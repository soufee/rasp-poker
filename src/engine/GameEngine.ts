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
  /** Consecutive rounds this player bid 0 (pass). Reset on any non-zero bid. */
  consecutivePassRounds: number;
}

export type JokerAction =
  | { type: 'TAKE' }
  | { type: 'DEMAND_SUIT'; suit: Suit }
  | { type: 'DROP'; suit?: Suit };

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

export interface LegalPlay {
  cardIndex: number;
  jokerActions?: JokerAction[];
}

export interface EngineActionResult {
  ok: boolean;
  error?: string;
  events: string[];
}

export interface PlayerRanking {
  playerId: string;
  name: string;
  score: number;
  place: number;
  zeroScoreSecond: boolean;
}

export class GameEngine {
  public state: GameState = GameState.WAITING_PLAYERS;
  public players: Player[] = [];
  public maxPlayers: number;
  public dealerIndex = 0;
  public currentPlayerIndex = 0;
  public deck: Deck;
  public trumpSuit: Suit | null = null;
  /** Last dealt card shown as trump indicator (null in no-trump / empty deal edge). */
  public trumpCard: Card | null = null;
  public tableCards: PlayedCard[] = [];
  public currentTrickLeadSuit: Suit | null = null;
  /**
   * Set when a trick is fully played but not yet cleared, so the UI can show
   * the completed trick before cards are collected by the winner.
   */
  public pendingTrickWinnerId: string | null = null;
  public currentRoundCards = 1;
  public currentRoundType: RoundType = RoundType.STANDARD;
  public isDarkRound = false;

  public plan: RoundSpec[] = [];
  public currentRoundIndex = 0;
  public playedRoundTypes: Set<RoundType> = new Set();
  public scoreHistory: RoundScoreRecord[] = [];

  public controlGameChooserId: string | null = null;
  public controlGamesPlayed = 0;
  public ranking: PlayerRanking[] = [];

  /** Safety cap for control-game tie-breaks */
  public maxControlGames = 20;

  /**
   * When true, completed tricks are kept on the table (pendingTrickWinnerId is
   * set) until finalizeTrick() is called, letting the UI show the full trick.
   * When false (default), tricks resolve and clear immediately, which keeps
   * direct engine consumers (tests, simulators, bot harnesses) synchronous.
   */
  private readonly holdCompletedTricks: boolean;

