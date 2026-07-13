import Redis from 'ioredis';
import { config } from '../config/env';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    const url = config.redisUrl || process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL is not set');
    }
    redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    redis.on('error', (err: Error) => {
      console.error('[redis] Client error:', err.message);
    });

    redis.on('connect', () => {
      console.log('[redis] Connected');
    });
  }
  return redis;
}

export async function connectRedis(): Promise<Redis> {
  const client = getRedis();
  await client.ping();
  return client;
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
