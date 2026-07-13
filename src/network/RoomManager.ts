import { randomUUID } from 'node:crypto';
import { Card, Suit } from '../engine/Card';
import { GameEngine, GameState, JokerAction } from '../engine/GameEngine';
import { RoundType } from '../engine/Scoring';

const OPEN_SOCKET_STATE = 1;
const MAX_CHAT_MESSAGES = 50;
const MAX_CHAT_MESSAGE_LENGTH = 300;

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
  settings: RoomSettings;
}

interface Client {
  userId: string;
  userName: string;
  socket: RoomSocket;
  connected: boolean;
}

class Room {
  public readonly id: string;
  public readonly name: string;
  public ownerId: string;
  public ownerName: string;
  public readonly maxPlayers: PlayerLimit;
  public readonly isPrivate: boolean;
  public settings: RoomSettings;
  public readonly engine: GameEngine;
  public readonly clients = new Map<string, Client>();
  public readonly chatHistory: ChatMessage[] = [];

  public constructor(input: NormalizedCreateRoomInput) {
    this.id = input.id;
    this.name = input.name;
    this.ownerId = input.ownerId;
    this.ownerName = input.ownerName;
    this.maxPlayers = input.maxPlayers;
    this.isPrivate = input.isPrivate;
    this.settings = { ...input.settings };
    this.engine = new GameEngine(input.maxPlayers);
  }
}

type ServerEvent =
  | { type: 'ROOM_INFO'; payload: PublicRoomInfo }
  | { type: 'STATE_UPDATE'; payload: Record<string, unknown> }
  | { type: 'CHAT_HISTORY'; payload: ChatMessage[] }
  | { type: 'CHAT_MESSAGE'; payload: ChatMessage }
  | { type: 'ACTION_REJECTED'; message: string };

