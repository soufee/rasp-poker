import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/core/stateSelectors';
import type { CardModel, GameStatePayload, Rank, RoundType, Suit } from '../src/protocol/types';
import { GrokStrategy } from '../src/strategy/GrokStrategy';
import {
  canReachZero,
  chooseZeroControlSetup,
  detectOpponentZeroThreats,
  isZeroPathAttractive,
  planZeroPath,
  shouldDefendSecondFromZero,
  trickPreferenceVsThreat,
} from '../src/strategy/zeroPath';

const ME = 'grok-bot';

function card(suit: Suit, rank: Rank): CardModel {
  return { suit, rank, isJoker: false };
}

interface StateOpts {
  phase?: GameStatePayload['state'];
  roundType?: RoundType;
  cards?: number;
  myScore?: number;
  myBid?: number | null;
  myTricks?: number;
  myHand?: Array<CardModel | null>;
  oppScores?: [number, number];
  oppBids?: [number | null, number | null];
  controlGamesPlayed?: number;
  playedRoundTypes?: RoundType[];
  allowedBids?: number[] | null;
  legalPlays?: Array<{ cardIndex: number }>;
  tableCards?: GameStatePayload['tableCards'];
  leadSuit?: Suit | null;
  trumpSuit?: Suit | null;
  plan?: GameStatePayload['plan'];
  currentRoundIndex?: number;
}

function makeState(opts: StateOpts = {}): GameStatePayload {
  const oppScores = opts.oppScores ?? [250, 220];
  const oppBids = opts.oppBids ?? [null, null];
  const hand = opts.myHand ?? [card('SPADES', 'A'), card('CLUBS', '6'), card('HEARTS', '7'), card('DIAMONDS', '8')];
  const me = {
    id: ME,
    name: 'Grok',
    cards: hand,
    score: opts.myScore ?? 40,
    currentBid: opts.myBid ?? null,
    tricksTaken: opts.myTricks ?? 0,
    connected: true,
    isBot: true,
  };
  const others = [0, 1].map((i) => ({
    id: `op${i + 1}`,
    name: `Opp ${i + 1}`,
    cards: hand.map(() => null) as Array<CardModel | null>,
    score: oppScores[i],
    currentBid: oppBids[i],
    tricksTaken: 0,
    connected: true,
    isBot: true,
  }));
  return {
    state: opts.phase ?? 'PLAYING_TRICKS',
    stateVersion: 1,
    viewerId: ME,
    hostId: ME,
    maxPlayers: 3,
    playersCount: 3,
    dealerIndex: 1,
    currentPlayerIndex: 0,
    trumpSuit: opts.trumpSuit ?? 'HEARTS',
    currentTrickLeadSuit: opts.leadSuit ?? null,
    tableCards: opts.tableCards ?? [],
    currentRoundCards: opts.cards ?? 12,
    currentRoundType: opts.roundType ?? 'STANDARD',
    isDarkRound: false,
    plan: opts.plan ?? [],
    currentRoundIndex: opts.currentRoundIndex ?? 0,
    playedRoundTypes: opts.playedRoundTypes ?? ['STANDARD', 'NO_TRUMP', 'DARK', 'PERCENTS', 'GOLD', 'MISER'],
    controlGamesPlayed: opts.controlGamesPlayed ?? 1,
    controlGameChooserId: ME,
    allowedBids: opts.allowedBids ?? null,
    validCardIndices: (opts.legalPlays ?? []).map((play) => play.cardIndex),
    legalPlays: opts.legalPlays ?? [],
    players: [me, ...others],
  };
}

function ctx(opts?: StateOpts) {
  const state = makeState(opts);
  const context = buildContext(state, ME);
  assert.ok(context);
  return context;
}

test('canReachZero: underbid dump from +40', () => {
  assert.equal(canReachZero(40, [{ type: 'STANDARD', cards: 12 }]), true);
});

test('canReachZero: GOLD climb from −70 to 0', () => {
  assert.equal(canReachZero(-70, [{ type: 'GOLD', cards: 12 }]), true);
});

test('canReachZero: −70 via GOLD pad then underbid', () => {
  assert.equal(
    canReachZero(-70, [
      { type: 'GOLD', cards: 12 },
      { type: 'STANDARD', cards: 12 },
    ]),
    true,
  );
});

test('zero path attractive when far behind with control remaining', () => {
  const context = ctx({
    phase: 'CONTROL_GAME_SETUP',
    myScore: -70,
    oppScores: [250, 220],
    controlGamesPlayed: 0,
  });
  assert.equal(isZeroPathAttractive(context), true);
});

