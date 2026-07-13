import type { CardModel, GameSnapshot, PlayerState, RoundType, Suit } from '../types/game';

export const suitSymbols: Record<Suit, string> = {
  CLUBS: '♣',
  DIAMONDS: '♦',
  HEARTS: '♥',
  SPADES: '♠',
};

export const suitNames: Record<Suit, string> = {
  CLUBS: 'Трефы',
  DIAMONDS: 'Бубны',
  HEARTS: 'Червы',
  SPADES: 'Пики',
};

export const roundNames: Record<RoundType, string> = {
  DARK: 'Тёмная',
  GOLD: 'Золотая',
  MISER: 'Мизер',
  NO_TRUMP: 'Бескозырка',
  PERCENTS: 'Проценты',
  STANDARD: 'Обычная',
};

export function isJoker(card: CardModel): boolean {
  return card.isJoker === true || (card.rank === '7' && card.suit === 'SPADES');
}

export function rotatePlayersForViewer(players: PlayerState[], viewerId: string): PlayerState[] {
  const viewerIndex = players.findIndex((player) => player.id === viewerId);

  if (viewerIndex <= 0) {
    return players;
  }

  return [...players.slice(viewerIndex), ...players.slice(0, viewerIndex)];
}

export function getSeatPosition(playersCount: 3 | 4 | 6, visualIndex: number): string {
  const positions: Record<3 | 4 | 6, string[]> = {
    3: ['bottom', 'upper-left', 'upper-right'],
    4: ['bottom', 'left', 'top', 'right'],
    6: ['bottom', 'lower-left', 'upper-left', 'top', 'upper-right', 'lower-right'],
  };

  return positions[playersCount][visualIndex] ?? 'top';
}

export function getExcludedDealerBid(game: GameSnapshot): number | null {
  if (game.currentPlayerIndex !== game.dealerIndex || !game.allowedBids) {
    return null;
  }

  const bidsTotal = game.players.reduce((total, player) => total + (player.currentBid ?? 0), 0);
  const excludedBid = game.currentRoundCards - bidsTotal;

  if (
    excludedBid < 0
    || excludedBid > game.currentRoundCards
    || game.allowedBids.includes(excludedBid)
  ) {
    return null;
  }

  return excludedBid;
}

export function getWinner(players: PlayerState[]): PlayerState | null {
  if (players.length === 0) {
    return null;
  }

  return players.reduce((leader, player) => (player.score > leader.score ? player : leader));
}

export function formatScore(score: number): string {
  return score > 0 ? `+${score}` : String(score);
}
