import { randomUUID } from 'node:crypto';
import { Card, Suit } from '../engine/Card';
import { GameEngine, GameState, JokerAction } from '../engine/GameEngine';
import { RoundType } from '../engine/Scoring';
import prisma from '../db/prisma';

const OPEN_SOCKET_STATE = 1;
const MAX_CHAT_MESSAGES = 50;
const MAX_CHAT_MESSAGE_LENGTH = 300;
const MAX_WS_MESSAGE_BYTES = 16_384;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 20;
const HUMAN_TURN_MS = 30_000;
const BOT_TURN_MS = 3_000;
const FINISHED_ROOM_CLEANUP_MS = 10 * 60_000;
/** How long a completed trick stays on the table before it is collected. */
const TRICK_HOLD_MS = 2_200;

export type PlayerLimit = 3 | 4 | 6;
export type RoomStatus = 'waiting' | 'playing' | 'finished';

export interface RoomSettings {
  playersCount: PlayerLimit;
  hasLadder: boolean;
  hasMiser: boolean;
}

export interface CreateRoomInput {
  id?: string;
  name: string;
  ownerId: string;
  ownerName: string;
  maxPlayers: number;
  hasLadder: boolean;
  hasMiser: boolean;
  isPrivate?: boolean;
  isTraining?: boolean;
}

export interface PublicRoomInfo {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  hostId: string;
  maxPlayers: PlayerLimit;
  settings: RoomSettings;
  status: RoomStatus;
  playersCount: number;
  isPrivate: boolean;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  text: string;
  createdAt: string;
}

export interface RoomSocket {
  readonly readyState: number;
  send(data: string): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

export type RoomManagerErrorCode = 'INVALID_ROOM' | 'ROOM_ALREADY_EXISTS';

export class RoomManagerError extends Error {
  public constructor(code: RoomManagerErrorCode, message: string) {
    super(message);
    this.name = 'RoomManagerError';
    this.code = code;
  }

  public readonly code: RoomManagerErrorCode;
}

interface NormalizedCreateRoomInput {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  maxPlayers: PlayerLimit;
  isPrivate: boolean;
  isTraining: boolean;
  settings: RoomSettings;
}

interface Client {
  userId: string;
  userName: string;
  socket: RoomSocket;
  connected: boolean;
  isBot: boolean;
  lastMessageAt: number;
  messageCountWindow: number;
  windowStartedAt: number;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  /**
   * A human seat currently auto-played by the «Новичок» bot after a disconnect
   * or a turn timeout. Cleared as soon as the human reconnects or acts again.
   * Genuine bots keep isBot=true and are never marked substituted.
   */
  substituted: boolean;
}

/** Bot that takes over an abandoned human seat (see registry id `random`). */
const SUBSTITUTE_BOT_LABEL = 'Новичок';

class Room {
  public readonly id: string;
  public readonly name: string;
  public ownerId: string;
  public ownerName: string;
  public readonly maxPlayers: PlayerLimit;
  public readonly isPrivate: boolean;
  public readonly isTraining: boolean;
  public settings: RoomSettings;
  public readonly engine: GameEngine;
  public readonly clients = new Map<string, Client>();
  public readonly chatHistory: ChatMessage[] = [];
  public stateVersion = 0;
  public turnDeadlineAt: number | null = null;
  public turnTimer: ReturnType<typeof setTimeout> | null = null;
  public trickTimer: ReturnType<typeof setTimeout> | null = null;
  public timeoutCount = 0;
  public dbStatsUpdated = false;

  public constructor(input: NormalizedCreateRoomInput) {
    this.id = input.id;
    this.name = input.name;
    this.ownerId = input.ownerId;
    this.ownerName = input.ownerName;
    this.maxPlayers = input.maxPlayers;
    this.isPrivate = input.isPrivate;
    this.isTraining = input.isTraining;
    this.settings = { ...input.settings };
    this.engine = new GameEngine(input.maxPlayers, true);
  }
}

type ServerEvent =
  | { type: 'ROOM_INFO'; payload: PublicRoomInfo }
  | { type: 'STATE_UPDATE'; payload: Record<string, unknown> }
  | { type: 'CHAT_HISTORY'; payload: ChatMessage[] }
  | { type: 'CHAT_MESSAGE'; payload: ChatMessage }
  | { type: 'ACTION_REJECTED'; message: string; code?: string; stateVersion?: number }
  | { type: 'TURN_TIMEOUT'; payload: { playerId: string; stateVersion: number } }
  | { type: 'SYSTEM'; message: string };

type JsonRecord = Record<string, unknown>;

export interface JoinOptions {
  isBot?: boolean;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly matchFinishedListeners: Array<(roomId: string) => void> = [];

  /** Register a callback fired once when a room's match reaches MATCH_FINISHED. */
  public onMatchFinished(listener: (roomId: string) => void): void {
    this.matchFinishedListeners.push(listener);
  }

