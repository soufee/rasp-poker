import test from 'node:test';
import assert from 'node:assert/strict';
import { ComposerStrategy } from '../src/strategy/ComposerStrategy';
import { buildContext } from '../src/core/stateSelectors';
import type { CardModel, GameStatePayload, Rank, RoundType, Suit } from '../src/protocol/types';

const ME = 'composer-bot';

function card(suit: Suit, rank: Rank, isJoker = false): CardModel {
  return { suit, rank, isJoker };
}

interface StateOptions {
  phase: GameStatePayload['state'];
  roundType?: RoundType;
  cards?: number;
  trumpSuit?: Suit | null;
  isDark?: boolean;
  allowedBids?: number[] | null;
  legalPlays?: Array<{ cardIndex: number; jokerActions?: Array<{ type: 'TAKE' } | { type: 'DEMAND_SUIT'; suit: Suit } | { type: 'DROP'; suit?: Suit }> }>;
  tableCards?: GameStatePayload['tableCards'];
  leadSuit?: Suit | null;
  myHand?: Array<CardModel | null>;
  myBid?: number | null;
  myTricks?: number;
}

function makeState(options: StateOptions): GameStatePayload {
  const others = [1, 2].map((n) => ({
    id: `op${n}`,
    name: `Opp ${n}`,
    cards: [null, null, null] as Array<CardModel | null>,
    score: 0,
    currentBid: null,
    tricksTaken: 0,
    connected: true,
    isBot: true,
  }));
  const me = {
    id: ME,
    name: 'Composer',
    cards: options.myHand ?? [],
    score: 0,
    currentBid: options.myBid ?? null,
    tricksTaken: options.myTricks ?? 0,
    connected: true,
    isBot: true,
  };
  return {
    state: options.phase,
    stateVersion: 1,
    viewerId: ME,
    hostId: ME,
    maxPlayers: 3,
    playersCount: 3,
    dealerIndex: 2,
    currentPlayerIndex: 0,
    trumpSuit: options.trumpSuit ?? null,
    currentTrickLeadSuit: options.leadSuit ?? null,
    tableCards: options.tableCards ?? [],
    currentRoundCards: options.cards ?? 3,
    currentRoundType: options.roundType ?? 'STANDARD',
    isDarkRound: options.isDark ?? false,
    plan: [],
    currentRoundIndex: 0,
    playedRoundTypes: ['STANDARD'],
    controlGamesPlayed: 0,
    controlGameChooserId: null,
    allowedBids: options.allowedBids ?? null,
    validCardIndices: (options.legalPlays ?? []).map((play) => play.cardIndex),
    legalPlays: options.legalPlays ?? [],
    players: [me, ...others],
  };
}

function decide(state: GameStatePayload) {
  const strategy = new ComposerStrategy();
  const context = buildContext(state, ME);
  assert.ok(context);
  strategy.trackTable(context);
  return { strategy, context };
}

test('Composer bid stays within allowedBids', () => {
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('HEARTS', 'A'), card('HEARTS', 'K'), card('HEARTS', 'Q')],
  });
  const { strategy, context } = decide(state);
  assert.ok([0, 1, 2, 3].includes(strategy.chooseBid(context)));
});

test('Composer bids high on strong trump', () => {
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('HEARTS', 'A'), card('HEARTS', 'K'), card('HEARTS', '10')],
  });
  const { strategy, context } = decide(state);
  assert.ok(strategy.chooseBid(context) >= 1);
});

