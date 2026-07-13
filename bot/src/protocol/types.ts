export type Suit = 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS';

export type Rank = '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export type RoundType =
  | 'STANDARD'
  | 'DARK'
  | 'PERCENTS'
  | 'NO_TRUMP'
  | 'GOLD'
  | 'MISER';

export type GamePhase =
  | 'WAITING_PLAYERS'
  | 'SHUFFLING_AND_DEALING'
  | 'BIDDING'
  | 'PLAYING_TRICKS'
  | 'SCORING'
  | 'CONTROL_GAME_SETUP'
  | 'MATCH_FINISHED';

export interface CardView {
  suit: Suit;
  rank: Rank;
  isJoker?: boolean;
}

export type JokerAction =
  | { type: 'TAKE' }
  | { type: 'DEMAND_SUIT'; suit: Suit }
  | { type: 'DROP'; suit?: Suit };

export interface PlayedCardView {
  playerId: string;
  card: CardView;
  jokerAction?: JokerAction;
}

export interface LegalPlay {
  cardIndex: number;
  jokerActions?: JokerAction[];
}

export interface PlayerView {
  id: string;
  name: string;
  cards: Array<CardView | null>;
  score: number;
  currentBid: number | null;
  tricksTaken: number;
  connected: boolean;
  isBot: boolean;
}

export interface RoundSpecView {
  roundNumber: number;
  type: RoundType;
  cardsInHand: number;
  dealerIndex: number;
}

export interface GameStateView {
  state: GamePhase;
  stateVersion: number;
  viewerId: string;
  hostId: string;
  maxPlayers: number;
  settings: { playersCount: number; hasLadder: boolean; hasMiser: boolean };
  playersCount: number;
  dealerIndex: number;
  currentPlayerIndex: number;
  trumpSuit: Suit | null;
  trumpCard: CardView | null;
  tableCards: PlayedCardView[];
  currentTrickLeadSuit: Suit | null;
  currentRoundCards: number;
  currentRoundType: RoundType;
  isDarkRound: boolean;
  plan: RoundSpecView[];
  currentRoundIndex: number;
  playedRoundTypes: RoundType[];
  controlGamesPlayed: number;
  controlGameChooserId: string | null;
  allowedBids: number[] | null;
  validCardIndices: number[] | null;
  legalPlays: LegalPlay[];
  players: PlayerView[];
}

export interface StartGameSettings {
  playersCount: number;
  hasLadder: boolean;
  hasMiser: boolean;
}

export type OutgoingAction =
  | { type: 'START_GAME'; settings: StartGameSettings; shortPlan?: boolean; shortRounds?: number }
  | { type: 'PLACE_BID'; bid: number }
  | { type: 'PLAY_CARD'; cardIndex: number; jokerAction?: JokerAction }
  | { type: 'SETUP_CONTROL'; roundType: RoundType; dealerIndex: number }
  | { type: 'PING' };

export interface ServerMessage {
  type: string;
  payload?: unknown;
  message?: string;
  code?: string;
}