  public createRoom(input: CreateRoomInput): PublicRoomInfo;
  public createRoom(roomId: string, maxPlayers: number): PublicRoomInfo;
  public createRoom(
    inputOrRoomId: CreateRoomInput | string,
    legacyMaxPlayers?: number,
  ): PublicRoomInfo {
    const input =
      typeof inputOrRoomId === 'string'
        ? this.getLegacyCreateInput(inputOrRoomId, legacyMaxPlayers)
        : inputOrRoomId;
    const normalizedInput = this.normalizeCreateInput(input);
    if (this.rooms.has(normalizedInput.id)) {
      throw new RoomManagerError(
        'ROOM_ALREADY_EXISTS',
        'Комната с таким идентификатором уже существует.',
      );
    }

    const room = new Room(normalizedInput);
    this.rooms.set(room.id, room);
    return this.toPublicRoomInfo(room);
  }

  public listRooms(): PublicRoomInfo[] {
    return Array.from(this.rooms.values())
      .filter((room) => !room.isPrivate)
      .map((room) => this.toPublicRoomInfo(room));
  }

  public getRoomInfo(roomId: string): PublicRoomInfo | null {
    const room = this.rooms.get(roomId);
    return room ? this.toPublicRoomInfo(room) : null;
  }

  public getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  public countHumans(room: Room): number {
    let count = 0;
    for (const client of room.clients.values()) {
      if (!client.isBot && room.engine.players.some((p) => p.id === client.userId)) {
        count += 1;
      }
    }
    // Also count connected humans only for chat? Spec: "2 or more live people at table"
    // Use seated non-bot players
    return room.engine.players.filter((p) => {
      const c = room.clients.get(p.id);
      return c && !c.isBot;
    }).length;
  }

  public isChatEnabled(room: Room): boolean {
    return this.countHumans(room) >= 2;
  }

  public joinRoom(
    roomId: string,
    userId: string,
    userName: string,
    socket: RoomSocket,
    options: JoinOptions = {},
  ): boolean {
    const room = this.rooms.get(roomId);
    if (!room) {
      return false;
    }

    const normalizedUserId = userId.trim();
    const normalizedUserName = userName.trim();
    if (!normalizedUserId || !normalizedUserName) {
      return false;
    }

    const isBot = options.isBot === true;
    const existingPlayer = room.engine.players.find((player) => player.id === normalizedUserId);
    if (!existingPlayer) {
      if (room.engine.state !== GameState.WAITING_PLAYERS) {
        return false;
      }
      if (room.engine.players.length >= room.maxPlayers) {
        return false;
      }

      const added = room.engine.addPlayer(normalizedUserId, normalizedUserName);
      if (!added) {
        return false;
      }
      if (room.ownerId === 'test-owner' && room.engine.players.length === 1) {
        room.ownerId = normalizedUserId;
        room.ownerName = normalizedUserName;
      }
    } else {
      existingPlayer.name = normalizedUserName;
    }

    const existingClient = room.clients.get(normalizedUserId);
    if (existingClient?.disconnectTimer) {
      clearTimeout(existingClient.disconnectTimer);
      existingClient.disconnectTimer = null;
    }
    let resumedFromSubstitute = false;
    if (existingClient) {
      existingClient.userName = normalizedUserName;
      existingClient.socket = socket;
      existingClient.connected = true;
      existingClient.isBot = existingClient.isBot || isBot;
      if (existingClient.substituted && !isBot) {
        existingClient.substituted = false;
        resumedFromSubstitute = true;
      }
    } else {
      room.clients.set(normalizedUserId, {
        userId: normalizedUserId,
        userName: normalizedUserName,
        socket,
        connected: true,
        isBot,
        lastMessageAt: 0,
        messageCountWindow: 0,
        windowStartedAt: Date.now(),
        disconnectTimer: null,
        substituted: false,
      });
    }

    this.attachSocketHandlers(room, normalizedUserId, socket);
    if (resumedFromSubstitute) {
      this.broadcastEvent(room, {
        type: 'SYSTEM',
        message: `Игрок ${normalizedUserName} вернулся за стол и снова ходит сам.`,
      });
      this.scheduleTurnTimer(room);
    }
    this.broadcastRoomInfo(room.id);
    this.broadcastState(room.id);

    const client = room.clients.get(normalizedUserId);
    if (client) {
      const chatEnabled = this.isChatEnabled(room);
      this.sendEvent(socket, {
        type: 'CHAT_HISTORY',
        payload: chatEnabled ? room.chatHistory.map((message) => ({ ...message })) : [],
      });
    }
    return true;
  }

  public broadcastRoomInfo(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    this.broadcastEvent(room, {
      type: 'ROOM_INFO',
      payload: this.toPublicRoomInfo(room),
    });
  }

