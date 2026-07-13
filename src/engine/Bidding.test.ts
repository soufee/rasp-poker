import { GameEngine, GameState } from './GameEngine';

describe('Bidding Phase Logic', () => {
  it('should restrict dealer from bidding a sum equal to total cards (Except Rule)', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.startGame({
      playersCount: 3,
      hasLadder: true,
      hasMiser: true,
    });
    // Force bidding state with 2 cards (may already be in BIDDING after deal)
    engine.state = GameState.BIDDING;
    engine.currentRoundCards = 2;
    engine.dealerIndex = 0;
    engine.currentPlayerIndex = 1; // left of dealer
    engine.players.forEach((p) => {
      p.currentBid = null;
    });

    expect(engine.placeBid('p2', 1)).toBe(true);
    expect(engine.placeBid('p3', 1)).toBe(true);

    const dealerBids = engine.getAvailableBids(0);
    expect(dealerBids.includes(0)).toBe(false); // except: 2-1-1=0
    expect(dealerBids.includes(1)).toBe(true);
    expect(dealerBids.includes(2)).toBe(true);
  });

  it('tracks consecutive passes per player across rounds (ТЗ §3)', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.BIDDING;
    engine.currentRoundCards = 3;
    engine.dealerIndex = 0;
    engine.currentPlayerIndex = 1;
    engine.players.forEach((p) => {
      p.currentBid = null;
      p.consecutivePassRounds = 0;
    });

    // p2 has already passed 2 rounds in a row → third pass forbidden
    engine.players[1].consecutivePassRounds = 2;
    const bids = engine.getLegalBids('p2');
    expect(bids.includes(0)).toBe(false);
    expect(bids[0]).toBeGreaterThanOrEqual(1);
  });

  it('resolves collision: Except overrides pass limit for dealer on H=1', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.BIDDING;
    engine.currentRoundCards = 1;
    engine.dealerIndex = 0;
    engine.currentPlayerIndex = 1;
    engine.players.forEach((p) => {
      p.currentBid = null;
      p.consecutivePassRounds = 0;
    });

    // Dealer already at pass limit
    engine.players[0].consecutivePassRounds = 2;

    engine.placeBid('p2', 0);
    engine.placeBid('p3', 0);

    // sum=0, exceptBid=1, pass restricted → only collision allows 0
    const dealerBids = engine.getAvailableBids(0);
    expect(dealerBids).toEqual([0]);
    expect(engine.placeBid('p1', 0)).toBe(true);
    expect(engine.state).toBe(GameState.PLAYING_TRICKS);
  });
});
