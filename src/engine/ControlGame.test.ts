import { GameEngine, GameState } from './GameEngine';
import { RoundType } from './Scoring';

describe('Control Game Logic', () => {
  it('should transition to CONTROL_GAME_SETUP after all planned rounds', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');

    engine.plan = [{ roundNumber: 1, type: RoundType.STANDARD, cardsInHand: 1, dealerIndex: 0 }];
    engine.currentRoundIndex = 0;
    engine.players.forEach((p) => (p.currentBid = 0));

    engine.transitionTo(GameState.SCORING);

    expect(engine.state).toBe(GameState.CONTROL_GAME_SETUP);
    expect(engine.controlGamesPlayed).toBe(0);
  });

  it('should allow the lowest scorer to pick the control game and dealer', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');

    engine.players[0].score = 50;
    engine.players[1].score = 20;
    engine.players[2].score = 30;

    engine.playedRoundTypes.add(RoundType.DARK);
    engine.playedRoundTypes.add(RoundType.STANDARD);

    engine.transitionTo(GameState.CONTROL_GAME_SETUP);

    expect(engine.controlGameChooserId).toBe('p2');

    expect(engine.setupControlGame('p1', RoundType.DARK, 0)).toBe(false);

    expect(engine.setupControlGame('p2', RoundType.MISER, 0)).toBe(false);

    expect(engine.setupControlGame('p2', RoundType.DARK, 2)).toBe(true);

    expect(engine.state).toBe(GameState.BIDDING);
    expect(engine.currentRoundType).toBe(RoundType.DARK);
    expect(engine.dealerIndex).toBe(2);
    expect(engine.controlGamesPlayed).toBe(1);
    expect(engine.currentRoundCards).toBe(12);
  });

  it('should require another control game if there is a tie for first place', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');

    engine.controlGamesPlayed = 1;
    engine.players[0].score = 100;
    engine.players[1].score = 50;
    engine.players[2].score = 100;
    engine.players.forEach((p) => (p.currentBid = 0));

    engine.plan = [];
    engine.currentRoundIndex = 0;
    engine.transitionTo(GameState.SCORING);

    expect(engine.state).toBe(GameState.CONTROL_GAME_SETUP);
    expect(engine.controlGameChooserId).toBe('p2');
  });

  it('should finish the match if there is a clear winner', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');

    engine.controlGamesPlayed = 1;
    engine.players[0].score = 120;
    engine.players[1].score = 50;
    engine.players[2].score = 100;
    engine.players.forEach((p) => (p.currentBid = 0));

    engine.plan = [];
    engine.transitionTo(GameState.SCORING);

    expect(engine.state).toBe(GameState.MATCH_FINISHED);
  });
});
