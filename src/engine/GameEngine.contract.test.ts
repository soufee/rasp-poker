import { Card, Rank, Suit } from './Card';
import { GameEngine, GameState } from './GameEngine';
import { RoundType } from './Scoring';

describe('GameEngine server contracts', () => {
  it('starts only with a supported matching player count', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');

    expect(
      engine.startGame({
        playersCount: 4,
        hasLadder: true,
        hasMiser: true,
      }),
    ).toBe(false);
    expect(engine.state).toBe(GameState.WAITING_PLAYERS);
  });

  it('returns valid indices without mutating the trick or hand', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;
    engine.trumpSuit = Suit.Spades;
    engine.currentTrickLeadSuit = Suit.Hearts;
    engine.tableCards = [
      {
        playerId: 'p3',
        card: new Card(Suit.Hearts, Rank.Six),
      },
    ];
    engine.players[0].cards = [
      new Card(Suit.Hearts, Rank.Eight),
      new Card(Suit.Spades, Rank.Nine),
      new Card(Suit.Clubs, Rank.Ace),
      new Card(Suit.Spades, Rank.Seven),
    ];

    const cardsBefore = [...engine.players[0].cards];
    const tableBefore = [...engine.tableCards];
    expect(engine.getValidCardIndices('p1')).toEqual([0, 3]);
    expect(engine.players[0].cards).toEqual(cardsBefore);
    expect(engine.tableCards).toEqual(tableBefore);
  });

  it('requires trump when the player cannot follow suit', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;
    engine.trumpSuit = Suit.Spades;
    engine.currentTrickLeadSuit = Suit.Hearts;
    engine.tableCards = [
      {
        playerId: 'p3',
        card: new Card(Suit.Hearts, Rank.Six),
      },
    ];
    engine.players[0].cards = [
      new Card(Suit.Spades, Rank.Nine),
      new Card(Suit.Clubs, Rank.Ace),
      new Card(Suit.Spades, Rank.Seven),
    ];

    expect(engine.getValidCardIndices('p1')).toEqual([0, 2]);
    expect(engine.playCard('p1', 1)).toBe(false);
    expect(engine.playCard('p1', 0)).toBe(true);
  });

  it('clears hands and keeps no-trump rounds without trump', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.players[0].cards = [new Card(Suit.Hearts, Rank.Ace)];
    engine.currentRoundCards = 1;
    engine.currentRoundType = RoundType.NO_TRUMP;

    engine.transitionTo(GameState.SHUFFLING_AND_DEALING);

    expect(engine.players.every((player) => player.cards.length === 1)).toBe(true);
    expect(engine.trumpSuit).toBeNull();
  });

  it('rejects an invalid dealer index for a control game', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.CONTROL_GAME_SETUP;
    engine.controlGameChooserId = 'p1';
    engine.playedRoundTypes.add(RoundType.STANDARD);

    expect(engine.setupControlGame('p1', RoundType.STANDARD, -1)).toBe(false);
    expect(engine.setupControlGame('p1', RoundType.STANDARD, 3)).toBe(false);
    expect(engine.setupControlGame('p1', RoundType.STANDARD, 1.5)).toBe(false);
    expect(engine.state).toBe(GameState.CONTROL_GAME_SETUP);
  });

  it('records bids, tricks and round score deltas', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.currentRoundCards = 3;
    engine.currentRoundType = RoundType.STANDARD;
    engine.players[0].currentBid = 1;
    engine.players[0].tricksTaken = 1;
    engine.players[1].currentBid = 0;
    engine.players[1].tricksTaken = 1;
    engine.players[2].currentBid = 2;
    engine.players[2].tricksTaken = 1;

    engine.transitionTo(GameState.SCORING);

    expect(engine.scoreHistory).toEqual([
      {
        roundNumber: 1,
        roundType: RoundType.STANDARD,
        cardsInHand: 3,
        scores: { p1: 10, p2: 1, p3: -20 },
        bids: { p1: 1, p2: 0, p3: 2 },
        tricks: { p1: 1, p2: 1, p3: 1 },
      },
    ]);
  });
});
