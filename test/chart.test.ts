import { describe, expect, it } from 'vitest';

import {
  averageTrueRange,
  groupBars,
  higherTrendOf,
  readChart,
  structureOf,
  swingPoints,
  trailStopSpot,
} from '../src/strategy/chart.js';
import { classifyLastCandles } from '../src/strategy/indicators.js';
import { DEFAULT_STRATEGY } from '../src/strategy/params.js';
import type { IntradayBar } from '../src/universe/types.js';
import { fiveMinuteBars, ist, steppingBars } from './marketFixtures.js';

const params = DEFAULT_STRATEGY.chart;
const PREV = '2026-10-20';
const DAY = '2026-10-21';

/** Bars from explicit highs and lows (open 1 above the low, close 1 under the high). */
function fromHighsLows(highs: readonly number[], lows: readonly number[]): IntradayBar[] {
  return fiveMinuteBars(
    DAY,
    '09:15',
    highs.map((high, index) => [lows[index]! + 1, high, lows[index]!, high - 1] as const),
  );
}

/**
 * A slide from 25,100 to 25,000 yesterday, then six rising bars today to 25,030; every bar is
 * 10 points tall, so the ATR is exactly 10. Futures trade 50 above spot (24,980).
 */
function risingMorning(lastBar?: readonly [number, number, number, number, number?]) {
  const today = steppingBars(DAY, '09:15', 25_000, 5, 6);
  const bars = [...steppingBars(PREV, '09:15', 25_100, -5, 20), ...today];
  if (lastBar) {
    bars[bars.length - 1] = fiveMinuteBars(DAY, '09:40', [lastBar])[0]!;
  }
  return readChart(
    { bars, todayYmd: DAY, spot: 24_980, futuresPrice: 25_030, callWall: null, putWall: null },
    params,
  );
}

describe('average true range', () => {
  it('measures normal 5-minute swings without counting the overnight gap', () => {
    const yesterday = steppingBars(PREV, '09:15', 25_000, 5, 14);
    // Today opens 130 points above yesterday's close.
    const today = steppingBars(DAY, '09:15', 25_200, 5, 14);
    expect(averageTrueRange([...yesterday, ...today], 14)).toBeCloseTo(10);
    expect(averageTrueRange(yesterday.slice(0, 5), 14)).toBeNull();
  });
});

describe('swings and structure', () => {
  const highs = [100, 104, 110, 104, 100, 106, 114, 108, 104, 108, 112];
  const lows = [96, 100, 106, 100, 97, 102, 110, 104, 101, 104, 108];

  it('finds swing highs and lows confirmed by two bars on each side', () => {
    const swings = swingPoints(fromHighsLows(highs, lows), 2);
    expect(swings.highs.map((swing) => swing.price)).toEqual([110, 114]);
    expect(swings.lows.map((swing) => swing.price)).toEqual([97, 101]);
  });

  it('reads rising highs and lows as an uptrend, falling as a downtrend, mixed as unclear', () => {
    expect(structureOf(swingPoints(fromHighsLows(highs, lows), 2))).toBe('up');
    const flipped = (values: readonly number[]) => values.map((value) => 300 - value);
    // Mirrored, the old lows become the highs.
    expect(structureOf(swingPoints(fromHighsLows(flipped(lows), flipped(highs)), 2))).toBe('down');
    const lowerLow = [96, 100, 106, 100, 97, 102, 110, 104, 95, 104, 108];
    expect(structureOf(swingPoints(fromHighsLows(highs, lowerLow), 2))).toBe('unclear');
  });
});

describe('15-minute trend', () => {
  it('groups 5-minute bars into 15-minute bars from 09:15', () => {
    const grouped = groupBars(steppingBars(DAY, '09:15', 100, 1, 6), 15);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toEqual({ o: 100, h: 105.5, l: 97.5, c: 103, key: expect.any(String) });
  });

  it('is up above a rising average, down below a falling one, flat otherwise', () => {
    const rising = Array.from({ length: 30 }, (_, index) => 100 + index);
    expect(higherTrendOf(rising, 20)).toBe('up');
    expect(higherTrendOf([...rising].reverse(), 20)).toBe('down');
    expect(
      higherTrendOf(
        Array.from({ length: 30 }, () => 100),
        20,
      ),
    ).toBe('flat');
    expect(higherTrendOf(rising.slice(0, 22), 20)).toBeNull();
  });
});

