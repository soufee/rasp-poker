import WebSocket from 'ws';
import type { GameStatePayload, IncomingMessage, OutgoingAction } from '../protocol/types';

export type ConnectionEventMap = {
  state: (s: GameStatePayload) => void;
  chat: (m: unknown) => void;
  rejected: (reason: string) => void;
  error: (info: unknown) => void;
  close: (info: unknown) => void;
  open: () => void;
};

type Handler<K extends keyof ConnectionEventMap> = ConnectionEventMap[K];

export interface RoomConnectionOptions {
  host: string;
  roomId: string;
  userId: string;
  userName: string;
  token?: string;
  /** Auto reconnect with same userId */
  reconnect?: boolean;
  reconnectDelayMs?: number;
}

export class RoomConnection {
  private socket: WebSocket | null = null;
  private readonly handlers: { [K in keyof ConnectionEventMap]: Set<Handler<K>> } = {
    state: new Set(),
    chat: new Set(),
    rejected: new Set(),
    error: new Set(),
    close: new Set(),
    open: new Set(),
  };
  private closedByUser = false;
  private readonly opts: Required<Pick<RoomConnectionOptions, 'reconnect' | 'reconnectDelayMs'>>
    & RoomConnectionOptions;

  public constructor(options: RoomConnectionOptions) {
    this.opts = {
      reconnect: true,
      reconnectDelayMs: 800,
      ...options,
    };
  }

  public get url(): string {
    const base = this.opts.host.replace(/\/$/, '').replace(/^http/, 'ws');
    const query = new URLSearchParams({
      userId: this.opts.userId,
      userName: this.opts.userName,
    });
    if (this.opts.token) {
      query.set('token', this.opts.token);
    }
    return `${base}/ws/room/${encodeURIComponent(this.opts.roomId)}?${query.toString()}`;
  }

  public connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      const onOpen = () => {
        this.emit('open');
        resolve();
      };
      const onError = (err: Error) => {
        this.emit('error', err);
        reject(err);
      };

      socket.once('open', onOpen);
      socket.once('error', onError);

      socket.on('message', (data) => {
        this.handleRaw(data.toString());
      });

      socket.on('close', (code, reason) => {
        this.emit('close', { code, reason: reason.toString() });
        this.socket = null;
        if (!this.closedByUser && this.opts.reconnect) {
          setTimeout(() => {
            if (!this.closedByUser) {
              void this.connect().catch((err) => this.emit('error', err));
            }
          }, this.opts.reconnectDelayMs);
        }
      });
    });
  }

  public send(action: OutgoingAction): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(action));
  }

  public on<K extends keyof ConnectionEventMap>(event: K, cb: Handler<K>): void {
    this.handlers[event].add(cb);
  }

  public off<K extends keyof ConnectionEventMap>(event: K, cb: Handler<K>): void {
    this.handlers[event].delete(cb);
  }

  public close(): void {
    this.closedByUser = true;
    this.socket?.close();
    this.socket = null;
  }

  private emit<K extends keyof ConnectionEventMap>(
    event: K,
    ...args: Parameters<Handler<K>>
  ): void {
    for (const cb of this.handlers[event]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cb as any)(...args);
    }
  }

  private handleRaw(raw: string): void {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(raw) as IncomingMessage;
    } catch {
      this.emit('error', new Error(`Invalid JSON: ${raw.slice(0, 120)}`));
      return;
    }

    switch (msg.type) {
      case 'STATE_UPDATE':
        this.emit('state', msg.payload);
        break;
      case 'CHAT_MESSAGE':
      case 'CHAT_HISTORY':
        this.emit('chat', msg);
        break;
      case 'ACTION_REJECTED':
        this.emit('rejected', msg.message);
        break;
      case 'ERROR':
        this.emit('error', msg);
        break;
      default:
        break;
    }
  }
}
