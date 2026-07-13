import { roomManager } from './RoomManager';
import { GameState } from '../engine/GameEngine';
import { RoundType } from '../engine/Scoring';

export class BotHarness {
  private bots: Map<string, string> = new Map(); // botId -> roomId

  constructor() {}

  addBotToRoom(roomId: string, botId: string, botName: string) {
    this.bots.set(botId, roomId);

    const mockSocket = {
      readyState: 1, // OPEN
      send: (message: string) => {
        this.handleMessage(botId, roomId, JSON.parse(message));
      },
      on: () => {},
      close: () => {}
    };

    roomManager.joinRoom(roomId, botId, botName, mockSocket);
  }

  private handleMessage(botId: string, roomId: string, message: any) {
    if (message.type === 'STATE_UPDATE') {
      const state = message.payload;
      this.decideAction(botId, roomId, state);
    }
  }

  private decideAction(botId: string, roomId: string, state: any) {
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
          dealerIndex: 0
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
        // Just try playing cards until one is valid
        // Real bot should validate follow suit correctly
        const hand = currentPlayer.cards;
        for (let i = 0; i < hand.length; i++) {
          const card = hand[i];
          let jokerAction = undefined;
          if (card && card.isJoker) {
            jokerAction = { type: 'TAKE' }; // Simple strategy: always take with joker
          }
          
          const prevTableCount = state.tableCards ? state.tableCards.length : 0;
          roomManager.handleAction(roomId, botId, { type: 'PLAY_CARD', cardIndex: i, jokerAction });
          // Note: RoomManager broadcastState will be called. If playCard was valid, state will update.
          // In a real harness, we'd check if it actually advanced, but for now this blind loop is a basic stub
          // Actually, we shouldn't spam handleAction in a loop if it succeeds.
          // Fastify is single threaded, handleAction is sync.
          // If it succeeded, currentPlayerIndex changed, so we're good.
        }
      }
    }, 1000); // 1 sec delay to simulate thinking
  }
}

export const botHarness = new BotHarness();
