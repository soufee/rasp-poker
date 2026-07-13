import type { DecisionContext } from '../core/stateSelectors';
import type {
  CardModel,
  JokerAction,
  RoundType,
  Suit,
} from '../protocol/types';
import {
  cardKey,
  isJokerCard,
  rankValue,
  resolveWinnerIndex,
  SUITS,
  type TrickCard,
} from './cards';
import { scoreForRound } from './scoring';
import {
  detectOpponentZeroThreats,
  planZeroPath,
  shouldDefendSecondFromZero,
} from './zeroPath';
import {
  DeterministicRandom,
  seedForContext,
  SolarisBelief,
  type SampledDeal,
} from './solarisBelief';

const BID_SAMPLES = 52;
const PLAY_SAMPLES = 64;
const EPSILON = 1e-9;

export interface SolarisPlay {
  cardIndex: number;
  jokerAction?: JokerAction;
}

export interface EvaluatedSolarisPlay extends SolarisPlay {
  utility: number;
}

interface SimPlay {
  playerIndex: number;
  card: CardModel;
  jokerAction?: JokerAction;
}

interface SimGame {
  hands: CardModel[][];
  table: SimPlay[];
  currentPlayerIndex: number;
  tricks: number[];
  bids: Array<number | null>;
  trumpSuit: Suit | null;
  leadSuit: Suit | null;
  roundType: RoundType;
  cardsInHand: number;
  playerIds: string[];
}

interface SimAction {
  cardIndex: number;
  jokerAction?: JokerAction;
}

interface SimulationResult {
  tricks: number[];
}

export class SolarisRollout {
  private readonly belief: SolarisBelief;
  private cachedContext: DecisionContext | null = null;
  private cachedZeroPlan: ReturnType<typeof planZeroPath> | null = null;
  private cachedDefendSecond = false;
  private cachedThreats: ReturnType<typeof detectOpponentZeroThreats> = [];

  public constructor(belief: SolarisBelief) {
    this.belief = belief;
  }

  public chooseBid(context: DecisionContext, allowed: number[]): number {
    if (allowed.length === 0) {
      return 0;
    }
    if (allowed.length === 1) {
      return allowed[0];
    }

    const deals = this.sampleDeals(context, BID_SAMPLES, 'bid');
    let bestBid = allowed[0];
    let bestUtility = Number.NEGATIVE_INFINITY;

    for (const bid of allowed) {
      let weightedUtility = 0;
      let totalWeight = 0;
      for (let sampleIndex = 0; sampleIndex < deals.length; sampleIndex += 1) {
        const deal = deals[sampleIndex];
        const bids = this.completeBids(context, deal.hands, bid);
        const game = this.newRoundGame(context, deal.hands, bids);
        const result = this.simulate(game, context.myIndex);
        const utility = this.roundUtility(context, result.tricks, bids);
        weightedUtility += deal.weight * utility;
        totalWeight += deal.weight;
      }

      const expectedUtility = weightedUtility / Math.max(EPSILON, totalWeight);
      const adjustedUtility =
        expectedUtility
        + this.bidPostureAdjustment(context, bid);
      if (
        adjustedUtility > bestUtility + EPSILON
        || (
          Math.abs(adjustedUtility - bestUtility) <= EPSILON
          && this.bidTieBreak(context, bid, bestBid)
        )
      ) {
        bestUtility = adjustedUtility;
        bestBid = bid;
      }
    }
    return bestBid;
  }

  public evaluatePlays(context: DecisionContext): EvaluatedSolarisPlay[] {
    const candidates = this.legalPlays(context);
    if (candidates.length === 0) {
      return [];
    }

    const deals = this.sampleDeals(context, PLAY_SAMPLES, 'play');
    const results: EvaluatedSolarisPlay[] = [];
    for (const candidate of candidates) {
      let weightedUtility = 0;
      let totalWeight = 0;
      for (const deal of deals) {
        const game = this.currentGame(context, deal.hands);
        if (!this.applyRootAction(game, context.myIndex, candidate)) {
          continue;
        }
        const result = this.simulate(game, context.myIndex);
        const utility =
          this.roundUtility(context, result.tricks, game.bids)
          + this.playPrior(context, candidate);
        weightedUtility += deal.weight * utility;
        totalWeight += deal.weight;
      }
      results.push({
        ...candidate,
        utility: weightedUtility / Math.max(EPSILON, totalWeight),
      });
    }

    return results.sort((left, right) => {
      if (Math.abs(right.utility - left.utility) > EPSILON) {
        return right.utility - left.utility;
      }
      return this.playTieBreak(context, left, right);
    });
  }

