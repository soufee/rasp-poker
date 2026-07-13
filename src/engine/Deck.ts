import { Card, Suit, Rank } from './Card';

export class Deck {
  public cards: Card[] = [];

  constructor() {
    this.generateDeck();
  }

  private generateDeck() {
    this.cards = [];
    for (const suit of Object.values(Suit)) {
      for (const rank of Object.values(Rank)) {
        this.cards.push(new Card(suit, rank));
      }
    }
  }

  public shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  /**
   * Generates and shuffles a deck, ensuring that the Joker (7 of Spades)
   * is not the last card in the deck (which is used as the trump card indicator).
   */
  public generateAndShuffleDeck(): Card[] {
    do {
      this.generateDeck();
      this.shuffle();
    } while (this.cards[this.cards.length - 1].isJoker);

    return this.cards;
  }
}
