import { GameEngine, GameState } from './GameEngine';

describe('Bidding Phase Logic', () => {
  it('should restrict dealer from bidding a sum equal to total cards (Except Rule)', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    // State is BIDDING, dealer is 0 (p1). current cards = 1
    // p1 is dealer. Bidding order: p2, p3, p1.
    engine.currentRoundCards = 2; // let's pretend it's 2
    
    // P2 bids 1
    expect(engine.placeBid('p2', 1)).toBe(true);
    // P3 bids 1
    expect(engine.placeBid('p3', 1)).toBe(true);
    
    // P1 (dealer) tries to bid. Total sum so far is 2.
    // Total cards = 2. Dealer cannot bid 0 (because 1+1+0 = 2).
    const dealerBids = engine.getAvailableBids(0);
    expect(dealerBids.includes(0)).toBe(false);
    expect(dealerBids.includes(1)).toBe(true);
    expect(dealerBids.includes(2)).toBe(true);
  });

  it('should resolve collision between consecutive passes and Except rule', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    
    // Dealer is p1(0). Cards = 1.
    engine.currentRoundCards = 1;
    
    // P2 passes (0)
    engine.placeBid('p2', 0);
    // P3 passes (0)
    engine.placeBid('p3', 0);
    
    // Now P1 (dealer) has to bid.
    // Pass limit = 2 (for 3 players). P2 and P3 passed, so P1 cannot pass.
    // Except rule: sum = 0, cards = 1. So P1 cannot bid 1 (0+0+1 = 1).
    // The only bids available would normally be empty, but collision resolution allows 0.
    const dealerBids = engine.getAvailableBids(0);
    expect(dealerBids).toEqual([0]);
    
    // P1 should be able to place 0
    expect(engine.placeBid('p1', 0)).toBe(true);
    // After dealer bids, it should transition to PLAYING_TRICKS
    expect(engine.state).toBe(GameState.PLAYING_TRICKS);
  });
});
