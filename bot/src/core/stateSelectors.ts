import type { CardView, GameStateView, PlayerView } from '../protocol/types';

export interface DecisionContext {
  state: GameStateView;
  myId: string;
  myIndex: number;
  me: PlayerView;
  hand: Array<CardView | null>;
  isMyTurn: boolean;
}

export function buildContext(state: GameStateView, myId: string): DecisionContext | null {
  const myIndex = state.players.findIndex((player) => player.id === myId);
  if (myIndex < 0) {
    return null;
  }
  const me = state.players[myIndex];
  const isMyTurn = state.currentPlayerIndex === myIndex;
  return {
    state,
    myId,
    myIndex,
    me,
    hand: me.cards,
    isMyTurn,
  };
}

/** Returns known cards (rank + suit) in a player hand, ignoring fog-of-war nulls. */
export function knownHand(hand: Array<CardView | null>): CardView[] {
  return hand.filter((card): card is CardView => card !== null);
}
