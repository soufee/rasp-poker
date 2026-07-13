import { buildContext, isMyTurn, type DecisionContext } from './stateSelectors';
import type { Strategy } from '../strategy/Strategy';
import { RoomConnection } from '../transport/RoomConnection';
import type { GameStatePayload, OutgoingAction } from '../protocol/types';

export interface BotClientOptions {
  host: string;
  roomId: string;
  userId: string;
  userName: string;
  token?: string;
  strategy: Strategy;
  /** Artificial think delay (ms), kept small to fit server turn budget */
  thinkDelayMs?: number;
  logger?: (line: string) => void;
}

/**
 * Wires transport + strategy. One STATE_UPDATE → at most one action.
 */
export class BotClient {
  private readonly connection: RoomConnection;
  private readonly strategy: Strategy;
  private readonly userId: string;
  private readonly userName: string;
  private readonly thinkDelayMs: number;
  private readonly log: (line: string) => void;
  private lastVersion = -1;
  private acting = false;
  private finished = false;

  public constructor(options: BotClientOptions) {
    this.userId = options.userId;
    this.userName = options.userName;
    this.strategy = options.strategy;
    this.thinkDelayMs = options.thinkDelayMs ?? 40;
    this.log = options.logger ?? ((line) => console.log(`[${options.userName}] ${line}`));
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
      this.log(`ACTION_REJECTED: ${reason}`);
      this.acting = false;
    });
    this.connection.on('error', (err) => {
      this.log(`error: ${String(err)}`);
    });
    this.connection.on('close', () => {
      this.log('socket closed');
      this.acting = false;
    });
  }

  public async start(): Promise<void> {
    await this.connection.connect();
    this.log(`connected as ${this.userId}`);
  }

  public stop(): void {
    this.connection.close();
  }

  public isFinished(): boolean {
    return this.finished;
  }

  private onState(state: GameStatePayload): void {
    if (state.state === 'MATCH_FINISHED') {
      this.finished = true;
      const me = state.players.find((p) => p.id === this.userId);
      this.log(`MATCH_FINISHED score=${me?.score ?? '?'} ranking=${JSON.stringify(state.ranking)}`);
      return;
    }

    const version = state.stateVersion ?? 0;
    if (version < this.lastVersion) {
      return;
    }

    const ctx = buildContext(state, this.userId);
    if (!ctx) {
      return;
    }

    this.strategy.observe?.(ctx);
    const action = this.decide(ctx);
    if (!action) {
      return;
    }

    // One action per version
    if (version === this.lastVersion && this.acting) {
      return;
    }
    this.lastVersion = version;
    this.acting = true;

    setTimeout(() => {
      this.connection.send(action);
      this.log(`→ ${action.type} ${JSON.stringify(action)}`);
      this.acting = false;
    }, this.thinkDelayMs);
  }

  private decide(ctx: DecisionContext): OutgoingAction | null {
    const { state } = ctx;

    if (state.state === 'WAITING_PLAYERS') {
      const should =
        this.strategy.shouldStartGame?.(ctx)
        ?? (state.hostId === this.userId
          && (state.playersCount ?? state.players.length) === state.maxPlayers);
      if (should && state.settings) {
        return {
          type: 'START_GAME',
          settings: state.settings,
          shortPlan: process.env.BOT_SHORT_PLAN === '1',
          shortRounds: 2,
        };
      }
      return null;
    }

    if (state.state === 'CONTROL_GAME_SETUP' && state.controlGameChooserId === this.userId) {
      const choice = this.strategy.chooseControlGame(ctx);
      return {
        type: 'SETUP_CONTROL',
        roundType: choice.roundType,
        dealerIndex: choice.dealerIndex,
      };
    }

    if (state.pendingTrickWinnerId) {
      return null;
    }

    if (!isMyTurn(ctx)) {
      return null;
    }

    if (state.state === 'BIDDING' && state.allowedBids && state.allowedBids.length > 0) {
      const bid = this.strategy.chooseBid(ctx);
      const safe = state.allowedBids.includes(bid) ? bid : state.allowedBids[0];
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
      const card = ctx.me.cards[cardIndex];
      const isJoker = Boolean(
        card && (card.isJoker || (card.suit === 'SPADES' && card.rank === '7')),
      );
      const jokerAction = isJoker
        ? this.strategy.chooseJokerAction(ctx, cardIndex)
        : undefined;
      return { type: 'PLAY_CARD', cardIndex, jokerAction };
    }

    return null;
  }
}
