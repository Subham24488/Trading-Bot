import type { DailyBar, IntradayBar } from '../universe/types.js';
import { fifteenMinuteCandles, type ChartRead } from './chart.js';
import { istClock } from './clock.js';
import {
  barsOnDay,
  classifyLastCandles,
  openingRange,
  rsi,
  type CandlePatternName,
  type OptionSide,
} from './indicators.js';
import type { StrategyParams } from './params.js';

/**
 * The chart setups added on 2026-11-19, read from NIFTY futures candles:
 * - flag breakout (15-minute signal): a strong move, a short tight pause, a close out of it;
 * - opening-range retest (5-minute): a break of the first 15 minutes' range, a pullback to it
 *   and a turn back;
 * - double bottom or top at a level (15-minute): two lows (highs) at yesterday's low, the
 *   biggest put-OI strike or the week's low, then a close through the high between them;
 * - failed breakout (15-minute): a break of yesterday's high that closes back under it.
 * Each returns the side, the index stop and target (spot prices) and the reason in words.
 * A setup counts at the check right after its entry candle closes, and only once.
 */
export type SetupKind =
  | 'flag'
  | 'opening-range-retest'
  | 'double-bottom'
  | 'double-top'
  | 'failed-breakout';

export type SetupSignal = {
  kind: SetupKind;
  side: OptionSide;
  /** Where the trade is wrong, on the index (spot prices). */
  stopSpot: number;
  /** The level the stop sits beyond, in words, for example "the flag's low". */
  stopName: string;
  /** The setup's target on the index (spot prices); null when none lies ahead. */
  targetSpot: number | null;
  /** What happened, in everyday words. */
  reason: string;
};

type Level = { name: string; price: number };

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const PATTERN_CANDLES = 8;
const VOLUME_CANDLES = 20;

const CALL_CANDLES = {
  flag: ['bull_marubozu', 'bullish_engulfing'],
  retest: ['hammer', 'bullish_engulfing'],
  reversal: ['bullish_engulfing', 'hammer', 'morning_star'],
  trap: ['hammer', 'bullish_engulfing'],
} satisfies Record<string, CandlePatternName[]>;
const PUT_CANDLES = {
  flag: ['bear_marubozu', 'bearish_engulfing'],
  retest: ['shooting_star', 'bearish_engulfing'],
  reversal: ['bearish_engulfing', 'shooting_star', 'evening_star'],
  trap: ['shooting_star', 'bearish_engulfing', 'dark_cloud'],
} satisfies Record<string, CandlePatternName[]>;

const wholeNumber = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const endOf = (bar: IntradayBar, ms: number) => Date.parse(bar.t) + ms;
const minuteOf = (bar: IntradayBar) => istClock(new Date(bar.t)).minute;

export type SetupInput = {
  now: Date;
  indexName: string;
  /** Completed 5-minute futures bars over several days, oldest first. */
  bars: readonly IntradayBar[];
  chart: ChartRead;
  spot: number;
  callWall: number | null;
  putWall: number | null;
  /** The index's daily bars before today (spot prices), for the week's high and low. */
  dailyBars: readonly DailyBar[];
};

/** The first setup that gives a signal at this check, in the order above; null without one. */
export function findSetup(input: SetupInput, params: StrategyParams): SetupSignal | null {
  const day = dayOf(input);
  if (!day) {
    return null;
  }
  for (const side of ['CE', 'PE'] as const) {
    const signal =
      flagBreakout(day, side, params) ??
      openingRangeRetest(day, side, params) ??
      doubleBottomOrTop(day, side, params) ??
      failedBreakout(day, side, params);
    if (signal) {
      return signal;
    }
  }
  return null;
}

/** Today's candles and levels, in futures prices. */
type Day = {
  input: SetupInput;
  minute: number;
  basis: number;
  fives: readonly IntradayBar[];
  /** Today's finished 15-minute candles. */
  fifteens: readonly IntradayBar[];
  /** Finished 15-minute candles over several days (today's are the same objects). */
  allFifteens: readonly IntradayBar[];
  fiveAtr: number;
  fifteenAtr: number;
  yesterday: { high: number; low: number } | null;
  week: { high: number; low: number } | null;
  /** The levels a candle must trade at to count, in futures prices. */
  levels: Level[];
  vwaps: number[];
  latest: IntradayBar;
};