  public broadcastState(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    if (room.engine.state === GameState.MATCH_FINISHED && !room.dbStatsUpdated) {
      room.dbStatsUpdated = true;
      void this.updateUserStats(room);
      this.notifyMatchFinished(room.id);
      this.scheduleFinishedRoomCleanup(room);
    }

    for (const client of room.clients.values()) {
      if (!client.connected) {
        continue;
      }
      const state = this.filterEngineState(room, client.userId);
      if (
        !this.sendEvent(client.socket, {
          type: 'STATE_UPDATE',
          payload: state,
        })
      ) {
        client.connected = false;
      }
    }
  }

  private async updateUserStats(room: Room): Promise<void> {
    const ranking =
      room.engine.ranking.length > 0
        ? room.engine.ranking
        : room.engine.computeRanking();
    if (ranking.length === 0) return;

    const maxPlace = Math.max(...ranking.map((r) => r.place));

    for (const r of ranking) {
      const client = room.clients.get(r.playerId);
      const isBot = client?.isBot === true;
      const isGuest = r.playerId.startsWith('guest-');

      if (isBot || isGuest) {
        continue;
      }

      const isLast = r.place === maxPlace;
      let points = 0;
      if (r.place === 1) {
        points = 100;
      } else if (r.place === 2 && !isLast) {
        points = 50;
      } else if (r.place === 3 && !isLast) {
        points = 20;
      }

      const isWon = r.place === 1;

      try {
        await prisma.user.update({
          where: { id: r.playerId },
          data: {
            ratingPoints: { increment: points },
            gamesPlayed: { increment: 1 },
            gamesWon: { increment: isWon ? 1 : 0 },
          },
        });
      } catch (err) {
        console.error(`[db] Failed to update stats for user ${r.playerId}:`, err);
      }
    }
  }

  private notifyMatchFinished(roomId: string): void {
    for (const listener of this.matchFinishedListeners) {
      try {
        listener(roomId);
      } catch (err) {
        console.error(`[rooms] match-finished listener failed for ${roomId}:`, err);
      }
    }
  }

  private scheduleFinishedRoomCleanup(room: Room): void {
    const timer = setTimeout(() => {
      this.maybeDeleteFinishedRoom(room.id);
    }, FINISHED_ROOM_CLEANUP_MS);
    timer.unref?.();
  }

