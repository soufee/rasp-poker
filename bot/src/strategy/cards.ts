import type { CardModel, JokerAction, Rank, Suit } from '../protocol/types';

export const RANK_ORDER: Rank[] = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS: Suit[] = ['SPADES', 'HEARTS', 'DIAMONDS', 'CLUBS'];
export const JOKER_KEY = '7:SPADES';

export interface DeckCard extends CardModel {
  key: string;
}

export interface TrickCard {
  card: CardModel;
  jokerAction?: JokerAction;
}

export function rankValue(rank: Rank): number {
  return RANK_ORDER.indexOf(rank);
}

export function cardKey(card: CardModel): string {
  return `${card.rank}:${card.suit}`;
}

export function isJokerCard(card: CardModel | null | undefined): boolean {
  return Boolean(card && (card.isJoker || (card.suit === 'SPADES' && card.rank === '7')));
}

export const FULL_DECK: DeckCard[] = (() => {
  const deck: DeckCard[] = [];
  for (const suit of SUITS) {
    for (const rank of RANK_ORDER) {
      const isJoker = suit === 'SPADES' && rank === '7';
      const card: DeckCard = { suit, rank, isJoker, key: `${rank}:${suit}` };
      deck.push(card);
    }
  }
  return deck;
})();

function effectiveCard(
  played: TrickCard,
  leadSuit: Suit | null,
): { suit: Suit | null; rankValue: number; isTakeJoker: boolean } {
  if (isJokerCard(played.card)) {
    if (played.jokerAction?.type === 'TAKE' || played.jokerAction?.type === 'DEMAND_SUIT') {
      return { suit: null, rankValue: 1000, isTakeJoker: true };
    }
    const suit = played.jokerAction?.suit ?? leadSuit ?? 'SPADES';
    return { suit, rankValue: -1, isTakeJoker: false };
  }
  return { suit: played.card.suit, rankValue: rankValue(played.card.rank), isTakeJoker: false };
}

export function resolveWinnerIndex(
  plays: TrickCard[],
  trumpSuit: Suit | null,
  leadSuit: Suit | null = null,
): number {
  if (plays.length === 0) {
    return -1;
  }

  const resolvedLead =
    leadSuit
    ?? (() => {
      const first = plays[0];
      if (isJokerCard(first.card)) {
        if (first.jokerAction?.type === 'DEMAND_SUIT') {
          return first.jokerAction.suit;
        }
        if (first.jokerAction?.type === 'DROP') {
          return first.jokerAction.suit ?? null;
        }
        return null;
      }
      return first.card.suit;
    })();

  let winner = 0;
  let winnerEff = effectiveCard(plays[0], resolvedLead);

  for (let index = 1; index < plays.length; index += 1) {
    const current = effectiveCard(plays[index], resolvedLead);
    if (current.isTakeJoker && !winnerEff.isTakeJoker) {
      winner = index;
      winnerEff = current;
      continue;
    }
    if (!current.isTakeJoker && winnerEff.isTakeJoker) {
      continue;
    }
    if (current.isTakeJoker && winnerEff.isTakeJoker) {
      continue;
    }

    const winnerTrump = trumpSuit !== null && winnerEff.suit === trumpSuit;
    const currentTrump = trumpSuit !== null && current.suit === trumpSuit;
    if (currentTrump && !winnerTrump) {
      winner = index;
      winnerEff = current;
      continue;
    }
    if (!currentTrump && winnerTrump) {
      continue;
    }
    if (currentTrump && winnerTrump) {
      if (current.rankValue > winnerEff.rankValue) {
        winner = index;
        winnerEff = current;
      }
      continue;
    }

    const winnerLead = winnerEff.suit === resolvedLead;
    const currentLead = current.suit === resolvedLead;
    if (currentLead && !winnerLead) {
      winner = index;
      winnerEff = current;
      continue;
    }
    if (!currentLead && winnerLead) {
      continue;
    }
    if (currentLead && winnerLead && current.rankValue > winnerEff.rankValue) {
      winner = index;
      winnerEff = current;
    }
  }

  return winner;
}

export function cardPower(card: CardModel, trumpSuit: Suit | null): number {
  if (isJokerCard(card)) {
    return 100;
  }
  const base = rankValue(card.rank);
  if (trumpSuit && card.suit === trumpSuit) {
    return 20 + base;
  }
  return base;
}