  private sampleDeals(
    context: DecisionContext,
    count: number,
    salt: string,
  ): SampledDeal[] {
    const random = new DeterministicRandom(seedForContext(context, salt));
    const deals: SampledDeal[] = [];
    for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
      deals.push(this.belief.sampleDeal(context, random));
    }
    return deals;
  }

  private completeBids(
    context: DecisionContext,
    hands: CardModel[][],
    myBid: number,
  ): Array<number | null> {
    const bids = context.state.players.map((player) => player.currentBid);
    bids[context.myIndex] = myBid;
    const playersCount = context.state.players.length;
    const handSize = context.state.currentRoundCards;
    const first = (context.state.dealerIndex + 1) % playersCount;

    for (let step = 0; step < playersCount; step += 1) {
      const playerIndex = (first + step) % playersCount;
      if (bids[playerIndex] !== null) {
        continue;
      }

      const legal: number[] = [];
      const previousSum = bids.reduce<number>(
        (sum, bid) => sum + (bid ?? 0),
        0,
      );
      const except =
        playerIndex === context.state.dealerIndex
          ? handSize - previousSum
          : -1;
      for (let bid = 0; bid <= handSize; bid += 1) {
        if (bid !== except) {
          legal.push(bid);
        }
      }
      if (legal.length === 0) {
        legal.push(0);
      }
      const estimate = this.estimateBidForHand(
        context,
        hands[playerIndex],
        playerIndex,
      );
      bids[playerIndex] = this.nearest(legal, estimate);
    }
    return bids;
  }

  private estimateBidForHand(
    context: DecisionContext,
    hand: CardModel[],
    playerIndex: number,
  ): number {
    if (
      context.state.isDarkRound
      || context.state.currentRoundType === 'DARK'
    ) {
      const fair = context.state.currentRoundCards / context.state.players.length;
      const playerScore = context.state.players[playerIndex].score;
      const leaderScore = Math.max(
        ...context.state.players.map((player) => player.score),
      );
      return fair + (leaderScore - playerScore >= 35 ? 0.45 : -0.05);
    }

    let estimate = 0;
    const bySuit = new Map<Suit, CardModel[]>();
    for (const card of hand) {
      if (isJokerCard(card)) {
        estimate += 0.94;
        continue;
      }
      const cards = bySuit.get(card.suit) ?? [];
      cards.push(card);
      bySuit.set(card.suit, cards);
    }

    for (const [suit, cards] of bySuit) {
      cards.sort((left, right) => rankValue(right.rank) - rankValue(left.rank));
      const isTrump =
        context.state.trumpSuit !== null
        && suit === context.state.trumpSuit;
      for (let index = 0; index < cards.length; index += 1) {
        const rank = rankValue(cards[index].rank) / 8;
        const topCardFactor = index === 0 ? 1 : Math.max(0.2, 0.72 - index * 0.12);
        if (isTrump) {
          estimate += (0.3 + 0.68 * rank) * topCardFactor;
        } else {
          estimate += Math.pow(rank, 2.05) * 0.72 * topCardFactor;
        }
      }
      if (
        context.state.trumpSuit === null
        && cards.length >= 4
        && cards.some((card) => card.rank === 'A')
      ) {
        estimate += Math.min(1.2, (cards.length - 3) * 0.28);
      }
    }
    return Math.max(0, estimate);
  }

  private nearest(values: number[], target: number): number {
    let best = values[0];
    let distance = Math.abs(best - target);
    for (let index = 1; index < values.length; index += 1) {
      const nextDistance = Math.abs(values[index] - target);
      if (
        nextDistance < distance - EPSILON
        || (
          Math.abs(nextDistance - distance) <= EPSILON
          && values[index] < best
        )
      ) {
        best = values[index];
        distance = nextDistance;
      }
    }
    return best;
  }

  private newRoundGame(
    context: DecisionContext,
    hands: CardModel[][],
    bids: Array<number | null>,
  ): SimGame {
    return {
      hands: hands.map((hand) => [...hand]),
      table: [],
      currentPlayerIndex:
        (context.state.dealerIndex + 1)
        % context.state.players.length,
      tricks: context.state.players.map(() => 0),
      bids: [...bids],
      trumpSuit: context.state.trumpSuit,
      leadSuit: null,
      roundType: context.state.currentRoundType,
      cardsInHand: context.state.currentRoundCards,
      playerIds: context.state.players.map((player) => player.id),
    };
  }

  private currentGame(
    context: DecisionContext,
    hands: CardModel[][],
  ): SimGame {
    const table = context.state.tableCards.map((played) => ({
      playerIndex: context.state.players.findIndex(
        (player) => player.id === played.playerId,
      ),
      card: played.card,
      jokerAction: played.jokerAction,
    }));
    return {
      hands: hands.map((hand) => [...hand]),
      table,
      currentPlayerIndex: context.state.currentPlayerIndex,
      tricks: context.state.players.map((player) => player.tricksTaken),
      bids: context.state.players.map((player) => player.currentBid),
      trumpSuit: context.state.trumpSuit,
      leadSuit: context.state.currentTrickLeadSuit ?? null,
      roundType: context.state.currentRoundType,
      cardsInHand: context.state.currentRoundCards,
      playerIds: context.state.players.map((player) => player.id),
    };
  }

  private applyRootAction(
    game: SimGame,
    playerIndex: number,
    action: SolarisPlay,
  ): boolean {
    if (game.currentPlayerIndex !== playerIndex) {
      return false;
    }
    const card = game.hands[playerIndex][action.cardIndex];
    if (!card) {
      return false;
    }
    this.applyAction(game, {
      cardIndex: action.cardIndex,
      jokerAction: action.jokerAction,
    });
    return true;
  }

  private simulate(
    game: SimGame,
    rootPlayerIndex: number,
  ): SimulationResult {
    let guard = 0;
    while (game.hands.some((hand) => hand.length > 0) && guard < 256) {
      guard += 1;
      const playerIndex = game.currentPlayerIndex;
      const action = this.policyAction(game, playerIndex, rootPlayerIndex);
      this.applyAction(game, action);
    }
    return { tricks: [...game.tricks] };
  }

  private policyAction(
    game: SimGame,
    playerIndex: number,
    rootPlayerIndex: number,
  ): SimAction {
    const actions = this.simLegalActions(game, playerIndex);
    if (actions.length === 1) {
      return actions[0];
    }

    const desire = this.takeDesire(game, playerIndex);
    let best = actions[0];
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const action of actions) {
      const score = this.policyActionScore(
        game,
        playerIndex,
        action,
        desire,
        playerIndex === rootPlayerIndex,
      );
      if (
        score > bestScore + EPSILON
        || (
          Math.abs(score - bestScore) <= EPSILON
          && this.simActionTieBreak(game, playerIndex, action, best, desire)
        )
      ) {
        best = action;
        bestScore = score;
      }
    }
    return best;
  }

  private policyActionScore(
    game: SimGame,
    playerIndex: number,
    action: SimAction,
    desire: number,
    isRoot: boolean,
  ): number {
    const card = game.hands[playerIndex][action.cardIndex];
    const winProbability = this.controlProbability(game, playerIndex, action);
    const cost = this.cardCost(card, action.jokerAction, game.trumpSuit);
    const tricksLeft = Math.max(1, game.hands[playerIndex].length);
    const need = Math.max(
      0,
      (game.bids[playerIndex] ?? 0) - game.tricks[playerIndex],
    );

    let score: number;
    if (desire >= 0) {
      const urgency = need >= tricksLeft ? 1.8 : 1 + Math.max(0, desire) * 0.45;
      score =
        winProbability * 115 * urgency
        - cost * (need >= tricksLeft ? 0.12 : 0.72);
      if (winProbability >= 0.78 && need < tricksLeft) {
        score += 20 - Math.min(20, cost) * 0.35;
      }
    } else {
      score =
        (1 - winProbability) * 125
        + cost * 0.58;
      if (
        action.jokerAction
        && action.jokerAction.type !== 'DROP'
      ) {
        score -= 95;
      }
    }

    if (game.table.length === 0) {
      score += this.leadStructureValue(
        game,
        playerIndex,
        card,
        action.jokerAction,
        desire,
      );
    }
    if (isRoot) {
      score += winProbability * 2;
    }
    return score;
  }

  private takeDesire(game: SimGame, playerIndex: number): number {
    if (game.roundType === 'GOLD') {
      return 1.25;
    }
    if (game.roundType === 'MISER') {
      const taken = game.tricks[playerIndex];
      const canTakeAll =
        taken > 0
        && taken + game.hands[playerIndex].length === game.cardsInHand;
      if (canTakeAll) {
        const allValue = 100;
        const ordinaryValue = -10 * taken;
        if (allValue - ordinaryValue >= 80) {
          return 1.5;
        }
      }
      return -1.35;
    }

    const bid = game.bids[playerIndex] ?? 0;
    const need = bid - game.tricks[playerIndex];
    const tricksLeft = Math.max(1, game.hands[playerIndex].length);
    if (need <= 0) {
      return -1.2;
    }
    if (need >= tricksLeft) {
      return 1.8;
    }
    return Math.max(0.1, need / tricksLeft);
  }

  private leadStructureValue(
    game: SimGame,
    playerIndex: number,
    card: CardModel,
    jokerAction: JokerAction | undefined,
    desire: number,
  ): number {
    const hand = game.hands[playerIndex];
    if (
      isJokerCard(card)
      && jokerAction?.type === 'DEMAND_SUIT'
    ) {
      const length = hand.filter(
        (entry) =>
          !isJokerCard(entry)
          && entry.suit === jokerAction.suit,
      ).length;
      const high = hand.filter(
        (entry) =>
          !isJokerCard(entry)
          && entry.suit === jokerAction.suit
          && rankValue(entry.rank) >= rankValue('Q'),
      ).length;
      return desire >= 0
        ? length * 7 + high * 10
        : -45;
    }
    if (
      isJokerCard(card)
      && jokerAction?.type === 'DROP'
    ) {
      return desire < 0 ? 55 : -70;
    }
    if (isJokerCard(card)) {
      return desire >= 0 ? 5 : -80;
    }

    const suitLength = hand.filter(
      (entry) =>
        !isJokerCard(entry)
        && entry.suit === card.suit,
    ).length;
    if (desire >= 0) {
      const honor = rankValue(card.rank) >= rankValue('Q') ? 10 : 0;
      return suitLength * 2.2 + honor;
    }
    return (game.cardsInHand - suitLength) * 1.4 - rankValue(card.rank) * 0.3;
  }

  private controlProbability(
    game: SimGame,
    playerIndex: number,
    action: SimAction,
  ): number {
    const card = game.hands[playerIndex][action.cardIndex];
    const trialTable = [
      ...game.table,
      {
        playerIndex,
        card,
        jokerAction: action.jokerAction,
      },
    ];
    const plays = trialTable.map((played) => ({
      card: played.card,
      jokerAction: played.jokerAction,
    }));
    const winnerSlot = resolveWinnerIndex(
      plays,
      game.trumpSuit,
      game.leadSuit,
    );
    if (
      winnerSlot < 0
      || trialTable[winnerSlot].playerIndex !== playerIndex
    ) {
      return 0;
    }
    if (
      isJokerCard(card)
      && action.jokerAction?.type !== 'DROP'
    ) {
      return 1;
    }

    const playersAfter =
      game.playerIds.length
      - trialTable.length;
    if (playersAfter <= 0) {
      return 1;
    }

    let survival = 1;
    let nextPlayer = (playerIndex + 1) % game.playerIds.length;
    const hypothetical: SimGame = {
      ...game,
      table: trialTable,
      leadSuit: this.leadAfterPlay(game, card, action.jokerAction),
    };
    for (let step = 0; step < playersAfter; step += 1) {
      const legal = this.simLegalActions(hypothetical, nextPlayer);
      const canBeat = legal.some((reply) =>
        this.replyBeatsPlayer(hypothetical, nextPlayer, reply, playerIndex),
      );
      if (canBeat) {
        const replyDesire = this.takeDesire(game, nextPlayer);
        const beatChance =
          replyDesire > 1
            ? 0.92
            : replyDesire >= 0
              ? 0.72
              : 0.18;
        survival *= 1 - beatChance;
      }
      nextPlayer = (nextPlayer + 1) % game.playerIds.length;
    }
    return Math.max(0, Math.min(1, survival));
  }

  private replyBeatsPlayer(
    game: SimGame,
    replyPlayer: number,
    reply: SimAction,
    targetPlayer: number,
  ): boolean {
    const card = game.hands[replyPlayer][reply.cardIndex];
    const table = [
      ...game.table,
      {
        playerIndex: replyPlayer,
        card,
        jokerAction: reply.jokerAction,
      },
    ];
    const winner = resolveWinnerIndex(
      table.map((played) => ({
        card: played.card,
        jokerAction: played.jokerAction,
      })),
      game.trumpSuit,
      game.leadSuit,
    );
    return (
      winner >= 0
      && table[winner].playerIndex !== targetPlayer
    );
  }

  private leadAfterPlay(
    game: SimGame,
    card: CardModel,
    jokerAction: JokerAction | undefined,
  ): Suit | null {
    if (game.table.length > 0) {
      return game.leadSuit;
    }
    if (!isJokerCard(card)) {
      return card.suit;
    }
    if (
      jokerAction?.type === 'DEMAND_SUIT'
      || jokerAction?.type === 'DROP'
    ) {
      return jokerAction.suit ?? null;
    }
    return null;
  }

  private simLegalActions(
    game: SimGame,
    playerIndex: number,
  ): SimAction[] {
    const hand = game.hands[playerIndex];
    const indices = this.simLegalCardIndices(game, hand);
    const actions: SimAction[] = [];
    for (const cardIndex of indices) {
      const card = hand[cardIndex];
      if (!isJokerCard(card)) {
        actions.push({ cardIndex });
        continue;
      }
      if (game.table.length === 0) {
        actions.push({ cardIndex, jokerAction: { type: 'TAKE' } });
        for (const suit of SUITS) {
          actions.push({
            cardIndex,
            jokerAction: { type: 'DEMAND_SUIT', suit },
          });
        }
        for (const suit of SUITS) {
          actions.push({
            cardIndex,
            jokerAction: { type: 'DROP', suit },
          });
        }
      } else {
        actions.push({ cardIndex, jokerAction: { type: 'TAKE' } });
        actions.push({ cardIndex, jokerAction: { type: 'DROP' } });
      }
    }
    return actions;
  }

  private simLegalCardIndices(
    game: SimGame,
    hand: CardModel[],
  ): number[] {
    const all = hand.map((_card, index) => index);
    if (game.table.length === 0) {
      return all;
    }

    const lead = game.table[0];
    const demandSuit =
      isJokerCard(lead.card)
      && lead.jokerAction?.type === 'DEMAND_SUIT'
        ? lead.jokerAction.suit
        : null;
    if (demandSuit !== null) {
      const demanded = all.filter((index) => {
        const card = hand[index];
        return !isJokerCard(card) && card.suit === demandSuit;
      });
      if (demanded.length > 0) {
        return this.highestIndices(hand, demanded);
      }
      if (game.trumpSuit !== null) {
        const trumps = all.filter((index) => {
          const card = hand[index];
          return !isJokerCard(card) && card.suit === game.trumpSuit;
        });
        if (trumps.length > 0) {
          return this.highestIndices(hand, trumps);
        }
      }
      return all;
    }

    if (game.leadSuit === null) {
      return all;
    }
    const following = all.filter((index) => {
      const card = hand[index];
      return !isJokerCard(card) && card.suit === game.leadSuit;
    });
    if (following.length > 0) {
      return all.filter((index) => {
        const card = hand[index];
        return isJokerCard(card) || card.suit === game.leadSuit;
      });
    }

    if (game.trumpSuit !== null) {
      const trumps = all.filter((index) => {
        const card = hand[index];
        return !isJokerCard(card) && card.suit === game.trumpSuit;
      });
      if (trumps.length > 0) {
        return all.filter((index) => {
          const card = hand[index];
          return isJokerCard(card) || card.suit === game.trumpSuit;
        });
      }
    }
    return all;
  }

  private highestIndices(
    hand: CardModel[],
    indices: number[],
  ): number[] {
    const highest = Math.max(
      ...indices.map((index) => rankValue(hand[index].rank)),
    );
    return indices.filter(
      (index) => rankValue(hand[index].rank) === highest,
    );
  }

  private applyAction(game: SimGame, action: SimAction): void {
    const playerIndex = game.currentPlayerIndex;
    const [card] = game.hands[playerIndex].splice(action.cardIndex, 1);
    if (game.table.length === 0) {
      game.leadSuit = this.leadAfterPlay(game, card, action.jokerAction);
    }
    game.table.push({
      playerIndex,
      card,
      jokerAction: action.jokerAction,
    });

    if (game.table.length < game.playerIds.length) {
      game.currentPlayerIndex =
        (playerIndex + 1)
        % game.playerIds.length;
      return;
    }

    const winnerSlot = resolveWinnerIndex(
      game.table.map((played) => ({
        card: played.card,
        jokerAction: played.jokerAction,
      })),
      game.trumpSuit,
      game.leadSuit,
    );
    const winner =
      winnerSlot >= 0
        ? game.table[winnerSlot].playerIndex
        : game.table[0].playerIndex;
    game.tricks[winner] += 1;
    game.currentPlayerIndex = winner;
    game.table = [];
    game.leadSuit = null;
  }

  private cardCost(
    card: CardModel,
    jokerAction: JokerAction | undefined,
    trumpSuit: Suit | null,
  ): number {
    if (isJokerCard(card)) {
      return jokerAction?.type === 'DROP' ? 12 : 100;
    }
    const base = rankValue(card.rank);
    if (
      trumpSuit !== null
      && card.suit === trumpSuit
    ) {
      return 20 + base;
    }
    return base;
  }

  private simActionTieBreak(
    game: SimGame,
    playerIndex: number,
    candidate: SimAction,
    incumbent: SimAction,
    desire: number,
  ): boolean {
    const candidateCard = game.hands[playerIndex][candidate.cardIndex];
    const incumbentCard = game.hands[playerIndex][incumbent.cardIndex];
    const candidateCost = this.cardCost(
      candidateCard,
      candidate.jokerAction,
      game.trumpSuit,
    );
    const incumbentCost = this.cardCost(
      incumbentCard,
      incumbent.jokerAction,
      game.trumpSuit,
    );
    if (desire >= 0) {
      return candidateCost < incumbentCost;
    }
    return candidateCost > incumbentCost;
  }

  private legalPlays(context: DecisionContext): SolarisPlay[] {
    const legal = context.state.legalPlays;
    if (legal && legal.length > 0) {
      const plays: SolarisPlay[] = [];
      for (const entry of legal) {
        const card = context.me.cards[entry.cardIndex];
        if (
          card
          && isJokerCard(card)
          && entry.jokerActions
          && entry.jokerActions.length > 0
        ) {
          for (const jokerAction of entry.jokerActions) {
            plays.push({
              cardIndex: entry.cardIndex,
              jokerAction,
            });
          }
        } else {
          plays.push({ cardIndex: entry.cardIndex });
        }
      }
      return plays;
    }

    const indices = context.state.validCardIndices ?? [];
    const plays: SolarisPlay[] = [];
    for (const cardIndex of indices) {
      const card = context.me.cards[cardIndex];
      if (!card || !isJokerCard(card)) {
        plays.push({ cardIndex });
        continue;
      }
      if (context.state.tableCards.length === 0) {
        plays.push({ cardIndex, jokerAction: { type: 'TAKE' } });
        for (const suit of SUITS) {
          plays.push({
            cardIndex,
            jokerAction: { type: 'DEMAND_SUIT', suit },
          });
          plays.push({
            cardIndex,
            jokerAction: { type: 'DROP', suit },
          });
        }
      } else {
        plays.push({ cardIndex, jokerAction: { type: 'TAKE' } });
        plays.push({ cardIndex, jokerAction: { type: 'DROP' } });
      }
    }
    return plays;
  }

  private roundUtility(
    context: DecisionContext,
    tricks: number[],
    bids: Array<number | null>,
  ): number {
    const deltas = context.state.players.map((_player, index) =>
      scoreForRound(
        context.state.currentRoundType,
        context.state.currentRoundCards,
        bids[index] ?? 0,
        tricks[index],
      ),
    );
    const totals = context.state.players.map(
      (player, index) => player.score + deltas[index],
    );
    const myDelta = deltas[context.myIndex];
    const myTotal = totals[context.myIndex];
    const leaderBefore = Math.max(
      ...context.state.players
        .filter((_player, index) => index !== context.myIndex)
        .map((player) => player.score),
      Number.NEGATIVE_INFINITY,
    );
    const trail = leaderBefore - context.me.score;

    let utility = myDelta * (trail >= 40 ? 1.08 : 1.28);
    for (let index = 0; index < deltas.length; index += 1) {
      if (index === context.myIndex) {
        continue;
      }
      utility -= this.rivalryWeight(context, index) * deltas[index];
    }

    const bestOtherAfter = Math.max(
      ...totals.filter((_score, index) => index !== context.myIndex),
      Number.NEGATIVE_INFINITY,
    );
    utility += (myTotal - bestOtherAfter) * 0.16;

    this.refreshMeta(context);
    const zeroPlan = this.cachedZeroPlan;
    if (zeroPlan?.active) {
      if (myTotal === 0) {
        utility += 2400;
      } else {
        utility -= Math.min(900, Math.abs(myTotal) * 8);
      }
      if (
        zeroPlan.maxTricksAllowed !== null
        && tricks[context.myIndex] > zeroPlan.maxTricksAllowed
      ) {
        utility -= 1200;
      }
    }

    if (this.cachedDefendSecond) {
      for (const threat of this.cachedThreats) {
        if (totals[threat.playerIndex] === 0) {
          utility -= 1800 * threat.severity;
        } else {
          utility += Math.min(220, Math.abs(totals[threat.playerIndex]) * 2);
        }
      }
    }

    if (this.isLateMatch(context)) {
      const place = this.projectedPlace(totals, context.myIndex);
      const placementValue = [0, 1200, 470, 80, -180, -320, -450];
      utility += placementValue[place] ?? -500;
      if (myTotal === 0) {
        utility = Math.max(utility, placementValue[2] + 300);
      }
    }
    return utility;
  }

  private refreshMeta(context: DecisionContext): void {
    if (this.cachedContext === context) {
      return;
    }
    this.cachedContext = context;
    this.cachedZeroPlan = planZeroPath(context);
    this.cachedDefendSecond = shouldDefendSecondFromZero(context);
    this.cachedThreats =
      this.cachedDefendSecond
        ? detectOpponentZeroThreats(context)
        : [];
  }

  private rivalryWeight(
    context: DecisionContext,
    playerIndex: number,
  ): number {
    const player = context.state.players[playerIndex];
    const bestScore = Math.max(
      ...context.state.players.map((entry) => entry.score),
    );
    let weight = 0.24;
    if (player.score >= bestScore - 2) {
      weight += 0.5;
    } else if (player.score >= context.me.score - 15) {
      weight += 0.2;
    }
    if (
      player.currentBid !== null
      && player.currentBid >= 3
    ) {
      weight += Math.min(0.25, player.currentBid * 0.04);
    }
    if (context.state.currentRoundType === 'PERCENTS') {
      weight *= 1.25;
    }
    return weight;
  }

  private isLateMatch(context: DecisionContext): boolean {
    if (
      context.state.state === 'CONTROL_GAME_SETUP'
      || (context.state.controlGamesPlayed ?? 0) > 0
    ) {
      return true;
    }
    const plan = context.state.plan ?? [];
    const roundIndex = context.state.currentRoundIndex ?? 0;
    return plan.length > 0 && roundIndex >= plan.length - 2;
  }

  private projectedPlace(
    totals: number[],
    myIndex: number,
  ): number {
    if (totals[myIndex] === 0) {
      return 2;
    }
    let place = 1;
    for (let index = 0; index < totals.length; index += 1) {
      if (
        index !== myIndex
        && totals[index] !== 0
        && totals[index] > totals[myIndex]
      ) {
        place += 1;
      }
    }
    if (
      place === 2
      && totals.some((score, index) => index !== myIndex && score === 0)
    ) {
      place = 3;
    }
    return place;
  }

  private bidPostureAdjustment(
    context: DecisionContext,
    bid: number,
  ): number {
    const opponents = context.state.players.filter(
      (_player, index) => index !== context.myIndex,
    );
    const bestOther = Math.max(
      ...opponents.map((player) => player.score),
      Number.NEGATIVE_INFINITY,
    );
    const gap = bestOther - context.me.score;
    if (gap >= 45) {
      return bid * 0.8;
    }
    if (gap <= -35) {
      return -bid * 0.55;
    }
    return -bid * 0.08;
  }

  private bidTieBreak(
    context: DecisionContext,
    candidate: number,
    incumbent: number,
  ): boolean {
    const others = context.state.players.filter(
      (_player, index) => index !== context.myIndex,
    );
    const bestOther = Math.max(
      ...others.map((player) => player.score),
      Number.NEGATIVE_INFINITY,
    );
    if (context.me.score + 30 < bestOther) {
      return candidate > incumbent;
    }
    return candidate < incumbent;
  }

  private playPrior(
    context: DecisionContext,
    play: SolarisPlay,
  ): number {
    const card = context.me.cards[play.cardIndex];
    if (!card) {
      return -1000;
    }
    const desire =
      context.state.currentRoundType === 'GOLD'
        ? 1
        : context.state.currentRoundType === 'MISER'
          ? -1
          : (context.me.currentBid ?? 0) > context.me.tricksTaken
            ? 1
            : -1;
    const cost = this.cardCost(
      card,
      play.jokerAction,
      context.state.trumpSuit,
    );
    let prior = desire >= 0 ? -cost * 0.08 : cost * 0.09;
    if (
      isJokerCard(card)
      && play.jokerAction?.type === 'DEMAND_SUIT'
    ) {
      const demandSuit = play.jokerAction.suit;
      const length = context.me.cards.filter(
        (entry) =>
          entry !== null
          && !isJokerCard(entry)
          && entry.suit === demandSuit,
      ).length;
      prior += length * 1.2;
    }
    return prior;
  }

  private playTieBreak(
    context: DecisionContext,
    left: SolarisPlay,
    right: SolarisPlay,
  ): number {
    const leftCard = context.me.cards[left.cardIndex];
    const rightCard = context.me.cards[right.cardIndex];
    if (!leftCard || !rightCard) {
      return left.cardIndex - right.cardIndex;
    }
    const leftCost = this.cardCost(
      leftCard,
      left.jokerAction,
      context.state.trumpSuit,
    );
    const rightCost = this.cardCost(
      rightCard,
      right.jokerAction,
      context.state.trumpSuit,
    );
    const needsTrick =
      context.state.currentRoundType === 'GOLD'
      || (
        context.state.currentRoundType !== 'MISER'
        && (context.me.currentBid ?? 0) > context.me.tricksTaken
      );
    if (needsTrick) {
      return leftCost - rightCost;
    }
    return rightCost - leftCost;
  }
}

export function sameSolarisPlay(
  left: SolarisPlay,
  right: SolarisPlay,
): boolean {
  if (left.cardIndex !== right.cardIndex) {
    return false;
  }
  return jokerActionKey(left.jokerAction) === jokerActionKey(right.jokerAction);
}

function jokerActionKey(action: JokerAction | undefined): string {
  if (!action) {
    return '-';
  }
  if (action.type === 'TAKE') {
    return 'TAKE';
  }
  return `${action.type}:${action.suit ?? '-'}`;
}

export function describeSolarisPlay(
  context: DecisionContext,
  play: SolarisPlay,
): string {
  const card = context.me.cards[play.cardIndex];
  const key = card ? cardKey(card) : `index:${play.cardIndex}`;
  return `${key}/${jokerActionKey(play.jokerAction)}`;
}
