import type { DecisionContext } from '../core/stateSelectors';
import type { JokerAction, RoundType } from '../protocol/types';
import type { Strategy } from './Strategy';

/** Baseline: always legal, never smart. */
export class RandomStrategy implements Strategy {
  public chooseBid(ctx: DecisionContext): number {
    const bids = ctx.state.allowedBids ?? [0];
    return bids[Math.floor(Math.random() * bids.length)];
  }

  public chooseCard(ctx: DecisionContext): number {
    const idx = ctx.state.validCardIndices ?? [0];
    return idx[Math.floor(Math.random() * idx.length)];
  }

  public chooseJokerAction(): JokerAction {
    return { type: 'TAKE' };
  }

  public chooseControlGame(ctx: DecisionContext): { roundType: RoundType; dealerIndex: number } {
    return {
      roundType: (ctx.state.playedRoundTypes?.[0] as RoundType) ?? 'STANDARD',
      dealerIndex: 0,
    };
  }
}
