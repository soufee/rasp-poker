import type { RoundType } from '../protocol/types';

/**
 * Mirrors src/engine/Scoring.ts — used for EV bidding.
 */
export function scoreForRound(
  roundType: RoundType,
  cardsInHand: number,
  bid: number,
  taken: number,
): number {
  if (roundType === 'GOLD') {
    return 10 * taken;
  }

  if (roundType === 'MISER') {
    if (taken === 0) {
      return 50;
    }
    if (taken === cardsInHand) {
      return 100;
    }
    return -10 * taken;
  }

  let score = 0;
  if (taken === bid) {
    if (bid === 0) {
      score = 5;
    } else if (bid === cardsInHand && cardsInHand > 1) {
      score = 20 * bid;
    } else {
      score = 10 * bid;
    }
  } else if (taken > bid) {
    score = taken;
  } else if (taken < bid) {
    score = -10 * bid;
  }

  if (roundType === 'PERCENTS') {
    score *= 3;
  }

  return score;
}