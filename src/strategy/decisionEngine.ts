import type { IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import type { IntradayBar } from '../universe/types.js';
import { istClock, minutesBetween } from './clock.js';
import { TICK } from './contracts.js';
import { pctChange, type OptionSide } from './indicators.js';
import type { StrategyParams } from './params.js';
import type { SetupKind } from './setups.js';
import type { DayType, IndexReading, SignalName } from './signals.js';
import type { ChartRead } from './chart.js';

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
  'no-pullback',
  'signals-disagree',
  'against-day-average',
  'bank-nifty-disagrees',
  'after-vix-spike',
  'scheduled-event',
  'doji-wait',
  'candle-not-at-level',
  'candles-disagree',
  'unclear-day-wait',
  'not-for-this-day-type',
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
  'target-reached',
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
  /**
   * Option price that triggers the stop-loss order, the planned loss limit. Null: `stopLossPct`
   * applies.
   */
  premiumStop: number | null;
  /** On a range-bound day: the setup's target on the index (spot), sold when reached. */
  targetSpot?: number | null;
};

export type ExitCheck = { action: 'EXIT'; reason: ExitReason } | { action: 'HOLD' };

export type StopOrderCheck =
  | ExitCheck
  /** The stop-loss order filled at `price`. */
  | { action: 'SOLD'; price: number }
  /** Triggered, but the price is under the order's limit: it waits to be re-priced to the bid. */
  | { action: 'UNFILLED' };

/** Which entries suit each day type: a trend day its breakouts, pullbacks, flags and retests. */
const DAY_TYPE_SETUPS: Record<SetupKind | 'pullback' | 'breakout', readonly DayType[]> = {
  pullback: ['trend', 'unclear'],
  breakout: ['trend'],
  flag: ['trend'],
  'opening-range-retest': ['trend'],
  'double-bottom': ['range', 'unclear'],
  'double-top': ['range', 'unclear'],
  'failed-breakout': ['range', 'unclear'],
};

/** A SKIP records which way the market leaned once at least this many net votes agree. */
const LEANING_MIN_SCORE = 2;

function sideOf(score: number): OptionSide | null {
  return score > 0 ? 'CE' : score < 0 ? 'PE' : null;
}

/**
 * Votes about the market backdrop rather than the last few candles. A pullback moves the price
 * votes against the trend for a while, so in pullback mode only these can block an entry.
 */
const BACKDROP_VOTES: readonly SignalName[] = [
  'futuresPositioning',
  'optionFlow',
  'breadth',
  'globalMood',
];

/** Pullback entries need a chart; without one the earlier vote-led rules apply. */
function usesPullback(reading: IndexReading, params: StrategyParams): boolean {
  return params.entryMode === 'pullback' && reading.chart !== null;
}

/** The side the 15-minute trend points to; null when it is flat or unknown. */
function trendSide(chart: ChartRead): OptionSide | null {
  return chart.higherTrend === 'up' ? 'CE' : chart.higherTrend === 'down' ? 'PE' : null;
}

/**
 * The side a reading would trade: a trend-day trigger's side (a breakout in the trend day's
 * direction), else the 15-minute trend in pullback mode, else the votes.
 */
