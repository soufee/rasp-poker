import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeStrategy } from '../src/strategy/ClaudeStrategy';
import { buildContext } from '../src/core/stateSelectors';
import type {
  CardModel,
  GameStatePayload,
  JokerAction,
  PlayedCard,
  PlayerState,
  Rank,
  RoundType,
  Suit,
} from '../src/protocol/types';

const ME = 'me';

function card(suit: Suit, rank: Rank, isJoker = false): CardModel {
  return { suit, rank, isJoker };
}

interface Options {
  phase: GameStatePayload['state'];
  roundType?: RoundType;
  cards?: number;
  trumpSuit?: Suit | null;
  isDark?: boolean;
  allowedBids?: number[] | null;
  validCardIndices?: number[];
  legalPlays?: Array<{ cardIndex: number; jokerActions?: JokerAction[] }>;
  tableCards?: PlayedCard[];
  leadSuit?: Suit | null;
  myHand?: Array<CardModel | null>;
  myBid?: number | null;
  myTricks?: number;
}

function makeState(options: Options): GameStatePayload {
  const others: PlayerState[] = [1, 2].map((n) => ({
    id: `op${n}`,
    name: `Opp ${n}`,
    cards: [null, null, null],
    score: 0,
    currentBid: null,
    tricksTaken: 0,
  }));
  const me: PlayerState = {
    id: ME,
    name: 'Claude',
    cards: options.myHand ?? [],
    score: 0,
    currentBid: options.myBid ?? null,
    tricksTaken: options.myTricks ?? 0,
  };
  return {
    state: options.phase,
    stateVersion: 1,
    hostId: ME,
    maxPlayers: 3,
    settings: { playersCount: 3, hasLadder: true, hasMiser: false },
    playersCount: 3,
    dealerIndex: 2,
    currentPlayerIndex: 0,
    trumpSuit: options.trumpSuit ?? null,
    tableCards: options.tableCards ?? [],
    currentTrickLeadSuit: options.leadSuit ?? null,
    currentRoundCards: options.cards ?? 3,
    currentRoundType: options.roundType ?? 'STANDARD',
    isDarkRound: options.isDark ?? false,
    playedRoundTypes: ['STANDARD'],
    controlGamesPlayed: 0,
    controlGameChooserId: null,
    allowedBids: options.allowedBids ?? null,
    validCardIndices:
      options.validCardIndices ?? (options.legalPlays ?? []).map((play) => play.cardIndex),
    legalPlays: options.legalPlays,
    players: [me, ...others],
  };
}

function ctxFor(state: GameStatePayload) {
  const context = buildContext(state, ME);
  assert.ok(context);
  return context;
}

test('bid is always within allowedBids', () => {
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('HEARTS', 'A'), card('HEARTS', 'K'), card('HEARTS', 'Q')],
  });
  const strategy = new ClaudeStrategy();
  assert.ok([0, 1, 2, 3].includes(strategy.chooseBid(ctxFor(state))));
});

test('strong trump hand bids high', () => {
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('HEARTS', 'A'), card('HEARTS', 'K'), card('HEARTS', 'Q')],
  });
  const strategy = new ClaudeStrategy();
  assert.ok(strategy.chooseBid(ctxFor(state)) >= 2);
});

test('weak hand bids low', () => {
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('CLUBS', '6'), card('DIAMONDS', '7'), card('CLUBS', '8')],
  });
  const strategy = new ClaudeStrategy();
  assert.ok(strategy.chooseBid(ctxFor(state)) <= 1);
});

test('blind dark round bids the fair share', () => {
  const state = makeState({
    phase: 'BIDDING',
    roundType: 'DARK',
    isDark: true,
    allowedBids: [0, 1, 2, 3],
    myHand: [null, null, null],
  });
  const strategy = new ClaudeStrategy();
  assert.equal(strategy.chooseBid(ctxFor(state)), 1);
});

test('when needing tricks it leads a winner', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 1,
    myTricks: 0,
    myHand: [card('HEARTS', 'A'), card('CLUBS', '6')],
    validCardIndices: [0, 1],
  });
  const strategy = new ClaudeStrategy();
  assert.equal(strategy.chooseCard(ctxFor(state)), 0);
});

test('when the bid is met it ducks with a low card', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 0,
    myTricks: 0,
    myHand: [card('HEARTS', 'A'), card('CLUBS', '6')],
    validCardIndices: [0, 1],
  });
  const strategy = new ClaudeStrategy();
  assert.equal(strategy.chooseCard(ctxFor(state)), 1);
});

