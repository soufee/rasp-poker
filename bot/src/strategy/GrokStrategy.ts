/**
 * Grok — competitive multi-layer bot for «Расписной покер».
 *
 * Design (must finish well within the ~2–3s server turn budget):
 *
 *  BELIEF
 *   - Full card counting of every revealed card in the round
 *   - Void / trump-void inference from failed follows (ruff ⇒ no side suit;
 *     off-suit non-trump discard ⇒ also void in trump)
 *   - Lead-position priors: early leads rarely ruffed; known ruffers poison
 *     side-suit aces until their trumps (and joker) are gone
 *   - Partial-deck priors (PERCENTS / short ladder)
 *
 *  BIDDING
 *   - Suit-establishment winners model + Poisson-binomial EV
 *   - Opponent claim pressure, undertrick risk, tournament posture
 *
 *  PLAY — priority stack (high → low)
 *   1. Make own contract (overtrick ≫ undertrick / −10·bid)
 *   2. Hold joker as last-resort TAKE; dump high losers safely once made
 *   3. Cash side winners only when lead-safe (no live ruff threat)
 *   4. Tournament sabotage when table is close and swing ≫ self overtrick cost
 *   5. Zero-path / deny-zero endgame
 *
 *  META
 *   - Control game: variance by score gap; leader as dealer when trailing
 */

import type { DecisionContext } from '../core/stateSelectors';
import { knownHand, remainingTricks, tricksNeeded } from '../core/stateSelectors';
import type { CardModel, JokerAction, RoundType, Suit } from '../protocol/types';
import type { Strategy } from './Strategy';
import {
  cardKey,
  FULL_DECK,
  isJokerCard,
  JOKER_KEY,
  rankValue,
  resolveWinnerIndex,
  SUITS,
  type TrickCard,
} from './cards';
import { poissonBinomialPmf } from './probability';
import { scoreForRound } from './scoring';
import {
  chooseZeroBid,
  chooseZeroControlSetup,
  detectOpponentZeroThreats,
  planZeroPath,
  scoreThreatOutcome,
  shouldDefendSecondFromZero,
  trickPreferenceVsThreat,
  type ZeroPathPlan,
} from './zeroPath';

// ── Tuning ────────────────────────────────────────────────────────────────

const WIN_THRESHOLD = 0.52;
const JOKER_WIN_COST = 100;
const JOKER_DROP_COST = 12;
const TRUMP_COST_BASE = 18;
const BASE_VOID_FACTOR = 0.32;
const JOKER_THREAT = 0.48;
const RIVALRY_BASE = 0.88;
const TACTICAL_SCALE = 2.35;
const DENY_ZERO_SCALE = 3.3;
const UNDERTRICK_RISK_WEIGHT = 7.5;
const LOOKAHEAD_WEIGHT = 0.45;
const ESTABLISHMENT_WEIGHT = 0.75;
/** Amplifies tournament (sit/feed) EV relative to soft tactical priors. */
const TOURNAMENT_SCALE = 1.15;
const CLAIM_TRUST = 0.55;
const STANDING_GAP = 28;
const DARK_MIN_BID = 1;
const RISK_MARGIN = 4.5;
/** How hard we refuse to cash a side-suit honour into a known ruff. */
const RUFF_DANGER_SCALE = 14;
/** Hold joker for the last needed trick / insurance against overtricks. */
const JOKER_RESERVE_SCALE = 9;
/** Tournament proximity: sabotage only when rivals are within this score gap. */
const CLOSE_RACE_GAP = 45;

// ── Types ─────────────────────────────────────────────────────────────────

type PlayMode = 'win' | 'avoid' | 'take_all' | 'dump_all';
type Posture = 'behind' | 'ahead' | 'normal';

interface Candidate {
  cardIndex: number;
  jokerAction?: JokerAction;
  winProb: number;
  cost: number;
}

// ── Strategy ──────────────────────────────────────────────────────────────

export class GrokStrategy implements Strategy {
  public readonly name = 'Grok';

  private roundKey = '';
  private lastOwnCount = 0;
  private readonly seen = new Set<string>();
  /** playerId → suits they are known void in. */
  private readonly voids = new Map<string, Set<Suit>>();
  private pendingJokerAction: JokerAction | undefined;

  // ── Public API ──────────────────────────────────────────────────────────

  public observe(context: DecisionContext): void {
    this.remember(context);
  }

  public chooseBid(context: DecisionContext): number {
    this.remember(context);
    const allowed = context.state.allowedBids ?? [];
    if (allowed.length === 0) {
      return 0;
    }
    if (allowed.length === 1) {
      return allowed[0];
    }

    const zeroPlan = planZeroPath(context);
    const zeroBid = chooseZeroBid(context, zeroPlan, allowed);
    if (zeroBid !== null) {
      return zeroBid;
    }

    const hand = knownHand(context.me.cards);
    const blind =
      context.state.isDarkRound
      || context.state.currentRoundType === 'DARK'
      || hand.length === 0;
    if (blind) {
      return this.bidDark(context, allowed);
    }

    return this.bidByExpectedValue(context, allowed);
  }

  public chooseCard(context: DecisionContext): number {
    this.remember(context);
    this.pendingJokerAction = undefined;
    const legal = context.state.legalPlays ?? [];
    const fallback = context.state.validCardIndices ?? [0];

    if (legal.length === 0) {
      const index = fallback[0] ?? 0;
      const card = context.me.cards[index];
      if (card && isJokerCard(card)) {
        this.pendingJokerAction = this.defaultJokerAction(context);
      }
      return index;
    }

    const candidates = this.buildCandidates(context, legal);
    if (candidates.length === 0) {
      return legal[0]?.cardIndex ?? fallback[0] ?? 0;
    }

    const { mode, urgent } = this.evaluateMode(context);
    const chosen = this.selectCandidate(candidates, mode, urgent, context);
    this.pendingJokerAction = chosen.jokerAction;
    return chosen.cardIndex;
  }

  public chooseJokerAction(context: DecisionContext, _cardIndex: number): JokerAction {
    if (this.pendingJokerAction) {
      return this.pendingJokerAction;
    }
    return this.defaultJokerAction(context);
  }

  public chooseControlGame(
    context: DecisionContext,
  ): { roundType: RoundType; dealerIndex: number } {
    const zeroSetup = chooseZeroControlSetup(context);
    if (zeroSetup) {
      return zeroSetup;
    }

    const played = context.state.playedRoundTypes ?? ['STANDARD'];
    const posture = this.posture(context);
    const gap = this.scoreGap(context);

    // High-variance types when trailing hard; low-variance when protecting a lead.
    let preferred: RoundType[];
    if (posture === 'behind') {
      preferred =
        gap <= -50
          ? ['MISER', 'GOLD', 'PERCENTS', 'DARK', 'NO_TRUMP', 'STANDARD']
          : ['GOLD', 'PERCENTS', 'MISER', 'DARK', 'NO_TRUMP', 'STANDARD'];
    } else if (posture === 'ahead') {
      preferred = ['STANDARD', 'NO_TRUMP', 'DARK', 'PERCENTS', 'GOLD', 'MISER'];
    } else {
      preferred = ['PERCENTS', 'STANDARD', 'NO_TRUMP', 'DARK', 'GOLD', 'MISER'];
    }

    let roundType: RoundType = played[0] ?? 'STANDARD';
    for (const candidate of preferred) {
      if (played.includes(candidate)) {
        roundType = candidate;
        break;
      }
    }

    // Behind → force the leader to deal (they face «Кроме» last).
    // Ahead / normal → deal ourselves when possible (information + «Кроме» control).
    let dealerIndex = context.myIndex >= 0 ? context.myIndex : 0;
    if (posture === 'behind') {
      let bestIndex = -1;
      let bestScore = -Infinity;
      context.state.players.forEach((player, index) => {
        if (index !== context.myIndex && player.score > bestScore) {
          bestScore = player.score;
          bestIndex = index;
        }
      });
      if (bestIndex >= 0) {
        dealerIndex = bestIndex;
      }
    }

    return { roundType, dealerIndex };
  }

  public shouldStartGame(context: DecisionContext): boolean {
    const count = context.state.playersCount ?? context.state.players.length;
    return context.state.hostId === context.myId && count === context.state.maxPlayers;
  }

  // ── Belief / card counting ──────────────────────────────────────────────

