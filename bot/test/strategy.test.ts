import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityStrategy } from '../src/strategy/AntigravityStrategy';
import type { DecisionContext } from '../src/core/stateSelectors';
import type { GameStatePayload } from '../src/protocol/types';

const strategy = new AntigravityStrategy();

function createBaseState(viewerId: string): GameStatePayload {
  return {
    viewerId,
    hostId: viewerId,
    state: 'BIDDING',
    stateVersion: 1,
    maxPlayers: 3,
    dealerIndex: 0,
    currentPlayerIndex: 0,
    trumpSuit: 'HEARTS',
    tableCards: [],
    currentRoundCards: 3,
    currentRoundType: 'STANDARD',
    isDarkRound: false,
    plan: [],
    currentRoundIndex: 0,
    controlGamesPlayed: 0,
    controlGameChooserId: null,
    playedRoundTypes: ['STANDARD'],
    allowedBids: [0, 1, 2, 3],
    validCardIndices: [0, 1, 2],
    players: [
      {
        id: viewerId,
        name: 'Antigravity',
        cards: [],
        score: 0,
        currentBid: null,
        tricksTaken: 0,
      },
    ],
  };
}

test('should bid conservatively with strong cards', () => {
  const viewerId = 'bot-1';
  const state = createBaseState(viewerId);
  state.players[0].cards = [
    { suit: 'HEARTS', rank: 'A' },
    { suit: 'SPADES', rank: 'A' },
    { suit: 'CLUBS', rank: '6' },
  ];

  const me = state.players[0];
  const ctx: DecisionContext = { state, myId: viewerId, myIndex: 0, me };
  const bid = strategy.chooseBid(ctx);
  assert.equal(bid, 1);
});

test('should bid dynamically in Dark rounds based on standings', () => {
  const viewerId = 'bot-1';
  
  // 1. Leader stance -> bids 0 (safe)
  const stateLeader = createBaseState(viewerId);
  stateLeader.players = [
    { id: viewerId, name: 'Antigravity', cards: [null, null, null], score: 100, currentBid: null, tricksTaken: 0 },
    { id: 'op1', name: 'Opp 1', cards: [null, null, null], score: 0, currentBid: null, tricksTaken: 0 },
    { id: 'op2', name: 'Opp 2', cards: [null, null, null], score: 0, currentBid: null, tricksTaken: 0 }
  ];
  const ctxLeader: DecisionContext = { state: stateLeader, myId: viewerId, myIndex: 0, me: stateLeader.players[0] };
  assert.equal(strategy.chooseBid(ctxLeader), 0);

  // 2. Normal stance -> bids 1 (balanced)
  const stateNormal = createBaseState(viewerId);
  stateNormal.players = [
    { id: viewerId, name: 'Antigravity', cards: [null, null, null], score: 0, currentBid: null, tricksTaken: 0 },
    { id: 'op1', name: 'Opp 1', cards: [null, null, null], score: 0, currentBid: null, tricksTaken: 0 },
    { id: 'op2', name: 'Opp 2', cards: [null, null, null], score: 0, currentBid: null, tricksTaken: 0 }
  ];
  const ctxNormal: DecisionContext = { state: stateNormal, myId: viewerId, myIndex: 0, me: stateNormal.players[0] };
  assert.equal(strategy.chooseBid(ctxNormal), 1);

  // 3. Trailing stance -> bids 2 (aggressive risk)
  const stateBehind = createBaseState(viewerId);
  stateBehind.players = [
    { id: viewerId, name: 'Antigravity', cards: [null, null, null], score: 0, currentBid: null, tricksTaken: 0 },
    { id: 'op1', name: 'Opp 1', cards: [null, null, null], score: 100, currentBid: null, tricksTaken: 0 },
    { id: 'op2', name: 'Opp 2', cards: [null, null, null], score: 0, currentBid: null, tricksTaken: 0 }
  ];
  const ctxBehind: DecisionContext = { state: stateBehind, myId: viewerId, myIndex: 0, me: stateBehind.players[0] };
  assert.equal(strategy.chooseBid(ctxBehind), 2);
});

test('should bid aggressively with spade/joker length synergy in No-Trump', () => {
  const viewerId = 'bot-1';
  const state = createBaseState(viewerId);
  state.currentRoundType = 'NO_TRUMP';
  state.trumpSuit = null;
  state.currentRoundCards = 9;
  state.allowedBids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  state.players = [
    {
      id: viewerId,
      name: 'Antigravity',
      cards: [
        { suit: 'SPADES', rank: '7', isJoker: true },
        { suit: 'SPADES', rank: 'A' },
        { suit: 'SPADES', rank: 'Q' },
        { suit: 'SPADES', rank: 'J' },
        { suit: 'SPADES', rank: '8' },
        { suit: 'CLUBS', rank: '6' },
        { suit: 'CLUBS', rank: '7' },
        { suit: 'DIAMONDS', rank: '6' },
        { suit: 'HEARTS', rank: '6' },
      ],
      score: 0,
      currentBid: null,
      tricksTaken: 0,
    },
    { id: 'op1', name: 'Opp 1', cards: Array(9).fill(null), score: 0, currentBid: null, tricksTaken: 0 },
    { id: 'op2', name: 'Opp 2', cards: Array(9).fill(null), score: 0, currentBid: null, tricksTaken: 0 }
  ];

  const ctx: DecisionContext = { state, myId: viewerId, myIndex: 0, me: state.players[0] };
  const bid = strategy.chooseBid(ctx);
  assert.equal(bid, 4);
});

test('should choose lowest winning card when wanting to win and playing last', () => {
  const viewerId = 'bot-1';
  const state = createBaseState(viewerId);
  state.state = 'PLAYING_TRICKS';
  state.currentTrickLeadSuit = 'SPADES';
  state.tableCards = [
    { playerId: 'player-2', card: { suit: 'SPADES', rank: '8' } },
    { playerId: 'player-3', card: { suit: 'SPADES', rank: '10' } },
  ];
  state.players[0].currentBid = 1;
  state.players[0].tricksTaken = 0;
  state.players[0].cards = [
    { suit: 'SPADES', rank: 'J' },
    { suit: 'SPADES', rank: 'A' },
    { suit: 'CLUBS', rank: '7' },
  ];
  state.legalPlays = [{ cardIndex: 0 }, { cardIndex: 1 }];

  const me = state.players[0];
  const ctx: DecisionContext = { state, myId: viewerId, myIndex: 0, me };
  assert.equal(strategy.chooseCard(ctx), 0);
});

test('should choose highest losing card when wanting to lose and playing last', () => {
  const viewerId = 'bot-1';
  const state = createBaseState(viewerId);
  state.state = 'PLAYING_TRICKS';
  state.currentTrickLeadSuit = 'SPADES';
  state.tableCards = [
    { playerId: 'player-2', card: { suit: 'SPADES', rank: 'Q' } },
    { playerId: 'player-3', card: { suit: 'SPADES', rank: '9' } },
  ];
  state.players[0].currentBid = 1;
  state.players[0].tricksTaken = 1;
  state.players[0].cards = [
    { suit: 'SPADES', rank: '6' },
    { suit: 'SPADES', rank: 'J' },
    { suit: 'SPADES', rank: 'A' },
  ];
  state.legalPlays = [{ cardIndex: 0 }, { cardIndex: 1 }, { cardIndex: 2 }];

  const me = state.players[0];
  const ctx: DecisionContext = { state, myId: viewerId, myIndex: 0, me };
  assert.equal(strategy.chooseCard(ctx), 1);
});