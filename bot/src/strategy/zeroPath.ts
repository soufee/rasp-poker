/**
 * Endgame «правило нулевого счёта»: score === 0 ⇒ guaranteed 2nd place.
 *
 * When we cannot catch 1st/2nd by raw points, but can still steer the match
 * total to exactly 0 (GOLD climb + deliberate underbid dump on control, etc.),
 * pursue that path. Otherwise stay inactive.
 *
 * Also: if we hold 2nd by points and an opponent is steering to 0 to steal
 * place 2, detect that threat and support counterplay (feed overtricks / deny
 * needed tricks) even at personal cost.
 */

import type { DecisionContext } from '../core/stateSelectors';
import type { RoundType } from '../protocol/types';
import { scoreForRound } from './scoring';

/** How an opponent is trying to land on exactly 0 this round. */
export type OpponentZeroKind =
  /** Miss contract on purpose: score − mult·bid = 0 if taken < bid. */
  | 'underbid_miss'
  /** GOLD: score + 10·taken = 0 at a specific taken total. */
  | 'gold_exact'
  /** Already at 0 — any positive/negative swing knocks them off. */
  | 'hold_zero'
  /** MISER delta lands on 0 at a target taken count. */
  | 'miser_target';

export interface OpponentZeroThreat {
  playerIndex: number;
  kind: OpponentZeroKind;
  bid: number | null;
  taken: number;
  score: number;
  /**
   * If set: they succeed at 0 only when finalTaken stays strictly below this
   * (classic underbid miss). Push them to ≥ breakMinTaken to sabotage.
   */
  breakMinTaken: number | null;
  /**
   * If set: they want exactly this many tricks by end of round (GOLD/MISER).
   * Deny when below; force extras when at/above.
   */
  idealTaken: number | null;
  /** Prefer giving them this trick (force make / overtrick / knock off 0). */
  preferFeed: boolean;
  /** Prefer preventing them from taking this trick. */
  preferDeny: boolean;
  /** 0..1+ importance. */
  severity: number;
  reason: string;
}

export type ZeroPlayStyle =
  | 'inactive'
  /** Climb toward a dumpable launch-pad (usually GOLD). */
  | 'accumulate'
  /** Bid high and miss on purpose for −10·bid (−30·bid in PERCENTS). */
  | 'dump_underbid'
  /** Already at 0 — try not to move the score. */
  | 'hold_zero'
  /** Need a specific absolute score after this round. */
  | 'target_delta';

export interface ZeroPathPlan {
  active: boolean;
  style: ZeroPlayStyle;
  /** Absolute score we want after this round (if known). */
  targetScoreAfterRound: number | null;
  /** Bid to place when dumping via underbid. */
  sacrificialBid: number | null;
  /** Max tricks we may still take without ruining a miss (bid − 1). */
  maxTricksAllowed: number | null;
  /** Why the plan fired (debug / tests). */
  reason: string;
}

interface RoundSpec {
  type: RoundType;
  cards: number;
}

const INACTIVE: ZeroPathPlan = {
  active: false,
  style: 'inactive',
  targetScoreAfterRound: null,
  sacrificialBid: null,
  maxTricksAllowed: null,
  reason: 'inactive',
};

