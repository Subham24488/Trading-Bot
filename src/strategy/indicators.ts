import { istClock } from './clock.js';

export type OptionSide = 'CE' | 'PE';

type Ohlc = { o: number; h: number; l: number; c: number };
type TimedBar = Ohlc & { t: string };

const SESSION_OPEN_MINUTE = 9 * 60 + 15;

export function pctChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || !(from > 0) || !Number.isFinite(to)) {
    return null;
  }
  return ((to - from) / from) * 100;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Exponential moving average of the whole series; null until `period` values exist. */
export function ema(values: readonly number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }
  const weight = 2 / (period + 1);
  let average = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) {
    average = value * weight + average * (1 - weight);
  }
  return average;
}

/** Wilder's relative strength index (0–100). */
export function rsi(closes: readonly number[], period = 14): number | null {
  if (closes.length < period + 1) {
    return null;
  }
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index]! - closes[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }
  return 100 - 100 / (1 + averageGain / averageLoss);
}

/** Drops the bar that is still forming (its start + length is after `now`). */
export function completedBars<T extends { t: string }>(
  bars: readonly T[],
  barMinutes: number,
  now: Date,
): T[] {
  const lastCompleteStart = now.getTime() - barMinutes * 60_000;
  return bars.filter((bar) => Date.parse(bar.t) <= lastCompleteStart);
}

export function barsOnDay<T extends { t: string }>(bars: readonly T[], ymd: string): T[] {
  return bars.filter((bar) => istClock(new Date(bar.t)).ymd === ymd);
}

/** High/low of the first `rangeMinutes` after 09:15; null until those bars are complete. */
export function openingRange(
  todayBars: readonly TimedBar[],
  barMinutes = 5,
  rangeMinutes = 15,
): { high: number; low: number } | null {
  const rangeEnd = SESSION_OPEN_MINUTE + rangeMinutes;
  const opening = todayBars.filter((bar) => istClock(new Date(bar.t)).minute < rangeEnd);
  if (opening.length < rangeMinutes / barMinutes) {
    return null;
  }
  return {
    high: Math.max(...opening.map((bar) => bar.h)),
    low: Math.min(...opening.map((bar) => bar.l)),
  };
}

export type CandlePatternName =
  | 'bullish_engulfing'
  | 'bearish_engulfing'
  | 'morning_star'
  | 'evening_star'
  | 'piercing'
  | 'dark_cloud'
  | 'hammer'
  | 'hanging_man'
  | 'shooting_star'
  | 'inverted_hammer'
  | 'doji'
  | 'inside_bar'
  | 'bull_marubozu'
  | 'bear_marubozu'
  | 'three_bar_push_up'
  | 'three_bar_push_down'
  | 'none';

const BULLISH_PATTERNS: CandlePatternName[] = [
  'bullish_engulfing',
  'morning_star',
  'piercing',
  'hammer',
  'bull_marubozu',
  'three_bar_push_up',
];
const BEARISH_PATTERNS: CandlePatternName[] = [
  'bearish_engulfing',
  'evening_star',
  'dark_cloud',
  'shooting_star',
  'bear_marubozu',
  'three_bar_push_down',
];

/** A last candle smaller than this share of a normal 5-minute swing (ATR) is noise, not a pattern. */
const MIN_PATTERN_RANGE_ATR = 0.3;
/** Body at most this share of the range: a doji (indecision). */
const DOJI_BODY_SHARE = 0.1;
/** The first candle of a star or the candle pierced must be at least this solid. */
const STRONG_BODY_SHARE = 0.5;
/** The middle candle of a star is at most this share of the first candle's body. */
const STAR_BODY_SHARE = 0.3;
/** Candles before a pattern read for the move it follows (hammer vs hanging man). */
const CONTEXT_BARS = 3;

function body(bar: Ohlc): number {
  return Math.abs(bar.c - bar.o);
}

function rangeOf(bar: Ohlc): number {
  return Math.max(bar.h - bar.l, 1e-9);
}

function bodyMid(bar: Ohlc): number {
  return (bar.o + bar.c) / 2;
}

