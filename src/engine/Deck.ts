import { Card, Suit, Rank } from './Card';

export class Deck {
  public cards: Card[] = [];

  public constructor() {
    this.generateDeck();
  }

  private generateDeck(): void {
    this.cards = [];
    for (const suit of Object.values(Suit)) {
      for (const rank of Object.values(Rank)) {
        this.cards.push(new Card(suit, rank));
      }
    }
  }

  public shuffle(): void {
    for (let i = this.cards.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  /**
   * Fresh 36-card deck, shuffled.
   * Optional: ensure card at `notJokerFromEnd` (0 = last index) is not the joker.
   * Used when the trump is determined by a specific deal position.
   */
  public generateAndShuffleDeck(options?: { notJokerFromEnd?: number }): Card[] {
    const fromEnd = options?.notJokerFromEnd ?? 0;
    do {
      this.generateDeck();
      this.shuffle();
    } while (this.cards[this.cards.length - 1 - fromEnd]?.isJoker);

    return this.cards;
  }
}
