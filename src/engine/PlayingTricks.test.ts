import { GameEngine, GameState } from './GameEngine';
import { Card, Suit, Rank } from './Card';

describe('Playing Tricks and Joker Rules', () => {
  it('should validate follow suit correctly', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;
    engine.players.forEach((p) => (p.currentBid = 0));

    engine.players[0].cards = [new Card(Suit.Hearts, Rank.Six)];
    engine.players[1].cards = [
      new Card(Suit.Hearts, Rank.Seven),
      new Card(Suit.Spades, Rank.Eight),
    ];
    engine.players[2].cards = [new Card(Suit.Spades, Rank.Nine)];

    expect(engine.playCard('p1', 0)).toBe(true);

    expect(engine.playCard('p2', 1)).toBe(false);

    expect(engine.playCard('p2', 0)).toBe(true);

    expect(engine.playCard('p3', 0)).toBe(true);
  });

  it('joker played first as TAKE wins the trick', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;
    engine.players.forEach((p) => (p.currentBid = 0));

    engine.players[0].cards = [new Card(Suit.Spades, Rank.Seven), new Card(Suit.Hearts, Rank.Six)];
    engine.players[1].cards = [new Card(Suit.Hearts, Rank.Ace), new Card(Suit.Hearts, Rank.Six)];
    engine.players[2].cards = [new Card(Suit.Diamonds, Rank.Ace), new Card(Suit.Hearts, Rank.Six)];

    expect(engine.playCard('p1', 0, { type: 'TAKE' })).toBe(true);
    expect(engine.playCard('p2', 0)).toBe(true);
    expect(engine.playCard('p3', 0)).toBe(true);

    expect(engine.players[0].tricksTaken).toBe(1);
    expect(engine.currentPlayerIndex).toBe(0);
  });

  it('joker played second as DROP acts as 5 of lead suit and loses', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;
    engine.trumpSuit = Suit.Diamonds;
    engine.players.forEach((p) => (p.currentBid = 0));

    engine.players[0].cards = [new Card(Suit.Hearts, Rank.Six), new Card(Suit.Clubs, Rank.Six)];
    engine.players[1].cards = [new Card(Suit.Spades, Rank.Seven), new Card(Suit.Clubs, Rank.Six)];
    engine.players[2].cards = [new Card(Suit.Hearts, Rank.Seven), new Card(Suit.Clubs, Rank.Six)];

    expect(engine.playCard('p1', 0)).toBe(true);
    expect(engine.playCard('p2', 0, { type: 'DROP' })).toBe(true);
    expect(engine.playCard('p3', 0)).toBe(true);

    expect(engine.players[2].tricksTaken).toBe(1);
  });

  it('a trump played mid-trick beats a later lead-suit card', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;
    engine.trumpSuit = Suit.Spades;
    engine.players.forEach((p) => (p.currentBid = 0));

    engine.players[0].cards = [new Card(Suit.Hearts, Rank.Ace), new Card(Suit.Clubs, Rank.Six)];
    engine.players[1].cards = [new Card(Suit.Spades, Rank.King), new Card(Suit.Clubs, Rank.Seven)];
    engine.players[2].cards = [new Card(Suit.Hearts, Rank.Six), new Card(Suit.Clubs, Rank.Eight)];

    expect(engine.playCard('p1', 0)).toBe(true);
    expect(engine.playCard('p2', 0)).toBe(true);
    expect(engine.playCard('p3', 0)).toBe(true);

    expect(engine.players[1].tricksTaken).toBe(1);
    expect(engine.currentPlayerIndex).toBe(1);
  });

  it('a low trump beats high lead-suit cards on both sides', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;
    engine.trumpSuit = Suit.Spades;
    engine.players.forEach((p) => (p.currentBid = 0));

    engine.players[0].cards = [new Card(Suit.Clubs, Rank.Ace), new Card(Suit.Hearts, Rank.Six)];
    engine.players[1].cards = [new Card(Suit.Spades, Rank.Six), new Card(Suit.Hearts, Rank.Seven)];
    engine.players[2].cards = [new Card(Suit.Clubs, Rank.King), new Card(Suit.Hearts, Rank.Eight)];

    expect(engine.playCard('p1', 0)).toBe(true);
    expect(engine.playCard('p2', 0)).toBe(true);
    expect(engine.playCard('p3', 0)).toBe(true);

    expect(engine.players[1].tricksTaken).toBe(1);
    expect(engine.currentPlayerIndex).toBe(1);
  });

  it('joker is exempt from follow suit rule', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;
    engine.players.forEach((p) => (p.currentBid = 0));

    engine.players[0].cards = [new Card(Suit.Hearts, Rank.Six)];
    engine.players[1].cards = [
      new Card(Suit.Hearts, Rank.Seven),
      new Card(Suit.Spades, Rank.Seven),
    ];
    engine.players[2].cards = [new Card(Suit.Clubs, Rank.Six)];

    expect(engine.playCard('p1', 0)).toBe(true);
    expect(engine.playCard('p2', 1, { type: 'TAKE' })).toBe(true);
  });
});
