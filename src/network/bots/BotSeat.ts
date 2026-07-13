import { roomManager, RoomSocket } from '../RoomManager';
import type { BotDecisionContext, BotStrategy } from './loader';

const OPEN_SOCKET_STATE = 1;

interface CardView {
  suit?: string;
  rank?: string;
  isJoker?: boolean;
}

interface PlayerView {
  id: string;
  cards: Array<CardView | null>;
}

interface StatePayload {
  state: string;
  stateVersion?: number;
  currentPlayerIndex: number;
  controlGameChooserId?: string | null;
  allowedBids?: number[] | null;
  validCardIndices?: number[] | null;
  pendingTrickWinnerId?: string | null;
  players: PlayerView[];
}

interface ServerMessage {
  type: string;
  payload?: StatePayload;
}

/**
 * One in-process bot occupying a single seat. It reuses the same fog-of-war
 * STATE_UPDATE stream that human clients receive (via a lightweight in-memory
 * socket) and turns strategy decisions into RoomManager actions. At most one
 * action is emitted per state version.
 */
export class BotSeat {
  private readonly roomId: string;
  private readonly userId: string;
  private readonly userName: string;
  private readonly strategy: BotStrategy;
  private readonly thinkDelayMs: number;
  private lastVersion = -1;
  private acting = false;
  private disposed = false;

  public constructor(
    roomId: string,
    userId: string,
    userName: string,
    strategy: BotStrategy,
    thinkDelayMs = 350,
  ) {
    this.roomId = roomId;
    this.userId = userId;
    this.userName = userName;
    this.strategy = strategy;
    this.thinkDelayMs = thinkDelayMs;
  }

  public get id(): string {
    return this.userId;
  }

  public seat(): boolean {
    const socket: RoomSocket = {
      readyState: OPEN_SOCKET_STATE,
      send: (data: string) => {
        this.onMessage(data);
      },
      on: () => undefined,
    };
    return roomManager.joinRoom(this.roomId, this.userId, this.userName, socket, { isBot: true });
  }

  public dispose(): void {
    this.disposed = true;
  }

  private onMessage(data: string): void {
    if (this.disposed) {
      return;
    }
    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    if (message.type !== 'STATE_UPDATE' || !message.payload) {
      return;
    }
    this.onState(message.payload);
  }

  private onState(state: StatePayload): void {
    if (state.state === 'MATCH_FINISHED') {
      this.disposed = true;
      return;
    }

    const version = state.stateVersion ?? 0;
    if (version < this.lastVersion) {
      return;
    }

    const ctx = this.buildContext(state);
    if (!ctx) {
      return;
    }
    this.strategy.observe?.(ctx);

    // A completed trick is being shown; wait until it is collected.
    if (state.pendingTrickWinnerId) {
      return;
    }
    const action = this.decide(ctx);
    if (!action) {
      return;
    }

    if (version === this.lastVersion && this.acting) {
      return;
    }
    this.lastVersion = version;
    this.acting = true;

    setTimeout(() => {
      this.acting = false;
      if (this.disposed) {
        return;
      }
      roomManager.handleAction(this.roomId, this.userId, action);
    }, this.thinkDelayMs);
  }

  private buildContext(state: StatePayload): BotDecisionContext | null {
    const myIndex = state.players.findIndex((player) => player.id === this.userId);
    if (myIndex < 0) {
      return null;
    }
    return {
      state: state as unknown as Record<string, unknown>,
      myId: this.userId,
      myIndex,
      me: state.players[myIndex] as unknown as Record<string, unknown>,
    };
  }

  private decide(ctx: BotDecisionContext): Record<string, unknown> | null {
    const state = ctx.state as unknown as StatePayload;

    if (state.state === 'CONTROL_GAME_SETUP' && state.controlGameChooserId === this.userId) {
      const choice = this.strategy.chooseControlGame(ctx);
      return {
        type: 'SETUP_CONTROL',
        roundType: choice.roundType,
        dealerIndex: choice.dealerIndex,
      };
    }

    if (state.currentPlayerIndex !== ctx.myIndex) {
      return null;
    }

    if (state.state === 'BIDDING') {
      const allowed = state.allowedBids ?? [];
      if (allowed.length === 0) {
        return null;
      }
      const bid = this.strategy.chooseBid(ctx);
      const safe = allowed.includes(bid) ? bid : allowed[0];
      return { type: 'PLACE_BID', bid: safe };
    }

    if (state.state === 'PLAYING_TRICKS') {
      const legal = state.validCardIndices ?? [];
      if (legal.length === 0) {
        return null;
      }
      let cardIndex = this.strategy.chooseCard(ctx);
      if (!legal.includes(cardIndex)) {
        cardIndex = legal[0];
      }
      const myCards = (ctx.me as unknown as PlayerView).cards;
      const card = myCards[cardIndex] as CardView | null | undefined;
      const isJoker = Boolean(
        card && (card.isJoker === true || (card.suit === 'SPADES' && card.rank === '7')),
      );
      const jokerAction = isJoker ? this.strategy.chooseJokerAction(ctx, cardIndex) : undefined;
      return { type: 'PLAY_CARD', cardIndex, jokerAction };
    }

    return null;
  }
}
