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
    engine.currentRoundCards = 2;

    expect(engine.placeBid('p2', 1)).toBe(true);
    expect(engine.placeBid('p3', 1)).toBe(true);

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
    engine.startGame({
      playersCount: 3,
      hasLadder: true,
      hasMiser: true,
    });

    engine.currentRoundCards = 1;

    engine.placeBid('p2', 0);
    engine.placeBid('p3', 0);

    const dealerBids = engine.getAvailableBids(0);
    expect(dealerBids).toEqual([0]);

    expect(engine.placeBid('p1', 0)).toBe(true);
    expect(engine.state).toBe(GameState.PLAYING_TRICKS);
  });
});
