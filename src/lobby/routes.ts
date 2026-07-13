import { FastifyPluginAsync } from 'fastify';
import { authenticate, requireVerification, AuthUser } from '../auth/middleware';
import { isLocal } from '../config/env';
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
  /** Training / bot-only table — unverified users allowed in production */
  isTraining?: unknown;
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

function parseCreateRoomBody(
  value: unknown,
  owner: AuthUser,
): (CreateRoomInput & { isTraining: boolean }) | null {
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
    || (body.isTraining !== undefined && typeof body.isTraining !== 'boolean')
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
    ownerId: owner.id,
    ownerName: owner.displayName || owner.email || 'Player',
    isTraining: body.isTraining === true,
  };
}

export const lobbyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/rooms', async () => roomManager.listRooms());

  fastify.post<CreateRoomRoute>(
    '/api/rooms',
    {
      preHandler: [
        authenticate,
        async (request, reply) => {
          // Ranked (default) requires verification; training skips
          const body = request.body as CreateRoomBody | undefined;
          const isTraining = body?.isTraining === true;
          if (!isTraining && !isLocal) {
            await requireVerification(request, reply);
          }
        },
      ],
    },
    async (request, reply) => {
      if (reply.sent) {
        return;
      }
      const user = request.user as AuthUser;
      const input = parseCreateRoomBody(request.body, user);
      if (!input) {
        return reply.status(400).send({
          error: 'Укажите название, настройки и количество игроков 3, 4 или 6.',
        });
      }

      try {
        const room = roomManager.createRoom(input);
        return reply.status(201).send({
          room,
          isTraining: input.isTraining,
          rankedPlay: !input.isTraining,
        });
      } catch (error) {
        if (error instanceof RoomManagerError) {
          const statusCode = error.code === 'ROOM_ALREADY_EXISTS' ? 409 : 400;
          return reply.status(statusCode).send({ error: error.message });
        }
        throw error;
      }
    },
  );
};

export default lobbyRoutes;
