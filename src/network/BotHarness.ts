import { roomManager } from './RoomManager';
import { GameState } from '../engine/GameEngine';
import { RoundType } from '../engine/Scoring';

interface BotCard {
  isJoker?: boolean;
}

interface BotPlayerState {
  id: string;
  cards: Array<BotCard | null>;
}

interface BotState {
  state: GameState;
  currentPlayerIndex: number;
  controlGameChooserId: string | null;
  allowedBids: number[] | null;
  validCardIndices: number[] | null;
  players: BotPlayerState[];
}

interface BotServerMessage {
  type: string;
  payload?: BotState;
}

export class BotHarness {
  private readonly bots: Map<string, string> = new Map(); // botId -> roomId

  public constructor() {}

  public addBotToRoom(roomId: string, botId: string, botName: string): void {
    this.bots.set(botId, roomId);

    const mockSocket = {
      readyState: 1, // OPEN
      send: (message: string) => {
        this.handleMessage(botId, roomId, JSON.parse(message) as BotServerMessage);
      },
      on: () => {},
      close: () => {},
    };

    roomManager.joinRoom(roomId, botId, botName, mockSocket);
  }

  private handleMessage(botId: string, roomId: string, message: BotServerMessage): void {
    if (message.type === 'STATE_UPDATE' && message.payload) {
      this.decideAction(botId, roomId, message.payload);
    }
  }

  private decideAction(botId: string, roomId: string, state: BotState): void {
    // Determine if it is our turn
    if (state.state === GameState.WAITING_PLAYERS) {
      // If 3 players are joined, someone needs to start the game
      // Just to automate testing, if the bot is the dealer or p1, maybe start it.
      // We can rely on a human to START_GAME.
      return;
    }

    if (state.state === GameState.CONTROL_GAME_SETUP && state.controlGameChooserId === botId) {
      setTimeout(() => {
        roomManager.handleAction(roomId, botId, {
          type: 'SETUP_CONTROL',
          roundType: RoundType.STANDARD, // just pick standard as fallback
          dealerIndex: 0,
        });
      }, 500);
      return;
    }

    const currentPlayer = state.players[state.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.id !== botId) {
      return;
    }

    // It is this bot's turn
    setTimeout(() => {
      if (state.state === GameState.BIDDING) {
        const allowedBids = state.allowedBids;
        if (allowedBids && allowedBids.length > 0) {
          // pick a random allowed bid
          const bid = allowedBids[Math.floor(Math.random() * allowedBids.length)];
          roomManager.handleAction(roomId, botId, { type: 'PLACE_BID', bid });
        }
      } else if (state.state === GameState.PLAYING_TRICKS) {
        const cardIndex = state.validCardIndices?.[0];
        if (cardIndex === undefined) {
          return;
        }
        const card = currentPlayer.cards[cardIndex];
        const jokerAction = card?.isJoker ? { type: 'TAKE' } : undefined;
        roomManager.handleAction(roomId, botId, {
          type: 'PLAY_CARD',
          cardIndex,
          jokerAction,
        });
      }
    }, 1000); // 1 sec delay to simulate thinking
  }
}

export const botHarness = new BotHarness();
