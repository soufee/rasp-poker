/**
 * NoviceStrategy («Новичок») — SOTA calculating, pragmatic, predictive, and goal-oriented bot strategy.
 *
 * Designed to be highly competitive against strong heuristic players (Claude, Grok, Composer):
 *  - Bidding: Exact expected value (EV) optimization via Poisson binomial win probability distribution,
 *    suit-by-suit top-down establishment modeling, trump control valuation, and tournament standing risk shifts.
 *  - Zero Path Precision: Integrates zero-path planning (`ZeroPathPlanner`) to climb or dump towards exact
 *    0 points when behind near the end of the game (`Правило нулевого счёта`), and defends against opponent zero attempts.
 *  - Play Execution: Dynamic win/avoid mode switching based on contract urgency (`need` vs `remainingTricks`).
 *    Saves low cards by discarding high dangerous honors (`K`, `Q`, `A`) when avoiding/ducking (`DUMP`/`DUCK`),
 *    and wins efficiently with cheapest reliable winners or Joker `DEMAND_SUIT` (`pull`) runners when needing tricks.
 *  - Special Rounds: Adapts aggression for `PERCENTS` (x3 multiplier), `DARK` (blind fair share + standing),
 *    `GOLD` (take all profitable tricks), and `MISER` (duck all, or execute a `+100` Miser Sweep when holding top honors).
 */
import type { DecisionContext } from '../core/stateSelectors';
import type { CardModel, JokerAction, RoundType, Suit } from '../protocol/types';
import type { Strategy } from './Strategy';
import {
  cardKey,
  cardPower,
  FULL_DECK,
  isJokerCard,
  JOKER_KEY,
  rankValue,
  resolveWinnerIndex,
  SUITS,
  type TrickCard,
} from './cards';
import {
  bestSuitEstablishment,
  pickNearestBid,
  shouldDemandSuit,
} from './composerPlanner';
import { poissonBinomialPmf } from './probability';
import { scoreForRound } from './scoring';
import {
  chooseZeroBid,
  chooseZeroControlSetup,
  detectOpponentZeroThreats,
  isZeroPathAttractive,
  planZeroPath,
  shouldDefendSecondFromZero,
  trickPreferenceVsThreat,
} from './zeroPath';

const WIN_THRESHOLD = 0.5;
const JOKER_WIN_COST = 100;
const JOKER_DROP_COST = 12;
const TRUMP_COST_BASE = 20;
const BASE_VOID_FACTOR = 0.35;
const JOKER_THREAT = 0.5;
const DARK_MIN_BID = 1;
const RISK_MARGIN = 4;
const STANDING_THRESHOLD = 30;

interface Candidate {
  cardIndex: number;
  jokerAction?: JokerAction;
  winProb: number;
  cost: number;
}

type PlayMode = 'win' | 'avoid';
type Standing = 'behind' | 'ahead' | 'normal';

export class NoviceStrategy implements Strategy {
  public readonly name = 'Новичок';

  private roundKey = '';
  private lastKnownCount = 0;
  private readonly seen = new Set<string>();
  private cached: { version: number; cardIndex: number; jokerAction?: JokerAction } | null = null;

  public chooseBid(ctx: DecisionContext): number {
    this.remember(ctx);
    const allowed = ctx.state.allowedBids ?? [];
    if (allowed.length === 0) {
      return 0;
    }
    if (allowed.length === 1) {
      return allowed[0];
    }

    const known = this.knownCards(ctx);
    const blind = ctx.state.isDarkRound || ctx.state.currentRoundType === 'DARK' || known.length === 0;
    if (blind) {
      return this.chooseDarkBid(ctx, allowed);
    }

    // Zero Path End-Game Precision Check
    if (isZeroPathAttractive(ctx)) {
      const plan = planZeroPath(ctx);
      const zeroBid = chooseZeroBid(ctx, plan, allowed);
      if (zeroBid !== null && zeroBid !== undefined && allowed.includes(zeroBid)) {
        return zeroBid;
      }
    }

    return this.chooseBidByExpectedValue(ctx, allowed);
  }

