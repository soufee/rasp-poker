/** Poisson binomial PMF: P(exactly k successes) for independent Bernoulli trials. */
export function poissonBinomialPmf(probabilities: number[]): number[] {
  const n = probabilities.length;
  const pmf = new Array<number>(n + 1).fill(0);
  pmf[0] = 1;

  for (const probability of probabilities) {
    const p = Math.max(0, Math.min(1, probability));
    for (let k = n; k >= 1; k -= 1) {
      pmf[k] = pmf[k] * (1 - p) + pmf[k - 1] * p;
    }
    pmf[0] *= 1 - p;
  }

  return pmf;
}

export function expectedValue(pmf: number[]): number {
  let value = 0;
  for (let k = 0; k < pmf.length; k += 1) {
    value += k * pmf[k];
  }
  return value;
}