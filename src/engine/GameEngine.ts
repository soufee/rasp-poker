import { Card, Rank, Suit } from './Card';
import { Deck } from './Deck';
import { PlannerSettings, RoundPlanner, RoundSpec } from './RoundPlanner';
import { calculatePlayerScore, RoundType } from './Scoring';

export enum GameState {
  WAITING_PLAYERS = 'WAITING_PLAYERS',
  SHUFFLING_AND_DEALING = 'SHUFFLING_AND_DEALING',
  BIDDING = 'BIDDING',
  PLAYING_TRICKS = 'PLAYING_TRICKS',
  SCORING = 'SCORING',
  CONTROL_GAME_SETUP = 'CONTROL_GAME_SETUP',
  MATCH_FINISHED = 'MATCH_FINISHED',
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
  { type: 'TAKE' } | { type: 'DEMAND_SUIT'; suit: Suit } | { type: 'DROP'; suit?: Suit };

export interface PlayedCard {
  playerId: string;
  card: Card;
  jokerAction?: JokerAction;
}

export interface RoundScoreRecord {
  roundNumber: number;
  roundType: RoundType;
  cardsInHand: number;
  scores: Record<string, number>;
  bids: Record<string, number | null>;
  tricks: Record<string, number>;
}

export class GameEngine {
  public state: GameState = GameState.WAITING_PLAYERS;
  public players: Player[] = [];
  public maxPlayers: number;
  public dealerIndex = 0;
  public currentPlayerIndex = 0;
  public deck: Deck;
  public trumpSuit: Suit | null = null;
  public tableCards: PlayedCard[] = [];
  public currentTrickLeadSuit: Suit | null = null;
  public currentRoundCards = 1;
  public currentRoundType: RoundType = RoundType.STANDARD;
  public isDarkRound = false;

  public plan: RoundSpec[] = [];
  public currentRoundIndex = 0;
  public playedRoundTypes: Set<RoundType> = new Set();
  public scoreHistory: RoundScoreRecord[] = [];

  public controlGameChooserId: string | null = null;
  public controlGamesPlayed = 0;

  public constructor(maxPlayers: number = 3) {
    this.maxPlayers = maxPlayers;
    this.deck = new Deck();
  }

  public addPlayer(id: string, name: string): boolean {
    if (this.state !== GameState.WAITING_PLAYERS) {
      return false;
    }
    if (this.players.length >= this.maxPlayers) {
      return false;
    }
    if (this.players.some((player) => player.id === id)) {
      return false;
    }

    this.players.push({
      id,
      name,
      cards: [],
      score: 0,
      currentBid: null,
      tricksTaken: 0,
    });
    return true;
  }

  public startGame(settings: PlannerSettings): boolean {
    if (this.state !== GameState.WAITING_PLAYERS) {
      return false;
    }
    if (!settings || !this.isSupportedPlayersCount(settings.playersCount)) {
      return false;
    }
    if (settings.playersCount !== this.maxPlayers) {
      return false;
    }
    if (this.players.length !== settings.playersCount) {
      return false;
    }
    if (typeof settings.hasLadder !== 'boolean' || typeof settings.hasMiser !== 'boolean') {
      return false;
    }

    this.plan = RoundPlanner.generatePlan(settings);
    this.currentRoundIndex = 0;
    this.scoreHistory = [];
    this.setupRoundFromPlan();
    return true;
  }

  private isSupportedPlayersCount(playersCount: number): boolean {
    return playersCount === 3 || playersCount === 4 || playersCount === 6;
  }

  private setupRoundFromPlan(): void {
    if (this.currentRoundIndex >= this.plan.length) {
      this.checkControlGameOrFinish();
      return;
    }

    const spec = this.plan[this.currentRoundIndex];
    this.currentRoundType = spec.type;
    this.currentRoundCards = spec.cardsInHand;
    this.dealerIndex = spec.dealerIndex;
    this.isDarkRound = spec.type === RoundType.DARK;
    this.playedRoundTypes.add(spec.type);
    this.transitionTo(GameState.SHUFFLING_AND_DEALING);
  }

