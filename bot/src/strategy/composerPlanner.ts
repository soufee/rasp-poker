import type { DecisionContext } from '../core/stateSelectors';
import type { CardModel, Rank, RoundType, Suit } from '../protocol/types';
import {
  cardKey,
  FULL_DECK,
  isJokerCard,
  JOKER_KEY,
  rankValue,
  RANK_ORDER,
  SUITS,
} from './cards';

export type RiskPosture = 'catch_up' | 'balanced' | 'protect';

export interface SuitEstablishment {
  suit: Suit;
  myLength: number;
  hasAce: boolean;
  hasJoker: boolean;
  /** Ranks opponents may still hold in this suit (unseen, not in our hand). */
  missingRanks: Rank[];
  /** Honors among missing that can still beat our lower winners. */
  threats: Rank[];
  /** Tricks we expect after pulling the top threat (usually K) via Ace or joker demand. */
  runnersAfterPull: number;
  leadAceIndex: number | null;
  establishmentValue: number;
}

export function tournamentPosture(ctx: DecisionContext): RiskPosture {
  const my = ctx.me.score;
  const others = ctx.state.players
    .filter((player) => player.id !== ctx.myId)
    .map((player) => player.score);
  if (others.length === 0) {
    return 'balanced';
  }
  const best = Math.max(...others);
  const gapBehind = best - my;
  if (gapBehind >= 25) {
    return 'catch_up';
  }
  if (my >= best + 20) {
    return 'protect';
  }
  return 'balanced';
}

export function riskAversion(posture: RiskPosture): number {
  if (posture === 'catch_up') {
    return 0.22;
  }
  if (posture === 'protect') {
    return 0.68;
  }
  return 0.45;
}

export function bidAggression(posture: RiskPosture): number {
  if (posture === 'catch_up') {
    return 0.75;
  }
  if (posture === 'protect') {
    return -0.55;
  }
  return 0;
}

/** Cards actually dealt this round (partial deck in PERCENTS etc.). */
export function cardsDealtInRound(ctx: DecisionContext): number {
  return ctx.state.currentRoundCards * ctx.state.maxPlayers;
}

export function darkBidTarget(ctx: DecisionContext): number {
  const handSize = ctx.state.currentRoundCards;
  const players = ctx.state.maxPlayers;
  const posture = tournamentPosture(ctx);
  const bump = bidAggression(posture);

  let target: number;
  if (players === 3) {
    if (handSize <= 4) {
      // In 3p short dark deals, taking most tricks is realistic.
      target = handSize - 0.4;
    } else if (handSize <= 6) {
      target = 2.8;
    } else {
      target = 2.4 + Math.min(1.2, (handSize - 6) * 0.12);
    }
  } else if (players === 4) {
    target = handSize / players + 1.1;
  } else {
    target = handSize / players + 0.8;
  }

  return Math.max(1, target + bump);
}

export function longHandBidTarget(
  ctx: DecisionContext,
  estimate: number,
): number {
  const handSize = ctx.state.currentRoundCards;
  const posture = tournamentPosture(ctx);
  const bump = bidAggression(posture);

  if (handSize >= 8) {
    const raw = Math.min(4, Math.max(2, estimate * 0.42 + bump));
    return raw;
  }
  if (handSize >= 6) {
    return Math.min(handSize - 1, Math.max(1, estimate * 0.5 + bump));
  }
  return estimate + bump;
}

export function pickNearestBid(
  allowed: number[],
  target: number,
  options: { avoidZero?: boolean } = {},
): number {
  let pool = options.avoidZero ? allowed.filter((bid) => bid > 0) : allowed;
  if (pool.length === 0) {
    pool = allowed;
  }

  let best = pool[0];
  let bestDist = Math.abs(best - target);
  for (const bid of pool) {
    const dist = Math.abs(bid - target);
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && bid > best)) {
      best = bid;
      bestDist = dist;
    }
  }
  return best;
}

export function analyzeSuitEstablishment(
  hand: CardModel[],
  indexByKey: Map<string, number>,
  suit: Suit,
  seen: Set<string>,
  jokerSeen: boolean,
): SuitEstablishment | null {
  const inSuit = hand.filter((card) => !isJokerCard(card) && card.suit === suit);
  if (inSuit.length < 3) {
    return null;
  }

  const hasJoker = hand.some(isJokerCard);
  const ace = inSuit.find((card) => card.rank === 'A');
  const myRanks = new Set(inSuit.map((card) => card.rank));

  const missingRanks: Rank[] = [];
  for (const rank of RANK_ORDER) {
    const key = `${rank}:${suit}`;
    if (!myRanks.has(rank) && !seen.has(key)) {
      missingRanks.push(rank);
    }
  }

  const threats = missingRanks.filter((rank) => rankValue(rank) >= rankValue('10'));
  const kingStillOut = missingRanks.includes('K');
  const aceStillOut = missingRanks.includes('A') && !ace;

  let runnersAfterPull = 0;
  if (ace) {
    const threatsAfterKing = threats.filter((rank) => rank !== 'K');
    for (const card of inSuit) {
      if (card.rank === 'A') {
        continue;
      }
      const beatsField = threatsAfterKing.every((rank) => rankValue(card.rank) > rankValue(rank));
      if (beatsField) {
        runnersAfterPull += 1;
      }
    }
    if (hasJoker && kingStillOut) {
      runnersAfterPull = Math.max(runnersAfterPull, inSuit.length - 1);
    }
  } else if (hasJoker && inSuit.length >= 4) {
    runnersAfterPull = inSuit.filter((card) => rankValue(card.rank) >= rankValue('J')).length;
  }

  let establishmentValue = 0;
  if (ace && inSuit.length >= 4) {
    establishmentValue =
      runnersAfterPull * 4
      + (hasJoker && kingStillOut ? 6 : 2)
      - threats.length * 1.5
      - (aceStillOut ? 2 : 0);
  } else if (hasJoker && inSuit.length >= 3 && inSuit.some((c) => rankValue(c.rank) >= rankValue('Q'))) {
    establishmentValue = inSuit.length * 2 + (kingStillOut ? 3 : 0);
  }

  const leadAceIndex = ace ? (indexByKey.get(cardKey(ace)) ?? null) : null;

  return {
    suit,
    myLength: inSuit.length,
    hasAce: Boolean(ace),
    hasJoker,
    missingRanks,
    threats,
    runnersAfterPull,
    leadAceIndex,
    establishmentValue,
  };
}

