import type { RoundType } from '../protocol/types';

/**
 * Mirror of the server's calculatePlayerScore (src/engine/Scoring.ts).
 * Kept in sync so the bot can maximize expected score when choosing a bid.
 */
export function scoreForRound(
  roundType: RoundType,
  cardsInHand: number,
  bid: number | null,
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

  if (bid === null) {
    return 0;
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
  } else {
    score = -10 * bid;
  }

  if (roundType === 'PERCENTS') {
    score *= 3;
  }

  return score;
}
