import { GameEngine, GameState } from '../engine/GameEngine';

interface Client {
  userId: string;
  socket: any; // WebSocket
}

class Room {
  id: string;
  engine: GameEngine;
  clients: Client[] = [];
  
  constructor(id: string, maxPlayers: number) {
    this.id = id;
    this.engine = new GameEngine(maxPlayers);
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  createRoom(roomId: string, maxPlayers: number) {
    this.rooms.set(roomId, new Room(roomId, maxPlayers));
  }

  joinRoom(roomId: string, userId: string, userName: string, socket: any) {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    // Register socket
    let client = room.clients.find(c => c.userId === userId);
    if (!client) {
      client = { userId, socket };
      room.clients.push(client);
    } else {
      client.socket = socket; // update socket on reconnect
    }

    // Add player to engine if not already in
    if (!room.engine.players.find(p => p.id === userId)) {
      room.engine.addPlayer(userId, userName);
    }

    // Attach message handler to socket
    socket.on('message', (message: string) => {
      try {
        const action = JSON.parse(message);
        this.handleAction(roomId, userId, action);
      } catch (e) {
        console.error('Invalid message format', e);
      }
    });

    socket.on('close', () => {
      // Handle disconnect (could mark as offline)
    });

    this.broadcastState(roomId);
    return true;
  }

  broadcastState(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.clients.forEach(client => {
      if (client.socket.readyState === 1) { // OPEN
        const state = this.filterEngineState(room.engine, client.userId);
        client.socket.send(JSON.stringify({ type: 'STATE_UPDATE', payload: state }));
      }
    });
  }

  private filterEngineState(engine: GameEngine, viewerId: string) {
    const isViewerTurn = engine.players[engine.currentPlayerIndex]?.id === viewerId;
    let allowedBids: number[] | null = null;
    let validCardIndices: number[] | null = null;

    if (isViewerTurn) {
      if (engine.state === GameState.BIDDING) {
        allowedBids = engine.getAvailableBids(engine.currentPlayerIndex);
      } else if (engine.state === GameState.PLAYING_TRICKS) {
        // Find valid cards (for simplicity we can send all indices, or filter)
        // A card is valid if playCard(viewerId, idx) would succeed. But playCard modifies state!
        // We can just rely on the frontend to try, or implement a validation method in engine.
      }
    }

    // Copy the engine state, but obscure other players' cards and the deck
    const state = {
      state: engine.state,
      maxPlayers: engine.maxPlayers,
      dealerIndex: engine.dealerIndex,
      currentPlayerIndex: engine.currentPlayerIndex,
      trumpSuit: engine.trumpSuit,
      tableCards: engine.tableCards,
      currentRoundCards: engine.currentRoundCards,
      currentRoundType: engine.currentRoundType,
      isDarkRound: engine.isDarkRound,
      plan: engine.plan,
      currentRoundIndex: engine.currentRoundIndex,
      controlGamesPlayed: engine.controlGamesPlayed,
      controlGameChooserId: engine.controlGameChooserId,
      allowedBids,
      players: engine.players.map(p => {
        if (p.id === viewerId) {
          // If Dark round, player cannot see their own cards until bidding is over
          const hideSelf = engine.isDarkRound && engine.state === GameState.BIDDING;
          return {
             ...p,
             cards: hideSelf ? p.cards.map(() => null) : p.cards
          };
        } else {
          // Hide others cards
          return {
             ...p,
             cards: p.cards.map(() => null)
          };
        }
      })
    };
    return state;
  }

  handleAction(roomId: string, userId: string, action: any) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (action.type === 'PLACE_BID') {
      room.engine.placeBid(userId, action.bid);
    } else if (action.type === 'PLAY_CARD') {
      room.engine.playCard(userId, action.cardIndex, action.jokerAction);
    } else if (action.type === 'START_GAME') {
      room.engine.startGame(action.settings);
    } else if (action.type === 'SETUP_CONTROL') {
      room.engine.setupControlGame(userId, action.roundType, action.dealerIndex);
    }

    this.broadcastState(roomId);
  }
}

export const roomManager = new RoomManager();
// Create a default test room
roomManager.createRoom('test-room', 3);
