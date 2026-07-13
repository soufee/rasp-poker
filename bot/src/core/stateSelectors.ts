import type { CardModel, GameStatePayload, PlayerState } from '../protocol/types';

export interface DecisionContext {
  state: GameStatePayload;
  myId: string;
  myIndex: number;
  me: PlayerState;
}

export function buildContext(state: GameStatePayload, myId: string): DecisionContext | null {
  const myIndex = state.players.findIndex((p) => p.id === myId);
  if (myIndex < 0) {
    return null;
  }
  return {
    state,
    myId,
    myIndex,
    me: state.players[myIndex],
  };
}

export function isMyTurn(ctx: DecisionContext): boolean {
  return ctx.state.currentPlayerIndex === ctx.myIndex;
}

export function knownHand(cards: Array<CardModel | null>): CardModel[] {
  const out: CardModel[] = [];
  for (const card of cards) {
    if (card) {
      out.push(card);
    }
  }
  return out;
}

export function myVisibleCards(ctx: DecisionContext): Array<{ index: number; card: CardModel }> {
  const out: Array<{ index: number; card: CardModel }> = [];
  ctx.me.cards.forEach((card, index) => {
    if (card) {
      out.push({ index, card });
    }
  });
  return out;
}

export function remainingTricks(ctx: DecisionContext): number {
  return ctx.me.cards.length;
}

export function tricksNeeded(ctx: DecisionContext): number {
  const bid = ctx.me.currentBid ?? 0;
  return Math.max(0, bid - ctx.me.tricksTaken);
}