/** Public entry: plan for the current decision context. */
export function planZeroPath(context: DecisionContext): ZeroPathPlan {
  if (!isZeroPathAttractive(context)) {
    return INACTIVE;
  }

  const myScore = context.me.score;
  const hand = context.state.currentRoundCards;
  const roundType = context.state.currentRoundType;
  const remaining = estimateRemainingRounds(context);
  const controlHand = maxHandSize(context);

  // Already on 0 with nothing risky left — hold.
  if (myScore === 0 && remaining.length <= 1) {
    return {
      active: true,
      style: 'hold_zero',
      targetScoreAfterRound: 0,
      sacrificialBid: roundType === 'GOLD' || roundType === 'MISER' ? null : 0,
      maxTricksAllowed: 0,
      reason: 'hold_exact_zero',
    };
  }

  // Current round is a bidding round and we can dump straight to 0.
  if (roundType !== 'GOLD' && roundType !== 'MISER') {
    // If we already placed a sacrificial bid, honour *that* miss budget.
    const liveBid = context.me.currentBid;
    if (liveBid !== null && liveBid > 0) {
      const mult = roundType === 'PERCENTS' ? 30 : 10;
      const afterMiss = myScore - mult * liveBid;
      if (afterMiss === 0) {
        return {
          active: true,
          style: 'dump_underbid',
          targetScoreAfterRound: 0,
          sacrificialBid: liveBid,
          maxTricksAllowed: liveBid - 1,
          reason: `live_underbid_dump_bid_${liveBid}`,
        };
      }
    }

    const dump = underbidDumpToZero(myScore, hand, roundType);
    if (dump !== null) {
      return {
        active: true,
        style: 'dump_underbid',
        targetScoreAfterRound: 0,
        sacrificialBid: dump.bid,
        maxTricksAllowed: dump.bid - 1,
        reason: `underbid_dump_bid_${dump.bid}`,
      };
    }
  }

  // GOLD: climb to the best launch-pad for a later underbid dump (or hit 0 now).
  if (roundType === 'GOLD') {
    const gold = goldAccumulatePlan(myScore, hand, remaining, controlHand, context);
    if (gold) {
      return gold;
    }
  }

  // MISER: sometimes −10·taken or +50/+100 can land on 0.
  if (roundType === 'MISER') {
    const miser = miserZeroPlan(myScore, hand);
    if (miser) {
      return miser;
    }
  }

  // Future dump is planned but this round has no clean lever — stay inactive tactically
  // unless we still need a multi-step reachability commit.
  if (canReachZero(myScore, remaining)) {
    // Soft: if later rounds can fix it, don't sabotage a normal mid-plan round.
    const onlySpecialLeft = remaining.every(
      (round) => round.type === 'GOLD' || round.type === 'MISER' || isControlLike(context, round),
    );
    if (onlySpecialLeft && remaining.length > 0) {
      return {
        active: true,
        style: 'accumulate',
        targetScoreAfterRound: null,
        sacrificialBid: null,
        maxTricksAllowed: null,
        reason: 'path_open_wait',
      };
    }
  }

  return INACTIVE;
}

/**
 * Control-game chooser for zero path:
 *  - prefer STANDARD / NO_TRUMP (clean −10·bid dumps)
 *  - dealer ≠ us so we are not under «Кроме»
 */
export function chooseZeroControlSetup(
  context: DecisionContext,
): { roundType: RoundType; dealerIndex: number } | null {
  if (!isZeroPathAttractive(context)) {
    return null;
  }

  const played = context.state.playedRoundTypes ?? [];
  const myScore = context.me.score;
  const hand = maxHandSize(context);

  const dumpTypes: RoundType[] = ['STANDARD', 'NO_TRUMP', 'DARK', 'PERCENTS'];
  let roundType: RoundType | null = null;
  let sacrificialBid: number | null = null;

  for (const candidate of dumpTypes) {
    if (!played.includes(candidate)) {
      continue;
    }
    const cards = candidate === 'PERCENTS' ? 4 : hand;
    const dump = underbidDumpToZero(myScore, cards, candidate);
    if (dump !== null) {
      roundType = candidate;
      sacrificialBid = dump.bid;
      break;
    }
  }

  // Need a climb first — pick GOLD if available and we are below a dump pad.
  if (roundType === null && myScore < 0 && played.includes('GOLD')) {
    const maxGain = 10 * hand;
    for (let t = 0; t <= hand; t += 1) {
      const after = myScore + 10 * t;
      if (after === 0 || underbidDumpToZero(after, hand, 'STANDARD') !== null) {
        roundType = 'GOLD';
        break;
      }
      if (after > 0 && after > maxGain + myScore) {
        break;
      }
    }
    if (roundType === null) {
      // Still prefer GOLD to approach zero from below.
      roundType = 'GOLD';
    }
  }

  // Positive score but not cleanly dumpable with STANDARD — try PERCENTS (−30·b).
  if (roundType === null && myScore > 0) {
    for (const candidate of dumpTypes) {
      if (played.includes(candidate)) {
        roundType = candidate;
        break;
      }
    }
  }

  if (roundType === null) {
    for (const fallback of ['NO_TRUMP', 'STANDARD', 'DARK', 'PERCENTS', 'GOLD', 'MISER'] as RoundType[]) {
      if (played.includes(fallback)) {
        roundType = fallback;
        break;
      }
    }
  }

  if (roundType === null) {
    return null;
  }

  // Never make ourselves dealer when we need a free sacrificial bid.
  const n = context.state.players.length;
  let dealerIndex = 0;
  if (n > 0) {
    // Prefer leader as dealer (they face «Кроме» last).
    let best = -1;
    let bestScore = -Infinity;
    context.state.players.forEach((player, index) => {
      if (index === context.myIndex) {
        return;
      }
      if (player.score > bestScore) {
        bestScore = player.score;
        best = index;
      }
    });
    dealerIndex = best >= 0 ? best : (context.myIndex + 1) % n;
    if (dealerIndex === context.myIndex && n > 1) {
      dealerIndex = (context.myIndex + 1) % n;
    }
  }

  void sacrificialBid;
  return { roundType, dealerIndex };
}

