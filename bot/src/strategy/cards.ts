import type { CardView, JokerAction, Suit, Rank } from '../protocol/types';

export const SUITS: Suit[] = ['SPADES', 'HEARTS', 'DIAMONDS', 'CLUBS'];

export const RANKS: Rank[] = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const RANK_VALUE: Record<Rank, number> = {
  '6': 0,
  '7': 1,
  '8': 2,
  '9': 3,
  '10': 4,
  J: 5,
  Q: 6,
  K: 7,
  A: 8,
};

export interface DeckCard {
  suit: Suit;
  rank: Rank;
  isJoker: boolean;
  key: string;
}

/** The joker in this game is the seven of spades. */
export function isJokerCard(card: { suit: Suit; rank: Rank; isJoker?: boolean }): boolean {
  return (
    card.isJoker === true
    || (card.suit === 'SPADES' && card.rank === '7')
  );
}

export function rankValue(rank: Rank): number {
  return RANK_VALUE[rank];
}

export function cardKey(card: { suit: Suit; rank: Rank }): string {
  return `${card.rank}:${card.suit}`;
}

export const FULL_DECK: DeckCard[] = SUITS.flatMap((suit) =>
  RANKS.map((rank) => ({
    suit,
    rank,
    isJoker: suit === 'SPADES' && rank === '7',
    key: `${rank}:${suit}`,
  })),
);

interface TrickCard {
  card: CardView;
  jokerAction?: JokerAction;
}

function leadSuitOf(plays: TrickCard[]): Suit | null {
  const first = plays[0];
  if (!first) {
    return null;
  }
  if (isJokerCard(first.card)) {
    if (
      first.jokerAction?.type === 'DEMAND_SUIT'
      || first.jokerAction?.type === 'DROP'
    ) {
      return first.jokerAction.suit ?? null;
    }
    return null;
  }
  return first.card.suit;
}

/**
 * Port of the server's trick resolution (GameEngine.resolveTrick) so the bot can
 * evaluate exactly who wins a given sequence of played cards.
 * Returns the index of the winning play.
 */
export function resolveWinnerIndex(plays: TrickCard[], trumpSuit: Suit | null): number {
  const leadSuit = leadSuitOf(plays);
  let winningIndex = 0;
  let isJokerTaking = false;

  for (let index = 0; index < plays.length; index += 1) {
    const current = plays[index];
    const currentIsJoker = isJokerCard(current.card);
    if (currentIsJoker) {
      if (
        current.jokerAction?.type === 'TAKE'
        || current.jokerAction?.type === 'DEMAND_SUIT'
      ) {
        winningIndex = index;
        isJokerTaking = true;
      }
      continue;
    }
    if (isJokerTaking) {
      continue;
    }

    const winning = plays[winningIndex];
    if (isJokerCard(winning.card)) {
      if (
        current.card.suit === leadSuit
        || current.card.suit === trumpSuit
      ) {
        winningIndex = index;
      }
      continue;
    }

    const currentIsTrump = current.card.suit === trumpSuit;
    const winningIsTrump = winning.card.suit === trumpSuit;
    if (currentIsTrump && !winningIsTrump) {
      winningIndex = index;
    } else if (currentIsTrump && winningIsTrump) {
      if (rankValue(current.card.rank) > rankValue(winning.card.rank)) {
        winningIndex = index;
      }
    } else if (current.card.suit === leadSuit) {
      if (
        winning.card.suit !== leadSuit
        || rankValue(current.card.rank) > rankValue(winning.card.rank)
      ) {
        winningIndex = index;
      }
    }
  }

  return winningIndex;
}

export { leadSuitOf };
export type { TrickCard };
