/**
 * Grok — strong heuristic bot for «Расписной покер».
 *
 * Design goals (must finish within ~2s of turn budget):
 *  - Exact-contract awareness (exact bid pays 10×/20×, underbid −10×, overbid only +taken)
 *  - Round-type awareness (MISER avoid tricks, GOLD take all, PERCENTS amplify)
 *  - Trick evaluation: who currently wins the table, can I beat it cheaply?
 *  - Joker policy: TAKE / DEMAND_SUIT / DROP chosen by contract pressure
 *  - Dark bidding: Bayesian-ish prior over hand strength without seeing cards
 *
 * Not MCTS: branching is huge with imperfect info; pure search would blow the timer.
 * Instead: O(hand × table) heuristics + small local search over legal moves.
 */

import type { DecisionContext } from '../core/stateSelectors';
import { myVisibleCards, remainingTricks, tricksNeeded } from '../core/stateSelectors';
import type { CardModel, JokerAction, Rank, RoundType, Suit } from '../protocol/types';
import type { Strategy } from './Strategy';

const RANK_ORDER: Rank[] = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS: Suit[] = ['SPADES', 'HEARTS', 'DIAMONDS', 'CLUBS'];

function rankValue(rank: Rank): number {
  return RANK_ORDER.indexOf(rank);
}

function isJokerCard(card: CardModel | null | undefined): boolean {
  return Boolean(card && (card.isJoker || (card.suit === 'SPADES' && card.rank === '7')));
}

function cardPower(card: CardModel, trump: Suit | null): number {
  if (isJokerCard(card)) {
    return 100;
  }
  const base = rankValue(card.rank);
  if (trump && card.suit === trump) {
    return 20 + base;
  }
  return base;
}

/** Rough estimate of how many tricks a visible hand can take. */
function estimateTricks(cards: CardModel[], trump: Suit | null, players: number): number {
  if (cards.length === 0) {
    return 0;
  }
  let score = 0;
  let jokers = 0;
  let highTrumps = 0;
  let aces = 0;
  let kings = 0;

  for (const card of cards) {
    if (isJokerCard(card)) {
      jokers += 1;
      score += 0.95;
      continue;
    }
    if (trump && card.suit === trump) {
      if (rankValue(card.rank) >= rankValue('10')) {
        highTrumps += 1;
        score += 0.75;
      } else {
        score += 0.35;
      }
      continue;
    }
    if (card.rank === 'A') {
      aces += 1;
      score += 0.55;
    } else if (card.rank === 'K') {
      kings += 1;
      score += 0.3;
    } else if (card.rank === 'Q' || card.rank === 'J') {
      score += 0.12;
    }
  }

  // Length control: long trump suit is gold
  if (trump) {
    const trumpLen = cards.filter((c) => !isJokerCard(c) && c.suit === trump).length;
    score += Math.max(0, trumpLen - Math.ceil(cards.length / players)) * 0.25;
  }

  // Soft cap by hand size
  const est = Math.min(cards.length, Math.round(score + (jokers + highTrumps + aces) * 0.05));
  void kings;
  return est;
}

