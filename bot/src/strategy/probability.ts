/**
 * Poisson-binomial distribution: probability mass function of the number of
 * successes among independent Bernoulli trials with (possibly different) success
 * probabilities. Used to turn per-card win probabilities into a distribution over
 * the number of tricks taken, which lets us pick the expected-value optimal bid.
 */
export function poissonBinomialPmf(probs: number[]): number[] {
  let pmf = [1];
  for (const rawProbability of probs) {
    const probability = clamp01(rawProbability);
    const next = new Array<number>(pmf.length + 1).fill(0);
    for (let taken = 0; taken < pmf.length; taken += 1) {
      next[taken] += pmf[taken] * (1 - probability);
      next[taken + 1] += pmf[taken] * probability;
    }
    pmf = next;
  }
  return pmf;
}

export function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export function expectedValue(pmf: number[]): number {
  let sum = 0;
  for (let taken = 0; taken < pmf.length; taken += 1) {
    sum += taken * pmf[taken];
  }
  return sum;
}