function dayOf(input: SetupInput): Day | null {
  const clock = istClock(input.now);
  const fives = barsOnDay(input.bars, clock.ymd);
  const latest = fives.at(-1);
  const fifteenAtr = input.chart.fifteenMinuteAtr;
  if (!latest || fifteenAtr === null || !(fifteenAtr > 0)) {
    return null;
  }
  const allFifteens = fifteenMinuteCandles(input.bars);
  const fifteens = allFifteens.filter((bar) => istClock(new Date(bar.t)).ymd === clock.ymd);
  const basis = input.chart.basis;
  const earlier = input.bars.filter((bar) => istClock(new Date(bar.t)).ymd < clock.ymd);
  const previousYmd = earlier.length ? istClock(new Date(earlier.at(-1)!.t)).ymd : null;
  const previous = earlier.filter((bar) => istClock(new Date(bar.t)).ymd === previousYmd);
  const yesterday = previous.length
    ? { high: Math.max(...previous.map((bar) => bar.h)), low: Math.min(...previous.map((bar) => bar.l)) }
    : null;
  const lastWeek = input.dailyBars.filter((bar) => bar.d < clock.ymd).slice(-5);
  const week = lastWeek.length
    ? {
        high: Math.max(...lastWeek.map((bar) => bar.h)) + basis,
        low: Math.min(...lastWeek.map((bar) => bar.l)) + basis,
      }
    : null;
  const vwaps = averagePriceByCandle(fives);
  const opening = openingRange(fives);
  const strike = (value: number) => wholeNumber.format(value);
  const levels: Level[] = [
    { name: "today's average price", price: vwaps.at(-1)! },
    ...(input.chart.trendAverage !== null
      ? [{ name: 'the 15-minute 20-candle average', price: input.chart.trendAverage }]
      : []),
    ...(yesterday
      ? [
          { name: "yesterday's high", price: yesterday.high },
          { name: "yesterday's low", price: yesterday.low },
        ]
      : []),
    ...(input.callWall !== null
      ? [{ name: `the ${strike(input.callWall)} call strike`, price: input.callWall + basis }]
      : []),
    ...(input.putWall !== null
      ? [{ name: `the ${strike(input.putWall)} put strike`, price: input.putWall + basis }]
      : []),
    ...(opening
      ? [
          { name: "the opening range's high", price: opening.high },
          { name: "the opening range's low", price: opening.low },
        ]
      : []),
  ];
  return {
    input,
    minute: clock.minute,
    basis,
    fives,
    fifteens,
    allFifteens,
    fiveAtr: input.chart.atr,
    fifteenAtr,
    yesterday,
    week,
    levels,
    vwaps,
    latest,
  };
}

/** Today's average price (VWAP) at the close of each candle. */
function averagePriceByCandle(bars: readonly IntradayBar[]): number[] {
  let volume = 0;
  let value = 0;
  return bars.map((bar) => {
    volume += bar.v;
    value += ((bar.h + bar.l + bar.c) / 3) * bar.v;
    return volume > 0 ? value / volume : bar.c;
  });
}

/** The pattern of `candles[index]`, read with the candles before it. */
function patternAt(candles: readonly IntradayBar[], index: number, atr: number): CandlePatternName {
  return classifyLastCandles(candles.slice(Math.max(0, index - PATTERN_CANDLES + 1), index + 1), {
    atr,
  }).pattern;
}

/**
 * The candle rules for a signal candle: one of `names`, closing in its top 40% for a call
 * (bottom 40% for a put), at least half a normal swing tall, and trading at one of `levels`.
 * Returns the level's name, or null when the candle does not count.
 */
function candleCounts(
  candles: readonly IntradayBar[],
  index: number,
  side: OptionSide,
  names: readonly CandlePatternName[],
  atr: number,
  levels: readonly Level[],
  params: StrategyParams,
): { pattern: CandlePatternName; level: string } | null {
  const candle = candles[index];
  if (!candle) {
    return null;
  }
  const pattern = patternAt(candles, index, atr);
  const range = candle.h - candle.l;
  if (!names.includes(pattern) || range < params.chart.minSignalRangeAtr * atr || !(range > 0)) {
    return null;
  }
  const closeLocation = (candle.c - candle.l) / range;
  const strong =
    side === 'CE'
      ? closeLocation >= params.chart.confirmCloseLocation
      : 1 - closeLocation >= params.chart.confirmCloseLocation;
  const near = params.chart.levelTouchAtr * atr;
  const level = levels.find((item) => candle.l - near <= item.price && item.price <= candle.h + near);
  return strong && level ? { pattern, level: level.name } : null;
}

