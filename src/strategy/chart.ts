import type { IntradayBar } from '../universe/types.js';
import { istClock, type IstClock } from './clock.js';
import {
  classifyLastCandles,
  ema,
  median,
  openingRange,
  type CandlePatternName,
  type OptionSide,
} from './indicators.js';
import type { ChartParams } from './params.js';

/**
 * Chart reading of completed 5-minute futures bars, after Zerodha Varsity's checklist: a
 * confirming candle, support and resistance from the chart, above-usual volume, the trend's
 * structure and a stop at the setup's low with room to the next level. Distances are in ATRs
 * (the size of a normal 5-minute swing); levels are returned in spot terms.
 */

/** Fewest completed bars a reading needs (the ATR plus a little history). */
export const MIN_CHART_BARS = 15;
const BAR_MS = 5 * 60_000;
const SESSION_OPEN_MINUTE = 9 * 60 + 15;
/** Bars before the signal candle that count as "the last hour". */
const LAST_HOUR_BARS = 12;
/** A last-hour high or low needs at least this many of today's bars. */
const MIN_LAST_HOUR_BARS = 6;
/** Candles given to the pattern classifier: the pattern plus the move before it. */
const PATTERN_BARS = 8;
/** The bigger-picture average must have moved over this many of its bars. */
const TREND_SLOPE_BARS = 3;

export type Structure = 'up' | 'down' | 'unclear';
export type HigherTrend = 'up' | 'down' | 'flat';

export type LevelKind =
  | 'swing-high'
  | 'swing-low'
  | 'previous-high'
  | 'previous-low'
  | 'previous-close'
  | 'day-high'
  | 'day-low'
  | 'opening-high'
  | 'opening-low'
  | 'hour-high'
  | 'hour-low'
  | 'call-wall'
  | 'put-wall'
  | 'projection';

/** A price level in spot terms. */
export type ChartLevel = { price: number; kind: LevelKind };

/** A confirmed swing high or low: futures price and the start time of its bar. */
export type SwingPoint = { t: string; price: number };

export type SignalCandle = {
  pattern: CandlePatternName;
  /** Side the pattern favours once its context is read. */
  side: OptionSide | null;
  /** Side the candle confirms: direction, a strong close, size, volume and follow-through. */
  confirms: OptionSide | null;
  /** Where the close sits in the candle's range: 0 at the low, 1 at the high. */
  closeLocation: number;
  rangeAtr: number;
  /** Volume against the usual volume for this time of day; null with nothing to compare. */
  volumeRatio: number | null;
};

/** Stop, target and room for one side, in spot terms. */
export type ChartPlan = {
  side: OptionSide;
  entrySpot: number;
  stopSpot: number;
  riskPoints: number;
  targetSpot: number;
  targetKind: LevelKind;
  rewardPoints: number;
  rewardToRisk: number;
  /** A chart level just ahead of the price (inside the level buffer), not yet broken. */
  nearLevel: ChartLevel | null;
};

export type ChartRead = {
  /** Size of a normal 5-minute swing, in index points. */
  atr: number;
  structure: Structure;
  higherTrend: HigherTrend | null;
  /** Net move of the last few candles in ATRs of the bars before them (positive: up). */
  burstAtr: number | null;
  candle: SignalCandle;
  /** Nearest chart levels below and above the price. */
  support: ChartLevel | null;
  resistance: ChartLevel | null;
  plans: Record<OptionSide, ChartPlan>;
  /** Futures minus spot; a futures level minus this is the same level in spot terms. */
  basis: number;
  /** Confirmed swings of today and the previous session (futures terms, oldest first). */
  swings: { highs: SwingPoint[]; lows: SwingPoint[] };
};

type Ohlc = { o: number; h: number; l: number; c: number };

function rangeOf(bar: Ohlc): number {
  return bar.h - bar.l;
}

function clockOf(bar: { t: string }): IstClock {
  return istClock(new Date(bar.t));
}

/**
 * Wilder's average true range. The first bar of each IST session uses its own high − low, so an
 * overnight gap does not count as a swing.
 */
export function averageTrueRange(bars: readonly IntradayBar[], period: number): number | null {
  if (period < 1 || bars.length < period) {
    return null;
  }
  const days = bars.map((bar) => clockOf(bar).ymd);
  const ranges = bars.map((bar, index) => {
    const prior = bars[index - 1];
    if (!prior || days[index - 1] !== days[index]) {
      return rangeOf(bar);
    }
    return Math.max(rangeOf(bar), Math.abs(bar.h - prior.c), Math.abs(bar.l - prior.c));
  });
  let atr = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  for (const range of ranges.slice(period)) {
    atr = (atr * (period - 1) + range) / period;
  }
  return atr;
}

