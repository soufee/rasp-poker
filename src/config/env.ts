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

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
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

const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 465;

export const config = {
  appEnv,
  isLocal,
  isProduction,
  isTest,
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  jwtSecret: process.env.JWT_SECRET || '',
  /** Local-only fixed superuser identity */
  localDev: {
    email: process.env.LOCAL_DEV_EMAIL || 'dev@local',
    displayName: process.env.LOCAL_DEV_NAME || 'dev',
    password: process.env.LOCAL_DEV_PASSWORD || 'dev',
  },
  /**
   * Yandex / generic SMTP (Spring-compatible mapping):
   * spring.mail.host     → SMTP_HOST
   * spring.mail.port     → SMTP_PORT
   * spring.mail.username → SMTP_USER
   * spring.mail.password → SMTP_PASSWORD  (plain app password, NOT Spring ENC(...))
   * spring.mail.protocol=smtps + 465 → SMTP_SECURE=true
   */
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number.isFinite(smtpPort) ? smtpPort : 465,
    secure: envBool('SMTP_SECURE', true),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from:
      process.env.SMTP_FROM
      || (process.env.SMTP_USER
        ? `Расписной покер <${process.env.SMTP_USER}>`
        : 'Расписной покер <noreply@localhost>'),
    debug: envBool('MAIL_DEBUG', false),
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

    required('SMTP_HOST', process.env.SMTP_HOST);
    required('SMTP_USER', process.env.SMTP_USER);
    required('SMTP_PASSWORD', process.env.SMTP_PASSWORD);
    if (process.env.SMTP_PASSWORD?.startsWith('ENC(')) {
      throw new Error(
        'SMTP_PASSWORD looks like a Spring ENC(...) value. Put the decrypted plain SMTP/app password in .env (never commit it).',
      );
    }
    config.smtp.host = process.env.SMTP_HOST!;
    config.smtp.user = process.env.SMTP_USER!;
    config.smtp.password = process.env.SMTP_PASSWORD!;
  } else {
    config.jwtSecret = process.env.JWT_SECRET || 'local-dev-only-jwt-secret';
    if (process.env.SMTP_PASSWORD?.startsWith('ENC(')) {
      console.warn(
        '[config] SMTP_PASSWORD is Spring ENC(...). Nodemailer needs the plain password — email will stay on console until fixed.',
      );
      config.smtp.password = '';
    }
  }
}
