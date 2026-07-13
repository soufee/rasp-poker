import { GameState } from '../engine/GameEngine';
import { RoundType } from '../engine/Scoring';

const RANK_ORDER: string[] = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export interface StrategyCard {
  suit?: 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS';
  rank?: '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
  isJoker?: boolean;
}

export interface StrategyPlayerState {
  id: string;
  name: string;
  cards: Array<StrategyCard | null>;
  score: number;
  currentBid: number | null;
  tricksTaken: number;
}

export interface StrategyGameState {
  state: GameState;
  stateVersion: number;
  currentPlayerIndex: number;
  controlGameChooserId: string | null;
  allowedBids: number[] | null;
  validCardIndices: number[] | null;
  playersCount?: number;
  maxPlayers?: number;
  playedRoundTypes?: string[];
  players: StrategyPlayerState[];
  trumpSuit: 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS' | null;
  currentTrickLeadSuit: 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS' | null;
  currentRoundType: string;
  tableCards: Array<{
    playerId: string;
    card: { suit: 'SPADES' | 'HEARTS' | 'DIAMONDS' | 'CLUBS'; rank: '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'; isJoker?: boolean };
    jokerAction?: any;
  }>;
}

export class AntigravityStrategy {
  private getRankValue(rank?: string): number {
    if (!rank) return -1;
    return RANK_ORDER.indexOf(rank);
  }

  private getCardStrength(card: StrategyCard, trumpSuit: string | null): number {
    const isJoker = card.isJoker || (card.rank === '7' && card.suit === 'SPADES');
    if (isJoker) return 1.0;

    const rv = this.getRankValue(card.rank);
    if (trumpSuit !== null) {
      if (card.suit === trumpSuit) {
        // Trumps: Trump Ace is 0.95, Trump 6 is 0.04
        const trumpStrengths: Record<string, number> = {
          '6': 0.04, '7': 0.08, '8': 0.18, '9': 0.30, '10': 0.45,
          'J': 0.60, 'Q': 0.70, 'K': 0.80, 'A': 0.95
        };
        return trumpStrengths[card.rank || '6'] || 0.05;
      } else {
        // Plain cards: Ace is 0.65, K is 0.45, others lower (can be trumped)
        const plainStrengths: Record<string, number> = {
          '6': 0.00, '7': 0.00, '8': 0.00, '9': 0.01, '10': 0.04,
          'J': 0.12, 'Q': 0.25, 'K': 0.45, 'A': 0.65
        };
        return plainStrengths[card.rank || '6'] || 0.00;
      }
    } else {
      // No trump (e.g. NO_TRUMP round)
      const noTrumpStrengths: Record<string, number> = {
        '6': 0.00, '7': 0.01, '8': 0.03, '9': 0.08, '10': 0.15,
        'J': 0.22, 'Q': 0.40, 'K': 0.60, 'A': 0.85
      };
      return noTrumpStrengths[card.rank || '6'] || 0.00;
    }
  }

  public chooseBid(state: StrategyGameState, botId: string): number {
    const allowed = state.allowedBids;
    if (!allowed || allowed.length === 0) {
      return 0;
    }

    const myIndex = state.players.findIndex((p) => p.id === botId);
    const me = state.players[myIndex];
    if (!me || !me.cards) {
      return allowed[0];
    }

    // Check if it's a DARK round (cards hidden from the viewer)
    const isDarkRound = me.cards.every((c) => c === null);
    if (isDarkRound) {
      // In Dark round, bidding 0 is extremely safe. Pick 0 if allowed, else lowest.
      if (allowed.includes(0)) return 0;
      return allowed[0];
    }

    // Estimate tricks based on card strength
    let estimatedTricks = 0;
    for (const card of me.cards) {
      if (card) {
        estimatedTricks += this.getCardStrength(card, state.trumpSuit);
      }
    }

    // Risk aversion: slightly underbid because missed bids are penalized with -10 * bid,
    // whereas overbidding (taking more than bid) still gives positive points (+taken).
    const targetBid = Math.max(0, Math.round(estimatedTricks - 0.15));

    // Find the closest allowed bid. If there's a tie, choose the lower one for safety.
    let bestBid = allowed[0];
    let minDistance = Math.abs(bestBid - targetBid);
    for (let i = 1; i < allowed.length; i++) {
      const bid = allowed[i];
      const dist = Math.abs(bid - targetBid);
      if (dist < minDistance || (dist === minDistance && bid < bestBid)) {
        bestBid = bid;
        minDistance = dist;
      }
    }

    return bestBid;
  }

