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
  | 'hammer'
  | 'shooting_star'
  | 'inside_bar'
  | 'bull_marubozu'
  | 'bear_marubozu'
  | 'three_bar_push_up'
  | 'three_bar_push_down'
  | 'none';

const BULLISH_PATTERNS: CandlePatternName[] = [
  'bullish_engulfing',
  'hammer',
  'bull_marubozu',
  'three_bar_push_up',
];
const BEARISH_PATTERNS: CandlePatternName[] = [
  'bearish_engulfing',
  'shooting_star',
  'bear_marubozu',
  'three_bar_push_down',
];

function body(bar: Ohlc): number {
  return Math.abs(bar.c - bar.o);
}

/** Pattern formed by the last one to three bars and the side it favours. */
export function classifyLastCandles(bars: readonly Ohlc[]): {
  pattern: CandlePatternName;
  side: OptionSide | null;
} {
  if (bars.length === 0) {
    return { pattern: 'none', side: null };
  }
  const last3 = bars.slice(-3);
  const last = last3.at(-1)!;
  const prior = last3.length >= 2 ? last3.at(-2)! : null;
  const first = last3.length >= 3 ? last3.at(-3)! : null;
  const lastBull = last.c > last.o;
  const lastBear = last.c < last.o;
  const lastBody = body(last);
  const lastRange = Math.max(last.h - last.l, 1e-9);
  const upper = last.h - Math.max(last.o, last.c);
  const lower = Math.min(last.o, last.c) - last.l;

  let pattern: CandlePatternName = 'none';
  if (prior) {
    const priorBull = prior.c > prior.o;
    const priorBear = prior.c < prior.o;
    if (
      lastBull &&
      priorBear &&
      last.o <= prior.c &&
      last.c >= prior.o &&
      lastBody > body(prior) * 0.9
    ) {
      pattern = 'bullish_engulfing';
    } else if (
      lastBear &&
      priorBull &&
      last.o >= prior.c &&
      last.c <= prior.o &&
      lastBody > body(prior) * 0.9
    ) {
      pattern = 'bearish_engulfing';
    } else if (last.h <= prior.h && last.l >= prior.l) {
      pattern = 'inside_bar';
    }
  }
  if (pattern === 'none' || pattern === 'inside_bar') {
    if (lower >= lastBody * 2 && upper <= lastBody * 0.5 && lastBull) {
      pattern = 'hammer';
    } else if (upper >= lastBody * 2 && lower <= lastBody * 0.5 && lastBear) {
      pattern = 'shooting_star';
    } else if (lastBody / lastRange >= 0.7 && lastBull) {
      pattern = 'bull_marubozu';
    } else if (lastBody / lastRange >= 0.7 && lastBear) {
      pattern = 'bear_marubozu';
    }
  }
  if (pattern === 'none' && first && prior) {
    if (last.c > prior.c && prior.c > first.c && last.c > last.o) {
      pattern = 'three_bar_push_up';
    } else if (last.c < prior.c && prior.c < first.c && last.c < last.o) {
      pattern = 'three_bar_push_down';
    }
  }

  const side = BULLISH_PATTERNS.includes(pattern)
    ? 'CE'
    : BEARISH_PATTERNS.includes(pattern)
      ? 'PE'
      : null;
  return { pattern, side };
}
