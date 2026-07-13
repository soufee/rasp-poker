import { roomManager } from './RoomManager';
import { GameState } from '../engine/GameEngine';
import { RoundType } from '../engine/Scoring';
import { antigravityStrategy } from './AntigravityStrategy';

export type BotProfile = 'tight' | 'aggressive' | 'random' | 'antigravity';

interface BotCard {
  suit?: 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS';
  rank?: '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
  isJoker?: boolean;
}

interface BotPlayerState {
  id: string;
  cards: Array<BotCard | null>;
  isBot?: boolean;
  name: string;
  score: number;
  currentBid: number | null;
  tricksTaken: number;
}

interface LegalPlay {
  cardIndex: number;
  jokerActions?: Array<{ type: string; suit?: string }>;
}

interface BotState {
  state: GameState;
  stateVersion: number;
  currentPlayerIndex: number;
  controlGameChooserId: string | null;
  allowedBids: number[] | null;
  validCardIndices: number[] | null;
  legalPlays?: LegalPlay[];
  hostId?: string;
  playersCount?: number;
  maxPlayers?: number;
  playedRoundTypes?: string[];
  players: BotPlayerState[];
  trumpSuit: 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS' | null;
  currentTrickLeadSuit: 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS' | null;
  currentRoundType: string;
  tableCards: Array<{
    playerId: string;
    card: { suit: 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS'; rank: '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'; isJoker?: boolean };
    jokerAction?: any;
  }>;
}

interface BotServerMessage {
  type: string;
  payload?: BotState;
}

interface BotInstance {
  roomId: string;
  profile: BotProfile;
  lastVersion: number;
}

const BOT_PROFILES: Array<{ id: string; name: string; profile: BotProfile }> = [
  { id: 'bot-tight', name: 'TightBot', profile: 'tight' },
  { id: 'bot-aggro', name: 'AggroBot', profile: 'aggressive' },
  { id: 'bot-random', name: 'RandomBot', profile: 'random' },
  { id: 'bot-antigravity', name: 'Antigravity', profile: 'antigravity' },
];

export class BotHarness {
  private readonly bots = new Map<string, BotInstance>();

  public addBotToRoom(
    roomId: string,
    botId: string,
    botName: string,
    profile: BotProfile = 'random',
  ): void {
    this.bots.set(botId, { roomId, profile, lastVersion: -1 });

    const mockSocket = {
      readyState: 1,
      send: (message: string) => {
        this.handleMessage(botId, roomId, JSON.parse(message) as BotServerMessage);
      },
      on: () => {},
      close: () => {},
    };

    roomManager.joinRoom(roomId, botId, botName, mockSocket, { isBot: true });
  }

  /** Fill room with three distinct bots and auto-start short or full match. */
  public fillWithThreeBots(
    roomId: string,
    options: { shortPlan?: boolean; ownerId?: string } = {},
  ): void {
    for (const bot of BOT_PROFILES) {
      // If filling, add the tight, aggro, and antigravity bots
      if (bot.profile !== 'random') {
        this.addBotToRoom(roomId, bot.id, bot.name, bot.profile);
      }
    }
    const room = roomManager.getRoom(roomId);
    if (!room) {
      return;
    }
    const hostId = options.ownerId ?? room.ownerId;
    // Host may be a bot if room created for smoke
    roomManager.handleAction(roomId, hostId, {
      type: 'START_GAME',
      shortPlan: options.shortPlan !== false,
      shortRounds: 2,
      settings: {
        playersCount: room.maxPlayers,
        hasLadder: room.settings.hasLadder,
        hasMiser: room.settings.hasMiser,
      },
    });
  }

  private handleMessage(botId: string, roomId: string, message: BotServerMessage): void {
    if (message.type === 'STATE_UPDATE' && message.payload) {
      this.decideAction(botId, roomId, message.payload);
    }
  }