// ── Defend 2nd place against opponent zero-seekers ─────────────────────────

/**
 * True when we should spend resources (even self-damage) to stop someone else
 * from stealing 2nd via the zero-score rule.
 */
export function shouldDefendSecondFromZero(context: DecisionContext): boolean {
  // If we ourselves are going for 0, that mission owns the endgame.
  if (isZeroPathAttractive(context)) {
    return false;
  }

  const myScore = context.me.score;
  const others = context.state.players
    .filter((_, index) => index !== context.myIndex)
    .map((player) => player.score)
    .sort((a, b) => b - a);

  if (others.length === 0) {
    return false;
  }

  const leader = others[0];
  const place = placeByPoints(myScore, others);

  // Must be sitting on 2nd by points (exactly one player strictly ahead).
  if (place !== 2 || myScore >= leader) {
    return false;
  }

  // First place unlikely: gap exceeds a *realistic* remaining upside
  // (not the theoretical cap-every-round fantasy).
  const remaining = estimateRemainingRounds(context);
  const realisticUpside = estimateRealisticUpside(remaining);
  if (leader - myScore <= realisticUpside) {
    // Still a realistic shot at first — fight up, don't tunnel on deny-zero.
    return false;
  }

  return detectOpponentZeroThreats(context).length > 0;
}

/** Typical-case upside (solid makes / partial GOLD), not absolute ceiling. */
function estimateRealisticUpside(rounds: RoundSpec[]): number {
  let total = 0;
  for (const round of rounds) {
    if (round.type === 'GOLD') {
      total += 10 * Math.ceil(round.cards / 3);
    } else if (round.type === 'MISER') {
      total += 50;
    } else if (round.type === 'PERCENTS') {
      total += 3 * 10 * Math.min(2, round.cards);
    } else {
      // A good but not perfect contract (~hand/3 tricks made).
      const made = Math.max(1, Math.round(round.cards / 3));
      total += 10 * made;
    }
  }
  return total;
}

/**
 * Spot opponents who can (or are clearly trying to) finish the match at 0.
 */
export function detectOpponentZeroThreats(context: DecisionContext): OpponentZeroThreat[] {
  const roundType = context.state.currentRoundType;
  const hand = context.state.currentRoundCards;
  const remaining = estimateRemainingRounds(context);
  const threats: OpponentZeroThreat[] = [];

  context.state.players.forEach((player, index) => {
    if (index === context.myIndex) {
      return;
    }

    // Only care about rivals who would steal 2nd from us — not the leader
    // (leader going to 0 is rare and would hand us 1st by points often).
    const othersAboveUs = context.state.players.filter(
      (entry, i) => i !== context.myIndex && entry.score > context.me.score,
    ).length;
    // Threat should not be sole leader by a huge margin fighting for 1st normally.
    const isLeader = player.score === Math.max(...context.state.players.map((entry) => entry.score));
    if (isLeader && player.score > context.me.score + 40) {
      // Leaders almost never zero-seek; skip unless score is already a dump pad.
      const dump = underbidDumpToZero(player.score, hand, roundType);
      if (dump === null && player.score !== 0) {
        return;
      }
    }

    const threat = analyzeOpponentZeroThreat(context, index, player.score, player.currentBid, player.tricksTaken, roundType, hand, remaining);
    if (threat) {
      // Slightly higher severity if they are currently behind us (would leap to 2nd via 0).
      if (player.score < context.me.score) {
        threat.severity *= 1.25;
      }
      if (othersAboveUs === 1) {
        threat.severity *= 1.1;
      }
      threats.push(threat);
    }
  });

  threats.sort((a, b) => b.severity - a.severity);
  return threats;
}