function clampToAllowed(value: number, allowed: number[]): number {
  if (allowed.includes(value)) {
    return value;
  }
  // nearest
  let best = allowed[0];
  let bestDist = Math.abs(best - value);
  for (const a of allowed) {
    const d = Math.abs(a - value);
    if (d < bestDist || (d === bestDist && a > best)) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}

type Mode = 'need_tricks' | 'avoid_tricks' | 'neutral' | 'take_all' | 'dump_all';

function playMode(ctx: DecisionContext): Mode {
  const type = ctx.state.currentRoundType;
  if (type === 'GOLD') {
    return 'take_all';
  }
  if (type === 'MISER') {
    return 'dump_all';
  }
  const need = tricksNeeded(ctx);
  const left = remainingTricks(ctx);
  const bid = ctx.me.currentBid;
  if (bid === null) {
    return 'neutral';
  }
  if (need > left) {
    // Already doomed on contract — salvage overtake points
    return 'take_all';
  }
  if (need === 0) {
    return 'avoid_tricks';
  }
  if (need === left) {
    return 'need_tricks'; // must take all remaining
  }
  if (need > 0) {
    return 'need_tricks';
  }
  return 'neutral';
}

/**
 * Who is currently winning the incomplete trick?
 * Returns null if table empty.
 */
function currentWinnerPower(
  table: DecisionContext['state']['tableCards'],
  trump: Suit | null,
  leadSuit: Suit | null,
): { playerId: string; power: number } | null {
  if (table.length === 0) {
    return null;
  }
  let bestIdx = 0;
  let bestPower = -1;
  let jokerTake = false;

  for (let i = 0; i < table.length; i += 1) {
    const played = table[i];
    if (isJokerCard(played.card)) {
      if (played.jokerAction?.type === 'TAKE' || played.jokerAction?.type === 'DEMAND_SUIT') {
        bestIdx = i;
        bestPower = 1000;
        jokerTake = true;
      } else {
        // DROP as virtual 5 of lead
        const power = -1;
        if (!jokerTake && power > bestPower) {
          bestIdx = i;
          bestPower = power;
        }
      }
      continue;
    }
    if (jokerTake) {
      continue;
    }
    let power = rankValue(played.card.rank);
    if (trump && played.card.suit === trump) {
      power += 50;
    } else if (leadSuit && played.card.suit !== leadSuit) {
      power -= 100; // off-suit non-trump loses
    }
    if (power > bestPower) {
      bestPower = power;
      bestIdx = i;
    }
  }
  return { playerId: table[bestIdx].playerId, power: bestPower };
}

function wouldWinTrick(
  card: CardModel,
  jokerAction: JokerAction | undefined,
  ctx: DecisionContext,
): boolean {
  const trump = ctx.state.trumpSuit;
  const table = ctx.state.tableCards;
  const lead =
    ctx.state.currentTrickLeadSuit
    ?? (table[0] && !isJokerCard(table[0].card) ? table[0].card.suit : null);

  if (isJokerCard(card)) {
    if (!jokerAction || jokerAction.type === 'TAKE' || jokerAction.type === 'DEMAND_SUIT') {
      return true;
    }
    // DROP almost never wins unless everyone else void
    const win = currentWinnerPower(table, trump, lead);
    return win === null || win.power < 0;
  }

  let myPower = rankValue(card.rank);
  if (trump && card.suit === trump) {
    myPower += 50;
  } else if (lead && card.suit !== lead && !(trump && card.suit === trump)) {
    myPower -= 100;
  }

  const win = currentWinnerPower(table, trump, lead);
  if (!win) {
    // Leading: high card more likely
    return myPower >= rankValue('Q') || (trump !== null && card.suit === trump);
  }
  return myPower > win.power;
}

export class GrokStrategy implements Strategy {
  public readonly name = 'Grok';

  public chooseBid(ctx: DecisionContext): number {
    const allowed = ctx.state.allowedBids ?? [0];
    if (allowed.length === 1) {
      return allowed[0];
    }

    const H = ctx.state.currentRoundCards;
    const n = ctx.state.players.length;
    const trump = ctx.state.trumpSuit;
    const type = ctx.state.currentRoundType;
    const dark = ctx.state.isDarkRound || type === 'DARK';

    const cards = myVisibleCards(ctx).map((c) => c.card);
    let estimate: number;

    if (dark && cards.every((c) => !c)) {
      // Blind: prior ≈ H / n with slight aggression on long hands
      estimate = Math.max(0, Math.round(H / n + (H >= 8 ? 0.4 : 0)));
    } else if (cards.length === 0) {
      estimate = Math.round(H / n);
    } else {
      estimate = estimateTricks(cards, trump, n);
      // Preferans-style: slightly underbid rather than risk −10×bid
      if (H >= 6) {
        estimate = Math.max(0, estimate - (estimate >= 4 ? 1 : 0));
      }
    }

    // Whole-hand slam: if estimate is full hand and H>1, exact full pays 20×
    if (estimate >= H && H > 1 && allowed.includes(H)) {
      // only slam if very strong
      const strong =
        cards.filter((c) => isJokerCard(c) || rankValue(c.rank) >= rankValue('Q')).length
        >= Math.ceil(H * 0.55);
      if (strong) {
        return H;
      }
    }

    // Prefer exact mid contracts over 0 when we have some strength
    if (estimate === 0 && allowed.includes(0)) {
      const hasHope = cards.some(
        (c) => isJokerCard(c) || (trump && c.suit === trump) || c.rank === 'A',
      );
      if (hasHope && allowed.includes(1)) {
        return 1;
      }
      return 0;
    }

    return clampToAllowed(estimate, allowed);
  }

  public chooseCard(ctx: DecisionContext): number {
    const legal = ctx.state.validCardIndices ?? [];
    if (legal.length === 0) {
      return 0;
    }
    if (legal.length === 1) {
      return legal[0];
    }

    const mode = playMode(ctx);
    const trump = ctx.state.trumpSuit;
    const table = ctx.state.tableCards;
    const isLead = table.length === 0;

    type Candidate = { index: number; score: number; card: CardModel };
    const candidates: Candidate[] = [];

    for (const index of legal) {
      const card = ctx.me.cards[index];
      if (!card) {
        continue;
      }
      let score = 0;
      const jokerDefault: JokerAction | undefined = isJokerCard(card)
        ? this.chooseJokerAction(ctx, index)
        : undefined;
      const wins = wouldWinTrick(card, jokerDefault, ctx);
      const power = cardPower(card, trump);

      if (mode === 'take_all' || mode === 'need_tricks') {
        if (wins) {
          // Prefer cheapest winner
          score = 1000 - power;
        } else {
          // Cannot win: dump lowest
          score = 100 - power;
        }
        // Save joker for when we really need a winner
        if (isJokerCard(card)) {
          const need = tricksNeeded(ctx);
          const left = remainingTricks(ctx);
          if (need < left && !isLead) {
            score -= 200; // hold joker
          } else {
            score += 50;
          }
        }
      } else if (mode === 'dump_all' || mode === 'avoid_tricks') {
        if (wins) {
          score = -1000 + power; // avoid winning; if forced, burn high?
          // Actually if forced to win, burn lowest winner — already wins=true path
          score = -500 - power;
        } else {
          score = 500 - power; // dump low
        }
        if (isJokerCard(card) && jokerDefault?.type === 'DROP') {
          score += 300;
        }
        if (isJokerCard(card) && jokerDefault?.type === 'TAKE') {
          score -= 800;
        }
      } else {
        // neutral: take if cheap win, else duck
        if (wins && power <= rankValue('J') + (trump && card.suit === trump ? 20 : 0)) {
          score = 400 - power;
        } else if (!wins) {
          score = 200 - power;
        } else {
          score = 50 - power;
        }
      }

      // Leading: prefer long plain suits for control, or trump if need
      if (isLead && !isJokerCard(card)) {
        const len = ctx.me.cards.filter(
          (c) => c && !isJokerCard(c) && c.suit === card.suit,
        ).length;
        if (mode === 'need_tricks' || mode === 'take_all') {
          if (trump && card.suit === trump) {
            score += 30;
          }
          score += len * 2;
        } else if (mode === 'dump_all' || mode === 'avoid_tricks') {
          if (trump && card.suit === trump) {
            score -= 40;
          }
          score += (4 - Math.min(4, len)) * 5; // lead short suits to void
        }
      }

      candidates.push({ index, score, card });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.index ?? legal[0];
  }

  public chooseJokerAction(ctx: DecisionContext, _cardIndex: number): JokerAction {
    const mode = playMode(ctx);
    const isLead = ctx.state.tableCards.length === 0;
    const trump = ctx.state.trumpSuit;
    const leadSuit = ctx.state.currentTrickLeadSuit;

    if (!isLead) {
      // Response: TAKE if we need tricks / gold; DROP if avoiding
      if (mode === 'dump_all' || mode === 'avoid_tricks') {
        return { type: 'DROP' };
      }
      if (mode === 'take_all' || mode === 'need_tricks') {
        return { type: 'TAKE' };
      }
      // Neutral: take only if would lose contract otherwise
      const need = tricksNeeded(ctx);
      return need > 0 ? { type: 'TAKE' } : { type: 'DROP' };
    }

    // Leading with joker
    if (mode === 'dump_all' || mode === 'avoid_tricks') {
      // DROP as lowest of a long side suit to fish safely
      const suit = this.pickDropLeadSuit(ctx);
      return { type: 'DROP', suit };
    }

    if (mode === 'take_all' || mode === 'need_tricks') {
      // DEMAND_SUIT to strip opponents of a suit we care about
      const demand = this.pickDemandSuit(ctx);
      if (demand) {
        return { type: 'DEMAND_SUIT', suit: demand };
      }
      return { type: 'TAKE' };
    }

    // Neutral lead: TAKE is simple and strong
    if (trump) {
      return { type: 'DEMAND_SUIT', suit: trump };
    }
    void leadSuit;
    return { type: 'TAKE' };
  }

  public chooseControlGame(
    ctx: DecisionContext,
  ): { roundType: RoundType; dealerIndex: number } {
    const played = ctx.state.playedRoundTypes ?? ['STANDARD'];
    const myScore = ctx.me.score;
    const scores = ctx.state.players.map((p) => p.score);
    const maxOther = Math.max(...scores.filter((_, i) => i !== ctx.myIndex), -Infinity);

    // Behind: prefer high-variance or mizer disruption
    let preferred: RoundType[] = [];
    if (myScore < maxOther) {
      preferred = ['MISER', 'GOLD', 'PERCENTS', 'DARK', 'NO_TRUMP', 'STANDARD'];
    } else {
      // Ahead: stabilize with standard / no trump
      preferred = ['STANDARD', 'NO_TRUMP', 'DARK', 'PERCENTS', 'GOLD', 'MISER'];
    }

    let roundType = (played[0] as RoundType) ?? 'STANDARD';
    for (const p of preferred) {
      if (played.includes(p)) {
        roundType = p;
        break;
      }
    }

    // Dealer: pick strongest opponent as dealer when behind (they deal last bid disadvantage)
    // or self when ahead
    let dealerIndex = ctx.myIndex;
    if (myScore < maxOther) {
      let best = -1;
      let bestScore = -Infinity;
      ctx.state.players.forEach((p, i) => {
        if (i !== ctx.myIndex && p.score > bestScore) {
          bestScore = p.score;
          best = i;
        }
      });
      if (best >= 0) {
        dealerIndex = best;
      }
    }

    return { roundType, dealerIndex };
  }

  public shouldStartGame(ctx: DecisionContext): boolean {
    return (
      ctx.state.hostId === ctx.myId
      && (ctx.state.playersCount ?? ctx.state.players.length) === ctx.state.maxPlayers
    );
  }

  private pickDemandSuit(ctx: DecisionContext): Suit | null {
    const trump = ctx.state.trumpSuit;
    // Prefer demanding trump to pull high trumps, else suit where we are void (opponents burn)
    if (trump) {
      const myTrumps = ctx.me.cards.filter((c) => c && !isJokerCard(c) && c.suit === trump);
      if (myTrumps.length <= 2) {
        return trump;
      }
    }
    // Suit where we have Ace / length
    let best: Suit | null = null;
    let bestScore = -1;
    for (const suit of SUITS) {
      const mine = ctx.me.cards.filter((c) => c && !isJokerCard(c) && c.suit === suit);
      if (mine.length === 0) {
        continue;
      }
      const hasA = mine.some((c) => c!.rank === 'A');
      const s = mine.length + (hasA ? 2 : 0);
      if (s > bestScore) {
        bestScore = s;
        best = suit;
      }
    }
    return best;
  }

  private pickDropLeadSuit(ctx: DecisionContext): Suit {
    // Longest non-trump side suit
    const trump = ctx.state.trumpSuit;
    let best: Suit = 'HEARTS';
    let bestLen = -1;
    for (const suit of SUITS) {
      if (suit === trump) {
        continue;
      }
      const len = ctx.me.cards.filter((c) => c && !isJokerCard(c) && c.suit === suit).length;
      if (len > bestLen) {
        bestLen = len;
        best = suit;
      }
    }
    return best;
  }
}
