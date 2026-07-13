import type { DecisionContext } from '../core/stateSelectors';
import type { Strategy } from './Strategy';
import { JokerAction, RoundType, CardModel, Suit, Rank } from '../protocol/types';
import { isJokerCard, rankValue, RANK_ORDER, SUITS, resolveWinnerIndex, cardKey } from './cards';

export class AntigravityStrategy implements Strategy {
  private roundKey = '';
  private readonly seen = new Set<string>();

  private remember(ctx: DecisionContext): void {
    const key =
      `${ctx.state.currentRoundIndex ?? 0}|${ctx.state.controlGamesPlayed ?? 0}` +
      `|${ctx.state.currentRoundType}|${ctx.state.currentRoundCards}`;
    if (key !== this.roundKey) {
      this.roundKey = key;
      this.seen.clear();
    }
    for (const played of ctx.state.tableCards) {
      this.seen.add(cardKey(played.card));
    }
    for (const card of ctx.me.cards) {
      if (card) {
        this.seen.add(cardKey(card));
      }
    }
  }

  private getCardStrengthProbabilistic(
    card: CardModel,
    trumpSuit: Suit | null,
    myCards: CardModel[],
    currentRoundCards: number,
    playersCount: number
  ): number {
    if (isJokerCard(card)) return 1.0;

    const hasJokerInHand = myCards.some(c => isJokerCard(c));

    // Count unseen higher cards of same suit
    let higherUnseen = 0;
    const myRankVal = rankValue(card.rank);
    for (const rank of RANK_ORDER) {
      if (rankValue(rank) > myRankVal) {
        const inHand = myCards.some(c => c && !isJokerCard(c) && c.suit === card.suit && c.rank === rank);
        if (!inHand) {
          higherUnseen++;
        }
      }
    }

    // Unseen trumps (if card is not trump and trumpSuit exists)
    let trumpsUnseen = 0;
    const isTrump = trumpSuit !== null && card.suit === trumpSuit;
    if (trumpSuit !== null && !isTrump) {
      for (const rank of RANK_ORDER) {
        if (trumpSuit === 'SPADES' && rank === '7') continue; // Joker is Spade 7 usually
        const inHand = myCards.some(c => c && !isJokerCard(c) && c.suit === trumpSuit && c.rank === rank);
        if (!inHand) {
          trumpsUnseen++;
        }
      }
    }

    const jokerUnseen = hasJokerInHand ? 0 : 1;

    let bEff = 0;
    if (isTrump) {
      bEff = higherUnseen + 0.85 * jokerUnseen;
    } else {
      bEff = higherUnseen + 0.35 * trumpsUnseen + 0.75 * jokerUnseen;
    }

    const o = playersCount - 1;
    const cOpps = o * currentRoundCards;
    const u = 36 - currentRoundCards;

    if (u <= 0 || cOpps <= 0) return 0.0;

    return Math.pow(Math.max(0, 1 - bEff / u), cOpps);
  }

  private getCardStrengthAdjusted(
    card: CardModel,
    trumpSuit: Suit | null,
    myCards: CardModel[],
    currentRoundCards: number,
    playersCount: number
  ): number {
    if (isJokerCard(card)) return 1.0;

    let strength = this.getCardStrengthProbabilistic(card, trumpSuit, myCards, currentRoundCards, playersCount);

    const sameSuitCards = myCards.filter(c => c && !isJokerCard(c) && c.suit === card.suit);
    const L = sameSuitCards.length;
    const hasJoker = myCards.some(c => isJokerCard(c));

    // Joker synergy
    if (hasJoker && L >= 3) {
      if (card.rank === 'A' || card.rank === 'K') {
        strength = 1.0;
      } else if (card.rank === 'Q') {
        strength = Math.min(1.0, strength + 0.4);
      } else if (card.rank === 'J') {
        strength = Math.min(1.0, strength + 0.3);
      } else if (card.rank === '10') {
        strength = Math.min(1.0, strength + 0.2);
      } else {
        strength = Math.min(1.0, strength + 0.1);
      }
    }

    // No-Trump length synergy
    if (trumpSuit === null && L >= 3) {
      const boost = 0.1 * (L - 2);
      strength = Math.min(1.0, strength + boost);
    }

    return strength;
  }