function analyzeOpponentZeroThreat(
  context: DecisionContext,
  playerIndex: number,
  score: number,
  bid: number | null,
  taken: number,
  roundType: RoundType,
  hand: number,
  remaining: RoundSpec[],
): OpponentZeroThreat | null {
  const late = isLateMatch(context) || remaining.length <= 2;
  const mult = roundType === 'PERCENTS' ? 30 : 10;

  // Already at 0 — any swing can knock them off; feed/force points.
  if (score === 0) {
    if (!late && (context.state.controlGamesPlayed ?? 0) === 0) {
      return null;
    }
    return {
      playerIndex,
      kind: 'hold_zero',
      bid,
      taken,
      score,
      breakMinTaken: null,
      idealTaken: null,
      preferFeed: true,
      preferDeny: false,
      severity: late ? 1.1 : 0.7,
      reason: 'hold_zero',
    };
  }

  // GOLD: exact trick count to hit 0.
  if (roundType === 'GOLD') {
    if (score < 0 && (-score) % 10 === 0) {
      const ideal = (-score) / 10;
      if (ideal >= 0 && ideal <= hand) {
        const preferDeny = taken < ideal;
        const preferFeed = taken >= ideal;
        return {
          playerIndex,
          kind: 'gold_exact',
          bid: null,
          taken,
          score,
          breakMinTaken: null,
          idealTaken: ideal,
          preferFeed,
          preferDeny,
          severity: 1.0 + (taken >= ideal - 1 ? 0.35 : 0),
          reason: `gold_exact_${ideal}`,
        };
      }
    }
    // Positive on GOLD only moves further from 0 — not a zero-seek this round.
    return null;
  }

  if (roundType === 'MISER') {
    const options: number[] = [];
    if (score + 50 === 0) {
      options.push(0);
    }
    if (score + 100 === 0) {
      options.push(hand);
    }
    for (let t = 1; t < hand; t += 1) {
      if (score - 10 * t === 0) {
        options.push(t);
      }
    }
    if (options.length === 0) {
      return null;
    }
    const ideal = options.sort((a, b) => Math.abs(a - taken) - Math.abs(b - taken))[0];
    return {
      playerIndex,
      kind: 'miser_target',
      bid: null,
      taken,
      score,
      breakMinTaken: null,
      idealTaken: ideal,
      preferFeed: taken >= ideal,
      preferDeny: taken < ideal,
      severity: 0.9,
      reason: `miser_target_${ideal}`,
    };
  }

  // Bidding rounds: live sacrificial underbid.
  if (bid !== null && bid > 0) {
    const afterMiss = score - mult * bid;
    if (afterMiss === 0) {
      const preferFeed = taken < bid; // need to push them to make/over
      return {
        playerIndex,
        kind: 'underbid_miss',
        bid,
        taken,
        score,
        breakMinTaken: bid,
        idealTaken: null,
        preferFeed,
        preferDeny: false,
        severity: 1.2 + (taken >= bid - 1 ? 0.4 : 0),
        reason: `underbid_miss_bid_${bid}`,
      };
    }
  }

  // No live bid yet, but score is a clean dump pad and match is late —
  // they are a latent zero-seeker (will bid score/mult next).
  if ((bid === null || bid === 0) && late) {
    const dump = underbidDumpToZero(score, hand, roundType);
    if (dump !== null) {
      return {
        playerIndex,
        kind: 'underbid_miss',
        bid: dump.bid,
        taken,
        score,
        breakMinTaken: dump.bid,
        idealTaken: null,
        preferFeed: taken < dump.bid,
        preferDeny: false,
        severity: 0.55,
        reason: `latent_dump_pad_${dump.bid}`,
      };
    }
  }

  // Reachable zero later (remaining rounds) while currently behind us — soft watch.
  if (late && score < context.me.score && canReachZero(score, remaining)) {
    return {
      playerIndex,
      kind: score < 0 ? 'gold_exact' : 'underbid_miss',
      bid,
      taken,
      score,
      breakMinTaken: bid !== null && bid > 0 ? bid : null,
      idealTaken: null,
      preferFeed: score > 0 || (bid !== null && bid > 0 && taken < bid),
      preferDeny: false,
      severity: 0.4,
      reason: 'soft_future_zero',
    };
  }

  return null;
}

/**
 * How good an outcome is *for us* given a threat's final trick count this round.
 * Large positive = they fail to land on 0. Large negative = they succeed.
 */