  private decideAction(botId: string, roomId: string, state: BotState): void {
    const bot = this.bots.get(botId);
    if (!bot) {
      return;
    }

    // Stale callback / version guard
    if (state.stateVersion <= bot.lastVersion && state.state !== GameState.WAITING_PLAYERS) {
      // allow same version only once
    }
    bot.lastVersion = state.stateVersion;

    if (state.state === GameState.WAITING_PLAYERS) {
      return;
    }

    if (state.state === GameState.MATCH_FINISHED) {
      return;
    }

    const profile = bot.profile;

    if (state.state === GameState.CONTROL_GAME_SETUP && state.controlGameChooserId === botId) {
      const types = state.playedRoundTypes ?? [];
      let roundType = types.includes(RoundType.STANDARD)
        ? RoundType.STANDARD
        : (types[0] as RoundType) || RoundType.STANDARD;
      let dealerIndex = Math.max(
        0,
        state.players.findIndex((p) => p.id === botId),
      );

      if (profile === 'antigravity') {
        const choice = antigravityStrategy.chooseControlGame(state as any, botId);
        roundType = choice.roundType;
        dealerIndex = choice.dealerIndex;
      }

      setTimeout(() => {
        const current = this.bots.get(botId);
        if (!current || current.lastVersion !== state.stateVersion) {
          return;
        }
        roomManager.handleAction(roomId, botId, {
          type: 'SETUP_CONTROL',
          roundType,
          dealerIndex,
        });
      }, 50);
      return;
    }

    const currentPlayer = state.players[state.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.id !== botId) {
      return;
    }

    const version = state.stateVersion;

    setTimeout(() => {
      const current = this.bots.get(botId);
      if (!current || current.lastVersion !== version) {
        return;
      }

      if (state.state === GameState.BIDDING) {
        const allowedBids = state.allowedBids;
        if (!allowedBids || allowedBids.length === 0) {
          return;
        }
        const bid = profile === 'antigravity'
          ? antigravityStrategy.chooseBid(state as any, botId)
          : this.pickBid(profile, allowedBids);
        roomManager.handleAction(roomId, botId, { type: 'PLACE_BID', bid });
        return;
      }

      if (state.state === GameState.PLAYING_TRICKS) {
        const plays = state.legalPlays ?? [];
        if (plays.length === 0) {
          const fallback = state.validCardIndices?.[0];
          if (fallback === undefined) {
            return;
          }
          roomManager.handleAction(roomId, botId, {
            type: 'PLAY_CARD',
            cardIndex: fallback,
            jokerAction: { type: 'TAKE' },
          });
          return;
        }

        if (profile === 'antigravity') {
          const play = antigravityStrategy.choosePlay(state as any, botId, plays);
          roomManager.handleAction(roomId, botId, {
            type: 'PLAY_CARD',
            cardIndex: play.cardIndex,
            jokerAction: play.jokerActions?.[0],
          });
        } else {
          const play = this.pickPlay(profile, plays, currentPlayer);
          roomManager.handleAction(roomId, botId, {
            type: 'PLAY_CARD',
            cardIndex: play.cardIndex,
            jokerAction: play.jokerActions?.[0],
          });
        }
      }
    }, 30);
  }

  private pickBid(profile: BotProfile, allowed: number[]): number {
    const sorted = [...allowed].sort((a, b) => a - b);
    if (profile === 'tight') {
      return sorted[0];
    }
    if (profile === 'aggressive') {
      return sorted[sorted.length - 1];
    }
    return sorted[Math.floor(Math.random() * sorted.length)];
  }

  private pickPlay(
    profile: BotProfile,
    plays: LegalPlay[],
    player: BotPlayerState,
  ): LegalPlay {
    if (profile === 'aggressive') {
      const withJoker = plays.find((p) => player.cards[p.cardIndex]?.isJoker);
      if (withJoker) {
        return {
          ...withJoker,
          jokerActions: withJoker.jokerActions?.filter((a) => a.type === 'TAKE')
            ?? [{ type: 'TAKE' }],
        };
      }
      return plays[plays.length - 1];
    }
    if (profile === 'tight') {
      return plays[0];
    }
    return plays[Math.floor(Math.random() * plays.length)];
  }
}

export const botHarness = new BotHarness();
export { BOT_PROFILES };

