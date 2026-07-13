import { RoomManager, RoomManagerError, RoomSocket } from './RoomManager';

interface TestMessage {
  type: string;
  payload?: unknown;
  message?: string;
  code?: string;
}

class FakeSocket implements RoomSocket {
  public readyState = 1;
  public readonly messages: TestMessage[] = [];
  private messageListener: ((message: unknown) => void) | null = null;
  private closeListener: (() => void) | null = null;

  public send(data: string): void {
    this.messages.push(JSON.parse(data) as TestMessage);
  }

  public on(event: 'message', listener: (message: unknown) => void): unknown;
  public on(event: 'close', listener: () => void): unknown;
  public on(
    event: 'message' | 'close',
    listener: ((message: unknown) => void) | (() => void),
  ): this {
    if (event === 'message') {
      this.messageListener = listener as (message: unknown) => void;
    } else {
      this.closeListener = listener as () => void;
    }
    return this;
  }

  public receive(action: unknown): void {
    this.messageListener?.(JSON.stringify(action));
  }

  public disconnect(): void {
    this.readyState = 3;
    this.closeListener?.();
  }
}

function getLastMessage(socket: FakeSocket, type: string): TestMessage | undefined {
  return [...socket.messages].reverse().find((message) => message.type === type);
}

function createManagerWithRoom(roomId: string): RoomManager {
  const manager = new RoomManager();
  manager.createRoom({
    id: roomId,
    name: 'Комната',
    ownerId: 'owner',
    ownerName: 'Владелец',
    maxPlayers: 3,
    hasLadder: true,
    hasMiser: false,
  });
  return manager;
}