test('joker secures a needed trick with TAKE', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 2,
    myTricks: 0,
    myHand: [card('SPADES', '7', true), card('CLUBS', '6')],
    legalPlays: [
      {
        cardIndex: 0,
        jokerActions: [
          { type: 'TAKE' },
          { type: 'DEMAND_SUIT', suit: 'HEARTS' },
          { type: 'DROP', suit: 'HEARTS' },
        ],
      },
      { cardIndex: 1 },
    ],
  });
  const strategy = new ClaudeStrategy();
  const context = ctxFor(state);
  const index = strategy.chooseCard(context);
  assert.equal(index, 0);
  const action = strategy.chooseJokerAction(context, index);
  assert.ok(action.type === 'TAKE' || action.type === 'DEMAND_SUIT');
});

function widenOpponents(state: GameStatePayload, count: number): void {
  for (let index = 1; index < state.players.length; index += 1) {
    state.players[index].cards = new Array(count).fill(null);
  }
}

test('dark round never bids zero when a positive bid is allowed', () => {
  const state = makeState({
    phase: 'BIDDING',
    roundType: 'DARK',
    isDark: true,
    cards: 9,
    allowedBids: [0, 1, 2, 3, 4],
    myHand: new Array(9).fill(null),
  });
  widenOpponents(state, 9);
  const strategy = new ClaudeStrategy();
  assert.ok(strategy.chooseBid(ctxFor(state)) >= 1);
});

test('no-trump joker with a long suit bids at least as high as without it', () => {
  const commonTail = [card('SPADES', 'A'), card('SPADES', 'Q'), card('SPADES', 'J'), card('SPADES', '8'), card('HEARTS', '6')];
  const withJoker = makeState({
    phase: 'BIDDING',
    roundType: 'NO_TRUMP',
    trumpSuit: null,
    cards: 6,
    allowedBids: [0, 1, 2, 3, 4, 5, 6],
    myHand: [card('SPADES', '7', true), ...commonTail],
  });
  const withoutJoker = makeState({
    phase: 'BIDDING',
    roundType: 'NO_TRUMP',
    trumpSuit: null,
    cards: 6,
    allowedBids: [0, 1, 2, 3, 4, 5, 6],
    myHand: [card('SPADES', '9'), ...commonTail],
  });
  widenOpponents(withJoker, 6);
  widenOpponents(withoutJoker, 6);
  const joinBid = new ClaudeStrategy().chooseBid(ctxFor(withJoker));
  const plainBid = new ClaudeStrategy().chooseBid(ctxFor(withoutJoker));
  assert.ok(joinBid > plainBid);
  assert.ok(joinBid >= 2);
});

test('leading the joker in win mode demands a suit to pull high cards', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: null,
    roundType: 'NO_TRUMP',
    myBid: 2,
    myTricks: 0,
    myHand: [card('SPADES', '7', true), card('SPADES', 'A'), card('SPADES', 'Q'), card('HEARTS', '6')],
    legalPlays: [
      {
        cardIndex: 0,
        jokerActions: [
          { type: 'TAKE' },
          { type: 'DEMAND_SUIT', suit: 'SPADES' },
          { type: 'DEMAND_SUIT', suit: 'HEARTS' },
          { type: 'DROP', suit: 'SPADES' },
        ],
      },
      { cardIndex: 1 },
      { cardIndex: 2 },
      { cardIndex: 3 },
    ],
  });
  const strategy = new ClaudeStrategy();
  const context = ctxFor(state);
  const action = strategy.chooseJokerAction(context, 0);
  assert.equal(action.type, 'DEMAND_SUIT');
  if (action.type === 'DEMAND_SUIT') {
    assert.equal(action.suit, 'SPADES');
  }
});

test('chosen card is always legal', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'DIAMONDS',
    myBid: 1,
    myTricks: 0,
    leadSuit: 'CLUBS',
    tableCards: [{ playerId: 'op1', card: card('CLUBS', 'K') }],
    myHand: [card('CLUBS', '9'), card('CLUBS', 'A')],
    validCardIndices: [0, 1],
  });
  const strategy = new ClaudeStrategy();
  assert.ok([0, 1].includes(strategy.chooseCard(ctxFor(state))));
});
