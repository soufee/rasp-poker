import { buildContext, isMyTurn } from './stateSelectors';
import { RoomConnection } from '../transport/RoomConnection';
import type { Strategy } from '../strategy/Strategy';
import type { GameStatePayload, OutgoingAction } from '../protocol/types';

export interface ClaudeDriverOptions {
  host: string;
  roomId: string;
  userId: string;
  userName: string;
  token?: string;
  strategy: Strategy;
  thinkDelayMs: number;
  shortPlan: boolean;
}

/**
 * Strategy-agnostic seat driver used by the Claude runner. It mirrors the shared
 * BotClient decision loop but exposes the last observed state and a finished flag,
 * which the arena needs to print a scoreboard. Kept separate so the shared
 * BotClient stays untouched.
 */
export class ClaudeDriver {
  private readonly connection: RoomConnection;
  private latest: GameStatePayload | null = null;
  private lastVersion = -1;
  private acting = false;
  private finished = false;

  public constructor(private readonly options: ClaudeDriverOptions) {
    this.connection = new RoomConnection({
      host: options.host,
      roomId: options.roomId,
      userId: options.userId,
      userName: options.userName,
      token: options.token,
      reconnect: true,
    });
    this.connection.on('state', (state) => this.onState(state));
    this.connection.on('rejected', (reason) => {
      console.warn(`[${options.userName}] rejected: ${reason}`);
      this.acting = false;
    });
  }

  public async start(): Promise<void> {
    await this.connection.connect();
  }

  public stop(): void {
    this.connection.close();
  }

  public isFinished(): boolean {
    return this.finished;
  }

  public lastState(): GameStatePayload | null {
    return this.latest;
  }

  private onState(state: GameStatePayload): void {
    this.latest = state;
    if (state.state === 'MATCH_FINISHED') {
      this.finished = true;
      return;
    }

    const version = state.stateVersion ?? 0;
    if (version < this.lastVersion) {
      return;
    }
    const action = this.decide(state);
    if (!action) {
      return;
    }
    if (version === this.lastVersion && this.acting) {
      return;
    }
    this.lastVersion = version;
    this.acting = true;
    setTimeout(() => {
      this.connection.send(action);
      this.acting = false;
    }, this.options.thinkDelayMs);
  }

  private decide(state: GameStatePayload): OutgoingAction | null {
    const context = buildContext(state, this.options.userId);
    if (!context) {
      return null;
    }
    const strategy = this.options.strategy;

    if (state.state === 'WAITING_PLAYERS') {
      const shouldStart =
        strategy.shouldStartGame?.(context)
        ?? (state.hostId === this.options.userId
          && (state.playersCount ?? state.players.length) === state.maxPlayers);
      if (shouldStart && state.settings) {
        return {
          type: 'START_GAME',
          settings: state.settings,
          shortPlan: this.options.shortPlan,
          shortRounds: 2,
        };
      }
      return null;
    }

    if (state.state === 'CONTROL_GAME_SETUP' && state.controlGameChooserId === this.options.userId) {
      const choice = strategy.chooseControlGame(context);
      return {
        type: 'SETUP_CONTROL',
        roundType: choice.roundType,
        dealerIndex: choice.dealerIndex,
      };
    }

    if (!isMyTurn(context)) {
      return null;
    }

    if (state.state === 'BIDDING' && state.allowedBids && state.allowedBids.length > 0) {
      const bid = strategy.chooseBid(context);
      const safe = state.allowedBids.includes(bid) ? bid : state.allowedBids[0];
      return { type: 'PLACE_BID', bid: safe };
    }

    if (state.state === 'PLAYING_TRICKS') {
      const legal = state.validCardIndices ?? [];
      if (legal.length === 0) {
        return null;
      }
      let cardIndex = strategy.chooseCard(context);
      if (!legal.includes(cardIndex)) {
        cardIndex = legal[0];
      }
      const card = context.me.cards[cardIndex];
      const joker = Boolean(
        card && (card.isJoker || (card.suit === 'SPADES' && card.rank === '7')),
      );
      const jokerAction = joker ? strategy.chooseJokerAction(context, cardIndex) : undefined;
      return { type: 'PLAY_CARD', cardIndex, jokerAction };
    }

    return null;
  }
}
