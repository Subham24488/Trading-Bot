import type { IntradayBar } from '../universe/types.js';
import { averageTrueRange, fifteenMinuteCandles, groupBars, type ChartRead } from './chart.js';
import { istClock } from './clock.js';
import { barsOnDay, ema, median, openingRange, type OptionSide } from './indicators.js';
import type { ChartParams, StrategyParams, TrendDayParams } from './params.js';

/**
 * Trend days. On a day the index runs one way, waiting for a pullback to VWAP misses the move:
 * in the 42-session backtest of 2026-11-18 the pullback rule alone caught 1 of 44 rallies of
 * 0.5% in 90 minutes. A day is flagged a trend day between 09:45 and 10:30 when all 3 checks
 * agree on a side, and stays one for the rest of the day. Trades in its direction may then
 * also buy a breakout through the opening-range, yesterday's or the last hour's high (lows for
 * puts) without waiting for a pullback or a confirming candle, and a shallow dip (to the
 * 9-candle average, or a higher low that holds) is pullback enough.
 */
export type TrendDay = {
  side: OptionSide;
  /** Minute after midnight IST when the day was flagged. */
  flaggedAtMinute: number;
  /** The checks that agreed, in everyday words. */
  reasons: string[];
};

/** What lets a trend-day trade enter without a pullback. */
export type EntryTrigger = {
  kind: 'breakout';
  /** The level it broke, in futures prices. */
  level: number;
  /** The level's name, for example "yesterday's high". */
  name: string;
  /** What happened, in everyday words. */
  reason: string;
};

/** On a trend day: whether a trade in its direction has a trigger to enter on now. */
export type TrendDayEntry = {
  side: OptionSide;
  trigger: EntryTrigger | null;
  /** A shallow dip that is pullback enough on a trend day ("dipped to its 9-candle average"). */
  shallowPullback: string | null;
};

const SESSION_OPEN_MINUTE = 9 * 60 + 15;
/** The short average of a shallow pullback, in 5-minute candles. */
const SHORT_AVERAGE_BARS = 9;
/** The opening-range check needs the last this many closes beyond the range. */
const OPENING_RANGE_HELD_BARS = 2;
/** The last hour's high or low: the 12 candles before the last one, at least 6 of them. */
const LAST_HOUR_BARS = 12;
const LAST_HOUR_MIN_BARS = 6;
const FIFTEEN_MINUTES = 15;

const wholeNumber = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** 15-minute candles made from 5-minute ones, without the one still forming at `now`. */
export function completedFifteenMinuteCandles(
  bars: readonly IntradayBar[],
  now: Date,
): ReturnType<typeof groupBars> {
  const candles = groupBars(bars, FIFTEEN_MINUTES);
  const last = bars.at(-1);
  if (last) {
    const minute = istClock(new Date(last.t)).minute;
    const start = Date.parse(last.t) - ((minute - SESSION_OPEN_MINUTE) % FIFTEEN_MINUTES) * 60_000;
    if (start + FIFTEEN_MINUTES * 60_000 > now.getTime()) {
      candles.pop();
    }
  }
  return candles;
}

/**
 * How strongly the price is trending (Wilder's ADX), with the upward and downward pressure
 * (+DI and −DI) that say which way. Null with too few candles.
 */
export function trendStrength(
  bars: readonly { h: number; l: number; c: number }[],
  period = 14,
): { strength: number; upward: number; downward: number } | null {
  if (bars.length < 2 * period + 1) {
    return null;
  }
  let range = 0;
  let up = 0;
  let down = 0;
  const swings: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const prior = bars[i - 1]!;
    const rise = bar.h - prior.h;
    const fall = prior.l - bar.l;
    const upMove = rise > fall && rise > 0 ? rise : 0;
    const downMove = fall > rise && fall > 0 ? fall : 0;
    const trueRange = Math.max(bar.h - bar.l, Math.abs(bar.h - prior.c), Math.abs(bar.l - prior.c));
    if (i <= period) {
      range += trueRange;
      up += upMove;
      down += downMove;
      if (i < period) {
        continue;
      }
    } else {
      range = range - range / period + trueRange;
      up = up - up / period + upMove;
      down = down - down / period + downMove;
    }
    const upward = range > 0 ? (100 * up) / range : 0;
    const downward = range > 0 ? (100 * down) / range : 0;
    swings.push(
      upward + downward > 0 ? (100 * Math.abs(upward - downward)) / (upward + downward) : 0,
    );
    if (i === bars.length - 1) {
      if (swings.length < period) {
        return null;
      }
      let strength = swings.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
      for (const value of swings.slice(period)) {
        strength = (strength * (period - 1) + value) / period;
      }
      return { strength, upward, downward };
    }
  }
  return null;
}

