/**
 * GLM — predictive, pragmatic bot for «Расписной покер».
 *
 * Design priorities (must finish well within the ~2s turn budget):
 *  - Predictive bidding: per-card win probabilities feed a Poisson-binomial
 *    PMF, then a scoring EV selects the bid. Opponents' already-placed bids are
 *    folded into the projection so we don't pretend tricks that rivals have
 *    contractually claimed are still available to us.
 *  - Risk-aware posture: behind on the table ⇒ accept variance (slight up-tilt);
 *    ahead ⇒ shade toward safer makes. Big contracts get an undertrick penalty
 *    that scales with bid size, so we don't suicide into −10·bid.
 *  - Predictive 2-trick play: for every legal candidate we model
 *    P(win)·U(I take) + P(lose)·avg U(recipient takes). U projects end-of-round
 *    points for every player (own contract-aware, opponents fair-share) and
 *    subtracts rivalry-weighted rival points. A short lookahead term nudges us
 *    to keep a future winner when we still need tricks, and to dump a high card
 *    once the contract is met.
 *  - Round-type awareness: GOLD → take all, MISER → dump all, PERCENTS →
 *    amplified EV (×3 scoring), DARK → fair-share anchor with posture tilt,
 *    NO_TRUMP → long-suit establishment via Ace lead + joker DEMAND.
 *  - Endgame navigation: reuses zeroPath for the 0-score 2nd place rule, and
 *    denies opponent zero-seekers when we hold 2nd by points and 1st is
 *    unreachable.
 *  - Joker policy: TAKE to secure a needed trick, DROP to dump, DEMAND_SUIT to
 *    pull the top honour of a long suit in no-trump (establishment).
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

/** Probability above which a card is treated as a reliable winner. */
const WIN_THRESHOLD = 0.5;
/** Cost "budget" constants so joker handling is consistent across modes. */
const JOKER_WIN_COST = 100;
const JOKER_DROP_COST = 12;
/** Soft prior on opponents being void in a side suit as the round matures. */
const BASE_VOID_FACTOR = 0.35;
/** Tuning weights for the play-value decomposition. */
const RIVALRY_BASE = 0.9;
const TACTICAL_SCALE = 2.4;
const DENY_ZERO_SCALE = 3.0;
/** Penalty applied to high bids with high undertrick probability. */
const UNDERTRICK_RISK_WEIGHT = 7;
/** Lookahead contribution to the play utility. */
const LOOKAHEAD_WEIGHT = 0.55;

type PlayMode = 'win' | 'avoid' | 'take_all' | 'dump_all';

type Posture = 'behind' | 'ahead' | 'normal';

interface Candidate {
  cardIndex: number;
  jokerAction?: JokerAction;
  winProb: number;
  cost: number;
}

export class GlmStrategy implements Strategy {
  public readonly name = 'GLM';

  private roundKey = '';
  private readonly seen = new Set<string>();
  private pendingJokerAction: JokerAction | undefined;

  // ── Observation ────────────────────────────────────────────────────────

  public observe(context: DecisionContext): void {
    const { state } = context;
    const key =
      `${state.currentRoundIndex ?? 0}|${state.controlGamesPlayed ?? 0}`
      + `|${state.currentRoundType}|${state.currentRoundCards}`;
    if (key !== this.roundKey) {
      this.roundKey = key;
      this.seen.clear();
    }
    for (const played of state.tableCards) {
      this.seen.add(cardKey(played.card));
    }
    for (const card of knownHand(context.me.cards)) {
      this.seen.add(cardKey(card));
    }
  }

  // ── Bidding ────────────────────────────────────────────────────────────

  public chooseBid(context: DecisionContext): number {
    this.observe(context);
    const allowed = context.state.allowedBids ?? [];
    if (allowed.length === 0) {
      return 0;
    }
    if (allowed.length === 1) {
      return allowed[0];
    }

    // Endgame: sacrificial underbid to land on exactly 0 (2nd place rule).
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

    const probs = hand.map((card) =>
      isJokerCard(card)
        ? this.winProbability(card, { type: 'TAKE' }, context)
        : this.winProbability(card, undefined, context),
    );
    return this.bidByExpectedValue(context, allowed, probs);
  }