  private compareCards(
    a: { suit?: string; rank?: string; isJoker?: boolean; jokerAction?: any },
    b: { suit?: string; rank?: string; isJoker?: boolean; jokerAction?: any },
    leadSuit: string | null,
    trumpSuit: string | null
  ): number {
    const isJokerA = a.isJoker || (a.rank === '7' && a.suit === 'SPADES');
    const isJokerB = b.isJoker || (b.rank === '7' && b.suit === 'SPADES');

    if (isJokerA) {
      if (a.jokerAction?.type === 'TAKE' || a.jokerAction?.type === 'DEMAND_SUIT') {
        return 1;
      }
    }
    if (isJokerB) {
      if (b.jokerAction?.type === 'TAKE' || b.jokerAction?.type === 'DEMAND_SUIT') {
        return -1;
      }
    }

    const getEffectiveCard = (c: { suit?: string; rank?: string; isJoker?: boolean; jokerAction?: any }) => {
      const isJ = c.isJoker || (c.rank === '7' && c.suit === 'SPADES');
      if (isJ) {
        const suit = c.jokerAction?.suit || leadSuit || 'SPADES';
        return { suit, rankValue: -1 }; // Plays as rank '5'
      }
      return { suit: c.suit, rankValue: this.getRankValue(c.rank) };
    };

    const effA = getEffectiveCard(a);
    const effB = getEffectiveCard(b);

    const aIsTrump = effA.suit === trumpSuit;
    const bIsTrump = effB.suit === trumpSuit;

    if (aIsTrump && !bIsTrump) return 1;
    if (!aIsTrump && bIsTrump) return -1;
    if (aIsTrump && bIsTrump) {
      return effA.rankValue - effB.rankValue;
    }

    const aIsLead = effA.suit === leadSuit;
    const bIsLead = effB.suit === leadSuit;

    if (aIsLead && !bIsLead) return 1;
    if (!aIsLead && bIsLead) return -1;
    if (aIsLead && bIsLead) {
      return effA.rankValue - effB.rankValue;
    }

    return 0;
  }

  private getWinningCardIndex(tableCards: any[], leadSuit: string | null, trumpSuit: string | null): number {
    if (tableCards.length === 0) return -1;
    let winIdx = 0;
    for (let i = 1; i < tableCards.length; i++) {
      const res = this.compareCards(
        { suit: tableCards[i].card.suit, rank: tableCards[i].card.rank, isJoker: tableCards[i].card.isJoker, jokerAction: tableCards[i].jokerAction },
        { suit: tableCards[winIdx].card.suit, rank: tableCards[winIdx].card.rank, isJoker: tableCards[winIdx].card.isJoker, jokerAction: tableCards[winIdx].jokerAction },
        leadSuit,
        trumpSuit
      );
      if (res > 0) {
        winIdx = i;
      }
    }
    return winIdx;
  }

  private getCardPlayStrength(card: StrategyCard, trumpSuit: string | null): number {
    const isJ = card.isJoker || (card.rank === '7' && card.suit === 'SPADES');
    if (isJ) return 100; // Joker is strongest

    const isTrump = trumpSuit !== null && card.suit === trumpSuit;
    const rankVal = this.getRankValue(card.rank);

    if (isTrump) {
      return 10 + rankVal; // Trump strength: 10 to 18
    }
    return rankVal; // Plain strength: 0 to 8
  }

