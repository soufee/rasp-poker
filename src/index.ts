import fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import authRoutes from './auth/routes';

const server = fastify({ logger: true });

server.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'super-secret-fallback-key'
});

server.register(authRoutes, { prefix: '/auth' });

server.get('/ping', async (request, reply) => {
  return { status: 'ok', time: new Date().toISOString() };
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Server is listening on port ${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
