# Smart Poker Bot Arena

Standalone network bots for «Расписной покер», including the predictive Solaris strategy.

## Installation

```bash
npm install
```

## Running

Create a table and fill it with bots:

```bash
npm start -- --smoke --strategy solaris --players 3
```

Join an existing room:

```bash
npm start -- --room <room-id> --host http://localhost:3000 --strategy solaris
```

Options: `--strategy`, `--userId`, `--userName`, `--token`, `--delay`, `--players`.

## Solaris

`bot/src/strategy/SolarisStrategy.ts` is the strongest calculation-oriented strategy in this package.

1. **Determinized rollouts** — samples hidden hands from the remaining 36-card deck and simulates every legal bid, card and joker declaration to the end of the round.
2. **Belief model** — remembers every public card, infers void suits from follow-suit and trump obligations, preserves the public dealer trump card, and weights sampled hands by opponents' bids.
3. **Exact-contract utility** — evaluates the real non-linear score formula, not only trick strength. It balances making its own contract against sitting a leader or forcing an opponent's overtrick.
4. **Tournament planning** — changes risk according to standings, scores control-game choices from historical performance and variance, and targets the current leader with dealer pressure.
5. **Endgame to zero** — when first or second by points is no longer realistic, it uses the exact-zero path to secure second place and disrupts opponents attempting the same route.
6. **Joker planning** — compares TAKE, DROP and every DEMAND_SUIT declaration inside the same rollout, including the forced-high-card effect.

Run the offline arena:

```bash
BOTS=Solaris,Claude,Grok npx tsx sim/simulate.ts 30 3
```

## Grok strategy overview

1. **EV Bidding** — per-card win probabilities feed a Poisson-binomial model; the bid with highest expected score (per `Scoring.ts` rules) is chosen. Slight variance tilt when far behind/ahead on the table.
2. **Card Counting** — every revealed card in the round is tracked to estimate trick-win chances.
3. **Contract-Aware Play** — wins tricks cheaply when behind contract; ducks and dumps high cards once the bid is met.
4. **Tournament Cynicism** — each legal play is scored by projected round points for *everyone*:
   `U = w_me · myPts − Σ rivalry_i · oppPts`.
   Hunts table leaders and big live contracts: will **sit** a rival one short of their make, or **feed an overtrick** when they sit on exact bid — even at mild self-damage (overtrick instead of clean make). Self-sacrifice is throttled when our own contract is urgent.
5. **Zero-score 2nd place** — by rules, finishing at **exactly 0** guarantees 2nd place. When 1st/2nd by raw points is unreachable but 0 is still reachable (DP over remaining GOLD/control/etc.), Grok steers there: climb on GOLD to a dumpable pad (e.g. +40), then on control pick **STANDARD/NO_TRUMP**, make **someone else** dealer (avoid «Кроме»), bid `score/10`, and **intentionally underbid** for `−10·bid` to land on 0. Only when tournament-rational.
6. **Deny opponent zero** — if Grok holds **2nd by points**, first is unlikely, and a trailer is steering to 0 (underbid dump / GOLD exact / hold at 0), Grok **sabotages** them even at self-cost: feeds tricks to force a make/overtrick, or steals tricks they need for an exact zero. Own zero-path still has priority when Grok is the seeker.
7. **Joker Policy** — TAKE / DEMAND_SUIT / DROP chosen by contract pressure, table position, standing utility, and deny-zero feed/steal.
8. **Meta Control** — when behind on score, prefers high-variance rounds (MISER, GOLD); when ahead, stabilizes with STANDARD. Zero-path overrides control choice when active.

## GLM — predictive pragmatic bot

`bot/src/strategy/GlmStrategy.ts` — registered alongside Grok/Claude/Composer. Run it:

```bash
# Join an existing room
npx tsx src/index.ts --room <roomId> --strategy glm --userName GLM

# Smoke (GLM hosts, 2 random fillers)
npm start -- --smoke --strategy glm

# Arena vs other bots
npx tsx src/claude.ts --arena --players 3 --opponents glm
```

Strategy highlights:

1. **Predictive EV bidding** — per-card win probabilities feed a Poisson-binomial PMF; opponents' already-placed bids cap the expected-trick anchor (claim-pressure rescaling) so GLM never assumes tricks that rivals have contractually claimed. Bidding utility = scoring EV − undertrick-risk penalty × bid size + posture tilt + proximity to predictive anchor.
2. **Risk-aware posture** — behind ⇒ slight up-tilt toward variance; ahead ⇒ safer lower makes. Undertrick penalty scales with bid size so big contracts are scrutinised harder.
3. **Predictive 2-trick play** — for every legal candidate: `U = P(win)·U(I take) + P(lose)·avg U(recipient)`. `U` projects end-of-round points for every player (own contract-aware, opponents fair-share) and subtracts rivalry-weighted rival points. A short lookahead term nudges us to keep a future winner when we still need tricks, and to dump a high loser once the contract is met.
4. **Tournament cynicism** — hunts table leaders and live contracts: sits a rival one short of their make, feeds an overtrick when they sit on exact bid, even at mild self-damage (throttled when own contract is urgent).
5. **Joker policy** — TAKE / DEMAND_SUIT / DROP chosen by contract pressure, table position, standing utility, and deny-zero feed/steal. In no-trump lead with a long side suit, prefers DEMAND_SUIT to pull the top honour and establish runners.
6. **Endgame navigation** — reuses `zeroPath` for the 0-score 2nd place rule: climbs on GOLD to a dumpable pad, then on control picks STANDARD/NO_TRUMP, makes someone else dealer (avoid «Кроме»), bids `score/10`, intentionally underbids for `−10·bid` to land on 0. When holding 2nd by points and 1st is unreachable, sabotages opponent zero-seekers even at self-cost.
7. **Round-type awareness** — GOLD → take all, MISER → dump all, PERCENTS → amplified EV (×3 scoring), DARK → fair-share anchor with posture tilt, NO_TRUMP → long-suit establishment.

## Custom Strategy

Implement the `Strategy` interface in `src/strategy/Strategy.ts` and wire it in `src/index.ts`.