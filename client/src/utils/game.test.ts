import type { GameSnapshot, PlayerState } from '../types/game';
import {
  getExcludedDealerBid,
  getSeatPosition,
  getWinner,
  isJoker,
  rotatePlayersForViewer,
} from './game';

const players: PlayerState[] = [
  {
    cards: [],
    currentBid: 1,
    id: 'one',
    name: 'Один',
    score: 12,
    tricksTaken: 1,
  },
  {
    cards: [],
    currentBid: 0,
    id: 'two',
    name: 'Два',
    score: 27,
    tricksTaken: 0,
  },
  {
    cards: [],
    currentBid: null,
    id: 'three',
    name: 'Три',
    score: -4,
    tricksTaken: 0,
  },
];

describe('game utilities', () => {
  test('recognizes the seven of spades as joker', () => {
    expect(isJoker({ rank: '7', suit: 'SPADES' })).toBe(true);
    expect(isJoker({ rank: '7', suit: 'CLUBS' })).toBe(false);
  });

  test('rotates viewer to the bottom seat', () => {
    expect(rotatePlayersForViewer(players, 'two').map((player) => player.id)).toEqual([
      'two',
      'three',
      'one',
    ]);
    expect(getSeatPosition(3, 0)).toBe('bottom');
    expect(getSeatPosition(6, 5)).toBe('lower-right');
  });

  test('finds excluded dealer bid', () => {
    const game: GameSnapshot = {
      allowedBids: [0, 1, 3],
      controlGameChooserId: null,
      controlGamesPlayed: 0,
      currentPlayerIndex: 2,
      currentRoundCards: 3,
      currentRoundIndex: 0,
      currentRoundType: 'STANDARD',
      dealerIndex: 2,
      isDarkRound: false,
      maxPlayers: 3,
      plan: [],
      players,
      state: 'BIDDING',
      tableCards: [],
      trumpSuit: 'HEARTS',
    };

    expect(getExcludedDealerBid(game)).toBe(2);
  });

  test('returns highest scoring player', () => {
    expect(getWinner(players)?.id).toBe('two');
    expect(getWinner([])).toBeNull();
  });
});
