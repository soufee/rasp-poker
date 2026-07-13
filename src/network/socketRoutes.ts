import { FastifyInstance } from 'fastify';
import { isLocal } from '../config/env';
import { getLocalDevUser } from '../db/seedLocal';
import { roomManager } from './RoomManager';

interface RoomSocketRoute {
  Params: {
    roomId: string;
  };
  Querystring: {
    token?: string;
  };
}

interface TokenPayload {
  id?: unknown;
  sub?: unknown;
  displayName?: unknown;
  name?: unknown;
  email?: unknown;
  tokenVersion?: unknown;
}

interface SocketIdentity {
  userId: string;
  userName: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : null;
}

function getTokenIdentity(
  fastify: FastifyInstance,
  token: string | undefined,
): SocketIdentity | null {
  if (!token || !fastify.hasDecorator('jwt')) {
    return null;
  }

  try {
    const payload = fastify.jwt.verify<TokenPayload>(token);
    if (!isRecord(payload)) {
      return null;
    }

    const userId = getNonEmptyString(payload.id) ?? getNonEmptyString(payload.sub);
    if (!userId) {
      return null;
    }
    const userName =
      getNonEmptyString(payload.displayName)
      ?? getNonEmptyString(payload.name)
      ?? getNonEmptyString(payload.email)
      ?? `Игрок ${userId.slice(0, 6)}`;
    return { userId, userName };
  } catch {
    return null;
  }
}

/**
 * Resolve identity for WS join.
 * - Production: JWT required (userId only from token — no query spoof)
 * - Local: JWT preferred; else auto local superuser `dev`
 */
async function resolveIdentity(
  fastify: FastifyInstance,
  query: RoomSocketRoute['Querystring'],
): Promise<SocketIdentity | null> {
  const tokenIdentity = getTokenIdentity(fastify, query.token);
  if (tokenIdentity) {
    return tokenIdentity;
  }

  if (isLocal) {
    const dev = await getLocalDevUser();
    if (dev) {
      return { userId: dev.id, userName: dev.displayName };
    }
  }

  return null;
}

export async function socketRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<RoomSocketRoute>('/ws/room/:roomId', { websocket: true }, async (socket, request) => {
    const identity = await resolveIdentity(fastify, request.query);
    if (!identity) {
      socket.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'Unauthorized: valid JWT token required (?token=...)',
          code: 'WS_UNAUTHORIZED',
        }),
      );
      socket.close();
      return;
    }

    const joined = roomManager.joinRoom(
      request.params.roomId,
      identity.userId,
      identity.userName,
      socket,
      { isBot: false },
    );
    if (!joined) {
      socket.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'Не удалось войти: комната не найдена, заполнена или игра уже началась.',
          code: 'JOIN_FAILED',
        }),
      );
      socket.close();
    }
  });
}
