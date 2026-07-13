import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createRoomSocketUrl,
  parseIncomingEvent,
  serializeOutgoingEvent,
} from '../services/roomSocket';
import type {
  ChatMessage,
  ConnectionStatus,
  GameSnapshot,
  OutgoingRoomEvent,
  RoomInfo,
  Session,
} from '../types/game';

interface UseRoomSocketResult {
  connectionStatus: ConnectionStatus;
  game: GameSnapshot | null;
  roomInfo: RoomInfo | null;
  chatMessages: ChatMessage[];
  notice: string | null;
  serverError: string | null;
  send: (event: OutgoingRoomEvent) => boolean;
  reconnect: () => void;
  clearNotice: () => void;
}

export function useRoomSocket(roomId: string, session: Session): UseRoomSocketResult {
  const socketRef = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [game, setGame] = useState<GameSnapshot | null>(null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [connectionGeneration, setConnectionGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let fatalErrorReceived = false;
    let reconnectTimer: number | null = null;
    let attempt = 0;

    const connect = (): void => {
      if (cancelled) {
        return;
      }

      setConnectionStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      const socket = new WebSocket(createRoomSocketUrl(roomId, session));
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (cancelled) {
          socket.close();
          return;
        }

        attempt = 0;
        setServerError(null);
        setConnectionStatus('connected');
      });

      socket.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') {
          return;
        }

        const event = parseIncomingEvent(message.data);

        if (!event) {
          setNotice('Получено неизвестное сообщение сервера');
          return;
        }

        if (event.type === 'STATE_UPDATE') {
          setGame(event.payload);
          return;
        }

        if (event.type === 'ROOM_INFO') {
          setRoomInfo(event.payload);
          return;
        }

        if (event.type === 'CHAT_HISTORY') {
          setChatMessages(event.payload);
          return;
        }

        if (event.type === 'CHAT_MESSAGE') {
          setChatMessages((current) => {
            if (current.some((item) => item.id === event.payload.id)) {
              return current;
            }

            return [...current, event.payload];
          });
          return;
        }

        if (event.type === 'ACTION_REJECTED') {
          setNotice(event.message);
          return;
        }

        fatalErrorReceived = true;
        setServerError(event.message);
        setNotice(event.message);
      });

      socket.addEventListener('error', () => {
        if (!cancelled) {
          setConnectionStatus('error');
        }
      });

      socket.addEventListener('close', () => {
        if (cancelled) {
          return;
        }

        if (fatalErrorReceived) {
          setConnectionStatus('disconnected');
          return;
        }

        attempt += 1;

        if (attempt > 6) {
          setConnectionStatus('disconnected');
          setServerError('Не удалось восстановить соединение с комнатой');
          return;
        }

        const delay = Math.min(750 * 2 ** (attempt - 1), 8_000);
        setConnectionStatus('reconnecting');
        reconnectTimer = window.setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      cancelled = true;

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }

      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connectionGeneration, roomId, session]);

  const send = useCallback((event: OutgoingRoomEvent): boolean => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNotice('Нет соединения. Дождитесь переподключения');
      return false;
    }

    socket.send(serializeOutgoingEvent(event));

    return true;
  }, []);

  const reconnect = useCallback(() => {
    setServerError(null);
    setConnectionGeneration((current) => current + 1);
  }, []);

  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);

  return {
    chatMessages,
    clearNotice,
    connectionStatus,
    game,
    notice,
    reconnect,
    roomInfo,
    send,
    serverError,
  };
}
