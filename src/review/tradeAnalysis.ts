import { istClock, minutesBetween } from '../strategy/clock.js';
import { floorExitReason, profitFloor } from '../strategy/decisionEngine.js';
import { pctChange, type OptionSide } from '../strategy/indicators.js';
import type { StrategyParams } from '../strategy/params.js';
import { parseDecisionSnapshot, type DecisionSnapshot } from '../strategy/snapshot.js';

export type ReviewRow = {
  decidedAt: Date;
  symbol: string;
  action: 'BUY' | 'HOLD' | 'EXIT' | 'SKIP';
  rationale: string;
  marketSnapshot: unknown;
  buyPrice: number | null;
  currentPrice: number | null;
  sellPrice: number | null;
  /** Optional so older fixtures and LLM-era rows still parse; null on SKIP. */
  tuuid?: string | null;
};

export type EntryContext = {
  index: string;
  side: OptionSide;
  score: number;
  opposingVotes: number;
  rsi: number | null;
  vixPct: number | null;
  ivToHv: number | null;
  delta: number | null;
  minute: number;
};

export type AnalyzedTrade = {
  symbol: string;
  /** From the BUY row; null for trades stored before tuuid existed. */
  tuuid: string | null;
  /** Made by the old LLM-based loop (no rules-v1 snapshot). */
  legacy: boolean;
  entryAt: Date;
  exitAt: Date | null;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlPct: number | null;
  netPnlInr: number | null;
  heldMinutes: number | null;
  exitReason: string | null;
  bestPct: number | null;
  worstPct: number | null;
  /** Share of the best gain that was kept at the exit. */
  keptShare: number | null;
  unclosed: boolean;
  overnight: boolean;
  startupExit: boolean;
  afterLossSameDay: boolean;
  /** Estimated best gain versus the entry price after the exit, same day. */
  afterExitBestPct: number | null;
  /** Estimated gain versus the entry price at the last stored point that day. */
  afterExitEndPct: number | null;
  entry: EntryContext | null;
  tunables: Record<string, number> | null;
  rationale: string;
  exitRationale: string | null;
  notes: string[];
};

export type SkipOutcome = 'missed-winner' | 'avoided-loser' | 'neutral' | 'unknown';

export type SkipEpisode = {
  startAt: Date;
  endAt: Date;
  rows: number;
  index: string;
  side: OptionSide;
  score: number;
  blockedBy: string[];
  symbol: string | null;
  estPnlPct: number | null;
  outcome: SkipOutcome;
  rationale: string;
};

export type GateStats = {
  gate: string;
  episodes: number;
  missedWinners: number;
  avoidedLosers: number;
  neutral: number;
};

/** Estimated outcome at or beyond these levels counts as a clear winner / loser. */
export const MISSED_WINNER_PCT = 10;
export const AVOIDED_LOSER_PCT = -10;
/** Delta assumed for an at-the-money option when none was stored. */
const DEFAULT_DELTA = 0.5;

type PathPoint = { at: Date; spot: number };

/** Text after `why=` in rationales written by the old LLM loop. */
export function legacyWhy(rationale: string): string {
  return rationale.match(/(?:^|;)\s*why=([^;]*)/i)?.[1]?.trim() ?? '';
}

function sameIstDay(left: Date, right: Date): boolean {
  return istClock(left).ymd === istClock(right).ymd;
}

/** Index levels stored by later rows of the same day (every cycle records spots). */
export function indexPath(rows: readonly ReviewRow[], after: Date, index: string): PathPoint[] {
  const points: PathPoint[] = [];
  for (const row of rows) {
    if (row.decidedAt <= after || !sameIstDay(row.decidedAt, after)) {
      continue;
    }
    const spot = parseDecisionSnapshot(row.marketSnapshot)?.spots[index];
    if (spot !== undefined && spot > 0) {
      points.push({ at: row.decidedAt, spot });
    }
  }
  return points;
}

/**
 * Rough option price path: premium + delta × index move (time decay ignored), run through
 * the stop-loss, profit floor (break-even lock and stepped trailing stop), time stop and
 * square-off rules.
 */
