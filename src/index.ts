import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, validateConfig, isLocal, isProduction } from './config/env';
import { runMigrations } from './db/migrate';
import { connectRedis } from './db/redis';
import { ensureLocalDevUser } from './db/seedLocal';
import { verifyMailTransport } from './mail/transport';
import prisma from './db/prisma';
import fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import authRoutes from './auth/routes';
import lobbyRoutes from './lobby/routes';
import { socketRoutes } from './network/socketRoutes';

async function bootstrap() {
  console.log(`[boot] APP_ENV=${config.appEnv} (local=${isLocal}, production=${isProduction})`);

  validateConfig();

  // 1) Migrations on every start
  runMigrations();

  // 2) Verify Postgres
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
  console.log('[db] PostgreSQL connected');

  // 3) Verify Redis
  await connectRedis();
  console.log('[redis] Ready');

  // 4) SMTP (Yandex etc.) — console fallback if not configured in local
  await verifyMailTransport();

  // 5) Local superuser auto-seed
  if (isLocal) {
    await ensureLocalDevUser();
  }

  const server = fastify({ logger: true });

  server.register(fastifyJwt, {
    secret: config.jwtSecret,
  });

  server.register(fastifyWebsocket);
  server.register(authRoutes, { prefix: '/api/auth' });
  server.register(lobbyRoutes);
  server.register(socketRoutes);

  const clientDistPath = path.resolve(process.cwd(), 'client', 'dist');
  const hasClientBuild = existsSync(path.join(clientDistPath, 'index.html'));
  if (hasClientBuild) {
    server.register(fastifyStatic, {
      root: clientDistPath,
      prefix: '/',
      wildcard: true,
    });
    server.setNotFoundHandler((request, reply) => {
      const acceptsHtml = request.headers.accept?.includes('text/html') === true;
      const isApplicationRoute =
        !request.url.startsWith('/api/') && !request.url.startsWith('/ws/');
      if (request.method === 'GET' && acceptsHtml && isApplicationRoute) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  server.get('/ping', async () => ({
    status: 'ok',
    time: new Date().toISOString(),
    appEnv: config.appEnv,
  }));

  server.get('/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const redis = (await import('./db/redis')).getRedis();
      await redis.ping();
      return {
        status: 'ready',
        appEnv: config.appEnv,
        authRequired: isProduction,
        localAutoLogin: isLocal,
      };
    } catch (err) {
      reply.status(503);
      return { status: 'not_ready', error: String(err) };
    }
  });

  const port = config.port;
  await server.listen({ port, host: '0.0.0.0' });
  console.log(`[boot] Server listening on port ${port}`);
  if (isLocal) {
    console.log('[boot] Local mode: GET /api/auth/session → auto-login as superuser "dev"');
  }
}

bootstrap().catch((err) => {
  console.error('[boot] Fatal:', err);
  process.exit(1);
});
