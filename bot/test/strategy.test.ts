import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GrokStrategy } from '../src/strategy/GrokStrategy';
import { RandomStrategy } from '../src/strategy/RandomStrategy';
import type { DecisionContext } from '../src/core/stateSelectors';
import type { GameStatePayload } from '../src/protocol/types';

function ctx(partial: Partial<GameStatePayload> & Pick<GameStatePayload, 'players'>): DecisionContext {
  const state: GameStatePayload = {
    state: 'BIDDING',
    maxPlayers: 3,
    dealerIndex: 0,
    currentPlayerIndex: 0,
    trumpSuit: 'SPADES',
    tableCards: [],
    currentRoundType: 'STANDARD',
    currentRoundCards: 6,
    isDarkRound: false,
    allowedBids: [0, 1, 2, 3, 4, 5, 6],
    validCardIndices: [0, 1, 2],
    players: partial.players,
    ...partial,
  };
  return {
    state,
    myId: state.players[0].id,
    myIndex: 0,
    me: state.players[0],
  };
}

describe('GrokStrategy', () => {
  const grok = new GrokStrategy();

  it('chooseBid only returns allowed values', () => {
    const c = ctx({
      players: [
        {
          id: 'grok',
          name: 'Grok',
          cards: [
            { suit: 'SPADES', rank: 'A' },
            { suit: 'SPADES', rank: 'K' },
            { suit: 'HEARTS', rank: 'A' },
            { suit: 'SPADES', rank: '7', isJoker: true },
            { suit: 'CLUBS', rank: '6' },
            { suit: 'DIAMONDS', rank: 'Q' },
          ],
          score: 0,
          currentBid: null,
          tricksTaken: 0,
        },
        {
          id: 'p2',
          name: 'P2',
          cards: [null, null, null, null, null, null],
          score: 0,
          currentBid: null,
          tricksTaken: 0,
        },
        {
          id: 'p3',
          name: 'P3',
          cards: [null, null, null, null, null, null],
          score: 0,
          currentBid: null,
          tricksTaken: 0,
        },
      ],
    });
    const bid = grok.chooseBid(c);
    assert.ok(c.state.allowedBids!.includes(bid), `bid ${bid} not in allowed`);
    assert.ok(bid >= 1, 'strong hand should bid at least 1');
  });

  it('chooseCard stays within validCardIndices', () => {
    const c = ctx({
      state: 'PLAYING_TRICKS',
      allowedBids: null,
      validCardIndices: [0, 2],
      currentRoundType: 'STANDARD',
      players: [
        {
          id: 'grok',
          name: 'Grok',
          cards: [
            { suit: 'HEARTS', rank: '6' },
            { suit: 'SPADES', rank: 'A' },
            { suit: 'HEARTS', rank: 'A' },
          ],
          score: 0,
          currentBid: 1,
          tricksTaken: 0,
        },
        {
          id: 'p2',
          name: 'P2',
          cards: [null, null],
          score: 0,
          currentBid: 1,
          tricksTaken: 0,
        },
        {
          id: 'p3',
          name: 'P3',
          cards: [null, null],
          score: 0,
          currentBid: 0,
          tricksTaken: 0,
        },
      ],
      tableCards: [
        {
          playerId: 'p2',
          card: { suit: 'HEARTS', rank: '10' },
        },
      ],
      currentTrickLeadSuit: 'HEARTS',
      currentPlayerIndex: 0,
    });
    const cardIndex = grok.chooseCard(c);
    assert.ok([0, 2].includes(cardIndex));
  });

  it('miser prefers DROP joker', () => {
    const c = ctx({
      state: 'PLAYING_TRICKS',
      currentRoundType: 'MISER',
      allowedBids: null,
      validCardIndices: [0],
      currentPlayerIndex: 0,
      tableCards: [{ playerId: 'p2', card: { suit: 'CLUBS', rank: '6' } }],
      currentTrickLeadSuit: 'CLUBS',
      players: [
        {
          id: 'grok',
          name: 'Grok',
          cards: [{ suit: 'SPADES', rank: '7', isJoker: true }],
          score: 0,
          currentBid: null,
          tricksTaken: 0,
        },
        {
          id: 'p2',
          name: 'P2',
          cards: [null],
          score: 0,
          currentBid: null,
          tricksTaken: 0,
        },
        {
          id: 'p3',
          name: 'P3',
          cards: [null],
          score: 0,
          currentBid: null,
          tricksTaken: 0,
        },
      ],
    });
    const action = grok.chooseJokerAction(c, 0);
    assert.equal(action.type, 'DROP');
  });

  it('RandomStrategy always legal', () => {
    const r = new RandomStrategy();
    const c = ctx({
      allowedBids: [0, 2, 4],
      validCardIndices: [1, 3],
      players: [
        {
          id: 'r',
          name: 'R',
          cards: [
            { suit: 'HEARTS', rank: '6' },
            { suit: 'HEARTS', rank: '7' },
            { suit: 'HEARTS', rank: '8' },
            { suit: 'HEARTS', rank: '9' },
          ],
          score: 0,
          currentBid: null,
          tricksTaken: 0,
        },
      ],
    });
    for (let i = 0; i < 20; i += 1) {
      assert.ok(c.state.allowedBids!.includes(r.chooseBid(c)));
      assert.ok(c.state.validCardIndices!.includes(r.chooseCard(c)));
    }
  });
});
