import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedValue, poissonBinomialPmf } from '../src/strategy/probability';

test('pmf sums to one', () => {
  const pmf = poissonBinomialPmf([0.2, 0.5, 0.9]);
  const total = pmf.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('pmf length equals trials plus one', () => {
  const pmf = poissonBinomialPmf([0.1, 0.4, 0.6, 0.8]);
  assert.equal(pmf.length, 5);
});

test('expected value equals sum of probabilities', () => {
  const probs = [0.2, 0.5, 0.9];
  const pmf = poissonBinomialPmf(probs);
  const expected = probs.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(expectedValue(pmf) - expected) < 1e-9);
});

test('all-certain trials give a deterministic count', () => {
  const pmf = poissonBinomialPmf([1, 1, 1]);
  assert.ok(Math.abs(pmf[3] - 1) < 1e-9);
});