/** Average volume of the `VOLUME_CANDLES` candles before `index` in `candles`. */
function usualVolume(candles: readonly IntradayBar[], index: number): number {
  const window = candles.slice(Math.max(0, index - VOLUME_CANDLES), index);
  return window.length ? window.reduce((sum, bar) => sum + bar.v, 0) / window.length : 0;
}

/** The latest 15-minute candle closed with the latest 5-minute bar (this check is right after it). */
function justClosed(day: Day): IntradayBar | null {
  const last = day.fifteens.at(-1);
  return last && endOf(last, FIFTEEN_MINUTES_MS) === endOf(day.latest, FIVE_MINUTES_MS) ? last : null;
}

/** The latest 5-minute bar closed through `level` and the one before it had not. */
function fiveMinuteBreak(day: Day, level: number, up: boolean): boolean {
  const prior = day.fives.at(-2);
  const closedThrough = up ? day.latest.c > level : day.latest.c < level;
  const priorThrough = prior ? (up ? prior.c > level : prior.c < level) : false;
  return closedThrough && !priorThrough;
}

const toSpot = (day: Day, futuresPrice: number) => futuresPrice - day.basis;

/**
 * 1. Flag breakout: a pole of at least `flagPoleAtr` 15-minute swings in up to
 * `flagPoleMaxCandles` candles, then 3–8 candles drifting against it in a tight range that
 * gives back at most half the pole. The signal: a 15-minute bullish marubozu or engulfing
 * closing above the flag on 1.5× its 20-candle volume, or earlier a 5-minute bullish marubozu
 * breaking the flag's high. Skipped right under yesterday's high or the biggest call-OI strike.
 */
function flagBreakout(day: Day, side: OptionSide, params: StrategyParams): SetupSignal | null {
  const p = params.setups;
  if (day.minute < p.flagFromMinute || day.minute > p.flagUntilMinute) {
    return null;
  }
  const up = side === 'CE';
  const dir = up ? 1 : -1;
  const closed = justClosed(day);
  // The flag ends at the last finished 15-minute candle, or the one before when the signal is
  // that candle's own close.
  const last = day.fifteens.length - 1 - (closed ? 1 : 0);
  for (let flagLength = p.flagMinCandles; flagLength <= p.flagMaxCandles; flagLength += 1) {
    for (let poleLength = 1; poleLength <= p.flagPoleMaxCandles; poleLength += 1) {
      const poleEnd = last - flagLength;
      const poleStart = poleEnd - poleLength + 1;
      if (poleStart < 0) {
        continue;
      }
      const pole = day.fifteens.slice(poleStart, poleEnd + 1);
      const flag = day.fifteens.slice(poleEnd + 1, last + 1);
      const poleHigh = Math.max(...pole.map((bar) => bar.h));
      const poleLow = Math.min(...pole.map((bar) => bar.l));
      const height = poleHigh - poleLow;
      if (height < p.flagPoleAtr * day.fifteenAtr || (pole.at(-1)!.c - pole[0]!.o) * dir <= 0) {
        continue;
      }
      const flagHigh = Math.max(...flag.map((bar) => bar.h));
      const flagLow = Math.min(...flag.map((bar) => bar.l));
      const edge = up ? flagHigh : flagLow;
      const tight = flagHigh - flagLow <= 0.5 * height;
      const noNewExtreme = up
        ? flagHigh <= poleHigh + 0.1 * day.fifteenAtr
        : flagLow >= poleLow - 0.1 * day.fifteenAtr;
      const halfKept = up ? flagLow >= poleHigh - 0.5 * height : flagHigh <= poleLow + 0.5 * height;
      const drifts = (flag.at(-1)!.c - flag[0]!.o) * dir <= 0.1 * day.fifteenAtr;
      if (!tight || !noNewExtreme || !halfKept || !drifts) {
        continue;
      }
      const blocker = up
        ? [day.yesterday?.high, day.input.callWall === null ? undefined : day.input.callWall + day.basis]
        : [day.yesterday?.low, day.input.putWall === null ? undefined : day.input.putWall + day.basis];
      if (
        blocker.some(
          (level) =>
            level !== undefined &&
            (level - edge) * dir >= 0 &&
            Math.abs(level - edge) <= p.flagClearanceAtr * day.fifteenAtr,
        )
      ) {
        continue;
      }
      const names = up ? CALL_CANDLES.flag : PUT_CANDLES.flag;
      let counted: { pattern: CandlePatternName; level: string } | null = null;
      let timeframe = '';
      if (closed && (closed.c - edge) * dir > 0) {
        const index = day.allFifteens.indexOf(closed);
        counted =
          closed.v >= p.flagVolumeMultiple * usualVolume(day.allFifteens, index)
            ? candleCounts(day.allFifteens, index, side, names, day.fifteenAtr, day.levels, params)
            : null;
        timeframe = '15-minute';
      }
      if (!counted && fiveMinuteBreak(day, edge, up)) {
        const all = day.input.bars;
        const index = all.length - 1;
        const marubozu: CandlePatternName[] = up ? ['bull_marubozu'] : ['bear_marubozu'];
        counted =
          day.latest.v >= p.flagVolumeMultiple * usualVolume(all, index)
            ? candleCounts(all, index, side, marubozu, day.fiveAtr, day.levels, params)
            : null;
        timeframe = '5-minute';
      }
      if (!counted) {
        continue;
      }
      return {
        kind: 'flag',
        side,
        stopSpot: toSpot(day, up ? flagLow : flagHigh),
        stopName: `the flag's ${up ? 'low' : 'high'}`,
        targetSpot: toSpot(day, edge + dir * height),
        reason:
          `${day.input.indexName} futures ${up ? 'rose' : 'fell'} ${wholeNumber.format(height)} points in ` +
          `${poleLength} 15-minute candle${poleLength > 1 ? 's' : ''}, paused for ${flagLength}, ` +
          `then a ${timeframe} ${patternWords(counted.pattern)} closed ${up ? 'above' : 'below'} the pause (${wholeNumber.format(edge)})`,
      };
    }
  }
  return null;
}

