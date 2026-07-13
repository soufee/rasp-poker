import test from 'node:test';
import assert from 'node:assert/strict';
import { NoviceStrategy } from '../src/strategy/NoviceStrategy';
import { RandomStrategy } from '../src/strategy/RandomStrategy';
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
  myScore?: number;
  oppScores?: number[];
}

function makeState(options: Options): GameStatePayload {
  const oppScores = options.oppScores ?? [0, 0];
  const others: PlayerState[] = [1, 2].map((n, i) => ({
    id: `op${n}`,
    name: `Opp ${n}`,
    cards: [null, null, null],
    score: oppScores[i] ?? 0,
    currentBid: null,
    tricksTaken: 0,
  }));
  const me: PlayerState = {
    id: ME,
    name: 'Новичок',
    cards: options.myHand ?? [],
    score: options.myScore ?? 0,
    currentBid: options.myBid ?? null,
    tricksTaken: options.myTricks ?? 0,
  };
  return {
    state: options.phase,
    stateVersion: 1,
    hostId: ME,
    maxPlayers: 3,
    settings: { playersCount: 3, hasLadder: true, hasMiser: true },
    playersCount: 3,
    dealerIndex: 2,
    currentPlayerIndex: 0,
    trumpSuit: options.trumpSuit ?? null,
    tableCards: options.tableCards ?? [],
    currentTrickLeadSuit: options.leadSuit ?? null,
    currentRoundCards: options.cards ?? 3,
    currentRoundType: options.roundType ?? 'STANDARD',
    isDarkRound: options.isDark ?? false,
    playedRoundTypes: ['STANDARD', 'NO_TRUMP', 'GOLD', 'MISER'],
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

test('NoviceStrategy name and RandomStrategy alias check', () => {
  const novice = new NoviceStrategy();
  const randomAlias = new RandomStrategy();
  assert.equal(novice.name, 'Новичок');
  assert.equal(randomAlias.name, 'Новичок');
});

test('bidding: bid is always within allowedBids', () => {
  const strategy = new NoviceStrategy();
  const state = makeState({
    phase: 'BIDDING',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('HEARTS', '6'), card('CLUBS', '7'), card('DIAMONDS', '8')],
  });
  const bid = strategy.chooseBid(ctxFor(state));
  assert.ok([0, 1, 2, 3].includes(bid));
});

test('bidding: strong trump hand bids aggressively', () => {
  const strategy = new NoviceStrategy();
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'SPADES',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('SPADES', 'A'), card('SPADES', 'K'), card('SPADES', '7', true)],
  });
  const bid = strategy.chooseBid(ctxFor(state));
  assert.ok(bid >= 2, `expected bid >= 2 for strong trump hand, got ${bid}`);
});

test('bidding: weak hand bids low', () => {
  const strategy = new NoviceStrategy();
  const state = makeState({
    phase: 'BIDDING',
    trumpSuit: 'HEARTS',
    allowedBids: [0, 1, 2, 3],
    myHand: [card('CLUBS', '6'), card('DIAMONDS', '7'), card('SPADES', '8')],
  });
  const bid = strategy.chooseBid(ctxFor(state));
  assert.ok(bid <= 1, `expected bid <= 1 for weak hand, got ${bid}`);
});

test('play: when needing tricks, leads a winning/strong card', () => {
  const strategy = new NoviceStrategy();
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 1,
    myTricks: 0,
    myHand: [card('HEARTS', 'A'), card('CLUBS', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const index = strategy.chooseCard(ctxFor(state));
  assert.equal(index, 0, 'should lead the Ace of trumps when needing a trick');
});

test('play: when contract is met, ducks with lowest/safest card', () => {
  const strategy = new NoviceStrategy();
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'HEARTS',
    myBid: 0,
    myTricks: 0,
    myHand: [card('HEARTS', 'A'), card('CLUBS', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const index = strategy.chooseCard(ctxFor(state));
  assert.equal(index, 1, 'should lead/play low club when contract already met or 0 bid');
});

test('play: playing last when needing trick chooses cheapest winner', () => {
  const strategy = new NoviceStrategy();
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    trumpSuit: null,
    myBid: 1,
    myTricks: 0,
    tableCards: [
      { card: card('HEARTS', '9'), playerId: 'op1' },
      { card: card('HEARTS', '10'), playerId: 'op2' },
    ],
    leadSuit: 'HEARTS',
    myHand: [card('HEARTS', 'J'), card('HEARTS', 'A')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
  });
  const index = strategy.chooseCard(ctxFor(state));
  assert.equal(index, 0, 'should win with J instead of wasting A when playing last');
});

test('control game: chooses a valid round type and dealer index', () => {
  const strategy = new NoviceStrategy();
  const state = makeState({
    phase: 'CONTROL_GAME_SETUP',
  });
  const { roundType, dealerIndex } = strategy.chooseControlGame(ctxFor(state));
  assert.ok(['STANDARD', 'NO_TRUMP', 'GOLD', 'MISER'].includes(roundType));
  assert.ok(dealerIndex >= 0 && dealerIndex < 3);
});