  public transitionTo(newState: GameState): void {
    this.state = newState;

    switch (newState) {
      case GameState.SHUFFLING_AND_DEALING:
        this.handleDealingPhase();
        break;
      case GameState.BIDDING:
        this.currentPlayerIndex = this.getNextPlayerIndex(this.dealerIndex);
        break;
      case GameState.PLAYING_TRICKS:
        this.currentPlayerIndex = this.getNextPlayerIndex(this.dealerIndex);
        break;
      case GameState.SCORING:
        this.applyScoring();
        this.currentRoundIndex += 1;
        for (const player of this.players) {
          player.currentBid = null;
          player.tricksTaken = 0;
        }
        this.setupRoundFromPlan();
        break;
      case GameState.CONTROL_GAME_SETUP:
        this.determineControlGameChooser();
        break;
      case GameState.MATCH_FINISHED:
        break;
    }
  }

  private applyScoring(): void {
    const scores: Record<string, number> = {};
    const bids: Record<string, number | null> = {};
    const tricks: Record<string, number> = {};
    for (const player of this.players) {
      const score = calculatePlayerScore(
        this.currentRoundType,
        this.currentRoundCards,
        player.currentBid,
        player.tricksTaken,
      );
      scores[player.id] = score;
      bids[player.id] = player.currentBid;
      tricks[player.id] = player.tricksTaken;
      player.score += score;
    }
    this.scoreHistory.push({
      roundNumber: this.scoreHistory.length + 1,
      roundType: this.currentRoundType,
      cardsInHand: this.currentRoundCards,
      scores,
      bids,
      tricks,
    });
  }

  private checkControlGameOrFinish(): void {
    if (this.controlGamesPlayed === 0) {
      this.transitionTo(GameState.CONTROL_GAME_SETUP);
      return;
    }

    const maxScore = Math.max(...this.players.map((player) => player.score));
    const firstPlacePlayers = this.players.filter((player) => player.score === maxScore);
    if (firstPlacePlayers.length > 1) {
      this.transitionTo(GameState.CONTROL_GAME_SETUP);
    } else {
      this.transitionTo(GameState.MATCH_FINISHED);
    }
  }

  private determineControlGameChooser(): void {
    const minScore = Math.min(...this.players.map((player) => player.score));
    const lowestPlayers = this.players.filter((player) => player.score === minScore);
    this.controlGameChooserId = lowestPlayers[0]?.id ?? null;
  }

  public setupControlGame(playerId: string, type: RoundType, newDealerIndex: number): boolean {
    if (this.state !== GameState.CONTROL_GAME_SETUP) {
      return false;
    }
    if (playerId !== this.controlGameChooserId) {
      return false;
    }
    if (!this.playedRoundTypes.has(type)) {
      return false;
    }
    if (
      !Number.isInteger(newDealerIndex)
      || newDealerIndex < 0
      || newDealerIndex >= this.players.length
    ) {
      return false;
    }

    this.currentRoundType = type;
    this.currentRoundCards = 36 / this.players.length;
    this.dealerIndex = newDealerIndex;
    this.isDarkRound = type === RoundType.DARK;
    this.controlGamesPlayed += 1;
    this.transitionTo(GameState.SHUFFLING_AND_DEALING);
    return true;
  }

  public getNextPlayerIndex(currentIndex: number): number {
    return (currentIndex + 1) % this.players.length;
  }

  public advanceTurn(): void {
    this.currentPlayerIndex = this.getNextPlayerIndex(this.currentPlayerIndex);
  }

  private handleDealingPhase(): void {
    for (const player of this.players) {
      player.cards = [];
    }
    this.tableCards = [];
    this.currentTrickLeadSuit = null;
    this.deck.generateAndShuffleDeck();

    const cardsToDeal = this.currentRoundCards;
    for (let cardIndex = 0; cardIndex < cardsToDeal; cardIndex += 1) {
      for (const player of this.players) {
        const card = this.deck.cards.pop();
        if (card) {
          player.cards.push(card);
        }
      }
    }

    if (this.currentRoundType === RoundType.NO_TRUMP) {
      this.trumpSuit = null;
    } else if (this.deck.cards.length > 0) {
      const trumpCard = this.deck.cards[this.deck.cards.length - 1];
      this.trumpSuit = trumpCard.suit;
    } else {
      this.trumpSuit = null;
    }

    this.transitionTo(GameState.BIDDING);
    if (this.currentRoundType === RoundType.GOLD || this.currentRoundType === RoundType.MISER) {
      for (const player of this.players) {
        player.currentBid = null;
      }
      this.transitionTo(GameState.PLAYING_TRICKS);
    }
  }

