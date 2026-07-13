import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/core/stateSelectors';
import {
  analyzeSuitEstablishment,
  darkBidTarget,
  pickNearestBid,
  shouldDemandSuit,
} from '../src/strategy/composerPlanner';
import type { CardModel, GameStatePayload, Suit } from '../src/protocol/types';
import { cardKey } from '../src/strategy/cards';

function card(suit: Suit, rank: CardModel['rank'], isJoker = false): CardModel {
  return { suit, rank, isJoker };
}

test('dark bid target is never below 1 in 3p', () => {
  const state: GameStatePayload = {
    state: 'BIDDING',
    maxPlayers: 3,
    dealerIndex: 0,
    currentPlayerIndex: 0,
    trumpSuit: null,
    tableCards: [],
    currentRoundCards: 4,
    currentRoundType: 'DARK',
    isDarkRound: true,
    allowedBids: [0, 1, 2, 3, 4],
    players: [
      { id: 'me', name: 'C', cards: [null, null, null, null], score: 0, currentBid: null, tricksTaken: 0 },
      { id: 'o1', name: '1', cards: [], score: 0, currentBid: null, tricksTaken: 0 },
      { id: 'o2', name: '2', cards: [], score: 0, currentBid: null, tricksTaken: 0 },
    ],
  };
  const ctx = buildContext(state, 'me');
  assert.ok(ctx);
  assert.ok(darkBidTarget(ctx) >= 2.5);
});

test('pickNearestBid avoids zero when asked', () => {
  assert.equal(pickNearestBid([0, 1, 2, 3], 2.6, { avoidZero: true }), 3);
  assert.equal(pickNearestBid([0, 1, 2, 3], 1.2, { avoidZero: true }), 1);
});

test('spade establishment sees runners after ace vs lone king threat', () => {
  const hand = [
    card('SPADES', '7', true),
    card('SPADES', 'A'),
    card('SPADES', 'Q'),
    card('SPADES', 'J'),
    card('SPADES', '8'),
  ];
  const indexByKey = new Map<string, number>();
  hand.forEach((c, i) => indexByKey.set(cardKey(c), i));
  const seen = new Set<string>();
  const plan = analyzeSuitEstablishment(hand, indexByKey, 'SPADES', seen, false);
  assert.ok(plan);
  assert.equal(plan!.myLength, 4);
  assert.ok(plan!.runnersAfterPull >= 3);
  assert.ok(plan!.establishmentValue >= 8);
  assert.equal(plan!.leadAceIndex, 1);
});

test('shouldDemandSuit after ace is out and king still missing', () => {
  const hand = [
    card('SPADES', '7', true),
    card('SPADES', 'Q'),
    card('SPADES', 'J'),
    card('SPADES', '8'),
  ];
  const indexByKey = new Map<string, number>();
  hand.forEach((c, i) => indexByKey.set(cardKey(c), i));
  const seen = new Set(['A:SPADES']);
  const plan = analyzeSuitEstablishment(hand, indexByKey, 'SPADES', seen, false);
  assert.ok(plan);
  assert.ok(shouldDemandSuit(plan!, seen));
});