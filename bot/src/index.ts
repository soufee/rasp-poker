/**
 * Network bot entrypoint (issue #22).
 *
 * Composer (default):
 *   npx tsx src/index.ts --room <roomId> --strategy composer
 *
 * Grok:
 *   npx tsx src/index.ts --room <roomId> --strategy grok --userName Grok
 *
 * Smoke:
 *   npx tsx src/index.ts --smoke --strategy composer
 */
import { parseConfig } from './config';
import { BotClient } from './core/BotClient';
import { ComposerStrategy } from './strategy/ComposerStrategy';
import { GlmStrategy } from './strategy/GlmStrategy';
import { GrokStrategy } from './strategy/GrokStrategy';
import { RandomStrategy } from './strategy/RandomStrategy';
import { SolarisStrategy } from './strategy/SolarisStrategy';
import type { Strategy } from './strategy/Strategy';

function makeStrategy(name: 'solaris' | 'grok' | 'composer' | 'random' | 'glm'): Strategy {
  if (name === 'solaris') {
    return new SolarisStrategy();
  }
  if (name === 'random') {
    return new RandomStrategy();
  }
  if (name === 'grok') {
    return new GrokStrategy();
  }
  if (name === 'glm') {
    return new GlmStrategy();
  }
  return new ComposerStrategy();
}

function botLabel(name: 'solaris' | 'grok' | 'composer' | 'random' | 'glm'): string {
  if (name === 'solaris') {
    return 'Solaris';
  }
  if (name === 'grok') {
    return 'Grok';
  }
  if (name === 'composer') {
    return 'Composer';
  }
  if (name === 'glm') {
    return 'GLM';
  }
  return 'RandomBot';
}

async function createRoom(
  host: string,
  players: 3 | 4 | 6,
  ownerName: string,
): Promise<{ roomId: string; token?: string; ownerId: string }> {
  // Local auto-login for host identity
  const sessionRes = await fetch(`${host.replace(/\/$/, '')}/api/auth/session`);
  let token: string | undefined;
  let ownerId = `host-grok-${Date.now()}`;
  if (sessionRes.ok) {
    const session = (await sessionRes.json()) as {
      token?: string;
      user?: { id?: string; displayName?: string };
    };
    token = session.token;
    if (session.user?.id) {
      ownerId = session.user.id;
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${host.replace(/\/$/, '')}/api/rooms`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `${ownerName} Arena ${new Date().toISOString().slice(11, 19)}`,
      maxPlayers: players,
      hasLadder: true,
      hasMiser: true,
      isPrivate: true,
      isTraining: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`create room failed ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { room: { id: string; ownerId: string } };
  return {
    roomId: body.room.id,
    token,
    ownerId: body.room.ownerId || ownerId,
  };
}

async function main(): Promise<void> {
  const cfg = parseConfig();
  const clients: BotClient[] = [];

  if (cfg.smoke) {
    process.env.BOT_SHORT_PLAN = process.env.BOT_SHORT_PLAN || '1';
    const label = botLabel(cfg.strategy);
    const { roomId, token, ownerId } = await createRoom(cfg.host, cfg.players, label);
    console.log(`[smoke] room=${roomId} host=${ownerId} strategy=${cfg.strategy}`);

    const hostClient = new BotClient({
      host: cfg.host,
      roomId,
      userId: ownerId,
      userName: label,
      strategy: makeStrategy(cfg.strategy),
      thinkDelayMs: cfg.thinkDelayMs,
    });
    clients.push(hostClient);
    await hostClient.start();
    void token; // used only for authenticated room create

    // Fill seats with random bots (weaker opponents)
    for (let i = 1; i < cfg.players; i += 1) {
      const id = `filler-${i}-${Date.now()}`;
      const client = new BotClient({
        host: cfg.host,
        roomId,
        userId: id,
        userName: `Filler${i}`,
        strategy: new RandomStrategy(),
        thinkDelayMs: 20,
      });
      clients.push(client);
      await client.start();
    }

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (clients.every((c) => c.isFinished()) || hostClient.isFinished()) {
        console.log('[smoke] finished');
        clients.forEach((c) => c.stop());
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    console.error('[smoke] timeout');
    clients.forEach((c) => c.stop());
    process.exit(1);
  }

  // Single bot join
  const client = new BotClient({
    host: cfg.host,
    roomId: cfg.roomId,
    userId: cfg.userId,
    userName: cfg.userName,
    token: cfg.token,
    strategy: makeStrategy(cfg.strategy),
    thinkDelayMs: cfg.thinkDelayMs,
  });
  await client.start();
  console.log(`Bot joined room ${cfg.roomId} as ${cfg.userName} (${cfg.strategy})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
