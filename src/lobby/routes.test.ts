import fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import lobbyRoutes from './routes';

async function createServer(): Promise<FastifyInstance> {
  const server = fastify();
  server.register(fastifyJwt, { secret: 'test-secret' });
  server.register(lobbyRoutes);
  await server.ready();
  return server;
}

describe('lobby routes', () => {
  it('lists rooms and creates a room (owner from auth, not body)', async () => {
    const server = await createServer();
    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/rooms',
    });
    expect(listResponse.statusCode).toBe(200);
    const rooms = JSON.parse(listResponse.body) as Array<{ id: string }>;
    expect(rooms.some((room) => room.id === 'test-room')).toBe(true);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: {
        name: 'Новая комната',
        maxPlayers: 4,
        hasLadder: true,
        hasMiser: false,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.body) as {
      room: {
        name: string;
        maxPlayers: number;
        ownerId: string;
      };
    };
    expect(created.room.name).toBe('Новая комната');
    expect(created.room.maxPlayers).toBe(4);
    expect(typeof created.room.ownerId).toBe('string');
    expect(created.room.ownerId.length).toBeGreaterThan(0);
    await server.close();
  });

  it('returns validation and conflict statuses', async () => {
    const server = await createServer();
    const invalidResponse = await server.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: {
        name: 'Некорректная',
        maxPlayers: 5,
        hasLadder: true,
        hasMiser: true,
      },
    });
    expect(invalidResponse.statusCode).toBe(400);

    const conflictResponse = await server.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: {
        id: 'test-room',
        name: 'Дубликат',
        maxPlayers: 3,
        hasLadder: true,
        hasMiser: true,
      },
    });
    expect(conflictResponse.statusCode).toBe(409);
    await server.close();
  });
});
