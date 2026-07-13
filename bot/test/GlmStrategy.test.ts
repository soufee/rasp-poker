import test from 'node:test';
import assert from 'node:assert/strict';
import { GlmStrategy } from '../src/strategy/GlmStrategy';
import { buildContext } from '../src/core/stateSelectors';
import type { CardModel, GameStatePayload, Rank, RoundType, Suit } from '../src/protocol/types';

const ME = 'glm-bot';

function card(suit: Suit, rank: Rank, isJoker = false): CardModel {
  return { suit, rank, isJoker };
}

interface OppSpec {
  id?: string;
  score?: number;
  bid?: number | null;
  tricks?: number;
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
  myScore?: number;
  opponents?: OppSpec[];
  currentPlayerIndex?: number;
}

function makeState(options: StateOptions): GameStatePayload {
  const oppSpecs = options.opponents ?? [{}, {}];
  const others = oppSpecs.map((spec, index) => ({
    id: spec.id ?? `op${index + 1}`,
    name: `Opp ${index + 1}`,
    cards: [null, null, null] as Array<CardModel | null>,
    score: spec.score ?? 0,
    currentBid: spec.bid ?? null,
    tricksTaken: spec.tricks ?? 0,
    connected: true,
    isBot: true,
  }));
  const me = {
    id: ME,
    name: 'GLM',
    cards: options.myHand ?? [],
    score: options.myScore ?? 0,
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
    currentPlayerIndex: options.currentPlayerIndex ?? 0,
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
  const strategy = new GlmStrategy();
  const context = buildContext(state, ME);
  assert.ok(context);
  strategy.observe(context);
  return { strategy, context };
}

test('bid is always within allowedBids', () => {
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('HEARTS', 'A'), card('HEARTS', 'K'), card('HEARTS', 'Q')],
  });
  const { strategy, context } = decide(state);
  const bid = strategy.chooseBid(context);
  assert.ok([0, 1, 2, 3].includes(bid));
});

test('strong trump hand bids aggressively', () => {
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('HEARTS', 'A'), card('HEARTS', 'K'), card('HEARTS', 'Q')],
  });
  const { strategy, context } = decide(state);
  assert.ok(strategy.chooseBid(context) >= 2);
});

test('weak hand bids low', () => {
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('CLUBS', '6'), card('DIAMONDS', '7'), card('CLUBS', '8')],
  });
  const { strategy, context } = decide(state);
  assert.ok(strategy.chooseBid(context) <= 1);
});

test('blind dark round bids the fair share', () => {
  const state = makeState({
    phase: 'BIDDING',
    roundType: 'DARK',
    isDark: true,
    allowedBids: [0, 1, 2, 3],
    myHand: [null, null, null],
  });
  const { strategy, context } = decide(state);
  assert.equal(strategy.chooseBid(context), 1);
});

test('when needing tricks it leads a winner', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 1,
    myTricks: 0,
    myHand: [card('HEARTS', 'A'), card('CLUBS', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const { strategy, context } = decide(state);
  assert.equal(strategy.chooseCard(context), 0);
});

test('when bid is met it ducks with a low card', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 0,
    myTricks: 0,
    myHand: [card('HEARTS', 'A'), card('CLUBS', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const { strategy, context } = decide(state);
  assert.equal(strategy.chooseCard(context), 1);
});

test('joker is used to secure a needed trick', () => {
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
  const { strategy, context } = decide(state);
  const cardIndex = strategy.chooseCard(context);
  const jokerAction = strategy.chooseJokerAction(context, cardIndex);
  assert.equal(cardIndex, 0);
  assert.ok(jokerAction.type === 'TAKE' || jokerAction.type === 'DEMAND_SUIT');
});

test('chooses cheapest winner when playing last', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    leadSuit: 'SPADES',
    myBid: 1,
    myTricks: 0,
    tableCards: [
      { playerId: 'op1', card: card('SPADES', '8') },
      { playerId: 'op2', card: card('SPADES', '10') },
    ],
    myHand: [card('SPADES', 'J'), card('SPADES', 'A'), card('CLUBS', '7')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const { strategy, context } = decide(state);
  assert.equal(strategy.chooseCard(context), 0);
});

test('discards high loser when contract is met', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    leadSuit: 'SPADES',
    myBid: 1,
    myTricks: 1,
    tableCards: [
      { playerId: 'op1', card: card('SPADES', 'Q') },
      { playerId: 'op2', card: card('SPADES', '9') },
    ],
    myHand: [card('SPADES', '6'), card('SPADES', 'J'), card('SPADES', 'A')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }, { cardIndex: 2 }],
  });
  const { strategy, context } = decide(state);
  assert.equal(strategy.chooseCard(context), 1);
});