/**
 * Swing highs (lows): a high above the `strength` bars before it and not exceeded by the
 * `strength` bars after it, so the last `strength` bars cannot be swings yet.
 */
export function swingPoints(
  bars: readonly IntradayBar[],
  strength: number,
): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let index = strength; index < bars.length - strength; index += 1) {
    const bar = bars[index]!;
    let high = true;
    let low = true;
    for (let step = 1; step <= strength; step += 1) {
      const before = bars[index - step]!;
      const after = bars[index + step]!;
      high &&= bar.h > before.h && bar.h >= after.h;
      low &&= bar.l < before.l && bar.l <= after.l;
    }
    if (high) {
      highs.push({ t: bar.t, price: bar.h });
    }
    if (low) {
      lows.push({ t: bar.t, price: bar.l });
    }
  }
  return { highs, lows };
}

/** Dow theory: rising highs and rising lows is an uptrend, falling both a downtrend. */
export function structureOf(swings: { highs: SwingPoint[]; lows: SwingPoint[] }): Structure {
  const [olderHigh, newerHigh] = swings.highs.slice(-2);
  const [olderLow, newerLow] = swings.lows.slice(-2);
  if (!olderHigh || !newerHigh || !olderLow || !newerLow) {
    return 'unclear';
  }
  if (newerHigh.price > olderHigh.price && newerLow.price > olderLow.price) {
    return 'up';
  }
  if (newerHigh.price < olderHigh.price && newerLow.price < olderLow.price) {
    return 'down';
  }
  return 'unclear';
}

/** 5-minute bars grouped into `minutes`-long bars counted from 09:15 IST each day. */
export function groupBars(bars: readonly IntradayBar[], minutes: number): Ohlc[] {
  const groups: Array<Ohlc & { key: string }> = [];
  for (const bar of bars) {
    const clock = clockOf(bar);
    const key = `${clock.ymd}:${Math.floor((clock.minute - SESSION_OPEN_MINUTE) / minutes)}`;
    const current = groups.at(-1);
    if (current?.key === key) {
      current.h = Math.max(current.h, bar.h);
      current.l = Math.min(current.l, bar.l);
      current.c = bar.c;
    } else {
      groups.push({ key, o: bar.o, h: bar.h, l: bar.l, c: bar.c });
    }
  }
  return groups;
}

/** Price above a rising average is up, below a falling one down; null without enough bars. */
export function higherTrendOf(closes: readonly number[], period: number): HigherTrend | null {
  if (closes.length < period + TREND_SLOPE_BARS) {
    return null;
  }
  const average = ema(closes, period)!;
  const earlier = ema(closes.slice(0, -TREND_SLOPE_BARS), period)!;
  const last = closes.at(-1)!;
  if (last > average && average > earlier) {
    return 'up';
  }
  if (last < average && average < earlier) {
    return 'down';
  }
  return 'flat';
}

/** Volume of the last bar against the median of the same 5-minute slot on earlier days. */
function volumeRatioOf(
  bars: readonly IntradayBar[],
  clocks: readonly IstClock[],
  today: string,
): number | null {
  const last = bars.at(-1)!;
  const slot = clocks.at(-1)!.minute;
  const sameSlot = bars
    .filter((bar, index) => clocks[index]!.ymd < today && clocks[index]!.minute === slot)
    .map((bar) => bar.v)
    .filter((volume) => volume > 0);
  let usual = sameSlot.length >= 2 ? median(sameSlot) : null;
  if (usual === null) {
    const earlierToday = bars
      .filter((bar, index) => clocks[index]!.ymd === today)
      .slice(0, -1)
      .map((bar) => bar.v)
      .filter((volume) => volume > 0);
    usual = median(earlierToday);
  }
  return usual !== null && usual > 0 ? last.v / usual : null;
}