  public chooseBid(ctx: DecisionContext): number {
    this.remember(ctx);
    const allowed = ctx.state.allowedBids;
    if (!allowed || allowed.length === 0) {
      return 0;
    }
    if (allowed.length === 1) {
      return allowed[0];
    }

    const me = ctx.me;
    const knownCards = me.cards.filter((c): c is CardModel => c !== null);
    const playersCount = ctx.state.maxPlayers;
    const N = ctx.state.currentRoundCards;

    const isDarkRound = ctx.state.isDarkRound || ctx.state.currentRoundType === 'DARK' || knownCards.length === 0;

    if (isDarkRound) {
      const E = N / playersCount;
      const otherScores = ctx.state.players.filter(p => p.id !== ctx.myId).map(p => p.score);
      const maxOther = otherScores.length > 0 ? Math.max(...otherScores) : 0;
      const myScore = me.score;

      let target = E;
      if (myScore < maxOther - 30) {
        // Behind: risk more
        target = E + 0.6;
      } else if (myScore >= maxOther + 30) {
        // Leading: play safe
        target = E - 0.6;
      }

      const minBid = Math.max(0, Math.floor(E - 1.2));
      const maxBid = Math.max(1, Math.ceil(E + 0.6));

      let targetBid = Math.round(target);
      targetBid = Math.max(minBid, Math.min(maxBid, targetBid));

      return this.pickNearestBid(allowed, targetBid);
    }

    let estimatedTricks = 0;
    for (const card of knownCards) {
      const str = this.getCardStrengthAdjusted(card, ctx.state.trumpSuit, knownCards, N, playersCount);
      estimatedTricks += str;
    }

    const targetBid = Math.max(0, Math.round(estimatedTricks - 0.15));
    const result = this.pickNearestBid(allowed, targetBid);
    return result;
  }