/**
 * 2. Opening-range retest: the price breaks out of the first 15-minute candle's range (no wider
 * than `retestMaxRangeAtr` 15-minute swings), pulls back to its edge, and a 5-minute hammer or
 * bullish engulfing turns up there; once that candle's 15-minute candle has closed back above
 * the range, the trade buys on the first 5-minute close above the turning candle's high.
 * The stop is under the retest low or the middle of the range, whichever is further.
 */
function openingRangeRetest(day: Day, side: OptionSide, params: StrategyParams): SetupSignal | null {
  const p = params.setups;
  if (day.minute < p.retestFromMinute || day.minute > p.retestUntilMinute) {
    return null;
  }
  const range = openingRange(day.fives);
  if (!range || range.high - range.low > p.retestMaxRangeAtr * day.fifteenAtr) {
    return null;
  }
  const up = side === 'CE';
  const dir = up ? 1 : -1;
  const edge = up ? range.high : range.low;
  const middle = (range.high + range.low) / 2;
  const fives = day.fives;
  const breakIndex = fives.findIndex(
    (bar) => minuteOf(bar) >= 9 * 60 + 30 && (bar.c - edge) * dir > 0,
  );
  if (breakIndex < 0) {
    return null;
  }
  // A 15-minute close back through the middle of the range after the break ends the setup.
  const breakAt = Date.parse(fives[breakIndex]!.t);
  if (day.fifteens.some((bar) => Date.parse(bar.t) >= breakAt && (bar.c - middle) * dir < 0)) {
    return null;
  }
  const names = up ? CALL_CANDLES.retest : PUT_CANDLES.retest;
  const near = params.chart.levelTouchAtr * day.fiveAtr;
  for (let k = breakIndex + 1; k < fives.length - 1; k += 1) {
    const candle = fives[k]!;
    const atEdge = up ? candle.l <= edge + near && candle.c > edge : candle.h >= edge - near && candle.c < edge;
    if (!atEdge) {
      continue;
    }
    const index = day.input.bars.indexOf(candle);
    const counted = candleCounts(day.input.bars, index, side, names, day.fiveAtr, day.levels, params);
    if (!counted) {
      continue;
    }
    // Its 15-minute candle must have closed back beyond the range before the entry.
    const quarter = day.fifteens.find(
      (bar) => Date.parse(bar.t) <= Date.parse(candle.t) && endOf(candle, FIVE_MINUTES_MS) <= endOf(bar, FIFTEEN_MINUTES_MS),
    );
    if (
      !quarter ||
      (quarter.c - edge) * dir <= 0 ||
      endOf(quarter, FIFTEEN_MINUTES_MS) > Date.parse(day.latest.t)
    ) {
      continue;
    }
    // The entry: the first 5-minute candle after that 15-minute close to close beyond the
    // turning candle's high (low for puts), at this check.
    const trigger = up ? candle.h : candle.l;
    const entryBar = fives.find(
      (bar) =>
        Date.parse(bar.t) >= endOf(quarter, FIFTEEN_MINUTES_MS) && (bar.c - trigger) * dir > 0,
    );
    if (entryBar !== day.latest) {
      continue;
    }
    const between = fives.slice(breakIndex, k + 1);
    const retestLow = up ? Math.min(...between.map((bar) => bar.l)) : Math.max(...between.map((bar) => bar.h));
    const entry = day.latest.c;
    const stop = up ? Math.min(retestLow, middle) : Math.max(retestLow, middle);
    const round = up ? Math.floor(entry / 100) * 100 + 100 : Math.ceil(entry / 100) * 100 - 100;
    const ahead = [
      up ? day.yesterday?.high : day.yesterday?.low,
      up ? day.week?.high : day.week?.low,
      round,
      up
        ? day.input.callWall === null ? undefined : day.input.callWall + day.basis
        : day.input.putWall === null ? undefined : day.input.putWall + day.basis,
    ].filter((level): level is number => level !== undefined && (level - entry) * dir > 0.25 * day.fiveAtr);
    const target = ahead.length ? (up ? Math.min(...ahead) : Math.max(...ahead)) : null;
    return {
      kind: 'opening-range-retest',
      side,
      stopSpot: toSpot(day, stop),
      stopName: stop === middle ? "the middle of the opening range" : 'the retest low',
      targetSpot: target === null ? null : toSpot(day, target),
      reason:
        `${day.input.indexName} futures broke ${up ? 'above' : 'below'} the opening range (${wholeNumber.format(edge)}), came back to it, ` +
        `and a 5-minute ${patternWords(counted.pattern)} turned ${up ? 'up' : 'down'} there`,
    };
  }
  return null;
}