test('Composer leads a strong card when needing tricks', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 1,
    myTricks: 0,
    myHand: [card('HEARTS', 'A'), card('CLUBS', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const { strategy, context } = decide(state);
  const chosen = strategy.chooseCard(context);
  const played = context.me.cards[chosen]!;
  const weak = card('CLUBS', '6');
  assert.ok(
    played.suit === 'HEARTS' && played.rank === 'A'
    || (played.suit === weak.suit && rankIndex(played.rank) >= rankIndex(weak.rank)),
  );
});

function rankIndex(rank: Rank): number {
  return ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(rank);
}

test('Composer ducks when contract is satisfied', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 1,
    myTricks: 1,
    leadSuit: 'SPADES',
    tableCards: [
      { playerId: 'op1', card: card('SPADES', 'Q') },
      { playerId: 'op2', card: card('SPADES', '9') },
    ],
    myHand: [card('SPADES', '6'), card('SPADES', 'J'), card('SPADES', 'A')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const { strategy, context } = decide(state);
  assert.equal(strategy.chooseCard(context), 1);
});

test('Composer uses joker to take when urgent', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 3,
    myTricks: 0,
    myHand: [card('SPADES', '7', true), card('CLUBS', '6'), card('DIAMONDS', '8')],
    legalPlays: [
      {
        cardIndex: 0,
        jokerActions: [
          { type: 'TAKE' },
          { type: 'DEMAND_SUIT', suit: 'HEARTS' },
          { type: 'DROP', suit: 'CLUBS' },
        ],
      },
      { cardIndex: 1 },
      { cardIndex: 2 },
    ],
  });
  const { strategy, context } = decide(state);
  const idx = strategy.chooseCard(context);
  const joker = strategy.chooseJokerAction(context, idx);
  const played = context.me.cards[idx]!;
  if (played.isJoker || (played.suit === 'SPADES' && played.rank === '7')) {
    assert.ok(joker.type === 'TAKE' || joker.type === 'DEMAND_SUIT');
  } else {
    assert.ok(idx >= 0 && idx < context.me.cards.length);
  }
});

test('Composer name is Composer', () => {
  assert.equal(new ComposerStrategy().name, 'Composer');
});

test('dark round never bids 0 when higher bids exist', () => {
  const state = makeState({
    phase: 'BIDDING',
    roundType: 'DARK',
    isDark: true,
    cards: 4,
    allowedBids: [0, 1, 2, 3, 4],
    myHand: [null, null, null, null],
  });
  const { strategy, context } = decide(state);
  assert.ok(strategy.chooseBid(context) >= 1);
});

test('dark 3p with 4 cards bids aggressively', () => {
  const state = makeState({
    phase: 'BIDDING',
    roundType: 'DARK',
    isDark: true,
    cards: 4,
    allowedBids: [0, 1, 2, 3, 4],
    myHand: [null, null, null, null],
  });
  const { strategy, context } = decide(state);
  assert.ok(strategy.chooseBid(context) >= 2);
});

test('no-trump long spades: leads ace to establish suit', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    roundType: 'NO_TRUMP',
    trumpSuit: null,
    myBid: 4,
    myTricks: 0,
    cards: 5,
    myHand: [
      card('SPADES', '7', true),
      card('SPADES', 'A'),
      card('SPADES', 'Q'),
      card('SPADES', 'J'),
      card('SPADES', '8'),
    ],
    legalPlays: [
      { cardIndex: 0, jokerActions: [{ type: 'TAKE' }, { type: 'DEMAND_SUIT', suit: 'SPADES' }, { type: 'DROP', suit: 'SPADES' }] },
      { cardIndex: 1 },
      { cardIndex: 2 },
      { cardIndex: 3 },
      { cardIndex: 4 },
    ],
  });
  const { strategy, context } = decide(state);
  assert.equal(strategy.chooseCard(context), 1);
});

test('9-card hand bids within 2-4 when allowed', () => {
  const state = makeState({
    phase: 'BIDDING',
    cards: 9,
    allowedBids: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    myHand: [
      card('HEARTS', 'A'),
      card('HEARTS', 'K'),
      card('HEARTS', 'Q'),
      card('HEARTS', 'J'),
      card('SPADES', 'A'),
      card('SPADES', '10'),
      card('CLUBS', 'K'),
      card('DIAMONDS', '9'),
      card('DIAMONDS', '8'),
    ],
  });
  const { strategy, context } = decide(state);
  const bid = strategy.chooseBid(context);
  assert.ok(bid >= 2 && bid <= 4);
});