function entrySide(reading: IndexReading, params: StrategyParams): OptionSide | null {
  if (reading.trendDayEntry?.trigger) {
    return reading.trendDayEntry.side;
  }
  if (reading.setup) {
    return reading.setup.side;
  }
  return usesPullback(reading, params) && reading.chart
    ? trendSide(reading.chart)
    : sideOf(reading.score);
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
  // Calls while the index is above its 20-day average close, puts while below it; a trade against
  // it needs a stronger setup: at least `againstDayAverageMinScore` of the 8 votes on its side.
  const { spot, dayAverage } = reading;
  if (side !== null && spot !== null && dayAverage !== null) {
    const rightSide = side === 'CE' ? spot > dayAverage : spot < dayAverage;
    const agreement = reading.score * (side === 'CE' ? 1 : -1);
    if (!rightSide && agreement < params.againstDayAverageMinScore) {
      gates.push('against-day-average');
    }
  }
  const { chart } = reading;
  const pullback = usesPullback(reading, params);
  // On a trend day, a trade in its direction may enter on a breakout: the breakout candle is the
  // confirmation, so it does not wait for a pullback, a confirming candle or the votes.
  const trendEntry =
    side !== null && reading.trendDayEntry?.side === side ? reading.trendDayEntry : null;
  const trigger = trendEntry?.trigger ?? null;
  // A chart setup (flag, opening-range retest, double bottom or top, failed breakout) does not
  // wait for a pullback or the votes either, and reads its own signal candle.
  const setup = side !== null && reading.setup?.side === side ? reading.setup : null;
  const kind = trigger ? 'breakout' : (setup?.kind ?? 'pullback');
  // The day type decides which setups trade (`DAY_TYPE_SETUPS`); a trend day only in its own
  // direction, and an unclear day nothing before 10:30.
  if (reading.dayType === 'unclear' && minute < params.trendDay.unclearWaitUntilMinute) {
    gates.push('unclear-day-wait');
  }
  if (
    side !== null &&
    reading.dayType !== undefined &&
    (!DAY_TYPE_SETUPS[kind].includes(reading.dayType) ||
      (reading.dayType === 'trend' && reading.trendDay?.side !== side))
  ) {
    gates.push('not-for-this-day-type');
  }
  // The 15-minute trend must agree, except for the reversal setups.
  const trendWay = side === 'CE' ? 'up' : 'down';
  if ((kind === 'flag' || kind === 'opening-range-retest') && chart?.higherTrend !== trendWay) {
    gates.push('chart-trend-disagrees');
  }
  if (pullback) {
    // A clear 15-minute trend and the price back near value (VWAP or the 21-bar average); when
    // the votes agree strongly, a shallower pullback will do.
    const agreement = side === null ? 0 : reading.score * (side === 'CE' ? 1 : -1);
    const maxGap =
      agreement >= params.chart.strongTrendScore
        ? params.chart.strongTrendMaxValueGapAtr
        : params.chart.maxValueGapAtr;
    const gap = chart?.valueGapAtr ?? null;
    // On a trend day a shallow dip (to the 9-candle average, or a higher low) is pullback enough.
    const shallow = trendEntry?.shallowPullback ?? null;
    if (!trigger && !setup && !shallow && (side === null || gap === null || gap > maxGap)) {
      gates.push('no-pullback');
    }
    // The 8 votes must lean the trade's way: entries against them lost 6 times out of 8.
    if (!trigger && !setup && side !== null && agreement < params.minAgreeingScore) {
      gates.push('signals-disagree');
    }
  } else if (side === null || Math.abs(reading.score) < params.minEntryScore) {
    gates.push('weak-signal');
  }
  if (side === null) {
    return gates;
  }
  const direction = side === 'CE' ? 1 : -1;
  if (
    !pullback &&
    (reading.votes.averagePrice !== direction || reading.votes.trend !== direction)
  ) {
    gates.push('trend-disagrees');
  }
  const counted = pullback
    ? BACKDROP_VOTES.map((name) => reading.votes[name])
    : Object.values(reading.votes);
  if (counted.filter((vote) => vote === -direction).length > params.maxOpposingVotes) {
    gates.push('too-many-opposing');
  }
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
  // Pullback entries check the candle's shape only: volume against earlier days' same slot
  // swings too much (all six 11-13 pullback winners traded at 0.4–0.6× of it).
  const confirmed = pullback ? chart?.candle.shapeConfirms : chart?.candle.confirms;
  // Candle rules, for every entry: the last finished 5-minute candle must be a named pattern on
  // the trade's side that closes strongly, it must trade at a level, a doji means wait, and the
  // last 15-minute candle must not point the other way.
  // A setup has already checked its own signal candle (15-minute for the flag, double bottom or
  // top and failed breakout; 5-minute for the opening-range retest).
  const candle = chart?.candle ?? null;
  if (reading.lastCandle.side !== null && reading.lastCandle.side !== side) {
    gates.push('opposite-candle');
  } else if (!setup && candle?.pattern === 'doji') {
    gates.push('doji-wait');
  } else if (!setup && chart && confirmed !== side) {
    gates.push('no-candle-confirmation');
  } else if (!setup && candle && candle.atLevel === null) {
    gates.push('candle-not-at-level');
  }
  const fifteenSide = chart?.fifteenMinuteCandle?.side ?? null;
  if (fifteenSide !== null && candle?.side && fifteenSide !== candle.side) {
    gates.push('candles-disagree');
  }
  if (side === 'CE' && vixPct !== null && vixPct >= params.maxVixRiseForCallsPct) {
    gates.push('fear-spike');
  }
  // Banks are a large part of NIFTY: skip when Bank NIFTY is moving the other way.
  const bankMove = reading.bankNiftyMovePct ?? null;
  if (bankMove !== null && bankMove * direction <= -params.bankNiftyAgainstPct) {
    gates.push('bank-nifty-disagrees');
  }
  // Straight after a jump in India VIX, option prices tend to fall back as it settles.
  const vixMove = reading.vixMovePct ?? null;
  if (vixMove !== null && vixMove >= params.vixSpikePct) {
    gates.push('after-vix-spike');
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
  if (pullback) {
    // The 15-minute trend already picked the side and a pullback forms 5-minute swings against
    // it. Swings of the last two sessions sit every few points, so a nearby level is not a
    // reason to skip either: the 11-13 pullback winners went through levels 13–30 points away.
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
 * ₹ per unit above the buy price that the profit lock keeps, from the best price so far: null
 * below buy + `profitLockInr`, then `profitLockStartInr`, rising by `profitStepInr` for each
 * further step reached (with the defaults: +₹10 → 0, the buy price; +₹15 → 5; +₹20 → 10 …).
 * Without steps it is a single lock at `profitLockInr`.
 */
export function profitLockLevelInr(
  entryPrice: number,
  peakPrice: number,
  params: StrategyParams,
): number | null {
  const gain = peakPrice - entryPrice;
  if (
    !(entryPrice > 0) ||
    params.profitLockInr <= 0 ||
    gain + ROUNDING_SLACK < params.profitLockInr
  ) {
    return null;
  }
  if (params.profitStepInr <= 0) {
    return params.profitLockInr;
  }
  const steps = Math.floor((gain - params.profitLockInr) / params.profitStepInr + ROUNDING_SLACK);
  return params.profitLockStartInr + steps * params.profitStepInr;
}

/**
 * Lowest gain (% on premium) the trade may fall back to before it is sold, from its best gain
 * so far; null until the break-even lock or the ₹ profit lock arms. With `entryPrice`, a best
 * price of buy + `profitLockInr` moves the floor up to that price; with `profitStepInr` the floor
 * moves to buy + `profitLockStartInr` instead, then ratchets up and alone decides the floor. Shared by the live checks, the HOLD rationale
 * and the review's what-if replay.
 */
export function profitFloor(
  peakGainPct: number,
  params: StrategyParams,
  atBigLevel = false,
  entryPrice: number | null = null,
): ProfitFloor | null {
  const lockPct = entryPrice === null ? null : profitLockPct(entryPrice, params);
  const lockArmed = lockPct !== null && peakGainPct + ROUNDING_SLACK >= lockPct;
  if (lockArmed && entryPrice !== null && params.profitStepInr > 0) {
    const level = profitLockLevelInr(entryPrice, entryPrice * (1 + peakGainPct / 100), params);
    return { floorPct: ((level ?? params.profitLockStartInr) / entryPrice) * 100, kind: 'lock' };
  }
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

/** Within `eventBlockMinutes` before or after a scheduled announcement (`scheduledEvents`, IST). */
export function nearScheduledEvent(now: Date, params: StrategyParams): boolean {
  return params.scheduledEvents.some((event) => {
    const at = Date.parse(`${event.replace(' ', 'T')}:00+05:30`);
    return Number.isFinite(at) && Math.abs(now.getTime() - at) < params.eventBlockMinutes * 60_000;
  });
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
  if (nearScheduledEvent(input.now, params)) {
    common.push('scheduled-event');
  }

  const evaluated = [...input.readings]
    .sort((left, right) => Math.abs(right.score) - Math.abs(left.score))
    .map((reading) => {
      const side = entrySide(reading, params);
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
  // In pullback mode the market leans the way the 15-minute trend points.
  const leans =
    strongest.side !== null &&
    (usesPullback(strongest.reading, params) ||
      Math.abs(strongest.reading.score) >= LEANING_MIN_SCORE);
  const leaning =
    leans && strongest.side
      ? { index: strongest.reading.index, side: strongest.side, score: strongest.reading.score }
      : null;
  return { action: 'SKIP', blockedBy: strongest.gates, leaning, reading: strongest.reading };
}

/**
 * Open position, checked in order: stale position, end-of-day square-off; once the ratcheting ₹
 * profit lock has armed, only that lock; otherwise the chart stop on the index (or the fixed
 * index move without one), the ₹ take-profit, the profit floor (₹ profit lock, break-even lock,
 * stepped trailing stop, tighter at a big level on cycle checks), time stop; then (cycle only,
 * after the minimum hold) trend reversal (the 15-minute trend in pullback mode, the votes
 * otherwise) and major news while losing. The stop on the option price is not here: it is the
 * stop-loss order in `checkStopOrder`.
 */
export function checkPositionExit(
  input: {
    now: Date;
    position: OpenPosition;
    price: number | null;
    /** Current spot of the position's index. */
    spot?: number | null;
    /**
     * Last traded price. The ratcheting profit lock triggers on it, like a GTT order, so a bid a
     * few paise under a step just reached does not sell at once; `price` (the bid) otherwise.
     */
    lastPrice?: number | null;
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
  // On a range-bound day a setup's trade takes the smaller target: it sells there on the index.
  const targetSpot = position.targetSpot ?? null;
  const indexNow = input.spot ?? null;
  if (
    targetSpot !== null &&
    indexNow !== null &&
    (position.side === 'CE' ? indexNow >= targetSpot : indexNow <= targetSpot)
  ) {
    return { action: 'EXIT', reason: 'target-reached' };
  }
  // Once the ratcheting profit lock has armed, only it (and the square-off above) can sell.
  if (params.profitStepInr > 0) {
    const level = profitLockLevelInr(
      position.entryPrice,
      Math.max(position.peakPrice, price ?? 0),
      params,
    );
    if (level !== null) {
      const trigger = input.lastPrice ?? price;
      return trigger !== null && trigger < position.entryPrice + level - ROUNDING_SLACK
        ? { action: 'EXIT', reason: 'profit-lock' }
        : { action: 'HOLD' };
    }
  }
  const pnlPct = pctChange(position.entryPrice, price);
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
  if (
    params.takeProfitInr > 0 &&
    price + ROUNDING_SLACK >= position.entryPrice + params.takeProfitInr
  ) {
    return { action: 'EXIT', reason: 'target-reached' };
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
    // A pullback is bought while the price votes still point the other way, so only the
    // 15-minute trend turning against the trade counts as a reversal in pullback mode.
    const reversed =
      params.entryMode === 'pullback'
        ? reading.chart?.higherTrend === (direction > 0 ? 'down' : 'up')
        : (reading.votes.averagePrice === -direction && reading.votes.trend === -direction) ||
          reading.score * direction <= -params.reversalScore;
    if (reversed) {
      return { action: 'EXIT', reason: 'trend-reversal' };
    }
    if (reading.newsLevel === 'high' && pnlPct < 0) {
      return { action: 'EXIT', reason: 'news-risk' };
    }
  }
  return { action: 'HOLD' };
}

/**
 * The option price that triggers the trade's stop-loss order: the planned stop until the option
 * has been `profitLockInr` above its buy price, then the profit lock (with the defaults: the buy
 * price, then ₹5 higher for every further ₹5 gain). It only ever moves up.
 */
export function stopTriggerPrice(position: OpenPosition, params: StrategyParams): number {
  const planned = position.premiumStop ?? position.entryPrice * (1 - params.stopLossPct / 100);
  const level =
    params.profitStepInr > 0
      ? profitLockLevelInr(position.entryPrice, position.peakPrice, params)
      : null;
  return level === null ? planned : Math.max(planned, position.entryPrice + level);
}

/**
 * The stop-loss limit order that rests in the market from the moment the BUY fills until the
 * trade is sold, checked every 15 seconds and before each full review. A stale position and the
 * square-off come first. The order triggers when the option trades at or under its stop and
 * sells with a limit `stopLimitGapInr` below it.
 *
 * The sale is priced at the first trade at or under the stop, not at the stop itself: one tick
 * under it when a candle traded down through it, the candle's open when it opened below it, or
 * the last traded price when only the quote shows it. A sell gets the bid, so the gap between
 * the last trade and the bid comes off. A price under the limit leaves the order unfilled; once
 * it has waited `stopRepriceSeconds` (`reprice`), it is sold at the bid.
 */
export function checkStopOrder(
  input: {
    now: Date;
    position: OpenPosition;
    /** The option's 1-minute candles that began since the last check, oldest first. */
    bars: readonly IntradayBar[];
    lastPrice: number | null;
    bid: number | null;
    reprice: boolean;
  },
  params: StrategyParams,
): StopOrderCheck {
  const { now, position, lastPrice, bid } = input;
  const clock = istClock(now);
  if (istClock(position.enteredAt).ymd < clock.ymd) {
    return { action: 'EXIT', reason: 'stale-position' };
  }
  if (clock.minute >= params.squareOffMinute) {
    return { action: 'EXIT', reason: 'square-off' };
  }
  const trigger = stopTriggerPrice(position, params);
  const crossed = input.bars.find((bar) => bar.l <= trigger + ROUNDING_SLACK);
  const quoteCrossed = lastPrice !== null && lastPrice <= trigger + ROUNDING_SLACK;
  if (!crossed && !quoteCrossed) {
    return { action: 'HOLD' };
  }
  const firstTrade = crossed ? Math.min(crossed.o, trigger - TICK) : lastPrice!;
  const spread = lastPrice !== null && bid !== null ? Math.max(lastPrice - bid, 0) : 0;
  const price = Math.floor((firstTrade - spread) / TICK + ROUNDING_SLACK) * TICK;
  if (price >= trigger - params.stopLimitGapInr - ROUNDING_SLACK) {
    return { action: 'SOLD', price: Number(price.toFixed(2)) };
  }
  return input.reprice && bid !== null ? { action: 'SOLD', price: bid } : { action: 'UNFILLED' };
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
