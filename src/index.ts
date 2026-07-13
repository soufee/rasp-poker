import fastify from 'fastify';

const server = fastify({ logger: true });

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
