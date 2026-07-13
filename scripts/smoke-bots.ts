/**
 * Smoke: create room → 3 distinct bots → short match → MATCH_FINISHED.
 * Exit 0 on success, 1 on failure/timeout.
 *
 * Usage: npx tsx scripts/smoke-bots.ts
 */
import { config, validateConfig, isLocal } from '../src/config/env';
import { runMigrations } from '../src/db/migrate';
import { connectRedis } from '../src/db/redis';
import { ensureLocalDevUser } from '../src/db/seedLocal';
import prisma from '../src/db/prisma';
import { roomManager } from '../src/network/RoomManager';
import { botHarness, BOT_PROFILES } from '../src/network/BotHarness';
import { GameState } from '../src/engine/GameEngine';

const TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  console.log('[smoke] APP_ENV=', config.appEnv);
  validateConfig();
  runMigrations();
  await prisma.$connect();
  await connectRedis();
  if (isLocal) {
    await ensureLocalDevUser();
  }

  const owner = await ensureLocalDevUser();
  const ownerId = owner?.id ?? 'smoke-owner';
  const ownerName = owner?.displayName ?? 'smoke';

  const room = roomManager.createRoom({
    id: `smoke-${Date.now()}`,
    name: 'Smoke Bots',
    ownerId,
    ownerName,
    maxPlayers: 3,
    hasLadder: true,
    hasMiser: false,
    isPrivate: true,
    isTraining: true,
  });

  console.log('[smoke] room', room.id);
  console.log(
    '[smoke] bots',
    BOT_PROFILES.map((b) => b.name).join(', '),
  );

  // Owner seat as bot host for auto-start
  botHarness.addBotToRoom(room.id, ownerId, ownerName, 'random');
  // Two more distinct profiles (skip if owner already random)
  botHarness.addBotToRoom(room.id, 'bot-tight', 'TightBot', 'tight');
  botHarness.addBotToRoom(room.id, 'bot-aggro', 'AggroBot', 'aggressive');

  const live = roomManager.getRoom(room.id);
  if (!live || live.engine.players.length !== 3) {
    throw new Error(`Expected 3 players, got ${live?.engine.players.length}`);
  }

  roomManager.handleAction(room.id, ownerId, {
    type: 'START_GAME',
    shortPlan: true,
    shortRounds: 2,
    settings: {
      playersCount: 3,
      hasLadder: true,
      hasMiser: false,
    },
  });

  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    const r = roomManager.getRoom(room.id);
    if (!r) {
      throw new Error('Room disappeared');
    }
    if (r.engine.state === GameState.MATCH_FINISHED) {
      console.log('[smoke] MATCH_FINISHED');
      console.log('[smoke] scores', r.engine.players.map((p) => `${p.name}:${p.score}`).join(' '));
      console.log('[smoke] ranking', JSON.stringify(r.engine.ranking));
      console.log('[smoke] timeouts', r.timeoutCount);
      console.log('[smoke] OK');
      await prisma.$disconnect();
      process.exit(0);
    }
    // Drive bot timeouts if needed
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const r = roomManager.getRoom(room.id);
  console.error('[smoke] TIMEOUT state=', r?.engine.state, 'version=', r?.stateVersion);
  process.exit(1);
}

main().catch((err) => {
  console.error('[smoke] fatal', err);
  process.exit(1);
});
