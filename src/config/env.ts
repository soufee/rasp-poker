import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root (works for tsx and compiled dist)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export type AppEnv = 'local' | 'production' | 'test';

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const rawAppEnv = (process.env.APP_ENV || process.env.NODE_ENV || 'local').toLowerCase();

/** local = developer machine; production = remote server; test = jest */
export const appEnv: AppEnv =
  rawAppEnv === 'production' || rawAppEnv === 'prod'
    ? 'production'
    : rawAppEnv === 'test'
      ? 'test'
      : 'local';

export const isLocal = appEnv === 'local';
export const isProduction = appEnv === 'production';
export const isTest = appEnv === 'test';

export const config = {
  appEnv,
  isLocal,
  isProduction,
  isTest,
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  jwtSecret: process.env.JWT_SECRET || '',
  /** Local-only fixed superuser identity */
  localDev: {
    email: process.env.LOCAL_DEV_EMAIL || 'dev@local',
    displayName: process.env.LOCAL_DEV_NAME || 'dev',
    password: process.env.LOCAL_DEV_PASSWORD || 'dev',
  },
};

/**
 * Validate env for the current mode.
 * - local: soft defaults allowed only for JWT if missing (dev convenience)
 * - production: fail hard on missing secrets (never commit real values)
 */
export function validateConfig(): void {
  if (isTest) {
    return;
  }

  required('DATABASE_URL', config.databaseUrl || process.env.DATABASE_URL);
  config.databaseUrl = process.env.DATABASE_URL!;

  required('REDIS_URL', config.redisUrl || process.env.REDIS_URL);
  config.redisUrl = process.env.REDIS_URL!;

  if (isProduction) {
    const secret = required('JWT_SECRET', process.env.JWT_SECRET);
    if (secret === 'super-secret-fallback-key' || secret.length < 16) {
      throw new Error('JWT_SECRET must be a strong secret in production (min 16 chars)');
    }
    config.jwtSecret = secret;
  } else {
    config.jwtSecret = process.env.JWT_SECRET || 'local-dev-only-jwt-secret';
  }
}
