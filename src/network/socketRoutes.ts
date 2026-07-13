import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { roomManager } from './RoomManager';

interface RoomSocketRoute {
  Params: {
    roomId: string;
  };
  Querystring: {
    token?: string;
    userId?: string;
    userName?: string;
  };
}

interface TokenPayload {
  id?: unknown;
  sub?: unknown;
  displayName?: unknown;
  name?: unknown;
  email?: unknown;
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

function getSocketIdentity(
  fastify: FastifyInstance,
  query: RoomSocketRoute['Querystring'],
): SocketIdentity {
  const tokenIdentity = getTokenIdentity(fastify, query.token);
  if (tokenIdentity) {
    return tokenIdentity;
  }

  const userId = getNonEmptyString(query.userId) ?? `guest-${randomUUID()}`;
  const userName = getNonEmptyString(query.userName) ?? `Гость ${userId.slice(0, 6)}`;
  return { userId, userName };
}

export async function socketRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<RoomSocketRoute>('/ws/room/:roomId', { websocket: true }, (socket, request) => {
    const identity = getSocketIdentity(fastify, request.query);
    const joined = roomManager.joinRoom(
      request.params.roomId,
      identity.userId,
      identity.userName,
      socket,
    );
    if (!joined) {
      socket.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'Не удалось войти: комната не найдена, заполнена или игра уже началась.',
        }),
      );
      socket.close();
    }
  });
}
