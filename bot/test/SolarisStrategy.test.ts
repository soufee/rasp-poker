import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/core/stateSelectors';
import type {
  CardModel,
  GameStatePayload,
  Rank,
  RoundType,
  Suit,
} from '../src/protocol/types';
import { SolarisBelief } from '../src/strategy/solarisBelief';
import {
  createStrategy,
  getBotDefinition,
} from '../src/strategy/registry';
import { SolarisStrategy } from '../src/strategy/SolarisStrategy';

const ME = 'solaris-bot';

function card(
  suit: Suit,
  rank: Rank,
  isJoker = false,
): CardModel {
  return { suit, rank, isJoker };
}

interface StateOptions {
  phase?: GameStatePayload['state'];
  roundType?: RoundType;
  cards?: number;
  trumpSuit?: Suit | null;
  leadSuit?: Suit | null;
  allowedBids?: number[] | null;
  hand?: CardModel[];
  bid?: number | null;
  tricks?: number;
  score?: number;
  opponentScores?: [number, number];
  tableCards?: GameStatePayload['tableCards'];
  legalPlays?: NonNullable<GameStatePayload['legalPlays']>;
  controlGamesPlayed?: number;
}

function makeState(options: StateOptions = {}): GameStatePayload {
  const hand =
    options.hand
    ?? [
      card('HEARTS', 'A'),
      card('CLUBS', '8'),
      card('DIAMONDS', '6'),
    ];
  const tableCards = options.tableCards ?? [];
  const opponents = (options.opponentScores ?? [30, 20]).map(
    (score, index) => ({
      id: `op${index + 1}`,
      name: `Opponent ${index + 1}`,
      cards: Array.from(
        {
          length:
            hand.length
            - tableCards.filter(
              (played) => played.playerId === `op${index + 1}`,
            ).length,
        },
        () => null,
      ) as Array<CardModel | null>,
      score,
      currentBid: index + 1,
      tricksTaken: 0,
    }),
  );
  return {
    state: options.phase ?? 'BIDDING',
    stateVersion: 7,
    viewerId: ME,
    hostId: ME,
    maxPlayers: 3,
    playersCount: 3,
    dealerIndex: 2,
    currentPlayerIndex: 0,
    trumpSuit: options.trumpSuit ?? 'HEARTS',
    trumpCard:
      options.trumpSuit === null
        ? null
        : card(options.trumpSuit ?? 'HEARTS', '6'),
    currentTrickLeadSuit: options.leadSuit ?? null,
    tableCards,
    currentRoundType: options.roundType ?? 'STANDARD',
    currentRoundCards: options.cards ?? hand.length,
    isDarkRound: options.roundType === 'DARK',
    plan: [],
    currentRoundIndex: 0,
    playedRoundTypes: [
      'STANDARD',
      'DARK',
      'PERCENTS',
      'NO_TRUMP',
      'GOLD',
      'MISER',
    ],
    scoreHistory: [],
    controlGamesPlayed: options.controlGamesPlayed ?? 0,
    controlGameChooserId: ME,
    allowedBids: options.allowedBids ?? null,
    validCardIndices: (options.legalPlays ?? []).map(
      (play) => play.cardIndex,
    ),
    legalPlays: options.legalPlays ?? [],
    players: [
      {
        id: ME,
        name: 'Solaris',
        cards: hand,
        score: options.score ?? 0,
        currentBid: options.bid ?? null,
        tricksTaken: options.tricks ?? 0,
      },
      ...opponents,
    ],
  };
}

function context(options: StateOptions = {}) {
  const result = buildContext(makeState(options), ME);
  assert.ok(result);
  return result;
}

test('Solaris exposes its name', () => {
  assert.equal(new SolarisStrategy().name, 'Solaris');
});

test('Solaris is available through the bot registry', async () => {
  assert.equal(getBotDefinition('solaris')?.label, 'Solaris');
  const strategy = await createStrategy('solaris');
  assert.equal(strategy.name, 'Solaris');
});

test('Solaris returns a legal bid for a strong trump hand', () => {
  const ctx = context({
    allowedBids: [0, 1, 2, 3],
    hand: [
      card('HEARTS', 'A'),
      card('HEARTS', 'K'),
      card('HEARTS', 'Q'),
    ],
  });
  const bid = new SolarisStrategy().chooseBid(ctx);
  assert.ok(ctx.state.allowedBids?.includes(bid));
  assert.ok(bid >= 1);
});

test('Solaris takes a required trick with a winning card', () => {
  const ctx = context({
    phase: 'PLAYING_TRICKS',
    cards: 3,
    leadSuit: 'SPADES',
    bid: 3,
    tricks: 1,
    hand: [
      card('SPADES', 'J'),
      card('SPADES', 'A'),
      card('SPADES', '6'),
    ],
    tableCards: [
      { playerId: 'op1', card: card('SPADES', '8') },
      { playerId: 'op2', card: card('SPADES', '10') },
    ],
    legalPlays: [
      { cardIndex: 0 },
      { cardIndex: 1 },
      { cardIndex: 2 },
    ],
  });
  assert.notEqual(new SolarisStrategy().chooseCard(ctx), 2);
});

test('Solaris uses a sacrificial bid to reach zero', () => {
  const ctx = context({
    phase: 'BIDDING',
    cards: 12,
    roundType: 'NO_TRUMP',
    trumpSuit: null,
    score: 40,
    opponentScores: [250, 220],
    controlGamesPlayed: 1,
    allowedBids: [0, 1, 2, 3, 4, 5, 6],
    hand: [
      card('HEARTS', 'A'),
      card('HEARTS', 'K'),
      card('HEARTS', 'Q'),
      card('CLUBS', 'A'),
      card('CLUBS', 'K'),
      card('CLUBS', 'Q'),
      card('DIAMONDS', 'A'),
      card('DIAMONDS', 'K'),
      card('DIAMONDS', 'Q'),
      card('SPADES', 'A'),
      card('SPADES', 'K'),
      card('SPADES', 'Q'),
    ],
  });
  assert.equal(new SolarisStrategy().chooseBid(ctx), 4);
});

test('Solaris belief records void suits from observed play', () => {
  const ctx = context({
    phase: 'PLAYING_TRICKS',
    trumpSuit: 'CLUBS',
    leadSuit: 'SPADES',
    bid: 1,
    hand: [
      card('SPADES', 'A'),
      card('CLUBS', '8'),
      card('DIAMONDS', '6'),
    ],
    tableCards: [
      { playerId: 'op1', card: card('SPADES', '9') },
      { playerId: 'op2', card: card('HEARTS', '10') },
    ],
  });
  const belief = new SolarisBelief();
  belief.observe(ctx);
  assert.equal(belief.isVoid('op2', 'SPADES'), true);
  assert.equal(belief.isVoid('op2', 'CLUBS'), true);
});

test('Solaris control choice is valid', () => {
  const ctx = context({
    phase: 'CONTROL_GAME_SETUP',
    score: -60,
    opponentScores: [180, 140],
  });
  const choice = new SolarisStrategy().chooseControlGame(ctx);
  assert.ok(ctx.state.playedRoundTypes?.includes(choice.roundType));
  assert.ok(choice.dealerIndex >= 0);
  assert.ok(choice.dealerIndex < ctx.state.players.length);
});