export function scoreThreatOutcome(
  threat: OpponentZeroThreat,
  finalTaken: number,
  roundType: RoundType,
  cardsInHand: number,
): number {
  const bid = threat.bid ?? 0;
  const points = scoreForRound(roundType, cardsInHand, bid, finalTaken);
  const endScore = threat.score + points;

  if (endScore === 0) {
    return -1000 * threat.severity;
  }

  // Distance from 0, plus extra for breaking their mechanical path.
  let value = Math.min(500, Math.abs(endScore)) * 0.35 * threat.severity;

  if (threat.kind === 'underbid_miss' && threat.breakMinTaken !== null) {
    if (finalTaken >= threat.breakMinTaken) {
      value += 280 * threat.severity; // made or over — dump failed
    } else {
      value -= 400 * threat.severity; // still on miss track
    }
  }

  if (
    (threat.kind === 'gold_exact' || threat.kind === 'miser_target')
    && threat.idealTaken !== null
  ) {
    if (finalTaken === threat.idealTaken) {
      value -= 500 * threat.severity;
    } else {
      value += 200 * threat.severity + Math.abs(finalTaken - threat.idealTaken) * 25;
    }
  }

  if (threat.kind === 'hold_zero') {
    // Any non-zero end is a win for us; endScore===0 already handled.
    value += 150 * threat.severity;
  }

  return value;
}

/**
 * Immediate preference for whether *this* trick should go to the threat.
 * Positive ⇒ better if they take it; negative ⇒ better if they don't.
 */
export function trickPreferenceVsThreat(
  threat: OpponentZeroThreat,
  theyGetTrick: boolean,
): number {
  const nextTaken = threat.taken + (theyGetTrick ? 1 : 0);
  let pref = 0;

  if (threat.kind === 'underbid_miss' && threat.breakMinTaken !== null) {
    if (threat.taken < threat.breakMinTaken) {
      // Need to feed until they reach breakMinTaken.
      pref += theyGetTrick ? 90 : -90;
      if (nextTaken >= threat.breakMinTaken) {
        pref += theyGetTrick ? 120 : 0; // this trick completes the sabotage
      }
    } else {
      // Already at/over bid — further overtricks also fine but less urgent.
      pref += theyGetTrick ? 25 : -10;
    }
  }

  if (
    (threat.kind === 'gold_exact' || threat.kind === 'miser_target')
    && threat.idealTaken !== null
  ) {
    if (threat.taken < threat.idealTaken) {
      pref += theyGetTrick ? -100 : 100; // deny
    } else {
      pref += theyGetTrick ? 100 : -40; // force past ideal
    }
  }

  if (threat.kind === 'hold_zero') {
    pref += theyGetTrick ? 80 : -50;
  }

  return pref * threat.severity;
}

/** Pick bid when zero path wants a sacrificial underbid. */
export function chooseZeroBid(context: DecisionContext, plan: ZeroPathPlan, allowed: number[]): number | null {
  if (!plan.active || allowed.length === 0) {
    return null;
  }

  if (plan.style === 'hold_zero') {
    if (allowed.includes(0)) {
      return 0;
    }
    return null;
  }

  if (plan.style === 'dump_underbid' && plan.sacrificialBid !== null) {
    if (allowed.includes(plan.sacrificialBid)) {
      return plan.sacrificialBid;
    }
    // Nearest higher legal bid still allows miss for a multiple dump ≤ score.
    const higher = allowed
      .filter((bid) => bid >= plan.sacrificialBid!)
      .sort((a, b) => a - b);
    if (higher.length > 0) {
      // Prefer bid whose −mult·bid lands closest to −score (toward 0).
      const mult = context.state.currentRoundType === 'PERCENTS' ? 30 : 10;
      let best = higher[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const bid of higher) {
        const after = context.me.score - mult * bid;
        const dist = Math.abs(after);
        if (dist < bestDist || (dist === bestDist && bid < best)) {
          bestDist = dist;
          best = bid;
        }
      }
      // Only accept if we still land on 0 or closer to 0 than doing nothing.
      if (bestDist < Math.abs(context.me.score)) {
        return best;
      }
    }
    // Try any underbid dump that hits 0 among allowed.
    for (const bid of [...allowed].sort((a, b) => b - a)) {
      if (bid <= 0) {
        continue;
      }
      const delta = scoreForRound(context.state.currentRoundType, context.state.currentRoundCards, bid, 0);
      if (context.me.score + delta === 0) {
        return bid;
      }
    }
  }

  return null;
}

// ── attractiveness & reachability ──────────────────────────────────────────