  public constructor(maxPlayers: number = 3, holdCompletedTricks: boolean = false) {
    this.maxPlayers = maxPlayers;
    this.holdCompletedTricks = holdCompletedTricks;
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
      consecutivePassRounds: 0,
    });
    // Stay in WAITING_PLAYERS until explicit startGame (no auto-deal deadlock)
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
    this.controlGamesPlayed = 0;
    this.ranking = [];
    this.setupRoundFromPlan();
    return true;
  }

  /**
   * Short plan for smoke/CI (not full ladder). Still exercises control flow.
   */
  public startShortGame(settings: PlannerSettings, standardRounds = 2): boolean {
    if (this.state !== GameState.WAITING_PLAYERS) {
      return false;
    }
    if (!settings || settings.playersCount !== this.maxPlayers) {
      return false;
    }
    if (this.players.length !== settings.playersCount) {
      return false;
    }

    const N = settings.playersCount;
    const M = 36 / N;
    const plan: RoundSpec[] = [];
    let roundNumber = 1;
    let dealer = 0;
    for (let i = 0; i < standardRounds; i += 1) {
      plan.push({
        roundNumber: roundNumber++,
        type: RoundType.STANDARD,
        cardsInHand: Math.min(i + 1, M),
        dealerIndex: dealer,
      });
      dealer = (dealer + 1) % N;
    }
    this.plan = plan;
    this.currentRoundIndex = 0;
    this.scoreHistory = [];
    this.controlGamesPlayed = 0;
    this.ranking = [];
    this.playedRoundTypes = new Set();
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
        this.ranking = this.computeRanking();
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

      // Track consecutive pass rounds (only for rounds with bidding)
      if (player.currentBid === 0) {
        player.consecutivePassRounds += 1;
      } else if (player.currentBid !== null && player.currentBid > 0) {
        player.consecutivePassRounds = 0;
      }
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

    if (this.controlGamesPlayed >= this.maxControlGames) {
      this.transitionTo(GameState.MATCH_FINISHED);
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
    // Percents control: always 4 cards; otherwise max hand M
    this.currentRoundCards =
      type === RoundType.PERCENTS ? 4 : 36 / this.players.length;
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
    this.pendingTrickWinnerId = null;
    this.trumpCard = null;
    this.trumpSuit = null;

    const cardsToDeal = this.currentRoundCards;
    const totalDeal = cardsToDeal * this.players.length;
    // Trump is the last card dealt (to dealer). It is the totalDeal-th pop from end of deck.
    // Index of that card before dealing: cards[length - totalDeal] after shuffle... 
    // With pop from end: last pop is at original index (length - totalDeal).
    // notJokerFromEnd = totalDeal - 1 means the totalDeal-th card from the end is not joker.
    const notJokerFromEnd = Math.max(0, totalDeal - 1);

    if (this.currentRoundType === RoundType.NO_TRUMP) {
      this.deck.generateAndShuffleDeck();
    } else {
      this.deck.generateAndShuffleDeck({ notJokerFromEnd });
    }

    // Deal one-by-one starting left of dealer, ending with dealer each ring
    const firstReceiver = this.getNextPlayerIndex(this.dealerIndex);
    let lastDealt: Card | null = null;
    for (let cardNum = 0; cardNum < cardsToDeal; cardNum += 1) {
      for (let offset = 0; offset < this.players.length; offset += 1) {
        const playerIndex = (firstReceiver + offset) % this.players.length;
        const card = this.deck.cards.pop();
        if (card) {
          this.players[playerIndex].cards.push(card);
          lastDealt = card;
        }
      }
    }

    if (this.currentRoundType === RoundType.NO_TRUMP) {
      this.trumpSuit = null;
      this.trumpCard = null;
    } else if (lastDealt) {
      this.trumpCard = lastDealt;
      this.trumpSuit = lastDealt.suit;
    }

    this.transitionTo(GameState.BIDDING);
    if (this.currentRoundType === RoundType.GOLD || this.currentRoundType === RoundType.MISER) {
      for (const player of this.players) {
        player.currentBid = null;
      }
      this.transitionTo(GameState.PLAYING_TRICKS);
    }
  }

  /** Max consecutive pass rounds allowed before forced non-zero bid (N-1). */
  private getMaxConsecutivePasses(): number {
    return this.maxPlayers - 1;
  }

  public getAvailableBids(playerIndex: number): number[] {
    return this.getLegalBidsByIndex(playerIndex);
  }

  public getLegalBids(playerId: string): number[] {
    const playerIndex = this.players.findIndex((player) => player.id === playerId);
    if (playerIndex < 0) {
      return [];
    }
    return this.getLegalBidsByIndex(playerIndex);
  }

  private getLegalBidsByIndex(playerIndex: number): number[] {
    if (this.state !== GameState.BIDDING) {
      return [];
    }
    if (playerIndex < 0 || playerIndex >= this.players.length) {
      return [];
    }
    if (playerIndex !== this.currentPlayerIndex) {
      return [];
    }

    const maxBid = this.currentRoundCards;
    let allowedBids: number[] = [];
    for (let bid = 0; bid <= maxBid; bid += 1) {
      allowedBids.push(bid);
    }

    const player = this.players[playerIndex];
    // Per-player history across rounds (ТЗ §3)
    const restrictPass = player.consecutivePassRounds >= this.getMaxConsecutivePasses();
    if (restrictPass) {
      allowedBids = allowedBids.filter((bid) => bid !== 0);
    }

    const isDealer = playerIndex === this.dealerIndex;
    let exceptBid: number | null = null;
    if (isDealer) {
      const sumBids = this.players.reduce((sum, p) => sum + (p.currentBid ?? 0), 0);
      exceptBid = maxBid - sumBids;
      if (exceptBid >= 0 && exceptBid <= maxBid) {
        allowedBids = allowedBids.filter((bid) => bid !== exceptBid);
      }
    }

    // Collision: «Кроме» has priority over pass limit → allow 0
    if (allowedBids.length === 0 && isDealer && restrictPass && exceptBid === 1 && maxBid === 1) {
      allowedBids = [0];
    }

    return allowedBids;
  }

  public placeBid(playerId: string, bid: number): boolean {
    return this.applyAction({ type: 'PLACE_BID', playerId, bid }).ok;
  }

  public getValidCardIndices(playerId: string): number[] {
    return this.getLegalPlays(playerId).map((play) => play.cardIndex);
  }

  public getLegalPlays(playerId: string): LegalPlay[] {
    if (this.state !== GameState.PLAYING_TRICKS) {
      return [];
    }

    const playerIndex = this.players.findIndex((player) => player.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) {
      return [];
    }

    const player = this.players[playerIndex];
    const indices = this.computeLegalCardIndices(player);
    return indices.map((cardIndex) => {
      const card = player.cards[cardIndex];
      if (!card.isJoker) {
        return { cardIndex };
      }
      return {
        cardIndex,
        jokerActions: this.getLegalJokerActions(),
      };
    });
  }

  private getActiveDemandSuit(): Suit | null {
    const lead = this.tableCards[0];
    if (!lead?.card.isJoker) {
      return null;
    }
    if (lead.jokerAction?.type === 'DEMAND_SUIT') {
      return lead.jokerAction.suit;
    }
    return null;
  }

  private computeLegalCardIndices(player: Player): number[] {
    const allIndices = player.cards.map((_card, cardIndex) => cardIndex);
    if (this.tableCards.length === 0) {
      return allIndices;
    }

    const demandSuit = this.getActiveDemandSuit();
    if (demandSuit !== null) {
      // «По старшим [масть]»: highest of demand suit, else highest trump, else any
      const demandCards = player.cards
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => !card.isJoker && card.suit === demandSuit);
      if (demandCards.length > 0) {
        const maxRank = Math.max(...demandCards.map(({ card }) => this.getRankValue(card.rank)));
        return demandCards
          .filter(({ card }) => this.getRankValue(card.rank) === maxRank)
          .map(({ index }) => index);
      }

      if (this.trumpSuit !== null) {
        const trumps = player.cards
          .map((card, index) => ({ card, index }))
          .filter(({ card }) => !card.isJoker && card.suit === this.trumpSuit);
        if (trumps.length > 0) {
          const maxRank = Math.max(...trumps.map(({ card }) => this.getRankValue(card.rank)));
          return trumps
            .filter(({ card }) => this.getRankValue(card.rank) === maxRank)
            .map(({ index }) => index);
        }
      }

      // May still play joker or any card
      return allIndices;
    }

    const leadSuit = this.currentTrickLeadSuit;
    if (leadSuit === null) {
      // Joker TAKE lead — no forced suit
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

  private getLegalJokerActions(): JokerAction[] {
    if (this.tableCards.length === 0) {
      const suits = [Suit.Spades, Suit.Hearts, Suit.Diamonds, Suit.Clubs];
      return [
        { type: 'TAKE' },
        ...suits.map((suit) => ({ type: 'DEMAND_SUIT' as const, suit })),
        ...suits.map((suit) => ({ type: 'DROP' as const, suit })),
      ];
    }
    return [{ type: 'TAKE' }, { type: 'DROP' }];
  }

  public playCard(playerId: string, cardIndex: number, jokerAction?: JokerAction): boolean {
    return this.applyAction({ type: 'PLAY_CARD', playerId, cardIndex, jokerAction }).ok;
  }

  public applyAction(
    action:
      | { type: 'PLACE_BID'; playerId: string; bid: number }
      | { type: 'PLAY_CARD'; playerId: string; cardIndex: number; jokerAction?: JokerAction }
      | { type: 'SETUP_CONTROL'; playerId: string; roundType: RoundType; dealerIndex: number },
  ): EngineActionResult {
    const events: string[] = [];

    if (action.type === 'PLACE_BID') {
      if (this.state !== GameState.BIDDING) {
        return { ok: false, error: 'Not in bidding phase', events };
      }
      const playerIndex = this.players.findIndex((player) => player.id === action.playerId);
      if (playerIndex !== this.currentPlayerIndex) {
        return { ok: false, error: 'Not your turn', events };
      }
      if (!Number.isInteger(action.bid)) {
        return { ok: false, error: 'Bid must be an integer', events };
      }
      const allowed = this.getLegalBidsByIndex(playerIndex);
      if (!allowed.includes(action.bid)) {
        return { ok: false, error: 'Illegal bid', events };
      }

      this.players[playerIndex].currentBid = action.bid;
      events.push('BID_PLACED');
      if (playerIndex === this.dealerIndex) {
        this.transitionTo(GameState.PLAYING_TRICKS);
        events.push('BIDDING_COMPLETE');
      } else {
        this.advanceTurn();
      }
      return { ok: true, events };
    }

    if (action.type === 'PLAY_CARD') {
      if (this.state !== GameState.PLAYING_TRICKS) {
        return { ok: false, error: 'Not in playing phase', events };
      }
      if (this.pendingTrickWinnerId !== null) {
        return { ok: false, error: 'Trick is resolving', events };
      }
      if (!Number.isInteger(action.cardIndex)) {
        return { ok: false, error: 'Invalid card index', events };
      }

      const playerIndex = this.players.findIndex((player) => player.id === action.playerId);
      if (playerIndex !== this.currentPlayerIndex) {
        return { ok: false, error: 'Not your turn', events };
      }

      const legal = this.getLegalPlays(action.playerId);
      const match = legal.find((play) => play.cardIndex === action.cardIndex);
      if (!match) {
        return { ok: false, error: 'Illegal card', events };
      }

      const player = this.players[playerIndex];
      const card = player.cards[action.cardIndex];
      let jokerAction = action.jokerAction;
      if (card.isJoker) {
        if (!this.isValidJokerAction(jokerAction)) {
          return { ok: false, error: 'Joker action required', events };
        }
        if (
          this.tableCards.length === 0
          && jokerAction?.type === 'DROP'
          && !jokerAction.suit
        ) {
          return { ok: false, error: 'DROP lead requires suit', events };
        }
        if (this.tableCards.length > 0 && jokerAction?.type === 'DEMAND_SUIT') {
          return { ok: false, error: 'Cannot DEMAND_SUIT when not leading', events };
        }
      } else {
        jokerAction = undefined;
      }

      player.cards.splice(action.cardIndex, 1);
      this.tableCards.push({ playerId: action.playerId, card, jokerAction });
      events.push('CARD_PLAYED');

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
        events.push('TRICK_RESOLVED');
      } else {
        this.advanceTurn();
      }
      return { ok: true, events };
    }

    if (action.type === 'SETUP_CONTROL') {
      const ok = this.setupControlGame(action.playerId, action.roundType, action.dealerIndex);
      return ok
        ? { ok: true, events: ['CONTROL_SETUP'] }
        : { ok: false, error: 'Invalid control setup', events };
    }

    return { ok: false, error: 'Unknown action', events };
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
        // A lead-suit card can only overtake another lead-suit card, never a trump.
        if (
          !winningIsTrump
          && (winning.card.suit !== this.currentTrickLeadSuit
            || this.getRankValue(current.card.rank) > this.getRankValue(winning.card.rank))
        ) {
          winningCardIndex = tableCardIndex;
        }
      }
    }

    const winnerId = this.tableCards[winningCardIndex].playerId;
    this.verifyTrickWinner(winnerId);
    const winnerPlayer = this.players.find((player) => player.id === winnerId);
    if (winnerPlayer) {
      winnerPlayer.tricksTaken += 1;
    }

    this.currentPlayerIndex = this.players.findIndex((player) => player.id === winnerId);
    // Keep the completed trick on the table so the UI can show it; the cards are
    // cleared later by finalizeTrick() once the winner "collects" them.
    this.pendingTrickWinnerId = winnerId;
    if (!this.holdCompletedTricks) {
      this.finalizeTrick();
    }
  }

  /**
   * Runtime self-check for the trick winner. Recomputes the winner with an
   * independent, deliberately simple reference (highest trump wins, otherwise
   * highest card of the lead suit) and screams a [TRICK-BUG] line with the full
   * layout if it ever disagrees with the primary resolver. Joker tricks are
   * skipped because their rules are special-cased in resolveTrick().
   */
  private verifyTrickWinner(computedWinnerId: string): void {
    const hasJoker = this.tableCards.some((played) => played.card.isJoker);
    const layout = this.tableCards
      .map((played) => `${played.playerId}:${played.card.rank}${played.card.suit}`)
      .join(', ');
    const trumpLabel = this.trumpSuit ?? 'none';
    if (hasJoker) {
      console.log(
        `[TRICK] trump=${trumpLabel} lead=${this.currentTrickLeadSuit} `
        + `cards=[${layout}] winner=${computedWinnerId} (joker)`,
      );
      return;
    }

    let refIndex = 0;
    for (let i = 1; i < this.tableCards.length; i += 1) {
      const cur = this.tableCards[i].card;
      const best = this.tableCards[refIndex].card;
      const curTrump = this.trumpSuit !== null && cur.suit === this.trumpSuit;
      const bestTrump = this.trumpSuit !== null && best.suit === this.trumpSuit;
      if (curTrump && !bestTrump) {
        refIndex = i;
      } else if (curTrump && bestTrump) {
        if (this.getRankValue(cur.rank) > this.getRankValue(best.rank)) {
          refIndex = i;
        }
      } else if (!curTrump && !bestTrump && cur.suit === this.currentTrickLeadSuit) {
        if (
          best.suit !== this.currentTrickLeadSuit
          || this.getRankValue(cur.rank) > this.getRankValue(best.rank)
        ) {
          refIndex = i;
        }
      }
    }

    const refWinnerId = this.tableCards[refIndex].playerId;
    if (refWinnerId !== computedWinnerId) {
      console.error(
        `[TRICK-BUG] trump=${trumpLabel} lead=${this.currentTrickLeadSuit} `
        + `cards=[${layout}] engine=${computedWinnerId} expected=${refWinnerId}`,
      );
      return;
    }
    console.log(
      `[TRICK] trump=${trumpLabel} lead=${this.currentTrickLeadSuit} `
      + `cards=[${layout}] winner=${computedWinnerId}`,
    );
  }

  /**
   * Clears the completed trick and advances the hand. Must be called after
   * resolveTrick() has marked a pending winner (see pendingTrickWinnerId).
   */
  public finalizeTrick(): boolean {
    if (this.pendingTrickWinnerId === null) {
      return false;
    }
    this.pendingTrickWinnerId = null;
    this.tableCards = [];
    this.currentTrickLeadSuit = null;
    if (this.players.every((player) => player.cards.length === 0)) {
      this.transitionTo(GameState.SCORING);
    }
    return true;
  }

  /**
   * Ranking with «правило нулевого счёта»: score === 0 → place 2.
   */
  public computeRanking(): PlayerRanking[] {
    const zeroPlayers = this.players.filter((player) => player.score === 0);
    const nonZero = this.players.filter((player) => player.score !== 0);
    nonZero.sort((a, b) => b.score - a.score);

    const result: PlayerRanking[] = [];
    let nextPlace = 1;

    for (const player of nonZero) {
      if (nextPlace === 2 && zeroPlayers.length > 0) {
        // Reserve place 2 for zero-score players
        nextPlace = 3;
      }
      const sameScorePlace = result.find((entry) => entry.score === player.score)?.place;
      const place = sameScorePlace ?? nextPlace;
      result.push({
        playerId: player.id,
        name: player.name,
        score: player.score,
        place,
        zeroScoreSecond: false,
      });
      if (sameScorePlace === undefined) {
        nextPlace = place + 1;
      }
    }

    for (const player of zeroPlayers) {
      result.push({
        playerId: player.id,
        name: player.name,
        score: 0,
        place: 2,
        zeroScoreSecond: true,
      });
    }

    result.sort((a, b) => a.place - b.place || b.score - a.score);
    return result;
  }

  /**
   * Ends the match immediately because a player left the table.
   * The leaver is always placed last (a loss); remaining players keep
   * their relative order by current score.
   */
  public forfeitMatch(loserId: string): boolean {
    if (this.state === GameState.MATCH_FINISHED) {
      return false;
    }
    const loser = this.players.find((player) => player.id === loserId);
    if (!loser) {
      return false;
    }

    const others = this.players.filter((player) => player.id !== loserId);
    others.sort((a, b) => b.score - a.score);

    const ranking: PlayerRanking[] = [];
    let nextPlace = 1;
    for (const player of others) {
      const sameScorePlace = ranking.find((entry) => entry.score === player.score)?.place;
      const place = sameScorePlace ?? nextPlace;
      ranking.push({
        playerId: player.id,
        name: player.name,
        score: player.score,
        place,
        zeroScoreSecond: false,
      });
      if (sameScorePlace === undefined) {
        nextPlace = place + 1;
      }
    }

    const lastPlace = others.length + 1;
    ranking.push({
      playerId: loser.id,
      name: loser.name,
      score: loser.score,
      place: lastPlace,
      zeroScoreSecond: false,
    });

    this.state = GameState.MATCH_FINISHED;
    this.ranking = ranking;
    return true;
  }

  private getRankValue(rank: Rank): number {
    const order = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    return order.indexOf(rank);
  }
}