  /** Drop a finished, empty room to avoid unbounded in-memory growth. */
  private maybeDeleteFinishedRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.engine.state !== GameState.MATCH_FINISHED) {
      return;
    }
    const hasConnectedHuman = Array.from(room.clients.values()).some(
      (client) => client.connected && !client.isBot,
    );
    if (hasConnectedHuman) {
      return;
    }
    for (const client of room.clients.values()) {
      if (client.disconnectTimer) {
        clearTimeout(client.disconnectTimer);
      }
    }
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
    }
    this.rooms.delete(roomId);
  }

  public handleAction(roomId: string, userId: string, action: unknown): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    if (!this.isRecord(action) || typeof action.type !== 'string') {
      this.rejectAction(room, userId, 'Некорректный формат действия.', 'INVALID_FORMAT');
      return;
    }

    // Any real message from a substituted human means they are back at the
    // keyboard, so control is handed back from the «Новичок» bot.
    const sender = room.clients.get(userId);
    if (sender && !sender.isBot && sender.substituted) {
      sender.substituted = false;
      this.broadcastEvent(room, {
        type: 'SYSTEM',
        message: `Игрок ${sender.userName} вернулся и снова ходит сам.`,
      });
      this.scheduleTurnTimer(room);
    }

    let stateChanged = false;
    switch (action.type) {
      case 'START_GAME':
        stateChanged = this.handleStartGame(room, userId, action);
        break;
      case 'PLACE_BID':
        stateChanged = this.handlePlaceBid(room, userId, action);
        break;
      case 'PLAY_CARD':
        stateChanged = this.handlePlayCard(room, userId, action);
        break;
      case 'SETUP_CONTROL':
        stateChanged = this.handleSetupControl(room, userId, action);
        break;
      case 'CHAT_SEND':
        this.handleChatSend(room, userId, action);
        break;
      case 'LEAVE_ROOM':
        stateChanged = this.handleLeaveRoom(room, userId);
        break;
      case 'PING':
        this.sendEvent(room.clients.get(userId)?.socket as RoomSocket, {
          type: 'SYSTEM',
          message: 'PONG',
        });
        break;
      default:
        this.rejectAction(room, userId, 'Неизвестное действие.', 'UNKNOWN_ACTION');
    }

    if (stateChanged) {
      room.stateVersion += 1;
      this.scheduleTurnTimer(room);
      this.broadcastRoomInfo(room.id);
      this.broadcastState(room.id);
    }
  }

  /**
   * A seated player leaves the table. During an active match this finishes
   * the game immediately: the leaver is recorded with a loss and the standings
   * are frozen for everyone else.
   */
  private handleLeaveRoom(room: Room, userId: string): boolean {
    const isPlayer = room.engine.players.some((player) => player.id === userId);
    const isActive =
      room.engine.state !== GameState.WAITING_PLAYERS
      && room.engine.state !== GameState.MATCH_FINISHED;

    if (!isPlayer || !isActive) {
      return false;
    }

    const finished = room.engine.forfeitMatch(userId);
    if (!finished) {
      return false;
    }

    const leaver = room.clients.get(userId);
    if (leaver) {
      leaver.connected = false;
      if (leaver.disconnectTimer) {
        clearTimeout(leaver.disconnectTimer);
        leaver.disconnectTimer = null;
      }
    }

    this.broadcastEvent(room, {
      type: 'SYSTEM',
      message: `Игрок ${leaver?.userName ?? userId} покинул стол. Матч завершён.`,
    });
    return true;
  }

  /** Server-side auto action when turn timer fires */
  public forceDefaultAction(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) {
      return false;
    }
    return this.applyDefaultTurnAction(room);
  }

  private applyDefaultTurnAction(room: Room): boolean {
    const engine = room.engine;
    const stateBefore = engine.state;

    if (engine.state === GameState.CONTROL_GAME_SETUP && engine.controlGameChooserId) {
      const chooserId = engine.controlGameChooserId;
      this.markSubstituted(room, chooserId);
      const types = Array.from(engine.playedRoundTypes);
      const type = types.includes(RoundType.STANDARD) ? RoundType.STANDARD : types[0];
      if (!type) {
        return false;
      }
      const dealerIndex = engine.players.findIndex((p) => p.id === chooserId);
      const ok = engine.setupControlGame(
        chooserId,
        type,
        dealerIndex >= 0 ? dealerIndex : 0,
      );
      if (ok) {
        this.afterAutoAction(room, chooserId);
      }
      return ok;
    }

    const current = engine.players[engine.currentPlayerIndex];
    if (!current) {
      return false;
    }
    this.markSubstituted(room, current.id);

    if (engine.state === GameState.BIDDING) {
      const bids = engine.getLegalBids(current.id);
      if (bids.length === 0) {
        return false;
      }
      const bid = this.pickRandom(bids);
      const result = engine.applyAction({ type: 'PLACE_BID', playerId: current.id, bid });
      if (result.ok) {
        this.afterAutoAction(room, current.id);
      }
      return result.ok;
    }

    if (engine.state === GameState.PLAYING_TRICKS) {
      const plays = engine.getLegalPlays(current.id);
      if (plays.length === 0) {
        return false;
      }
      const play = this.pickRandom(plays);
      const jokerAction = play.jokerActions && play.jokerActions.length > 0
        ? this.pickRandom(play.jokerActions)
        : undefined;
      const result = engine.applyAction({
        type: 'PLAY_CARD',
        playerId: current.id,
        cardIndex: play.cardIndex,
        jokerAction,
      });
      if (result.ok) {
        this.afterAutoAction(room, current.id);
      }
      return result.ok;
    }

    return stateBefore !== engine.state;
  }

  /** Broadcast bookkeeping shared by every auto (timeout / substitute) action. */
  private afterAutoAction(room: Room, actorId: string): void {
    room.timeoutCount += 1;
    room.stateVersion += 1;
    this.broadcastEvent(room, {
      type: 'TURN_TIMEOUT',
      payload: { playerId: actorId, stateVersion: room.stateVersion },
    });
    this.scheduleTurnTimer(room);
    this.broadcastRoomInfo(room.id);
    this.broadcastState(room.id);
  }

  /**
   * Marks a human seat as auto-played by the «Новичок» bot after a timeout.
   * No-op for genuine bots or seats already substituted.
   */
  private markSubstituted(room: Room, playerId: string): void {
    const client = room.clients.get(playerId);
    if (!client || client.isBot || client.substituted) {
      return;
    }
    client.substituted = true;
    this.broadcastEvent(room, {
      type: 'SYSTEM',
      message: `Игрок ${client.userName} не ходит — за него доигрывает бот «${SUBSTITUTE_BOT_LABEL}».`,
    });
  }

  private pickRandom<T>(items: readonly T[]): T {
    const index = Math.floor(Math.random() * items.length);
    return items[index];
  }

  private scheduleTurnTimer(room: Room): void {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
    room.turnDeadlineAt = null;

    const engine = room.engine;

    // A completed trick is being shown: hold it, then collect and continue.
    if (engine.pendingTrickWinnerId !== null) {
      this.scheduleTrickFinalize(room);
      return;
    }

    const timedStates = [
      GameState.BIDDING,
      GameState.PLAYING_TRICKS,
      GameState.CONTROL_GAME_SETUP,
    ];
    if (!timedStates.includes(engine.state)) {
      return;
    }
    if (engine.state === GameState.MATCH_FINISHED) {
      return;
    }

    let actorId: string | null = null;
    if (engine.state === GameState.CONTROL_GAME_SETUP) {
      actorId = engine.controlGameChooserId;
    } else {
      actorId = engine.players[engine.currentPlayerIndex]?.id ?? null;
    }
    if (!actorId) {
      return;
    }

    const client = room.clients.get(actorId);
    // Bots, disconnected seats and «Новичок»-substituted seats all move at the
    // fast bot pace so the table never stalls waiting for someone who is gone.
    const isAutoActor =
      !client
      || client.isBot
      || client.substituted
      || !client.connected;
    const delay = isAutoActor ? BOT_TURN_MS : HUMAN_TURN_MS;
    room.turnDeadlineAt = Date.now() + delay;
    const versionAtSchedule = room.stateVersion;

    room.turnTimer = setTimeout(() => {
      const live = this.rooms.get(room.id);
      if (!live || live.stateVersion !== versionAtSchedule) {
        return;
      }
      this.applyDefaultTurnAction(live);
    }, delay);
    room.turnTimer.unref?.();
  }

  /** Holds the completed trick briefly, then clears it and resumes play. */
  private scheduleTrickFinalize(room: Room): void {
    if (room.trickTimer) {
      clearTimeout(room.trickTimer);
      room.trickTimer = null;
    }
    const versionAtSchedule = room.stateVersion;
    room.trickTimer = setTimeout(() => {
      const live = this.rooms.get(room.id);
      if (!live || live.stateVersion !== versionAtSchedule) {
        return;
      }
      room.trickTimer = null;
      if (!live.engine.finalizeTrick()) {
        return;
      }
      live.stateVersion += 1;
      this.scheduleTurnTimer(live);
      this.broadcastRoomInfo(live.id);
      this.broadcastState(live.id);
    }, TRICK_HOLD_MS);
    room.trickTimer.unref?.();
  }

  private getLegacyCreateInput(roomId: string, maxPlayers: number | undefined): CreateRoomInput {
    return {
      id: roomId,
      name: roomId,
      ownerId: 'system',
      ownerName: 'Система',
      maxPlayers: maxPlayers ?? Number.NaN,
      hasLadder: true,
      hasMiser: true,
      isPrivate: false,
    };
  }

  private normalizeCreateInput(input: CreateRoomInput): NormalizedCreateRoomInput {
    if (!this.isPlayerLimit(input.maxPlayers)) {
      throw new RoomManagerError('INVALID_ROOM', 'Количество игроков должно быть 3, 4 или 6.');
    }
    if (
      typeof input.hasLadder !== 'boolean'
      || typeof input.hasMiser !== 'boolean'
      || (input.isPrivate !== undefined && typeof input.isPrivate !== 'boolean')
    ) {
      throw new RoomManagerError(
        'INVALID_ROOM',
        'Настройки лестницы и мизера должны быть указаны.',
      );
    }

    const name = input.name.trim();
    if (!name) {
      throw new RoomManagerError(
        'INVALID_ROOM',
        'Название комнаты и данные владельца обязательны.',
      );
    }
    const ownerId = input.ownerId.trim();
    if (!ownerId) {
      throw new RoomManagerError(
        'INVALID_ROOM',
        'Название комнаты и данные владельца обязательны.',
      );
    }
    const ownerName = input.ownerName.trim();
    if (!ownerName) {
      throw new RoomManagerError(
        'INVALID_ROOM',
        'Название комнаты и данные владельца обязательны.',
      );
    }

    const id = input.id === undefined ? this.createUniqueRoomId() : input.id.trim();
    if (!id) {
      throw new RoomManagerError('INVALID_ROOM', 'Идентификатор комнаты не может быть пустым.');
    }

    return {
      id,
      name,
      ownerId,
      ownerName,
      maxPlayers: input.maxPlayers,
      isPrivate: input.isPrivate ?? false,
      isTraining: input.isTraining ?? false,
      settings: {
        playersCount: input.maxPlayers,
        hasLadder: input.hasLadder,
        hasMiser: input.hasMiser,
      },
    };
  }

  private createUniqueRoomId(): string {
    let roomId = randomUUID();
    while (this.rooms.has(roomId)) {
      roomId = randomUUID();
    }
    return roomId;
  }

  private isPlayerLimit(value: unknown): value is PlayerLimit {
    return value === 3 || value === 4 || value === 6;
  }

  private toPublicRoomInfo(room: Room): PublicRoomInfo {
    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      ownerName: room.ownerName,
      hostId: room.ownerId,
      maxPlayers: room.maxPlayers,
      settings: { ...room.settings },
      status: this.getRoomStatus(room.engine.state),
      playersCount: room.engine.players.length,
      isPrivate: room.isPrivate,
    };
  }

  private getRoomStatus(state: GameState): RoomStatus {
    if (state === GameState.WAITING_PLAYERS) {
      return 'waiting';
    }
    if (state === GameState.MATCH_FINISHED) {
      return 'finished';
    }
    return 'playing';
  }

  private attachSocketHandlers(room: Room, userId: string, socket: RoomSocket): void {
    socket.on('message', (message: unknown) => {
      const client = room.clients.get(userId);
      if (!client || !client.connected || client.socket !== socket) {
        return;
      }

      const rawMessage = typeof message === 'string' ? message : String(message);
      if (rawMessage.length > MAX_WS_MESSAGE_BYTES) {
        this.rejectAction(room, userId, 'Сообщение слишком большое.', 'MESSAGE_TOO_LARGE');
        return;
      }

      const now = Date.now();
      if (now - client.windowStartedAt > RATE_LIMIT_WINDOW_MS) {
        client.windowStartedAt = now;
        client.messageCountWindow = 0;
      }
      client.messageCountWindow += 1;
      if (client.messageCountWindow > RATE_LIMIT_MAX) {
        this.rejectAction(room, userId, 'Слишком много сообщений.', 'RATE_LIMIT');
        return;
      }

      let action: unknown;
      try {
        action = JSON.parse(rawMessage) as unknown;
      } catch {
        this.rejectAction(room, userId, 'Сообщение должно быть корректным JSON.', 'INVALID_JSON');
        return;
      }
      this.handleAction(room.id, userId, action);
    });

    socket.on('close', () => {
      const client = room.clients.get(userId);
      if (!client || client.socket !== socket) {
        return;
      }
      client.connected = false;
      if (client.disconnectTimer) {
        clearTimeout(client.disconnectTimer);
        client.disconnectTimer = null;
      }
      // A human dropping mid-game is immediately covered by the «Новичок» bot so
      // the remaining players can finish. Control returns on reconnect.
      const midGame =
        room.engine.state !== GameState.WAITING_PLAYERS
        && room.engine.state !== GameState.MATCH_FINISHED;
      if (!client.isBot && midGame) {
        this.markSubstituted(room, userId);
        this.scheduleTurnTimer(room);
      }
      this.broadcastRoomInfo(room.id);
      this.broadcastState(room.id);

      if (room.engine.state === GameState.MATCH_FINISHED) {
        this.maybeDeleteFinishedRoom(room.id);
      }
    });
  }

  private handleStartGame(room: Room, userId: string, action: JsonRecord): boolean {
    if (userId !== room.ownerId) {
      this.rejectAction(room, userId, 'Начать игру может только владелец комнаты.', 'NOT_HOST');
      return false;
    }
    if (room.engine.state !== GameState.WAITING_PLAYERS) {
      this.rejectAction(room, userId, 'Игра уже началась.', 'ALREADY_STARTED');
      return false;
    }
    if (room.engine.players.length !== room.maxPlayers) {
      this.rejectAction(room, userId, `Для старта нужны все игроки: ${room.maxPlayers}.`, 'NOT_FULL');
      return false;
    }

    const settings =
      action.settings === undefined
        ? { ...room.settings }
        : this.parseRoomSettings(action.settings);
    if (!settings || settings.playersCount !== room.maxPlayers) {
      this.rejectAction(room, userId, 'Некорректные настройки игры.', 'INVALID_SETTINGS');
      return false;
    }

    const shortPlan = action.shortPlan === true;
    const started = shortPlan
      ? room.engine.startShortGame(settings, typeof action.shortRounds === 'number' ? action.shortRounds : 2)
      : room.engine.startGame(settings);
    if (!started) {
      this.rejectAction(room, userId, 'Не удалось начать игру.', 'START_FAILED');
      return false;
    }
    room.settings = { ...settings };
    return true;
  }

  private handlePlaceBid(room: Room, userId: string, action: JsonRecord): boolean {
    if (!Number.isInteger(action.bid)) {
      this.rejectAction(room, userId, 'Заказ должен быть целым числом.', 'INVALID_BID');
      return false;
    }

    const result = room.engine.applyAction({
      type: 'PLACE_BID',
      playerId: userId,
      bid: action.bid as number,
    });
    if (!result.ok) {
      this.rejectAction(
        room,
        userId,
        'Этот заказ сейчас недоступен или ход принадлежит другому игроку.',
        'ILLEGAL_BID',
      );
    }
    return result.ok;
  }

  private handlePlayCard(room: Room, userId: string, action: JsonRecord): boolean {
    if (!Number.isInteger(action.cardIndex)) {
      this.rejectAction(room, userId, 'Индекс карты должен быть целым числом.', 'INVALID_CARD');
      return false;
    }

    const jokerAction = this.parseJokerAction(action.jokerAction);
    if (action.jokerAction !== undefined && !jokerAction) {
      this.rejectAction(room, userId, 'Некорректное действие джокера.', 'INVALID_JOKER');
      return false;
    }

    const result = room.engine.applyAction({
      type: 'PLAY_CARD',
      playerId: userId,
      cardIndex: action.cardIndex as number,
      jokerAction,
    });
    if (!result.ok) {
      this.rejectAction(
        room,
        userId,
        'Эту карту нельзя сыграть: проверьте очередь, масть и козырь.',
        'ILLEGAL_CARD',
      );
    }
    return result.ok;
  }

  private handleSetupControl(room: Room, userId: string, action: JsonRecord): boolean {
    if (!this.isRoundType(action.roundType)) {
      this.rejectAction(room, userId, 'Некорректный тип контрольной игры.', 'INVALID_ROUND_TYPE');
      return false;
    }
    if (!Number.isInteger(action.dealerIndex)) {
      this.rejectAction(room, userId, 'Некорректный индекс сдающего.', 'INVALID_DEALER');
      return false;
    }

    const result = room.engine.applyAction({
      type: 'SETUP_CONTROL',
      playerId: userId,
      roundType: action.roundType,
      dealerIndex: action.dealerIndex as number,
    });
    if (!result.ok) {
      this.rejectAction(
        room,
        userId,
        'Нельзя настроить контрольную игру с этими параметрами.',
        'ILLEGAL_CONTROL',
      );
    }
    return result.ok;
  }

  private handleChatSend(room: Room, userId: string, action: JsonRecord): void {
    const client = room.clients.get(userId);
    if (client?.isBot) {
      this.rejectAction(room, userId, 'Боты не могут писать в чат.', 'BOTS_NO_CHAT');
      return;
    }
    if (!this.isChatEnabled(room)) {
      this.rejectAction(
        room,
        userId,
        'Чат доступен только когда за столом 2 или более живых игрока.',
        'CHAT_DISABLED',
      );
      return;
    }
    if (typeof action.text !== 'string') {
      this.rejectAction(room, userId, 'Текст сообщения обязателен.', 'CHAT_EMPTY');
      return;
    }

    const text = this.sanitizeChatText(action.text);
    if (text.length === 0) {
      this.rejectAction(room, userId, 'Сообщение не может быть пустым.', 'CHAT_EMPTY');
      return;
    }
    if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
      this.rejectAction(
        room,
        userId,
        `Сообщение не должно превышать ${MAX_CHAT_MESSAGE_LENGTH} символов.`,
        'CHAT_TOO_LONG',
      );
      return;
    }

    const player = room.engine.players.find((roomPlayer) => roomPlayer.id === userId);
    if (!player) {
      this.rejectAction(room, userId, 'Отправлять сообщения могут только игроки.', 'NOT_PLAYER');
      return;
    }

    const message: ChatMessage = {
      id: randomUUID(),
      userId,
      userName: player.name,
      text,
      createdAt: new Date().toISOString(),
    };
    room.chatHistory.push(message);
    if (room.chatHistory.length > MAX_CHAT_MESSAGES) {
      room.chatHistory.splice(0, room.chatHistory.length - MAX_CHAT_MESSAGES);
    }
    this.broadcastEvent(room, {
      type: 'CHAT_MESSAGE',
      payload: { ...message },
    });
  }

  private sanitizeChatText(text: string): string {
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim();
  }

  private parseRoomSettings(value: unknown): RoomSettings | null {
    if (!this.isRecord(value)) {
      return null;
    }
    const playersCount = value.playersCount;
    if (!this.isPlayerLimit(playersCount)) {
      return null;
    }
    if (typeof value.hasLadder !== 'boolean' || typeof value.hasMiser !== 'boolean') {
      return null;
    }
    return {
      playersCount,
      hasLadder: value.hasLadder,
      hasMiser: value.hasMiser,
    };
  }

  private parseJokerAction(value: unknown): JokerAction | undefined {
    if (!this.isRecord(value) || typeof value.type !== 'string') {
      return undefined;
    }
    if (value.type === 'TAKE') {
      return { type: 'TAKE' };
    }
    if (value.type === 'DEMAND_SUIT' && this.isSuit(value.suit)) {
      return { type: 'DEMAND_SUIT', suit: value.suit };
    }
    if (value.type === 'DROP') {
      if (value.suit === undefined) {
        return { type: 'DROP' };
      }
      if (this.isSuit(value.suit)) {
        return { type: 'DROP', suit: value.suit };
      }
    }
    return undefined;
  }

  private isSuit(value: unknown): value is Suit {
    return (
      value === Suit.Spades
      || value === Suit.Hearts
      || value === Suit.Diamonds
      || value === Suit.Clubs
    );
  }

  private isRoundType(value: unknown): value is RoundType {
    return (
      value === RoundType.STANDARD
      || value === RoundType.DARK
      || value === RoundType.PERCENTS
      || value === RoundType.NO_TRUMP
      || value === RoundType.GOLD
      || value === RoundType.MISER
    );
  }

  private isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null;
  }

  private rejectAction(
    room: Room,
    userId: string,
    message: string,
    code = 'REJECTED',
  ): void {
    const client = room.clients.get(userId);
    if (!client) {
      return;
    }
    this.sendEvent(client.socket, {
      type: 'ACTION_REJECTED',
      message,
      code,
      stateVersion: room.stateVersion,
    });
  }

  private broadcastEvent(room: Room, event: ServerEvent): void {
    for (const client of room.clients.values()) {
      if (!client.connected) {
        continue;
      }
      if (!this.sendEvent(client.socket, event)) {
        client.connected = false;
      }
    }
  }

  private sendEvent(socket: RoomSocket | undefined, event: ServerEvent): boolean {
    if (!socket || socket.readyState !== OPEN_SOCKET_STATE) {
      return false;
    }
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  private filterEngineState(room: Room, viewerId: string): Record<string, unknown> {
    const engine = room.engine;
    const isViewerTurn = engine.players[engine.currentPlayerIndex]?.id === viewerId;
    const allowedBids =
      isViewerTurn && engine.state === GameState.BIDDING
        ? engine.getLegalBids(viewerId)
        : null;
    const legalPlays =
      isViewerTurn && engine.state === GameState.PLAYING_TRICKS
        ? engine.getLegalPlays(viewerId)
        : [];
    const validCardIndices = legalPlays.map((play) => play.cardIndex);
    const chatEnabled = this.isChatEnabled(room);

    return {
      stateVersion: room.stateVersion,
      turnDeadlineAt: room.turnDeadlineAt,
      timeoutCount: room.timeoutCount,
      chatEnabled,
      humanCount: this.countHumans(room),
      allowedBids,
      validCardIndices,
      legalPlays: legalPlays.map((play) => ({
        cardIndex: play.cardIndex,
        jokerActions: play.jokerActions,
      })),
      state: engine.state,
      viewerId,
      hostId: room.ownerId,
      maxPlayers: room.maxPlayers,
      settings: { ...room.settings },
      playersCount: engine.players.length,
      dealerIndex: engine.dealerIndex,
      currentPlayerIndex: engine.currentPlayerIndex,
      trumpSuit: engine.trumpSuit,
      // trumpCard only suit/rank for public; already known when shown
      trumpCard: engine.trumpCard
        ? this.serializeCard(engine.trumpCard)
        : null,
      tableCards: engine.tableCards.map((playedCard) => ({
        playerId: playedCard.playerId,
        jokerAction: playedCard.jokerAction,
        card: this.serializeCard(playedCard.card),
      })),
      currentTrickLeadSuit: engine.currentTrickLeadSuit,
      pendingTrickWinnerId: engine.pendingTrickWinnerId,
      currentRoundCards: engine.currentRoundCards,
      currentRoundType: engine.currentRoundType,
      isDarkRound: engine.isDarkRound,
      plan: engine.plan.map((round) => ({ ...round })),
      scoreHistory: engine.scoreHistory.map((round) => ({
        ...round,
        scores: { ...round.scores },
        bids: { ...round.bids },
        tricks: { ...round.tricks },
      })),
      currentRoundIndex: engine.currentRoundIndex,
      playedRoundTypes: Array.from(engine.playedRoundTypes),
      controlGamesPlayed: engine.controlGamesPlayed,
      controlGameChooserId: engine.controlGameChooserId,
      ranking: engine.ranking,
      players: engine.players.map((player) => {
        const client = room.clients.get(player.id);
        const base = {
          id: player.id,
          name: player.name,
          score: player.score,
          currentBid: player.currentBid,
          tricksTaken: player.tricksTaken,
          connected: client?.connected ?? false,
          isBot: client?.isBot ?? false,
          substituted: client?.substituted ?? false,
        };
        if (player.id === viewerId) {
          const hideSelf = engine.isDarkRound && engine.state === GameState.BIDDING;
          const cards = hideSelf
            ? player.cards.map(() => null)
            : player.cards.map((card) => this.serializeCard(card, true));
          return { ...base, cards };
        }
        // Fog of war: never send rank/suit of others
        return {
          ...base,
          cards: player.cards.map(() => null),
        };
      }),
    };
  }

  private serializeCard(
    card: Card,
    forOwner = false,
  ): {
    suit: Suit;
    rank: Card['rank'];
    isJoker?: boolean;
  } {
    return {
      suit: card.suit,
      rank: card.rank,
      // isJoker highlight only for owner (ТЗ)
      ...(forOwner ? { isJoker: card.isJoker } : {}),
    };
  }
}

export const roomManager = new RoomManager();
roomManager.createRoom({
  id: 'test-room',
  name: 'Тестовая комната',
  ownerId: 'test-owner',
  ownerName: 'Тестовый владелец',
  maxPlayers: 3,
  hasLadder: true,
  hasMiser: true,
  isPrivate: false,
});
