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
  public currentRoundCards: number = 1;
  public isDarkRound: boolean = false;

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

  public getAvailableBids(playerIndex: number): number[] {
    const isDealer = playerIndex === this.dealerIndex;
    const maxBid = this.currentRoundCards;
    let allowedBids: number[] = [];

    // All bids from 0 to maxBid are initially allowed
    for (let i = 0; i <= maxBid; i++) allowedBids.push(i);

    // Rule: consecutive passes limit
    const consecutivePassesAllowed = this.maxPlayers === 3 ? 2 : this.maxPlayers === 4 ? 3 : 4;
    let currentPasses = 0;
    
    // Check previous players' bids
    // To do this properly, we trace back from the current player to the start of the bidding round.
    // The bidding starts at getNextPlayerIndex(dealerIndex).
    let checkIdx = this.getNextPlayerIndex(this.dealerIndex);
    while (checkIdx !== playerIndex) {
      if (this.players[checkIdx].currentBid === 0) {
        currentPasses++;
      } else {
        currentPasses = 0; // Reset consecutive passes
      }
      checkIdx = this.getNextPlayerIndex(checkIdx);
    }

    let restrictPass = false;
    if (currentPasses >= consecutivePassesAllowed) {
      restrictPass = true;
    }

    // Rule: "Except" for dealer
    let exceptBid: number | null = null;
    if (isDealer) {
      const sumBids = this.players.reduce((sum, p) => sum + (p.currentBid || 0), 0);
      exceptBid = maxBid - sumBids;
    }

    // Apply restrictions
    if (restrictPass) {
      allowedBids = allowedBids.filter(b => b !== 0);
    }

    if (isDealer && exceptBid !== null) {
      allowedBids = allowedBids.filter(b => b !== exceptBid);
    }

    // Collision resolution: if dealer has no allowed bids (e.g., 1 card, pass limit reached, and exceptBid is 1)
    // The "Except" rule overrides pass limit, so we allow 0.
    if (allowedBids.length === 0 && isDealer && exceptBid === 1 && restrictPass) {
       allowedBids = [0];
    }

    return allowedBids;
  }

  public placeBid(playerId: string, bid: number): boolean {
    if (this.state !== GameState.BIDDING) return false;
    
    const pIndex = this.players.findIndex(p => p.id === playerId);
    if (pIndex !== this.currentPlayerIndex) return false;

    const allowedBids = this.getAvailableBids(pIndex);
    if (!allowedBids.includes(bid)) return false;

    this.players[pIndex].currentBid = bid;

    // Advance turn or transition to playing tricks
    if (pIndex === this.dealerIndex) {
      this.transitionTo(GameState.PLAYING_TRICKS);
    } else {
      this.advanceTurn();
    }

    return true;
  }
}