export function simulateExitRules(
  start: { premium: number; delta: number; side: OptionSide; spot: number; at: Date },
  path: readonly PathPoint[],
  params: StrategyParams,
): { pnlPct: number; bestPct: number; reason: string } | null {
  if (path.length === 0 || !(start.premium > 0)) {
    return null;
  }
  const direction = start.side === 'CE' ? 1 : -1;
  let peak = start.premium;
  let latestPct = 0;
  for (const point of path) {
    const estimate = Math.max(
      0.05,
      start.premium + start.delta * (point.spot - start.spot) * direction,
    );
    peak = Math.max(peak, estimate);
    latestPct = pctChange(start.premium, estimate) ?? 0;
    const bestPct = pctChange(start.premium, peak) ?? 0;
    if (latestPct <= -params.stopLossPct) {
      return { pnlPct: latestPct, bestPct, reason: 'stop-loss' };
    }
    const floor = profitFloor(bestPct, params);
    if (floor && latestPct < floor.floorPct) {
      return { pnlPct: latestPct, bestPct, reason: floorExitReason(floor) };
    }
    if (
      minutesBetween(start.at, point.at) >= params.timeStopMinutes &&
      latestPct < params.timeStopMinGainPct
    ) {
      return { pnlPct: latestPct, bestPct, reason: 'time-stop' };
    }
    if (istClock(point.at).minute >= params.squareOffMinute) {
      return { pnlPct: latestPct, bestPct, reason: 'square-off' };
    }
  }
  return {
    pnlPct: latestPct,
    bestPct: pctChange(start.premium, peak) ?? 0,
    reason: 'end-of-day data',
  };
}

function entryContext(snapshot: DecisionSnapshot, decidedAt: Date): EntryContext | null {
  const entry = snapshot.entry;
  if (!entry) {
    return null;
  }
  const direction = entry.side === 'CE' ? 1 : -1;
  const reading = snapshot.readings.find((item) => item.index === entry.index);
  return {
    index: entry.index,
    side: entry.side,
    score: entry.score,
    opposingVotes: reading
      ? Object.values(reading.votes).filter((vote) => vote === -direction).length
      : 0,
    rsi: reading?.rsi ?? null,
    vixPct: snapshot.market.vixPct,
    ivToHv: entry.candidates.find((candidate) => candidate.symbol === entry.chosen)?.ivToHv ?? null,
    delta: snapshot.position?.entryDelta ?? null,
    minute: istClock(decidedAt).minute,
  };
}

function afterExitMoves(
  rows: readonly ReviewRow[],
  exit: ReviewRow,
  exitSnapshot: DecisionSnapshot | null,
  entry: EntryContext | null,
  entryPrice: number | null,
  exitPrice: number | null,
): { best: number | null; end: number | null } {
  const exitSpot = entry ? exitSnapshot?.spots[entry.index] : undefined;
  if (!entry || exitSpot === undefined || entryPrice === null || exitPrice === null) {
    return { best: null, end: null };
  }
  const path = indexPath(rows, exit.decidedAt, entry.index);
  if (path.length === 0) {
    return { best: null, end: null };
  }
  const direction = entry.side === 'CE' ? 1 : -1;
  const delta = entry.delta ?? DEFAULT_DELTA;
  const gains = path.map(
    (point) => pctChange(entryPrice, exitPrice + delta * (point.spot - exitSpot) * direction) ?? 0,
  );
  return { best: Math.max(...gains), end: gains.at(-1) ?? null };
}

