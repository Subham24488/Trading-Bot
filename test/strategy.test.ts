import { describe, expect, it } from 'vitest';

import { readChart, type ChartPlan, type ChartRead } from '../src/strategy/chart.js';
import { msUntilNextCycle } from '../src/strategy/clock.js';
import type { ChainQuote, ContractCandidate } from '../src/strategy/contracts.js';
import {
  checkPositionExit,
  decideEntry,
  levelRoomPct,
  profitFloor,
  summarizeDay,
  type DayRow,
  type DayStats,
  type OpenPosition,
} from '../src/strategy/decisionEngine.js';
import { completedBars, ema, rsi } from '../src/strategy/indicators.js';
import { DEFAULT_STRATEGY } from '../src/strategy/params.js';
import {
  describeBuy,
  describeExit,
  describeHold,
  describeSkip,
} from '../src/strategy/rationale.js';
import {
  globalMoodSignal,
  readIndex,
  SIGNAL_NAMES,
  type IndexMarketData,
  type IndexReading,
  type MarketBackdrop,
  type SignalName,
  type Vote,
} from '../src/strategy/signals.js';
import { fiveMinuteBars, ist, steppingBars, uptrendFuturesBars } from './marketFixtures.js';

const params = DEFAULT_STRATEGY;
const JARGON = /\b(VWAP|EMA|RSI|PCR|OI|delta|IV)\b/i;

function chainRow(
  side: 'CE' | 'PE',
  strike: number,
  oi: number,
  oiChangeToday: number,
): ChainQuote {
  return {
    symbol: `NIFTY26OCT${strike}${side}`,
    index: 'NIFTY',
    side,
    strike,
    expiry: '2026-10-27',
    token: strike + (side === 'CE' ? 1 : 2),
    lotSize: 65,
    ltp: 120,
    bid: 119.8,
    ask: 120.2,
    oi,
    volume: 50_000,
    oiChangeToday,
  };
}

function bullishMarket(): { data: IndexMarketData; backdrop: MarketBackdrop } {
  const futuresBars = uptrendFuturesBars({ yesterday: '2026-10-20', today: '2026-10-21' });
  const futuresPrice = futuresBars.at(-1)!.c;
  const strikes = [24_900, 24_950, 25_000, 25_050, 25_100];
  return {
    data: {
      index: 'NIFTY',
      spot: 25_000,
      step: 50,
      futures: { symbol: 'NIFTY26OCTFUT', token: 9001 },
      futuresPrice,
      futuresVwap: futuresPrice - 30,
      futuresBars,
      chain: [
        ...strikes.map((strike) => chainRow('CE', strike, 5_000_000, 100_000)),
        ...strikes.map((strike) => chainRow('PE', strike, 5_000_000, 800_000)),
        chainRow('CE', 25_250, 9_000_000, 0),
      ],
      expiryToday: false,
      newsLevel: 'none',
    },
    backdrop: {
      vixPct: -1,
      usdInrPct: 0,
      crudePct: -2,
      gapPct: 0.5,
      advancersPct: 70,
      headlineTone: 0,
    },
  };
}

function reading(
  overrides: Partial<IndexReading> & { votes?: Partial<Record<SignalName, Vote>> },
): IndexReading {
  const votes = Object.fromEntries(SIGNAL_NAMES.map((name) => [name, 1])) as Record<
    SignalName,
    Vote
  >;
  Object.assign(votes, overrides.votes ?? {});
  return {
    index: 'NIFTY',
    signals: SIGNAL_NAMES.map((name) => ({
      name,
      vote: votes[name],
      plain: `${name} points ${votes[name] > 0 ? 'up' : votes[name] < 0 ? 'down' : 'nowhere'}`,
    })),
    rsi: 60,
    lastCandle: { pattern: 'none', side: null },
    chart: null,
    spot: 25_000,
    futuresPrice: 25_060,
    vwap: 25_030,
    callWall: 25_300,
    putWall: 24_700,
    pcr: 1.1,
    expiryToday: false,
    newsLevel: 'none',
    coreDataOk: true,
    ...overrides,
    votes,
    score: overrides.score ?? Object.values(votes).reduce((sum, vote) => sum + vote, 0),
  };
}

const quietDay: DayStats = { trades: 0, losingTrades: 0, lastExitAt: null, netPnlInr: 0 };

