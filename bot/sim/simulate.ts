/**
 * Offline arena: run full matches directly against the real GameEngine (no DB,
 * no network) using the same fog-of-war view the server sends to clients. Used to
 * validate that ClaudeStrategy plays only legal moves, finishes matches, and to
 * measure win rate against Grok and Random.
 *
 * Usage: npx tsx bot/sim/simulate.ts [matches] [players]
 */
import { GameEngine, GameState, type JokerAction } from '../../src/engine/GameEngine';
import { RoundType } from '../../src/engine/Scoring';
import { buildContext } from '../src/core/stateSelectors';
import type { Strategy } from '../src/strategy/Strategy';
import { ClaudeStrategy } from '../src/strategy/ClaudeStrategy';
import { ComposerStrategy } from '../src/strategy/ComposerStrategy';
import { GlmStrategy } from '../src/strategy/GlmStrategy';
import { GrokStrategy } from '../src/strategy/GrokStrategy';
import { RandomStrategy } from '../src/strategy/RandomStrategy';
import { SolarisStrategy } from '../src/strategy/SolarisStrategy';
import type {
  GameStatePayload,
  PlayedCard,
  PlayerState,
  Rank,
  RoundType as BotRoundType,
  Suit,
} from '../src/protocol/types';

interface Contestant {
  label: string;
  make: () => Strategy;
}

const ALL_CONTESTANTS: Contestant[] = [
  { label: 'Solaris', make: () => new SolarisStrategy() },
  { label: 'Claude', make: () => new ClaudeStrategy() },
  { label: 'Grok', make: () => new GrokStrategy() },
  { label: 'GLM', make: () => new GlmStrategy() },
  { label: 'Composer', make: () => new ComposerStrategy() },
  { label: 'Random', make: () => new RandomStrategy() },
];

const WITHOUT_RANDOM: Contestant[] = process.env.NO_RANDOM
  ? ALL_CONTESTANTS.filter((contestant) => contestant.label !== 'Random')
  : ALL_CONTESTANTS;
