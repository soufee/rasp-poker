import { Deck } from './Deck';
import { Card, Suit, Rank } from './Card';
import { RoundPlanner, RoundSpec, PlannerSettings } from './RoundPlanner';
import { RoundType, calculatePlayerScore } from './Scoring';

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

export type JokerAction = 
  | { type: 'TAKE' }
  | { type: 'DEMAND_SUIT', suit: Suit }
  | { type: 'DROP', suit?: Suit }; // suit required if played first

export interface PlayedCard {
  playerId: string;
  card: Card;
  jokerAction?: JokerAction;
}

export class GameEngine {
  public state: GameState = GameState.WAITING_PLAYERS;
  public players: Player[] = [];
  public maxPlayers: number;
  public dealerIndex: number = 0;
  public currentPlayerIndex: number = 0;
  public deck: Deck;
  public trumpSuit: Suit | null = null;
  public tableCards: PlayedCard[] = [];
  public currentTrickLeadSuit: Suit | null = null;
  public currentRoundCards: number = 1;
  public currentRoundType: RoundType = RoundType.STANDARD;
  public isDarkRound: boolean = false;
  
  public plan: RoundSpec[] = [];
  public currentRoundIndex: number = 0;
  public playedRoundTypes: Set<RoundType> = new Set();
  
  public controlGameChooserId: string | null = null;
  public controlGamesPlayed: number = 0;

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

  public startGame(settings: PlannerSettings): boolean {
    if (this.state !== GameState.WAITING_PLAYERS) return false;
    if (this.players.length !== settings.playersCount) return false;

    this.plan = RoundPlanner.generatePlan(settings);
    this.currentRoundIndex = 0;
    this.setupRoundFromPlan();
    return true;
  }

