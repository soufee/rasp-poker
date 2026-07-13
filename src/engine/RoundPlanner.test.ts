import { RoundPlanner } from './RoundPlanner';
import { RoundType } from './Scoring';

describe('RoundPlanner', () => {
  it('should generate correct plan for 3 players with ladder and miser', () => {
    const plan = RoundPlanner.generatePlan({ playersCount: 3, hasLadder: true, hasMiser: true });
    // L = Math.floor(12 / 3) * 3 = 12
    // M = 12
    // Ladder: 12
    // Max: 3
    // Dark: 3
    // Percents: 3
    // NoTrump: 3
    // Gold: 3
    // Miser: 3
    // Total = 12 + 3 * 6 = 30
    expect(plan.length).toBe(30);

    // Verify Percents has exactly 4 cards
    const percents = plan.filter(r => r.type === RoundType.PERCENTS);
    expect(percents.length).toBe(3);
    percents.forEach(r => expect(r.cardsInHand).toBe(4));

    // Verify dealer distribution (should be perfectly balanced)
    const dealerCounts = [0, 0, 0];
    plan.forEach(r => dealerCounts[r.dealerIndex]++);
    expect(dealerCounts).toEqual([10, 10, 10]);
  });

  it('should generate correct plan for 4 players without ladder and without miser', () => {
    const plan = RoundPlanner.generatePlan({ playersCount: 4, hasLadder: false, hasMiser: false });
    // M = 9
    // Max: 4
    // Dark: 4
    // Percents: 4
    // NoTrump: 4
    // Gold: 4
    // Total = 4 * 5 = 20
    expect(plan.length).toBe(20);
    expect(plan.filter(r => r.type === RoundType.MISER).length).toBe(0);

    const maxRounds = plan.filter(r => r.type === RoundType.STANDARD);
    expect(maxRounds.length).toBe(4);
    maxRounds.forEach(r => expect(r.cardsInHand).toBe(9));
  });

  it('should properly rotate dealers', () => {
    const plan = RoundPlanner.generatePlan({ playersCount: 3, hasLadder: true, hasMiser: false });
    expect(plan[0].dealerIndex).toBe(0);
    expect(plan[1].dealerIndex).toBe(1);
    expect(plan[2].dealerIndex).toBe(2);
    expect(plan[3].dealerIndex).toBe(0);
  });
});