test('zero path not attractive when already clear 2nd by points', () => {
  const context = ctx({
    myScore: 200,
    oppScores: [250, 100],
    controlGamesPlayed: 1,
  });
  assert.equal(isZeroPathAttractive(context), false);
});

test('zero path not attractive when leading', () => {
  const context = ctx({
    myScore: 300,
    oppScores: [250, 220],
  });
  assert.equal(isZeroPathAttractive(context), false);
});

test('plan: dump underbid from score 40', () => {
  const context = ctx({
    myScore: 40,
    roundType: 'STANDARD',
    cards: 12,
    controlGamesPlayed: 1,
  });
  const plan = planZeroPath(context);
  assert.equal(plan.active, true);
  assert.equal(plan.style, 'dump_underbid');
  assert.equal(plan.sacrificialBid, 4);
  assert.equal(plan.maxTricksAllowed, 3);
});

test('plan: GOLD accumulates toward dump pad from −70', () => {
  const context = ctx({
    phase: 'PLAYING_TRICKS',
    roundType: 'GOLD',
    myScore: -70,
    myTricks: 0,
    cards: 12,
    myHand: Array.from({ length: 12 }, (_, i) => card('HEARTS', (['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as Rank[])[i % 9]!)),
    controlGamesPlayed: 0,
    plan: [
      { roundNumber: 1, type: 'GOLD', cardsInHand: 12, dealerIndex: 0 },
      { roundNumber: 2, type: 'STANDARD', cardsInHand: 12, dealerIndex: 1 },
    ],
    currentRoundIndex: 0,
  });
  // Force attractiveness via late GOLD + deep hole.
  assert.equal(isZeroPathAttractive(context), true);
  const plan = planZeroPath(context);
  assert.equal(plan.active, true);
  assert.ok(
    plan.style === 'accumulate' || plan.style === 'target_delta' || plan.style === 'hold_zero',
    plan.reason,
  );
  // Target after GOLD should be a multiple of 10 that can dump to 0 (e.g. 10..120).
  if (plan.targetScoreAfterRound !== null) {
    assert.equal(plan.targetScoreAfterRound % 10, 0);
    assert.ok(plan.targetScoreAfterRound >= 0);
  }
});

test('control setup: dumpable type, dealer is not us', () => {
  const context = ctx({
    phase: 'CONTROL_GAME_SETUP',
    myScore: 40,
    oppScores: [250, 220],
    controlGamesPlayed: 0,
    playedRoundTypes: ['STANDARD', 'NO_TRUMP', 'GOLD'],
  });
  const setup = chooseZeroControlSetup(context);
  assert.ok(setup);
  assert.ok(setup!.roundType === 'STANDARD' || setup!.roundType === 'NO_TRUMP');
  assert.notEqual(setup!.dealerIndex, context.myIndex);
});

test('Grok bids 4 to dump from +40', () => {
  const state = makeState({
    phase: 'BIDDING',
    roundType: 'NO_TRUMP',
    myScore: 40,
    oppScores: [250, 220],
    cards: 12,
    allowedBids: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    controlGamesPlayed: 1,
  });
  const strategy = new GrokStrategy();
  const context = buildContext(state, ME)!;
  strategy.observe(context);
  assert.equal(strategy.chooseBid(context), 4);
});

test('Grok ducks to miss sacrificial bid', () => {
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    roundType: 'STANDARD',
    myScore: 40,
    myBid: 4,
    myTricks: 0,
    oppScores: [250, 220],
    cards: 6,
    trumpSuit: 'DIAMONDS',
    leadSuit: 'SPADES',
    tableCards: [
      { playerId: 'op1', card: card('SPADES', '10') },
      { playerId: 'op2', card: card('SPADES', '8') },
    ],
    myHand: [card('SPADES', 'A'), card('SPADES', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
    controlGamesPlayed: 1,
  });
  const strategy = new GrokStrategy();
  const context = buildContext(state, ME)!;
  strategy.observe(context);
  assert.equal(strategy.chooseCard(context), 1, 'must duck to protect underbid dump to 0');
});

test('Grok control chooser uses zero setup', () => {
  const state = makeState({
    phase: 'CONTROL_GAME_SETUP',
    myScore: 40,
    oppScores: [250, 220],
    controlGamesPlayed: 0,
    playedRoundTypes: ['STANDARD', 'NO_TRUMP', 'DARK', 'GOLD'],
  });
  const strategy = new GrokStrategy();
  const context = buildContext(state, ME)!;
  const choice = strategy.chooseControlGame(context);
  assert.ok(choice.roundType === 'STANDARD' || choice.roundType === 'NO_TRUMP');
  assert.notEqual(choice.dealerIndex, 0);
});

test('defend 2nd: detects opponent underbid dump to zero', () => {
  const context = ctx({
    myScore: 200,
    oppScores: [250, 40],
    oppBids: [2, 4],
    controlGamesPlayed: 1,
    roundType: 'STANDARD',
    cards: 12,
  });
  // op2 is index 2 with score 40 bid 4 → miss lands on 0
  assert.equal(shouldDefendSecondFromZero(context), true);
  const threats = detectOpponentZeroThreats(context);
  assert.ok(threats.some((threat) => threat.kind === 'underbid_miss' && threat.playerIndex === 2));
});

test('defend 2nd: prefers feeding underbid seeker', () => {
  const threats = detectOpponentZeroThreats(
    ctx({
      myScore: 200,
      oppScores: [250, 40],
      oppBids: [1, 4],
      myTricks: 0,
      controlGamesPlayed: 1,
      roundType: 'NO_TRUMP',
      cards: 12,
    }),
  );
  const threat = threats.find((entry) => entry.playerIndex === 2);
  assert.ok(threat);
  assert.ok(trickPreferenceVsThreat(threat!, true) > trickPreferenceVsThreat(threat!, false));
});

test('Grok feeds overtrick to spoil opponent zero dump even at self cost', () => {
  // We are 2nd (200). Leader 250. Trailer 40 bid 4 taken 3 — one feed makes them
  // exact (+40) instead of miss (−40→0). Our bid already made; ducking is self-harmless
  // but even if we overtrick, deny-zero should prefer feed.
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    roundType: 'STANDARD',
    myScore: 200,
    myBid: 1,
    myTricks: 1,
    oppScores: [250, 40],
    oppBids: [2, 4],
    cards: 6,
    trumpSuit: 'DIAMONDS',
    leadSuit: 'SPADES',
    tableCards: [
      { playerId: 'op1', card: card('SPADES', '8') },
      { playerId: 'op2', card: card('SPADES', 'Q') },
    ],
    myHand: [card('SPADES', 'A'), card('SPADES', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
    controlGamesPlayed: 1,
  });
  // Fix op2 tricks to 3 (one short of make).
  state.players[2].tricksTaken = 3;
  state.players[2].currentBid = 4;
  state.players[1].currentBid = 2;

  const strategy = new GrokStrategy();
  const context = buildContext(state, ME)!;
  strategy.observe(context);
  assert.equal(
    strategy.chooseCard(context),
    1,
    'must duck and feed the zero-seeker so they make instead of missing to 0',
  );
});

test('Grok steals GOLD trick to deny opponent exact zero climb', () => {
  // We are 2nd. Opponent at −20 needs exactly 2 GOLD tricks total; has 1; is winning board.
  // Steal so they cannot land on 0.
  const state = makeState({
    phase: 'PLAYING_TRICKS',
    roundType: 'GOLD',
    myScore: 180,
    myBid: null,
    myTricks: 2,
    oppScores: [240, -20],
    cards: 6,
    trumpSuit: null,
    leadSuit: 'SPADES',
    tableCards: [
      { playerId: 'op1', card: card('SPADES', '8') },
      { playerId: 'op2', card: card('SPADES', 'Q') },
    ],
    myHand: [card('SPADES', 'A'), card('SPADES', '6')],
    legalPlays: [{ cardIndex: 0 }, { cardIndex: 1 }],
    controlGamesPlayed: 1,
  });
  state.players[2].tricksTaken = 1;
  state.players[2].score = -20;

  const strategy = new GrokStrategy();
  const context = buildContext(state, ME)!;
  strategy.observe(context);
  assert.equal(
    strategy.chooseCard(context),
    0,
    'must take to deny GOLD exact-zero path',
  );
});

test('does not defend when we ourselves need the zero path', () => {
  const context = ctx({
    myScore: -70,
    oppScores: [250, 220],
    controlGamesPlayed: 0,
    phase: 'CONTROL_GAME_SETUP',
  });
  assert.equal(isZeroPathAttractive(context), true);
  assert.equal(shouldDefendSecondFromZero(context), false);
});