export function isZeroPathAttractive(context: DecisionContext): boolean {
  const players = context.state.players;
  if (players.length < 2) {
    return false;
  }

  const myScore = context.me.score;
  const others = players
    .filter((_, index) => index !== context.myIndex)
    .map((player) => player.score)
    .sort((a, b) => b - a);

  const leader = others[0] ?? myScore;
  const secondByPoints = others[1] ?? others[0] ?? myScore;

  // Already sole first by a healthy margin — zero would *lose* first place.
  if (myScore > leader) {
    return false;
  }

  // Tied or within striking of first with realistic upside — fight for first.
  const remaining = estimateRemainingRounds(context);
  const maxUpside = estimateMaxUpside(remaining);
  if (myScore + maxUpside >= leader && myScore >= secondByPoints - 5) {
    // Can still contest top-2 by points.
    if (myScore + maxUpside >= secondByPoints) {
      // Only skip zero path if 2nd by points is realistic.
      const gapToSecond = secondByPoints - myScore;
      if (gapToSecond <= maxUpside * 0.85) {
        return false;
      }
    }
  }

  // If we finished right now: would zero give a better place than raw points?
  const placeNow = placeByPoints(myScore, others);
  if (placeNow <= 2 && myScore !== 0) {
    // Already 1st or 2nd on points — zero is only interesting if we're not stable 2nd
    // and first is unreachable. If place 2 on points, don't risk it.
    if (placeNow === 1) {
      return false;
    }
    if (placeNow === 2 && myScore > 0) {
      return false;
    }
  }

  // Far behind 2nd: need zero path.
  const gapToSecond = secondByPoints - myScore;
  if (gapToSecond <= 0 && myScore !== 0) {
    // Ahead of "second" but not leader — we're 2nd on points.
    return false;
  }

  if (gapToSecond > maxUpside) {
    // Cannot catch 2nd by points.
    return canReachZero(myScore, remaining) || canReachZeroWithControlChoice(myScore, context);
  }

  // Borderline: if upside is thin and zero is clean, still prefer zero.
  if (gapToSecond > maxUpside * 0.7 && canReachZero(myScore, remaining)) {
    return true;
  }

  // Late match (control or last specials) and deep negative / awkward score.
  if (isLateMatch(context) && canReachZero(myScore, remaining)) {
    if (placeNow >= 3 || myScore < secondByPoints - 20) {
      return true;
    }
  }

  return false;
}

function placeByPoints(myScore: number, othersDesc: number[]): number {
  let place = 1;
  for (const score of othersDesc) {
    if (score > myScore) {
      place += 1;
    }
  }
  return place;
}

function isLateMatch(context: DecisionContext): boolean {
  if ((context.state.controlGamesPlayed ?? 0) > 0) {
    return true;
  }
  if (context.state.state === 'CONTROL_GAME_SETUP') {
    return true;
  }
  const plan = context.state.plan ?? [];
  const idx = context.state.currentRoundIndex ?? 0;
  if (plan.length > 0 && idx >= plan.length - 3) {
    return true;
  }
  const type = context.state.currentRoundType;
  return type === 'GOLD' || type === 'MISER';
}

function isControlLike(context: DecisionContext, round: RoundSpec): boolean {
  return (context.state.controlGamesPlayed ?? 0) > 0 || round.cards === maxHandSize(context);
}

function maxHandSize(context: DecisionContext): number {
  const n = context.state.maxPlayers || context.state.players.length || 3;
  return Math.floor(36 / n);
}

function estimateRemainingRounds(context: DecisionContext): RoundSpec[] {
  const plan = context.state.plan ?? [];
  const idx = context.state.currentRoundIndex ?? 0;
  const fromPlan: RoundSpec[] = [];

  // Include current plan round if still playing it.
  for (let i = idx; i < plan.length; i += 1) {
    const entry = plan[i];
    fromPlan.push({
      type: entry.type as RoundType,
      cards: entry.cardsInHand,
    });
  }

  // If plan exhausted or we're in control territory, append a synthetic control.
  const controlPlayed = context.state.controlGamesPlayed ?? 0;
  if (controlPlayed === 0) {
    // One control remaining (chooser picks type later — model as STANDARD max hand).
    const alreadyListed =
      fromPlan.length > 0
      && idx >= plan.length - 1
      && context.state.state === 'CONTROL_GAME_SETUP';
    if (fromPlan.length === 0 || idx >= plan.length || alreadyListed) {
      if (context.state.state === 'CONTROL_GAME_SETUP') {
        fromPlan.push({ type: 'STANDARD', cards: maxHandSize(context) });
      } else if (idx >= plan.length) {
        fromPlan.push({ type: 'STANDARD', cards: maxHandSize(context) });
      } else {
        // Control still after remaining plan.
        fromPlan.push({ type: 'STANDARD', cards: maxHandSize(context) });
      }
    } else if (idx < plan.length) {
      fromPlan.push({ type: 'STANDARD', cards: maxHandSize(context) });
    }
  }

  // If mid-round without plan info, at least current round.
  if (fromPlan.length === 0) {
    fromPlan.push({
      type: context.state.currentRoundType,
      cards: context.state.currentRoundCards,
    });
    if (controlPlayed === 0 && context.state.state !== 'CONTROL_GAME_SETUP') {
      fromPlan.push({ type: 'STANDARD', cards: maxHandSize(context) });
    }
  }

  return fromPlan;
}