  private remember(context: DecisionContext): void {
    const ownCount = knownHand(context.me.cards).length;
    const key =
      `${context.state.currentRoundIndex ?? 0}|${context.state.controlGamesPlayed ?? 0}`
      + `|${context.state.currentRoundType}|${context.state.currentRoundCards}`
      + `|${context.state.dealerIndex}|${context.state.trumpSuit ?? '-'}`;
    // Fresh deal: more cards than we held at end of previous round, or key change.
    const freshDeal = key !== this.roundKey || ownCount > this.lastOwnCount + 1;
    if (freshDeal) {
      this.roundKey = key;
      this.seen.clear();
      this.voids.clear();
    }
    this.lastOwnCount = ownCount;

    for (const card of knownHand(context.me.cards)) {
      this.seen.add(cardKey(card));
    }
    for (const played of context.state.tableCards) {
      this.seen.add(cardKey(played.card));
    }
    this.inferVoids(context);
  }

  /**
   * Mark voids from the current trick (persists across the round).
   *
   * Rules:
   *  - Off-lead-suit play ⇒ void in lead suit.
   *  - Off-lead non-trump discard ⇒ also void in trump (must ruff if able).
   *  - Joker is free of follow obligations ⇒ not a void signal.
   */
  private inferVoids(context: DecisionContext): void {
    const table = context.state.tableCards;
    if (table.length === 0) {
      return;
    }

    const trump = context.state.trumpSuit;
    let leadSuit: Suit | null = context.state.currentTrickLeadSuit ?? null;
    const first = table[0];
    if (!leadSuit && first) {
      if (isJokerCard(first.card)) {
        if (first.jokerAction?.type === 'DEMAND_SUIT') {
          leadSuit = first.jokerAction.suit;
        } else if (first.jokerAction?.type === 'DROP') {
          leadSuit = first.jokerAction.suit ?? null;
        }
      } else {
        leadSuit = first.card.suit;
      }
    }
    if (!leadSuit) {
      return;
    }

    for (const played of table) {
      if (isJokerCard(played.card)) {
        continue;
      }
      if (played.card.suit === leadSuit) {
        continue;
      }
      this.markVoid(played.playerId, leadSuit);
      // Failed to follow and did not ruff ⇒ no trumps left either.
      if (trump !== null && played.card.suit !== trump) {
        this.markVoid(played.playerId, trump);
      }
    }
  }

  private markVoid(playerId: string, suit: Suit): void {
    let set = this.voids.get(playerId);
    if (!set) {
      set = new Set();
      this.voids.set(playerId, set);
    }
    set.add(suit);
  }

  private isVoid(playerId: string, suit: Suit): boolean {
    return this.voids.get(playerId)?.has(suit) ?? false;
  }

  /** True when we are about to play the first card of the trick. */
  private isLeading(context: DecisionContext): boolean {
    return context.state.tableCards.length === 0;
  }

  private jokerStillOut(): boolean {
    return !this.seen.has(JOKER_KEY);
  }

  private unseenTrumpCount(context: DecisionContext): number {
    const trump = context.state.trumpSuit;
    if (!trump) {
      return 0;
    }
    return this.countUnseenSuit(trump, this.seen);
  }

  /**
   * Opponents known void in `suit` who are NOT known void in trump — they will
   * ruff our side-suit lead if they still hold a trump (or the joker).
   */
  private liveRuffersInSuit(context: DecisionContext, suit: Suit): string[] {
    const trump = context.state.trumpSuit;
    if (!trump || suit === trump) {
      return [];
    }
    const ruffers: string[] = [];
    for (const player of context.state.players) {
      if (player.id === context.myId) {
        continue;
      }
      if (!this.isVoid(player.id, suit)) {
        continue;
      }
      if (this.isVoid(player.id, trump)) {
        continue; // stripped of trumps — cannot ruff
      }
      // Still holds cards ⇒ may still hold a trump.
      if (player.cards.length > 0) {
        ruffers.push(player.id);
      }
    }
    return ruffers;
  }

  /**
   * 0 = certain ruff death, 1 = cash as lead is essentially safe.
   * Early virgin leads: high safety. Known ruffers + trumps out: low.
   */
  private leadCashSafety(
    card: CardModel,
    context: DecisionContext,
  ): number {
    if (isJokerCard(card)) {
      return 1;
    }
    const trump = context.state.trumpSuit;
    if (!trump || card.suit === trump) {
      return 1; // trump leads aren't "ruffed" in the side-suit sense
    }
    if (!this.isLeading(context)) {
      // Mid-trick: safety is handled by exact resolution + remaining players.
      return 1;
    }

    const ruffers = this.liveRuffersInSuit(context, card.suit);
    const trumpsOut = this.unseenTrumpCount(context);
    const jokerOut = this.jokerStillOut() ? 1 : 0;
    const handSize = Math.max(1, context.state.currentRoundCards);
    const progress = 1 - context.me.cards.length / handSize;

    if (ruffers.length > 0) {
      // Known void player(s) will ruff unless they have no trump left.
      // If any trump/joker is still out, Ace of that suit is poisoned.
      if (trumpsOut + jokerOut > 0) {
        return Math.max(0.02, 0.12 / (1 + ruffers.length + trumpsOut * 0.35));
      }
      // All trumps accounted for — ruffers are toothless.
      return 0.92;
    }

    // No known voids yet: early leads are relatively safe (everyone follows).
    // As the deal progresses, void/ruff risk rises.
    const earlyBoost = Math.max(0, 1 - progress * 1.4);
    const base = 0.55 + earlyBoost * 0.38;
    // Honour cash is safer early; low cards don't care.
    const honour = rankValue(card.rank) >= rankValue('Q') ? 1 : 0.7;
    // Residual unseen trumps still threaten late.
    const trumpDrag = Math.min(0.35, (trumpsOut + jokerOut * 0.8) * 0.04 * progress);
    return Math.max(0.15, Math.min(0.98, base * honour - trumpDrag));
  }

  // ── Bidding ─────────────────────────────────────────────────────────────

  private bidDark(context: DecisionContext, allowed: number[]): number {
    const handSize = context.state.currentRoundCards;
    const players = context.state.maxPlayers;
    const posture = this.posture(context);
    // Baseline: fair share of the deal.
    let target = handSize / players;

    // Only lean aggressive on mid-length dark hands (not 1–3 card ladder deals,
    // where fair share is already the correct EV anchor).
    if (players === 3 && handSize === 4) {
      target = 2.2;
    } else if (players === 3 && handSize >= 5 && handSize <= 7) {
      target = Math.max(target, 2.4);
    } else if (handSize >= 9) {
      // Long dark hands: slightly under fair share (harder to make blind).
      target = handSize / players - 0.15;
    }

    if (posture === 'behind') {
      target = Math.ceil(target + 0.15);
    } else if (posture === 'ahead') {
      target = Math.floor(target);
    } else {
      target = Math.round(target);
    }

    // Prefer a non-zero bid when legal (pass is only +5 and often broken blind).
    target = Math.max(DARK_MIN_BID, target);
    const nonZero = allowed.filter((bid) => bid !== 0);
    const pool = nonZero.length > 0 ? nonZero : allowed;
    return this.pickNearestBid(pool, target);
  }

  /**
   * EV-maximising bid from a suit-aware trick distribution.
   *
   * 1. Build per-card lead-win probabilities (damped for correlation).
   * 2. Add fractional establishment bonus (long no-trump suit + joker pull).
   * 3. Soft-shrink expected tricks by opponents' already-placed bids.
   * 4. Pick bid maximising scoring EV − undertrick risk + posture tilt.
   */
  private bidByExpectedValue(context: DecisionContext, allowed: number[]): number {
    const hand = knownHand(context.me.cards);
    const players = context.state.players.length;
    let damping = 0.88 - 0.03 * (players - 3);
    damping = Math.max(0.74, Math.min(0.9, damping));
    if (context.state.currentRoundType === 'NO_TRUMP') {
      damping *= 0.9;
    }

    const probs = hand.map((card) => {
      if (isJokerCard(card)) {
        return damping * this.winProbability(card, { type: 'TAKE' }, context);
      }
      return damping * this.winProbability(card, undefined, context);
    });

    // Suit-establishment bonus: joker pull converts low cards into winners.
    const establishment = this.establishmentBonus(context);
    if (establishment > 0) {
      probs.push(Math.min(0.92, establishment));
    }

    const pmf = poissonBinomialPmf(probs);
    const rawExpected = probs.reduce((sum, p) => sum + p, 0);
    const claimPressure = this.opponentClaimPressure(context);
    const adjustedExpected = Math.max(0, rawExpected - claimPressure);

    const roundType = context.state.currentRoundType;
    const cardsInHand = context.state.currentRoundCards;
    const posture = this.posture(context);
    const varianceTilt =
      posture === 'behind' ? 0.32
      : posture === 'ahead' ? -0.24
      : 0;

    // On PERCENTS everything is ×3 — undertrick risk is also amplified, so
    // lean slightly conservative relative to raw EV.
    const percentsGuard = roundType === 'PERCENTS' ? 1.15 : 1;

    let bestBid = allowed[0];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const bid of allowed) {
      let ev = 0;
      let undertrickMass = 0;
      for (let taken = 0; taken < pmf.length; taken += 1) {
        const p = pmf[taken];
        ev += p * scoreForRound(roundType, cardsInHand, bid, taken);
        if (taken < bid) {
          undertrickMass += p;
        }
      }

      const riskPenalty =
        UNDERTRICK_RISK_WEIGHT * percentsGuard * undertrickMass * Math.max(1, bid);
      const proximity = -Math.abs(bid - adjustedExpected) * 1.15;
      // Slight preference for contracts we can actually hit (exact make >> overtrick).
      const makeMass = pmf[bid] ?? 0;
      const makeBonus = makeMass * (bid === 0 ? 2 : 6);

      let utility = ev - riskPenalty + proximity + varianceTilt * bid + makeBonus;

      // GOLD / MISER have no bids in normal play — but if we somehow bid here,
      // fall through with raw EV.

      const better =
        utility > bestScore + 1e-9
        || (Math.abs(utility - bestScore) <= 1e-9
          && Math.abs(bid - adjustedExpected) < Math.abs(bestBid - adjustedExpected));
      if (better) {
        bestScore = utility;
        bestBid = bid;
      }
    }