  private setupRoundFromPlan() {
    if (this.currentRoundIndex < this.plan.length) {
      const spec = this.plan[this.currentRoundIndex];
      this.currentRoundType = spec.type;
      this.currentRoundCards = spec.cardsInHand;
      this.dealerIndex = spec.dealerIndex;
      this.isDarkRound = spec.type === RoundType.DARK;
      this.playedRoundTypes.add(spec.type);
      this.transitionTo(GameState.SHUFFLING_AND_DEALING);
    } else {
      this.checkControlGameOrFinish();
    }
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
        // First trick lead
        this.currentPlayerIndex = this.getNextPlayerIndex(this.dealerIndex);
        break;
      case GameState.SCORING:
        this.applyScoring();
        this.currentRoundIndex++;
        // Reset state for next round
        this.players.forEach(p => { p.currentBid = null; p.tricksTaken = 0; });
        this.setupRoundFromPlan();
        break;
      case GameState.CONTROL_GAME_SETUP:
        this.determineControlGameChooser();
        break;
      case GameState.MATCH_FINISHED:
        break;
    }
  }

  private applyScoring() {
    for (const player of this.players) {
      const score = calculatePlayerScore(
        this.currentRoundType,
        this.currentRoundCards,
        player.currentBid,
        player.tricksTaken
      );
      player.score += score;
    }
  }

  private checkControlGameOrFinish() {
    if (this.controlGamesPlayed === 0) {
      // Must play at least one control game
      this.transitionTo(GameState.CONTROL_GAME_SETUP);
      return;
    }

    // Check for ties for 1st place
    const maxScore = Math.max(...this.players.map(p => p.score));
    const firstPlacePlayers = this.players.filter(p => p.score === maxScore);

    if (firstPlacePlayers.length > 1) {
      // Tie for first place, another control game
      this.transitionTo(GameState.CONTROL_GAME_SETUP);
    } else {
      this.transitionTo(GameState.MATCH_FINISHED);
    }
  }

  private determineControlGameChooser() {
    let minScore = Math.min(...this.players.map(p => p.score));
    const lowestPlayers = this.players.filter(p => p.score === minScore);
    // If tie for lowest, we just pick the first one for now (could add tie-breaker logic)
    this.controlGameChooserId = lowestPlayers[0].id;
  }

  public setupControlGame(playerId: string, type: RoundType, newDealerIndex: number): boolean {
    if (this.state !== GameState.CONTROL_GAME_SETUP) return false;
    if (playerId !== this.controlGameChooserId) return false;
    if (!this.playedRoundTypes.has(type)) return false;

    this.currentRoundType = type;
    this.currentRoundCards = this.players.length === 3 ? 12 : this.players.length === 4 ? 9 : 6; // Max cards M
    this.dealerIndex = newDealerIndex;
    this.isDarkRound = type === RoundType.DARK;
    this.controlGamesPlayed++;
    
    this.transitionTo(GameState.SHUFFLING_AND_DEALING);
    return true;
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
    
    const cardsToDeal = this.currentRoundCards;
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
    
    // Auto-skip bidding for Gold and Miser
    if (this.currentRoundType === RoundType.GOLD || this.currentRoundType === RoundType.MISER) {
      this.players.forEach(p => p.currentBid = null);
      this.transitionTo(GameState.PLAYING_TRICKS);
    }
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
      if (this.currentRoundType === RoundType.GOLD || this.currentRoundType === RoundType.MISER) {
        // Gold and Miser have no bidding, so this shouldn't happen actually,
        // but if it does we skip. However, in Gold/Miser we should transition directly.
      }
      this.transitionTo(GameState.PLAYING_TRICKS);
    } else {
      this.advanceTurn();
    }

    return true;
  }

  public playCard(playerId: string, cardIndex: number, jokerAction?: JokerAction): boolean {
    if (this.state !== GameState.PLAYING_TRICKS) return false;
    
    const pIndex = this.players.findIndex(p => p.id === playerId);
    if (pIndex !== this.currentPlayerIndex) return false;

    const player = this.players[pIndex];
    if (cardIndex < 0 || cardIndex >= player.cards.length) return false;

    const card = player.cards[cardIndex];

    // Joker validation
    if (card.isJoker) {
      if (!jokerAction) return false; // Action must be specified
      if (this.tableCards.length === 0 && jokerAction.type === 'DROP' && !jokerAction.suit) return false; // Suit required to lead drop
      if (this.tableCards.length > 0 && jokerAction.type === 'DEMAND_SUIT') return false; // Cannot demand suit when not leading
    } else {
      // Normal card validation (Follow suit)
      if (this.tableCards.length > 0) {
        const leadSuit = this.currentTrickLeadSuit;
        const hasLeadSuit = player.cards.some(c => c.suit === leadSuit && !c.isJoker);
        if (hasLeadSuit && card.suit !== leadSuit) return false; // Must follow suit if possible
      }
    }

    // Play card
    player.cards.splice(cardIndex, 1);
    this.tableCards.push({ playerId, card, jokerAction });

    // Set lead suit if this is the first card
    if (this.tableCards.length === 1) {
      if (card.isJoker) {
        if (jokerAction?.type === 'DEMAND_SUIT' || jokerAction?.type === 'DROP') {
          this.currentTrickLeadSuit = jokerAction.suit || null;
        } else {
          this.currentTrickLeadSuit = null; // 'TAKE' means no strict lead suit (or effectively none)
        }
      } else {
        this.currentTrickLeadSuit = card.suit;
      }
    }

    // Check if trick is complete
    if (this.tableCards.length === this.players.length) {
      this.resolveTrick();
    } else {
      this.advanceTurn();
    }

    return true;
  }

  private resolveTrick() {
    let winningCardIndex = 0;
    const leadSuit = this.currentTrickLeadSuit;
    let isJokerTaking = false;

    for (let i = 0; i < this.tableCards.length; i++) {
      const current = this.tableCards[i];
      
      if (current.card.isJoker) {
        if (current.jokerAction?.type === 'TAKE' || current.jokerAction?.type === 'DEMAND_SUIT') {
          winningCardIndex = i;
          isJokerTaking = true;
          // If joker claims to take, it beats everything. (If multiple jokers existed, last played, but there's only 1)
        }
        // If 'DROP', it acts as a virtual 5, so it loses to any normal card of lead/trump.
        // It can only win if literally everyone else played a non-lead, non-trump card and joker was lead as drop, 
        // which means it acts as lead suit 5. We just let it be treated as rank 5 below if needed.
        continue;
      }

      if (isJokerTaking) continue; // Nothing beats the joker taking

      const winning = this.tableCards[winningCardIndex];
      if (winning.card.isJoker) {
        // Winning card is joker as 'DROP', evaluate current card against it.
        // Joker drop acts as 5 of lead suit.
        if (current.card.suit === leadSuit || current.card.suit === this.trumpSuit) {
           winningCardIndex = i;
        }
        continue;
      }

      // Normal comparison
      const currentIsTrump = current.card.suit === this.trumpSuit;
      const winningIsTrump = winning.card.suit === this.trumpSuit;

      if (currentIsTrump && !winningIsTrump) {
        winningCardIndex = i;
      } else if (currentIsTrump && winningIsTrump) {
        if (this.getRankValue(current.card.rank) > this.getRankValue(winning.card.rank)) {
          winningCardIndex = i;
        }
      } else if (current.card.suit === leadSuit) {
        if (winning.card.suit !== leadSuit || this.getRankValue(current.card.rank) > this.getRankValue(winning.card.rank)) {
          winningCardIndex = i;
        }
      }
    }

    const winnerId = this.tableCards[winningCardIndex].playerId;
    const winnerPlayer = this.players.find(p => p.id === winnerId);
    if (winnerPlayer) winnerPlayer.tricksTaken++;

    this.currentPlayerIndex = this.players.findIndex(p => p.id === winnerId);
    this.tableCards = [];
    this.currentTrickLeadSuit = null;

    // Check if round is over (no cards left in hand)
    if (this.players[0].cards.length === 0) {
      this.transitionTo(GameState.SCORING);
    }
  }

  private getRankValue(rank: Rank): number {
    const order = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    return order.indexOf(rank);
  }
}