type JsonRecord = Record<string, unknown>;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

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

  public joinRoom(roomId: string, userId: string, userName: string, socket: RoomSocket): boolean {
    const room = this.rooms.get(roomId);
    if (!room) {
      return false;
    }

    const normalizedUserId = userId.trim();
    const normalizedUserName = userName.trim();
    if (!normalizedUserId || !normalizedUserName) {
      return false;
    }

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
    if (existingClient) {
      existingClient.userName = normalizedUserName;
      existingClient.socket = socket;
      existingClient.connected = true;
    } else {
      room.clients.set(normalizedUserId, {
        userId: normalizedUserId,
        userName: normalizedUserName,
        socket,
        connected: true,
      });
    }

    this.attachSocketHandlers(room, normalizedUserId, socket);
    this.broadcastRoomInfo(room.id);
    this.broadcastState(room.id);
    this.sendEvent(socket, {
      type: 'CHAT_HISTORY',
      payload: room.chatHistory.map((message) => ({ ...message })),
    });
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

  public handleAction(roomId: string, userId: string, action: unknown): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    if (!this.isRecord(action) || typeof action.type !== 'string') {
      this.rejectAction(room, userId, 'Некорректный формат действия.');
      return;
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
      default:
        this.rejectAction(room, userId, 'Неизвестное действие.');
    }

    if (stateChanged) {
      this.broadcastRoomInfo(room.id);
      this.broadcastState(room.id);
    }
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

      let action: unknown;
      try {
        const rawMessage = typeof message === 'string' ? message : String(message);
        action = JSON.parse(rawMessage) as unknown;
      } catch {
        this.rejectAction(room, userId, 'Сообщение должно быть корректным JSON.');
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
      this.broadcastRoomInfo(room.id);
      this.broadcastState(room.id);
    });
  }

  private handleStartGame(room: Room, userId: string, action: JsonRecord): boolean {
    if (userId !== room.ownerId) {
      this.rejectAction(room, userId, 'Начать игру может только владелец комнаты.');
      return false;
    }
    if (room.engine.state !== GameState.WAITING_PLAYERS) {
      this.rejectAction(room, userId, 'Игра уже началась.');
      return false;
    }
    if (room.engine.players.length !== room.maxPlayers) {
      this.rejectAction(room, userId, `Для старта нужны все игроки: ${room.maxPlayers}.`);
      return false;
    }

    const settings =
      action.settings === undefined
        ? { ...room.settings }
        : this.parseRoomSettings(action.settings);
    if (!settings || settings.playersCount !== room.maxPlayers) {
      this.rejectAction(room, userId, 'Некорректные настройки игры.');
      return false;
    }

    const started = room.engine.startGame(settings);
    if (!started) {
      this.rejectAction(room, userId, 'Не удалось начать игру.');
      return false;
    }
    room.settings = { ...settings };
    return true;
  }

  private handlePlaceBid(room: Room, userId: string, action: JsonRecord): boolean {
    if (!Number.isInteger(action.bid)) {
      this.rejectAction(room, userId, 'Заказ должен быть целым числом.');
      return false;
    }

    const placed = room.engine.placeBid(userId, action.bid as number);
    if (!placed) {
      this.rejectAction(
        room,
        userId,
        'Этот заказ сейчас недоступен или ход принадлежит другому игроку.',
      );
    }
    return placed;
  }

  private handlePlayCard(room: Room, userId: string, action: JsonRecord): boolean {
    if (!Number.isInteger(action.cardIndex)) {
      this.rejectAction(room, userId, 'Индекс карты должен быть целым числом.');
      return false;
    }

    const jokerAction = this.parseJokerAction(action.jokerAction);
    if (action.jokerAction !== undefined && !jokerAction) {
      this.rejectAction(room, userId, 'Некорректное действие джокера.');
      return false;
    }

    const played = room.engine.playCard(userId, action.cardIndex as number, jokerAction);
    if (!played) {
      this.rejectAction(
        room,
        userId,
        'Эту карту нельзя сыграть: проверьте очередь, масть и козырь.',
      );
    }
    return played;
  }

  private handleSetupControl(room: Room, userId: string, action: JsonRecord): boolean {
    if (!this.isRoundType(action.roundType)) {
      this.rejectAction(room, userId, 'Некорректный тип контрольной игры.');
      return false;
    }
    if (!Number.isInteger(action.dealerIndex)) {
      this.rejectAction(room, userId, 'Некорректный индекс сдающего.');
      return false;
    }

    const configured = room.engine.setupControlGame(
      userId,
      action.roundType,
      action.dealerIndex as number,
    );
    if (!configured) {
      this.rejectAction(room, userId, 'Нельзя настроить контрольную игру с этими параметрами.');
    }
    return configured;
  }

  private handleChatSend(room: Room, userId: string, action: JsonRecord): void {
    if (typeof action.text !== 'string') {
      this.rejectAction(room, userId, 'Текст сообщения обязателен.');
      return;
    }

    const text = this.sanitizeChatText(action.text);
    if (text.length === 0) {
      this.rejectAction(room, userId, 'Сообщение не может быть пустым.');
      return;
    }
    if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
      this.rejectAction(
        room,
        userId,
        `Сообщение не должно превышать ${MAX_CHAT_MESSAGE_LENGTH} символов.`,
      );
      return;
    }

    const player = room.engine.players.find((roomPlayer) => roomPlayer.id === userId);
    if (!player) {
      this.rejectAction(room, userId, 'Отправлять сообщения могут только игроки.');
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

  private rejectAction(room: Room, userId: string, message: string): void {
    const client = room.clients.get(userId);
    if (!client) {
      return;
    }
    this.sendEvent(client.socket, {
      type: 'ACTION_REJECTED',
      message,
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

  private sendEvent(socket: RoomSocket, event: ServerEvent): boolean {
    if (socket.readyState !== OPEN_SOCKET_STATE) {
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
        ? engine.getAvailableBids(engine.currentPlayerIndex)
        : null;
    const validCardIndices = engine.getValidCardIndices(viewerId);

    return {
      allowedBids,
      validCardIndices,
      state: engine.state,
      viewerId,
      hostId: room.ownerId,
      maxPlayers: room.maxPlayers,
      settings: { ...room.settings },
      playersCount: engine.players.length,
      dealerIndex: engine.dealerIndex,
      currentPlayerIndex: engine.currentPlayerIndex,
      trumpSuit: engine.trumpSuit,
      tableCards: engine.tableCards.map((playedCard) => ({
        ...playedCard,
        card: this.serializeCard(playedCard.card),
      })),
      currentTrickLeadSuit: engine.currentTrickLeadSuit,
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
      players: engine.players.map((player) => {
        if (player.id === viewerId) {
          const hideSelf = engine.isDarkRound && engine.state === GameState.BIDDING;
          const cards = hideSelf
            ? player.cards.map(() => null)
            : player.cards.map((card) => this.serializeCard(card));
          return {
            ...player,
            cards,
            connected: room.clients.get(player.id)?.connected ?? false,
          };
        }
        return {
          ...player,
          cards: player.cards.map(() => null),
          connected: room.clients.get(player.id)?.connected ?? false,
        };
      }),
    };
  }

  private serializeCard(card: Card): {
    suit: Suit;
    rank: Card['rank'];
    isJoker: boolean;
  } {
    return {
      suit: card.suit,
      rank: card.rank,
      isJoker: card.isJoker,
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
