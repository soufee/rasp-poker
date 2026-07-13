export enum RoundType {
  STANDARD = 'STANDARD',
  DARK = 'DARK',
  PERCENTS = 'PERCENTS',
  NO_TRUMP = 'NO_TRUMP',
  GOLD = 'GOLD',
  MISER = 'MISER'
}

export interface PlayerScoreInput {
  bid: number | null; // null for Gold and Miser
  taken: number;
}

/**
 * Calculates score for a single player for a specific round.
 * @param roundType The type of the round.
 * @param cardsInHand The number of cards dealt in this round (H).
 * @param bid The player's bid (null if GOLD/MISER).
 * @param taken The number of tricks the player actually took.
 */
export function calculatePlayerScore(
  roundType: RoundType,
  cardsInHand: number,
  bid: number | null,
  taken: number
): number {
  if (roundType === RoundType.GOLD) {
    return 10 * taken;
  }

  if (roundType === RoundType.MISER) {
    if (taken === 0) return 50;
    if (taken === cardsInHand) return 100;
    return -10 * taken;
  }

  if (bid === null) {
    throw new Error('Bid cannot be null for this round type');
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

  if (roundType === RoundType.PERCENTS) {
    score *= 3;
  }

  return score;
}