/**
 * 3. Double bottom (top for puts) at a level: two 15-minute lows within
 * `doubleBottomTolerancePct`, at least `doubleBottomMinGap` candles apart, at yesterday's low,
 * the biggest put-OI strike or the week's low; a bullish engulfing, hammer or morning star at
 * the second low. The trade buys on a 15-minute close above the high between the two lows, or
 * earlier when a 5-minute candle closes above the signal candle's high.
 */
function doubleBottomOrTop(day: Day, side: OptionSide, params: StrategyParams): SetupSignal | null {
  const p = params.setups;
  if (day.minute < p.reversalFromMinute) {
    return null;
  }
  const up = side === 'CE';
  const dir = up ? 1 : -1;
  const candles = day.fifteens;
  const low = (bar: IntradayBar) => (up ? bar.l : bar.h);
  const closed = justClosed(day);
  const lastSignal = candles.length - 1;
  const levels: Level[] = up
    ? [
        ...(day.yesterday ? [{ name: "yesterday's low", price: day.yesterday.low }] : []),
        ...(day.input.putWall !== null
          ? [{ name: `the ${wholeNumber.format(day.input.putWall)} put strike`, price: day.input.putWall + day.basis }]
          : []),
        ...(day.week ? [{ name: "the week's low", price: day.week.low }] : []),
      ]
    : [
        ...(day.yesterday ? [{ name: "yesterday's high", price: day.yesterday.high }] : []),
        ...(day.input.callWall !== null
          ? [{ name: `the ${wholeNumber.format(day.input.callWall)} call strike`, price: day.input.callWall + day.basis }]
          : []),
        ...(day.week ? [{ name: "the week's high", price: day.week.high }] : []),
      ];
  for (let second = p.doubleBottomMinGap; second <= lastSignal; second += 1) {
    for (let first = 0; first <= second - p.doubleBottomMinGap; first += 1) {
      const a = candles[first]!;
      const b = candles[second]!;
      if (Math.abs(low(a) - low(b)) > (p.doubleBottomTolerancePct / 100) * low(a)) {
        continue;
      }
      const neighbours = candles.slice(Math.max(0, first - 2), first).concat(candles.slice(first + 1, first + 3));
      const isSwing = neighbours.length > 0 && neighbours.every((bar) => (low(bar) - low(a)) * dir > 0);
      const bottom = up ? Math.min(low(a), low(b)) : Math.max(low(a), low(b));
      const between = candles.slice(first + 1, second);
      if (!isSwing || between.some((bar) => (low(bar) - bottom) * dir < 0)) {
        continue;
      }
      const level = levels.find((item) => Math.abs(item.price - bottom) <= (p.doubleBottomTolerancePct / 100) * bottom);
      if (!level) {
        continue;
      }
      const names = up ? CALL_CANDLES.reversal : PUT_CANDLES.reversal;
      const signalIndex = [second, second + 1].find(
        (index) =>
          index <= lastSignal &&
          candleCounts(day.allFifteens, day.allFifteens.indexOf(candles[index]!), side, names, day.fifteenAtr, [level, ...day.levels], params),
      );
      if (signalIndex === undefined) {
        continue;
      }
      const signal = candles[signalIndex]!;
      const neckline = up
        ? Math.max(...candles.slice(first, second + 1).map((bar) => bar.h))
        : Math.min(...candles.slice(first, second + 1).map((bar) => bar.l));
      const after = candles.slice(signalIndex + 1);
      if (after.some((bar) => (bar.c - low(b)) * dir < 0)) {
        continue; // closed beyond the second low: the pattern failed
      }
      // The first 15-minute close through the neckline, or before it a 5-minute close through
      // the signal candle.
      const throughNeck = after.filter((bar) => (bar.c - neckline) * dir > 0);
      const neckBreak = closed !== null && throughNeck.length === 1 && throughNeck[0] === closed;
      const earlyBreak =
        throughNeck.length === 0 &&
        Date.parse(day.latest.t) >= endOf(signal, FIFTEEN_MINUTES_MS) &&
        fiveMinuteBreak(day, up ? signal.h : signal.l, up);
      if (!neckBreak && !earlyBreak) {
        continue;
      }
      const closesAll = day.allFifteens.map((bar) => bar.c);
      const rsiAt = (bar: IntradayBar) => rsi(closesAll.slice(0, day.allFifteens.indexOf(bar) + 1));
      const rsiA = rsiAt(a);
      const rsiB = rsiAt(b);
      const divergence = rsiA !== null && rsiB !== null && (rsiB - rsiA) * dir > 0;
      const pattern = patternAt(day.allFifteens, day.allFifteens.indexOf(signal), day.fifteenAtr);
      return {
        kind: up ? 'double-bottom' : 'double-top',
        side,
        stopSpot: toSpot(day, low(b)),
        stopName: `the second ${up ? 'low' : 'high'}`,
        targetSpot: toSpot(day, neckline + (neckline - bottom)),
        reason:
          `${day.input.indexName} futures made a double ${up ? 'bottom' : 'top'} at ${level.name} ` +
          `(${wholeNumber.format(bottom)}), a 15-minute ${patternWords(pattern)} turned it ${up ? 'up' : 'down'}` +
          `${divergence ? ' with momentum stronger than at the first ' + (up ? 'low' : 'high') : ''}, ` +
          (neckBreak
            ? `and it closed ${up ? 'above' : 'below'} the ${wholeNumber.format(neckline)} ${up ? 'high' : 'low'} between them`
            : `and a 5-minute candle closed ${up ? 'above' : 'below'} that candle`),
      };
    }
  }
  return null;
}

