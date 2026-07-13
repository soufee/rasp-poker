/**
 * Новичок («Novice») bot strategy, previously known as `RandomStrategy`.
 *
 * Transformed into a competitive, pragmatic, calculating, and goal-oriented player
 * adhering to the official game rules (`raspisnoy_poker_TZ.md`) and issue #22 guidelines.
 *
 * Delegates execution to `NoviceStrategy`.
 */
import { NoviceStrategy } from './NoviceStrategy';

export class RandomStrategy extends NoviceStrategy {
  public override readonly name = 'Новичок';
}

export { NoviceStrategy };