describe('readChart', () => {
  it('reads the levels, stop and target in spot terms', () => {
    const chart = risingMorning()!;
    expect(chart).toMatchObject({
      atr: 10,
      basis: 50,
      structure: 'unclear',
      higherTrend: null,
      candle: { pattern: 'three_bar_push_up', side: 'CE', confirms: 'CE', volumeRatio: 1 },
      // Today's high before the last candle (25,027.5 futures) is just under spot now.
      support: { price: 24_977.5, kind: 'day-high' },
      // Yesterday's high, 25,102.5 on futures, is 25,052.5 in spot terms.
      resistance: { price: 25_052.5, kind: 'previous-high' },
    });
    expect(chart.burstAtr).toBeCloseTo(1.5);
    // Under the low of the last two candles (25,017.5) by 0.25 ATR, less the basis.
    expect(chart.plans.CE).toMatchObject({
      stopSpot: 24_965,
      riskPoints: 15,
      targetSpot: 25_052.5,
      targetKind: 'previous-high',
      rewardPoints: 72.5,
      nearLevel: null,
    });
    expect(chart.plans.CE.rewardToRisk).toBeCloseTo(4.83, 2);
    // A put's structural stop (24,985) is inside 1 ATR, so it widens to 24,990; today's high
    // 2.5 points below is the level it sits on.
    expect(chart.plans.PE).toMatchObject({
      stopSpot: 24_990,
      riskPoints: 10,
      nearLevel: { price: 24_977.5, kind: 'day-high' },
      targetSpot: 24_967.5,
      targetKind: 'opening-high',
    });
  });

  it('confirms only a strong close past the candle before, on usual volume, of normal size', () => {
    expect(risingMorning()?.candle.confirms).toBe('CE');
    // Closes in the middle of its range.
    expect(risingMorning([25_025, 25_032.5, 25_022.5, 25_027])?.candle.confirms).toBeNull();
    // Half the usual volume.
    expect(risingMorning([25_025, 25_032.5, 25_022.5, 25_030, 500])?.candle.confirms).toBeNull();
    // Four points tall, under half a normal swing.
    expect(risingMorning([25_025, 25_028.5, 25_024.5, 25_028])?.candle.confirms).toBeNull();
    const falling = readChart(
      {
        bars: [
          ...steppingBars(PREV, '09:15', 24_900, 5, 20),
          ...steppingBars(DAY, '09:15', 25_000, -5, 6),
        ],
        todayYmd: DAY,
        spot: 24_920,
        futuresPrice: 24_970,
        callWall: null,
        putWall: null,
      },
      params,
    );
    expect(falling?.candle.confirms).toBe('PE');
  });

  it('needs the spot, the futures price and two of today’s bars', () => {
    const bars = steppingBars(PREV, '09:15', 25_100, -5, 20);
    const base = {
      todayYmd: DAY,
      spot: 24_980,
      futuresPrice: 25_030,
      callWall: null,
      putWall: null,
    };
    expect(readChart({ ...base, bars }, params)).toBeNull();
    const today = [...bars, ...steppingBars(DAY, '09:15', 25_000, 5, 2)];
    expect(readChart({ ...base, bars: today }, params)).not.toBeNull();
    expect(readChart({ ...base, bars: today, spot: null }, params)).toBeNull();
  });

  it('trails a stop only from swings that formed after the entry', () => {
    const chart = risingMorning()!;
    // The only swing low is yesterday's last candle (24,997.5 on futures).
    expect(trailStopSpot(chart, 'CE', ist(DAY, '09:00'), params)).toBeNull();
    expect(trailStopSpot(chart, 'CE', ist(PREV, '09:00'), params)).toBe(24_945);
  });
});

describe('candle patterns in context', () => {
  // A long lower shadow and a small body near the high.
  const hammerShape = [100, 101.3, 96, 101] as const;
  const bar = ([o, h, l, c]: readonly number[]) => ({ o: o!, h: h!, l: l!, c: c! });
  const declining = [
    [110, 110.5, 105.5, 106],
    [106, 106.5, 102.5, 103],
    [103, 103.5, 99.5, 100],
  ].map(bar);
  const rising = [
    [90, 94.5, 89.5, 94],
    [94, 97.5, 93.5, 97],
    [97, 100.5, 96.5, 100],
  ].map(bar);

  it('reads a hammer after a fall as bullish and the same shape after a rise as a hanging man', () => {
    expect(classifyLastCandles([...declining, bar(hammerShape)])).toEqual({
      pattern: 'hammer',
      side: 'CE',
    });
    expect(classifyLastCandles([...rising, bar(hammerShape)])).toEqual({
      pattern: 'hanging_man',
      side: null,
    });
  });

  it('ignores candles too small to mean anything and spots stars and dojis', () => {
    expect(classifyLastCandles([...declining, bar(hammerShape)], { atr: 20 }).pattern).toBe('none');
    const morningStar = [
      [110, 110.5, 99.5, 100],
      [100, 101, 98.5, 99.5],
      [99.5, 108.5, 99, 108],
    ].map(bar);
    expect(classifyLastCandles(morningStar)).toEqual({ pattern: 'morning_star', side: 'CE' });
    expect(classifyLastCandles([...rising, bar([100, 103, 97, 100.2])]).pattern).toBe('doji');
  });
});