  public chooseCard(ctx: DecisionContext): number {
    this.remember(ctx);
    const legal = ctx.state.validCardIndices ?? [];
    if (legal.length === 0) {
      return 0;
    }
    if (legal.length === 1) {
      this.cacheJoker(ctx, legal[0]);
      return legal[0];
    }

    const candidates = this.buildCandidates(ctx, legal);
    const { mode, urgent, need } = this.evaluateMode(ctx);

    let chosen: Candidate;
    if (mode === 'win') {
      chosen = this.selectForWin(candidates, urgent, need, ctx);
    } else {
      chosen = this.selectForAvoid(candidates, ctx);
    }

    const jokerAction = this.refineJokerAction(ctx, chosen, mode);
    this.cached = {
      version: ctx.state.stateVersion ?? 0,
      cardIndex: chosen.cardIndex,
      jokerAction,
    };
    return chosen.cardIndex;
  }

  public chooseJokerAction(ctx: DecisionContext, cardIndex: number): JokerAction {
    if (
      this.cached
      && this.cached.version === (ctx.state.stateVersion ?? 0)
      && this.cached.cardIndex === cardIndex
      && this.cached.jokerAction
    ) {
      return this.cached.jokerAction;
    }
    return this.fallbackJokerAction(ctx, cardIndex);
  }

  public chooseControlGame(ctx: DecisionContext): { roundType: RoundType; dealerIndex: number } {
    const zeroSetup = chooseZeroControlSetup(ctx);
    if (zeroSetup) {
      return zeroSetup;
    }

    const played = ctx.state.playedRoundTypes ?? ['STANDARD'];
    const behind = this.standing(ctx) === 'behind';
    const preference: RoundType[] = behind
      ? ['GOLD', 'PERCENTS', 'DARK', 'NO_TRUMP', 'STANDARD', 'MISER']
      : ['STANDARD', 'NO_TRUMP', 'PERCENTS', 'DARK', 'GOLD', 'MISER'];

    const roundType =
      preference.find((type) => played.includes(type))
      ?? (played[0] as RoundType)
      ?? 'STANDARD';

    // Assign dealer to strongest opponent if possible, giving them rule "Кроме" restriction
    let dealerIndex = ctx.myIndex >= 0 ? ctx.myIndex : 0;
    let maxOppScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < ctx.state.players.length; i++) {
      if (i !== ctx.myIndex && ctx.state.players[i].score > maxOppScore) {
        maxOppScore = ctx.state.players[i].score;
        dealerIndex = i;
      }
    }