export function bestSuitEstablishment(
  hand: CardModel[],
  indexByKey: Map<string, number>,
  seen: Set<string>,
  jokerSeen: boolean,
): SuitEstablishment | null {
  let best: SuitEstablishment | null = null;
  for (const suit of SUITS) {
    const plan = analyzeSuitEstablishment(hand, indexByKey, suit, seen, jokerSeen);
    if (plan && (!best || plan.establishmentValue > best.establishmentValue)) {
      best = plan;
    }
  }
  return best;
}

/** P(win trick) with partial-deck uncertainty (PERCENTS / short deals). */
export function uncertaintyWinChance(
  card: CardModel,
  ctx: DecisionContext,
  seen: Set<string>,
  forBidding: boolean,
): number {
  if (isJokerCard(card)) {
    if (!forBidding) {
      return 1;
    }
    return seen.has(JOKER_KEY) ? 0.15 : 0.9;
  }

  const trump = ctx.state.trumpSuit;
  const inPlay = cardsDealtInRound(ctx);
  const unseenInPlay = Math.max(1, inPlay - seen.size);
  const players = ctx.state.maxPlayers;
  const roundType = ctx.state.currentRoundType;

  const beaters = countBeaters(card, trump, seen);
  const jokerOut = seen.has(JOKER_KEY);

  let perCardBuster = beaters / unseenInPlay;
  if (roundType === 'PERCENTS') {
    perCardBuster *= 1.15;
  }
  if (!jokerOut) {
    perCardBuster += 0.04;
  }

  const hand = handCards(ctx);
  const suitLen = hand.filter((c) => !isJokerCard(c) && c.suit === card.suit).length;
  const isTrump = trump !== null && card.suit === trump;
  const rv = rankValue(card.rank);

  let base: number;
  if (isTrump) {
    base = 0.2 + rv * 0.065 + suitLen * 0.035;
  } else if (card.rank === 'A') {
    base = 0.38 + suitLen * 0.05;
  } else if (card.rank === 'K' && suitLen >= 2) {
    base = 0.28;
  } else if (rv >= rankValue('Q')) {
    base = 0.12 + suitLen * 0.03;
  } else {
    base = 0.03 + suitLen * 0.02;
  }

  const opponentsFactor = Math.pow(1 - Math.min(0.92, perCardBuster), Math.max(1, players - 1));
  return Math.max(0.02, Math.min(0.97, base * 0.55 + opponentsFactor * 0.45));
}

function countBeaters(card: CardModel, trump: Suit | null, seen: Set<string>): number {
  let count = 0;
  const candidateTrump = trump !== null && card.suit === trump;

  for (const deckCard of FULL_DECK) {
    if (deckCard.isJoker) {
      if (!seen.has(deckCard.key)) {
        count += 1;
      }
      continue;
    }
    if (seen.has(deckCard.key)) {
      continue;
    }

    if (candidateTrump) {
      if (deckCard.suit === trump && rankValue(deckCard.rank) > rankValue(card.rank)) {
        count += 1;
      }
      continue;
    }

    if (deckCard.suit === card.suit && rankValue(deckCard.rank) > rankValue(card.rank)) {
      count += 1;
      continue;
    }
    if (trump !== null && deckCard.suit === trump) {
      count += 1;
    }
  }
  return count;
}

function handCards(ctx: DecisionContext): CardModel[] {
  const out: CardModel[] = [];
  for (const card of ctx.me.cards) {
    if (card) {
      out.push(card);
    }
  }
  return out;
}

export function shouldDemandSuit(
  plan: SuitEstablishment,
  seen: Set<string>,
): boolean {
  const acePlayed = seen.has(`${'A'}:${plan.suit}`);
  const kingPlayed = seen.has(`${'K'}:${plan.suit}`);
  return plan.hasJoker
    && plan.establishmentValue >= 6
    && (acePlayed || plan.hasAce)
    && !kingPlayed
    && plan.threats.includes('K');
}

export function roundUncertaintyFactor(roundType: RoundType, ctx: DecisionContext): number {
  if (roundType === 'PERCENTS') {
    return 1.25;
  }
  if (ctx.state.currentRoundCards <= 4) {
    return 1.1;
  }
  return 1;
}