function formatPct(value: number): string {
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1)}%`;
}

function tradeNotes(trade: Omit<AnalyzedTrade, 'notes'>): string[] {
  const notes: string[] = [];
  if (trade.legacy) {
    notes.push('Made by the previous LLM-based logic; reported but not used to tune the rules.');
  }
  if (trade.unclosed) {
    notes.push('Still open at the end of the reviewed period.');
  }
  if (trade.overnight) {
    notes.push('Held overnight; positions should be sold by 3:15 PM.');
  }
  if (
    trade.bestPct !== null &&
    trade.pnlPct !== null &&
    trade.bestPct >= 20 &&
    trade.pnlPct < trade.bestPct * 0.4
  ) {
    notes.push(
      `Reached ${formatPct(trade.bestPct)} but sold at ${formatPct(trade.pnlPct)}: most of the gain was given back.`,
    );
  }
  if (
    trade.exitReason === 'stop-loss' &&
    (trade.afterExitBestPct ?? -Infinity) >= MISSED_WINNER_PCT
  ) {
    notes.push(
      `Stopped out, then the option would have recovered to about ${formatPct(trade.afterExitBestPct!)} (estimated).`,
    );
  }
  if (trade.exitReason === 'time-stop' && (trade.afterExitBestPct ?? -Infinity) >= 15) {
    notes.push(
      `Closed for lack of progress, but the move came later (about ${formatPct(trade.afterExitBestPct!)}, estimated).`,
    );
  }
  return notes;
}

function analyzeTrade(
  rows: readonly ReviewRow[],
  buy: ReviewRow,
  holds: readonly ReviewRow[],
  exit: ReviewRow | null,
): Omit<AnalyzedTrade, 'afterLossSameDay' | 'notes'> {
  const buySnapshot = parseDecisionSnapshot(buy.marketSnapshot);
  const exitSnapshot = exit ? parseDecisionSnapshot(exit.marketSnapshot) : null;
  const entryPrice = buy.buyPrice ?? buy.currentPrice;
  const exitPrice = exit ? (exit.sellPrice ?? exit.currentPrice) : null;
  const pricePath = [entryPrice, ...holds.map((row) => row.currentPrice), exitPrice].filter(
    (price): price is number => price !== null && price > 0,
  );
  const peak =
    exitSnapshot?.position?.peakPrice ?? (pricePath.length ? Math.max(...pricePath) : null);
  const trough =
    exitSnapshot?.position?.troughPrice ?? (pricePath.length ? Math.min(...pricePath) : null);
  const pnlPct = pctChange(entryPrice, exitPrice);
  const bestPct = pctChange(entryPrice, peak);
  const entry = buySnapshot ? entryContext(buySnapshot, buy.decidedAt) : null;
  const after = exit
    ? afterExitMoves(rows, exit, exitSnapshot, entry, entryPrice, exitPrice)
    : { best: null, end: null };
  return {
    symbol: buy.symbol,
    tuuid: buy.tuuid ?? null,
    legacy: buySnapshot === null,
    entryAt: buy.decidedAt,
    exitAt: exit?.decidedAt ?? null,
    entryPrice,
    exitPrice,
    pnlPct,
    netPnlInr: exitSnapshot?.position?.netPnlInr ?? null,
    heldMinutes: exit ? minutesBetween(buy.decidedAt, exit.decidedAt) : null,
    exitReason: exitSnapshot?.exit?.reason ?? (exit ? legacyWhy(exit.rationale) || null : null),
    bestPct,
    worstPct: pctChange(entryPrice, trough),
    keptShare: bestPct !== null && bestPct > 0 && pnlPct !== null ? pnlPct / bestPct : null,
    unclosed: exit === null,
    overnight: exit !== null && !sameIstDay(buy.decidedAt, exit.decidedAt),
    startupExit: exitSnapshot?.trigger === 'startup',
    afterExitBestPct: after.best,
    afterExitEndPct: after.end,
    entry,
    tunables: buySnapshot?.tunables ?? null,
    rationale: buy.rationale,
    exitRationale: exit?.rationale ?? null,
  };
}

/** Pairs BUY → HOLD… → EXIT per symbol; unmatched BUYs are reported as unclosed. */
export function buildTrades(rows: readonly ReviewRow[]): AnalyzedTrade[] {
  const open = new Map<string, { buy: ReviewRow; holds: ReviewRow[] }>();
  const built: Array<Omit<AnalyzedTrade, 'afterLossSameDay' | 'notes'>> = [];
  for (const row of rows) {
    if (row.action === 'BUY') {
      open.set(row.symbol, { buy: row, holds: [] });
    } else if (row.action === 'HOLD') {
      open.get(row.symbol)?.holds.push(row);
    } else if (row.action === 'EXIT') {
      const trade = open.get(row.symbol);
      if (trade) {
        built.push(analyzeTrade(rows, trade.buy, trade.holds, row));
        open.delete(row.symbol);
      }
    }
  }
  for (const trade of open.values()) {
    built.push(analyzeTrade(rows, trade.buy, trade.holds, null));
  }
  built.sort((left, right) => left.entryAt.getTime() - right.entryAt.getTime());
  return built.map((trade) => {
    const afterLossSameDay = built.some(
      (earlier) =>
        earlier.exitAt !== null &&
        earlier.exitAt <= trade.entryAt &&
        sameIstDay(earlier.exitAt, trade.entryAt) &&
        (earlier.pnlPct ?? 0) < 0,
    );
    const withFlag = { ...trade, afterLossSameDay };
    return { ...withFlag, notes: tradeNotes(withFlag) };
  });
}

/**
 * Consecutive rules-based SKIPs with the same lean and the same blocking gates form one
 * episode, so a single missed move is not counted at every cycle.
 */
export function buildSkipEpisodes(
  rows: readonly ReviewRow[],
  params: StrategyParams,
): SkipEpisode[] {
  const episodes: SkipEpisode[] = [];
  let current: {
    first: ReviewRow;
    snapshot: DecisionSnapshot;
    key: string;
    last: ReviewRow;
    count: number;
  } | null = null;
  const close = () => {
    if (current) {
      episodes.push(
        evaluateEpisode(rows, current.first, current.snapshot, current.last, current.count, params),
      );
      current = null;
    }
  };
  for (const row of rows) {
    const snapshot = row.action === 'SKIP' ? parseDecisionSnapshot(row.marketSnapshot) : null;
    const leaning = snapshot?.leaning;
    if (!snapshot || !leaning) {
      close();
      continue;
    }
    const key = `${istClock(row.decidedAt).ymd}|${leaning.index}|${leaning.side}|${[...snapshot.blockedBy].sort().join(',')}`;
    if (current && current.key === key) {
      current.last = row;
      current.count += 1;
      continue;
    }
    close();
    current = { first: row, snapshot, key, last: row, count: 1 };
  }
  close();
  return episodes;
}

function evaluateEpisode(
  rows: readonly ReviewRow[],
  first: ReviewRow,
  snapshot: DecisionSnapshot,
  last: ReviewRow,
  count: number,
  params: StrategyParams,
): SkipEpisode {
  const leaning = snapshot.leaning!;
  const spot = snapshot.spots[leaning.index];
  const simulated =
    leaning.premium !== null && spot !== undefined
      ? simulateExitRules(
          {
            premium: leaning.premium,
            delta: leaning.delta ?? DEFAULT_DELTA,
            side: leaning.side,
            spot,
            at: first.decidedAt,
          },
          indexPath(rows, first.decidedAt, leaning.index),
          params,
        )
      : null;
  const outcome: SkipOutcome = !simulated
    ? 'unknown'
    : simulated.pnlPct >= MISSED_WINNER_PCT
      ? 'missed-winner'
      : simulated.pnlPct <= AVOIDED_LOSER_PCT
        ? 'avoided-loser'
        : 'neutral';
  return {
    startAt: first.decidedAt,
    endAt: last.decidedAt,
    rows: count,
    index: leaning.index,
    side: leaning.side,
    score: leaning.score,
    blockedBy: [...snapshot.blockedBy],
    symbol: leaning.symbol,
    estPnlPct: simulated ? Number(simulated.pnlPct.toFixed(1)) : null,
    outcome,
    rationale: first.rationale,
  };
}

export function gateStats(episodes: readonly SkipEpisode[]): GateStats[] {
  const byGate = new Map<string, GateStats>();
  for (const episode of episodes) {
    if (episode.outcome === 'unknown') {
      continue;
    }
    for (const gate of episode.blockedBy) {
      const stats = byGate.get(gate) ?? {
        gate,
        episodes: 0,
        missedWinners: 0,
        avoidedLosers: 0,
        neutral: 0,
      };
      stats.episodes += 1;
      if (episode.outcome === 'missed-winner') {
        stats.missedWinners += 1;
      } else if (episode.outcome === 'avoided-loser') {
        stats.avoidedLosers += 1;
      } else {
        stats.neutral += 1;
      }
      byGate.set(gate, stats);
    }
  }
  return [...byGate.values()].sort((left, right) => right.episodes - left.episodes);
}

/** Most common `why=` reasons among SKIPs written by the old LLM loop. */
export function legacySkipReasons(
  rows: readonly ReviewRow[],
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.action !== 'SKIP' || parseDecisionSnapshot(row.marketSnapshot)) {
      continue;
    }
    const reason = legacyWhy(row.rationale) || 'no reason recorded';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5);
}
