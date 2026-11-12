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
  'low-reward',
  'day-in-profit',
  'no-candle-confirmation',
  'near-chart-level',
  'chart-trend-disagrees',
  'target-out-of-reach',
  'risk-too-wide',
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
  'breakeven-stop',
  'level-reached',
  'chart-stop',
  'profit-lock',
] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

export type DayStats = {
  trades: number;
  losingTrades: number;
  lastExitAt: Date | null;
  /** Net ₹ of today's closed trades after estimated charges. */
  netPnlInr: number;
};

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
  /**
   * Index level (spot) that ends the trade: under the setup's low for calls, over its high for
   * puts, tightened as new swings form. Null: the `indexStopPct` move from entry applies.
   */
  stopSpot: number | null;
  /** Option price that ends the trade, the planned loss limit. Null: `stopLossPct` applies. */
  premiumStop: number | null;
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

/**
 * Room (% of spot) the index has before the next big option level in the trade's direction:
 * the call wall above for calls, the put wall below for puts. Null when either is unknown.
 */
export function levelRoomPct(reading: IndexReading, side: OptionSide): number | null {
  const { spot } = reading;
  const wall = side === 'CE' ? reading.callWall : reading.putWall;
  if (spot === null || wall === null) {
    return null;
  }
  const room = ((wall - spot) / spot) * 100;
  return side === 'CE' ? room : -room;
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
  const { chart } = reading;
  const stretched =
    reading.rsi !== null &&
    (side === 'CE'
      ? reading.rsi >= params.rsiChaseLimit
      : reading.rsi <= 100 - params.rsiChaseLimit);
  // A climax: the last few candles already moved several normal swings in the trade's direction.
  const burstAtr = chart?.burstAtr ?? null;
  const burst = burstAtr !== null && burstAtr * direction >= params.chart.maxBurstAtr;
  if (stretched || burst) {
    gates.push('chasing');
  }
  if (reading.lastCandle.side !== null && reading.lastCandle.side !== side) {
    gates.push('opposite-candle');
  } else if (chart && chart.candle.confirms !== side) {
    gates.push('no-candle-confirmation');
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
  if (!chart) {
    const room = levelRoomPct(reading, side);
    if (room !== null && room < params.minRewardToRisk * params.indexStopPct) {
      gates.push('low-reward');
    }
    return gates;
  }
  const plan = chart.plans[side];
  if (plan.nearLevel) {
    gates.push('near-chart-level');
  }
  const against = side === 'CE' ? 'down' : 'up';
  if (chart.structure === against || chart.higherTrend === against) {
    gates.push('chart-trend-disagrees');
  }
  if (plan.rewardToRisk < params.chart.minRewardToRisk) {
    gates.push('low-reward');
  }
  return gates;
}

export type ProfitFloor = { floorPct: number; kind: 'lock' | 'breakeven' | 'trail' | 'level' };

const FLOOR_EXIT_REASON: Record<ProfitFloor['kind'], ExitReason> = {
  lock: 'profit-lock',
  breakeven: 'breakeven-stop',
  trail: 'trailing-stop',
  level: 'level-reached',
};

/** Rounding slack so a price exactly at a stop, floor or lock level counts as at it. */
const ROUNDING_SLACK = 1e-9;

/** Gain (% on premium) the ₹ profit lock keeps for an option bought at `entryPrice`. */
export function profitLockPct(entryPrice: number, params: StrategyParams): number | null {
  return entryPrice > 0 && params.profitLockInr > 0
    ? (params.profitLockInr / entryPrice) * 100
    : null;
}

/**
 * Lowest gain (% on premium) the trade may fall back to before it is sold, from its best gain
 * so far; null until the break-even lock or the ₹ profit lock arms. With `entryPrice`, a best
 * price of buy + `profitLockInr` moves the floor up to that price. Shared by the live checks,
 * the HOLD rationale and the review's what-if replay.
 */
export function profitFloor(
  peakGainPct: number,
  params: StrategyParams,
  atBigLevel = false,
  entryPrice: number | null = null,
): ProfitFloor | null {
  const lockPct = entryPrice === null ? null : profitLockPct(entryPrice, params);
  const lockArmed = lockPct !== null && peakGainPct + ROUNDING_SLACK >= lockPct;
  const breakevenArmed = peakGainPct >= params.breakevenActivatePct;
  if (!breakevenArmed && !lockArmed) {
    return null;
  }
  let floor: ProfitFloor =
    lockArmed && (!breakevenArmed || lockPct > params.breakevenLockPct)
      ? { floorPct: lockPct, kind: 'lock' }
      : { floorPct: params.breakevenLockPct, kind: 'breakeven' };
  const raise = (floorPct: number, kind: ProfitFloor['kind']) => {
    if (floorPct > floor.floorPct) {
      floor = { floorPct, kind };
    }
  };
  if (peakGainPct >= params.trailActivatePct) {
    const keep = params.trailTiers.reduce(
      (best, tier) => (peakGainPct >= tier.fromPct ? Math.max(best, tier.keep) : best),
      params.trailKeepFraction,
    );
    raise(peakGainPct * keep, 'trail');
  }
  if (atBigLevel) {
    raise(peakGainPct * params.bigLevelKeepFraction, 'level');
  }
  return floor;
}

/** The exit reason stored when the price falls through `floor`. */
export function floorExitReason(floor: ProfitFloor): ExitReason {
  return FLOOR_EXIT_REASON[floor.kind];
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
  if (input.day.netPnlInr > params.dayProfitLockInr) {
    common.push('day-in-profit');
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
 * Open position, checked in order: stale position, end-of-day square-off, the planned premium
 * stop, the chart stop on the index (or the fixed index move without one), the profit floor
 * (₹ profit lock, break-even lock, stepped trailing stop, tighter at a big level on cycle
 * checks), time stop; then (cycle only, after the minimum hold) trend reversal and major news
 * while losing.
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
  const premiumStop = position.premiumStop ?? position.entryPrice * (1 - params.stopLossPct / 100);
  if (price !== null && price <= premiumStop + ROUNDING_SLACK) {
    return { action: 'EXIT', reason: 'stop-loss' };
  }
  const spot = input.spot ?? null;
  if (position.stopSpot !== null) {
    const broken =
      spot !== null &&
      (position.side === 'CE' ? spot <= position.stopSpot : spot >= position.stopSpot);
    if (broken) {
      return { action: 'EXIT', reason: 'chart-stop' };
    }
  } else if (indexMovedAgainst(position, spot) >= params.indexStopPct) {
    return { action: 'EXIT', reason: 'index-stop' };
  }
  if (price === null || pnlPct === null) {
    return { action: 'HOLD' };
  }
  const reading = input.reading;
  const peakGainPct = pctChange(position.entryPrice, Math.max(position.peakPrice, price)) ?? 0;
  const floor = profitFloor(
    peakGainPct,
    params,
    reading ? isNearBigLevel(reading, position.side, params) : false,
    position.entryPrice,
  );
  if (floor && pnlPct < floor.floorPct - ROUNDING_SLACK) {
    return { action: 'EXIT', reason: floorExitReason(floor) };
  }
  const heldMinutes = minutesBetween(position.enteredAt, now);
  if (heldMinutes >= params.timeStopMinutes && pnlPct < params.timeStopMinGainPct) {
    return { action: 'EXIT', reason: 'time-stop' };
  }
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
  /** EXIT only: net ₹ after estimated charges, when known. */
  netPnlInr: number | null;
};

export function summarizeDay(rows: readonly DayRow[], now: Date): DayStats {
  const today = istClock(now).ymd;
  const todays = rows.filter((row) => istClock(row.decidedAt).ymd === today);
  const exits = todays.filter((row) => row.action === 'EXIT' && row.trigger !== 'startup');
  return {
    trades: todays.filter((row) => row.action === 'BUY').length,
    // A trade sold just above its buy price can still lose after charges; that counts as a loss.
    losingTrades: exits.filter((row) =>
      row.netPnlInr !== null
        ? row.netPnlInr < 0
        : row.buyPrice !== null && row.sellPrice !== null && row.sellPrice < row.buyPrice,
    ).length,
    lastExitAt: exits.reduce<Date | null>(
      (latest, row) => (latest && latest >= row.decidedAt ? latest : row.decidedAt),
      null,
    ),
    netPnlInr: exits.reduce((sum, row) => sum + (row.netPnlInr ?? 0), 0),
  };
}
