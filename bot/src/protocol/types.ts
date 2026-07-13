/** Server contract — keep in sync with client/src/types/game.ts */

export type Suit = 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS';
export type Rank = '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type RoundType = 'STANDARD' | 'DARK' | 'PERCENTS' | 'NO_TRUMP' | 'GOLD' | 'MISER';
export type GamePhase =
  | 'WAITING_PLAYERS'
  | 'SHUFFLING_AND_DEALING'
  | 'BIDDING'
  | 'PLAYING_TRICKS'
  | 'SCORING'
  | 'CONTROL_GAME_SETUP'
  | 'MATCH_FINISHED';

export interface CardModel {
  suit: Suit;
  rank: Rank;
  isJoker?: boolean;
}

/** Alias used by optional helpers */
export type CardView = CardModel;

export type JokerAction =
  | { type: 'TAKE' }
  | { type: 'DEMAND_SUIT'; suit: Suit }
  | { type: 'DROP'; suit?: Suit };

export interface PlayedCard {
  playerId: string;
  card: CardModel;
  jokerAction?: JokerAction;
}

export interface PlayerState {
  id: string;
  name: string;
  cards: Array<CardModel | null>;
  score: number;
  currentBid: number | null;
  tricksTaken: number;
  connected?: boolean;
  isBot?: boolean;
}

export interface GameStatePayload {
  state: GamePhase;
  viewerId?: string;
  hostId?: string;
  maxPlayers: 3 | 4 | 6;
  settings?: { playersCount: 3 | 4 | 6; hasLadder: boolean; hasMiser: boolean };
  playersCount?: number;
  dealerIndex: number;
  currentPlayerIndex: number;
  trumpSuit: Suit | null;
  trumpCard?: CardModel | null;
  currentTrickLeadSuit?: Suit | null;
  pendingTrickWinnerId?: string | null;
  tableCards: PlayedCard[];
  currentRoundType: RoundType;
  currentRoundCards: number;
  isDarkRound: boolean;
  plan?: Array<{ roundNumber: number; type: RoundType; cardsInHand: number; dealerIndex: number }>;
  currentRoundIndex?: number;
  playedRoundTypes?: RoundType[];
  scoreHistory?: Array<{
    roundNumber: number;
    roundType: RoundType;
    cardsInHand: number;
    scores: Record<string, number>;
    bids?: Record<string, number | null>;
    tricks?: Record<string, number>;
  }>;
  controlGamesPlayed?: number;
  controlGameChooserId?: string | null;
  allowedBids: number[] | null;
  validCardIndices?: number[] | null;
  legalPlays?: Array<{ cardIndex: number; jokerActions?: JokerAction[] }>;
  players: PlayerState[];
  stateVersion?: number;
  turnDeadlineAt?: number | null;
  ranking?: unknown[];
}

export type OutgoingAction =
  | {
      type: 'START_GAME';
      settings: { playersCount: 3 | 4 | 6; hasLadder: boolean; hasMiser: boolean };
      shortPlan?: boolean;
      shortRounds?: number;
    }
  | { type: 'PLACE_BID'; bid: number }
  | { type: 'PLAY_CARD'; cardIndex: number; jokerAction?: JokerAction }
  | { type: 'SETUP_CONTROL'; roundType: RoundType; dealerIndex: number }
  | { type: 'CHAT_SEND'; text: string };

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  text: string;
  createdAt: string;
}

export type IncomingMessage =
  | { type: 'STATE_UPDATE'; payload: GameStatePayload }
  | { type: 'ROOM_INFO'; payload: Record<string, unknown> }
  | { type: 'CHAT_HISTORY'; payload: ChatMessage[] }
  | { type: 'CHAT_MESSAGE'; payload: ChatMessage }
  | { type: 'ACTION_REJECTED'; message: string; code?: string }
  | { type: 'TURN_TIMEOUT'; payload?: unknown }
  | { type: 'SYSTEM'; message?: string }
  | { type: 'ERROR'; message: string; code?: string };