const requestedBots = new Set(
  (process.env.BOTS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);
const CONTESTANTS: Contestant[] =
  requestedBots.size > 0
    ? WITHOUT_RANDOM.filter((contestant) => requestedBots.has(contestant.label))
    : WITHOUT_RANDOM;

function buildView(engine: GameEngine, viewerId: string, version: number): GameStatePayload {
  const isViewerTurn = engine.players[engine.currentPlayerIndex]?.id === viewerId;
  const allowedBids =
    isViewerTurn && engine.state === GameState.BIDDING ? engine.getLegalBids(viewerId) : null;
  const legalPlays =
    isViewerTurn && engine.state === GameState.PLAYING_TRICKS
      ? engine.getLegalPlays(viewerId)
      : [];

  const players: PlayerState[] = engine.players.map((player) => {
    const base: PlayerState = {
      id: player.id,
      name: player.name,
      cards: [],
      score: player.score,
      currentBid: player.currentBid,
      tricksTaken: player.tricksTaken,
    };
    if (player.id === viewerId) {
      const hideSelf = engine.isDarkRound && engine.state === GameState.BIDDING;
      base.cards = hideSelf
        ? player.cards.map(() => null)
        : player.cards.map((card) => ({
            suit: card.suit as Suit,
            rank: card.rank as Rank,
            isJoker: card.isJoker,
          }));
    } else {
      base.cards = player.cards.map(() => null);
    }
    return base;
  });

  const tableCards: PlayedCard[] = engine.tableCards.map((played) => ({
    playerId: played.playerId,
    jokerAction: played.jokerAction as JokerAction | undefined,
    card: { suit: played.card.suit as Suit, rank: played.card.rank as Rank },
  }));

  return {
    state: engine.state as unknown as GameStatePayload['state'],
    stateVersion: version,
    hostId: engine.players[0]?.id,
    maxPlayers: engine.maxPlayers as 3 | 4 | 6,
    settings: {
      playersCount: engine.maxPlayers as 3 | 4 | 6,
      hasLadder: true,
      hasMiser: true,
    },
    playersCount: engine.players.length,
    dealerIndex: engine.dealerIndex,
    currentPlayerIndex: engine.currentPlayerIndex,
    trumpSuit: (engine.trumpSuit as Suit | null) ?? null,
    trumpCard: engine.trumpCard
      ? {
          suit: engine.trumpCard.suit as Suit,
          rank: engine.trumpCard.rank as Rank,
        }
      : null,
    tableCards,
    currentTrickLeadSuit: (engine.currentTrickLeadSuit as Suit | null) ?? null,
    pendingTrickWinnerId: engine.pendingTrickWinnerId,
    currentRoundType: engine.currentRoundType as unknown as BotRoundType,
    currentRoundCards: engine.currentRoundCards,
    isDarkRound: engine.isDarkRound,
    plan: engine.plan.map((round) => ({
      ...round,
      type: round.type as unknown as BotRoundType,
    })),
    scoreHistory: engine.scoreHistory.map((round) => ({
      ...round,
      roundType: round.roundType as unknown as BotRoundType,
      scores: { ...round.scores },
      bids: { ...round.bids },
      tricks: { ...round.tricks },
    })),
    currentRoundIndex: engine.currentRoundIndex,
    playedRoundTypes: Array.from(engine.playedRoundTypes) as unknown as BotRoundType[],
    controlGamesPlayed: engine.controlGamesPlayed,
    controlGameChooserId: engine.controlGameChooserId,
    allowedBids,
    validCardIndices: legalPlays.map((play) => play.cardIndex),
    legalPlays: legalPlays.map((play) => ({
      cardIndex: play.cardIndex,
      jokerActions: play.jokerActions as JokerAction[] | undefined,
    })),
    players,
  };
}

function playMatch(strategies: Strategy[], players: 3 | 4 | 6): GameEngine {
  const engine = new GameEngine(players, true);
  for (let seat = 0; seat < players; seat += 1) {
    engine.addPlayer(`p${seat}`, strategies[seat].name ?? `Bot ${seat + 1}`);
  }
  const byId = new Map<string, Strategy>();
  engine.players.forEach((player, index) => byId.set(player.id, strategies[index]));

  engine.startGame({ playersCount: players, hasLadder: true, hasMiser: true });

  let version = 0;
  let guard = 0;
  while (engine.state !== GameState.MATCH_FINISHED && guard < 200_000) {
    guard += 1;
    version += 1;
    for (const player of engine.players) {
      const observer = byId.get(player.id);
      const observerContext = buildContext(
        buildView(engine, player.id, version),
        player.id,
      );
      if (observer && observerContext) {
        observer.observe?.(observerContext);
      }
    }

    if (engine.state === GameState.CONTROL_GAME_SETUP) {
      const chooserId = engine.controlGameChooserId;
      if (!chooserId) {
        break;
      }
      const strategy = byId.get(chooserId)!;
      const context = buildContext(buildView(engine, chooserId, version), chooserId);
      const choice = strategy.chooseControlGame(context!);
      const played = Array.from(engine.playedRoundTypes);
      const roundType = played.includes(choice.roundType as unknown as RoundType)
        ? (choice.roundType as unknown as RoundType)
        : played[0];
      const ok = engine.setupControlGame(chooserId, roundType, choice.dealerIndex);
      if (!ok) {
        engine.setupControlGame(chooserId, played[0], 0);
      }
      continue;
    }

    const current = engine.players[engine.currentPlayerIndex];
    if (!current) {
      break;
    }
    const strategy = byId.get(current.id)!;
    const context = buildContext(buildView(engine, current.id, version), current.id)!;

    if (engine.state === GameState.BIDDING) {
      const allowed = engine.getLegalBids(current.id);
      let bid = strategy.chooseBid(context);
      if (!allowed.includes(bid)) {
        bid = allowed[0];
      }
      engine.applyAction({ type: 'PLACE_BID', playerId: current.id, bid });
      continue;
    }

    if (engine.state === GameState.PLAYING_TRICKS) {
      const legal = engine.getLegalPlays(current.id);
      let cardIndex = strategy.chooseCard(context);
      if (!legal.some((play) => play.cardIndex === cardIndex)) {
        cardIndex = legal[0].cardIndex;
      }
      const card = current.cards[cardIndex];
      let jokerAction: JokerAction | undefined;
      if (card.isJoker) {
        jokerAction = strategy.chooseJokerAction(context, cardIndex) as JokerAction;
      }
      engine.applyAction({ type: 'PLAY_CARD', playerId: current.id, cardIndex, jokerAction });
      if (engine.pendingTrickWinnerId !== null) {
        version += 1;
        for (const player of engine.players) {
          const observer = byId.get(player.id);
          const observerContext = buildContext(
            buildView(engine, player.id, version),
            player.id,
          );
          if (observer && observerContext) {
            observer.observe?.(observerContext);
          }
        }
        engine.finalizeTrick();
      }
      continue;
    }

    break;
  }
  return engine;
}

function main(): void {
  const matches = Number(process.argv[2] ?? 60);
  const players = (Number(process.argv[3] ?? 3) as 3 | 4 | 6) || 3;

  const wins = new Map<string, number>();
  const totalScore = new Map<string, number>();
  const byType = new Map<string, Map<string, number>>();
  for (const contestant of CONTESTANTS) {
    wins.set(contestant.label, 0);
    totalScore.set(contestant.label, 0);
    byType.set(contestant.label, new Map());
  }

  const bidStats = new Map<string, { rounds: number; bidSum: number; takeSum: number; exact: number; over: number; under: number; missPoints: number; hist: number[]; takeByBid: number[] }>();
  bidStats.set('Claude', { rounds: 0, bidSum: 0, takeSum: 0, exact: 0, over: 0, under: 0, missPoints: 0, hist: new Array(7).fill(0), takeByBid: new Array(7).fill(0) });
  bidStats.set('Grok', { rounds: 0, bidSum: 0, takeSum: 0, exact: 0, over: 0, under: 0, missPoints: 0, hist: new Array(7).fill(0), takeByBid: new Array(7).fill(0) });

  let finished = 0;
  for (let match = 0; match < matches; match += 1) {
    const rotation = match % CONTESTANTS.length;
    const seating: Contestant[] = [];
    for (let seat = 0; seat < players; seat += 1) {
      seating.push(CONTESTANTS[(seat + rotation) % CONTESTANTS.length]);
    }
    const strategies = seating.map((contestant) => contestant.make());

    const engine = playMatch(strategies, players);
    if (engine.state !== GameState.MATCH_FINISHED) {
      console.error(`match ${match} did not finish (state=${engine.state})`);
      continue;
    }
    finished += 1;

    let bestScore = Number.NEGATIVE_INFINITY;
    let bestLabel = '';
    const idToLabel = new Map<string, string>();
    engine.players.forEach((player, index) => {
      const label = seating[index].label;
      idToLabel.set(player.id, label);
      totalScore.set(label, (totalScore.get(label) ?? 0) + player.score);
      if (player.score > bestScore) {
        bestScore = player.score;
        bestLabel = label;
      }
    });
    wins.set(bestLabel, (wins.get(bestLabel) ?? 0) + 1);

    for (const record of engine.scoreHistory) {
      for (const [playerId, delta] of Object.entries(record.scores)) {
        const label = idToLabel.get(playerId);
        if (!label) {
          continue;
        }
        const perType = byType.get(label)!;
        perType.set(record.roundType, (perType.get(record.roundType) ?? 0) + delta);
      }
      if (process.env.BID_DEBUG && record.roundType === process.env.BID_DEBUG) {
        for (const playerId of Object.keys(record.scores)) {
          const label = idToLabel.get(playerId);
          if (label !== 'Claude' && label !== 'Grok') {
            continue;
          }
          const bid = record.bids?.[playerId] ?? null;
          const take = record.tricks?.[playerId] ?? 0;
          if (bid === null) {
            continue;
          }
          const acc = bidStats.get(label)!;
          acc.rounds += 1;
          acc.bidSum += bid;
          acc.takeSum += take;
          acc.hist[Math.min(bid, 6)] += 1;
          acc.takeByBid[Math.min(bid, 6)] += take;
          if (take < bid) {
            acc.missPoints += -10 * bid;
          }
          if (take === bid) {
            acc.exact += 1;
          } else if (take > bid) {
            acc.over += 1;
          } else {
            acc.under += 1;
          }
        }
      }
    }
  }

  console.log(`\nFinished ${finished}/${matches} matches (${players} players)\n`);
  console.log('Strategy   Wins   WinRate   AvgScore');
  for (const contestant of CONTESTANTS) {
    const w = wins.get(contestant.label) ?? 0;
    const avg = (totalScore.get(contestant.label) ?? 0) / Math.max(1, finished);
    const rate = ((w / Math.max(1, finished)) * 100).toFixed(1);
    console.log(
      `${contestant.label.padEnd(9)} ${String(w).padStart(4)} ${rate.padStart(7)}% ${avg
        .toFixed(1)
        .padStart(9)}`,
    );
  }

  if (process.env.BID_DEBUG) {
    console.log(`\nBid stats for ${process.env.BID_DEBUG} rounds:`);
    console.log('Strategy   Rounds   AvgBid   AvgTake   Exact%   Over%   Under%');
    for (const label of ['Claude', 'Grok']) {
      const s = bidStats.get(label)!;
      const n = Math.max(1, s.rounds);
      console.log(
        `${label.padEnd(9)} ${String(s.rounds).padStart(6)} ${(s.bidSum / n).toFixed(2).padStart(8)} `
          + `${(s.takeSum / n).toFixed(2).padStart(9)} ${((s.exact / n) * 100).toFixed(1).padStart(7)} `
          + `${((s.over / n) * 100).toFixed(1).padStart(7)} ${((s.under / n) * 100).toFixed(1).padStart(7)}`,
      );
    }
    console.log('Strategy   MissPts   BidHist[0..6]');
    for (const label of ['Claude', 'Grok']) {
      const s = bidStats.get(label)!;
      console.log(`${label.padEnd(9)} ${String(s.missPoints).padStart(8)}   ${s.hist.join(' ')}`);
    }
    console.log('Strategy   AvgTakeByBid[0..6]');
    for (const label of ['Claude', 'Grok']) {
      const s = bidStats.get(label)!;
      const cells = s.takeByBid.map((sum, bid) => (s.hist[bid] > 0 ? (sum / s.hist[bid]).toFixed(2) : '-.--'));
      console.log(`${label.padEnd(9)} ${cells.join(' ')}`);
    }
  }

  const roundTypes = ['STANDARD', 'DARK', 'PERCENTS', 'NO_TRUMP', 'GOLD', 'MISER'];
  console.log('\nNet points per round type (total across matches):');
  console.log(`${'Strategy'.padEnd(9)}${roundTypes.map((type) => type.slice(0, 5).padStart(9)).join('')}`);
  for (const contestant of CONTESTANTS) {
    const perType = byType.get(contestant.label)!;
    const cells = roundTypes.map((type) => (perType.get(type) ?? 0).toFixed(0).padStart(9)).join('');
    console.log(`${contestant.label.padEnd(9)}${cells}`);
  }
}

main();
