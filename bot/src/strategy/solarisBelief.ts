import type { DecisionContext } from '../core/stateSelectors';
import type { CardModel, PlayedCard, Suit } from '../protocol/types';
import {
  cardKey,
  FULL_DECK,
  isJokerCard,
  rankValue,
} from './cards';

export interface SampledDeal {
  hands: CardModel[][];
  weight: number;
}

export class DeterministicRandom {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
    if (this.state === 0) {
      this.state = 0x9e3779b9;
    }
  }

  public next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  public int(limit: number): number {
    if (limit <= 1) {
      return 0;
    }
    return Math.floor(this.next() * limit);
  }

  public shuffle<T>(values: T[]): void {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const other = this.int(index + 1);
      [values[index], values[other]] = [values[other], values[index]];
    }
  }
}

export function seedForContext(context: DecisionContext, salt: string): number {
  const hand = context.me.cards
    .filter((card): card is CardModel => card !== null)
    .map((card) => cardKey(card))
    .join(',');
  const source =
    `${context.myId}|${context.state.currentRoundIndex ?? 0}`
    + `|${context.state.controlGamesPlayed ?? 0}|${context.state.stateVersion ?? 0}`
    + `|${context.state.currentRoundType}|${context.state.currentRoundCards}`
    + `|${context.state.tableCards.length}|${hand}|${salt}`;

  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class SolarisBelief {
  private roundKey = '';
  private lastOwnCount = 0;
  private readonly seen = new Set<string>();
  private readonly voidSuits = new Map<string, Set<Suit>>();

  public observe(context: DecisionContext): void {
    const ownCount = context.me.cards.filter((card) => card !== null).length;
    const nextRoundKey = this.getRoundKey(context);
    const freshDeal =
      nextRoundKey !== this.roundKey
      || ownCount > this.lastOwnCount + 1;

    if (freshDeal) {
      this.roundKey = nextRoundKey;
      this.seen.clear();
      this.voidSuits.clear();
    }
    this.lastOwnCount = ownCount;

    for (const card of context.me.cards) {
      if (card) {
        this.seen.add(cardKey(card));
      }
    }
    for (const played of context.state.tableCards) {
      this.seen.add(cardKey(played.card));
    }
    this.observeVoids(context);
  }

  public hasSeen(card: CardModel): boolean {
    return this.seen.has(cardKey(card));
  }

  public isVoid(playerId: string, suit: Suit): boolean {
    return this.voidSuits.get(playerId)?.has(suit) ?? false;
  }

  public sampleDeal(
    context: DecisionContext,
    random: DeterministicRandom,
  ): SampledDeal {
    const fixedHands = context.state.players.map((player) =>
      player.cards.filter((card): card is CardModel => card !== null),
    );
    const pool = FULL_DECK
      .filter((card) => !this.seen.has(card.key))
      .map((card) => ({ suit: card.suit, rank: card.rank, isJoker: card.isJoker }));

    const forced = this.forcePublicTrump(context, fixedHands, pool);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const result = this.tryAssign(context, fixedHands, forced, random);
      if (result) {
        return {
          hands: result,
          weight: this.bidConsistencyWeight(context, result),
        };
      }
    }

    const fallback = fixedHands.map((hand) => [...hand]);
    const fallbackPool = [...forced];
    random.shuffle(fallbackPool);
    for (let playerIndex = 0; playerIndex < fallback.length; playerIndex += 1) {
      const target = context.state.players[playerIndex].cards.length;
      while (fallback[playerIndex].length < target && fallbackPool.length > 0) {
        const card = fallbackPool.pop();
        if (card) {
          fallback[playerIndex].push(card);
        }
      }
    }
    return {
      hands: fallback,
      weight: this.bidConsistencyWeight(context, fallback),
    };
  }

  private getRoundKey(context: DecisionContext): string {
    return (
      `${context.state.currentRoundIndex ?? 0}|${context.state.controlGamesPlayed ?? 0}`
      + `|${context.state.currentRoundType}|${context.state.currentRoundCards}`
      + `|${context.state.dealerIndex}|${context.state.trumpSuit ?? '-'}`
    );
  }

  private observeVoids(context: DecisionContext): void {
    const table = context.state.tableCards;
    if (table.length < 2) {
      return;
    }

    const lead = table[0];
    const demandSuit =
      isJokerCard(lead.card) && lead.jokerAction?.type === 'DEMAND_SUIT'
        ? lead.jokerAction.suit
        : null;
    const leadSuit = this.leadSuit(lead);

    for (let index = 1; index < table.length; index += 1) {
      const played = table[index];
      if (isJokerCard(played.card)) {
        continue;
      }

      if (demandSuit !== null) {
        if (played.card.suit !== demandSuit) {
          this.markVoid(played.playerId, demandSuit);
          if (
            context.state.trumpSuit !== null
            && played.card.suit !== context.state.trumpSuit
          ) {
            this.markVoid(played.playerId, context.state.trumpSuit);
          }
        }
        continue;
      }

      if (leadSuit !== null && played.card.suit !== leadSuit) {
        this.markVoid(played.playerId, leadSuit);
        if (
          context.state.trumpSuit !== null
          && played.card.suit !== context.state.trumpSuit
        ) {
          this.markVoid(played.playerId, context.state.trumpSuit);
        }
      }
    }
  }

  private leadSuit(played: PlayedCard): Suit | null {
    if (!isJokerCard(played.card)) {
      return played.card.suit;
    }
    if (
      played.jokerAction?.type === 'DEMAND_SUIT'
      || played.jokerAction?.type === 'DROP'
    ) {
      return played.jokerAction.suit ?? null;
    }
    return null;
  }

  private markVoid(playerId: string, suit: Suit): void {
    const suits = this.voidSuits.get(playerId) ?? new Set<Suit>();
    suits.add(suit);
    this.voidSuits.set(playerId, suits);
  }

  private forcePublicTrump(
    context: DecisionContext,
    fixedHands: CardModel[][],
    pool: CardModel[],
  ): CardModel[] {
    const available = [...pool];
    const trumpCard = context.state.trumpCard;
    if (
      context.state.state !== 'BIDDING'
      || !trumpCard
      || this.seen.has(cardKey(trumpCard))
    ) {
      return available;
    }

    const dealer = context.state.dealerIndex;
    if (dealer < 0 || dealer >= fixedHands.length) {
      return available;
    }
    const targetSize = context.state.players[dealer].cards.length;
    if (fixedHands[dealer].length >= targetSize) {
      return available;
    }

    const poolIndex = available.findIndex((card) => cardKey(card) === cardKey(trumpCard));
    if (poolIndex < 0) {
      return available;
    }
    const [knownTrump] = available.splice(poolIndex, 1);
    fixedHands[dealer].push(knownTrump);
    return available;
  }

  private tryAssign(
    context: DecisionContext,
    fixedHands: CardModel[][],
    sourcePool: CardModel[],
    random: DeterministicRandom,
  ): CardModel[][] | null {
    const hands = fixedHands.map((hand) => [...hand]);
    const pool = [...sourcePool];
    const slots: number[] = [];

    for (let playerIndex = 0; playerIndex < hands.length; playerIndex += 1) {
      const missing =
        context.state.players[playerIndex].cards.length
        - hands[playerIndex].length;
      for (let count = 0; count < missing; count += 1) {
        slots.push(playerIndex);
      }
    }

    random.shuffle(slots);
    slots.sort((left, right) => {
      const leftConstraints = this.voidSuits.get(context.state.players[left].id)?.size ?? 0;
      const rightConstraints = this.voidSuits.get(context.state.players[right].id)?.size ?? 0;
      return rightConstraints - leftConstraints;
    });

    for (const playerIndex of slots) {
      const candidates: Array<{ poolIndex: number; weight: number }> = [];
      for (let poolIndex = 0; poolIndex < pool.length; poolIndex += 1) {
        const card = pool[poolIndex];
        const weight = this.assignmentWeight(card, playerIndex, context);
        if (weight > 0) {
          candidates.push({ poolIndex, weight });
        }
      }
      if (candidates.length === 0) {
        return null;
      }

      const chosen = this.weightedChoice(candidates, random);
      const [card] = pool.splice(chosen, 1);
      hands[playerIndex].push(card);
    }
    return hands;
  }

  private assignmentWeight(
    card: CardModel,
    playerIndex: number,
    context: DecisionContext,
  ): number {
    const player = context.state.players[playerIndex];
    if (!isJokerCard(card) && this.isVoid(player.id, card.suit)) {
      return 0;
    }

    const bid = player.currentBid;
    if (bid === null) {
      return 1;
    }
    const handSize = Math.max(1, context.state.currentRoundCards);
    const fairShare = 1 / Math.max(1, context.state.players.length);
    const bidSignal = bid / handSize - fairShare;
    const strength = this.cardStrength(card, context.state.trumpSuit);
    return Math.exp(bidSignal * (strength - 0.45) * 2.4);
  }

  private weightedChoice(
    candidates: Array<{ poolIndex: number; weight: number }>,
    random: DeterministicRandom,
  ): number {
    const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    let cursor = random.next() * total;
    for (const candidate of candidates) {
      cursor -= candidate.weight;
      if (cursor <= 0) {
        return candidate.poolIndex;
      }
    }
    return candidates[candidates.length - 1].poolIndex;
  }

  private bidConsistencyWeight(
    context: DecisionContext,
    hands: CardModel[][],
  ): number {
    if (
      context.state.currentRoundType === 'GOLD'
      || context.state.currentRoundType === 'MISER'
    ) {
      return 1;
    }

    let squaredError = 0;
    let observations = 0;
    for (let playerIndex = 0; playerIndex < hands.length; playerIndex += 1) {
      if (playerIndex === context.myIndex) {
        continue;
      }
      const bid = context.state.players[playerIndex].currentBid;
      if (bid === null) {
        continue;
      }
      const estimate = hands[playerIndex].reduce(
        (sum, card) => sum + this.cardStrength(card, context.state.trumpSuit),
        0,
      );
      squaredError += Math.pow(estimate - bid, 2);
      observations += 1;
    }
    if (observations === 0) {
      return 1;
    }
    return Math.max(0.08, Math.exp(-0.18 * squaredError / observations));
  }

  private cardStrength(card: CardModel, trumpSuit: Suit | null): number {
    if (isJokerCard(card)) {
      return 0.98;
    }
    const rank = rankValue(card.rank) / 8;
    if (trumpSuit !== null && card.suit === trumpSuit) {
      return 0.28 + rank * 0.68;
    }
    return Math.pow(rank, 2.1) * 0.72;
  }
}