/**
 * Flags a trend day when all three agree on a side, between `checkFromMinute` and
 * `checkUntilMinute`:
 * - the opening range broke and held: the last 2 closes are beyond it;
 * - the price stays on one side of today's average price (VWAP): the last `vwapSideBars` closes;
 * - the 15-minute trend is strong: ADX(14) of the completed 15-minute candles is
 *   `trendStrengthMin` or more, rising for calls and falling for puts.
 * Null when it is not a trend day (yet).
 */
export function checkTrendDay(
  input: {
    now: Date;
    /** Completed 5-minute futures bars over several days, oldest first. */
    bars: readonly IntradayBar[];
  },
  params: TrendDayParams,
): TrendDay | null {
  const clock = istClock(input.now);
  if (clock.minute < params.checkFromMinute || clock.minute > params.checkUntilMinute) {
    return null;
  }
  const today = barsOnDay(input.bars, clock.ymd);
  if (today.length < Math.max(6, params.vwapSideBars)) {
    return null;
  }
  const up: string[] = [];
  const down: string[] = [];

  const range = openingRange(today);
  const held = today.slice(-OPENING_RANGE_HELD_BARS);
  if (range && held.length === OPENING_RANGE_HELD_BARS) {
    if (held.every((bar) => bar.c > range.high)) {
      up.push('it broke above the first-15-minute range and held for 2 candles');
    }
    if (held.every((bar) => bar.c < range.low)) {
      down.push('it broke below the first-15-minute range and held for 2 candles');
    }
  }

  const vwaps = averagePriceByCandle(today);
  const recent = today.slice(-params.vwapSideBars);
  const recentVwaps = vwaps.slice(-params.vwapSideBars);
  if (recent.every((bar, i) => bar.c > recentVwaps[i]!)) {
    up.push(`its last ${params.vwapSideBars} closes are above today's average price`);
  }
  if (recent.every((bar, i) => bar.c < recentVwaps[i]!)) {
    down.push(`its last ${params.vwapSideBars} closes are below today's average price`);
  }

  const strength = trendStrength(completedFifteenMinuteCandles(input.bars, input.now));
  if (strength && strength.strength >= params.trendStrengthMin) {
    (strength.upward > strength.downward ? up : down).push(
      `the 15-minute trend is strong (${strength.strength.toFixed(0)} on a 0–100 trend-strength scale)`,
    );
  }

  if (up.length === 3) {
    return { side: 'CE', flaggedAtMinute: clock.minute, reasons: up };
  }
  if (down.length === 3) {
    return { side: 'PE', flaggedAtMinute: clock.minute, reasons: down };
  }
  return null;
}

/** Today's average price (VWAP) at the close of each of today's candles. */
function averagePriceByCandle(today: readonly IntradayBar[]): number[] {
  let volume = 0;
  let value = 0;
  return today.map((bar) => {
    volume += bar.v;
    value += ((bar.h + bar.l + bar.c) / 3) * bar.v;
    return volume > 0 ? value / volume : bar.c;
  });
}

/**
 * A range-bound day, from `rangeFromMinute`: the 15-minute 20-candle average is flat (it moved
 * less than `flatAverageAtr` of a normal 15-minute swing over its last `flatAverageCandles`
 * candles) and today's 15-minute closes crossed today's average price at least
 * `rangeVwapCrossings` times. Returns the reason in words, or null on other days.
 */