function signalCandle(
  bars: readonly IntradayBar[],
  todayBars: readonly IntradayBar[],
  clocks: readonly IstClock[],
  today: string,
  atr: number,
  params: ChartParams,
): SignalCandle {
  const last = bars.at(-1)!;
  const prior = bars.at(-2) ?? null;
  const pattern = classifyLastCandles(todayBars.slice(-PATTERN_BARS), { atr });
  const range = rangeOf(last);
  const closeLocation = range > 0 ? (last.c - last.l) / range : 0.5;
  const rangeAtr = range / atr;
  const volumeRatio = volumeRatioOf(bars, clocks, today);
  const solid =
    rangeAtr >= params.minSignalRangeAtr &&
    (volumeRatio === null || volumeRatio >= params.minSignalVolumeRatio);
  let confirms: OptionSide | null = null;
  if (solid && last.c > last.o && closeLocation >= params.confirmCloseLocation) {
    confirms = !prior || last.c > prior.h || pattern.side === 'CE' ? 'CE' : null;
  } else if (solid && last.c < last.o && 1 - closeLocation >= params.confirmCloseLocation) {
    confirms = !prior || last.c < prior.l || pattern.side === 'PE' ? 'PE' : null;
  }
  return { ...pattern, confirms, closeLocation, rangeAtr, volumeRatio };
}

/**
 * Levels from the bars before the signal candle (so a breakout candle is not its own
 * resistance), moved into spot terms, plus the two option walls.
 */
function chartLevels(input: {
  bars: readonly IntradayBar[];
  clocks: readonly IstClock[];
  today: string;
  swings: { highs: SwingPoint[]; lows: SwingPoint[] };
  basis: number;
  callWall: number | null;
  putWall: number | null;
}): ChartLevel[] {
  const { bars, clocks, today, basis } = input;
  const levels: ChartLevel[] = [];
  const add = (price: number | undefined, kind: LevelKind) => {
    if (price !== undefined && Number.isFinite(price)) {
      levels.push({ price: price - basis, kind });
    }
  };
  for (const swing of input.swings.highs) {
    add(swing.price, 'swing-high');
  }
  for (const swing of input.swings.lows) {
    add(swing.price, 'swing-low');
  }
  const previousDay = clocks
    .map((clock) => clock.ymd)
    .filter((ymd) => ymd < today)
    .at(-1);
  if (previousDay) {
    const previous = bars.filter((_, index) => clocks[index]!.ymd === previousDay);
    add(Math.max(...previous.map((bar) => bar.h)), 'previous-high');
    add(Math.min(...previous.map((bar) => bar.l)), 'previous-low');
    add(previous.at(-1)?.c, 'previous-close');
  }
  const todayBars = bars.filter((_, index) => clocks[index]!.ymd === today);
  const beforeSignal = todayBars.slice(0, -1);
  if (beforeSignal.length > 0) {
    add(Math.max(...beforeSignal.map((bar) => bar.h)), 'day-high');
    add(Math.min(...beforeSignal.map((bar) => bar.l)), 'day-low');
  }
  const opening = openingRange(todayBars);
  if (opening) {
    add(opening.high, 'opening-high');
    add(opening.low, 'opening-low');
  }
  const lastHour = beforeSignal.slice(-LAST_HOUR_BARS);
  if (lastHour.length >= MIN_LAST_HOUR_BARS) {
    add(Math.max(...lastHour.map((bar) => bar.h)), 'hour-high');
    add(Math.min(...lastHour.map((bar) => bar.l)), 'hour-low');
  }
  if (input.callWall !== null) {
    levels.push({ price: input.callWall, kind: 'call-wall' });
  }
  if (input.putWall !== null) {
    levels.push({ price: input.putWall, kind: 'put-wall' });
  }
  return levels;
}

function isWall(level: ChartLevel): boolean {
  return level.kind === 'call-wall' || level.kind === 'put-wall';
}

/**
 * Stop under the low of the last two candles (calls; above their high for puts) plus a buffer,
 * never closer than `minStopAtr`; target at the nearest level ahead outside the level buffer.
 */