    return this.applyRiskShift(context, allowed, bestBid, (bid) => {
      let value = 0;
      for (let taken = 0; taken < pmf.length; taken += 1) {
        value += pmf[taken] * scoreForRound(roundType, cardsInHand, bid, taken);
      }
      return value;
    });
  }

  /**
   * Extra fractional winners from establishing a long no-trump suit with
   * joker DEMAND pulling the top threat (classic: A then joker-out K → runners).
   */
  private establishmentBonus(context: DecisionContext): number {
    if (context.state.trumpSuit !== null && context.state.currentRoundType !== 'NO_TRUMP') {
      // With trump, establishment is weaker; still credit long trump + joker.
      return this.trumpEstablishmentBonus(context) * 0.45;
    }

    const hand = knownHand(context.me.cards);
    const hasJoker = hand.some(isJokerCard);
    if (!hasJoker && context.state.trumpSuit !== null) {
      return 0;
    }

    const seen = new Set(this.seen);
    let best = 0;
    for (const suit of SUITS) {
      if (context.state.trumpSuit !== null && suit !== context.state.trumpSuit) {
        // Only establish trump when trump exists (side-suit length less useful).
        continue;
      }
      const myRanks = hand
        .filter((card) => !isJokerCard(card) && card.suit === suit)
        .map((card) => rankValue(card.rank))
        .sort((a, b) => b - a);
      if (myRanks.length < 2) {
        continue;
      }
      const unseenHigher = this.unseenRanksInSuit(suit, seen);
      const pulls = hasJoker ? 1 : 0;
      const withoutPull = suitWinnersGreedy(myRanks, unseenHigher, 0);
      const withPull = suitWinnersGreedy(myRanks, unseenHigher, pulls);
      const gain = withPull - withoutPull;
      // Also credit raw greedy winners beyond independent-card estimate.
      const lengthBonus = Math.max(0, withPull - myRanks.filter((r) => r >= rankValue('Q')).length) * 0.25;
      best = Math.max(best, gain * 0.65 + lengthBonus);
    }
    return Math.min(1.15, best);
  }

  private trumpEstablishmentBonus(context: DecisionContext): number {
    const trump = context.state.trumpSuit;
    if (!trump) {
      return 0;
    }
    const hand = knownHand(context.me.cards);
    const myTrumps = hand
      .filter((card) => !isJokerCard(card) && card.suit === trump)
      .map((card) => rankValue(card.rank))
      .sort((a, b) => b - a);
    if (myTrumps.length < 2) {
      return hand.some(isJokerCard) ? 0.4 : 0;
    }
    const unseen = this.unseenRanksInSuit(trump, this.seen);
    const winners = suitWinnersGreedy(myTrumps, unseen, hand.some(isJokerCard) ? 1 : 0);
    return Math.min(1, Math.max(0, winners - 1) * 0.35);
  }

  /**
   * How many remaining tricks opponents have already "claimed" via bids.
   * Excess over 1.5× fair share is treated as noise (bluff / overreach).
   */
  private opponentClaimPressure(context: DecisionContext): number {
    const cardsInHand = context.state.currentRoundCards;
    const fair = cardsInHand / Math.max(1, context.state.maxPlayers);
    let claimed = 0;
    let opponents = 0;
    for (const player of context.state.players) {
      if (player.id === context.myId) {
        continue;
      }
      opponents += 1;
      const bid = player.currentBid ?? 0;
      claimed += Math.min(bid, Math.ceil(fair * 1.5));
    }
    if (opponents === 0) {
      return 0;
    }
    return claimed * CLAIM_TRUST;
  }

  private applyRiskShift(
    context: DecisionContext,
    allowed: number[],
    bestBid: number,
    evOf: (bid: number) => number,
  ): number {
    const posture = this.posture(context);
    if (posture === 'behind' && allowed.includes(bestBid + 1)) {
      if (evOf(bestBid + 1) >= evOf(bestBid) - RISK_MARGIN) {
        return bestBid + 1;
      }
    }
    if (posture === 'ahead' && allowed.includes(bestBid - 1)) {
      if (evOf(bestBid - 1) >= evOf(bestBid) - RISK_MARGIN) {
        return bestBid - 1;
      }
    }
    return bestBid;
  }

  // ── Play: candidates & selection ────────────────────────────────────────

  private buildCandidates(
    context: DecisionContext,
    legal: NonNullable<DecisionContext['state']['legalPlays']>,
  ): Candidate[] {
    const candidates: Candidate[] = [];
    for (const play of legal) {
      const card = context.me.cards[play.cardIndex];
      if (!card) {
        continue;
      }
      if (isJokerCard(card) && play.jokerActions && play.jokerActions.length > 0) {
        for (const jokerAction of play.jokerActions) {
          candidates.push({
            cardIndex: play.cardIndex,
            jokerAction,
            winProb: this.winProbability(card, jokerAction, context),
            cost: this.cardCost(card, jokerAction, context.state.trumpSuit),
          });
        }
        continue;
      }
      candidates.push({
        cardIndex: play.cardIndex,
        winProb: this.winProbability(card, undefined, context),
        cost: this.cardCost(card, undefined, context.state.trumpSuit),
      });
    }
    if (candidates.length > 0) {
      return candidates;
    }
    return legal.map((play) => {
      const card = context.me.cards[play.cardIndex]!;
      return {
        cardIndex: play.cardIndex,
        winProb: this.winProbability(card, undefined, context),
        cost: this.cardCost(card, undefined, context.state.trumpSuit),
      };
    });
  }

  private selectCandidate(
    candidates: Candidate[],
    mode: PlayMode,
    urgent: boolean,
    context: DecisionContext,
  ): Candidate {
    return this.best(candidates, (a, b) => {
      const diff =
        this.playValue(b, mode, urgent, context)
        - this.playValue(a, mode, urgent, context);
      if (Math.abs(diff) > 1e-9) {
        return diff;
      }
      // Stable tactical tie-breakers.
      if (mode === 'take_all' || mode === 'win') {
        if (urgent) {
          return b.winProb - a.winProb || a.cost - b.cost;
        }
        return a.cost - b.cost || b.winProb - a.winProb;
      }
      return this.jokerRank(a) - this.jokerRank(b)
        || b.cost - a.cost
        || a.winProb - b.winProb;
    });
  }

  /**
   * Total play utility. Priority stack is encoded in relative scales:
   *   contract lock ≫ joker reserve / lead safety ≫ tournament sabotage
   *   ≫ soft tactical, with zero-path overriding when active.
   */
  private playValue(
    candidate: Candidate,
    mode: PlayMode,
    urgent: boolean,
    context: DecisionContext,
  ): number {
    const zeroPlan = planZeroPath(context);
    const defending = shouldDefendSecondFromZero(context);
    const zeroBias = this.zeroPathPlayBias(candidate, zeroPlan, context);
    const denyBias = this.denyOpponentZeroBias(candidate, context);

    // Tournament sabotage only scales up when the race is close; far-ahead or
    // far-behind dead money is de-emphasised so we protect our own make first.
    const race = this.closeRaceFactor(context);
    const tourneyScale =
      (zeroPlan.active ? 0.15 : defending ? 0.4 : 0.55 + 0.6 * race)
      * TOURNAMENT_SCALE;
    const tacticalScale = defending ? TACTICAL_SCALE * 0.5 : TACTICAL_SCALE;

    return (
      zeroBias
      + denyBias
      + this.contractLockBias(candidate, mode, context)
      + this.jokerReserveBias(candidate, mode, context)
      + this.leadSafetyBias(candidate, mode, context)
      + tourneyScale * this.tournamentEV(candidate, context)
      + tacticalScale * this.tacticalBias(candidate, mode, urgent)
      + LOOKAHEAD_WEIGHT * this.lookaheadBias(candidate, mode, context)
      + ESTABLISHMENT_WEIGHT * this.establishmentPlayBias(candidate, mode, context)
    );
  }

  /**
   * 0 = no one close on the table, 1 = neck-and-neck with a rival.
   * Used to decide whether self-overtrick cost is worth sitting someone.
   */
  private closeRaceFactor(context: DecisionContext): number {
    const my = context.me.score;
    let nearest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < context.state.players.length; index += 1) {
      if (index === context.myIndex) {
        continue;
      }
      nearest = Math.min(nearest, Math.abs(context.state.players[index].score - my));
    }
    if (!Number.isFinite(nearest)) {
      return 0.5;
    }
    if (nearest <= 10) {
      return 1;
    }
    if (nearest >= CLOSE_RACE_GAP) {
      return 0.2;
    }
    return 1 - (nearest - 10) / (CLOSE_RACE_GAP - 10) * 0.8;
  }

  /**
   * Lead-position cash discipline:
   *  - Virgin first-trick side-suit Ace: often safe (everyone still follows).
   *  - Known ruffer with trumps out: do NOT cash that Ace — pull trumps / wait.
   *  - Mid-trick: no extra penalty (exact winProb already knows the board).
   */
  private leadSafetyBias(
    candidate: Candidate,
    mode: PlayMode,
    context: DecisionContext,
  ): number {
    if (!this.isLeading(context)) {
      return 0;
    }
    const card = context.me.cards[candidate.cardIndex];
    if (!card || isJokerCard(card)) {
      return 0;
    }
    if (mode === 'dump_all' || mode === 'avoid') {
      // We don't want to win — cash safety irrelevant; prefer losers.
      return 0;
    }

    const safety = this.leadCashSafety(card, context);
    const isHonour = rankValue(card.rank) >= rankValue('10');
    if (!isHonour) {
      return 0;
    }

    // Reward safe cashes when we still need tricks; punish poisoned aces hard.
    if (mode === 'win' || mode === 'take_all') {
      const need = tricksNeeded(context);
      if (safety < 0.35 && need > 0) {
        // Spending a "winner" that will be ruffed is a double loss (card + trick).
        return -RUFF_DANGER_SCALE * (0.35 - safety) * (1 + rankValue(card.rank) * 0.08);
      }
      if (safety > 0.75 && candidate.winProb >= WIN_THRESHOLD && need > 0) {
        return (safety - 0.75) * 4;
      }
      // Prefer leading safe winners over unsafe ones even when both look strong.
      return (safety - 0.5) * 3 * (isHonour ? 1 : 0.3);
    }
    return 0;
  }

  /**
   * Joker policy:
   *  - Need exactly 1 more and hold joker ⇒ reserve TAKE for the last trick;
   *    dump other cards (high losers first) in the meantime.
   *  - Contract made ⇒ never TAKE with joker unless sabotage EV is huge
   *    (handled by tournament term); prefer DROP or non-joker plays; keep
   *    joker as late insurance against an accidental forced winner.
   *  - Need many / urgent ⇒ free to spend joker.
   */
  private jokerReserveBias(
    candidate: Candidate,
    mode: PlayMode,
    context: DecisionContext,
  ): number {
    const card = context.me.cards[candidate.cardIndex];
    if (!card || !isJokerCard(card)) {
      // Non-joker: slight bonus for dumping high guaranteed losers while we
      // still hold a joker as insurance (contract made or last trick reserved).
      return this.jokerInsuranceDumpBonus(candidate, mode, context);
    }

    const need = tricksNeeded(context);
    const left = remainingTricks(context);
    const action = candidate.jokerAction?.type ?? 'TAKE';
    const isTake =
      action === 'TAKE' || action === 'DEMAND_SUIT';

    // MISER / dump: keep joker in hand as late insurance; dump ordinary losers first.
    if (mode === 'dump_all' || mode === 'avoid') {
      if (action === 'DROP') {
        // Only happy to DROP joker when it is (almost) the last card.
        if (left <= 1) {
          return JOKER_RESERVE_SCALE * 0.9;
        }
        // Prefer not playing joker at all while other cards can safely lose.
        return -JOKER_RESERVE_SCALE * 1.3;
      }
      // TAKE while dumping: only justified by huge sabotage (tournament EV).
      return -JOKER_RESERVE_SCALE * 2.2;
    }

    // Still need tricks.
    if (need <= 0) {
      return isTake ? -JOKER_RESERVE_SCALE * 2.0 : -JOKER_RESERVE_SCALE * 0.5;
    }

    // Last needed trick with short hand: joker TAKE/DEMAND is ideal — spend it.
    if (need === 1 && left <= 2) {
      return isTake ? JOKER_RESERVE_SCALE * 1.4 : -JOKER_RESERVE_SCALE;
    }

    // Need exactly one more but several tricks remain: HOLD the joker hard.
    // Must outweigh contractLockBias(winProb=1) ≈ 0.55·20·bid so we dump losers first.
    if (need === 1 && left > 2) {
      if (isTake) {
        return -JOKER_RESERVE_SCALE * 4.0;
      }
      return -JOKER_RESERVE_SCALE * 2.5;
    }

    // Need multiple urgently: free to use joker.
    if (need >= left) {
      return isTake ? JOKER_RESERVE_SCALE * 0.6 : -JOKER_RESERVE_SCALE;
    }
    // Need multiple with slack: mild reserve, DEMAND slightly preferred for establishment.
    if (action === 'DEMAND_SUIT') {
      return -JOKER_RESERVE_SCALE * 0.15;
    }
    if (isTake) {
      return -JOKER_RESERVE_SCALE * 0.55;
    }
    return -JOKER_RESERVE_SCALE * 0.8;
  }

  /**
   * While holding the joker as insurance, dump highest *safe losers* first so
   * we never accidentally take with a stranded Ace after the contract is made.
   */
  private jokerInsuranceDumpBonus(
    candidate: Candidate,
    mode: PlayMode,
    context: DecisionContext,
  ): number {
    if (mode !== 'avoid' && mode !== 'dump_all') {
      // Also when need===1 with joker in hand: prefer non-joker dumps that lose.
      const need = tricksNeeded(context);
      const hand = knownHand(context.me.cards);
      const hasJoker = hand.some(isJokerCard);
      if (!(need === 1 && hasJoker && candidate.winProb < WIN_THRESHOLD)) {
        return 0;
      }
      // Dump high losers while reserving joker for the last make.
      return candidate.cost * 0.08 + (1 - candidate.winProb) * 1.5;
    }

    const hand = knownHand(context.me.cards);
    if (!hand.some(isJokerCard)) {
      return 0;
    }
    // Contract met + joker in hand: dump fat losers, keep joker for last.
    if (candidate.winProb < WIN_THRESHOLD) {
      return candidate.cost * 0.1;
    }
    // Don't cash a side winner "for free" while joker insurance exists —
    // might be needed to avoid something later; mild penalty.
    return -1.2;
  }

  /**
   * When the contract is still open, expected make/miss swing dominates soft
   * cynicism about opponents' pass scores. Without this, the bot happily leads
   * garbage to "break" rival passes while its own −10·bid is still at risk.
   *
   * Exception: when we still hold the joker as a reserved last winner
   * (need === 1, long hand), do not credit ordinary low-prob cashes less than
   * the joker — the reserve bias handles joker deferral separately, and we
   * still want *some* contract pressure on real winners.
   */
  private contractLockBias(
    candidate: Candidate,
    mode: PlayMode,
    context: DecisionContext,
  ): number {
    if (mode !== 'win' && mode !== 'take_all') {
      return 0;
    }
    const need = tricksNeeded(context);
    if (need <= 0) {
      return 0;
    }

    const bid = context.me.currentBid ?? 0;
    const cards = context.state.currentRoundCards;
    const roundType = context.state.currentRoundType;
    const makePts = scoreForRound(roundType, cards, bid, bid);
    const missPts = scoreForRound(roundType, cards, bid, Math.max(0, bid - 1));
    const swing = makePts - missPts; // typically 10·bid − (−10·bid) = 20·bid

    const left = remainingTricks(context);
    const pressure = need >= left ? 1.4 : need > left * 0.5 ? 1.1 : 0.85;

    // Soften lock credit on joker when we are deliberately reserving it.
    const card = context.me.cards[candidate.cardIndex];
    let jokerSoft = 1;
    if (
      card
      && isJokerCard(card)
      && need === 1
      && left > 2
      && (candidate.jokerAction?.type === 'TAKE'
        || candidate.jokerAction?.type === 'DEMAND_SUIT')
    ) {
      jokerSoft = 0.15;
    }

    return candidate.winProb * swing * pressure * 0.55 * jokerSoft;
  }

  /**
   * Two-trick micro-lookahead: if we spend this winner now, do we still have
   * another for the next needed trick? Encourages saving strong cards when we
   * need exactly one more, and dumping high losers once the contract is met.
   */
  private lookaheadBias(
    candidate: Candidate,
    mode: PlayMode,
    context: DecisionContext,
  ): number {
    const hand = knownHand(context.me.cards);
    if (hand.length <= 1) {
      return 0;
    }

    // Remaining hand after playing this card (by key, not broken indices).
    const playedKey = cardKey(context.me.cards[candidate.cardIndex]!);
    const remainingAfter = hand.filter((card) => cardKey(card) !== playedKey);
    if (remainingAfter.length === 0) {
      return 0;
    }

    if (mode === 'win' || mode === 'take_all') {
      const needNow = tricksNeeded(context);

      let bestFuture = 0;
      for (const card of remainingAfter) {
        if (isJokerCard(card)) {
          bestFuture = Math.max(bestFuture, 1);
          continue;
        }
        bestFuture = Math.max(
          bestFuture,
          this.winProbability(card, undefined, context),
        );
      }

      // Cash a reliable winner when the contract is still open.
      if (needNow > 0 && candidate.winProb >= WIN_THRESHOLD) {
        return candidate.winProb * 6 - candidate.cost * 0.04;
      }

      // Leading a likely loser while we still need tricks is dangerous —
      // residual future winners are discounted, not free.
      if (needNow > 0 && candidate.winProb < WIN_THRESHOLD) {
        return bestFuture * 1.5 - (WIN_THRESHOLD - candidate.winProb) * 7;
      }

      const need = needNow - (candidate.winProb >= WIN_THRESHOLD ? 1 : 0);
      if (need <= 0) {
        return candidate.cost * 0.03 * (candidate.winProb < WIN_THRESHOLD ? 1 : 0);
      }

      const spendsLastWinner =
        candidate.winProb >= WIN_THRESHOLD && bestFuture < WIN_THRESHOLD && need > 1;
      return bestFuture * 4 - candidate.cost * 0.04 - (spendsLastWinner ? 6 : 0);
    }

    if (mode === 'avoid' || mode === 'dump_all') {
      // Dump highest-cost losers now; keep cheap exits for later.
      return candidate.cost * 0.07 * (candidate.winProb < WIN_THRESHOLD ? 1 : -0.55);
    }
    return 0;
  }

  /**
   * Prefer leading from an establishable long suit (Ace / top honour) when we
   * need tricks; prefer joker DEMAND of that suit over bare TAKE.
   */
  private establishmentPlayBias(
    candidate: Candidate,
    mode: PlayMode,
    context: DecisionContext,
  ): number {
    if (mode === 'avoid' || mode === 'dump_all') {
      return 0;
    }
    if (context.state.tableCards.length > 0) {
      // Only steer leads; mid-trick is pure win/lose math.
      return 0;
    }

    const card = context.me.cards[candidate.cardIndex];
    if (!card) {
      return 0;
    }

    const plan = this.bestEstablishmentSuit(context);
    if (!plan) {
      // Mild default: lead high trump / Ace when winning is the goal.
      if (isJokerCard(card)) {
        if (candidate.jokerAction?.type === 'DEMAND_SUIT') {
          return 1.5;
        }
        if (candidate.jokerAction?.type === 'TAKE') {
          return 0.8;
        }
        return -1;
      }
      return 0;
    }

    let value = 0;
    if (isJokerCard(card)) {
      if (
        candidate.jokerAction?.type === 'DEMAND_SUIT'
        && candidate.jokerAction.suit === plan.suit
      ) {
        value += 5 + plan.runners * 1.5;
      } else if (candidate.jokerAction?.type === 'TAKE') {
        value += 1.2; // still fine, just not optimal
      } else if (candidate.jokerAction?.type === 'DROP') {
        value -= 4;
      }
      return value;
    }

    if (card.suit === plan.suit) {
      // Prefer leading top of the suit only when cash is lead-safe.
      const safety = this.leadCashSafety(card, context);
      if (safety < 0.4 && rankValue(card.rank) >= rankValue('10')) {
        // Poisoned honour — do not "establish" into a ruff.
        value -= 4;
      } else {
        const topBonus = rankValue(card.rank) >= rankValue('Q') ? 2.5 : 0.8;
        value += (topBonus + plan.runners * 0.4) * (0.5 + 0.5 * safety);
        if (card.rank === 'A') {
          value += 2 * safety;
        }
      }
    } else {
      // Leading off-plan burns tempo for establishment.
      value -= 0.6;
    }
    return value;
  }

  private bestEstablishmentSuit(
    context: DecisionContext,
  ): { suit: Suit; runners: number; hasAce: boolean } | null {
    const hand = knownHand(context.me.cards);
    const hasJoker = hand.some(isJokerCard);
    const trump = context.state.trumpSuit;
    let best: { suit: Suit; runners: number; hasAce: boolean; score: number } | null = null;

    for (const suit of SUITS) {
      // Prefer side suits in no-trump; prefer trump when it exists and is long.
      if (trump !== null && suit !== trump && context.state.currentRoundType !== 'NO_TRUMP') {
        // Side-suit establishment only when length ≥ 4 and we have Ace.
        const side = hand.filter((c) => !isJokerCard(c) && c.suit === suit);
        if (side.length < 4 || !side.some((c) => c.rank === 'A')) {
          continue;
        }
      }

      const mine = hand
        .filter((c) => !isJokerCard(c) && c.suit === suit)
        .map((c) => rankValue(c.rank))
        .sort((a, b) => b - a);
      if (mine.length < 2) {
        continue;
      }
      const unseen = this.unseenRanksInSuit(suit, this.seen);
      const pulls = hasJoker ? 1 : 0;
      const runners = suitWinnersGreedy(mine, unseen, pulls);
      const hasAce = mine[0] === rankValue('A');
      const score =
        runners * 3
        + mine.length
        + (hasAce ? 2 : 0)
        + (trump !== null && suit === trump ? 1.5 : 0)
        + (trump === null ? 1 : 0);
      if (!best || score > best.score) {
        best = { suit, runners, hasAce, score };
      }
    }
    return best;
  }

  // ── Zero-path & deny-zero ───────────────────────────────────────────────

  private zeroPathPlayBias(
    candidate: Candidate,
    plan: ZeroPathPlan,
    context: DecisionContext,
  ): number {
    if (!plan.active || plan.style === 'inactive') {
      return 0;
    }

    const taken = context.me.tricksTaken;
    const max = plan.maxTricksAllowed;
    const p = candidate.winProb;

    if (max === null) {
      if (plan.style === 'accumulate') {
        return p * 90;
      }
      return 0;
    }

    if (taken >= max) {
      return (1 - p) * 200 - p * 200;
    }

    if (plan.style === 'dump_underbid' || plan.style === 'hold_zero') {
      const room = max - taken;
      if (room <= 0) {
        return (1 - p) * 200 - p * 200;
      }
      return (1 - p) * 120 - p * 40 - (candidate.cost >= JOKER_WIN_COST ? 30 : 0);
    }

    if (plan.style === 'accumulate' || plan.style === 'target_delta') {
      const need = max - taken;
      if (need <= 0) {
        return (1 - p) * 200 - p * 200;
      }
      return p * (80 + need * 15) - candidate.cost * 0.05;
    }

    return 0;
  }

  private denyOpponentZeroBias(candidate: Candidate, context: DecisionContext): number {
    if (!shouldDefendSecondFromZero(context)) {
      return 0;
    }
    if (planZeroPath(context).active) {
      return 0;
    }

    const threats = detectOpponentZeroThreats(context);
    if (threats.length === 0) {
      return 0;
    }

    const p = Math.max(0, Math.min(1, candidate.winProb));
    const recipients = this.likelyDumpRecipients(candidate, context);
    const roundType = context.state.currentRoundType;
    const cards = context.state.currentRoundCards;
    const remainingAfter = Math.max(0, remainingTricks(context) - 1);
    const n = Math.max(1, context.state.players.length);

    let value = 0;
    for (const threat of threats) {
      const ifITake = trickPreferenceVsThreat(threat, false);
      let ifILose = 0;
      if (recipients.length === 0) {
        ifILose = ifITake;
      } else {
        for (const recipient of recipients) {
          ifILose += trickPreferenceVsThreat(threat, recipient === threat.playerIndex);
        }
        ifILose /= recipients.length;
      }
      value += DENY_ZERO_SCALE * (p * ifITake + (1 - p) * ifILose);

      const projectEnd = (takenNow: number): number => {
        let finalTaken = takenNow;
        if (threat.kind === 'gold_exact' && threat.idealTaken !== null) {
          const need = Math.max(0, threat.idealTaken - takenNow);
          finalTaken = takenNow + Math.min(need, remainingAfter);
        } else if (threat.kind === 'hold_zero' || threat.kind === 'underbid_miss') {
          finalTaken = takenNow;
        } else {
          finalTaken = takenNow + Math.round(remainingAfter / n);
        }
        return scoreThreatOutcome(threat, finalTaken, roundType, cards);
      };

      const uWin = projectEnd(threat.taken);
      let uLose = 0;
      if (recipients.length === 0) {
        uLose = uWin;
      } else {
        for (const recipient of recipients) {
          const taken =
            recipient === threat.playerIndex ? threat.taken + 1 : threat.taken;
          uLose += projectEnd(taken);
        }
        uLose /= recipients.length;
      }
      value += DENY_ZERO_SCALE * 0.45 * (p * uWin + (1 - p) * uLose);
    }

    if (candidate.cost >= JOKER_WIN_COST && value < 50) {
      value -= 8;
    }
    return value;
  }

  private tacticalBias(candidate: Candidate, mode: PlayMode, urgent: boolean): number {
    let value = 0;
    if (mode === 'take_all' || mode === 'win') {
      value += candidate.winProb * (urgent ? 6.2 : 2.3);
      value -= candidate.cost * 0.025;
      if (!urgent && candidate.winProb >= WIN_THRESHOLD) {
        value += (22 - Math.min(22, candidate.cost)) * 0.08;
      }
    } else {
      value += (1 - candidate.winProb) * 4.6;
      value += candidate.cost * 0.045;
      if (candidate.jokerAction && candidate.jokerAction.type !== 'DROP') {
        value -= 2.6;
      }
    }
    if (candidate.cost >= JOKER_WIN_COST) {
      // Conserve joker unless urgent or establishment DEMAND.
      const isDemand = candidate.jokerAction?.type === 'DEMAND_SUIT';
      value -= urgent || isDemand ? 0.4 : 1.5;
    }
    return value;
  }

  // ── Tournament EV ───────────────────────────────────────────────────────

  private tournamentEV(candidate: Candidate, context: DecisionContext): number {
    const p = Math.max(0, Math.min(1, candidate.winProb));
    const uWin = this.standingUtilityAfterTrick(context, context.myIndex);
    const recipients = this.likelyDumpRecipients(candidate, context);
    let uLose = 0;
    if (recipients.length === 0) {
      uLose = uWin;
    } else {
      for (const recipient of recipients) {
        uLose += this.standingUtilityAfterTrick(context, recipient);
      }
      uLose /= recipients.length;
    }
    return p * uWin + (1 - p) * uLose;
  }

  private standingUtilityAfterTrick(
    context: DecisionContext,
    trickWinnerIndex: number,
  ): number {
    const remainingAfter = Math.max(0, remainingTricks(context) - 1);
    const n = Math.max(1, context.state.players.length);
    const roundType = context.state.currentRoundType;
    const cardsInHand = context.state.currentRoundCards;
    const myWeight = this.personalWeight(context);
    const defending = shouldDefendSecondFromZero(context);
    const threats = defending ? detectOpponentZeroThreats(context) : [];

    let utility = 0;
    context.state.players.forEach((player, index) => {
      const getsThis = index === trickWinnerIndex ? 1 : 0;
      const takenNow = player.tricksTaken + getsThis;
      const finalTaken = this.projectFinalTaken(
        player.currentBid,
        takenNow,
        remainingAfter,
        n,
        roundType,
        index === context.myIndex,
        context,
      );
      const bid = player.currentBid ?? 0;
      const points = scoreForRound(roundType, cardsInHand, bid, finalTaken);
      if (index === context.myIndex) {
        utility += myWeight * points;
      } else {
        utility -= this.rivalryWeight(index, context) * points;
        if (defending) {
          const threat = threats.find((entry) => entry.playerIndex === index);
          if (threat) {
            utility += scoreThreatOutcome(threat, finalTaken, roundType, cardsInHand) * 0.5;
          } else if (player.score + points === 0) {
            utility -= 400;
          }
        }
      }
    });
    return utility;
  }

  private projectFinalTaken(
    bid: number | null,
    takenNow: number,
    remainingAfter: number,
    n: number,
    roundType: RoundType,
    isMe: boolean,
    context: DecisionContext,
  ): number {
    if (remainingAfter <= 0) {
      return takenNow;
    }

    const fair = remainingAfter / n;

    if (roundType === 'GOLD') {
      const greedy = isMe ? remainingAfter * 0.55 : fair;
      return Math.round(takenNow + Math.min(remainingAfter, greedy * 0.7 + fair * 0.3));
    }

    if (roundType === 'MISER') {
      const extra = isMe ? remainingAfter * 0.12 : fair * 0.5;
      return Math.round(takenNow + Math.min(remainingAfter, extra));
    }

    if (isMe) {
      const contract = bid ?? 0;
      const need = Math.max(0, contract - takenNow);
      const { mode } = this.evaluateMode(context);
      if (mode === 'avoid' || mode === 'dump_all') {
        // Try to stay put; allow a little accidental overtrick leakage.
        return Math.round(takenNow + Math.min(remainingAfter, fair * 0.2));
      }
      if (mode === 'win' || mode === 'take_all') {
        // Assume we press for the contract; do not invent free extras.
        const push = Math.min(remainingAfter, need > 0 ? need * 0.75 + fair * 0.2 : fair * 0.25);
        return Math.round(takenNow + push);
      }
    }

    // Opponents: pure fair-share extras only. Auto-filling their remaining need
    // would erase the EV of sitting / feeding overtricks on *this* trick.
    return Math.round(takenNow + fair);
  }

  private personalWeight(context: DecisionContext): number {
    if (planZeroPath(context).active) {
      return 0.2;
    }
    if (shouldDefendSecondFromZero(context)) {
      return 0.35;
    }

    const roundType = context.state.currentRoundType;
    if (roundType === 'GOLD') {
      return 1.15;
    }
    if (roundType === 'MISER') {
      return 1.3;
    }

    const need = tricksNeeded(context);
    const left = remainingTricks(context);
    if (need <= 0) {
      // Bid already made — personal overtrick points are tiny; sabotage is free.
      // Keep a little weight so exact-make (+10) still beats overtrick (+taken)
      // unless the table swing is large (rivalry handles that).
      return 0.55;
    }
    if (need >= left && need > 0) {
      return 2.5;
    }
    if (need > left * 0.6) {
      return 1.75;
    }

    const gap = this.scoreGap(context);
    if (gap <= -30) {
      return 0.7; // accept self-damage to kneecap leader
    }
    return 1.0;
  }

  private rivalryWeight(playerIndex: number, context: DecisionContext): number {
    const player = context.state.players[playerIndex];
    if (!player) {
      return RIVALRY_BASE;
    }

    const myScore = context.me.score;
    const scores = context.state.players.map((entry) => entry.score);
    const best = Math.max(...scores);
    const theirScore = player.score;
    const gap = theirScore - myScore;

    let weight = RIVALRY_BASE;

    // Close-race amplifier: sabotage is worth self-overtrick only when we
    // actually care about this rival on the tournament table.
    const race = this.closeRaceFactor(context);
    weight *= 0.55 + 0.7 * race;

    if (theirScore >= best - 2) {
      weight += 0.78 * (0.6 + 0.4 * race);
    } else if (theirScore >= best - 15) {
      weight += 0.35 * (0.5 + 0.5 * race);
    }

    if (gap > 0) {
      weight += Math.min(0.7, gap / 65) * race;
    } else if (gap < -35) {
      weight *= 0.3; // far behind us — ignore
    } else if (gap > -20 && gap < 0) {
      weight += 0.25 * race; // close chaser
    }

    const bid = player.currentBid ?? 0;
    const taken = player.tricksTaken;
    const roundType = context.state.currentRoundType;

    if (bid >= 3 && roundType !== 'GOLD' && roundType !== 'MISER') {
      weight *= 1 + 0.1 * bid;
    }

    if (roundType !== 'GOLD' && roundType !== 'MISER' && bid > 0) {
      const makePts = scoreForRound(roundType, context.state.currentRoundCards, bid, bid);
      const underPts = scoreForRound(
        roundType,
        context.state.currentRoundCards,
        bid,
        Math.max(0, bid - 1),
      );
      const overPts = scoreForRound(roundType, context.state.currentRoundCards, bid, bid + 1);
      const swing = Math.max(makePts - underPts, makePts - overPts);
      weight *= 1 + Math.min(1.25, swing / 75);

      if (taken === bid) {
        weight *= 1.38; // feed overtrick
      }
      if (taken === bid - 1 && bid >= 2) {
        weight *= 1.42; // sit the make
      }
    }

    if (roundType === 'PERCENTS') {
      weight *= 1.5;
    }

    return Math.max(0.12, weight);
  }

  // ── Recipients / geometry ───────────────────────────────────────────────

  private likelyDumpRecipients(candidate: Candidate, context: DecisionContext): number[] {
    const card = context.me.cards[candidate.cardIndex];
    if (!card) {
      return this.playersAfterMe(context);
    }

    const table = context.state.tableCards;
    const plays: TrickCard[] = table.map((played) => ({
      card: played.card,
      jokerAction: played.jokerAction,
    }));
    plays.push({ card, jokerAction: candidate.jokerAction });

    const winnerPlayIndex = resolveWinnerIndex(
      plays,
      context.state.trumpSuit,
      context.state.currentTrickLeadSuit ?? null,
    );
    const myPlayIndex = plays.length - 1;

    if (winnerPlayIndex !== myPlayIndex && winnerPlayIndex >= 0) {
      if (winnerPlayIndex < table.length) {
        const recipient = this.playerIndexForTableSlot(context, winnerPlayIndex);
        return recipient >= 0 ? [recipient] : this.opponentIndices(context);
      }
    }

    // Players still to act — weight those not known void in the lead suit.
    const after = this.playersAfterMe(context);
    if (after.length === 0) {
      return this.opponentIndices(context);
    }

    const lead =
      context.state.currentTrickLeadSuit
      ?? (!isJokerCard(card) ? card.suit : null);
    if (!lead) {
      return after;
    }

    // Prefer recipients who can still hold the suit / trump (not known void).
    const capable = after.filter((index) => {
      const id = context.state.players[index]?.id;
      if (!id) {
        return true;
      }
      // Known void in lead → can only ruff or dump; still a possible winner via trump.
      return true;
    });
    return capable.length > 0 ? capable : after;
  }

  private playerIndexForTableSlot(context: DecisionContext, tableSlot: number): number {
    const n = context.state.players.length;
    if (n === 0) {
      return -1;
    }
    const tableLen = context.state.tableCards.length;
    const leadIndex = (context.state.currentPlayerIndex - tableLen + n * 4) % n;
    return (leadIndex + tableSlot) % n;
  }

  private playersAfterMe(context: DecisionContext): number[] {
    const n = context.state.players.length;
    const remaining = n - context.state.tableCards.length - 1;
    const indices: number[] = [];
    for (let step = 1; step <= remaining; step += 1) {
      indices.push((context.state.currentPlayerIndex + step) % n);
    }
    return indices.filter((index) => index !== context.myIndex);
  }

  private opponentIndices(context: DecisionContext): number[] {
    return context.state.players
      .map((_, index) => index)
      .filter((index) => index !== context.myIndex);
  }

  // ── Mode ────────────────────────────────────────────────────────────────

  private evaluateMode(context: DecisionContext): { mode: PlayMode; urgent: boolean } {
    const zeroPlan = planZeroPath(context);
    if (zeroPlan.active) {
      const taken = context.me.tricksTaken;
      const max = zeroPlan.maxTricksAllowed;

      if (zeroPlan.style === 'dump_underbid' || zeroPlan.style === 'hold_zero') {
        return { mode: 'dump_all', urgent: true };
      }
      if (zeroPlan.style === 'accumulate') {
        if (max !== null && taken >= max) {
          return { mode: 'avoid', urgent: true };
        }
        return { mode: 'take_all', urgent: true };
      }
      if (zeroPlan.style === 'target_delta') {
        if (max !== null && taken >= max) {
          return { mode: 'avoid', urgent: true };
        }
        if (max !== null && taken < max) {
          return { mode: 'win', urgent: true };
        }
      }
    }

    const roundType = context.state.currentRoundType;
    if (roundType === 'GOLD') {
      return { mode: 'take_all', urgent: false };
    }
    if (roundType === 'MISER') {
      return { mode: 'dump_all', urgent: false };
    }

    const need = tricksNeeded(context);
    const left = remainingTricks(context);
    if (need <= 0) {
      return { mode: 'avoid', urgent: false };
    }
    if (need >= left) {
      return { mode: 'win', urgent: true };
    }
    // Need 1 of 2 remaining is already urgent — every deferred make is a risk.
    return { mode: 'win', urgent: need * 2 >= left || need > left * 0.5 };
  }

  // ── Card math / win probability ─────────────────────────────────────────

  private cardCost(
    card: CardModel,
    jokerAction: JokerAction | undefined,
    trump: Suit | null,
  ): number {
    if (isJokerCard(card)) {
      if (jokerAction?.type === 'DROP') {
        return JOKER_DROP_COST;
      }
      return JOKER_WIN_COST;
    }
    if (trump !== null && card.suit === trump) {
      return TRUMP_COST_BASE + rankValue(card.rank);
    }
    return rankValue(card.rank);
  }

  /**
   * Probability that playing `candidate` wins the current trick.
   *
   * Lead-position model:
   *  - First lead of a virgin suit early in the deal → low ruff prior
   *    (everyone still has length; Ace of side suit is often cash).
   *  - Known ruffer (void in suit, not void in trump) + trumps out →
   *    side-suit honour is nearly dead until those trumps are drawn.
   * Mid-trick uses exact board resolution + live remaining players.
   */
  private winProbability(
    candidate: CardModel,
    jokerAction: JokerAction | undefined,
    context: DecisionContext,
  ): number {
    const { trumpSuit, tableCards, maxPlayers } = context.state;
    const leadSuit = context.state.currentTrickLeadSuit ?? null;

    const plays: TrickCard[] = tableCards.map((played) => ({
      card: played.card,
      jokerAction: played.jokerAction,
    }));
    plays.push({ card: candidate, jokerAction });

    const winnerIndex = resolveWinnerIndex(plays, trumpSuit, leadSuit);
    if (winnerIndex !== plays.length - 1) {
      return 0;
    }
    if (isJokerCard(candidate)) {
      return jokerAction?.type === 'DROP' ? 0 : 1;
    }

    const playersAfter = maxPlayers - plays.length;
    if (playersAfter <= 0) {
      return 1;
    }

    const seen = new Set(this.seen);
    for (const played of tableCards) {
      seen.add(cardKey(played.card));
    }
    seen.add(cardKey(candidate));

    const live = this.liveFraction(context, seen, playersAfter);
    const jokerUnseen = seen.has(JOKER_KEY) ? 0 : 1;
    const candidateIsTrump = trumpSuit !== null && candidate.suit === trumpSuit;
    const leading = tableCards.length === 0;

    const effectiveLead =
      leadSuit
      ?? (isJokerCard(candidate)
        ? (jokerAction?.type === 'DEMAND_SUIT' || jokerAction?.type === 'DROP'
          ? jokerAction.suit ?? null
          : null)
        : candidate.suit);

    const after = this.playersAfterMe(context);
    let knownVoidInLead = 0;
    let knownCanFollow = 0;
    let knownRuffers = 0; // void in lead, not void in trump
    if (effectiveLead) {
      for (const index of after) {
        const id = context.state.players[index]?.id;
        if (!id) {
          continue;
        }
        if (this.isVoid(id, effectiveLead)) {
          knownVoidInLead += 1;
          if (
            trumpSuit !== null
            && effectiveLead !== trumpSuit
            && !this.isVoid(id, trumpSuit)
          ) {
            knownRuffers += 1;
          }
        } else {
          knownCanFollow += 1;
        }
      }
    }

    let probability: number;
    if (candidateIsTrump) {
      const higherTrumps = this.countUnseenHigher(trumpSuit!, candidate, seen);
      probability = Math.pow(1 - live, higherTrumps);
    } else {
      const higherSameSuit = this.countUnseenHigher(candidate.suit, candidate, seen);
      const trumpsTotal =
        trumpSuit !== null ? this.countUnseenSuit(trumpSuit, seen) : 0;

      const handSize = Math.max(1, context.state.currentRoundCards);
      const progress = 1 - context.me.cards.length / handSize;
      let voidFactor = Math.min(0.88, BASE_VOID_FACTOR + progress * 0.38);

      if (leading && knownVoidInLead === 0) {
        // Opening lead into a suit with no known voids: ruffs are rare early.
        voidFactor *= Math.max(0.25, 0.55 - progress * 0.15);
      }

      if (after.length > 0 && effectiveLead) {
        const voidRatio = knownVoidInLead / after.length;
        voidFactor = Math.min(0.97, voidFactor * (1 - voidRatio) + voidRatio * 0.92);
        if (knownCanFollow === after.length && knownVoidInLead === 0) {
          voidFactor *= 0.7;
        }
      }

      // Hard hit: known ruffers behind us almost surely beat a side-suit lead
      // if any trump remains in the deck / their hand.
      if (knownRuffers > 0 && trumpsTotal + jokerUnseen > 0) {
        // P(survive all known ruffers) collapses.
        const ruffSurvive = Math.pow(0.12, knownRuffers);
        probability =
          Math.pow(1 - live, higherSameSuit)
          * Math.pow(1 - live * voidFactor, Math.max(0, trumpsTotal - knownRuffers))
          * ruffSurvive;
      } else {
        probability =
          Math.pow(1 - live, higherSameSuit)
          * Math.pow(1 - live * voidFactor, trumpsTotal);
      }

      // Also apply global lead-cash safety as a soft multiplier for side honours.
      if (leading && trumpSuit && candidate.suit !== trumpSuit) {
        const safety = this.leadCashSafety(candidate, context);
        // Blend: don't fully trust the analytic if safety is low.
        probability *= 0.35 + 0.65 * safety;
      }
    }

    if (jokerUnseen === 1) {
      probability *= 1 - live * JOKER_THREAT;
    }

    return Math.max(0, Math.min(1, probability));
  }

  /**
   * Chance that any given unseen card sits in a hand that still plays after us.
   * Uses actual remaining hand sizes, so short deals (PERCENTS / ladder) correctly
   * treat most of the 36-card deck as never dealt and therefore harmless.
   */
  private liveFraction(
    context: DecisionContext,
    seen: Set<string>,
    playersAfter: number,
  ): number {
    const unseen = Math.max(1, 36 - seen.size);
    const liveCards = this.cardsHeldByNextPlayers(context, playersAfter);
    return Math.min(1, Math.max(0, liveCards / unseen));
  }

  private cardsHeldByNextPlayers(context: DecisionContext, playersAfter: number): number {
    const total = context.state.players.length;
    let held = 0;
    for (let step = 1; step <= playersAfter; step += 1) {
      const index = (context.state.currentPlayerIndex + step) % total;
      if (index === context.myIndex) {
        continue;
      }
      held += context.state.players[index]?.cards.length ?? 0;
    }
    return held;
  }

  private unseenRanksInSuit(suit: Suit, seen: Set<string>): number[] {
    const ranks: number[] = [];
    for (const deckCard of FULL_DECK) {
      if (deckCard.suit !== suit || deckCard.isJoker) {
        continue;
      }
      if (!seen.has(deckCard.key)) {
        ranks.push(rankValue(deckCard.rank));
      }
    }
    return ranks.sort((a, b) => b - a);
  }

  private countUnseenHigher(suit: Suit, higherThan: CardModel, seen: Set<string>): number {
    const threshold = rankValue(higherThan.rank);
    let count = 0;
    for (const deckCard of FULL_DECK) {
      if (deckCard.suit !== suit || deckCard.isJoker) {
        continue;
      }
      if (rankValue(deckCard.rank) <= threshold) {
        continue;
      }
      if (!seen.has(deckCard.key)) {
        count += 1;
      }
    }
    return count;
  }

  private countUnseenSuit(suit: Suit, seen: Set<string>): number {
    let count = 0;
    for (const deckCard of FULL_DECK) {
      if (deckCard.suit !== suit || deckCard.isJoker) {
        continue;
      }
      if (!seen.has(deckCard.key)) {
        count += 1;
      }
    }
    return count;
  }

  // ── Joker policy ────────────────────────────────────────────────────────

  private defaultJokerAction(context: DecisionContext): JokerAction {
    const { mode } = this.evaluateMode(context);
    const isLead = context.state.tableCards.length === 0;
    const trump = context.state.trumpSuit;

    // Mid-trick: TAKE or DROP by who should receive the trick.
    if (!isLead && context.state.tableCards.length > 0) {
      const boardWinnerSlot = resolveWinnerIndex(
        context.state.tableCards.map((played) => ({
          card: played.card,
          jokerAction: played.jokerAction,
        })),
        context.state.trumpSuit,
        context.state.currentTrickLeadSuit ?? null,
      );
      if (boardWinnerSlot >= 0) {
        const recipient = this.playerIndexForTableSlot(context, boardWinnerSlot);
        if (recipient >= 0 && recipient !== context.myIndex) {
          if (shouldDefendSecondFromZero(context)) {
            const threats = detectOpponentZeroThreats(context);
            const threat = threats.find((entry) => entry.playerIndex === recipient);
            if (threat) {
              const feedPref = trickPreferenceVsThreat(threat, true);
              const denyPref = trickPreferenceVsThreat(threat, false);
              if (feedPref > denyPref + 20) {
                return { type: 'DROP' };
              }
              if (denyPref > feedPref + 20) {
                return { type: 'TAKE' };
              }
            }
          }
          const feed = this.standingUtilityAfterTrick(context, recipient);
          const steal = this.standingUtilityAfterTrick(context, context.myIndex);
          if (feed > steal + 3) {
            return { type: 'DROP' };
          }
          if (steal > feed + 3) {
            return { type: 'TAKE' };
          }
        }
      }
    }

    if (!isLead) {
      if (mode === 'dump_all' || mode === 'avoid') {
        return { type: 'DROP' };
      }
      // Reserve joker TAKE when we need more than one trick later.
      const need = tricksNeeded(context);
      const left = remainingTricks(context);
      if (need === 1 && left > 2) {
        // Prefer not to be forced here — but if we must play joker mid-trick
        // while reserving, still TAKE (we wouldn't have chosen joker otherwise).
        return { type: 'TAKE' };
      }
      return { type: 'TAKE' };
    }

    if (mode === 'dump_all' || mode === 'avoid') {
      return { type: 'DROP', suit: this.pickDropLeadSuit(context) };
    }

    // Lead in win mode: DEMAND establishment only if that suit is cash-safe;
    // otherwise DEMAND trump to strip ruffers, or plain TAKE.
    const plan = this.bestEstablishmentSuit(context);
    if (plan) {
      const probe: CardModel = {
        suit: plan.suit,
        rank: 'A',
        isJoker: false,
      };
      const safety = this.leadCashSafety(probe, context);
      if (safety >= 0.45 || context.state.trumpSuit === null) {
        return { type: 'DEMAND_SUIT', suit: plan.suit };
      }
    }
    if (trump) {
      // Pull trumps when side suits are poisoned by known ruffers.
      return { type: 'DEMAND_SUIT', suit: trump };
    }
    return { type: 'TAKE' };
  }

  private pickDropLeadSuit(context: DecisionContext): Suit {
    const trump = context.state.trumpSuit;
    let best: Suit = 'HEARTS';
    let bestLen = -1;
    for (const suit of SUITS) {
      if (suit === trump) {
        continue;
      }
      const len = knownHand(context.me.cards).filter(
        (card) => !isJokerCard(card) && card.suit === suit,
      ).length;
      if (len > bestLen) {
        bestLen = len;
        best = suit;
      }
    }
    return best;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private posture(context: DecisionContext): Posture {
    const gap = this.scoreGap(context);
    if (gap < -STANDING_GAP) {
      return 'behind';
    }
    if (gap > STANDING_GAP) {
      return 'ahead';
    }
    return 'normal';
  }

  /** Positive when we lead the table; negative when we trail the leader. */
  private scoreGap(context: DecisionContext): number {
    const others = context.state.players
      .filter((_player, index) => index !== context.myIndex)
      .map((player) => player.score);
    const maxOther = Math.max(...others, Number.NEGATIVE_INFINITY);
    return context.me.score - maxOther;
  }

  private pickNearestBid(allowed: number[], target: number): number {
    let bestBid = allowed[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const bid of allowed) {
      const distance = Math.abs(bid - target);
      if (
        distance < bestDistance - 1e-9
        || (Math.abs(distance - bestDistance) <= 1e-9 && bid < bestBid)
      ) {
        bestDistance = distance;
        bestBid = bid;
      }
    }
    return bestBid;
  }

  private jokerRank(candidate: Candidate): number {
    return candidate.jokerAction ? 1 : 0;
  }

  private best(
    candidates: Candidate[],
    compare: (a: Candidate, b: Candidate) => number,
  ): Candidate {
    let winner = candidates[0];
    for (let index = 1; index < candidates.length; index += 1) {
      if (compare(candidates[index], winner) < 0) {
        winner = candidates[index];
      }
    }
    return winner;
  }
}

/**
 * Count tricks won by leading a suit top-down while opponents must follow.
 * `pulls` removes that many of the opponents' highest cards first (joker DEMAND).
 */
function suitWinnersGreedy(myDesc: number[], unseenDesc: number[], pulls: number): number {
  const opponent = unseenDesc.slice(Math.max(0, pulls));
  let high = 0;
  let low = opponent.length - 1;
  let winners = 0;
  for (const myCard of myDesc) {
    if (high <= low && opponent[high] > myCard) {
      high += 1;
    } else {
      winners += 1;
      if (high <= low) {
        low -= 1;
      }
    }
  }
  return winners;
}
