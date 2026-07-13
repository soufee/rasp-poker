import { Card, Rank, Suit } from './Card';
import { GameEngine, GameState } from './GameEngine';
import { RoundType } from './Scoring';

describe('Engine rules fixes (#14)', () => {
  function filledEngine(n = 3): GameEngine {
    const engine = new GameEngine(n);
    for (let i = 1; i <= n; i += 1) {
      engine.addPlayer(`p${i}`, `Player ${i}`);
    }
    return engine;
  }

  it('full deal sets trump from last dealt card (not null)', () => {
    const engine = filledEngine(3);
    engine.startGame({ playersCount: 3, hasLadder: false, hasMiser: false });
    expect(engine.currentRoundCards).toBe(12);
    expect(engine.trumpSuit).not.toBeNull();
    expect(engine.trumpCard).not.toBeNull();
    expect(engine.trumpCard!.isJoker).toBe(false);
    const dealer = engine.players[engine.dealerIndex];
    expect(
      dealer.cards.some(
        (c) => c.suit === engine.trumpCard!.suit && c.rank === engine.trumpCard!.rank,
      ),
    ).toBe(true);
  });

  it('NO_TRUMP has null trump', () => {
    const engine = filledEngine(3);
    engine.currentRoundType = RoundType.NO_TRUMP;
    engine.currentRoundCards = 12;
    engine.dealerIndex = 0;
    engine.transitionTo(GameState.SHUFFLING_AND_DEALING);
    expect(engine.trumpSuit).toBeNull();
    expect(engine.trumpCard).toBeNull();
  });

  it('clears hands and deals equal counts on short game', () => {
    const engine = filledEngine(3);
    expect(engine.startShortGame({ playersCount: 3, hasLadder: true, hasMiser: false }, 2)).toBe(
      true,
    );
    const handSizes = engine.players.map((p) => p.cards.length);
    expect(handSizes.every((s) => s === engine.currentRoundCards)).toBe(true);
  });

  it('does not auto-start on full seats', () => {
    const engine = filledEngine(3);
    expect(engine.state).toBe(GameState.WAITING_PLAYERS);
    expect(engine.players.length).toBe(3);
  });

  it('DEMAND_SUIT forces highest of demanded suit', () => {
    const engine = filledEngine(3);
    engine.state = GameState.PLAYING_TRICKS;
    engine.currentPlayerIndex = 1;
    engine.trumpSuit = Suit.Clubs;
    engine.tableCards = [
      {
        playerId: 'p1',
        card: new Card(Suit.Spades, Rank.Seven),
        jokerAction: { type: 'DEMAND_SUIT', suit: Suit.Hearts },
      },
    ];
    engine.currentTrickLeadSuit = Suit.Hearts;
    engine.players[1].cards = [
      new Card(Suit.Hearts, Rank.Six),
      new Card(Suit.Hearts, Rank.Ace),
      new Card(Suit.Spades, Rank.King),
    ];

    const legal = engine.getLegalPlays('p2');
    expect(legal.map((p) => p.cardIndex)).toEqual([1]);
  });

  it('zero-score rule assigns place 2', () => {
    const engine = filledEngine(3);
    engine.players[0].score = 100;
    engine.players[1].score = 0;
    engine.players[2].score = 50;
    const ranking = engine.computeRanking();
    const zero = ranking.find((r) => r.playerId === 'p2');
    expect(zero?.place).toBe(2);
    expect(zero?.zeroScoreSecond).toBe(true);
    const first = ranking.find((r) => r.playerId === 'p1');
    expect(first?.place).toBe(1);
  });

  it('control PERCENTS uses hand size 4', () => {
    const engine = filledEngine(3);
    engine.playedRoundTypes.add(RoundType.PERCENTS);
    engine.playedRoundTypes.add(RoundType.STANDARD);
    engine.players[0].score = 10;
    engine.players[1].score = 5;
    engine.players[2].score = 20;
    engine.transitionTo(GameState.CONTROL_GAME_SETUP);
    expect(engine.setupControlGame('p2', RoundType.PERCENTS, 0)).toBe(true);
    expect(engine.currentRoundCards).toBe(4);
  });

  it('getLegalBids / applyAction do not mutate on illegal bid', () => {
    const engine = filledEngine(3);
    engine.state = GameState.BIDDING;
    engine.currentPlayerIndex = 0;
    engine.dealerIndex = 2;
    engine.currentRoundCards = 2;
    const before = engine.players[0].currentBid;
    const result = engine.applyAction({ type: 'PLACE_BID', playerId: 'p1', bid: 99 });
    expect(result.ok).toBe(false);
    expect(engine.players[0].currentBid).toBe(before);
  });
});