function estimateMaxUpside(rounds: RoundSpec[]): number {
  let total = 0;
  for (const round of rounds) {
    if (round.type === 'GOLD') {
      total += 10 * round.cards;
    } else if (round.type === 'MISER') {
      total += 100; // take all
    } else if (round.type === 'PERCENTS') {
      total += 3 * 20 * Math.min(4, round.cards); // cap ×3
    } else {
      // Optimistic perfect cap on full hand.
      total += 20 * round.cards;
    }
  }
  return total;
}

function canReachZeroWithControlChoice(myScore: number, context: DecisionContext): boolean {
  const hand = maxHandSize(context);
  const played = context.state.playedRoundTypes ?? [
    'STANDARD',
    'NO_TRUMP',
    'DARK',
    'PERCENTS',
    'GOLD',
  ];
  const options: RoundSpec[] = [];
  for (const type of played) {
    options.push({
      type: type as RoundType,
      cards: type === 'PERCENTS' ? 4 : hand,
    });
  }
  // Single control round from current score.
  for (const opt of options) {
    if (reachableAfterOneRound(myScore, opt).has(0)) {
      return true;
    }
  }
  // GOLD control then… only one control at a time, but GOLD itself can hit 0.
  return false;
}

export function canReachZero(startScore: number, rounds: RoundSpec[]): boolean {
  if (rounds.length === 0) {
    return startScore === 0;
  }
  // DP on reachable scores; clamp to keep set small.
  let reachable = new Set<number>([startScore]);
  for (const round of rounds) {
    const next = new Set<number>();
    for (const score of reachable) {
      for (const delta of possibleDeltas(round)) {
        const value = score + delta;
        if (value >= -800 && value <= 800) {
          next.add(value);
        }
      }
    }
    reachable = next;
    if (reachable.size > 4000) {
      // Coarse prune: keep scores near 0 and multiples of 5.
      const pruned = new Set<number>();
      for (const score of reachable) {
        if (Math.abs(score) <= 200 || score % 10 === 0) {
          pruned.add(score);
        }
      }
      reachable = pruned;
    }
  }
  return reachable.has(0);
}

function reachableAfterOneRound(start: number, round: RoundSpec): Set<number> {
  const out = new Set<number>();
  for (const delta of possibleDeltas(round)) {
    out.add(start + delta);
  }
  return out;
}

/** Representative deltas achievable in a round of this type (not exhaustive for overtricks). */
function possibleDeltas(round: RoundSpec): number[] {
  const { type, cards } = round;
  const deltas = new Set<number>();

  if (type === 'GOLD') {
    for (let t = 0; t <= cards; t += 1) {
      deltas.add(10 * t);
    }
    return [...deltas];
  }

  if (type === 'MISER') {
    deltas.add(50); // 0 tricks
    deltas.add(100); // all tricks
    for (let t = 1; t < cards; t += 1) {
      deltas.add(-10 * t);
    }
    return [...deltas];
  }

  const mult = type === 'PERCENTS' ? 3 : 1;
  // Underbids
  for (let bid = 1; bid <= cards; bid += 1) {
    deltas.add(-10 * bid * mult);
  }
  // Exact makes
  deltas.add(5 * mult); // bid 0
  for (let bid = 1; bid <= cards; bid += 1) {
    if (bid === cards && cards > 1) {
      deltas.add(20 * bid * mult);
    } else {
      deltas.add(10 * bid * mult);
    }
  }
  // Simple overtricks: +taken for taken > bid (sample)
  for (let taken = 1; taken <= cards; taken += 1) {
    deltas.add(taken * mult);
  }

  return [...deltas];
}

function underbidDumpToZero(
  score: number,
  hand: number,
  roundType: RoundType,
): { bid: number } | null {
  if (score <= 0) {
    return null;
  }
  const mult = roundType === 'PERCENTS' ? 30 : 10;
  if (score % mult !== 0) {
    return null;
  }
  const bid = score / mult;
  if (bid >= 1 && bid <= hand && Number.isInteger(bid)) {
    return { bid };
  }
  return null;
}

