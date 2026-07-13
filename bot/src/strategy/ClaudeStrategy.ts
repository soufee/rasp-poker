/**
 * Claude — a planning bot for «Расписной покер».
 *
 * Bidding uses a suit-by-suit "winners" model instead of naively summing single
 * cards. For each suit it simulates leading top-down while opponents follow, so a
 * long suit whose high cards are drawn out establishes its low cards as winners.
 * The joker adds a guaranteed trick and can "pull" one dangerous high card
 * (DEMAND highest), exactly like leading A then jokering out the King so Q/J/low
 * become good. Every threat is weighted by the chance it was actually dealt to an
 * opponent (a King is far safer in a 4-card «percents» deal than in a full deal),
 * and the final bid is shaded by the tournament standing (behind → more risk).
 *
 * Play decides win-mode vs avoid-mode from the contract, then picks the cheapest
 * reliable winner or the safest duck, spends the joker to secure a needed trick
 * (pulling with DEMAND when leading) and dumps it only to dodge an unwanted one.
 */
import type { DecisionContext } from '../core/stateSelectors';
import type { CardModel, JokerAction, RoundType, Suit } from '../protocol/types';
import type { Strategy } from './Strategy';
import {
  cardKey,
  FULL_DECK,
  isJokerCard,
  rankValue,
  resolveWinnerIndex,
  SUITS,
  type TrickCard,
} from './cards';
import { poissonBinomialPmf } from './probability';
import { scoreForRound } from './scoring';

const JOKER_KEY = '7:SPADES';
const WIN_THRESHOLD = 0.5;
const JOKER_WIN_COST = 100;
const JOKER_DROP_COST = 12;
const TRUMP_COST_BASE = 20;
const BASE_VOID_FACTOR = 0.35;
const JOKER_THREAT = 0.5;
const SIDE_RUFF_FACTOR = 0.82;
const DARK_MIN_BID = 1;
const RISK_MARGIN = 4;
const STANDING_THRESHOLD = 30;

/**
 * Per-card lead estimates are correlated (two honours in one suit rarely both
 * win), so we shade the raw distribution. The overcount grows with the table
 * size, hence a lower factor with more opponents.
 */
function bidDamping(playersCount: number): number {
  const value = 0.88 - 0.03 * (playersCount - 3);
  return Math.max(0.74, Math.min(0.9, value));
}

interface Candidate {
  cardIndex: number;
  jokerAction?: JokerAction;
  winProb: number;
  cost: number;
}

type PlayMode = 'win' | 'avoid';
type Standing = 'behind' | 'ahead' | 'normal';