/**
 * 7. Failed breakout (a trap): the price breaks above yesterday's high, then a 15-minute shooting
 * star, bearish engulfing or dark cloud closes back below it; a put is bought when a 5-minute
 * candle closes below that candle's low. The stop sits above the failed breakout's high; the
 * target is today's average price, or the middle of the day's range. Calls mirror this at
 * yesterday's low with a hammer or bullish engulfing.
 */
function failedBreakout(day: Day, side: OptionSide, params: StrategyParams): SetupSignal | null {
  const p = params.setups;
  if (!day.yesterday || day.minute < p.reversalFromMinute) {
    return null;
  }
  const up = side === 'CE';
  const level = up ? day.yesterday.low : day.yesterday.high;
  const candles = day.fifteens;
  const breakIndex = candles.findIndex((bar) => (up ? bar.l < level : bar.h > level));
  if (breakIndex < 0) {
    return null;
  }
  // Only the first 15-minute candle back inside yesterday's range counts.
  const backIndex = candles.findIndex((bar, index) => index >= breakIndex && (up ? bar.c > level : bar.c < level));
  if (backIndex < 0) {
    return null;
  }
  const trap = candles[backIndex]!;
  const names = up ? CALL_CANDLES.trap : PUT_CANDLES.trap;
  const levelName = up ? "yesterday's low" : "yesterday's high";
  const counted = candleCounts(
    day.allFifteens,
    day.allFifteens.indexOf(trap),
    side,
    names,
    day.fifteenAtr,
    [{ name: levelName, price: level }, ...day.levels],
    params,
  );
  if (!counted || Date.parse(day.latest.t) < endOf(trap, FIFTEEN_MINUTES_MS)) {
    return null;
  }
  const extreme = up
    ? Math.min(...candles.slice(breakIndex, backIndex + 1).map((bar) => bar.l))
    : Math.max(...candles.slice(breakIndex, backIndex + 1).map((bar) => bar.h));
  // Not once the price has closed back beyond the failed breakout's extreme.
  const since = day.fives.filter((bar) => Date.parse(bar.t) >= endOf(trap, FIFTEEN_MINUTES_MS));
  if (since.some((bar) => (up ? bar.c < extreme : bar.c > extreme))) {
    return null;
  }
  if (!fiveMinuteBreak(day, up ? trap.h : trap.l, up)) {
    return null;
  }
  const entry = day.latest.c;
  const vwap = day.vwaps.at(-1)!;
  const dayHigh = Math.max(...day.fives.map((bar) => bar.h));
  const dayLow = Math.min(...day.fives.map((bar) => bar.l));
  const target = (up ? vwap > entry : vwap < entry) ? vwap : (dayHigh + dayLow) / 2;
  return {
    kind: 'failed-breakout',
    side,
    stopSpot: toSpot(day, extreme),
    stopName: `the failed breakout's ${up ? 'low' : 'high'}`,
    targetSpot: (target - entry) * (up ? 1 : -1) > 0 ? toSpot(day, target) : null,
    reason:
      `${day.input.indexName} futures broke ${up ? 'below' : 'above'} ${levelName} (${wholeNumber.format(level)}) and a 15-minute ` +
      `${patternWords(counted.pattern)} closed back ${up ? 'above' : 'below'} it, then a 5-minute candle closed ${up ? 'above' : 'below'} that candle`,
  };
}

