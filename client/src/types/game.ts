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
  rank: Rank;
  suit: Suit;
  isJoker?: boolean;
}

export type JokerAction =
  { type: 'TAKE' } | { type: 'DEMAND_SUIT'; suit: Suit } | { type: 'DROP'; suit?: Suit };

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
  avatarUrl?: string;
  connected?: boolean;
  isReady?: boolean;
}

export interface RoundPlanItem {
  roundNumber: number;
  type: RoundType;
  cardsInHand: number;
  dealerIndex: number;
}

export interface RoundScore {
  roundNumber: number;
  roundType: RoundType;
  cardsInHand: number;
  scores: Record<string, number>;
  bids?: Record<string, number | null>;
  tricks?: Record<string, number>;
}

export interface GameSnapshot {
  viewerId?: string;
  hostId?: string;
  state: GamePhase;
  maxPlayers: 3 | 4 | 6;
  dealerIndex: number;
  currentPlayerIndex: number;
  trumpSuit: Suit | null;
  tableCards: PlayedCard[];
  currentRoundCards: number;
  currentRoundType: RoundType;
  isDarkRound: boolean;
  plan: RoundPlanItem[];
  currentRoundIndex: number;
  controlGamesPlayed: number;
  controlGameChooserId: string | null;
  playedRoundTypes?: RoundType[];
  allowedBids: number[] | null;
  validCardIndices?: number[] | null;
  players: PlayerState[];
  scoreHistory?: RoundScore[];
}

export interface RoomSettings {
  playersCount: 3 | 4 | 6;
  hasLadder: boolean;
  hasMiser: boolean;
}

export interface RoomSummary {
  id: string;
  name: string;
  playersCount: number;
  maxPlayers: 3 | 4 | 6;
  isPrivate: boolean;
  status: 'waiting' | 'playing' | 'finished';
  ownerName?: string;
  settings?: RoomSettings;
}

export interface RoomInfo {
  id: string;
  name: string;
  hostId?: string;
  ownerId?: string;
  ownerName?: string;
  maxPlayers: 3 | 4 | 6;
  playersCount?: number;
  settings?: RoomSettings;
  isPrivate?: boolean;
  inviteCode?: string;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  text: string;
  createdAt: string;
}

export interface SessionUser {
  id: string;
  email?: string;
  displayName: string;
  role?: string;
  verified: boolean;
  isGuest?: boolean;
}

export interface Session {
  token?: string;
  user: SessionUser;
}

export interface Preferences {
  sound: boolean;
  reducedMotion: boolean;
  compactCards: boolean;
  chatOpen: boolean;
}

export type IncomingRoomEvent =
  | { type: 'STATE_UPDATE'; payload: GameSnapshot }
  | { type: 'ROOM_INFO'; payload: RoomInfo }
  | { type: 'CHAT_HISTORY'; payload: ChatMessage[] }
  | { type: 'CHAT_MESSAGE'; payload: ChatMessage }
  | { type: 'ACTION_REJECTED'; message: string }
  | { type: 'ERROR'; message: string };

export type OutgoingRoomEvent =
  | { type: 'START_GAME'; settings: RoomSettings }
  | { type: 'PLACE_BID'; bid: number }
  | {
      type: 'PLAY_CARD';
      cardIndex: number;
      jokerAction?: JokerAction;
    }
  | {
      type: 'SETUP_CONTROL';
      roundType: RoundType;
      dealerIndex: number;
    }
  | { type: 'CHAT_SEND'; text: string };

export type ConnectionStatus =
  'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
