/**
 * Composer — suit-establishment & uncertainty-aware strategy.
 *
 * Bidding:
 *  - DARK: never 0 when avoidable; 2–3 avg (3p short deals → up to H−1)
 *  - Long hands (9): target 2–4 from strength + tournament posture
 *  - PERCENTS / partial deck: beaters only among cards actually in play
 *  - Risk: catch_up → aggressive, protect → conservative
 *
 * Play (NO_TRUMP):
 *  - Establish long suit: Ace → pull King → runners (Q,J,8…) / joker DEMAND_SUIT
 *  - Save joker for demand when regular cards can win cheaper
 */

import type { DecisionContext } from '../core/stateSelectors';
import { remainingTricks, tricksNeeded } from '../core/stateSelectors';
import type { CardModel, JokerAction, RoundType, Suit } from '../protocol/types';
import type { Strategy } from './Strategy';
import {
  cardKey,
  cardPower,
  isJokerCard,
  JOKER_KEY,
  rankValue,
  resolveWinnerIndex,
  SUITS,
  type TrickCard,
} from './cards';
import {
  bestSuitEstablishment,
  bidAggression,
  cardsDealtInRound,
  darkBidTarget,
  longHandBidTarget,
  pickNearestBid,
  riskAversion,
  roundUncertaintyFactor,
  shouldDemandSuit,
  tournamentPosture,
  uncertaintyWinChance,
  type SuitEstablishment,
} from './composerPlanner';
import { poissonBinomialPmf } from './probability';
import { scoreForRound } from './scoring';

const UNDERBID_WEIGHT = 8;
const LOOKAHEAD_WEIGHT = 0.4;

interface PlayCandidate {
  cardIndex: number;
  jokerAction?: JokerAction;
  winsTrick: boolean;
  cardCost: number;
  lookahead: number;
  establishment: number;
}

type Intent = 'take' | 'dump' | 'neutral';

export class ComposerStrategy implements Strategy {
  public readonly name = 'Composer';

  private roundKey = '';
  private readonly seenKeys = new Set<string>();
  private readonly suitPlayed = new Map<Suit, number>();
  private pendingJoker: JokerAction | undefined;
  private cachedPlan: SuitEstablishment | null = null;

  public chooseBid(ctx: DecisionContext): number {
    this.refreshRoundState(ctx);
    const allowed = ctx.state.allowedBids ?? [];
    if (allowed.length === 0) {
      return 0;
    }
    if (allowed.length === 1) {
      return allowed[0];
    }

    const hand = this.knownHand(ctx.me.cards);
    const isDark = ctx.state.isDarkRound || ctx.state.currentRoundType === 'DARK';
    const blind = isDark || hand.length === 0;

    if (blind) {
      return this.bidDark(ctx, allowed);
    }

    const probs = hand.map((card) => uncertaintyWinChance(card, ctx, this.seenKeys, true));
    let estimate = this.suitCentricEstimate(hand, ctx.state.trumpSuit);
    const trump = ctx.state.trumpSuit;
    if (trump) {
      const trumpCards = hand.filter((c) => !isJokerCard(c) && c.suit === trump);
      const honors = trumpCards.filter((c) => rankValue(c.rank) >= rankValue('10')).length;
      if (honors >= 3) {
        estimate = Math.max(estimate, honors * 0.85);
      }
    }
    return this.riskAdjustedBid(allowed, probs, estimate, ctx);
  }

  public chooseCard(ctx: DecisionContext): number {
    this.refreshRoundState(ctx);
    this.pendingJoker = undefined;
    this.cachedPlan = bestSuitEstablishment(
      this.knownHand(ctx.me.cards),
      this.indexByKey(ctx.me.cards),
      this.seenKeys,
      this.seenKeys.has(JOKER_KEY),
    );

    const legal = ctx.state.legalPlays ?? [];
    const fallback = ctx.state.validCardIndices ?? [0];

    if (legal.length === 0) {
      const index = fallback[0] ?? 0;
      const card = ctx.me.cards[index];
      if (card && isJokerCard(card)) {
        this.pendingJoker = this.defaultJoker(ctx);
      }
      return index;
    }

    const intent = this.intent(ctx);
    const candidates = this.buildPlayCandidates(ctx, legal);
    const best = this.pickPlay(candidates, intent, ctx);
    this.pendingJoker = best.jokerAction;
    return best.cardIndex;
  }

