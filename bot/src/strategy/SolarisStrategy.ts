import type { DecisionContext } from '../core/stateSelectors';
import type {
  CardModel,
  JokerAction,
  RoundType,
  Suit,
} from '../protocol/types';
import type { Strategy } from './Strategy';
import { isJokerCard, SUITS } from './cards';
import {
  chooseZeroBid,
  chooseZeroControlSetup,
  planZeroPath,
} from './zeroPath';
import { SolarisBelief } from './solarisBelief';
import {
  SolarisRollout,
  type SolarisPlay,
} from './solarisRollout';

interface CachedPlay extends SolarisPlay {
  stateVersion: number;
}

const CONTROL_VARIANCE: Record<RoundType, number> = {
  STANDARD: 28,
  DARK: 58,
  PERCENTS: 86,
  NO_TRUMP: 32,
  GOLD: 24,
  MISER: 70,
};

export class SolarisStrategy implements Strategy {
  public readonly name = 'Solaris';

  private readonly belief = new SolarisBelief();
  private readonly rollout = new SolarisRollout(this.belief);
  private cachedPlay: CachedPlay | null = null;

  public observe(context: DecisionContext): void {
    this.belief.observe(context);
  }

  public chooseBid(context: DecisionContext): number {
    this.observe(context);
    const allowed = context.state.allowedBids ?? [];
    if (allowed.length === 0) {
      return 0;
    }
    if (allowed.length === 1) {
      return allowed[0];
    }

    const zeroPlan = planZeroPath(context);
    const zeroBid = chooseZeroBid(context, zeroPlan, allowed);
    if (zeroBid !== null) {
      return zeroBid;
    }
    return this.rollout.chooseBid(context, allowed);
  }

  public chooseCard(context: DecisionContext): number {
    this.observe(context);
    const evaluated = this.rollout.evaluatePlays(context);
    const best = evaluated[0];
    if (best) {
      this.cachedPlay = {
        cardIndex: best.cardIndex,
        jokerAction: best.jokerAction,
        stateVersion: context.state.stateVersion ?? 0,
      };
      return best.cardIndex;
    }

    const fallback = context.state.validCardIndices?.[0] ?? 0;
    const card = context.me.cards[fallback];
    this.cachedPlay = {
      cardIndex: fallback,
      jokerAction:
        card && isJokerCard(card)
          ? this.fallbackJokerAction(context, fallback)
          : undefined,
      stateVersion: context.state.stateVersion ?? 0,
    };
    return fallback;
  }

  public chooseJokerAction(
    context: DecisionContext,
    cardIndex: number,
  ): JokerAction {
    if (
      this.cachedPlay
      && this.cachedPlay.cardIndex === cardIndex
      && this.cachedPlay.stateVersion === (context.state.stateVersion ?? 0)
      && this.cachedPlay.jokerAction
    ) {
      return this.cachedPlay.jokerAction;
    }
    return this.fallbackJokerAction(context, cardIndex);
  }

  public chooseControlGame(
    context: DecisionContext,
  ): { roundType: RoundType; dealerIndex: number } {
    this.observe(context);
    const zeroSetup = chooseZeroControlSetup(context);
    if (zeroSetup) {
      return zeroSetup;
    }

    const played = context.state.playedRoundTypes ?? ['STANDARD'];
    const candidates = Array.from(new Set(played));
    let roundType = candidates[0] ?? 'STANDARD';
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      const value = this.controlTypeValue(context, candidate);
      if (value > bestValue) {
        bestValue = value;
        roundType = candidate;
      }
    }