export class ClaudeStrategy implements Strategy {
  public readonly name = 'Claude';

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
    const chosen =
      mode === 'win'
        ? this.selectForWin(candidates, urgent, need)
        : this.selectForAvoid(candidates);

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
    return this.fallbackJokerAction(ctx);
  }

  public chooseControlGame(ctx: DecisionContext): { roundType: RoundType; dealerIndex: number } {
    const played = ctx.state.playedRoundTypes ?? ['STANDARD'];
    const behind = this.standing(ctx) === 'behind';
    const preference: RoundType[] = behind
      ? ['GOLD', 'PERCENTS', 'DARK', 'NO_TRUMP', 'STANDARD', 'MISER']
      : ['STANDARD', 'NO_TRUMP', 'PERCENTS', 'DARK', 'GOLD', 'MISER'];
    const roundType =
      preference.find((type) => played.includes(type))
      ?? (played[0] as RoundType)
      ?? 'STANDARD';
    const dealerIndex = ctx.myIndex >= 0 ? ctx.myIndex : 0;
    return { roundType, dealerIndex };
  }

  public shouldStartGame(ctx: DecisionContext): boolean {
    return (
      ctx.state.hostId === ctx.myId
      && (ctx.state.playersCount ?? ctx.state.players.length) === ctx.state.maxPlayers
    );
  }

  private remember(ctx: DecisionContext): void {
    const known = this.knownCards(ctx);
    const key =
      `${ctx.state.currentRoundIndex ?? 0}|${ctx.state.controlGamesPlayed ?? 0}`
      + `|${ctx.state.currentRoundType}|${ctx.state.currentRoundCards}`
      + `|${ctx.state.dealerIndex}|${ctx.state.trumpSuit ?? '-'}`;
    // A fresh deal hands us more cards than we held at the end of the last round;
    // the round key alone is not unique when views omit the round index.
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

  // === Bidding =============================================================

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
    return this.pickNearestBid(pool, target);
  }

  /**
   * Distribution over the number of tricks we expect to take. We estimate every
   * card's chance of winning the trick it leads (threats weighted by the chance
   * they were actually dealt to an opponent — a King is far safer in a 4-card
   * «percents» deal than in a full deal), shade for suit correlation, then add a
   * bounded establishment bonus for a long no-trump suit backed by the joker.
   */
  private bidTrickPmf(ctx: DecisionContext): number[] {
    const known = this.knownCards(ctx);
    let damping = bidDamping(ctx.state.players.length);
    if (ctx.state.currentRoundType === 'NO_TRUMP') {
      // No trump to protect our honours: winners are overtaken more often.
      damping *= 0.9;
    }
    const probs = known.map((card) => this.leadWinProbability(card, ctx) * damping);

    const bonus = this.establishmentBonus(ctx);
    if (bonus > 0) {
      probs.push(Math.min(0.95, bonus));
    }
    return poissonBinomialPmf(probs);
  }

  /**
   * Extra winners a long suit backed by the joker can establish in a no-trump
   * round: lead the top card, joker-DEMAND out the one dangerous card, and the
   * remaining low cards become good. Returns a fractional bonus, deliberately
   * capped so it only nudges the bid.
   */
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
      const withoutPull = suitWinnersGreedy(myRanks, unseenHigher, 0);
      const withPull = suitWinnersGreedy(myRanks, unseenHigher, 1);
      best = Math.max(best, withPull - withoutPull);
    }
    return Math.min(1, best) * 0.6;
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
        || (Math.abs(score - bestScore) <= 1e-9
          && Math.abs(bid - expected) < Math.abs(bestBid - expected));
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
    if (standing === 'behind' && allowed.includes(bestBid + 1)) {
      if (evOf(bestBid + 1) >= evOf(bestBid) - RISK_MARGIN) {
        return bestBid + 1;
      }
    }
    if (standing === 'ahead' && allowed.includes(bestBid - 1)) {
      if (evOf(bestBid - 1) >= evOf(bestBid) - RISK_MARGIN) {
        return bestBid - 1;
      }
    }
    return bestBid;
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

  // === Play ================================================================

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

  /**
   * When leading with the joker in win mode, prefer DEMAND highest of the suit we
   * want to establish (pull the one dangerous card) rather than a plain TAKE.
   */
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

  private fallbackJokerAction(ctx: DecisionContext): JokerAction {
    const { mode } = this.evaluateMode(ctx);
    const leading = ctx.state.tableCards.length === 0;
    if (mode === 'avoid') {
      return leading ? { type: 'DROP', suit: this.pickDropSuit(ctx) } : { type: 'DROP' };
    }
    if (leading) {
      const demand = this.pickDemandSuit(ctx);
      if (demand) {
        return { type: 'DEMAND_SUIT', suit: demand };
      }
    }
    return { type: 'TAKE' };
  }

  private cacheJoker(ctx: DecisionContext, cardIndex: number): void {
    const card = ctx.me.cards[cardIndex];
    if (card && isJokerCard(card)) {
      this.cached = {
        version: ctx.state.stateVersion ?? 0,
        cardIndex,
        jokerAction: this.fallbackJokerAction(ctx),
      };
    }
  }

  /** Suit we want to strip from opponents: our longest suit that still has a gap at the top. */
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

  private selectForWin(candidates: Candidate[], urgent: boolean, need: number): Candidate {
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

  private selectForAvoid(candidates: Candidate[]): Candidate {
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

  private evaluateMode(ctx: DecisionContext): { mode: PlayMode; urgent: boolean; need: number } {
    const roundType = ctx.state.currentRoundType;
    if (roundType === 'GOLD') {
      return { mode: 'win', urgent: false, need: 1 };
    }
    if (roundType === 'MISER') {
      return { mode: 'avoid', urgent: false, need: 0 };
    }
    const bid = ctx.me.currentBid ?? 0;
    const needMore = bid - ctx.me.tricksTaken;
    if (needMore <= 0) {
      return { mode: 'avoid', urgent: false, need: 0 };
    }
    return { mode: 'win', urgent: needMore >= ctx.me.cards.length, need: needMore };
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

  /** Probability that leading this card wins its trick (bidding uses an empty table). */
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
      const progress = 1 - ctx.me.cards.length / handSize;
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

  /** Chance that a given unseen card sits in a hand that still plays after us. */
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
}

/**
 * Count tricks won by leading a suit top-down while opponents must follow.
 * `pulls` removes that many of the opponents' highest cards first, modelling a
 * joker DEMAND that strips their top honour.
 */
function suitWinnersGreedy(myDesc: number[], unseenDesc: number[], pulls: number): number {
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
