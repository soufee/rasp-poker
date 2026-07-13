import { Deck } from './Deck';
import { Card, Suit } from './Card';

export enum GameState {
  WAITING_PLAYERS = 'WAITING_PLAYERS',
  SHUFFLING_AND_DEALING = 'SHUFFLING_AND_DEALING',
  BIDDING = 'BIDDING',
  PLAYING_TRICKS = 'PLAYING_TRICKS',
  SCORING = 'SCORING',
  CONTROL_GAME_SETUP = 'CONTROL_GAME_SETUP',
  MATCH_FINISHED = 'MATCH_FINISHED'
}

export interface Player {
  id: string;
  name: string;
  cards: Card[];
  score: number;
  currentBid: number | null;
  tricksTaken: number;
}

export class GameEngine {
  public state: GameState = GameState.WAITING_PLAYERS;
  public players: Player[] = [];
  public maxPlayers: number;
  public dealerIndex: number = 0;
  public currentPlayerIndex: number = 0;
  public deck: Deck;
  public trumpSuit: Suit | null = null;
  public tableCards: { playerId: string, card: Card }[] = [];

  constructor(maxPlayers: number = 3) {
    this.maxPlayers = maxPlayers;
    this.deck = new Deck();
  }

  public addPlayer(id: string, name: string): boolean {
    if (this.state !== GameState.WAITING_PLAYERS) return false;
    if (this.players.length >= this.maxPlayers) return false;
    
    this.players.push({
      id,
      name,
      cards: [],
      score: 0,
      currentBid: null,
      tricksTaken: 0
    });

    if (this.players.length === this.maxPlayers) {
      this.transitionTo(GameState.SHUFFLING_AND_DEALING);
    }

    return true;
  }

  public transitionTo(newState: GameState) {
    this.state = newState;
    
    switch (newState) {
      case GameState.SHUFFLING_AND_DEALING:
        this.handleDealingPhase();
        break;
      case GameState.BIDDING:
        // Set first bidder (left of dealer)
        this.currentPlayerIndex = this.getNextPlayerIndex(this.dealerIndex);
        break;
      case GameState.PLAYING_TRICKS:
        // First trick lead (left of dealer initially, or trick winner later)
        // In full implementation, trick winner will be set here
        this.currentPlayerIndex = this.getNextPlayerIndex(this.dealerIndex);
        break;
      case GameState.SCORING:
        // Score calculation goes here
        break;
      case GameState.CONTROL_GAME_SETUP:
        // Wait for lowest scorer to pick setup
        break;
      case GameState.MATCH_FINISHED:
        break;
    }
  }

  public getNextPlayerIndex(currentIndex: number): number {
    return (currentIndex + 1) % this.players.length;
  }

  public advanceTurn() {
    this.currentPlayerIndex = this.getNextPlayerIndex(this.currentPlayerIndex);
  }

  private handleDealingPhase() {
    // Basic dealing stub for now
    this.deck.generateAndShuffleDeck();
    
    // Default to deal 1 card for now
    const cardsToDeal = 1;
    for (let i = 0; i < cardsToDeal; i++) {
      for (const player of this.players) {
        const card = this.deck.cards.pop();
        if (card) player.cards.push(card);
      }
    }

    if (this.deck.cards.length > 0) {
      const trumpCard = this.deck.cards[this.deck.cards.length - 1];
      this.trumpSuit = trumpCard.suit;
    } else {
      this.trumpSuit = null; // No trump (or special round)
    }

    this.transitionTo(GameState.BIDDING);
  }
}