    return {
      roundType,
      dealerIndex: this.controlDealer(context),
    };
  }

  public shouldStartGame(context: DecisionContext): boolean {
    const playersCount =
      context.state.playersCount
      ?? context.state.players.length;
    return (
      context.state.hostId === context.myId
      && playersCount === context.state.maxPlayers
    );
  }

  private fallbackJokerAction(
    context: DecisionContext,
    cardIndex: number,
  ): JokerAction {
    const legal = context.state.legalPlays?.find(
      (play) => play.cardIndex === cardIndex,
    )?.jokerActions;
    const wantsTrick = this.wantsTrick(context);
    if (wantsTrick) {
      if (context.state.tableCards.length === 0) {
        const suit = this.bestDemandSuit(context);
        const demand = legal?.find(
          (action) =>
            action.type === 'DEMAND_SUIT'
            && action.suit === suit,
        );
        if (demand) {
          return demand;
        }
      }
      const take = legal?.find((action) => action.type === 'TAKE');
      return take ?? { type: 'TAKE' };
    }

    const drop = legal?.find((action) => action.type === 'DROP');
    if (drop) {
      return drop;
    }
    if (context.state.tableCards.length === 0) {
      return {
        type: 'DROP',
        suit: this.bestDropSuit(context),
      };
    }
    return { type: 'DROP' };
  }

  private wantsTrick(context: DecisionContext): boolean {
    if (context.state.currentRoundType === 'GOLD') {
      return true;
    }
    if (context.state.currentRoundType === 'MISER') {
      return false;
    }
    return (context.me.currentBid ?? 0) > context.me.tricksTaken;
  }

  private bestDemandSuit(context: DecisionContext): Suit {
    let bestSuit: Suit = 'HEARTS';
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const suit of SUITS) {
      const cards = context.me.cards.filter(
        (card): card is CardModel =>
          card !== null
          && !isJokerCard(card)
          && card.suit === suit,
      );
      const honors = cards.filter(
        (card) =>
          card.rank === 'A'
          || card.rank === 'K'
          || card.rank === 'Q',
      ).length;
      const value =
        cards.length * 2
        + honors * 3
        + (
          context.state.trumpSuit === suit
            ? 1
            : 0
        );
      if (value > bestValue) {
        bestValue = value;
        bestSuit = suit;
      }
    }
    return bestSuit;
  }

  private bestDropSuit(context: DecisionContext): Suit {
    let bestSuit: Suit = 'HEARTS';
    let bestLength = -1;
    for (const suit of SUITS) {
      if (suit === context.state.trumpSuit) {
        continue;
      }
      const length = context.me.cards.filter(
        (card) =>
          card !== null
          && !isJokerCard(card)
          && card.suit === suit,
      ).length;
      if (length > bestLength) {
        bestLength = length;
        bestSuit = suit;
      }
    }
    return bestSuit;
  }

  private controlTypeValue(
    context: DecisionContext,
    roundType: RoundType,
  ): number {
    const history = context.state.scoreHistory ?? [];
    let myTotal = 0;
    let opponentsTotal = 0;
    let rounds = 0;
    for (const record of history) {
      if (record.roundType !== roundType) {
        continue;
      }
      myTotal += record.scores[context.myId] ?? 0;
      for (const player of context.state.players) {
        if (player.id !== context.myId) {
          opponentsTotal += record.scores[player.id] ?? 0;
        }
      }
      rounds += 1;
    }

    const opponentsCount = Math.max(
      1,
      context.state.players.length - 1,
    );
    const historicalEdge =
      rounds > 0
        ? (
          myTotal
          - opponentsTotal / opponentsCount
        ) / rounds
        : 0;
    const bestOther = Math.max(
      ...context.state.players
        .filter((_player, index) => index !== context.myIndex)
        .map((player) => player.score),
      Number.NEGATIVE_INFINITY,
    );
    const gap = Math.max(0, bestOther - context.me.score);
    const varianceNeed = Math.min(1.8, gap / 80);
    let value =
      historicalEdge * 1.8
      + CONTROL_VARIANCE[roundType] * varianceNeed;

    if (roundType === 'GOLD') {
      value -= gap > 30 ? 24 : 0;
    }
    if (
      roundType === 'PERCENTS'
      && gap >= 45
    ) {
      value += 35;
    }
    if (
      roundType === 'MISER'
      && gap < 35
    ) {
      value -= 28;
    }
    return value;
  }

  private controlDealer(context: DecisionContext): number {
    let leaderIndex = 0;
    let leaderScore = Number.NEGATIVE_INFINITY;
    context.state.players.forEach((player, index) => {
      if (
        index !== context.myIndex
        && player.score > leaderScore
      ) {
        leaderIndex = index;
        leaderScore = player.score;
      }
    });
    if (
      leaderIndex === context.myIndex
      && context.state.players.length > 1
    ) {
      return (context.myIndex + 1) % context.state.players.length;
    }
    return leaderIndex;
  }
}