function sidePlan(input: {
  side: OptionSide;
  spot: number;
  atr: number;
  basis: number;
  setup: readonly IntradayBar[];
  levels: readonly ChartLevel[];
  params: ChartParams;
}): ChartPlan {
  const { side, spot, atr, basis, params } = input;
  const up = side === 'CE';
  const buffer = params.stopBufferAtr * atr;
  const minDistance = params.minStopAtr * atr;
  const structural = up
    ? Math.min(...input.setup.map((bar) => bar.l)) - buffer - basis
    : Math.max(...input.setup.map((bar) => bar.h)) + buffer - basis;
  const stopSpot = up
    ? Math.min(structural, spot - minDistance)
    : Math.max(structural, spot + minDistance);
  const riskPoints = Math.abs(spot - stopSpot);
  const ownWall = up ? 'call-wall' : 'put-wall';
  const ahead = input.levels
    .filter((level) => (up ? level.price > spot : level.price < spot))
    .filter((level) => !isWall(level) || level.kind === ownWall)
    .sort((left, right) => Math.abs(left.price - spot) - Math.abs(right.price - spot));
  const near = params.levelBufferAtr * atr;
  const nearLevel =
    ahead.find((level) => !isWall(level) && Math.abs(level.price - spot) <= near) ?? null;
  const target = ahead.find((level) => Math.abs(level.price - spot) > near) ?? {
    price: spot + (up ? 1 : -1) * params.targetFallbackAtr * atr,
    kind: 'projection' as const,
  };
  const rewardPoints = Math.abs(target.price - spot);
  return {
    side,
    entrySpot: spot,
    stopSpot,
    riskPoints,
    targetSpot: target.price,
    targetKind: target.kind,
    rewardPoints,
    rewardToRisk: riskPoints > 0 ? rewardPoints / riskPoints : 0,
    nearLevel,
  };
}

/**
 * Reads the chart of one index from its completed 5-minute futures bars (oldest first). Null
 * when the spot, the futures price, `MIN_CHART_BARS` bars or two of today's bars are missing.
 */
export function readChart(
  input: {
    bars: readonly IntradayBar[];
    todayYmd: string;
    spot: number | null;
    futuresPrice: number | null;
    callWall: number | null;
    putWall: number | null;
  },
  params: ChartParams,
): ChartRead | null {
  const { bars, spot, futuresPrice, todayYmd: today } = input;
  if (spot === null || futuresPrice === null || bars.length < MIN_CHART_BARS) {
    return null;
  }
  const clocks = bars.map(clockOf);
  const todayBars = bars.filter((_, index) => clocks[index]!.ymd === today);
  const atr = averageTrueRange(bars, params.atrPeriod);
  if (todayBars.length < 2 || clocks.at(-1)!.ymd !== today || atr === null || !(atr > 0)) {
    return null;
  }
  const basis = futuresPrice - spot;
  const sessions = [...new Set(clocks.map((clock) => clock.ymd))];
  const fromDay = sessions.at(-2) ?? today;
  const recent = bars.filter((_, index) => clocks[index]!.ymd >= fromDay);
  const swings = swingPoints(recent, params.swingBars);
  const baseline = averageTrueRange(bars.slice(0, -params.burstBars), params.atrPeriod);
  const burstFrom = bars.at(-1 - params.burstBars);
  const burstAtr =
    baseline !== null && baseline > 0 && burstFrom
      ? (bars.at(-1)!.c - burstFrom.c) / baseline
      : null;
  const levels = chartLevels({
    bars,
    clocks,
    today,
    swings,
    basis,
    callWall: input.callWall,
    putWall: input.putWall,
  });
  const chartOnly = levels.filter((level) => !isWall(level));
  const nearest = (below: boolean) =>
    chartOnly
      .filter((level) => (below ? level.price < spot : level.price > spot))
      .sort((left, right) => Math.abs(left.price - spot) - Math.abs(right.price - spot))[0] ?? null;
  const setup = bars.slice(-2);
  const plan = (side: OptionSide) => sidePlan({ side, spot, atr, basis, setup, levels, params });
  return {
    atr,
    structure: structureOf(swings),
    higherTrend: higherTrendOf(
      groupBars(bars, params.trendMinutes).map((bar) => bar.c),
      params.trendEmaPeriod,
    ),
    burstAtr,
    candle: signalCandle(bars, todayBars, clocks, today, atr, params),
    support: nearest(true),
    resistance: nearest(false),
    plans: { CE: plan('CE'), PE: plan('PE') },
    basis,
    swings,
  };
}

/**
 * Stop at the newest swing (a low for calls, a high for puts) whose bar ended after `since`,
 * plus the buffer, in spot terms; null when no such swing has formed yet.
 */
export function trailStopSpot(
  chart: ChartRead,
  side: OptionSide,
  since: Date,
  params: ChartParams,
): number | null {
  const swings = side === 'CE' ? chart.swings.lows : chart.swings.highs;
  const newest = swings.filter((swing) => Date.parse(swing.t) + BAR_MS > since.getTime()).at(-1);
  if (!newest) {
    return null;
  }
  const buffer = params.stopBufferAtr * chart.atr;
  return side === 'CE' ? newest.price - buffer - chart.basis : newest.price + buffer - chart.basis;
}
