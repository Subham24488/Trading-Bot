import type { IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import { istClock, minutesBetween } from './clock.js';
import { pctChange, type OptionSide } from './indicators.js';
import type { StrategyParams } from './params.js';
import type { IndexReading } from './signals.js';

export const GATE_IDS = [
  'entry-window',
  'daily-trade-limit',
  'daily-loss-limit',
  'cooldown',
  'data-missing',
  'expiry-day-cutoff',
  'weak-signal',
  'trend-disagrees',
  'too-many-opposing',
  'chasing',
  'opposite-candle',
  'fear-spike',
  'high-news',
  'near-big-level',
  'no-liquid-contract',
] as const;

export type GateId = (typeof GATE_IDS)[number];

export const EXIT_REASONS = [
  'square-off',
  'stale-position',
  'stop-loss',
  'trailing-stop',
  'time-stop',
  'trend-reversal',
  'news-risk',
  'unrestorable',
  'index-stop',
] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

export type DayStats = { trades: number; losingTrades: number; lastExitAt: Date | null };

export type Leaning = { index: IndexOptionName; side: OptionSide; score: number };

export type EntryDecision =
  | {
      action: 'BUY';
      index: IndexOptionName;
      side: OptionSide;
      score: number;
      reading: IndexReading;
    }
  | { action: 'SKIP'; blockedBy: GateId[]; leaning: Leaning | null; reading: IndexReading | null };

export type OpenPosition = {
  symbol: string;
  index: IndexOptionName;
  side: OptionSide;
  strike: number | null;
  expiry: string | null;
  token: number | null;
  entryPrice: number;
  enteredAt: Date;
  peakPrice: number;
  troughPrice: number;
  lotSize: number | null;
  entryDelta: number | null;
  /** Index spot when bought; drives the index-move stop. Null when it was not known. */
  entrySpot: number | null;
};

export type ExitCheck = { action: 'EXIT'; reason: ExitReason } | { action: 'HOLD' };

/** A SKIP records which way the market leaned once at least this many net votes agree. */
const LEANING_MIN_SCORE = 2;

function sideOf(score: number): OptionSide | null {
  return score > 0 ? 'CE' : score < 0 ? 'PE' : null;
}

function isNearBigLevel(reading: IndexReading, side: OptionSide, params: StrategyParams): boolean {
  const { spot, callWall, putWall } = reading;
  if (spot === null) {
    return false;
  }
  if (side === 'CE') {
    return callWall !== null && ((callWall - spot) / spot) * 100 < params.bigLevelBufferPct;
  }
  return putWall !== null && ((spot - putWall) / spot) * 100 < params.bigLevelBufferPct;
}

function readingGates(
  reading: IndexReading,
  side: OptionSide | null,
  minute: number,
  vixPct: number | null,
  params: StrategyParams,
): GateId[] {
  const gates: GateId[] = [];
  if (!reading.coreDataOk) {
    gates.push('data-missing');
  }
  if (reading.expiryToday && minute > params.expiryDayLastEntryMinute) {
    gates.push('expiry-day-cutoff');
  }
  if (side === null || Math.abs(reading.score) < params.minEntryScore) {
    gates.push('weak-signal');
  }
  if (side === null) {
    return gates;
  }
  const direction = side === 'CE' ? 1 : -1;
  if (reading.votes.averagePrice !== direction || reading.votes.trend !== direction) {
    gates.push('trend-disagrees');
  }
  const opposing = Object.values(reading.votes).filter((vote) => vote === -direction).length;
  if (opposing > params.maxOpposingVotes) {
    gates.push('too-many-opposing');
  }
  const chasing =
    reading.rsi !== null &&
    (side === 'CE'
      ? reading.rsi >= params.rsiChaseLimit
      : reading.rsi <= 100 - params.rsiChaseLimit);
  if (chasing) {
    gates.push('chasing');
  }
  if (reading.lastCandle.side !== null && reading.lastCandle.side !== side) {
    gates.push('opposite-candle');
  }
  if (side === 'CE' && vixPct !== null && vixPct >= params.maxVixRiseForCallsPct) {
    gates.push('fear-spike');
  }
  if (reading.newsLevel === 'high') {
    gates.push('high-news');
  }
  if (isNearBigLevel(reading, side, params)) {
    gates.push('near-big-level');
  }
  return gates;
}

/** How far (%) the index has moved against the position since entry; 0 when unknown. */
export function indexMovedAgainst(position: OpenPosition, spot: number | null): number {
  const moved = pctChange(position.entrySpot, spot);
  if (moved === null) {
    return 0;
  }
  return position.side === 'CE' ? -moved : moved;
}

/**
 * Flat book: BUY the strongest index whose votes and gates all agree, otherwise SKIP
 * with the gates that blocked the strongest index and the way the market leaned.
 */
export function decideEntry(
  input: {
    now: Date;
    readings: readonly IndexReading[];
    day: DayStats;
    vixPct: number | null;
  },
  params: StrategyParams,
): EntryDecision {
  const minute = istClock(input.now).minute;
  const common: GateId[] = [];
  if (minute < params.entryStartMinute || minute > params.lastEntryMinute) {
    common.push('entry-window');
  }
  if (input.day.trades >= params.maxTradesPerDay) {
    common.push('daily-trade-limit');
  }
  if (input.day.losingTrades >= params.maxLosingTradesPerDay) {
    common.push('daily-loss-limit');
  }
  if (
    input.day.lastExitAt &&
    minutesBetween(input.day.lastExitAt, input.now) < params.cooldownMinutes
  ) {
    common.push('cooldown');
  }

  const evaluated = [...input.readings]
    .sort((left, right) => Math.abs(right.score) - Math.abs(left.score))
    .map((reading) => {
      const side = sideOf(reading.score);
      return {
        reading,
        side,
        gates: [...common, ...readingGates(reading, side, minute, input.vixPct, params)],
      };
    });

  const winner = evaluated.find((item) => item.side !== null && item.gates.length === 0);
  if (winner?.side) {
    return {
      action: 'BUY',
      index: winner.reading.index,
      side: winner.side,
      score: winner.reading.score,
      reading: winner.reading,
    };
  }

  const strongest = evaluated[0];
  if (!strongest) {
    return { action: 'SKIP', blockedBy: [...common, 'data-missing'], leaning: null, reading: null };
  }
  const leaning =
    strongest.side && Math.abs(strongest.reading.score) >= LEANING_MIN_SCORE
      ? { index: strongest.reading.index, side: strongest.side, score: strongest.reading.score }
      : null;
  return { action: 'SKIP', blockedBy: strongest.gates, leaning, reading: strongest.reading };
}

/**
 * Open position, checked in order: end-of-day square-off, stale position, stop-loss,
 * trailing stop, time stop; then (cycle only, after the minimum hold) trend reversal
 * and major news while losing.
 */
export function checkPositionExit(
  input: {
    now: Date;
    position: OpenPosition;
    price: number | null;
    /** Current spot of the position's index. */
    spot?: number | null;
    reading?: IndexReading | null;
  },
  params: StrategyParams,
): ExitCheck {
  const { now, position, price } = input;
  const clock = istClock(now);
  if (istClock(position.enteredAt).ymd < clock.ymd) {
    return { action: 'EXIT', reason: 'stale-position' };
  }
  if (clock.minute >= params.squareOffMinute) {
    return { action: 'EXIT', reason: 'square-off' };
  }
  const pnlPct = pctChange(position.entryPrice, price);
  if (pnlPct !== null && pnlPct <= -params.stopLossPct) {
    return { action: 'EXIT', reason: 'stop-loss' };
  }
  if (indexMovedAgainst(position, input.spot ?? null) >= params.indexStopPct) {
    return { action: 'EXIT', reason: 'index-stop' };
  }
  if (price === null || pnlPct === null) {
    return { action: 'HOLD' };
  }
  const peakGainPct = pctChange(position.entryPrice, Math.max(position.peakPrice, price)) ?? 0;
  if (peakGainPct >= params.trailActivatePct && pnlPct < peakGainPct * params.trailKeepFraction) {
    return { action: 'EXIT', reason: 'trailing-stop' };
  }
  const heldMinutes = minutesBetween(position.enteredAt, now);
  if (heldMinutes >= params.timeStopMinutes && pnlPct < params.timeStopMinGainPct) {
    return { action: 'EXIT', reason: 'time-stop' };
  }
  const reading = input.reading;
  if (reading && heldMinutes >= params.minHoldMinutes) {
    const direction = position.side === 'CE' ? 1 : -1;
    const trendFlipped =
      reading.votes.averagePrice === -direction && reading.votes.trend === -direction;
    if (trendFlipped || reading.score * direction <= -params.reversalScore) {
      return { action: 'EXIT', reason: 'trend-reversal' };
    }
    if (reading.newsLevel === 'high' && pnlPct < 0) {
      return { action: 'EXIT', reason: 'news-risk' };
    }
  }
  return { action: 'HOLD' };
}

export type DayRow = {
  action: string;
  decidedAt: Date;
  buyPrice: number | null;
  sellPrice: number | null;
  /** Snapshot trigger; start-up exits of older positions do not count against today. */
  trigger: string | null;
};

export function summarizeDay(rows: readonly DayRow[], now: Date): DayStats {
  const today = istClock(now).ymd;
  const todays = rows.filter((row) => istClock(row.decidedAt).ymd === today);
  const exits = todays.filter((row) => row.action === 'EXIT' && row.trigger !== 'startup');
  return {
    trades: todays.filter((row) => row.action === 'BUY').length,
    losingTrades: exits.filter(
      (row) => row.buyPrice !== null && row.sellPrice !== null && row.sellPrice < row.buyPrice,
    ).length,
    lastExitAt: exits.reduce<Date | null>(
      (latest, row) => (latest && latest >= row.decidedAt ? latest : row.decidedAt),
      null,
    ),
  };
}
