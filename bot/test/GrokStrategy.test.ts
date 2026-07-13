import test from 'node:test';
import assert from 'node:assert/strict';
import { GrokStrategy } from '../src/strategy/GrokStrategy';
import { buildContext } from '../src/core/stateSelectors';
import type { CardModel, GameStatePayload, Rank, RoundType, Suit } from '../src/protocol/types';

const ME = 'grok-bot';

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
  /** Opponents in seat order after me: [op1, op2]. */
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
    name: 'Grok',
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
  const strategy = new GrokStrategy();
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

test('sits the table leader: steals their make even at self-overtrick cost', () => {
  // Leader (op1) bid 5, has 4 — one short. They currently win the trick.
  // Our bid is already made; taking forces us to overtrick (+2 instead of +10),
  // but sitting the leader is −50 vs +50 for them — pure tournament value.
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
  // Leader already has taken === bid. Feeding one more destroys their 10×bid.
  // We already made our bid; we should duck instead of "stealing" uselessly.
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
  // We need this trick to avoid −10×bid catastrophe; even if leader wants it,
  // personal survival wins when need >= left.
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

test('control game returns a played type and valid dealer index', () => {
  const state = makeState({
    phase: 'CONTROL_GAME_SETUP',
    myScore: 20,
    opponents: [{ score: 80 }, { score: 40 }],
  });
  state.controlGameChooserId = ME;
  state.playedRoundTypes = ['STANDARD', 'GOLD', 'PERCENTS'];
  const { strategy, context } = decide(state);
  const choice = strategy.chooseControlGame(context);
  assert.ok(state.playedRoundTypes.includes(choice.roundType));
  assert.ok(choice.dealerIndex >= 0 && choice.dealerIndex < 3);
});

test('does not cash side-suit Ace into a known ruffer while trumps remain', () => {
  // op1 previously ruffed hearts → void in HEARTS, still may hold diamonds (trump).
  // Leading ♥A would be ruffed; bot should prefer a trump or a safe side card.
  const strategy = new GrokStrategy();
  const ruffSight = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'DIAMONDS',
    leadSuit: 'HEARTS',
    cards: 6,
    myBid: 2,
    myTricks: 0,
    currentPlayerIndex: 0,
    tableCards: [
      { playerId: 'op2', card: card('HEARTS', '6') },
      { playerId: 'op1', card: card('DIAMONDS', '8') }, // ruff
    ],
    myHand: [
      card('HEARTS', 'A'),
      card('DIAMONDS', 'A'),
      card('CLUBS', '9'),
      card('CLUBS', '7'),
      card('SPADES', '6'),
      card('SPADES', '8'),
    ],
    legalPlays: [{ cardIndex: 0 }],
    opponents: [
      { id: 'op1', bid: 1, tricks: 0 },
      { id: 'op2', bid: 1, tricks: 1 },
    ],
  });
  const ruffCtx = buildContext(ruffSight, ME);
  assert.ok(ruffCtx);
  strategy.observe(ruffCtx!);

  const leadState = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'DIAMONDS',
    cards: 6,
    myBid: 2,
    myTricks: 0,
    myHand: [
      card('HEARTS', 'A'),
      card('DIAMONDS', 'A'),
      card('CLUBS', '9'),
      card('CLUBS', '7'),
      card('SPADES', '6'),
      card('SPADES', '8'),
    ],
    legalPlays: [
      { cardIndex: 0 },
      { cardIndex: 1 },
      { cardIndex: 2 },
      { cardIndex: 3 },
      { cardIndex: 4 },
      { cardIndex: 5 },
    ],
    opponents: [
      { id: 'op1', bid: 1, tricks: 0 },
      { id: 'op2', bid: 1, tricks: 1 },
    ],
  });
  // Same round key so voids persist (same round index / type / cards).
  const leadCtx = buildContext(leadState, ME);
  assert.ok(leadCtx);
  strategy.observe(leadCtx!);
  const chosen = strategy.chooseCard(leadCtx!);
  assert.notEqual(chosen, 0, 'must not lead ♥A into known ruffer with trumps out');
});

test('early lead: trump Ace is preferred as a safe cash when needing tricks', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'SPADES',
    cards: 6,
    myBid: 1,
    myTricks: 0,
    myHand: [card('SPADES', 'A'), card('CLUBS', '6'), card('DIAMONDS', '7')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }, { cardIndex: 2 }],
  });
  const { strategy, context } = decide(state);
  assert.equal(strategy.chooseCard(context), 0);
});

test('holds joker when only one trick still needed and hand is long', () => {
  // Need 1 more of 5 remaining — dump a loser, reserve joker TAKE for later.
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    cards: 6,
    myBid: 2,
    myTricks: 1,
    myHand: [
      card('SPADES', '7', true),
      card('CLUBS', '6'),
      card('CLUBS', '8'),
      card('DIAMONDS', '7'),
      card('DIAMONDS', '9'),
    ],
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
      { cardIndex: 3 },
      { cardIndex: 4 },
    ],
  });
  const { strategy, context } = decide(state);
  const chosen = strategy.chooseCard(context);
  assert.notEqual(chosen, 0, 'must reserve joker while ordinary losers can be played');
});