export function checkRangeDay(
  input: {
    now: Date;
    /** Completed 5-minute futures bars over several days, oldest first. */
    bars: readonly IntradayBar[];
    trendEmaPeriod: number;
  },
  params: TrendDayParams,
): string | null {
  const clock = istClock(input.now);
  if (clock.minute < params.rangeFromMinute) {
    return null;
  }
  const fifteen = fifteenMinuteCandles(input.bars);
  const atr = averageTrueRange(fifteen, 14);
  const closes = fifteen.map((bar) => bar.c);
  const average = ema(closes, input.trendEmaPeriod);
  const earlier = ema(closes.slice(0, -params.flatAverageCandles), input.trendEmaPeriod);
  if (atr === null || !(atr > 0) || average === null || earlier === null) {
    return null;
  }
  const flat = Math.abs(average - earlier) < params.flatAverageAtr * atr;
  // Today's average price at each 15-minute close: the 5-minute VWAP at the candle's last bar.
  const today = barsOnDay(input.bars, clock.ymd);
  const vwaps = averagePriceByCandle(today);
  const fifteenToday = fifteen.filter((bar) => istClock(new Date(bar.t)).ymd === clock.ymd);
  const sides = fifteenToday.map((candle) => {
    const end = Date.parse(candle.t) + FIFTEEN_MINUTES * 60_000;
    const index = today.findLastIndex((bar) => Date.parse(bar.t) < end);
    return index < 0 ? 0 : Math.sign(candle.c - vwaps[index]!);
  });
  let crossings = 0;
  for (let i = 1; i < sides.length; i += 1) {
    if (sides[i] !== 0 && sides[i - 1] !== 0 && sides[i] !== sides[i - 1]) {
      crossings += 1;
    }
  }
  return flat && crossings >= params.rangeVwapCrossings
    ? `the 15-minute average is flat and NIFTY crossed today's average price ${crossings} times`
    : null;
}

/**
 * Breakout: from `breakoutFromMinute`, the last 5-minute candle closed through the opening-range
 * high, yesterday's high or the last hour's high (the lows for puts), from the candle before at
 * or under it, on at least `breakoutVolumeMultiple` × the day's median volume. The furthest level
 * crossed counts. Null without one.
 */
function findBreakout(
  input: {
    minute: number;
    side: OptionSide;
    /** Completed 5-minute futures bars over several days and today's alone. */
    bars: readonly IntradayBar[];
    today: readonly IntradayBar[];
    indexName: string;
  },
  params: TrendDayParams,
): EntryTrigger | null {
  const { today, side } = input;
  const last = today.at(-1);
  const prior = today.at(-2);
  if (!last || !prior || input.minute < params.breakoutFromMinute) {
    return null;
  }
  const up = side === 'CE';
  const levels: Array<{ level: number; name: string }> = [];
  const range = openingRange(today);
  if (range) {
    levels.push(
      up
        ? { level: range.high, name: 'the first-15-minute high' }
        : { level: range.low, name: 'the first-15-minute low' },
    );
  }
  const todayYmd = istClock(new Date(last.t)).ymd;
  const earlierDays = [...new Set(input.bars.map((bar) => istClock(new Date(bar.t)).ymd))].filter(
    (ymd) => ymd < todayYmd,
  );
  const yesterday = earlierDays.length > 0 ? barsOnDay(input.bars, earlierDays.at(-1)!) : [];
  if (yesterday.length > 0) {
    levels.push(
      up
        ? { level: Math.max(...yesterday.map((bar) => bar.h)), name: "yesterday's high" }
        : { level: Math.min(...yesterday.map((bar) => bar.l)), name: "yesterday's low" },
    );
  }
  const hour = today.slice(-(LAST_HOUR_BARS + 1), -1);
  if (hour.length >= LAST_HOUR_MIN_BARS) {
    levels.push(
      up
        ? { level: Math.max(...hour.map((bar) => bar.h)), name: "the last hour's high" }
        : { level: Math.min(...hour.map((bar) => bar.l)), name: "the last hour's low" },
    );
  }
  const usual = median(today.map((bar) => bar.v)) ?? 0;
  const crossed = levels.filter(({ level }) =>
    up ? prior.c <= level && last.c > level : prior.c >= level && last.c < level,
  );
  if (crossed.length === 0 || usual <= 0 || last.v < params.breakoutVolumeMultiple * usual) {
    return null;
  }
  const furthest = crossed.sort((a, b) => (up ? b.level - a.level : a.level - b.level))[0]!;
  return {
    kind: 'breakout',
    level: furthest.level,
    name: furthest.name,
    reason:
      `${input.indexName} futures closed ${up ? 'above' : 'below'} ${furthest.name} ` +
      `(${wholeNumber.format(furthest.level)}) on ${(last.v / usual).toFixed(1)}× the day's usual volume`,
  };
}

