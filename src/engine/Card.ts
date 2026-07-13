export enum Suit {
  Spades = 'SPADES',
  Hearts = 'HEARTS',
  Diamonds = 'DIAMONDS',
  Clubs = 'CLUBS',
}

export enum Rank {
  Six = '6',
  Seven = '7',
  Eight = '8',
  Nine = '9',
  Ten = '10',
  Jack = 'J',
  Queen = 'Q',
  King = 'K',
  Ace = 'A',
}

export class Card {
  constructor(
    public readonly suit: Suit,
    public readonly rank: Rank
  ) {}

  public get isJoker(): boolean {
    return this.suit === Suit.Spades && this.rank === Rank.Seven;
  }

  public toString(): string {
    return `${this.rank}${this.suit[0]}`; // e.g. 7S, AH
  }
}