  public getAvailableBids(playerIndex: number): number[] {
    if (playerIndex < 0 || playerIndex >= this.players.length) {
      return [];
    }

    const maxBid = this.currentRoundCards;
    let allowedBids: number[] = [];
    for (let bid = 0; bid <= maxBid; bid += 1) {
      allowedBids.push(bid);
    }

    let currentPasses = 0;
    let checkIndex = this.getNextPlayerIndex(this.dealerIndex);
    while (checkIndex !== playerIndex) {
      if (this.players[checkIndex].currentBid === 0) {
        currentPasses += 1;
      } else {
        currentPasses = 0;
      }
      checkIndex = this.getNextPlayerIndex(checkIndex);
    }

    const consecutivePassesAllowed = this.maxPlayers === 3 ? 2 : this.maxPlayers === 4 ? 3 : 4;
    const restrictPass = currentPasses >= consecutivePassesAllowed;
    if (restrictPass) {
      allowedBids = allowedBids.filter((bid) => bid !== 0);
    }

    const isDealer = playerIndex === this.dealerIndex;
    let exceptBid: number | null = null;
    if (isDealer) {
      const sumBids = this.players.reduce((sum, player) => sum + (player.currentBid ?? 0), 0);
      exceptBid = maxBid - sumBids;
    }

    if (isDealer && exceptBid !== null) {
      allowedBids = allowedBids.filter((bid) => bid !== exceptBid);
    }
    if (allowedBids.length === 0 && isDealer && exceptBid === 1 && restrictPass) {
      allowedBids = [0];
    }
    return allowedBids;
  }

  public placeBid(playerId: string, bid: number): boolean {
    if (this.state !== GameState.BIDDING) {
      return false;
    }

    const playerIndex = this.players.findIndex((player) => player.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) {
      return false;
    }

    const allowedBids = this.getAvailableBids(playerIndex);
    if (!allowedBids.includes(bid)) {
      return false;
    }

    this.players[playerIndex].currentBid = bid;
    if (playerIndex === this.dealerIndex) {
      this.transitionTo(GameState.PLAYING_TRICKS);
    } else {
      this.advanceTurn();
    }
    return true;
  }

  public getValidCardIndices(playerId: string): number[] {
    if (this.state !== GameState.PLAYING_TRICKS) {
      return [];
    }

    const playerIndex = this.players.findIndex((player) => player.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) {
      return [];
    }

    const player = this.players[playerIndex];
    const allIndices = player.cards.map((_card, cardIndex) => cardIndex);
    const leadSuit = this.currentTrickLeadSuit;
    if (this.tableCards.length === 0 || leadSuit === null) {
      return allIndices;
    }

    const hasLeadSuit = player.cards.some((card) => !card.isJoker && card.suit === leadSuit);
    if (hasLeadSuit) {
      return allIndices.filter((cardIndex) => {
        const card = player.cards[cardIndex];
        return card.isJoker || card.suit === leadSuit;
      });
    }

    const trumpSuit = this.trumpSuit;
    const hasTrump =
      trumpSuit !== null && player.cards.some((card) => !card.isJoker && card.suit === trumpSuit);
    if (hasTrump) {
      return allIndices.filter((cardIndex) => {
        const card = player.cards[cardIndex];
        return card.isJoker || card.suit === trumpSuit;
      });
    }
    return allIndices;
  }