const PATTERN_WORDS: Partial<Record<CandlePatternName, string>> = {
  bullish_engulfing: 'bullish engulfing candle',
  bearish_engulfing: 'bearish engulfing candle',
  hammer: 'hammer',
  shooting_star: 'shooting star',
  morning_star: 'morning star',
  evening_star: 'evening star',
  piercing: 'piercing line',
  dark_cloud: 'dark cloud cover',
  bull_marubozu: 'bullish marubozu (a solid up candle)',
  bear_marubozu: 'bearish marubozu (a solid down candle)',
};

function patternWords(pattern: CandlePatternName): string {
  return PATTERN_WORDS[pattern] ?? 'strong candle';
}

/**
 * A setup's stop sits on the index at its own level (for example the flag's low), when that is
 * still on the safe side of the price; the plan's risk is measured from there.
 */
export function withSetupStop(
  chart: ChartRead | null,
  setup: SetupSignal | null,
  spot: number | null,
): ChartRead | null {
  if (!chart || !setup || spot === null) {
    return chart;
  }
  const safe = setup.side === 'CE' ? setup.stopSpot < spot : setup.stopSpot > spot;
  if (!safe) {
    return chart;
  }
  const plan = chart.plans[setup.side];
  return {
    ...chart,
    plans: {
      ...chart.plans,
      [setup.side]: {
        ...plan,
        stopSpot: setup.stopSpot,
        riskPoints: Math.abs(spot - setup.stopSpot),
        stopBeyondBrokenLevel: true,
      },
    },
  };
}