function goldAccumulatePlan(
  myScore: number,
  hand: number,
  remaining: RoundSpec[],
  controlHand: number,
  context: DecisionContext,
): ZeroPathPlan | null {
  // Tricks already taken this GOLD round are on the player; score not yet updated.
  const already = context.me.tricksTaken;
  const left = Math.max(0, (context.me.cards?.length ?? hand) );
  // cards in hand ≈ remaining tricks including current if mid-trick — use remainingTricks feel:
  const tricksLeftInRound = left; // length of hand
  const maxEndTricks = already + tricksLeftInRound;

  // After this GOLD, later rounds (excluding current GOLD if first of remaining)
  const later = remaining.slice(1);
  const laterOrControl =
    later.length > 0
      ? later
      : [{ type: 'STANDARD' as RoundType, cards: controlHand }];

  type Candidate = { endTricks: number; scoreAfter: number; dumpable: boolean; dist: number };
  const candidates: Candidate[] = [];

  for (let endTricks = already; endTricks <= maxEndTricks; endTricks += 1) {
    const scoreAfter = myScore + 10 * endTricks;
    const dumpable =
      scoreAfter === 0
      || laterOrControl.some((round) => {
        if (round.type === 'GOLD' || round.type === 'MISER') {
          return reachableAfterOneRound(scoreAfter, round).has(0);
        }
        return underbidDumpToZero(scoreAfter, round.cards, round.type) !== null
          || reachableAfterOneRound(scoreAfter, round).has(0);
      });
    candidates.push({
      endTricks,
      scoreAfter,
      dumpable,
      dist: Math.abs(scoreAfter),
    });
  }

  const dumpable = candidates.filter((entry) => entry.dumpable);
  const pool = dumpable.length > 0 ? dumpable : candidates;
  // Prefer dumpable, then closer to 0, then higher dump pad (more miss margin) if positive.
  pool.sort((a, b) => {
    if (a.dumpable !== b.dumpable) {
      return a.dumpable ? -1 : 1;
    }
    if (a.scoreAfter === 0 && b.scoreAfter !== 0) {
      return -1;
    }
    if (b.scoreAfter === 0 && a.scoreAfter !== 0) {
      return 1;
    }
    // Prefer positive dump pads (underbid) over large negatives.
    const aPen = a.scoreAfter < 0 ? 50 : 0;
    const bPen = b.scoreAfter < 0 ? 50 : 0;
    if (a.dist + aPen !== b.dist + bPen) {
      return a.dist + aPen - (b.dist + bPen);
    }
    // More tricks for positive pad → larger sacrificial bid → safer miss.
    return b.endTricks - a.endTricks;
  });

  const best = pool[0];
  if (!best) {
    return null;
  }

  const targetTricks = best.endTricks;
  const maxTricksAllowed = targetTricks; // may take up to this many total in the round
  const needMore = targetTricks > already;

  return {
    active: true,
    style: best.scoreAfter === 0 && targetTricks === already
      ? 'hold_zero'
      : needMore
        ? 'accumulate'
        : 'target_delta',
    targetScoreAfterRound: best.scoreAfter,
    sacrificialBid: null,
    maxTricksAllowed,
    reason: best.dumpable
      ? `gold_pad_to_${best.scoreAfter}`
      : `gold_near_zero_${best.scoreAfter}`,
  };
}

function miserZeroPlan(myScore: number, hand: number): ZeroPathPlan | null {
  // score + delta = 0
  const options: Array<{ taken: number; delta: number }> = [
    { taken: 0, delta: 50 },
    { taken: hand, delta: 100 },
  ];
  for (let t = 1; t < hand; t += 1) {
    options.push({ taken: t, delta: -10 * t });
  }
  const hits = options.filter((option) => myScore + option.delta === 0);
  if (hits.length === 0) {
    return null;
  }
  // Prefer 0 tricks if possible (easier), else fewest tricks for negative dump.
  hits.sort((a, b) => a.taken - b.taken);
  const best = hits[0];
  return {
    active: true,
    style: best.taken === 0 ? 'hold_zero' : best.delta < 0 ? 'dump_underbid' : 'accumulate',
    targetScoreAfterRound: 0,
    sacrificialBid: null,
    maxTricksAllowed: best.taken,
    reason: `miser_taken_${best.taken}`,
  };
}
