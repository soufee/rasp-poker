import { GameEngine, GameState } from './GameEngine';

describe('GameEngine State Machine', () => {
  it('should initialize in WAITING_PLAYERS state', () => {
    const engine = new GameEngine(3);
    expect(engine.state).toBe(GameState.WAITING_PLAYERS);
  });

  it('should stay waiting until a full game is started', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    expect(engine.state).toBe(GameState.WAITING_PLAYERS);

    engine.addPlayer('p3', 'Player 3');
    expect(engine.state).toBe(GameState.WAITING_PLAYERS);
    expect(
      engine.startGame({
        playersCount: 3,
        hasLadder: true,
        hasMiser: true,
      }),
    ).toBe(true);
    expect(engine.state).toBe(GameState.BIDDING);
    expect(engine.players[0].cards.length).toBe(1);
  });

  it('should correctly advance turn clockwise', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.startGame({
      playersCount: 3,
      hasLadder: true,
      hasMiser: true,
    });

    expect(engine.currentPlayerIndex).toBe(1);

    engine.advanceTurn();
    expect(engine.currentPlayerIndex).toBe(2);

    engine.advanceTurn();
    expect(engine.currentPlayerIndex).toBe(0);
  });
});