  private pickNearestBid(allowed: number[], targetBid: number): number {
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

  private isSureWinner(card: CardModel, trumpSuit: Suit | null): boolean {
    if (isJokerCard(card)) return true;

    const myRankVal = rankValue(card.rank);
    for (const rank of RANK_ORDER) {
      if (rankValue(rank) > myRankVal) {
        if (!this.seen.has(`${rank}:${card.suit}`)) {
          return false;
        }
      }
    }

    const jokerSeen = this.seen.has('7:SPADES');
    if (!jokerSeen) return false;

    const isTrump = trumpSuit !== null && card.suit === trumpSuit;
    if (isTrump) {
      return true;
    }

    if (trumpSuit === null) {
      return true;
    }

    for (const rank of RANK_ORDER) {
      if (rank === '7' && trumpSuit === 'SPADES') continue;
      if (!this.seen.has(`${rank}:${trumpSuit}`)) {
        return false;
      }
    }

    return true;
  }

  private getCardPlayStrength(card: CardModel, trumpSuit: Suit | null): number {
    if (isJokerCard(card)) return 100;
    const isTrump = trumpSuit !== null && card.suit === trumpSuit;
    const rankVal = rankValue(card.rank);
    if (isTrump) {
      return 10 + rankVal;
    }
    return rankVal;
  }

  public chooseCard(ctx: DecisionContext): number {
    this.remember(ctx);
    const state = ctx.state;
    const me = ctx.me;
    const plays = state.legalPlays ?? [];
    if (plays.length === 0) {
      return state.validCardIndices?.[0] ?? 0;
    }

    const bid = me.currentBid;
    const taken = me.tricksTaken;
    const roundType = state.currentRoundType;

    let target: 'WIN' | 'LOSE' = 'WIN';
    if (roundType === 'GOLD') {
      target = 'WIN';
    } else if (roundType === 'MISER') {
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

    const candidates: Array<{ cardIndex: number; card: CardModel; jokerActions?: JokerAction[] }> = [];
    for (const play of plays) {
      const card = me.cards[play.cardIndex];
      if (card) {
        candidates.push({ cardIndex: play.cardIndex, card, jokerActions: play.jokerActions });
      }
    }

    if (candidates.length === 0) {
      return state.validCardIndices?.[0] ?? 0;
    }

    const trump = state.trumpSuit;
    const leadSuit = state.currentTrickLeadSuit ?? null;

    if (state.tableCards.length === 0) {
      if (target === 'WIN') {
        const sureWinners = candidates.filter(cand => this.isSureWinner(cand.card, trump));
        if (sureWinners.length > 0) {
          const nonJokerSure = sureWinners.filter(cand => !isJokerCard(cand.card));
          if (nonJokerSure.length > 0) {
            nonJokerSure.sort((a, b) => this.getCardPlayStrength(b.card, trump) - this.getCardPlayStrength(a.card, trump));
            return nonJokerSure[0].cardIndex;
          } else {
            return sureWinners[0].cardIndex;
          }
        }
        candidates.sort((a, b) => this.getCardPlayStrength(b.card, trump) - this.getCardPlayStrength(a.card, trump));
        return candidates[0].cardIndex;
      } else {
        candidates.sort((a, b) => this.getCardPlayStrength(a.card, trump) - this.getCardPlayStrength(b.card, trump));
        return candidates[0].cardIndex;
      }
    }

    const winIdx = resolveWinnerIndex(state.tableCards, trump, leadSuit);
    const tableWinner = state.tableCards[winIdx];

    const winningCandidates = candidates.filter((cand) => {
      const isJ = isJokerCard(cand.card);
      const action = isJ ? { type: 'TAKE' as const } : undefined;
      const playsList = [
        { card: tableWinner.card, jokerAction: tableWinner.jokerAction },
        { card: cand.card, jokerAction: action }
      ];
      return resolveWinnerIndex(playsList, trump, leadSuit) === 1;
    });

    const losingCandidates = candidates.filter((cand) => {
      const isJ = isJokerCard(cand.card);
      const action = isJ ? { type: 'DROP' as const } : undefined;
      const playsList = [
        { card: tableWinner.card, jokerAction: tableWinner.jokerAction },
        { card: cand.card, jokerAction: action }
      ];
      return resolveWinnerIndex(playsList, trump, leadSuit) === 0;
    });

    const isLastPlayer = state.tableCards.length === state.maxPlayers - 1;

    if (target === 'WIN') {
      if (winningCandidates.length > 0) {
        if (isLastPlayer) {
          winningCandidates.sort((a, b) => {
            const jokerA = isJokerCard(a.card) ? 1 : 0;
            const jokerB = isJokerCard(b.card) ? 1 : 0;
            if (jokerA !== jokerB) return jokerA - jokerB;
            return this.getCardPlayStrength(a.card, trump) - this.getCardPlayStrength(b.card, trump);
          });
          return winningCandidates[0].cardIndex;
        } else {
          winningCandidates.sort((a, b) => this.getCardPlayStrength(b.card, trump) - this.getCardPlayStrength(a.card, trump));
          return winningCandidates[0].cardIndex;
        }
      } else {
        candidates.sort((a, b) => this.getCardPlayStrength(a.card, trump) - this.getCardPlayStrength(b.card, trump));
        return candidates[0].cardIndex;
      }
    } else {
      if (losingCandidates.length > 0) {
        if (isLastPlayer) {
          losingCandidates.sort((a, b) => {
            const jokerA = isJokerCard(a.card) ? 1 : 0;
            const jokerB = isJokerCard(b.card) ? 1 : 0;
            if (jokerA !== jokerB) return jokerB - jokerA;
            return this.getCardPlayStrength(b.card, trump) - this.getCardPlayStrength(a.card, trump);
          });
          return losingCandidates[0].cardIndex;
        } else {
          losingCandidates.sort((a, b) => this.getCardPlayStrength(b.card, trump) - this.getCardPlayStrength(a.card, trump));
          return losingCandidates[0].cardIndex;
        }
      } else {
        candidates.sort((a, b) => this.getCardPlayStrength(b.card, trump) - this.getCardPlayStrength(a.card, trump));
        return candidates[0].cardIndex;
      }
    }
  }

  public chooseJokerAction(ctx: DecisionContext, cardIndex: number): JokerAction {
    this.remember(ctx);
    const state = ctx.state;
    const me = ctx.me;
    const bid = me.currentBid;
    const taken = me.tricksTaken;
    const roundType = state.currentRoundType;

    let target: 'WIN' | 'LOSE' = 'WIN';
    if (roundType === 'GOLD') {
      target = 'WIN';
    } else if (roundType === 'MISER') {
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

    if (state.tableCards.length === 0) {
      if (target === 'WIN') {
        return { type: 'TAKE' };
      } else {
        return { type: 'DROP', suit: this.getSafeSuit(me.cards) };
      }
    } else {
      if (target === 'WIN') {
        return { type: 'TAKE' };
      } else {
        return { type: 'DROP' };
      }
    }
  }

  private getSafeSuit(cards: Array<CardModel | null>): Suit {
    const counts: Record<Suit, number> = { SPADES: 0, HEARTS: 0, DIAMONDS: 0, CLUBS: 0 };
    for (const card of cards) {
      if (card && !isJokerCard(card)) {
        counts[card.suit]++;
      }
    }
    let bestSuit: Suit = 'SPADES';
    let maxCount = -1;
    for (const suit of SUITS) {
      if (counts[suit] > maxCount) {
        maxCount = counts[suit];
        bestSuit = suit;
      }
    }
    return bestSuit;
  }

  public chooseControlGame(ctx: DecisionContext): { roundType: RoundType; dealerIndex: number } {
    const dealerIndex = ctx.myIndex >= 0 ? ctx.myIndex : 0;
    const played = ctx.state.playedRoundTypes || [];

    let roundType: RoundType = 'STANDARD';
    if (played.includes('PERCENTS')) {
      roundType = 'PERCENTS';
    } else if (played.length > 0) {
      roundType = played[0];
    }

    return { roundType, dealerIndex };
  }

  public shouldStartGame(ctx: DecisionContext): boolean {
    return ctx.state.players.length === ctx.state.maxPlayers;
  }
}

