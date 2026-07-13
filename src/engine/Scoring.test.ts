import { calculatePlayerScore, RoundType } from './Scoring';

describe('Scoring Logic', () => {
  it('Standard Round: exact bid', () => {
    expect(calculatePlayerScore(RoundType.STANDARD, 6, 2, 2)).toBe(20);
  });

  it('Standard Round: pass (exact 0)', () => {
    expect(calculatePlayerScore(RoundType.STANDARD, 6, 0, 0)).toBe(5);
  });

  it('Standard Round: full hand bid (H > 1)', () => {
    expect(calculatePlayerScore(RoundType.STANDARD, 6, 6, 6)).toBe(120);
  });

  it('Standard Round: full hand bid when H=1 is normal scoring', () => {
    expect(calculatePlayerScore(RoundType.STANDARD, 1, 1, 1)).toBe(10);
  });

  it('Standard Round: overtrick (перебор)', () => {
    expect(calculatePlayerScore(RoundType.STANDARD, 6, 2, 3)).toBe(3);
    expect(calculatePlayerScore(RoundType.STANDARD, 6, 0, 1)).toBe(1);
  });

  it('Standard Round: undertrick (недобор)', () => {
    expect(calculatePlayerScore(RoundType.STANDARD, 6, 3, 2)).toBe(-30);
  });

  it('Percents Round: score is multiplied by 3', () => {
    expect(calculatePlayerScore(RoundType.PERCENTS, 4, 2, 2)).toBe(60); // 20 * 3
    expect(calculatePlayerScore(RoundType.PERCENTS, 4, 0, 0)).toBe(15); // 5 * 3
    expect(calculatePlayerScore(RoundType.PERCENTS, 4, 4, 4)).toBe(240); // (20*4) * 3
    expect(calculatePlayerScore(RoundType.PERCENTS, 4, 1, 2)).toBe(6); // 2 * 3
    expect(calculatePlayerScore(RoundType.PERCENTS, 4, 3, 2)).toBe(-90); // -30 * 3
  });

  it('Gold Round: 10 per trick, no penalties', () => {
    expect(calculatePlayerScore(RoundType.GOLD, 9, null, 0)).toBe(0);
    expect(calculatePlayerScore(RoundType.GOLD, 9, null, 3)).toBe(30);
  });

  it('Miser Round: penalties and premiums', () => {
    expect(calculatePlayerScore(RoundType.MISER, 9, null, 0)).toBe(50);
    expect(calculatePlayerScore(RoundType.MISER, 9, null, 9)).toBe(100);
    expect(calculatePlayerScore(RoundType.MISER, 9, null, 3)).toBe(-30);
  });
});
