import { describe, expect, it } from 'vitest';

import { readChart } from '../src/strategy/chart.js';
import { DEFAULT_STRATEGY } from '../src/strategy/params.js';
import { findSetup } from '../src/strategy/setups.js';
import type { IntradayBar } from '../src/universe/types.js';
import { fiveMinuteBars, ist } from './marketFixtures.js';

const params = DEFAULT_STRATEGY;
const PREV = '2026-10-20';
const DAY = '2026-10-21';
/** Futures trade 50 points above spot. */
const BASIS = 50;

type Candle = readonly [open: number, high: number, low: number, close: number, volume?: number];

/** 15-minute candles as three 5-minute bars each: the low in the first, the high in the second. */
function fromFifteen(ymd: string, from: string, candles: readonly Candle[]): IntradayBar[] {
  const start = ist(ymd, from).getTime();
  return candles.flatMap(([o, h, l, c, v = 3_000], i) => {
    const first = o + (c - o) / 3;
    const second = o + ((c - o) * 2) / 3;
    const t = (k: number) => new Date(start + (i * 3 + k) * 5 * 60_000).toISOString();
    return [
      { t: t(0), o, h: Math.max(o, first), l, c: first, v: v / 3 },
      { t: t(1), o: first, h, l: Math.min(first, second), c: second, v: v / 3 },
      { t: t(2), o: second, h: Math.max(second, c), l: Math.min(second, c), c, v: v / 3 },
    ];
  });
}

/** Yesterday around 25,000 on futures: low 24,990, and one spike to `high` (25,040). */
function yesterday(high = 25_040): IntradayBar[] {
  return fromFifteen(
    PREV,
    '09:15',
    Array.from({ length: 25 }, (_, i): Candle =>
      i === 15
        ? [25_000, high, 24_996, 25_008]
        : i % 2 === 0
          ? [25_000, 25_010, 24_990, 25_004]
          : [25_004, 25_012, 24_992, 25_000],
    ),
  );
}

/** The setup found at the check 20 seconds after `hhmm`, from the bars finished by then. */
function setupAt(bars: readonly IntradayBar[], hhmm: string) {
  const now = new Date(ist(DAY, hhmm).getTime() + 20_000);
  const done = bars.filter((bar) => Date.parse(bar.t) + 5 * 60_000 <= now.getTime());
  const futuresPrice = done.at(-1)!.c;
  const spot = futuresPrice - BASIS;
  const chart = readChart(
    { bars: done, todayYmd: DAY, spot, futuresPrice, callWall: null, putWall: null, vwap: null },
    params.chart,
  )!;
  return findSetup(
    {
      now,
      indexName: 'NIFTY',
      bars: done,
      chart,
      spot,
      callWall: null,
      putWall: null,
      dailyBars: [],
    },
    params,
  );
}

describe('flag breakout', () => {
  // A 50-point pole at 09:30, a three-candle pause just over yesterday's high (25,040), then a
  // 15-minute candle closing above the pause on three times the usual volume.
  const today = fromFifteen(DAY, '09:15', [
    [25_005, 25_012, 24_998, 25_008],
    [25_008, 25_056, 25_006, 25_055, 6_000],
    [25_055, 25_057, 25_044, 25_048, 2_000],
    [25_048, 25_052, 25_038, 25_043, 2_000],
    [25_043, 25_049, 25_036, 25_041, 2_000],
    [25_041, 25_070, 25_039.5, 25_069, 9_000],
    [25_069, 25_072, 25_064, 25_066],
  ]);

  it('buys the 15-minute close above the pause, with the stop under the flag', () => {
    const bars = [...yesterday(), ...today];
    expect(setupAt(bars, '10:45')).toMatchObject({
      kind: 'flag',
      side: 'CE',
      // Under the flag's low (25,036 on futures), 50-point pole added to the pause's high.
      stopSpot: 24_986,
      stopName: "the flag's low",
      targetSpot: 25_057,
    });
    // Only once: at the next check it is no longer a fresh signal.
    expect(setupAt(bars, '10:50')).toBeNull();
    // Before the breakout candle has closed there is nothing to buy.
    expect(setupAt(bars, '10:40')).toBeNull();
  });

  it('is skipped when the flag sits right under yesterday\'s high', () => {
    const bars = [...yesterday(25_060), ...today];
    expect(setupAt(bars, '10:45')?.kind).not.toBe('flag');
  });
});