  private bidDark(context: DecisionContext, allowed: number[]): number {
    const handSize = context.state.currentRoundCards;
    const players = context.state.maxPlayers;
    const fairShare = handSize / players;
    const posture = this.posture(context);
    let target = fairShare;
    if (posture === 'behind') {
      target = Math.ceil(fairShare);
    } else if (posture === 'ahead') {
      target = Math.floor(fairShare);
    }
    if (target < 1) {
      target = 1;
    }
    return this.pickNearestBid(allowed, target);
  }

  /**
   * EV-maximising bid with risk shading.
   *
   * Predictive: opponents' placed bids reduce the pool of tricks realistically
   * available to us, so we cap the expected-trick anchor (and rescale the PMF)
   * before evaluating each bid's scoring EV.
   */
  private bidByExpectedValue(
    context: DecisionContext,
    allowed: number[],
    probs: number[],
  ): number {
    const roundType = context.state.currentRoundType;
    const cardsInHand = context.state.currentRoundCards;

    // Predictive cap: opponents have contractually claimed some tricks; we
    // can't expect to win more than what's left, with a soft discount for
    // opponents who will miss their contracts.
    const claimPressure = this.opponentClaimPressure(context);
    const maxAvailable = Math.max(0, cardsInHand - claimPressure);
    const adjustedProbs = probs.slice();
    const rawExpected = adjustedProbs.reduce((sum, p) => sum + p, 0);
    if (rawExpected > maxAvailable && rawExpected > 0) {
      const scale = maxAvailable / rawExpected;
      for (let i = 0; i < adjustedProbs.length; i += 1) {
        adjustedProbs[i] *= scale;
      }
    }
    const pmf = poissonBinomialPmf(adjustedProbs);
    const adjustedExpected = Math.min(rawExpected, maxAvailable);

    const posture = this.posture(context);
    const varianceTilt =
      posture === 'behind' ? 0.3
      : posture === 'ahead' ? -0.22
      : 0;

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
      // Penalise bids with high probability of failing the contract.
      const riskPenalty = UNDERTRICK_RISK_WEIGHT * undertrickMass * Math.max(1, bid);
      // Soft pull toward the predictive anchor.
      const proximity = -Math.abs(bid - adjustedExpected) * 1.2;
      const utility = ev - riskPenalty + proximity + varianceTilt * bid;

      const better =
        utility > bestScore + 1e-9
        || (Math.abs(utility - bestScore) <= 1e-9
          && Math.abs(bid - adjustedExpected) < Math.abs(bestBid - adjustedExpected));
      if (better) {
        bestScore = utility;
        bestBid = bid;
      }
    }
    return bestBid;
  }

  /**
   * Estimate how many of the remaining tricks opponents have already
   * "claimed" via their bids. We don't trust their bids literally, but a table
   * that has collectively bid high leaves us fewer realistic chances.
   */
  private opponentClaimPressure(context: DecisionContext): number {
    const cardsInHand = context.state.currentRoundCards;
    let claimed = 0;
    let opponents = 0;
    for (const player of context.state.players) {
      if (player.id === context.myId) {
        continue;
      }
      opponents += 1;
      const bid = player.currentBid ?? 0;
      // Trust bids up to a fair share; treat excess as bluff/overreach noise.
      const fair = cardsInHand / context.state.maxPlayers;
      const trustedBid = Math.min(bid, Math.ceil(fair * 1.5));
      claimed += trustedBid;
    }
    if (opponents === 0) {
      return 0;
    }
    // Soft discount: opponents often miss their contracts.
    return claimed * 0.55;
  }

  // ── Play ───────────────────────────────────────────────────────────────

  public chooseCard(context: DecisionContext): number {
    this.observe(context);
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
            cost: this.cardCost(card, jokerAction),
          });
        }
        continue;
      }
      candidates.push({
        cardIndex: play.cardIndex,
        winProb: this.winProbability(card, undefined, context),
        cost: this.cardCost(card, undefined),
      });
    }
    if (candidates.length > 0) {
      return candidates;
    }
    // Defensive fallback: never return an empty list to the selector.
    return legal.map((play) => {
      const card = context.me.cards[play.cardIndex]!;
      return {
        cardIndex: play.cardIndex,
        winProb: this.winProbability(card, undefined, context),
        cost: this.cardCost(card, undefined),
      };
    });
  }

  /**
   * Total play utility = zeroPath bias + deny-zero bias + tournament EV
   * + tactical prior + 2-trick lookahead. Weights shift when our own zero
   * mission or deny-zero defense is active so the right term dominates.
   */
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
      // Stable tactical tie-breakers — keep selection deterministic.
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
    const tourneyScale = zeroPlan.active ? 0.15 : defending ? 0.4 : 1;
    const tacticalScale = defending ? TACTICAL_SCALE * 0.55 : TACTICAL_SCALE;
    return (
      zeroBias
      + denyBias
      + tourneyScale * this.tournamentEV(candidate, context)
      + tacticalScale * this.tacticalBias(candidate, mode, urgent)
      + LOOKAHEAD_WEIGHT * this.lookaheadBias(candidate, mode, context)
    );
  }

  /**
   * Two-trick micro-lookahead: if we win this trick, does our remaining hand
   * still contain a likely winner for the next needed trick? Encourages saving
   * a strong card when we need multiple tricks, and dumping high losers when
   * the contract is already met.
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
    const remainingAfter = hand.filter((_, index) => index !== candidate.cardIndex);
    if (remainingAfter.length === 0) {
      return 0;
    }

    if (mode === 'win' || mode === 'take_all') {
      const currentNeed = tricksNeeded(context);
      const wouldWin = candidate.winProb >= WIN_THRESHOLD;
      const remainingNeed = currentNeed - (wouldWin ? 1 : 0);
      if (remainingNeed <= 0) {
        // Winning this trick meets the contract — pure win, small bonus.
        return wouldWin ? 6 : 0;
      }
      // Only apply "save winner for next trick" when we need multiple tricks;
      // with a single trick left to make, taking now is always right.
      if (currentNeed >= 2) {
        let bestFuture = 0;
        for (const card of remainingAfter) {
          if (isJokerCard(card)) {
            bestFuture = Math.max(bestFuture, 1);
            continue;
          }
          const p = this.winProbability(card, undefined, context);
          bestFuture = Math.max(bestFuture, p);
        }
        return bestFuture * 6 - candidate.cost * 0.03;
      }
      return 0;
    }

    if (mode === 'avoid' || mode === 'dump_all') {
      // Prefer to dump the highest-cost loser now (cheaper cards keep flexibility).
      return candidate.cost * 0.06 * (candidate.winProb < WIN_THRESHOLD ? 1 : -0.5);
    }
    return 0;
  }

  /**
   * Zero-path trick budget enforcer. When the endgame mission is to land on
   * exactly 0, this overrides normal play with strong take/dump directives.
   */
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

  /**
   * Counter zero-seekers who would steal 2nd place via the 0-score rule.
   * Active only when we hold 2nd by points, 1st is unreachable, and a trailer
   * is steering toward 0. Own zero mission always takes precedence.
   */
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

      const takenIfIWin = threat.taken;
      const projectEnd = (takenNow: number): number => {
        let finalTaken = takenNow;
        if (threat.kind === 'gold_exact' && threat.idealTaken !== null) {
          const need = Math.max(0, threat.idealTaken - takenNow);
          finalTaken = takenNow + Math.min(need, remainingAfter);
        } else if (threat.kind === 'hold_zero') {
          finalTaken = takenNow;
        } else if (threat.kind === 'underbid_miss') {
          finalTaken = takenNow;
        } else {
          finalTaken = takenNow + Math.round(remainingAfter / n);
        }
        return scoreThreatOutcome(threat, finalTaken, roundType, cards);
      };

      const uWin = projectEnd(takenIfIWin);
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
      value += candidate.winProb * (urgent ? 6 : 2.2);
      value -= candidate.cost * 0.025;
      if (!urgent && candidate.winProb >= WIN_THRESHOLD) {
        value += (20 - Math.min(20, candidate.cost)) * 0.08;
      }
    } else {
      value += (1 - candidate.winProb) * 4.5;
      value += candidate.cost * 0.04;
      if (candidate.jokerAction && candidate.jokerAction.type !== 'DROP') {
        value -= 2.5;
      }
    }
    if (candidate.cost >= JOKER_WIN_COST) {
      value -= 1.2;
    }
    return value;
  }

  /**
   * E[standing utility | play] = P(win)·U(I take) + P(lose)·avg U(recipient).
   * U = my projected round points − rivalry-weighted opponent points, plus an
   * explicit anti-zero term when defending 2nd from an opponent zero-seeker.
   */
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

  /**
   * Soft projection of end-of-round tricks. Opponents use fair-share only so
   * that feeding/denying *this* trick still moves them across exact-bid
   * thresholds; we ourselves follow contract mode for a smarter self-forecast.
   */
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
        return Math.round(takenNow + Math.min(remainingAfter, fair * 0.2));
      }
      if (mode === 'win' || mode === 'take_all') {
        const push = Math.min(remainingAfter, need * 0.7 + fair * 0.3);
        return Math.round(takenNow + push);
      }
    }
    return Math.round(takenNow + fair);
  }

  /**
   * How much we protect our own round score vs table warfare. Contract already
   * met → free to grief; must-make → less sacrifice; behind → accept self-damage
   * to kneecap the leader.
   */
  private personalWeight(context: DecisionContext): number {
    if (planZeroPath(context).active) {
      return 0.2;
    }
    if (shouldDefendSecondFromZero(context)) {
      return 0.4;
    }
    const roundType = context.state.currentRoundType;
    if (roundType === 'GOLD') {
      return 1.15;
    }
    if (roundType === 'MISER') {
      return 1.25;
    }
    const need = tricksNeeded(context);
    const left = remainingTricks(context);
    if (need <= 0) {
      return 0.5;
    }
    if (need >= left && need > 0) {
      return 2.4;
    }
    if (need > left * 0.6) {
      return 1.7;
    }
    const myScore = context.me.score;
    const leaderScore = Math.max(
      ...context.state.players.map((player, index) =>
        (index === context.myIndex ? -Infinity : player.score)),
      myScore,
    );
    if (leaderScore - myScore >= 30) {
      return 0.7;
    }
    return 1.0;
  }

  /** Leaders and live contracts get hunted hardest; trailers get ignored. */
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
    if (theirScore >= best - 2) {
      weight += 0.75;
    } else if (theirScore >= best - 15) {
      weight += 0.35;
    }
    if (gap > 0) {
      weight += Math.min(0.65, gap / 70);
    } else if (gap < -35) {
      weight *= 0.4;
    } else if (gap > -20 && gap < 0) {
      weight += 0.2;
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
      weight *= 1 + Math.min(1.2, swing / 80);
      if (taken === bid) {
        weight *= 1.35;
      }
      if (taken === bid - 1 && bid >= 2) {
        weight *= 1.4;
      }
    }
    if (roundType === 'PERCENTS') {
      weight *= 1.45;
    }
    return Math.max(0.15, weight);
  }

  // ── Recipients / mode ─────────────────────────────────────────────────

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
    const after = this.playersAfterMe(context);
    if (after.length > 0) {
      return after;
    }
    return this.opponentIndices(context);
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
    return { mode: 'win', urgent: need > left * 0.6 };
  }

  // ── Card math ──────────────────────────────────────────────────────────

  private cardCost(card: CardModel, jokerAction: JokerAction | undefined): number {
    if (isJokerCard(card)) {
      if (jokerAction?.type === 'DROP') {
        return JOKER_DROP_COST;
      }
      return JOKER_WIN_COST;
    }
    return rankValue(card.rank);
  }

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
    const amWinning = winnerIndex === plays.length - 1;
    if (!amWinning) {
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
    const candidateIsTrump = trumpSuit !== null && candidate.suit === trumpSuit;
    const jokerUnseen = seen.has(JOKER_KEY) ? 0 : 1;
    let beaters: number;
    if (candidateIsTrump) {
      beaters = this.countUnseen(trumpSuit, candidate, seen, true) + jokerUnseen;
    } else {
      const higherSameSuit = this.countUnseen(candidate.suit, candidate, seen, true);
      const trumpsTotal =
        trumpSuit !== null ? this.countUnseen(trumpSuit, null, seen, false) : 0;
      const progress =
        1 - knownHand(context.me.cards).length / Math.max(1, context.state.currentRoundCards);
      const voidFactor = Math.min(0.85, BASE_VOID_FACTOR + progress * 0.35);
      beaters = higherSameSuit + trumpsTotal * voidFactor + jokerUnseen;
    }
    const unseenCount = Math.max(1, 36 - seen.size);
    const perOpponent = Math.min(0.98, beaters / unseenCount);
    const winProb = Math.pow(1 - perOpponent, playersAfter);
    return Math.max(0, Math.min(1, winProb));
  }

  private countUnseen(
    suit: Suit,
    higherThan: CardModel | null,
    seen: Set<string>,
    excludeLowerOrEqual: boolean,
  ): number {
    const threshold = higherThan ? rankValue(higherThan.rank) : -1;
    let count = 0;
    for (const deckCard of FULL_DECK) {
      if (deckCard.suit !== suit || deckCard.isJoker) {
        continue;
      }
      if (excludeLowerOrEqual && rankValue(deckCard.rank) <= threshold) {
        continue;
      }
      if (seen.has(deckCard.key)) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  // ── Joker / control / start ───────────────────────────────────────────

  private defaultJokerAction(context: DecisionContext): JokerAction {
    const { mode } = this.evaluateMode(context);
    const isLead = context.state.tableCards.length === 0;
    const trump = context.state.trumpSuit;

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
      return { type: 'TAKE' };
    }

    if (mode === 'dump_all' || mode === 'avoid') {
      return { type: 'DROP', suit: this.pickDropLeadSuit(context) };
    }

    // Lead in win mode: prefer establishment DEMAND in no-trump long suits.
    if (trump === null) {
      const demandSuit = this.pickEstablishmentSuit(context);
      if (demandSuit) {
        return { type: 'DEMAND_SUIT', suit: demandSuit };
      }
    }
    if (trump) {
      return { type: 'DEMAND_SUIT', suit: trump };
    }
    return { type: 'TAKE' };
  }

  /** Longest side suit with at least one honour — establishment DEMAND target. */
  private pickEstablishmentSuit(context: DecisionContext): Suit | null {
    const hand = knownHand(context.me.cards);
    let best: Suit | null = null;
    let bestScore = -1;
    for (const suit of SUITS) {
      const mine = hand.filter((card) => !isJokerCard(card) && card.suit === suit);
      if (mine.length < 2) {
        continue;
      }
      const hasHonour = mine.some((card) => rankValue(card.rank) >= rankValue('10'));
      const score = mine.length + (hasHonour ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = suit;
      }
    }
    return best;
  }

  private pickDropLeadSuit(context: DecisionContext): Suit {
    const trump = context.state.trumpSuit;
    let best: Suit = 'HEARTS';
    let bestLen = -1;
    for (const suit of SUITS) {
      if (suit === trump) {
        continue;
      }
      const len = knownHand(context.me.cards).filter((card) => card.suit === suit).length;
      if (len > bestLen) {
        bestLen = len;
        best = suit;
      }
    }
    return best;
  }

  public chooseControlGame(
    context: DecisionContext,
  ): { roundType: RoundType; dealerIndex: number } {
    const zeroSetup = chooseZeroControlSetup(context);
    if (zeroSetup) {
      return zeroSetup;
    }

    const played = context.state.playedRoundTypes ?? ['STANDARD'];
    const myScore = context.me.score;
    const scores = context.state.players.map((player) => player.score);
    const maxOther = Math.max(
      ...scores.filter((_, index) => index !== context.myIndex),
      Number.NEGATIVE_INFINITY,
    );

    let preferred: RoundType[];
    if (myScore < maxOther) {
      preferred = ['MISER', 'GOLD', 'PERCENTS', 'DARK', 'NO_TRUMP', 'STANDARD'];
    } else {
      preferred = ['STANDARD', 'NO_TRUMP', 'DARK', 'PERCENTS', 'GOLD', 'MISER'];
    }
    let roundType: RoundType = played[0] ?? 'STANDARD';
    for (const candidate of preferred) {
      if (played.includes(candidate)) {
        roundType = candidate;
        break;
      }
    }

    // When behind, make the leader dealer so they face «Кроме» pressure.
    let dealerIndex = context.myIndex >= 0 ? context.myIndex : 0;
    if (myScore < maxOther) {
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

  // ── Helpers ────────────────────────────────────────────────────────────

  private posture(context: DecisionContext): Posture {
    const others = context.state.players
      .filter((_player, index) => index !== context.myIndex)
      .map((player) => player.score);
    const maxOther = Math.max(...others, Number.NEGATIVE_INFINITY);
    const diff = context.me.score - maxOther;
    if (diff < -25) {
      return 'behind';
    }
    if (diff > 25) {
      return 'ahead';
    }
    return 'normal';
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