/** Net move of up to three candles just before the last `patternLength`; null with fewer than 2. */
function moveBefore(bars: readonly Ohlc[], patternLength: number): number | null {
  const end = bars.length - patternLength;
  const start = Math.max(0, end - CONTEXT_BARS);
  if (end - start < 2) {
    return null;
  }
  return bars[end - 1]!.c - bars[start]!.o;
}

/**
 * Pattern formed by the last one to three candles and the side it favours. Hammers and shooting
 * stars count only after the move they reverse (a hammer after a rise is a hanging man), and a
 * last candle under 0.3 ATR is too small to mean anything when `atr` is given.
 */
export function classifyLastCandles(
  bars: readonly Ohlc[],
  options: { atr?: number | null } = {},
): {
  pattern: CandlePatternName;
  side: OptionSide | null;
} {
  const pattern = lastCandlePattern(bars, options.atr ?? null);
  const side = BULLISH_PATTERNS.includes(pattern)
    ? 'CE'
    : BEARISH_PATTERNS.includes(pattern)
      ? 'PE'
      : null;
  return { pattern, side };
}

function lastCandlePattern(bars: readonly Ohlc[], atr: number | null): CandlePatternName {
  const last = bars.at(-1);
  if (!last) {
    return 'none';
  }
  if (atr !== null && atr > 0 && last.h - last.l < MIN_PATTERN_RANGE_ATR * atr) {
    return 'none';
  }
  const prior = bars.length >= 2 ? bars.at(-2)! : null;
  const first = bars.length >= 3 ? bars.at(-3)! : null;
  const lastBull = last.c > last.o;
  const lastBear = last.c < last.o;
  const lastBody = body(last);
  const lastRange = rangeOf(last);
  const upper = last.h - Math.max(last.o, last.c);
  const lower = Math.min(last.o, last.c) - last.l;

  if (prior) {
    const priorBull = prior.c > prior.o;
    const priorBear = prior.c < prior.o;
    // The three-candle stars first: their last candle often also engulfs the small middle one.
    if (first && body(first) >= STRONG_BODY_SHARE * rangeOf(first)) {
      const smallStar = body(prior) <= STAR_BODY_SHARE * body(first);
      if (smallStar && first.c < first.o && lastBull && last.c > bodyMid(first)) {
        return 'morning_star';
      }
      if (smallStar && first.c > first.o && lastBear && last.c < bodyMid(first)) {
        return 'evening_star';
      }
    }
    if (
      lastBull &&
      priorBear &&
      last.o <= prior.c &&
      last.c >= prior.o &&
      lastBody > body(prior) * 0.9
    ) {
      return 'bullish_engulfing';
    }
    if (
      lastBear &&
      priorBull &&
      last.o >= prior.c &&
      last.c <= prior.o &&
      lastBody > body(prior) * 0.9
    ) {
      return 'bearish_engulfing';
    }
    const solidPrior = body(prior) >= STRONG_BODY_SHARE * rangeOf(prior);
    if (
      solidPrior &&
      priorBear &&
      lastBull &&
      last.o <= prior.c &&
      last.c > bodyMid(prior) &&
      last.c < prior.o
    ) {
      return 'piercing';
    }
    if (
      solidPrior &&
      priorBull &&
      lastBear &&
      last.o >= prior.c &&
      last.c < bodyMid(prior) &&
      last.c > prior.o
    ) {
      return 'dark_cloud';
    }
  }
  if (lastBody <= DOJI_BODY_SHARE * lastRange) {
    return 'doji';
  }
  const before = moveBefore(bars, 1);
  if (lower >= lastBody * 2 && upper <= lastBody * 0.5 && before !== null && before !== 0) {
    return before < 0 ? 'hammer' : 'hanging_man';
  }
  if (upper >= lastBody * 2 && lower <= lastBody * 0.5 && before !== null && before !== 0) {
    return before > 0 ? 'shooting_star' : 'inverted_hammer';
  }
  if (lastBody / lastRange >= 0.7) {
    return lastBull ? 'bull_marubozu' : 'bear_marubozu';
  }
  if (prior && last.h <= prior.h && last.l >= prior.l) {
    return 'inside_bar';
  }
  if (first && prior) {
    if (last.c > prior.c && prior.c > first.c && lastBull) {
      return 'three_bar_push_up';
    }
    if (last.c < prior.c && prior.c < first.c && lastBear) {
      return 'three_bar_push_down';
    }
  }
  return 'none';
}
