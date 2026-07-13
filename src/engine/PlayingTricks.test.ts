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

    engine.players[0].cards = [new Card(Suit.Hearts, Rank.Six)];
    engine.players[1].cards = [new Card(Suit.Hearts, Rank.Seven), new Card(Suit.Spades, Rank.Eight)];
    engine.players[2].cards = [new Card(Suit.Spades, Rank.Nine)];

    // P1 plays Hearts
    expect(engine.playCard('p1', 0)).toBe(true);

    // P2 tries to play Spades (invalid, must follow Hearts)
    expect(engine.playCard('p2', 1)).toBe(false);
    
    // P2 plays Hearts (valid)
    expect(engine.playCard('p2', 0)).toBe(true);

    // P3 plays Spades (valid, has no Hearts)
    expect(engine.playCard('p3', 0)).toBe(true);
  });

  it('joker played first as TAKE wins the trick', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;

    engine.players[0].cards = [new Card(Suit.Spades, Rank.Seven)]; // Joker
    engine.players[1].cards = [new Card(Suit.Hearts, Rank.Ace)];
    engine.players[2].cards = [new Card(Suit.Diamonds, Rank.Ace)];
    
    expect(engine.playCard('p1', 0, { type: 'TAKE' })).toBe(true);
    expect(engine.playCard('p2', 0)).toBe(true);
    expect(engine.playCard('p3', 0)).toBe(true);

    // Trick resolved, P1 should win
    expect(engine.players[0].tricksTaken).toBe(1);
    expect(engine.currentPlayerIndex).toBe(0); // Winner leads next
  });

  it('joker played second as DROP acts as 5 of lead suit and loses', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;
    engine.trumpSuit = Suit.Diamonds;

    engine.players[0].cards = [new Card(Suit.Hearts, Rank.Six)];
    engine.players[1].cards = [new Card(Suit.Spades, Rank.Seven)]; // Joker
    engine.players[2].cards = [new Card(Suit.Hearts, Rank.Seven)];

    // P1 leads Hearts 6
    expect(engine.playCard('p1', 0)).toBe(true);
    // P2 plays Joker as DROP
    expect(engine.playCard('p2', 0, { type: 'DROP' })).toBe(true);
    // P3 plays Hearts 7
    expect(engine.playCard('p3', 0)).toBe(true);

    // Trick resolved, P3 should win because P3's 7 > P1's 6, and Joker is 5
    expect(engine.players[2].tricksTaken).toBe(1);
  });

  it('joker is exempt from follow suit rule', () => {
    const engine = new GameEngine(3);
    engine.addPlayer('p1', 'Player 1');
    engine.addPlayer('p2', 'Player 2');
    engine.addPlayer('p3', 'Player 3');
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 0;

    engine.players[0].cards = [new Card(Suit.Hearts, Rank.Six)];
    engine.players[1].cards = [new Card(Suit.Hearts, Rank.Seven), new Card(Suit.Spades, Rank.Seven)]; // Hearts and Joker
    engine.players[2].cards = [new Card(Suit.Clubs, Rank.Six)];

    expect(engine.playCard('p1', 0)).toBe(true);
    // P2 has Hearts, but chooses to play Joker (index 1). This should be allowed.
    expect(engine.playCard('p2', 1, { type: 'TAKE' })).toBe(true);
  });
});