test('sits the table leader: steals make even at self-overtrick cost', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'DIAMONDS',
    leadSuit: 'SPADES',
    cards: 6,
    myBid: 1,
    myTricks: 1,
    myScore: 40,
    opponents: [
      { id: 'op1', score: 90, bid: 5, tricks: 4 },
      { id: 'op2', score: 30, bid: 1, tricks: 1 },
    ],
    currentPlayerIndex: 0,
    tableCards: [
      { playerId: 'op1', card: card('SPADES', 'Q') },
      { playerId: 'op2', card: card('SPADES', '9') },
    ],
    myHand: [card('SPADES', 'A'), card('CLUBS', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const { strategy, context } = decide(state);
  assert.equal(
    strategy.chooseCard(context),
    0,
    'must take the trick to sit the leader on a big contract',
  );
});

test('feeds overtrick to leader sitting on exact bid', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'DIAMONDS',
    leadSuit: 'SPADES',
    cards: 6,
    myBid: 1,
    myTricks: 1,
    myScore: 40,
    opponents: [
      { id: 'op1', score: 95, bid: 4, tricks: 4 },
      { id: 'op2', score: 25, bid: 0, tricks: 0 },
    ],
    currentPlayerIndex: 0,
    tableCards: [
      { playerId: 'op1', card: card('SPADES', '10') },
      { playerId: 'op2', card: card('SPADES', '8') },
    ],
    myHand: [card('SPADES', 'A'), card('SPADES', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const { strategy, context } = decide(state);
  assert.equal(
    strategy.chooseCard(context),
    1,
    'must duck and force the leader to overtrick',
  );
});

test('does not suicide when own contract still urgently needs the trick', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    leadSuit: 'SPADES',
    cards: 3,
    myBid: 2,
    myTricks: 1,
    myScore: 50,
    opponents: [
      { id: 'op1', score: 80, bid: 1, tricks: 0 },
      { id: 'op2', score: 20, bid: 0, tricks: 0 },
    ],
    tableCards: [
      { playerId: 'op1', card: card('SPADES', '9') },
      { playerId: 'op2', card: card('SPADES', '8') },
    ],
    myHand: [card('SPADES', 'A')],
    legalPlays: [{ cardIndex: 0 }],
  });
  const { strategy, context } = decide(state);
  assert.equal(strategy.chooseCard(context), 0);
});

test('control game choice returns a played round type and valid dealer', () => {
  const state = makeState({
    phase: 'CONTROL_GAME_SETUP',
    opponents: [
      { id: 'op1', score: 100 },
      { id: 'op2', score: 50 },
    ],
  });
  state.playedRoundTypes = ['STANDARD', 'NO_TRUMP', 'GOLD', 'DARK', 'PERCENTS'];
  state.controlGameChooserId = ME;
  const { strategy, context } = decide(state);
  const choice = strategy.chooseControlGame(context);
  assert.ok(state.playedRoundTypes!.includes(choice.roundType));
  assert.ok(choice.dealerIndex >= 0 && choice.dealerIndex < state.players.length);
});

test('predictive claim pressure reduces bid when opponents bid high', () => {
  // 6-card hand, 3 players. Expected tricks ≈ 3 (strong honours), but
  // opponents have already claimed 5 of the 6 tricks via their bids.
  // GLM should shade downward rather than bidding the raw EV.
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    cards: 6,
    allowedBids: [0, 1, 2, 3, 4, 5, 6],
    myHand: [
      card('HEARTS', 'A'),
      card('HEARTS', 'K'),
      card('HEARTS', 'Q'),
      card('SPADES', 'A'),
      card('CLUBS', 'K'),
      card('DIAMONDS', 'Q'),
    ],
    opponents: [
      { id: 'op1', score: 0, bid: 3, tricks: 0 },
      { id: 'op2', score: 0, bid: 2, tricks: 0 },
    ],
  });
  const { strategy, context } = decide(state);
  const bid = strategy.chooseBid(context);
  assert.ok(bid <= 3, `expected shaded bid ≤ 3, got ${bid}`);
});
