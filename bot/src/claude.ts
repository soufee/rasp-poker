/**
 * Claude bot runner (standalone, does not touch the shared framework entrypoint).
 *
 * Join a human/host room:
 *   npx tsx bot/src/claude.ts --room <roomId> --bots 1
 *
 * Bot-vs-bot arena (create a table, Claude hosts, fill with opponents):
 *   npx tsx bot/src/claude.ts --arena --players 4 --opponents grok
 *
 * Opponents: claude | grok | random | mix (default mix)
 */
import { ClaudeDriver } from './core/ClaudeDriver';
import { signBotToken } from './auth/token';
import { ClaudeStrategy } from './strategy/ClaudeStrategy';
import { GlmStrategy } from './strategy/GlmStrategy';
import { GrokStrategy } from './strategy/GrokStrategy';
import { RandomStrategy } from './strategy/RandomStrategy';
import type { Strategy } from './strategy/Strategy';
import type { GameStatePayload } from './protocol/types';

type PlayerCount = 3 | 4 | 6;
type Opponents = 'claude' | 'grok' | 'glm' | 'random' | 'mix';

interface ClaudeConfig {
  host: string;
  secret: string;
  arena: boolean;
  roomId: string;
  players: PlayerCount;
  bots: number;
  opponents: Opponents;
  delayMs: number;
  name: string;
  short: boolean;
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }
  return undefined;
}

function parseConfig(argv: string[]): ClaudeConfig {
  const args = argv.slice(2);
  const roomId = argValue(args, '--room') ?? '';
  const arena = args.includes('--arena') || roomId === '';
  const playersRaw = Number(argValue(args, '--players') ?? 4);
  const players: PlayerCount = playersRaw === 3 || playersRaw === 6 ? playersRaw : 4;
  const opponentsRaw = (argValue(args, '--opponents') ?? 'mix') as Opponents;

  return {
    host: argValue(args, '--host') ?? process.env.BOT_HOST ?? 'http://127.0.0.1:3000',
    secret: argValue(args, '--secret') ?? process.env.JWT_SECRET ?? 'local-dev-only-jwt-secret',
    arena,
    roomId,
    players,
    bots: Number(argValue(args, '--bots') ?? 1),
    opponents: ['claude', 'grok', 'glm', 'random', 'mix'].includes(opponentsRaw) ? opponentsRaw : 'mix',
    delayMs: Number(argValue(args, '--delay') ?? 200),
    name: argValue(args, '--name') ?? 'Claude',
    short: args.includes('--short'),
  };
}

function makeOpponent(kind: Opponents, index: number): { strategy: Strategy; label: string } {
  if (kind === 'grok') {
    return { strategy: new GrokStrategy(), label: 'Grok' };
  }
  if (kind === 'random') {
    return { strategy: new RandomStrategy(), label: 'Random' };
  }
  if (kind === 'claude') {
    return { strategy: new ClaudeStrategy(), label: 'Claude' };
  }
  if (kind === 'glm') {
    return { strategy: new GlmStrategy(), label: 'GLM' };
  }
  const pool: Array<{ strategy: Strategy; label: string }> = [
    { strategy: new GrokStrategy(), label: 'Grok' },
    { strategy: new GlmStrategy(), label: 'GLM' },
    { strategy: new ClaudeStrategy(), label: 'Claude' },
    { strategy: new RandomStrategy(), label: 'Random' },
  ];
  return pool[index % pool.length];
}

async function createRoom(
  host: string,
  token: string,
  players: PlayerCount,
): Promise<string> {
  const response = await fetch(`${host.replace(/\/$/, '')}/api/rooms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: `Claude Arena ${new Date().toISOString().slice(11, 19)}`,
      maxPlayers: players,
      hasLadder: true,
      hasMiser: true,
      isPrivate: true,
      isTraining: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`create room failed ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { room: { id: string } };
  return body.room.id;
}

function printScoreboard(state: GameStatePayload): void {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  console.log('\n=== MATCH FINISHED ===');
  sorted.forEach((player, place) => {
    console.log(`  #${place + 1}  ${String(player.score).padStart(5)}  ${player.name}`);
  });
  console.log('======================\n');
}

async function runArena(config: ClaudeConfig): Promise<void> {
  const runTag = Date.now().toString(36);
  const hostId = `claude-${runTag}-1`;
  const hostToken = signBotToken(config.secret, { id: hostId, displayName: config.name });
  const roomId = await createRoom(config.host, hostToken, config.players);
  console.log(`[arena] room=${roomId} players=${config.players} opponents=${config.opponents}`);

  const clients: ClaudeDriver[] = [];
  let reported = false;

  clients.push(
    new ClaudeDriver({
      host: config.host,
      roomId,
      userId: hostId,
      userName: config.name,
      token: hostToken,
      strategy: new ClaudeStrategy(),
      thinkDelayMs: config.delayMs,
      shortPlan: config.short,
    }),
  );

  for (let seat = 1; seat < config.players; seat += 1) {
    const opponent = makeOpponent(config.opponents, seat - 1);
    const id = `${opponent.label.toLowerCase()}-${runTag}-${seat + 1}`;
    const token = signBotToken(config.secret, { id, displayName: `${opponent.label} ${seat}` });
    clients.push(
      new ClaudeDriver({
        host: config.host,
        roomId,
        userId: id,
        userName: `${opponent.label} ${seat}`,
        token,
        strategy: opponent.strategy,
        thinkDelayMs: config.delayMs,
        shortPlan: config.short,
      }),
    );
  }

  for (const client of clients) {
    await client.start();
  }

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const finishedClient = clients.find((client) => client.isFinished());
    if (finishedClient) {
      if (!reported) {
        reported = true;
        const finalState = finishedClient.lastState();
        if (finalState) {
          printScoreboard(finalState);
        }
      }
      clients.forEach((client) => client.stop());
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.error('[arena] timeout');
  clients.forEach((client) => client.stop());
  process.exit(1);
}

async function runJoin(config: ClaudeConfig): Promise<void> {
  const runTag = Date.now().toString(36);
  const clients: ClaudeDriver[] = [];
  for (let index = 0; index < config.bots; index += 1) {
    const name = config.bots === 1 ? config.name : `${config.name} ${index + 1}`;
    const id = `claude-${runTag}-${index + 1}`;
    const token = signBotToken(config.secret, { id, displayName: name });
    const client = new ClaudeDriver({
      host: config.host,
      roomId: config.roomId,
      userId: id,
      userName: name,
      token,
      strategy: new ClaudeStrategy(),
      thinkDelayMs: config.delayMs,
      shortPlan: config.short,
    });
    clients.push(client);
    await client.start();
    console.log(`[join] ${name} joined room ${config.roomId}`);
  }

  const shutdown = (): void => {
    clients.forEach((client) => client.stop());
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv);
  if (config.arena) {
    await runArena(config);
  } else {
    await runJoin(config);
  }
}

main().catch((error) => {
  console.error('[claude] fatal', error);
  process.exit(1);
});