describe('indicators', () => {
  it('computes EMA and RSI and drops the candle that is still forming', () => {
    expect(ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toBeCloseTo(9, 6);
    const upTwoDownOne = [100];
    for (let step = 1; step <= 14; step += 1) {
      upTwoDownOne.push(upTwoDownOne.at(-1)! + (step % 2 === 1 ? 2 : -1));
    }
    expect(rsi(upTwoDownOne)).toBeCloseTo(66.67, 1);
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toBe(100);
    const bars = [
      { t: ist('2026-10-21', '10:20').toISOString() },
      { t: ist('2026-10-21', '10:25').toISOString() },
    ];
    expect(completedBars(bars, 5, ist('2026-10-21', '10:29'))).toHaveLength(1);
  });

  it('schedules cycles on clock boundaries plus a short delay', () => {
    expect(msUntilNextCycle(ist('2026-10-21', '10:30'), 15)).toBe(20_000);
    expect(msUntilNextCycle(new Date(ist('2026-10-21', '10:30').getTime() + 20_000), 15)).toBe(
      15 * 60_000,
    );
    expect(msUntilNextCycle(ist('2026-10-21', '10:31'), 15)).toBe(14 * 60_000 + 20_000);
  });
});

describe('market votes', () => {
  it('reads a broad uptrend as eight votes for calls', () => {
    const { data, backdrop } = bullishMarket();
    const result = readIndex(data, backdrop, params, ist('2026-10-21', '10:30'));
    expect(result.votes).toEqual({
      averagePrice: 1,
      trend: 1,
      openingRange: 1,
      futuresPositioning: 1,
      optionFlow: 1,
      volume: 1,
      breadth: 1,
      globalMood: 1,
    });
    expect(result.coreDataOk).toBe(true);
    expect(result.rsi).toBeLessThan(params.rsiChaseLimit);
    expect(result.lastCandle.side).toBe('CE');
  });

  it('counts a 0.2% futures open-interest build-up as fresh positioning', () => {
    const { data, backdrop } = bullishMarket();
    let todayIndex = 0;
    // About +0.2% open interest over the six-bar window (the old 0.3% threshold missed this).
    const futuresBars = data.futuresBars.map((bar) =>
      bar.t.startsWith('2026-10-21') ? { ...bar, oi: 10_000_000 + 3_400 * todayIndex++ } : bar,
    );
    const now = ist('2026-10-21', '10:30');
    expect(readIndex({ ...data, futuresBars }, backdrop, params, now).votes.futuresPositioning).toBe(1);
    const oldThreshold = { ...params, signals: { ...params.signals, futuresOiChangePct: 0.3 } };
    expect(
      readIndex({ ...data, futuresBars }, backdrop, oldThreshold, now).votes.futuresPositioning,
    ).toBe(0);
  });

  it('turns global mood negative only when at least two risk-off cues agree', () => {
    const calm = {
      vixPct: 6,
      usdInrPct: 0,
      crudePct: 0,
      gapPct: 0,
      advancersPct: null,
      headlineTone: 0,
    };
    expect(globalMoodSignal(calm, params.signals).vote).toBe(0);
    expect(globalMoodSignal({ ...calm, crudePct: 2.1 }, params.signals)).toMatchObject({
      vote: -1,
      plain: expect.stringContaining('crude oil is up 2.1%'),
    });
  });
});

describe('big option levels', () => {
  // Replays 2026-10-22 12:25: NIFTY 22,598.6, just under the 22,600 strike with the most put OI.
  const levelChain = [
    chainRow('PE', 22_500, 5_000_000, 0),
    chainRow('PE', 22_550, 3_000_000, 0),
    chainRow('PE', 22_600, 9_000_000, 0),
    chainRow('PE', 22_650, 2_000_000, 0),
    chainRow('CE', 22_650, 2_000_000, 0),
    chainRow('CE', 22_800, 9_000_000, 0),
  ];
  const levelsAt = (spot: number) => {
    const { data, backdrop } = bullishMarket();
    return readIndex({ ...data, spot, chain: levelChain }, backdrop, params, ist('2026-10-22', '12:25'));
  };
  const bearish = (putWall: number | null) =>
    reading({
      votes: Object.fromEntries(SIGNAL_NAMES.map((name) => [name, -1])) as Record<SignalName, Vote>,
      spot: 22_598.6,
      rsi: 38.8,
      putWall,
      callWall: 22_800,
    });

  it('keeps a wall that spot has only just ticked through', () => {
    expect(levelsAt(22_598.6)).toMatchObject({ putWall: 22_600, callWall: 22_800 });
    // A real break, more than the 0.15% buffer below the wall, moves on to the next support.
    expect(levelsAt(22_560).putWall).toBe(22_500);
  });

  it('does not buy a put sitting on the biggest put support', () => {
    const now = ist('2026-10-22', '12:25');
    const atWall = decideEntry(
      { now, readings: [bearish(levelsAt(22_598.6).putWall)], day: quietDay, vixPct: 4 },
      params,
    );
    expect(atWall.action).toBe('SKIP');
    expect(atWall.action === 'SKIP' && atWall.blockedBy).toContain('near-big-level');
    // The old reading (wall 22,500) let this exact entry through.
    const oldWall = decideEntry(
      { now, readings: [bearish(22_500)], day: quietDay, vixPct: 4 },
      params,
    );
    expect(oldWall).toMatchObject({ action: 'BUY', side: 'PE' });
  });
});

describe('decideEntry', () => {
  const now = ist('2026-10-21', '10:30');

  it('buys the strongest index when votes and gates agree', () => {
    const decision = decideEntry(
      {
        now,
        readings: [reading({ index: 'BANKNIFTY', votes: { breadth: 0, volume: 0 } }), reading({})],
        day: quietDay,
        vixPct: 0,
      },
      params,
    );
    expect(decision).toMatchObject({ action: 'BUY', index: 'NIFTY', side: 'CE', score: 8 });
  });

  it.each([
    ['outside the entry window', { now: ist('2026-10-21', '09:20') }, 'entry-window'],
    [
      'late on an expiry day',
      { now: ist('2026-10-21', '13:45'), expiry: true },
      'expiry-day-cutoff',
    ],
    ['after the daily trade limit', { day: { ...quietDay, trades: 3 } }, 'daily-trade-limit'],
    ['after two losing trades', { day: { ...quietDay, losingTrades: 2 } }, 'daily-loss-limit'],
    ['once the day is in profit', { day: { ...quietDay, netPnlInr: 450 } }, 'day-in-profit'],
    [
      'soon after an exit',
      { day: { ...quietDay, lastExitAt: new Date(now.getTime() - 10 * 60_000) } },
      'cooldown',
    ],
    ['with two opposing signals', { votes: { breadth: -1, globalMood: -1 } }, 'too-many-opposing'],
    ['against the trend', { votes: { trend: -1 } }, 'trend-disagrees'],
    ['when chasing a stretched move', { rsi: 80 }, 'chasing'],
  ] as const)('skips %s', (_label, scenario, gate) => {
    const scenarioReading = reading({
      expiryToday: 'expiry' in scenario,
      ...('votes' in scenario ? { votes: scenario.votes } : {}),
      ...('rsi' in scenario ? { rsi: scenario.rsi } : {}),
    });
    const decision = decideEntry(
      {
        now: 'now' in scenario ? scenario.now : now,
        readings: [scenarioReading],
        day: 'day' in scenario ? scenario.day : quietDay,
        vixPct: 0,
      },
      params,
    );
    expect(decision.action).toBe('SKIP');
    expect(decision.action === 'SKIP' && decision.blockedBy).toContain(gate);
    expect(decision.action === 'SKIP' && decision.leaning).toMatchObject({
      index: 'NIFTY',
      side: 'CE',
    });
  });
});

describe('reward-to-risk and the day lock', () => {
  // 2026-11-09 10:45: NIFTY 24,855.15 had fallen 0.29% in 15 minutes toward the 24,800 put wall.
  const nov9 = (putWall: number) =>
    reading({
      votes: Object.fromEntries(SIGNAL_NAMES.map((name) => [name, -1])) as Record<SignalName, Vote>,
      spot: 24_855.15,
      rsi: 33,
      putWall,
      callWall: 25_000,
    });
  const now = ist('2026-11-09', '10:45');

  it('measures room to the next big level in the trade direction', () => {
    expect(levelRoomPct(reading({}), 'CE')).toBeCloseTo(1.2);
    expect(levelRoomPct(reading({}), 'PE')).toBeCloseTo(1.2);
    expect(levelRoomPct(nov9(24_800), 'PE')).toBeCloseTo(0.222, 3);
    expect(levelRoomPct(reading({ putWall: null }), 'PE')).toBeNull();
  });

  it('does not buy the 2026-11-09 put with 0.22% room against a 0.15% loss limit', () => {
    const decision = decideEntry(
      { now, readings: [nov9(24_800)], day: quietDay, vixPct: -6 },
      params,
    );
    // Outside the 0.15% big-level buffer, so only the reward-to-risk check stops it.
    expect(decision).toMatchObject({ action: 'SKIP', blockedBy: ['low-reward'] });
    expect(
      decideEntry({ now, readings: [nov9(24_700)], day: quietDay, vixPct: -6 }, params),
    ).toMatchObject({ action: 'BUY', side: 'PE' });
  });

  it('keeps trading on a losing day and stops once the day is green', () => {
    const buys = (day: DayStats) =>
      decideEntry({ now, readings: [nov9(24_700)], day, vixPct: -6 }, params).action;
    expect(buys({ ...quietDay, trades: 1, losingTrades: 1, netPnlInr: -1_900 })).toBe('BUY');
    expect(buys({ ...quietDay, trades: 1, netPnlInr: 0 })).toBe('BUY');
    expect(buys({ ...quietDay, trades: 1, netPnlInr: 1 })).toBe('SKIP');
  });

  it("sums the net result of today's closed trades, leaving out start-up exits", () => {
    const row = (action: string, time: string, extra: Partial<DayRow> = {}): DayRow => ({
      action,
      decidedAt: ist('2026-11-09', time),
      buyPrice: 100,
      sellPrice: null,
      trigger: 'cycle',
      netPnlInr: null,
      ...extra,
    });
    const day = summarizeDay(
      [
        row('EXIT', '09:16', { sellPrice: 60, trigger: 'startup', netPnlInr: -2_700 }),
        row('BUY', '10:00'),
        row('EXIT', '10:20', { sellPrice: 90, trigger: 'monitor', netPnlInr: -730 }),
        row('BUY', '11:00'),
        row('EXIT', '11:40', { sellPrice: 118, netPnlInr: 1_090 }),
      ],
      ist('2026-11-09', '12:00'),
    );
    expect(day).toMatchObject({ trades: 2, losingTrades: 1, netPnlInr: 360 });
  });
});

/** A clean chart for calls (and its mirror for puts); `overrides` change one part. */
function chartRead(
  overrides: Partial<Omit<ChartRead, 'candle'>> & {
    candle?: Partial<ChartRead['candle']>;
    plan?: Partial<ChartPlan>;
  } = {},
): ChartRead {
  const { candle, plan, ...rest } = overrides;
  const sidePlan = (side: 'CE' | 'PE'): ChartPlan => ({
    side,
    entrySpot: 25_000,
    stopSpot: side === 'CE' ? 24_985 : 25_015,
    riskPoints: 15,
    targetSpot: side === 'CE' ? 25_060 : 24_940,
    targetKind: side === 'CE' ? 'swing-high' : 'swing-low',
    rewardPoints: 60,
    rewardToRisk: 4,
    nearLevel: null,
    ...plan,
  });
  return {
    atr: 12,
    structure: 'unclear',
    higherTrend: 'up',
    burstAtr: 0.8,
    candle: {
      pattern: 'bull_marubozu',
      side: 'CE',
      confirms: 'CE',
      closeLocation: 0.9,
      rangeAtr: 1.1,
      volumeRatio: 1.4,
      ...candle,
    },
    support: { price: 24_985, kind: 'swing-low' },
    resistance: { price: 25_060, kind: 'swing-high' },
    plans: { CE: sidePlan('CE'), PE: sidePlan('PE') },
    basis: 60,
    swings: { highs: [], lows: [] },
    ...rest,
  };
}

describe('chart gates', () => {
  const now = ist('2026-10-21', '10:30');
  const decide = (chart: ChartRead, extra: Partial<IndexReading> = {}) =>
    decideEntry(
      { now, readings: [reading({ chart, ...extra })], day: quietDay, vixPct: 0 },
      params,
    );

  it('buys when the chart agrees', () => {
    expect(decide(chartRead())).toMatchObject({ action: 'BUY', side: 'CE' });
  });

  it.each([
    [
      'without a confirming candle',
      chartRead({ candle: { confirms: null, side: null } }),
      'no-candle-confirmation',
    ],
    [
      'right under a level the price turned back from',
      chartRead({ plan: { nearLevel: { price: 25_003, kind: 'hour-high' } } }),
      'near-chart-level',
    ],
    ['against the 15-minute trend', chartRead({ higherTrend: 'down' }), 'chart-trend-disagrees'],
    ['against falling highs and lows', chartRead({ structure: 'down' }), 'chart-trend-disagrees'],
    ['after a climax run of three normal swings', chartRead({ burstAtr: 3 }), 'chasing'],
    [
      'with the next level closer than 1.5× the stop',
      chartRead({ plan: { rewardPoints: 20, rewardToRisk: 1.33 } }),
      'low-reward',
    ],
  ] as const)('skips %s', (_label, chart, gate) => {
    const decision = decide(chart);
    expect(decision.action).toBe('SKIP');
    expect(decision.action === 'SKIP' && decision.blockedBy).toContain(gate);
  });

  it('names an opposite pattern, not a missing confirmation', () => {
    const chart = chartRead({
      candle: { pattern: 'bearish_engulfing', side: 'PE', confirms: 'PE' },
    });
    const decision = decide(chart, { lastCandle: { pattern: 'bearish_engulfing', side: 'PE' } });
    expect(decision.action === 'SKIP' && decision.blockedBy).toContain('opposite-candle');
    expect(decision.action === 'SKIP' && decision.blockedBy).not.toContain(
      'no-candle-confirmation',
    );
  });

  it('does not buy the 2026-11-09 put after a 72-point fall in 15 minutes into the put wall', () => {
    // An hour of quiet trade around 24,950 on futures, then three 29-point down candles.
    const quiet = (ymd: string, count: number) =>
      fiveMinuteBars(
        ymd,
        '09:15',
        Array.from({ length: count }, (_, index) =>
          index % 2 === 0
            ? ([24_950, 24_957, 24_947, 24_954] as const)
            : ([24_954, 24_957, 24_947, 24_950] as const),
        ),
      );
    const drop = fiveMinuteBars('2026-11-09', '10:30', [
      [24_951, 24_953, 24_920, 24_922, 3_000],
      [24_922, 24_924, 24_891, 24_893, 3_000],
      [24_893, 24_895, 24_862, 24_864, 3_000],
    ]);
    const chart = readChart(
      {
        bars: [...quiet('2026-11-06', 20), ...quiet('2026-11-09', 15), ...drop],
        todayYmd: '2026-11-09',
        spot: 24_855.15,
        futuresPrice: 24_864,
        callWall: 25_000,
        putWall: 24_800,
      },
      params.chart,
    )!;
    expect(chart.burstAtr).toBeLessThan(-params.chart.maxBurstAtr);
    const decision = decideEntry(
      {
        now: ist('2026-11-09', '10:45'),
        readings: [
          reading({
            votes: Object.fromEntries(SIGNAL_NAMES.map((name) => [name, -1])) as Record<
              SignalName,
              Vote
            >,
            spot: 24_855.15,
            rsi: 33,
            putWall: 24_800,
            callWall: 25_000,
            chart,
          }),
        ],
        day: quietDay,
        vixPct: -6,
      },
      params,
    );
    // Stop above the last two candles is ~64 points away; the put wall is 55 points down.
    expect(decision).toMatchObject({ action: 'SKIP', blockedBy: ['chasing', 'low-reward'] });
  });

  it('does not buy the 2026-11-11 call three points under the hour’s high', () => {
    // An hour boxed between 25,398 and 25,432 on futures, then a strong candle up to 25,429.
    const box = [
      25_400, 25_410, 25_420, 25_430, 25_420, 25_410, 25_400, 25_410, 25_420, 25_430, 25_420,
      25_410,
    ];
    let open = 25_405;
    const boxBars = fiveMinuteBars(
      '2026-11-11',
      '10:15',
      box.map((close) => {
        const bar = [open, Math.max(open, close) + 2, Math.min(open, close) - 2, close] as const;
        open = close;
        return bar;
      }),
    );
    const bars = [
      ...steppingBars('2026-11-10', '09:15', 25_360, 1, 20),
      ...steppingBars('2026-11-11', '09:15', 25_380, 2, 12),
      ...boxBars,
      ...fiveMinuteBars('2026-11-11', '11:15', [[25_410, 25_430, 25_409, 25_429]]),
    ];
    const chart = readChart(
      {
        bars,
        todayYmd: '2026-11-11',
        spot: 25_384.5,
        futuresPrice: 25_429,
        callWall: 25_500,
        putWall: 25_300,
      },
      params.chart,
    )!;
    expect(chart.candle.confirms).toBe('CE');
    // The box top: 25,432 on futures, 25,387.5 in spot terms, 3 points above spot.
    expect(chart.plans.CE.nearLevel).toMatchObject({ price: 25_387.5 });
    const decision = decideEntry(
      {
        now: ist('2026-11-11', '11:20'),
        readings: [reading({ spot: 25_384.5, callWall: 25_500, putWall: 25_300, chart })],
        day: quietDay,
        vixPct: 0,
      },
      params,
    );
    expect(decision).toMatchObject({ action: 'SKIP', blockedBy: ['near-chart-level'] });
  });
});

describe('checkPositionExit', () => {
  const position: OpenPosition = {
    symbol: 'NIFTY26OCT25000CE',
    index: 'NIFTY',
    side: 'CE',
    strike: 25_000,
    expiry: '2026-10-27',
    token: 1,
    entryPrice: 100,
    enteredAt: ist('2026-10-21', '10:00'),
    peakPrice: 100,
    troughPrice: 100,
    lotSize: 65,
    entryDelta: 0.5,
    entrySpot: 25_000,
    stopSpot: null,
    premiumStop: null,
  };
  const flipped = reading({ votes: { averagePrice: -1, trend: -1 } });
  // Spot 25,000 is 0.1% under the strike where option sellers hold the most calls.
  const atCallWall = reading({ callWall: 25_025 });

  it.each([
    ['square-off at 3:15 PM', { now: '15:15', price: 130 }, 'square-off'],
    [
      'stale position from an earlier day',
      { enteredAt: ist('2026-10-20', '14:00'), now: '09:30', price: 100 },
      'stale-position',
    ],
    ['stop-loss', { now: '10:20', price: 74 }, 'stop-loss'],
    [
      'trailing stop after a big gain',
      { now: '10:40', price: 119, peakPrice: 140 },
      'trailing-stop',
    ],
    ['time stop when nothing happens', { now: '10:50', price: 103 }, 'time-stop'],
    [
      'trend reversal after the minimum hold',
      { now: '10:20', price: 101, reading: flipped },
      'trend-reversal',
    ],
    ['hold while the minimum hold runs', { now: '10:10', price: 101, reading: flipped }, null],
    ['hold a healthy trade', { now: '10:20', price: 108 }, null],
    [
      'index stop when the index falls 0.15% against a call',
      { now: '10:10', price: 95, spot: 24_962 },
      'index-stop',
    ],
    [
      'hold while the index move stays inside 0.15%',
      { now: '10:10', price: 95, spot: 24_965 },
      null,
    ],
    ['index stop even without an option price', { now: '10:10', price: null, spot: 24_900 }, 'index-stop'],
    [
      'break-even exit once a +9% gain fades to +1.5%',
      { now: '10:20', price: 101.5, peakPrice: 109 },
      'breakeven-stop',
    ],
    ['hold above the break-even exit', { now: '10:20', price: 103, peakPrice: 109 }, null],
    [
      'bigger gains keep a bigger share (65% of a +30% best)',
      { now: '10:40', price: 118, peakPrice: 130 },
      'trailing-stop',
    ],
    [
      'the ₹10 profit lock sells a ₹100 option that reached ₹112 and slipped to ₹108',
      { now: '10:20', price: 108, peakPrice: 112, reading: reading({}) },
      'profit-lock',
    ],
    [
      'tighter profit lock at a big option-seller level (₹40 option: ₹10 is 25%)',
      { now: '10:20', entryPrice: 40, price: 43.2, peakPrice: 44.8, reading: atCallWall },
      'level-reached',
    ],
    [
      'the same pullback away from big levels holds (₹40 option)',
      { now: '10:20', entryPrice: 40, price: 43.2, peakPrice: 44.8, reading: reading({}) },
      null,
    ],
    [
      'chart stop once NIFTY trades at the level under the setup',
      { now: '10:10', price: 99, spot: 24_985, stopSpot: 24_985, premiumStop: 92 },
      'chart-stop',
    ],
    [
      'hold just above the chart stop, ignoring the fixed 0.15% move',
      { now: '10:10', price: 99, spot: 24_960, stopSpot: 24_955, premiumStop: 92 },
      null,
    ],
    [
      'planned premium stop once the bid reaches the loss limit',
      { now: '10:10', price: 92, spot: 24_990, stopSpot: 24_985, premiumStop: 92 },
      'stop-loss',
    ],
    [
      'hold a cent above the planned premium stop',
      { now: '10:10', price: 92.05, spot: 24_990, stopSpot: 24_985, premiumStop: 92 },
      null,
    ],
  ] as const)('%s', (_label, scenario, reason) => {
    const result = checkPositionExit(
      {
        now: ist('2026-10-21', scenario.now),
        position: {
          ...position,
          ...('enteredAt' in scenario ? { enteredAt: scenario.enteredAt } : {}),
          ...('entryPrice' in scenario ? { entryPrice: scenario.entryPrice } : {}),
          ...('peakPrice' in scenario ? { peakPrice: scenario.peakPrice } : {}),
          ...('stopSpot' in scenario ? { stopSpot: scenario.stopSpot } : {}),
          ...('premiumStop' in scenario ? { premiumStop: scenario.premiumStop } : {}),
        },
        price: scenario.price,
        spot: 'spot' in scenario ? scenario.spot : null,
        reading: 'reading' in scenario ? scenario.reading : null,
      },
      params,
    );
    expect(result).toEqual(reason ? { action: 'EXIT', reason } : { action: 'HOLD' });
  });

  it('sells a put once the index rises 0.15% from the entry spot (2026-10-22 trade)', () => {
    const put: OpenPosition = {
      ...position,
      symbol: 'NIFTY26OCT22600PE',
      side: 'PE',
      strike: 22_600,
      entryPrice: 144.65,
      peakPrice: 146.45,
      troughPrice: 116.55,
      entrySpot: 22_598.6,
    };
    const at = (spot: number) =>
      checkPositionExit({ now: ist('2026-10-21', '10:25'), position: put, price: 120, spot }, params);
    expect(at(22_630)).toEqual({ action: 'HOLD' });
    expect(at(22_634)).toEqual({ action: 'EXIT', reason: 'index-stop' });
  });

  it('keeps the gains the 2026-11-03 call and 2026-11-04 put gave back under the old rules', () => {
    // Best +14.6%, just under the old +15% trail start; it was later closed at −0.5% on time.
    const call: OpenPosition = {
      ...position,
      symbol: 'NIFTY26N0923700CE',
      strike: 23_700,
      expiry: '2026-11-09',
      entryPrice: 159.3,
      enteredAt: ist('2026-11-03', '11:40'),
      peakPrice: 182.6,
      troughPrice: 158.5,
      entrySpot: 23_666.7,
    };
    const callAt = (time: string, price: number, spot: number) =>
      checkPositionExit({ now: ist('2026-11-03', time), position: call, price, spot }, params);
    expect(callAt('12:10', 171.15, 23_689.1)).toEqual({ action: 'HOLD' });
    expect(callAt('12:15', 158.8, 23_661.2)).toEqual({ action: 'EXIT', reason: 'trailing-stop' });

    // Best +13.3% within ten minutes; it was later closed at −18.4% on time.
    const put: OpenPosition = {
      ...call,
      symbol: 'NIFTY26N0923700PE',
      side: 'PE',
      entryPrice: 157.55,
      enteredAt: ist('2026-11-04', '12:10'),
      peakPrice: 178.45,
      troughPrice: 157.55,
      entrySpot: 23_775.9,
    };
    expect(
      checkPositionExit(
        { now: ist('2026-11-04', '12:20'), position: put, price: 158.35, spot: 23_766.85 },
        params,
      ),
    ).toEqual({ action: 'EXIT', reason: 'trailing-stop' });
  });

  it('keeps ₹10 of the 2026-10-23 put that reached +₹13.35 and closed at −₹6.95 on time', () => {
    const put: OpenPosition = {
      ...position,
      symbol: 'NIFTY26OCT22500PE',
      side: 'PE',
      strike: 22_500,
      entryPrice: 151.85,
      enteredAt: ist('2026-10-23', '11:33'),
      peakPrice: 165.2,
      troughPrice: 140.6,
      entrySpot: 22_461.5,
    };
    const at = (bid: number) =>
      checkPositionExit(
        { now: ist('2026-10-23', '11:50'), position: put, price: bid, spot: null },
        params,
      );
    // The lock sits at the buy price + ₹10 = ₹161.85.
    expect(at(161.9)).toEqual({ action: 'HOLD' });
    expect(at(161.8)).toEqual({ action: 'EXIT', reason: 'profit-lock' });
  });

  it('sells a put once NIFTY rises to its chart stop', () => {
    const put: OpenPosition = {
      ...position,
      symbol: 'NIFTY26OCT25000PE',
      side: 'PE',
      stopSpot: 25_020,
      premiumStop: 90,
    };
    const at = (spot: number) =>
      checkPositionExit(
        { now: ist('2026-10-21', '10:10'), position: put, price: 98, spot },
        params,
      );
    expect(at(25_019)).toEqual({ action: 'HOLD' });
    expect(at(25_020)).toEqual({ action: 'EXIT', reason: 'chart-stop' });
  });
});

describe('profitFloor', () => {
  it('locks break-even from +8%, trails from +10% and keeps more of bigger gains', () => {
    expect(profitFloor(7.9, params)).toBeNull();
    expect(profitFloor(8, params)).toEqual({ floorPct: 2, kind: 'breakeven' });
    expect(profitFloor(12, params)).toEqual({ floorPct: 6, kind: 'trail' });
    expect(profitFloor(30, params)?.floorPct).toBeCloseTo(19.5);
    expect(profitFloor(40, params)?.floorPct).toBeCloseTo(30);
    expect(profitFloor(12, params, true)).toMatchObject({ kind: 'level' });
    expect(profitFloor(12, params, true)?.floorPct).toBeCloseTo(9.6);
  });

  it('with the buy price, moves the floor up to buy + ₹10 once the option has gained ₹10', () => {
    // ₹151.85 bought: ₹10 is 6.59%, below the +8% break-even start.
    expect(profitFloor(6.5, params, false, 151.85)).toBeNull();
    expect(profitFloor(6.6, params, false, 151.85)).toMatchObject({ kind: 'lock' });
    expect(profitFloor(6.6, params, false, 151.85)?.floorPct).toBeCloseTo((10 / 151.85) * 100);
    // ₹100 bought: a +12% best locks +10%, above the 6% trail; at +30% the trail keeps more.
    expect(profitFloor(12, params, false, 100)).toEqual({ floorPct: 10, kind: 'lock' });
    expect(profitFloor(30, params, false, 100)).toMatchObject({ kind: 'trail' });
  });

  it('still follows a review-tuned trailKeepFraction', () => {
    expect(profitFloor(12, { ...params, trailKeepFraction: 0.7 })?.floorPct).toBeCloseTo(8.4);
    expect(profitFloor(30, { ...params, trailKeepFraction: 0.7 })?.floorPct).toBeCloseTo(21);
  });
});

describe('plain-English rationale', () => {
  const now = ist('2026-10-21', '10:30');
  const candidate: ContractCandidate = {
    symbol: 'NIFTY26OCT25000CE',
    index: 'NIFTY',
    side: 'CE',
    strike: 25_000,
    expiry: '2026-10-27',
    token: 1,
    lotSize: 65,
    ltp: 120,
    bid: 119.8,
    ask: 120.2,
    spreadPct: 0.33,
    oi: 5_000_000,
    volume: 50_000,
    delta: 0.52,
    ivToHv: 1.05,
    stepsFromAtm: 0,
    moneyness: 'at the money',
    feeInr: 66,
    plan: null,
    rank: 1,
  };
  const { data, backdrop } = bullishMarket();
  const marketReading = readIndex(data, backdrop, params, now);
  const position: OpenPosition = {
    symbol: candidate.symbol,
    index: 'NIFTY',
    side: 'CE',
    strike: 25_000,
    expiry: '2026-10-27',
    token: 1,
    entryPrice: 120.2,
    enteredAt: now,
    peakPrice: 150,
    troughPrice: 118,
    lotSize: 65,
    entryDelta: 0.52,
    entrySpot: 25_000,
    stopSpot: null,
    premiumStop: null,
  };

  it('explains every action without trading jargon', () => {
    const texts = [
      describeBuy({
        now,
        candidate,
        fillPrice: 120.2,
        reading: marketReading,
        pickedBy: 'llm',
        candidateCount: 3,
        params,
      }),
      describeSkip({
        now,
        blockedBy: ['chasing', 'near-big-level'],
        leaning: { index: 'NIFTY', side: 'CE', score: 5 },
        reading: marketReading,
        params,
      }),
      describeHold({ position, price: 140, netPnlInr: 1_220, reading: marketReading, params }),
      describeExit({
        now: ist('2026-10-21', '11:10'),
        position,
        exitPrice: 135,
        reason: 'trailing-stop',
        netPnlInr: 900,
        params,
      }),
      describeExit({
        now: ist('2026-10-21', '10:45'),
        position,
        exitPrice: 104,
        reason: 'index-stop',
        netPnlInr: -1_100,
        params,
      }),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(JARGON);
      expect(text.length).toBeLessThanOrEqual(1200);
    }
    expect(texts[0]).toContain(
      'Bought 1 lot (65 units) of NIFTY 25,000 Call (expires 27 Oct) at ₹120.20',
    );
    expect(texts[0]).toContain('sell by 3:15 PM');
    expect(texts[0]).toContain('or if NIFTY falls to 24,963 (0.15% against us), protect profits');
    expect(texts[4]).toContain('the index moved 0.15% against the trade');
    expect(texts[1]).toMatch(/^No trade at 10:30 AM\. NIFTY is leaning upward/);
    expect(texts[0]).toContain('NIFTY has room to rise to 25,250 (1.00% away)');
    expect(texts[2]).toContain('or if NIFTY falls to 24,963 (0.15% against us)');
    expect(texts[2]).toContain('₹');
    expect(texts[3]).toContain('fell back from its best level of ₹150.00');
  });

  it('explains the break-even lock and the new exits in plain words', () => {
    const buy = describeBuy({
      now,
      candidate,
      fillPrice: 120.2,
      reading: marketReading,
      pickedBy: 'llm',
      candidateCount: 3,
      params,
    });
    // Best +8.2% (₹9.80, short of the ₹10 lock): the exit has moved to cost plus 2% (₹122.60).
    const hold = describeHold({
      position: { ...position, peakPrice: 130 },
      price: 125,
      netPnlInr: 250,
      reading: null,
      params,
    });
    const exits = (['breakeven-stop', 'level-reached'] as const).map((reason) =>
      describeExit({
        now: ist('2026-10-21', '11:10'),
        position,
        exitPrice: 128,
        reason,
        netPnlInr: 450,
        params,
      }),
    );
    const overnight = describeExit({
      now: ist('2026-10-21', '15:15'),
      position,
      exitPrice: 133.5,
      reason: 'stale-position',
      netPnlInr: 800,
      params,
      pricedAtSquareOff: true,
    });
    for (const text of [buy, hold, ...exits, overnight]) {
      expect(text).not.toMatch(JARGON);
      expect(text.length).toBeLessThanOrEqual(1200);
    }
    expect(buy).toContain('(−20%)');
    expect(buy).toContain('reaches ₹129.82 (+8%) by moving the exit up to ₹122.60');
    expect(hold).toContain(
      'the exit has moved up to ₹122.60 so this trade cannot turn into a loss',
    );
    expect(exits[0]).toContain('fell back to our break-even exit');
    expect(exits[1]).toContain('option sellers are betting it will not cross');
    expect(overnight).toContain('recorded at its 3:15 PM price on the day it was bought');
  });

  it('states the chart stop, the planned loss, the target and the ₹10 lock on a BUY', () => {
    const plan = {
      stopSpot: 24_983.4,
      targetSpot: 25_060,
      riskPoints: 16.6,
      rewardPoints: 60,
      rewardPerUnit: 30.8,
      riskPerUnit: 9.03,
      premiumStop: 111.15,
      lockPrice: 130.2,
      maxLossInr: 657.4,
      lockedProfitInr: 576.3,
    };
    const chartReading = reading({ chart: chartRead() });
    const buy = describeBuy({
      now,
      candidate: { ...candidate, plan },
      fillPrice: 120.2,
      reading: chartReading,
      pickedBy: 'llm',
      candidateCount: 3,
      params,
    });
    expect(buy).not.toMatch(JARGON);
    expect(buy.length).toBeLessThanOrEqual(1200);
    expect(buy.endsWith('…')).toBe(false);
    expect(buy).toContain(
      'Plan: sell if NIFTY falls below 24,983 (under the low of the last two 5-minute candles) or the option falls to ₹111.15, a planned loss of about ₹657.40 on 1 lot after charges.',
    );
    expect(buy).toContain(
      'Next level: 25,060 (a recent high where it turned back), 60 points away',
    );
    expect(buy).toContain('(4.0× the risk)');
    expect(buy).toContain(
      'Once it reaches ₹130.20 (₹10 above the buy price), the exit moves up to ₹130.20, locking about ₹576.30 after charges',
    );
    expect(buy).toContain(
      'Chart: the last 5-minute candles show a strong up candle with almost no pullback',
    );

    const stops = { ...position, stopSpot: 24_983.4, premiumStop: 111.15 };
    const armed = describeHold({
      position: { ...stops, peakPrice: 131 },
      price: 130.5,
      netPnlInr: 600,
      reading: null,
      params,
    });
    expect(armed).toContain('Exit if NIFTY falls below 24,983 or the option falls to ₹111.15');
    expect(armed).toContain('the ₹10 profit lock is on, so it sells below ₹130.20');
    const early = describeHold({
      position: { ...stops, peakPrice: 123 },
      price: 122,
      netPnlInr: 80,
      reading: null,
      params,
    });
    expect(early).toContain(
      'profit protection starts at ₹129.82 and the ₹10 profit lock at ₹130.20',
    );

    const lockExit = describeExit({
      now: ist('2026-10-21', '10:50'),
      position: { ...stops, peakPrice: 131 },
      exitPrice: 130.15,
      reason: 'profit-lock',
      netPnlInr: 570,
      params,
    });
    expect(lockExit).toContain(
      'the option had gained ₹10 and slipped back to the profit lock at ₹130.20, so the gain was kept',
    );
    const chartExit = describeExit({
      now: ist('2026-10-21', '10:45'),
      position: stops,
      exitPrice: 112,
      reason: 'chart-stop',
      netPnlInr: -600,
      params,
    });
    expect(chartExit).toContain('NIFTY fell below 24,983, past the low that supported the trade');
    expect(chartExit).toMatch(/The planned loss limit was about ₹\d/);
    for (const text of [armed, early, lockExit, chartExit]) {
      expect(text).not.toMatch(JARGON);
    }
  });

  it('explains the reward-to-risk and day-profit skips in plain words', () => {
    const skip = describeSkip({
      now,
      blockedBy: ['low-reward', 'day-in-profit'],
      leaning: { index: 'NIFTY', side: 'PE', score: -5 },
      reading: marketReading,
      params,
    });
    expect(skip).not.toMatch(JARGON);
    expect(skip).toContain('the possible gain is less than 1.5× the loss at our stop');
    expect(skip).toContain("today's closed trades are already in profit, so we stop for the day");
  });
});
