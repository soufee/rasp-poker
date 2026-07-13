import { FastifyPluginAsync } from 'fastify';
import {
  CreateRoomInput,
  PlayerLimit,
  RoomManagerError,
  roomManager,
} from '../network/RoomManager';

interface CreateRoomBody {
  id?: unknown;
  name?: unknown;
  maxPlayers?: unknown;
  hasLadder?: unknown;
  hasMiser?: unknown;
  isPrivate?: unknown;
  ownerId?: unknown;
  ownerName?: unknown;
}

interface CreateRoomRoute {
  Body: CreateRoomBody;
}

function isRecord(value: unknown): value is CreateRoomBody {
  return typeof value === 'object' && value !== null;
}

function isPlayerLimit(value: unknown): value is PlayerLimit {
  return value === 3 || value === 4 || value === 6;
}

function parseCreateRoomInput(value: unknown): CreateRoomInput | null {
  if (!isRecord(value)) {
    return null;
  }
  const body = value;
  if (
    typeof body.name !== 'string'
    || !isPlayerLimit(body.maxPlayers)
    || typeof body.hasLadder !== 'boolean'
    || typeof body.hasMiser !== 'boolean'
    || (body.isPrivate !== undefined && typeof body.isPrivate !== 'boolean')
    || typeof body.ownerId !== 'string'
    || typeof body.ownerName !== 'string'
  ) {
    return null;
  }
  if (body.id !== undefined && typeof body.id !== 'string') {
    return null;
  }

  return {
    id: body.id,
    name: body.name,
    maxPlayers: body.maxPlayers,
    hasLadder: body.hasLadder,
    hasMiser: body.hasMiser,
    isPrivate: body.isPrivate,
    ownerId: body.ownerId,
    ownerName: body.ownerName,
  };
}

export const lobbyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/rooms', async () => roomManager.listRooms());

  fastify.post<CreateRoomRoute>('/api/rooms', async (request, reply) => {
    const input = parseCreateRoomInput(request.body);
    if (!input) {
      return reply.status(400).send({
        error: 'Укажите название, владельца, настройки и количество игроков 3, 4 или 6.',
      });
    }

    try {
      const room = roomManager.createRoom(input);
      return reply.status(201).send({ room });
    } catch (error) {
      if (error instanceof RoomManagerError) {
        const statusCode = error.code === 'ROOM_ALREADY_EXISTS' ? 409 : 400;
        return reply.status(statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
};

export default lobbyRoutes;