  public chooseJokerAction(ctx: DecisionContext, _cardIndex: number): JokerAction {
    return this.pendingJoker ?? this.defaultJoker(ctx);
  }

  public chooseControlGame(ctx: DecisionContext): { roundType: RoundType; dealerIndex: number } {
    const played = ctx.state.playedRoundTypes ?? ['STANDARD'];
    const myScore = ctx.me.score;
    const bestOther = Math.max(
      ...ctx.state.players.map((p, i) => (i === ctx.myIndex ? -Infinity : p.score)),
    );

    const history = ctx.state.scoreHistory ?? [];
    const myPerf = new Map<RoundType, number>();
    for (const row of history) {
      const delta = row.scores[ctx.myId] ?? 0;
      myPerf.set(row.roundType, (myPerf.get(row.roundType) ?? 0) + delta);
    }

    let preferred: RoundType[];
    if (myScore < bestOther) {
      const ranked = [...played].sort(
        (a, b) => (myPerf.get(b) ?? 0) - (myPerf.get(a) ?? 0),
      );
      preferred = ranked.length > 0
        ? ranked
        : ['PERCENTS', 'GOLD', 'STANDARD', 'NO_TRUMP', 'DARK', 'MISER'];
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

    let dealerIndex = ctx.myIndex >= 0 ? ctx.myIndex : 0;
    if (myScore < bestOther) {
      let leader = -1;
      let leaderScore = -Infinity;
      ctx.state.players.forEach((player, index) => {
        if (index !== ctx.myIndex && player.score > leaderScore) {
          leaderScore = player.score;
          leader = index;
        }
      });
      if (leader >= 0) {
        dealerIndex = leader;
      }
    }

    return { roundType, dealerIndex };
  }

  public shouldStartGame(ctx: DecisionContext): boolean {
    const count = ctx.state.playersCount ?? ctx.state.players.length;
    return ctx.state.hostId === ctx.myId && count === ctx.state.maxPlayers;
  }

  // --- Bidding ---

  private bidDark(ctx: DecisionContext, allowed: number[]): number {
    const target = darkBidTarget(ctx);
    return pickNearestBid(allowed, target, { avoidZero: true });
  }

  private riskAdjustedBid(
    allowed: number[],
    probs: number[],
    estimate: number,
    ctx: DecisionContext,
  ): number {
    const pmf = poissonBinomialPmf(probs);
    const roundType = ctx.state.currentRoundType;
    const handSize = ctx.state.currentRoundCards;
    const posture = tournamentPosture(ctx);
    const aversion = riskAversion(posture);
    const uncertainty = roundUncertaintyFactor(roundType, ctx);

    let anchor = probs.reduce((sum, p) => sum + p, 0);
    if (handSize >= 8) {
      anchor = longHandBidTarget(ctx, estimate);
    } else {
      anchor += bidAggression(posture);
    }

    let bestBid = allowed[0];
    let bestUtility = Number.NEGATIVE_INFINITY;

    for (const bid of allowed) {
      let ev = 0;
      let underRisk = 0;
      for (let taken = 0; taken < pmf.length; taken += 1) {
        const p = pmf[taken];
        ev += p * scoreForRound(roundType, handSize, bid, taken);
        if (taken < bid) {
          underRisk += p;
        }
      }
      const proximity = -Math.abs(bid - anchor) * 1.5 * uncertainty;
      const utility =
        ev
        - aversion * underRisk * UNDERBID_WEIGHT * Math.max(1, bid)
        + proximity
        + this.tableBidPressure(ctx) * (bid <= Math.round(anchor) ? 2 : -2);

      if (utility > bestUtility + 1e-9) {
        bestUtility = utility;
        bestBid = bid;
      }
    }

    if (handSize >= 8) {
      const inRange = allowed.filter((b) => b >= 2 && b <= 4);
      if (inRange.length > 0) {
        bestBid = pickNearestBid(inRange, anchor, { avoidZero: true });
      }
    }

    return bestBid;
  }

  private tableBidPressure(ctx: DecisionContext): number {
    let others = 0;
    for (const player of ctx.state.players) {
      if (player.id !== ctx.myId && player.currentBid !== null) {
        others += player.currentBid;
      }
    }
    const cards = ctx.state.currentRoundCards;
    if (others >= cards - 1) {
      return -1;
    }
    if (others <= Math.floor(cards / ctx.state.maxPlayers)) {
      return 1;
    }
    return 0;
  }

  private suitCentricEstimate(hand: CardModel[], trump: Suit | null): number {
    let total = 0;
    const bySuit = new Map<Suit, CardModel[]>();
    for (const card of hand) {
      if (isJokerCard(card)) {
        total += 0.95;
        continue;
      }
      const list = bySuit.get(card.suit) ?? [];
      list.push(card);
      bySuit.set(card.suit, list);
    }

    for (const [suit, cards] of bySuit) {
      const isTrump = trump !== null && suit === trump;
      const honors = cards.filter((c) => rankValue(c.rank) >= rankValue('10')).length;
      const hasAce = cards.some((c) => c.rank === 'A');
      const len = cards.length;
      if (isTrump) {
        total += Math.min(len, honors + 1) * 0.58 + (hasAce ? 0.3 : 0);
      } else if (trump === null && len >= 4 && hasAce) {
        total += 1.2 + (len - 1) * 0.35;
      } else {
        total += (hasAce ? 0.48 : 0)
          + (cards.some((c) => c.rank === 'K') && len >= 2 ? 0.22 : 0)
          + Math.max(0, len - 3) * 0.07;
      }
    }
    return total;
  }

  // --- Play ---

  private buildPlayCandidates(
    ctx: DecisionContext,
    legal: NonNullable<DecisionContext['state']['legalPlays']>,
  ): PlayCandidate[] {
    const out: PlayCandidate[] = [];
    for (const play of legal) {
      const card = ctx.me.cards[play.cardIndex];
      if (!card) {
        continue;
      }
      if (isJokerCard(card) && play.jokerActions?.length) {
        for (const jokerAction of play.jokerActions) {
          out.push(this.evaluatePlay(ctx, play.cardIndex, card, jokerAction));
        }
      } else {
        out.push(this.evaluatePlay(ctx, play.cardIndex, card, undefined));
      }
    }
    return out;
  }

  private evaluatePlay(
    ctx: DecisionContext,
    cardIndex: number,
    card: CardModel,
    jokerAction: JokerAction | undefined,
  ): PlayCandidate {
    const winsTrick = this.winsTrickNow(card, jokerAction, ctx);
    const cardCost = isJokerCard(card)
      ? (jokerAction?.type === 'DROP' ? 8 : 95)
      : cardPower(card, ctx.state.trumpSuit);
    const lookahead = this.lookaheadValue(ctx, cardIndex, winsTrick);
    const establishment = this.establishmentBonus(ctx, cardIndex, card, jokerAction, winsTrick);
    return { cardIndex, jokerAction, winsTrick, cardCost, lookahead, establishment };
  }

  private establishmentBonus(
    ctx: DecisionContext,
    cardIndex: number,
    card: CardModel,
    jokerAction: JokerAction | undefined,
    winsTrick: boolean,
  ): number {
    const plan = this.cachedPlan;
    if (!plan || ctx.state.trumpSuit !== null) {
      return 0;
    }
    const leading = ctx.state.tableCards.length === 0;
    const intent = this.intent(ctx);
    if (intent === 'dump') {
      return 0;
    }

    let bonus = 0;
    if (leading && plan.leadAceIndex === cardIndex && plan.establishmentValue >= 6) {
      bonus += 140 + plan.runnersAfterPull * 12;
    }

    if (isJokerCard(card) && jokerAction?.type === 'DEMAND_SUIT' && jokerAction.suit === plan.suit) {
      if (shouldDemandSuit(plan, this.seenKeys)) {
        bonus += 120 + plan.runnersAfterPull * 10;
      } else {
        bonus -= 40;
      }
    }

    if (isJokerCard(card) && jokerAction?.type === 'TAKE') {
      const hasCheaperWinner = this.knownHand(ctx.me.cards).some((c) => {
        if (isJokerCard(c)) {
          return false;
        }
        return c.suit === plan.suit && rankValue(c.rank) >= rankValue('J');
      });
      if (hasCheaperWinner && leading) {
        bonus -= 80;
      }
    }

    if (!leading && winsTrick && card.suit === plan.suit && rankValue(card.rank) < rankValue('K')) {
      bonus += 15;
    }

    return bonus;
  }

  private pickPlay(candidates: PlayCandidate[], intent: Intent, ctx: DecisionContext): PlayCandidate {
    const urgent = tricksNeeded(ctx) >= remainingTricks(ctx);
    const isLast = ctx.state.tableCards.length === ctx.state.maxPlayers - 1;
    const leading = ctx.state.tableCards.length === 0;

    const scoreFn = (c: PlayCandidate): number => {
      let s = c.establishment;
      if (intent === 'take') {
        if (c.winsTrick) {
          s += 120 - c.cardCost + (urgent ? 90 : 0) + (isLast ? 25 : 0);
          if (leading) {
            s += c.cardCost * 0.5;
          }
        } else {
          s -= 70;
        }
        if (urgent && c.jokerAction?.type === 'TAKE') {
          s += 60;
        }
        if (c.jokerAction?.type === 'DEMAND_SUIT') {
          s += urgent ? 30 : 10;
        }
      } else if (intent === 'dump') {
        if (c.winsTrick) {
          s -= 160 + c.cardCost;
        } else {
          s += 85 - c.cardCost * 0.25 + (isLast ? c.cardCost * 0.45 : 0);
        }
      } else {
        s += c.winsTrick ? 25 - c.cardCost : 18 - c.cardCost * 0.1;
      }
      s += LOOKAHEAD_WEIGHT * c.lookahead;
      if (leading && !isJokerCard(ctx.me.cards[c.cardIndex]!)) {
        s += this.leadBonus(ctx, ctx.me.cards[c.cardIndex]!);
      }
      return s;
    };

    let best = candidates[0];
    let bestScore = scoreFn(best);
    for (let i = 1; i < candidates.length; i += 1) {
      const s = scoreFn(candidates[i]);
      if (s > bestScore) {
        best = candidates[i];
        bestScore = s;
      }
    }
    return best;
  }

  private leadBonus(ctx: DecisionContext, card: CardModel): number {
    const trump = ctx.state.trumpSuit;
    const hand = this.knownHand(ctx.me.cards);
    const suitLen = hand.filter((c) => !isJokerCard(c) && c.suit === card.suit).length;
    const intent = this.intent(ctx);
    if (intent === 'take' && trump && card.suit === trump) {
      return suitLen * 4;
    }
    if (intent === 'dump') {
      return suitLen <= 1 ? 15 : -suitLen * 2;
    }
    return (this.suitPlayed.get(card.suit) ?? 0) >= 2 ? 8 : 0;
  }

  private lookaheadValue(
    ctx: DecisionContext,
    removeIndex: number,
    winsThis: boolean,
  ): number {
    const hand = ctx.me.cards
      .map((c, i) => ({ c, i }))
      .filter((entry) => entry.c && entry.i !== removeIndex)
      .map((entry) => entry.c!);
    const need = tricksNeeded(ctx) - (winsThis ? 1 : 0);
    const left = hand.length;
    if (left === 0) {
      return need === 0 ? 12 : -12;
    }

    const plan = bestSuitEstablishment(hand, this.indexFromHand(hand), this.seenKeys, this.seenKeys.has(JOKER_KEY));
    const est = plan && ctx.state.trumpSuit === null
      ? plan.runnersAfterPull + (plan.hasAce ? 1 : 0) + (plan.hasJoker ? 0.8 : 0)
      : this.suitCentricEstimate(hand, ctx.state.trumpSuit);

    if (need <= 0) {
      return -est;
    }
    if (need >= left) {
      return est * 2.2;
    }
    return est - Math.abs(est - need) * 1.2;
  }

  private intent(ctx: DecisionContext): Intent {
    const type = ctx.state.currentRoundType;
    if (type === 'GOLD') {
      return 'take';
    }
    if (type === 'MISER') {
      return 'dump';
    }
    const need = tricksNeeded(ctx);
    if (need === 0) {
      return 'dump';
    }
    if (need >= remainingTricks(ctx)) {
      return 'take';
    }
    return 'neutral';
  }

  private winsTrickNow(
    card: CardModel,
    jokerAction: JokerAction | undefined,
    ctx: DecisionContext,
  ): boolean {
    const lead = ctx.state.currentTrickLeadSuit ?? null;
    const plays: TrickCard[] = ctx.state.tableCards.map((p) => ({
      card: p.card,
      jokerAction: p.jokerAction,
    }));
    plays.push({ card, jokerAction });
    return resolveWinnerIndex(plays, ctx.state.trumpSuit, lead) === plays.length - 1;
  }

  private defaultJoker(ctx: DecisionContext): JokerAction {
    const intent = this.intent(ctx);
    const lead = ctx.state.tableCards.length === 0;
    const plan = this.cachedPlan ?? bestSuitEstablishment(
      this.knownHand(ctx.me.cards),
      this.indexByKey(ctx.me.cards),
      this.seenKeys,
      this.seenKeys.has(JOKER_KEY),
    );

    if (!lead) {
      if (intent === 'dump') {
        return { type: 'DROP' };
      }
      const cheaper = this.cheaperWinnerExists(ctx);
      return cheaper ? { type: 'DROP' } : { type: 'TAKE' };
    }

    if (intent === 'dump') {
      return { type: 'DROP', suit: this.longestSideSuit(ctx) };
    }

    if (plan && ctx.state.trumpSuit === null && shouldDemandSuit(plan, this.seenKeys)) {
      return { type: 'DEMAND_SUIT', suit: plan.suit };
    }

    if (plan && ctx.state.trumpSuit === null && plan.leadAceIndex !== null && intent === 'take') {
      return { type: 'DROP', suit: plan.suit };
    }

    if (plan && plan.establishmentValue >= 5 && ctx.state.trumpSuit === null) {
      return { type: 'DEMAND_SUIT', suit: plan.suit };
    }

    return { type: 'TAKE' };
  }

  private cheaperWinnerExists(ctx: DecisionContext): boolean {
    const legal = ctx.state.legalPlays ?? [];
    for (const play of legal) {
      const card = ctx.me.cards[play.cardIndex];
      if (!card || isJokerCard(card)) {
        continue;
      }
      if (this.winsTrickNow(card, undefined, ctx)) {
        return true;
      }
    }
    return false;
  }

  private longestSideSuit(ctx: DecisionContext): Suit {
    const trump = ctx.state.trumpSuit;
    let best: Suit = 'HEARTS';
    let bestLen = -1;
    for (const suit of SUITS) {
      if (suit === trump) {
        continue;
      }
      const len = this.knownHand(ctx.me.cards).filter((c) => c.suit === suit).length;
      if (len > bestLen) {
        bestLen = len;
        best = suit;
      }
    }
    return best;
  }

  private knownHand(cards: Array<CardModel | null>): CardModel[] {
    const out: CardModel[] = [];
    for (const card of cards) {
      if (card) {
        out.push(card);
      }
    }
    return out;
  }

  private indexByKey(cards: Array<CardModel | null>): Map<string, number> {
    const map = new Map<string, number>();
    cards.forEach((card, index) => {
      if (card) {
        map.set(cardKey(card), index);
      }
    });
    return map;
  }

  private indexFromHand(hand: CardModel[]): Map<string, number> {
    const map = new Map<string, number>();
    hand.forEach((card, index) => {
      map.set(cardKey(card), index);
    });
    return map;
  }

  private refreshRoundState(ctx: DecisionContext): void {
    const key =
      `${ctx.state.currentRoundIndex}|${ctx.state.currentRoundType}|${ctx.state.currentRoundCards}`;
    if (key !== this.roundKey) {
      this.roundKey = key;
      this.seenKeys.clear();
      this.suitPlayed.clear();
      this.cachedPlan = null;
    }
    for (const played of ctx.state.tableCards) {
      this.seenKeys.add(cardKey(played.card));
      if (!isJokerCard(played.card)) {
        this.suitPlayed.set(
          played.card.suit,
          (this.suitPlayed.get(played.card.suit) ?? 0) + 1,
        );
      }
    }
    for (const card of this.knownHand(ctx.me.cards)) {
      this.seenKeys.add(cardKey(card));
    }
    void cardsDealtInRound(ctx);
  }

  /** @deprecated use refreshRoundState */
  public trackTable(ctx: DecisionContext): void {
    this.refreshRoundState(ctx);
  }
}