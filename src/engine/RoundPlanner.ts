import { RoundType } from './Scoring';

export interface RoundSpec {
  roundNumber: number;
  type: RoundType;
  cardsInHand: number;
  dealerIndex: number;
}

export interface PlannerSettings {
  playersCount: number;
  hasLadder: boolean;
  hasMiser: boolean;
}

export class RoundPlanner {
  public static generatePlan(settings: PlannerSettings): RoundSpec[] {
    const { playersCount: N, hasLadder, hasMiser } = settings;
    if (N < 3 || N > 6 || N === 5) {
      throw new Error('Unsupported number of players. Must be 3, 4, or 6.');
    }

    const M = 36 / N;
    const L = Math.floor(M / N) * N;

    const plan: RoundSpec[] = [];
    let roundNumber = 1;
    let currentDealer = 0; // Assuming player 0 is the first dealer

    const addRound = (type: RoundType, cards: number) => {
      plan.push({
        roundNumber: roundNumber++,
        type,
        cardsInHand: cards,
        dealerIndex: currentDealer
      });
      currentDealer = (currentDealer + 1) % N;
    };

    // 1. Ladder
    if (hasLadder) {
      for (let i = 1; i <= L; i++) {
        addRound(RoundType.STANDARD, i);
      }
    }

    // 2. Max Rounds
    for (let i = 0; i < N; i++) {
      addRound(RoundType.STANDARD, M);
    }

    // 3. Dark Rounds (Тёмная)
    for (let i = 0; i < N; i++) {
      addRound(RoundType.DARK, M);
    }

    // 4. Percents Rounds (Проценты)
    for (let i = 0; i < N; i++) {
      addRound(RoundType.PERCENTS, 4);
    }

    // 5. No Trump Rounds (Бескозырка)
    for (let i = 0; i < N; i++) {
      addRound(RoundType.NO_TRUMP, M);
    }

    // 6. Gold Rounds (Золотая)
    for (let i = 0; i < N; i++) {
      addRound(RoundType.GOLD, M);
    }

    // 7. Miser Rounds (Мизер)
    if (hasMiser) {
      for (let i = 0; i < N; i++) {
        addRound(RoundType.MISER, M);
      }
    }

    return plan;
  }
}