  public playCard(playerId: string, cardIndex: number, jokerAction?: JokerAction): boolean {
    if (!Number.isInteger(cardIndex)) {
      return false;
    }

    const playerIndex = this.players.findIndex((player) => player.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) {
      return false;
    }

    const validCardIndices = this.getValidCardIndices(playerId);
    if (!validCardIndices.includes(cardIndex)) {
      return false;
    }

    const player = this.players[playerIndex];
    const card = player.cards[cardIndex];
    if (card.isJoker && !this.isValidJokerAction(jokerAction)) {
      return false;
    }
    if (
      card.isJoker
      && this.tableCards.length === 0
      && jokerAction?.type === 'DROP'
      && !jokerAction.suit
    ) {
      return false;
    }
    if (card.isJoker && this.tableCards.length > 0 && jokerAction?.type === 'DEMAND_SUIT') {
      return false;
    }

    player.cards.splice(cardIndex, 1);
    this.tableCards.push({ playerId, card, jokerAction });
    if (this.tableCards.length === 1) {
      if (card.isJoker && (jokerAction?.type === 'DEMAND_SUIT' || jokerAction?.type === 'DROP')) {
        this.currentTrickLeadSuit = jokerAction.suit ?? null;
      } else if (card.isJoker) {
        this.currentTrickLeadSuit = null;
      } else {
        this.currentTrickLeadSuit = card.suit;
      }
    }

    if (this.tableCards.length === this.players.length) {
      this.resolveTrick();
    } else {
      this.advanceTurn();
    }
    return true;
  }

  private isValidJokerAction(jokerAction: JokerAction | undefined): jokerAction is JokerAction {
    if (!jokerAction) {
      return false;
    }
    if (jokerAction.type === 'TAKE') {
      return true;
    }
    if (jokerAction.type === 'DEMAND_SUIT') {
      return this.isKnownSuit(jokerAction.suit);
    }
    if (jokerAction.type === 'DROP') {
      return jokerAction.suit === undefined || this.isKnownSuit(jokerAction.suit);
    }
    return false;
  }

  private isKnownSuit(suit: unknown): suit is Suit {
    return (
      suit === Suit.Spades || suit === Suit.Hearts || suit === Suit.Diamonds || suit === Suit.Clubs
    );
  }

  private resolveTrick(): void {
    let winningCardIndex = 0;
    let isJokerTaking = false;

    for (let tableCardIndex = 0; tableCardIndex < this.tableCards.length; tableCardIndex += 1) {
      const current = this.tableCards[tableCardIndex];
      if (current.card.isJoker) {
        if (current.jokerAction?.type === 'TAKE' || current.jokerAction?.type === 'DEMAND_SUIT') {
          winningCardIndex = tableCardIndex;
          isJokerTaking = true;
        }
        continue;
      }
      if (isJokerTaking) {
        continue;
      }

      const winning = this.tableCards[winningCardIndex];
      if (winning.card.isJoker) {
        if (
          current.card.suit === this.currentTrickLeadSuit
          || current.card.suit === this.trumpSuit
        ) {
          winningCardIndex = tableCardIndex;
        }
        continue;
      }

      const currentIsTrump = current.card.suit === this.trumpSuit;
      const winningIsTrump = winning.card.suit === this.trumpSuit;
      if (currentIsTrump && !winningIsTrump) {
        winningCardIndex = tableCardIndex;
      } else if (currentIsTrump && winningIsTrump) {
        if (this.getRankValue(current.card.rank) > this.getRankValue(winning.card.rank)) {
          winningCardIndex = tableCardIndex;
        }
      } else if (current.card.suit === this.currentTrickLeadSuit) {
        if (
          winning.card.suit !== this.currentTrickLeadSuit
          || this.getRankValue(current.card.rank) > this.getRankValue(winning.card.rank)
        ) {
          winningCardIndex = tableCardIndex;
        }
      }
    }

    const winnerId = this.tableCards[winningCardIndex].playerId;
    const winnerPlayer = this.players.find((player) => player.id === winnerId);
    if (winnerPlayer) {
      winnerPlayer.tricksTaken += 1;
    }

    this.currentPlayerIndex = this.players.findIndex((player) => player.id === winnerId);
    this.tableCards = [];
    this.currentTrickLeadSuit = null;
    if (this.players[0].cards.length === 0) {
      this.transitionTo(GameState.SCORING);
    }
  }

  private getRankValue(rank: Rank): number {
    const order = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    return order.indexOf(rank);
  }
}