    return { roundType, dealerIndex };
  }

  public shouldStartGame(ctx: DecisionContext): boolean {
    return (
      ctx.state.hostId === ctx.myId
      && (ctx.state.playersCount ?? ctx.state.players.length) === ctx.state.maxPlayers
    );
  }

  // === State & Memory ======================================================

  private remember(ctx: DecisionContext): void {
    const known = this.knownCards(ctx);
    const key =
      `${ctx.state.currentRoundIndex ?? 0}|${ctx.state.controlGamesPlayed ?? 0}`
      + `|${ctx.state.currentRoundType}|${ctx.state.currentRoundCards}`
      + `|${ctx.state.dealerIndex}|${ctx.state.trumpSuit ?? '-'}`;

    const freshDeal = known.length > this.lastKnownCount;
    if (key !== this.roundKey || freshDeal) {
      this.roundKey = key;
      this.seen.clear();
    }
    this.lastKnownCount = known.length;
    for (const played of ctx.state.tableCards) {
      this.seen.add(cardKey(played.card));
    }
    for (const card of known) {
      this.seen.add(cardKey(card));
    }
  }

  private knownCards(ctx: DecisionContext): CardModel[] {
    return ctx.me.cards.filter((card): card is CardModel => card !== null);
  }

  private standing(ctx: DecisionContext): Standing {
    const others = ctx.state.players
      .filter((_player, index) => index !== ctx.myIndex)
      .map((player) => player.score);
    const maxOther = Math.max(...others, Number.NEGATIVE_INFINITY);
    const diff = ctx.me.score - maxOther;
    if (diff < -STANDING_THRESHOLD) {
      return 'behind';
    }
    if (diff > STANDING_THRESHOLD) {
      return 'ahead';
    }
    return 'normal';
  }

  // === Bidding Engine ======================================================

  private chooseDarkBid(ctx: DecisionContext, allowed: number[]): number {
    const base = ctx.state.currentRoundCards / ctx.state.players.length;
    const standing = this.standing(ctx);
    let target = Math.round(base);
    if (standing === 'behind') {
      target = Math.ceil(base);
    } else if (standing === 'ahead') {
      target = Math.floor(base);
    }
    target = Math.max(DARK_MIN_BID, target);

    const nonZero = allowed.filter((bid) => bid !== 0);
    const pool = target > 0 && nonZero.length > 0 ? nonZero : allowed;
    return pickNearestBid(pool, target);
  }

  private bidDamping(playersCount: number, roundType: RoundType): number {
    let value = 0.88 - 0.03 * (playersCount - 3);
    let damping = Math.max(0.74, Math.min(0.9, value));
    if (roundType === 'NO_TRUMP') {
      damping *= 0.9;
    } else if (roundType === 'PERCENTS') {
      // In Percents, shade slightly conservative to avoid heavy undertrick penalty (-30 * bid)
      damping *= 0.94;
    }
    return damping;
  }

  private bidTrickPmf(ctx: DecisionContext): number[] {
    const known = this.knownCards(ctx);
    const damping = this.bidDamping(ctx.state.players.length, ctx.state.currentRoundType);
    const probs = known.map((card) => this.leadWinProbability(card, ctx) * damping);

    const bonus = this.establishmentBonus(ctx);
    if (bonus > 0) {
      probs.push(Math.min(0.95, bonus));
    }
    return poissonBinomialPmf(probs);
  }

  private establishmentBonus(ctx: DecisionContext): number {
    if (ctx.state.trumpSuit !== null) {
      return 0;
    }
    const known = this.knownCards(ctx);
    if (!known.some((card) => isJokerCard(card))) {
      return 0;
    }
    const seen = new Set(this.seen);
    let best = 0;
    for (const suit of SUITS) {
      const myRanks = known
        .filter((card) => !isJokerCard(card) && card.suit === suit)
        .map((card) => rankValue(card.rank))
        .sort((a, b) => b - a);
      if (myRanks.length < 2) {
        continue;
      }
      const unseenHigher = this.unseenRanksInSuit(suit, seen);
      const withoutPull = this.suitWinnersGreedy(myRanks, unseenHigher, 0);
      const withPull = this.suitWinnersGreedy(myRanks, unseenHigher, 1);
      best = Math.max(best, withPull - withoutPull);
    }
    return Math.min(1, best) * 0.65;
  }

  private suitWinnersGreedy(myDesc: number[], unseenDesc: number[], pulls: number): number {
    const opponent = unseenDesc.slice(pulls);
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

  private chooseBidByExpectedValue(ctx: DecisionContext, allowed: number[]): number {
    const cardsInHand = ctx.state.currentRoundCards;
    const pmf = this.bidTrickPmf(ctx);
    const expected = pmf.reduce((sum, weight, taken) => sum + weight * taken, 0);
    const roundType = ctx.state.currentRoundType;

    const evOf = (bid: number): number => {
      let value = 0;
      for (let taken = 0; taken < pmf.length; taken += 1) {
        value += pmf[taken] * scoreForRound(roundType, cardsInHand, bid, taken);
      }
      return value;
    };

    let bestBid = allowed[0];
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const bid of allowed) {
      const score = evOf(bid);
      const better =
        score > bestScore + 1e-9
        || (Math.abs(score - bestScore) <= 1e-9 && Math.abs(bid - expected) < Math.abs(bestBid - expected));
      if (better) {
        bestScore = score;
        bestBid = bid;
      }
    }

    return this.applyRiskShift(ctx, allowed, bestBid, evOf);
  }

  private applyRiskShift(
    ctx: DecisionContext,
    allowed: number[],
    bestBid: number,
    evOf: (bid: number) => number,
  ): number {
    const standing = this.standing(ctx);
    const margin = ctx.state.currentRoundType === 'PERCENTS' ? RISK_MARGIN * 1.5 : RISK_MARGIN;
    if (standing === 'behind' && allowed.includes(bestBid + 1)) {
      if (evOf(bestBid + 1) >= evOf(bestBid) - margin) {
        return bestBid + 1;
      }
    }
    if (standing === 'ahead' && allowed.includes(bestBid - 1)) {
      if (evOf(bestBid - 1) >= evOf(bestBid) - margin) {
        return bestBid - 1;
      }
    }
    return bestBid;
  }

  // === Play Engine =========================================================

  private buildCandidates(ctx: DecisionContext, legal: number[]): Candidate[] {
    const trump = ctx.state.trumpSuit;
    const candidates: Candidate[] = [];
    for (const index of legal) {
      const card = ctx.me.cards[index];
      if (!card) {
        continue;
      }
      if (isJokerCard(card)) {
        for (const jokerAction of this.legalJokerActions(ctx, index)) {
          candidates.push({
            cardIndex: index,
            jokerAction,
            winProb: this.winProbability(card, jokerAction, ctx),
            cost: this.cardCost(card, jokerAction, trump),
          });
        }
        continue;
      }
      candidates.push({
        cardIndex: index,
        winProb: this.winProbability(card, undefined, ctx),
        cost: this.cardCost(card, undefined, trump),
      });
    }
    return candidates;
  }

  private legalJokerActions(ctx: DecisionContext, cardIndex: number): JokerAction[] {
    const fromServer = ctx.state.legalPlays?.find((play) => play.cardIndex === cardIndex);
    if (fromServer?.jokerActions && fromServer.jokerActions.length > 0) {
      return fromServer.jokerActions;
    }
    if (ctx.state.tableCards.length === 0) {
      const leadActions: JokerAction[] = [{ type: 'TAKE' }];
      for (const suit of SUITS) {
        leadActions.push({ type: 'DEMAND_SUIT', suit });
      }
      for (const suit of SUITS) {
        leadActions.push({ type: 'DROP', suit });
      }
      return leadActions;
    }
    return [{ type: 'TAKE' }, { type: 'DROP' }];
  }

  private refineJokerAction(
    ctx: DecisionContext,
    chosen: Candidate,
    mode: PlayMode,
  ): JokerAction | undefined {
    if (!chosen.jokerAction) {
      return undefined;
    }
    const leading = ctx.state.tableCards.length === 0;
    if (mode === 'win' && leading && chosen.jokerAction.type !== 'DROP') {
      const demand = this.pickDemandSuit(ctx);
      if (demand) {
        const legal = this.legalJokerActions(ctx, chosen.cardIndex);
        const allowed = legal.some(
          (action) => action.type === 'DEMAND_SUIT' && action.suit === demand,
        );
        if (allowed) {
          return { type: 'DEMAND_SUIT', suit: demand };
        }
      }
    }
    return chosen.jokerAction;
  }

  private fallbackJokerAction(ctx: DecisionContext, cardIndex?: number): JokerAction {
    const { mode } = this.evaluateMode(ctx);
    const leading = ctx.state.tableCards.length === 0;
    const legal = cardIndex !== undefined ? this.legalJokerActions(ctx, cardIndex) : null;

    let target: JokerAction;
    if (mode === 'avoid') {
      target = leading ? { type: 'DROP', suit: this.pickDropSuit(ctx) } : { type: 'DROP' };
    } else if (leading) {
      const demand = this.pickDemandSuit(ctx);
      target = demand ? { type: 'DEMAND_SUIT', suit: demand } : { type: 'TAKE' };
    } else {
      target = { type: 'TAKE' };
    }

    if (legal && legal.length > 0) {
      const found = legal.find(
        (a) => a.type === target.type && (a.type !== 'DEMAND_SUIT' && a.type !== 'DROP' || 'suit' in a && 'suit' in target && a.suit === target.suit)
      );
      if (found) return found;
      return legal[0];
    }
    return target;
  }

  private cacheJoker(ctx: DecisionContext, cardIndex: number): void {
    const card = ctx.me.cards[cardIndex];
    if (card && isJokerCard(card)) {
      this.cached = {
        version: ctx.state.stateVersion ?? 0,
        cardIndex,
        jokerAction: this.fallbackJokerAction(ctx, cardIndex),
      };
    }
  }

  private pickDemandSuit(ctx: DecisionContext): Suit | null {
    const known = this.knownCards(ctx);
    let best: Suit | null = null;
    let bestScore = -1;
    for (const suit of SUITS) {
      const mine = known.filter((card) => !isJokerCard(card) && card.suit === suit);
      if (mine.length === 0) {
        continue;
      }
      const hasHigh = mine.some((card) => rankValue(card.rank) >= rankValue('Q'));
      const score = mine.length + (hasHigh ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = suit;
      }
    }
    return best;
  }

  private pickDropSuit(ctx: DecisionContext): Suit {
    const trump = ctx.state.trumpSuit;
    let best: Suit = 'HEARTS';
    let bestLength = -1;
    for (const suit of SUITS) {
      if (suit === trump) {
        continue;
      }
      const length = this.knownCards(ctx).filter(
        (card) => !isJokerCard(card) && card.suit === suit,
      ).length;
      if (length > bestLength) {
        bestLength = length;
        best = suit;
      }
    }
    return best;
  }

  private evaluateMode(ctx: DecisionContext): { mode: PlayMode; urgent: boolean; need: number } {
    const roundType = ctx.state.currentRoundType;
    if (roundType === 'GOLD') {
      return { mode: 'win', urgent: false, need: 1 };
    }
    if (roundType === 'MISER') {
      // Check for Miser Sweep (+100 points for taking ALL tricks)
      const known = this.knownCards(ctx);
      const remainingTricks = known.length;
      const alreadyTaken = ctx.me.tricksTaken;
      const totalTricks = ctx.state.currentRoundCards;
      const canStillSweep = (alreadyTaken + remainingTricks === totalTricks);
      if (canStillSweep && totalTricks > 1) {
        const sureWinners = known.filter((c) => this.leadWinProbability(c, ctx) >= 0.85);
        if (sureWinners.length === known.length) {
          return { mode: 'win', urgent: true, need: remainingTricks };
        }
      }
      return { mode: 'avoid', urgent: false, need: 0 };
    }
    const bid = ctx.me.currentBid ?? 0;
    const needMore = bid - ctx.me.tricksTaken;
    if (needMore <= 0) {
      return { mode: 'avoid', urgent: false, need: 0 };
    }
    return { mode: 'win', urgent: needMore >= this.knownCards(ctx).length, need: needMore };
  }

  private selectForWin(candidates: Candidate[], urgent: boolean, need: number, ctx: DecisionContext): Candidate {
    // Check Zero Defense: if opponent is threatening to hit 0, bias trick preference
    if (shouldDefendSecondFromZero(ctx)) {
      const threats = detectOpponentZeroThreats(ctx);
      if (threats.length > 0) {
        const feedValue = trickPreferenceVsThreat(threats[0], true);
        const stealValue = trickPreferenceVsThreat(threats[0], false);
        if (stealValue > feedValue) {
          urgent = true;
        } else if (feedValue > stealValue) {
          return this.selectForAvoid(candidates, ctx);
        }
      }
    }

    if (urgent) {
      return this.best(candidates, (a, b) => b.winProb - a.winProb || a.cost - b.cost);
    }
    const winners = candidates.filter((candidate) => candidate.winProb >= WIN_THRESHOLD);
    if (winners.length >= need && winners.length > 0) {
      return this.best(winners, (a, b) => a.cost - b.cost || b.winProb - a.winProb);
    }
    const contenders = candidates.filter((candidate) => candidate.winProb > 0);
    if (contenders.length > 0) {
      return this.best(contenders, (a, b) => b.winProb - a.winProb || a.cost - b.cost);
    }
    return this.best(candidates, (a, b) => a.cost - b.cost || a.winProb - b.winProb);
  }

  private selectForAvoid(candidates: Candidate[], ctx: DecisionContext): Candidate {
    // Check Zero Defense when avoiding
    if (shouldDefendSecondFromZero(ctx)) {
      const threats = detectOpponentZeroThreats(ctx);
      if (threats.length > 0) {
        const feedValue = trickPreferenceVsThreat(threats[0], true);
        const stealValue = trickPreferenceVsThreat(threats[0], false);
        if (stealValue > feedValue) {
          return this.best(candidates, (a, b) => b.winProb - a.winProb || a.cost - b.cost);
        }
      }
    }

    const losers = candidates.filter((candidate) => candidate.winProb < WIN_THRESHOLD);
    if (losers.length > 0) {
      return this.best(losers, (a, b) =>
        this.jokerRank(a) - this.jokerRank(b)
        || b.cost - a.cost
        || a.winProb - b.winProb);
    }
    return this.best(candidates, (a, b) => a.winProb - b.winProb || b.cost - a.cost);
  }

  private jokerRank(candidate: Candidate): number {
    return candidate.jokerAction ? 1 : 0;
  }

  private best(candidates: Candidate[], compare: (a: Candidate, b: Candidate) => number): Candidate {
    let winner = candidates[0];
    for (let index = 1; index < candidates.length; index += 1) {
      if (compare(candidates[index], winner) < 0) {
        winner = candidates[index];
      }
    }
    return winner;
  }

  private cardCost(card: CardModel, jokerAction: JokerAction | undefined, trump: Suit | null): number {
    if (isJokerCard(card)) {
      return jokerAction?.type === 'DROP' ? JOKER_DROP_COST : JOKER_WIN_COST;
    }
    if (trump !== null && card.suit === trump) {
      return TRUMP_COST_BASE + rankValue(card.rank);
    }
    return rankValue(card.rank);
  }

  // === Probabilistic Win Estimation ========================================

  private leadWinProbability(card: CardModel, ctx: DecisionContext): number {
    const jokerAction: JokerAction | undefined = isJokerCard(card) ? { type: 'TAKE' } : undefined;
    return this.winProbability(card, jokerAction, ctx);
  }

  private winProbability(
    candidate: CardModel,
    jokerAction: JokerAction | undefined,
    ctx: DecisionContext,
  ): number {
    const trump = ctx.state.trumpSuit;
    const plays: TrickCard[] = ctx.state.tableCards.map((played) => ({
      card: played.card,
      jokerAction: played.jokerAction,
    }));
    plays.push({ card: candidate, jokerAction });

    const winnerIndex = resolveWinnerIndex(plays, trump);
    if (winnerIndex !== plays.length - 1) {
      return 0;
    }
    if (isJokerCard(candidate)) {
      return jokerAction?.type === 'DROP' ? 0 : 1;
    }

    const playersAfter = ctx.state.maxPlayers - plays.length;
    if (playersAfter <= 0) {
      return 1;
    }

    const seen = new Set(this.seen);
    for (const played of ctx.state.tableCards) {
      seen.add(cardKey(played.card));
    }
    seen.add(cardKey(candidate));

    const live = this.liveFraction(ctx, seen, playersAfter);
    const jokerUnseen = seen.has(JOKER_KEY) ? 0 : 1;
    const candidateIsTrump = trump !== null && candidate.suit === trump;

    let probability: number;
    if (candidateIsTrump) {
      const higherTrumps = this.countUnseenHigher(trump, candidate, seen);
      probability = Math.pow(1 - live, higherTrumps);
    } else {
      const higherSameSuit = this.countUnseenHigher(candidate.suit, candidate, seen);
      const trumpsTotal = trump !== null ? this.countUnseenSuit(trump, seen) : 0;
      const handSize = Math.max(1, ctx.state.currentRoundCards);
      const progress = 1 - this.knownCards(ctx).length / handSize;
      const voidFactor = Math.min(0.85, BASE_VOID_FACTOR + progress * 0.35);
      probability =
        Math.pow(1 - live, higherSameSuit)
        * Math.pow(1 - live * voidFactor, trumpsTotal);
    }

    if (jokerUnseen === 1) {
      probability *= 1 - live * JOKER_THREAT;
    }

    return Math.max(0, Math.min(1, probability));
  }

  private liveFraction(ctx: DecisionContext, seen: Set<string>, playersAfter: number): number {
    const unseen = Math.max(1, 36 - seen.size);
    const liveOpponentCards = this.cardsHeldByNextPlayers(ctx, playersAfter);
    return Math.min(1, Math.max(0, liveOpponentCards / unseen));
  }

  private cardsHeldByNextPlayers(ctx: DecisionContext, playersAfter: number): number {
    const total = ctx.state.players.length;
    let held = 0;
    for (let step = 1; step <= playersAfter; step += 1) {
      const index = (ctx.state.currentPlayerIndex + step) % total;
      if (index === ctx.myIndex) {
        continue;
      }
      held += ctx.state.players[index]?.cards.length ?? 0;
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
}