  private getSafeSuit(cards: Array<StrategyCard | null>): string {
    for (const card of cards) {
      if (card && card.suit && !(card.rank === '7' && card.suit === 'SPADES')) {
        return card.suit;
      }
    }
    return 'SPADES';
  }

  public choosePlay(
    state: StrategyGameState,
    botId: string,
    plays: Array<{ cardIndex: number; jokerActions?: any[] }>
  ): { cardIndex: number; jokerActions?: any[] } {
    const myIndex = state.players.findIndex((p) => p.id === botId);
    const me = state.players[myIndex];
    if (!me) {
      return { cardIndex: plays[0]?.cardIndex ?? 0 };
    }

    const bid = me.currentBid;
    const taken = me.tricksTaken;
    const roundType = state.currentRoundType;

    // Define target: WIN or LOSE
    let target: 'WIN' | 'LOSE' = 'WIN';
    if (roundType === RoundType.GOLD) {
      target = 'WIN';
    } else if (roundType === RoundType.MISER) {
      target = 'LOSE';
    } else if (bid === null) {
      target = 'WIN';
    } else {
      if (taken < bid) {
        target = 'WIN';
      } else {
        target = 'LOSE';
      }
    }

    // Build candidates
    const candidates: Array<{ cardIndex: number; jokerAction?: any; card: StrategyCard }> = [];
    for (const play of plays) {
      const card = me.cards[play.cardIndex];
      if (!card) continue;
      const isJ = card.isJoker || (card.rank === '7' && card.suit === 'SPADES');
      if (isJ) {
        const actions = play.jokerActions && play.jokerActions.length > 0
          ? play.jokerActions
          : [{ type: 'TAKE' }];
        for (const act of actions) {
          candidates.push({ cardIndex: play.cardIndex, jokerAction: act, card });
        }
      } else {
        candidates.push({ cardIndex: play.cardIndex, card });
      }
    }

    if (candidates.length === 0) {
      return { cardIndex: plays[0]?.cardIndex ?? 0 };
    }

    // Lead or Follow
    if (state.tableCards.length === 0) {
      // Leading the trick!
      if (target === 'WIN') {
        // Play strongest card
        candidates.sort((a, b) => this.getCardPlayStrength(b.card, state.trumpSuit) - this.getCardPlayStrength(a.card, state.trumpSuit));
        const best = candidates[0];
        let jokerAction = best.jokerAction;
        if (jokerAction && jokerAction.type === 'DROP') {
          jokerAction = { type: 'DROP', suit: this.getSafeSuit(me.cards) };
        }
        return { cardIndex: best.cardIndex, jokerActions: jokerAction ? [jokerAction] : undefined };
      } else {
        // Play weakest card
        candidates.sort((a, b) => this.getCardPlayStrength(a.card, state.trumpSuit) - this.getCardPlayStrength(b.card, state.trumpSuit));
        const best = candidates[0];
        let jokerAction = best.jokerAction;
        if (jokerAction && jokerAction.type === 'DROP') {
          jokerAction = { type: 'DROP', suit: this.getSafeSuit(me.cards) };
        }
        return { cardIndex: best.cardIndex, jokerActions: jokerAction ? [jokerAction] : undefined };
      }
    }

    // Following the trick
    const winIdx = this.getWinningCardIndex(state.tableCards, state.currentTrickLeadSuit, state.trumpSuit);
    const tableWinner = state.tableCards[winIdx];

    // Filter winning candidates
    const winningCandidates = candidates.filter((cand) => {
      const res = this.compareCards(
        { suit: cand.card.suit, rank: cand.card.rank, isJoker: cand.card.isJoker, jokerAction: cand.jokerAction },
        { suit: tableWinner.card.suit, rank: tableWinner.card.rank, isJoker: tableWinner.card.isJoker, jokerAction: tableWinner.jokerAction },
        state.currentTrickLeadSuit,
        state.trumpSuit
      );
      return res > 0;
    });

    const losingCandidates = candidates.filter((cand) => {
      const res = this.compareCards(
        { suit: cand.card.suit, rank: cand.card.rank, isJoker: cand.card.isJoker, jokerAction: cand.jokerAction },
        { suit: tableWinner.card.suit, rank: tableWinner.card.rank, isJoker: tableWinner.card.isJoker, jokerAction: tableWinner.jokerAction },
        state.currentTrickLeadSuit,
        state.trumpSuit
      );
      return res <= 0;
    });

    const playersCount = state.maxPlayers ?? state.players.length;
    const isLastPlayer = state.tableCards.length === playersCount - 1;

    if (target === 'WIN') {
      if (winningCandidates.length > 0) {
        if (isLastPlayer) {
          // Play the weakest winning card to conserve high cards
          winningCandidates.sort((a, b) => this.getCardPlayStrength(a.card, state.trumpSuit) - this.getCardPlayStrength(b.card, state.trumpSuit));
          const best = winningCandidates[0];
          return { cardIndex: best.cardIndex, jokerActions: best.jokerAction ? [best.jokerAction] : undefined };
        } else {
          // Play the strongest winning card to protect against subsequent players
          winningCandidates.sort((a, b) => this.getCardPlayStrength(b.card, state.trumpSuit) - this.getCardPlayStrength(a.card, state.trumpSuit));
          const best = winningCandidates[0];
          return { cardIndex: best.cardIndex, jokerActions: best.jokerAction ? [best.jokerAction] : undefined };
        }
      } else {
        // Can't win anyway: play weakest card to dump it
        candidates.sort((a, b) => this.getCardPlayStrength(a.card, state.trumpSuit) - this.getCardPlayStrength(b.card, state.trumpSuit));
        const best = candidates[0];
        return { cardIndex: best.cardIndex, jokerActions: best.jokerAction ? [best.jokerAction] : undefined };
      }
    } else {
      // We want to LOSE
      if (losingCandidates.length > 0) {
        if (isLastPlayer) {
          // Play the strongest losing card to safely get rid of high cards
          losingCandidates.sort((a, b) => this.getCardPlayStrength(b.card, state.trumpSuit) - this.getCardPlayStrength(a.card, state.trumpSuit));
          const best = losingCandidates[0];
          return { cardIndex: best.cardIndex, jokerActions: best.jokerAction ? [best.jokerAction] : undefined };
        } else {
          // Play the weakest losing card to avoid being ducked by later players
          losingCandidates.sort((a, b) => this.getCardPlayStrength(a.card, state.trumpSuit) - this.getCardPlayStrength(b.card, state.trumpSuit));
          const best = losingCandidates[0];
          return { cardIndex: best.cardIndex, jokerActions: best.jokerAction ? [best.jokerAction] : undefined };
        }
      } else {
        // Forced to win: play strongest card to get rid of it
        candidates.sort((a, b) => this.getCardPlayStrength(b.card, state.trumpSuit) - this.getCardPlayStrength(a.card, state.trumpSuit));
        const best = candidates[0];
        return { cardIndex: best.cardIndex, jokerActions: best.jokerAction ? [best.jokerAction] : undefined };
      }
    }
  }

  public chooseControlGame(
    state: StrategyGameState,
    botId: string
  ): { roundType: RoundType; dealerIndex: number } {
    const myIndex = state.players.findIndex((p) => p.id === botId);
    const dealerIndex = myIndex >= 0 ? myIndex : 0;

    const played = state.playedRoundTypes || [];
    // Prefer PERCENTS for maximum comeback potential if it was played, otherwise STANDARD
    let roundType = RoundType.STANDARD;
    if (played.includes(RoundType.PERCENTS)) {
      roundType = RoundType.PERCENTS;
    } else if (played.length > 0) {
      roundType = played[0] as RoundType;
    }

    return { roundType, dealerIndex };
  }
}

export const antigravityStrategy = new AntigravityStrategy();
