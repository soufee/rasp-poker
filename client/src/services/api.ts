import type {
  BotStrength,
  BotSummary,
  RoomSettings,
  RoomSummary,
  Session,
  SessionUser,
} from '../types/game';

interface RegisterInput {
  displayName: string;
  email: string;
  password: string;
}

interface LoginInput {
  email: string;
  password: string;
}

interface CreateRoomInput extends RoomSettings {
  name: string;
  isPrivate: boolean;
  /** Strategy ids and/or the "random" token to seat as opponents. */
  bots?: string[];
}

interface MessageResponse {
  message: string;
}

type JsonRecord = Record<string, unknown>;

export class ApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function getString(record: JsonRecord, key: string, fallback = ''): string {
  const value = record[key];

  return typeof value === 'string' ? value : fallback;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');

  if (!contentType?.includes('application/json')) {
    return null;
  }

  return response.json() as Promise<unknown>;
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');

  if (options.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;

  try {
    response = await fetch(path, {
      ...options,
      headers,
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }

    throw new ApiError('Не удалось связаться с сервером', 0);
  }

  const data = await readJson(response);

  if (!response.ok) {
    const message = isRecord(data)
      ? getString(data, 'error', getString(data, 'message', 'Ошибка запроса'))
      : `Сервер ответил с кодом ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return data as T;
}

function normalizeUser(value: unknown): SessionUser {
  if (!isRecord(value)) {
    throw new ApiError('Сервер вернул некорректный профиль', 500);
  }

  const id = getString(value, 'id');
  const email = getString(value, 'email');
  const displayName = getString(value, 'displayName', email.split('@')[0] ?? 'Игрок');

  if (!id) {
    throw new ApiError('В профиле отсутствует идентификатор', 500);
  }

  return {
    id,
    email: email || undefined,
    displayName,
    role: getString(value, 'role') || undefined,
    verified: value.verified === true,
    ratingPoints: typeof value.ratingPoints === 'number' ? value.ratingPoints : 0,
    gamesPlayed: typeof value.gamesPlayed === 'number' ? value.gamesPlayed : 0,
    gamesWon: typeof value.gamesWon === 'number' ? value.gamesWon : 0,
  };
}

function normalizeSession(value: unknown, existingToken?: string): Session {
  if (!isRecord(value)) {
    throw new ApiError('Сервер вернул некорректную сессию', 500);
  }

  const token = getString(value, 'token', existingToken ?? '');

  return {
    token: token || undefined,
    user: normalizeUser(value.user),
  };
}

function asPlayerLimit(value: unknown): 3 | 4 | 6 {
  if (value === 4 || value === 6) {
    return value;
  }

  return 3;
}

function normalizeRoomSettings(value: unknown): RoomSettings | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    hasLadder: value.hasLadder === true,
    hasMiser: value.hasMiser === true,
    playersCount: asPlayerLimit(value.playersCount),
  };
}

export function normalizeRoom(value: unknown): RoomSummary {
  if (!isRecord(value)) {
    throw new ApiError('Получены некорректные данные комнаты', 500);
  }

  const id = getString(value, 'id', getString(value, 'roomId'));
  const rawStatus = getString(value, 'status', 'waiting').toLowerCase();
  const status = rawStatus === 'playing' || rawStatus === 'finished' ? rawStatus : 'waiting';

  if (!id) {
    throw new ApiError('У комнаты отсутствует идентификатор', 500);
  }

  return {
    id,
    name: getString(value, 'name', `Стол ${id.slice(0, 6)}`),
    playersCount:
      typeof value.playersCount === 'number'
        ? value.playersCount
        : Array.isArray(value.players)
          ? value.players.length
          : 0,
    maxPlayers: asPlayerLimit(value.maxPlayers),
    isPrivate: value.isPrivate === true,
    status,
    ownerName: getString(value, 'ownerName') || undefined,
    settings: normalizeRoomSettings(value.settings),
  };
}

export const authApi = {
  async bootstrap(token?: string): Promise<Session> {
    const data = await request<unknown>(
      '/api/auth/session',
      {
        method: 'GET',
      },
      token,
    );

    return normalizeSession(data, token);
  },

  async login(input: LoginInput): Promise<Session> {
    const data = await request<unknown>('/api/auth/login', {
      body: JSON.stringify(input),
      method: 'POST',
    });

    return normalizeSession(data);
  },

  async register(input: RegisterInput): Promise<MessageResponse> {
    return request<MessageResponse>('/api/auth/register', {
      body: JSON.stringify(input),
      method: 'POST',
    });
  },

  async forgotPassword(email: string): Promise<MessageResponse> {
    return request<MessageResponse>('/api/auth/forgot-password', {
      body: JSON.stringify({ email }),
      method: 'POST',
    });
  },

  async resetPassword(token: string, newPassword: string): Promise<MessageResponse> {
    return request<MessageResponse>('/api/auth/reset-password', {
      body: JSON.stringify({ newPassword, token }),
      method: 'POST',
    });
  },

  async verifyEmail(token: string): Promise<MessageResponse> {
    const query = new URLSearchParams({ token });

    return request<MessageResponse>(`/api/auth/verify?${query.toString()}`, {
      method: 'GET',
    });
  },
};

function normalizeBot(value: unknown): BotSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value, 'id');
  if (!id) {
    return null;
  }
  const rawStrength = getString(value, 'strength', 'medium');
  const strength: BotStrength =
    rawStrength === 'strong' || rawStrength === 'basic' ? rawStrength : 'medium';

  return {
    id,
    label: getString(value, 'label', id),
    description: getString(value, 'description'),
    strength,
  };
}

export const botsApi = {
  async list(token?: string, signal?: AbortSignal): Promise<BotSummary[]> {
    const data = await request<unknown>('/api/bots', { method: 'GET', signal }, token);
    const bots = isRecord(data) && Array.isArray(data.bots) ? data.bots : [];

    return bots.map(normalizeBot).filter((bot): bot is BotSummary => bot !== null);
  },
};

export const roomsApi = {
  async list(token?: string, signal?: AbortSignal): Promise<RoomSummary[]> {
    const data = await request<unknown>(
      '/api/rooms',
      {
        method: 'GET',
        signal,
      },
      token,
    );
    const rooms = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.rooms)
        ? data.rooms
        : [];

    return rooms.map(normalizeRoom);
  },

  async create(input: CreateRoomInput, session: Session): Promise<RoomSummary> {
    const hasBots = Array.isArray(input.bots) && input.bots.length > 0;
    const data = await request<unknown>(
      '/api/rooms',
      {
        body: JSON.stringify({
          hasLadder: input.hasLadder,
          hasMiser: input.hasMiser,
          isPrivate: input.isPrivate,
          maxPlayers: input.playersCount,
          name: input.name,
          ownerId: session.user.id,
          ownerName: session.user.displayName,
          ...(hasBots ? { bots: input.bots } : {}),
        }),
        method: 'POST',
      },
      session.token,
    );
    const room = isRecord(data) && data.room ? data.room : data;

    return normalizeRoom(room);
  },
};