test('after contract made, dumps high loser rather than joker TAKE', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    leadSuit: 'SPADES',
    cards: 5,
    myBid: 1,
    myTricks: 1,
    tableCards: [
      { playerId: 'op1', card: card('SPADES', 'Q') },
      { playerId: 'op2', card: card('SPADES', 'K') },
    ],
    myHand: [card('SPADES', '7', true), card('SPADES', 'J')],
    legalPlays: [
      {
        cardIndex: 0,
        jokerActions: [{ type: 'TAKE' }, { type: 'DROP' }],
      },
      { cardIndex: 1 },
    ],
  });
  const { strategy, context } = decide(state);
  const chosen = strategy.chooseCard(context);
  // Prefer dumping J under K (loses) over joker TAKE (wins unwanted).
  assert.equal(chosen, 1);
});

test('behind on table: control puts pressure on the leader as dealer', () => {
  // Score far from zero-path dump range so meta choice (not zero setup) decides.
  const state = makeState({
    phase: 'CONTROL_GAME_SETUP',
    myScore: 55,
    opponents: [{ score: 120 }, { score: 40 }],
  });
  state.controlGameChooserId = ME;
  state.playedRoundTypes = ['STANDARD', 'GOLD', 'MISER', 'PERCENTS'];
  const { strategy, context } = decide(state);
  const choice = strategy.chooseControlGame(context);
  assert.ok(state.playedRoundTypes.includes(choice.roundType));
  // Leader (index 1, score 120) should be forced to deal («Кроме» pressure).
  assert.equal(choice.dealerIndex, 1);
});
test('no-trump: leading joker demands an establishment suit', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: null,
    roundType: 'NO_TRUMP',
    myBid: 2,
    myTricks: 0,
    myHand: [
      card('SPADES', '7', true),
      card('HEARTS', 'A'),
      card('HEARTS', 'K'),
      card('HEARTS', 'Q'),
      card('HEARTS', 'J'),
    ],
    legalPlays: [
      {
        cardIndex: 0,
        jokerActions: [
          { type: 'TAKE' },
          { type: 'DEMAND_SUIT', suit: 'HEARTS' },
          { type: 'DEMAND_SUIT', suit: 'SPADES' },
          { type: 'DROP', suit: 'HEARTS' },
        ],
      },
      { cardIndex: 1 },
      { cardIndex: 2 },
      { cardIndex: 3 },
      { cardIndex: 4 },
    ],
  });
  const { strategy, context } = decide(state);
  const cardIndex = strategy.chooseCard(context);
  // Either cash hearts Ace or joker-DEMAND hearts — both establishment plays.
  if (cardIndex === 0) {
    const action = strategy.chooseJokerAction(context, cardIndex);
    assert.equal(action.type, 'DEMAND_SUIT');
    assert.equal(action.type === 'DEMAND_SUIT' ? action.suit : null, 'HEARTS');
  } else {
    assert.equal(cardIndex, 1, 'lead Ace of long hearts suit');
  }
});

test('dark bid avoids zero when positive bids are legal', () => {
  const state = makeState({
    phase: 'BIDDING',
    roundType: 'DARK',
    isDark: true,
    cards: 6,
    allowedBids: [0, 1, 2, 3, 4, 5, 6],
    myHand: [null, null, null, null, null, null],
  });
  const { strategy, context } = decide(state);
  const bid = strategy.chooseBid(context);
  assert.ok(bid >= 1);
  assert.ok(bid <= 6);
});

test('claim pressure: high opponent bids shade our contract down', () => {
  const baseHand = [
    card('CLUBS', '10'),
    card('DIAMONDS', '9'),
    card('HEARTS', '8'),
    card('SPADES', '6'),
  ];
  const quiet = makeState({
    phase: 'BIDDING',
    trumpSuit: 'CLUBS',
    cards: 4,
    allowedBids: [0, 1, 2, 3, 4],
    myHand: baseHand,
    opponents: [{ bid: null }, { bid: null }],
  });
  const pressured = makeState({
    phase: 'BIDDING',
    trumpSuit: 'CLUBS',
    cards: 4,
    allowedBids: [0, 1, 2, 3, 4],
    myHand: baseHand,
    opponents: [{ bid: 3 }, { bid: 2 }],
  });
  const quietBid = decide(quiet).strategy.chooseBid(decide(quiet).context);
  const pressuredBid = decide(pressured).strategy.chooseBid(decide(pressured).context);
  assert.ok(
    pressuredBid <= quietBid,
    `pressured ${pressuredBid} should be ≤ quiet ${quietBid}`,
  );
});
