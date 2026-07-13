import type { DecisionContext } from '../core/stateSelectors';
import type { JokerAction, RoundType } from '../protocol/types';

export interface Strategy {
  chooseBid(ctx: DecisionContext): number;
  chooseCard(ctx: DecisionContext): number;
  chooseJokerAction(ctx: DecisionContext, cardIndex: number): JokerAction;
  chooseControlGame(ctx: DecisionContext): { roundType: RoundType; dealerIndex: number };
  shouldStartGame?(ctx: DecisionContext): boolean;
}