describe('opening-range retest', () => {
  // The first 15 minutes trade 24,996–25,020; the price breaks out, comes back to 25,020 and a
  // bullish candle turns up there; the next 5-minute close above that candle is the entry.
  const today = fiveMinuteBars(DAY, '09:15', [
    [25_000, 25_008, 24_996, 25_006],
    [25_006, 25_014, 25_004, 25_012],
    [25_012, 25_020, 25_010, 25_018],
    [25_018, 25_030, 25_017, 25_028],
    [25_028, 25_033, 25_026, 25_031],
    [25_031, 25_032, 25_024, 25_025],
    [25_025, 25_027, 25_022, 25_023],
    [25_023, 25_026, 25_018, 25_025.5],
    [25_025.5, 25_029, 25_024, 25_028],
    [25_028, 25_033, 25_027, 25_032],
    [25_032, 25_035, 25_030, 25_034],
  ]);

  it('buys the first 5-minute close above the turning candle once its 15-minute candle closed above the range', () => {
    const bars = [...yesterday(), ...today];
    expect(setupAt(bars, '10:05')).toMatchObject({
      kind: 'opening-range-retest',
      side: 'CE',
      // The middle of the opening range (25,008 on futures) is further than the retest low.
      stopSpot: 24_958,
      stopName: 'the middle of the opening range',
    });
    expect(setupAt(bars, '10:05')?.reason).toContain('came back to it');
    expect(setupAt(bars, '10:10')).toBeNull();
    // 09:55: the turning candle's 15-minute candle has not closed yet.
    expect(setupAt(bars, '09:55')).toBeNull();
  });
});

describe('double bottom at a level', () => {
  // Two 15-minute lows at 24,991 and 24,992.5, at yesterday's low (24,990), four candles
  // apart; a bullish engulfing at the second low, then a 5-minute close above it.
  const today = [
    ...fromFifteen(DAY, '09:15', [
      [25_010, 25_015, 25_000, 25_004],
      [25_004, 25_006, 24_991, 24_994],
      [24_994, 25_012, 24_993, 25_010],
      [25_010, 25_020, 25_006, 25_016],
      [25_016, 25_018, 25_000, 25_003],
      [25_003, 25_005, 24_992.5, 24_996],
      [24_995.5, 25_012, 24_994, 25_011],
    ]),
    ...fiveMinuteBars(DAY, '11:00', [[25_011, 25_014, 25_009, 25_013.5]]),
  ];

  it('buys a call when a 5-minute candle closes above the signal candle at the second low', () => {
    const signal = setupAt([...yesterday(), ...today], '11:05');
    expect(signal).toMatchObject({
      kind: 'double-bottom',
      side: 'CE',
      // Under the second low (24,992.5 on futures); the 29-point pattern added to the
      // neckline (25,020).
      stopSpot: 24_942.5,
      stopName: 'the second low',
      targetSpot: 24_999,
    });
    expect(signal?.reason).toContain("at yesterday's low");
  });
});

describe('failed breakout', () => {
  // The price breaks above yesterday's high (25,040) at 09:45, then a 15-minute bearish
  // engulfing closes back under it; the next 5-minute close below that candle sells the trap.
  const today = [
    ...fromFifteen(DAY, '09:15', [
      [25_010, 25_020, 25_005, 25_018],
      [25_018, 25_036, 25_015, 25_034],
      [25_034, 25_048, 25_030, 25_044],
      [25_044, 25_052, 25_026, 25_028],
    ]),
    ...fiveMinuteBars(DAY, '10:15', [[25_028, 25_029, 25_022, 25_023]]),
  ];

  it("buys a put below the trap candle, with the stop over the failed breakout's high", () => {
    const signal = setupAt([...yesterday(), ...today], '10:20');
    expect(signal).toMatchObject({
      kind: 'failed-breakout',
      side: 'PE',
      stopSpot: 25_002,
      stopName: "the failed breakout's high",
    });
    expect(signal?.reason).toContain("broke above yesterday's high (25,040)");
  });
});