describe('RoomManager', () => {
  it('stores public metadata and rejects invalid or duplicate rooms', () => {
    const manager = createManagerWithRoom('room-1');
    expect(manager.getRoomInfo('room-1')).toEqual({
      id: 'room-1',
      name: 'Комната',
      ownerId: 'owner',
      ownerName: 'Владелец',
      hostId: 'owner',
      maxPlayers: 3,
      settings: {
        playersCount: 3,
        hasLadder: true,
        hasMiser: false,
      },
      status: 'waiting',
      playersCount: 0,
      isPrivate: false,
    });
    expect(manager.listRooms()).toHaveLength(1);
    manager.createRoom({
      id: 'room-private',
      name: 'Закрытая комната',
      ownerId: 'owner',
      ownerName: 'Владелец',
      maxPlayers: 3,
      hasLadder: true,
      hasMiser: true,
      isPrivate: true,
    });
    expect(manager.listRooms()).toHaveLength(1);
    expect(manager.getRoomInfo('room-private')?.isPrivate).toBe(true);
    expect(() =>
      manager.createRoom({
        id: 'room-1',
        name: 'Дубликат',
        ownerId: 'owner',
        ownerName: 'Владелец',
        maxPlayers: 3,
        hasLadder: true,
        hasMiser: true,
      }),
    ).toThrow(RoomManagerError);
    expect(() =>
      manager.createRoom({
        id: 'room-2',
        name: 'Пять игроков',
        ownerId: 'owner',
        ownerName: 'Владелец',
        maxPlayers: 5,
        hasLadder: true,
        hasMiser: true,
      }),
    ).toThrow(RoomManagerError);
  });

  it('sends room, state and chat history on join', () => {
    const manager = createManagerWithRoom('room-join');
    const socket = new FakeSocket();
    expect(manager.joinRoom('room-join', 'owner', 'Владелец', socket)).toBe(true);

    expect(socket.messages.map((message) => message.type)).toEqual([
      'ROOM_INFO',
      'STATE_UPDATE',
      'CHAT_HISTORY',
    ]);
    const state = getLastMessage(socket, 'STATE_UPDATE')?.payload as Record<string, unknown>;
    expect(state.viewerId).toBe('owner');
    expect(state.hostId).toBe('owner');
    expect(state.validCardIndices).toEqual([]);
    expect(state.chatEnabled).toBe(false); // only 1 human
    expect(state.stateVersion).toBe(0);
    const players = state.players as Array<Record<string, unknown>>;
    expect(players[0].connected).toBe(true);
  });

  it('allows reconnect but rejects new players after start', () => {
    const manager = createManagerWithRoom('room-start');
    const ownerSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const thirdSocket = new FakeSocket();
    manager.joinRoom('room-start', 'owner', 'Владелец', ownerSocket);
    manager.joinRoom('room-start', 'p2', 'Игрок 2', secondSocket);
    manager.joinRoom('room-start', 'p3', 'Игрок 3', thirdSocket);

    manager.handleAction('room-start', 'p2', {
      type: 'START_GAME',
      settings: {
        playersCount: 3,
        hasLadder: true,
        hasMiser: false,
      },
    });
    expect(getLastMessage(secondSocket, 'ACTION_REJECTED')?.message).toContain('владелец');
    expect(manager.getRoomInfo('room-start')?.status).toBe('waiting');

    manager.handleAction('room-start', 'owner', {
      type: 'START_GAME',
      settings: {
        playersCount: 3,
        hasLadder: true,
        hasMiser: false,
      },
    });
    expect(manager.getRoomInfo('room-start')?.status).toBe('playing');

    const fourthSocket = new FakeSocket();
    expect(manager.joinRoom('room-start', 'p4', 'Игрок 4', fourthSocket)).toBe(false);
    expect(fourthSocket.messages).toEqual([]);

    ownerSocket.disconnect();
    const reconnectSocket = new FakeSocket();
    expect(manager.joinRoom('room-start', 'owner', 'Владелец', reconnectSocket)).toBe(true);
    expect(manager.getRoomInfo('room-start')?.playersCount).toBe(3);
  });

  it('enables chat only with ≥2 humans; keeps 50 messages', () => {
    const manager = createManagerWithRoom('room-chat');
    const ownerSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    manager.joinRoom('room-chat', 'owner', 'Владелец', ownerSocket);

    // 1 human → reject
    manager.handleAction('room-chat', 'owner', {
      type: 'CHAT_SEND',
      text: 'hello',
    });
    expect(getLastMessage(ownerSocket, 'ACTION_REJECTED')?.code).toBe('CHAT_DISABLED');

    manager.joinRoom('room-chat', 'p2', 'Игрок 2', secondSocket);

    for (let messageIndex = 0; messageIndex < 55; messageIndex += 1) {
      manager.handleAction('room-chat', 'owner', {
        type: 'CHAT_SEND',
        text: `  <b>m${messageIndex}</b>  `,
      });
    }

    const firstChat = ownerSocket.messages.find((message) => message.type === 'CHAT_MESSAGE')
      ?.payload as Record<string, unknown>;
    expect(firstChat.text).toBe('m0');

    const reconnectSocket = new FakeSocket();
    manager.joinRoom('room-chat', 'owner', 'Владелец', reconnectSocket);
    const history = getLastMessage(reconnectSocket, 'CHAT_HISTORY')?.payload as Array<
      Record<string, unknown>
    >;
    expect(history).toHaveLength(50);
    expect(history[0].text).toBe('m5');
    expect(history[49].text).toBe('m54');
  });

  it('rejects bot chat', () => {
    const manager = createManagerWithRoom('room-bot-chat');
    const human1 = new FakeSocket();
    const human2 = new FakeSocket();
    const botSocket = new FakeSocket();
    manager.joinRoom('room-bot-chat', 'h1', 'H1', human1);
    manager.joinRoom('room-bot-chat', 'h2', 'H2', human2);
    manager.joinRoom('room-bot-chat', 'bot1', 'Bot', botSocket, { isBot: true });
    manager.handleAction('room-bot-chat', 'bot1', { type: 'CHAT_SEND', text: 'nope' });
    expect(getLastMessage(botSocket, 'ACTION_REJECTED')?.code).toBe('BOTS_NO_CHAT');
  });

  it('forceDefaultAction advances a silent bidder', () => {
    const manager = createManagerWithRoom('room-timeout');
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const s3 = new FakeSocket();
    manager.joinRoom('room-timeout', 'owner', 'Owner', s1);
    manager.joinRoom('room-timeout', 'p2', 'P2', s2);
    manager.joinRoom('room-timeout', 'p3', 'P3', s3);
    manager.handleAction('room-timeout', 'owner', {
      type: 'START_GAME',
      shortPlan: true,
      shortRounds: 1,
      settings: { playersCount: 3, hasLadder: true, hasMiser: false },
    });
    const room = manager.getRoom('room-timeout');
    expect(room?.engine.state).toBe('BIDDING');
    const ok = manager.forceDefaultAction('room-timeout');
    expect(ok).toBe(true);
    expect((room?.timeoutCount ?? 0) > 0).toBe(true);
  });

  it('hides other players cards in fog of war', () => {
    const manager = createManagerWithRoom('room-fog');
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const s3 = new FakeSocket();
    manager.joinRoom('room-fog', 'owner', 'Owner', s1);
    manager.joinRoom('room-fog', 'p2', 'P2', s2);
    manager.joinRoom('room-fog', 'p3', 'P3', s3);
    manager.handleAction('room-fog', 'owner', {
      type: 'START_GAME',
      shortPlan: true,
      settings: { playersCount: 3, hasLadder: true, hasMiser: false },
    });
    const state = getLastMessage(s1, 'STATE_UPDATE')?.payload as {
      players: Array<{ id: string; cards: Array<null | { suit?: string }> }>;
    };
    const other = state.players.find((p) => p.id === 'p2');
    expect(other?.cards.every((c) => c === null)).toBe(true);
  });
});