/**
 * Shallow pullback: the futures price is within `maxValueGapAtr` of its 9-candle average, or the
 * last two swing lows rise and the price holds above the newer one by no more than 1 normal
 * swing (puts: falling swing highs, the price under the newer one). Null without one.
 */
function shallowPullbackOf(input: {
  side: OptionSide;
  bars: readonly IntradayBar[];
  futuresPrice: number;
  chart: ChartRead;
  maxValueGapAtr: number;
}): string | null {
  const { chart, futuresPrice } = input;
  const up = input.side === 'CE';
  const shortAverage = ema(
    input.bars.map((bar) => bar.c),
    SHORT_AVERAGE_BARS,
  );
  if (
    shortAverage !== null &&
    Math.abs(futuresPrice - shortAverage) / chart.atr <= input.maxValueGapAtr
  ) {
    return `dipped to its ${SHORT_AVERAGE_BARS}-candle average`;
  }
  const [older, newer] = (up ? chart.swings.lows : chart.swings.highs).slice(-2);
  if (!older || !newer) {
    return null;
  }
  const holds = up
    ? newer.price > older.price &&
      futuresPrice > newer.price &&
      futuresPrice - newer.price <= chart.atr
    : newer.price < older.price &&
      futuresPrice < newer.price &&
      newer.price - futuresPrice <= chart.atr;
  return holds
    ? `held a ${up ? 'higher low' : 'lower high'} at ${wholeNumber.format(newer.price)} on the futures`
    : null;
}

/** On a trend day: the trigger a trade in its direction can enter on now; null on other days. */
export function trendDayEntryOf(
  input: {
    now: Date;
    indexName: string;
    trendDay: TrendDay | null;
    /** Completed 5-minute futures bars over several days, oldest first. */
    bars: readonly IntradayBar[];
    chart: ChartRead | null;
    futuresPrice: number | null;
  },
  params: StrategyParams,
): TrendDayEntry | null {
  if (!input.trendDay) {
    return null;
  }
  const clock = istClock(input.now);
  const side = input.trendDay.side;
  const today = barsOnDay(input.bars, clock.ymd);
  const entry: TrendDayEntry = { side, trigger: null, shallowPullback: null };
  const last = today.at(-1);
  if (input.chart && input.chart.atr > 0 && last && today.length >= 2) {
    entry.trigger = findBreakout(
      { minute: clock.minute, side, bars: input.bars, today, indexName: input.indexName },
      params.trendDay,
    );
    if (input.futuresPrice !== null) {
      entry.shallowPullback = shallowPullbackOf({
        side,
        bars: input.bars,
        futuresPrice: input.futuresPrice,
        chart: input.chart,
        maxValueGapAtr: params.chart.maxValueGapAtr,
      });
    }
  }
  return entry;
}

/**
 * A trade on a trend-day trigger puts its index stop just beyond the level it broke
 * (`stopBufferAtr` past it, in spot prices), when that is still on the safe side of the price.
 */
export function stopBeyondBrokenLevel(
  chart: ChartRead | null,
  entry: TrendDayEntry | null,
  spot: number | null,
  params: ChartParams,
): ChartRead | null {
  const trigger = entry?.trigger;
  if (!chart || !entry || !trigger || spot === null) {
    return chart;
  }
  const buffer = params.stopBufferAtr * chart.atr;
  const stopSpot =
    entry.side === 'CE'
      ? trigger.level - chart.basis - buffer
      : trigger.level - chart.basis + buffer;
  if (entry.side === 'CE' ? stopSpot >= spot : stopSpot <= spot) {
    return chart;
  }
  return {
    ...chart,
    plans: {
      ...chart.plans,
      [entry.side]: {
        ...chart.plans[entry.side],
        stopSpot,
        riskPoints: Math.abs(spot - stopSpot),
        stopBeyondBrokenLevel: true,
      },
    },
  };
}
