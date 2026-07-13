import { FastifyPluginAsync } from 'fastify';
import { authenticate, requireVerification, AuthUser } from '../auth/middleware';
import { isLocal } from '../config/env';
import {
  CreateRoomInput,
  PlayerLimit,
  RoomManagerError,
  roomManager,
} from '../network/RoomManager';
import { botManager } from '../network/bots/BotManager';

interface CreateRoomBody {
  id?: unknown;
  name?: unknown;
  maxPlayers?: unknown;
  hasLadder?: unknown;
  hasMiser?: unknown;
  isPrivate?: unknown;
  /** Training / bot-only table — unverified users allowed in production */
  isTraining?: unknown;
  /** Opponent bots to seat: strategy ids and/or the "random" token. */
  bots?: unknown;
}

interface CreateRoomRoute {
  Body: CreateRoomBody;
}

interface ParsedCreateRoom extends CreateRoomInput {
  isTraining: boolean;
  bots: string[];
}

function isRecord(value: unknown): value is CreateRoomBody {
  return typeof value === 'object' && value !== null;
}

function isPlayerLimit(value: unknown): value is PlayerLimit {
  return value === 3 || value === 4 || value === 6;
}

function parseBots(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function hasBots(body: CreateRoomBody | undefined): boolean {
  return parseBots(body?.bots).length > 0;
}

function parseCreateRoomBody(value: unknown, owner: AuthUser): ParsedCreateRoom | null {
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
    || (body.bots !== undefined && !Array.isArray(body.bots))
  ) {
    return null;
  }
  if (body.id !== undefined && typeof body.id !== 'string') {
    return null;
  }

  const bots = parseBots(body.bots);
  const withBots = bots.length > 0;

  return {
    id: body.id,
    name: body.name,
    maxPlayers: body.maxPlayers,
    hasLadder: body.hasLadder,
    hasMiser: body.hasMiser,
    // Bot tables are personal training tables — keep them out of the public list.
    isPrivate: withBots ? true : body.isPrivate,
    ownerId: owner.id,
    ownerName: owner.displayName || owner.email || 'Player',
    isTraining: body.isTraining === true || withBots,
    bots,
  };
}

export const lobbyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/rooms', async () => roomManager.listRooms());

  fastify.get('/api/bots', async () => ({ bots: await botManager.listAvailable() }));

  fastify.post<CreateRoomRoute>(
    '/api/rooms',
    {
      preHandler: [
        authenticate,
        async (request, reply) => {
          // Ranked (default) requires verification; training / bot tables skip
          const body = request.body as CreateRoomBody | undefined;
          const isTraining = body?.isTraining === true || hasBots(body);
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

      let room;
      try {
        room = roomManager.createRoom(input);
      } catch (error) {
        if (error instanceof RoomManagerError) {
          const statusCode = error.code === 'ROOM_ALREADY_EXISTS' ? 409 : 400;
          return reply.status(statusCode).send({ error: error.message });
        }
        throw error;
      }

      let seatedBots: Awaited<ReturnType<typeof botManager.addBots>> = [];
      if (input.bots.length > 0) {
        seatedBots = await seatRequestedBots(room.id, input.bots, room.maxPlayers);
      }

      return reply.status(201).send({
        room,
        isTraining: input.isTraining,
        rankedPlay: !input.isTraining,
        bots: seatedBots,
      });
    },
  );
};

/** Fill every non-owner seat with the requested bots, padding with random ones. */
async function seatRequestedBots(
  roomId: string,
  requested: string[],
  maxPlayers: number,
): Promise<Awaited<ReturnType<typeof botManager.addBots>>> {
  const freeSeats = Math.max(0, maxPlayers - 1);
  const filled = requested.slice(0, freeSeats);
  while (filled.length < freeSeats) {
    filled.push('random');
  }
  const strategyIds = await botManager.resolveBotIds(filled, freeSeats);
  return botManager.addBots(roomId, strategyIds);
}

export default lobbyRoutes;
