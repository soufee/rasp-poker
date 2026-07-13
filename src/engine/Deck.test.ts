import { Deck } from './Deck';
import { Suit, Rank } from './Card';

describe('Deck logic', () => {
  it('should generate a 36 card deck', () => {
    const deck = new Deck();
    expect(deck.cards.length).toBe(36);
  });

  it('generateAndShuffleDeck should never return joker as the last card', () => {
    const deck = new Deck();

    for (let i = 0; i < 100; i++) {
      const cards = deck.generateAndShuffleDeck();
      const lastCard = cards[cards.length - 1];
      expect(lastCard.isJoker).toBe(false);
    }
  });

  it('deck should contain exactly one joker', () => {
    const deck = new Deck();
    const cards = deck.generateAndShuffleDeck();
    const jokers = cards.filter((c) => c.isJoker);
    expect(jokers.length).toBe(1);
    expect(jokers[0].suit).toBe(Suit.Spades);
    expect(jokers[0].rank).toBe(Rank.Seven);
  });
});
