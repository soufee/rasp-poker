import type { IncomingRoomEvent, OutgoingRoomEvent, Session } from '../types/game';

type LocationSource = Pick<Location, 'host' | 'protocol'>;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function hasMessage(value: JsonRecord): value is JsonRecord & { message: string } {
  return typeof value.message === 'string';
}

export function createRoomSocketUrl(
  roomId: string,
  session: Session,
  source: LocationSource = window.location,
): string {
  const protocol = source.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({
    userId: session.user.id,
    userName: session.user.displayName,
  });

  if (session.token) {
    query.set('token', session.token);
  }

  return `${protocol}//${source.host}/ws/room/${encodeURIComponent(roomId)}?${query.toString()}`;
}

export function parseIncomingEvent(raw: string): IncomingRoomEvent | null {
  let value: unknown;

  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }

  if (value.type === 'STATE_UPDATE' && isRecord(value.payload)) {
    return value as unknown as IncomingRoomEvent;
  }

  if (value.type === 'ROOM_INFO' && isRecord(value.payload)) {
    return value as unknown as IncomingRoomEvent;
  }

  if (value.type === 'CHAT_HISTORY' && Array.isArray(value.payload)) {
    return value as unknown as IncomingRoomEvent;
  }

  if (value.type === 'CHAT_MESSAGE' && isRecord(value.payload)) {
    return value as unknown as IncomingRoomEvent;
  }

  if ((value.type === 'ACTION_REJECTED' || value.type === 'ERROR') && hasMessage(value)) {
    return value as IncomingRoomEvent;
  }

  return null;
}

export function serializeOutgoingEvent(event: OutgoingRoomEvent): string {
  return JSON.stringify(event);
}
