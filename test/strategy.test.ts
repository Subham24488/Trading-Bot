import { describe, expect, it } from 'vitest';
import type { IntradayBar } from '../src/universe/types.js';


import { readChart, type ChartPlan, type ChartRead } from '../src/strategy/chart.js';
import { msUntilNextCycle } from '../src/strategy/clock.js';
import type { ChainQuote, ContractCandidate } from '../src/strategy/contracts.js';
import {
  checkPositionExit,
  checkStopOrder,
  decideEntry,
  levelRoomPct,
  profitFloor,
  profitLockLevelInr,
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
import { checkRangeDay, checkTrendDay, type TrendDay } from '../src/strategy/trendDay.js';
import type { SetupSignal } from '../src/strategy/setups.js';
import {
  fiveMinuteBars,
  ist,
  MOMENTUM_RULES,
  steppingBars,
  uptrendFuturesBars,
} from './marketFixtures.js';

/** Most suites check the earlier vote-led rules; the pullback suites use the defaults. */
const params = MOMENTUM_RULES;
const current = DEFAULT_STRATEGY;
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
      dailyBars: [],
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
    dayAverage: null,
    futuresPrice: 25_060,
    vwap: 25_030,
    callWall: 25_300,
    putWall: 24_700,
    pcr: 1.1,
    expiryToday: false,
    newsLevel: 'none',
    coreDataOk: true,
    trendDay: null,
    trendDayEntry: null,
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

  it('buys puts below the 20-day average, and above it only with at least 5 of the 8 signals on their side', () => {
    const allBearish = Object.fromEntries(SIGNAL_NAMES.map((name) => [name, -1])) as Record<
      SignalName,
      Vote
    >;
    // Four signals point down and four nowhere.
    const fourBearish = {
      ...allBearish,
      optionFlow: 0,
      volume: 0,
      breadth: 0,
      globalMood: 0,
    } as const;
    const decide = (votes: Record<SignalName, Vote>, dayAverage: number | null) =>
      decideEntry(
        { now, readings: [reading({ votes, dayAverage })], day: quietDay, vixPct: 0 },
        params,
      );
    // NIFTY is at 25,000.
    expect(decide(fourBearish, 25_100)).toMatchObject({ action: 'BUY', side: 'PE' });
    expect(decide(fourBearish, null)).toMatchObject({ action: 'BUY', side: 'PE' });
    expect(decide(fourBearish, 24_900)).toMatchObject({
      action: 'SKIP',
      blockedBy: ['against-day-average'],
    });
    // All 8 signals point down: strong enough to buy a put above the 20-day average.
    expect(decide(allBearish, 24_900)).toMatchObject({ action: 'BUY', side: 'PE' });
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
      { day: { ...quietDay, lastExitAt: new Date(now.getTime() - 9 * 60_000) } },
      'cooldown',
    ],
    ['with two opposing signals', { votes: { breadth: -1, globalMood: -1 } }, 'too-many-opposing'],
    ['against the trend', { votes: { trend: -1 } }, 'trend-disagrees'],
    ['when chasing a stretched move', { rsi: 80 }, 'chasing'],
    [
      'a call below its 20-day average with only 4 of the 8 signals on its side',
      { dayAverage: 25_100, votes: { optionFlow: 0, volume: 0, breadth: 0, globalMood: 0 } },
      'against-day-average',
    ],
  ] as const)('skips %s', (_label, scenario, gate) => {
    const scenarioReading = reading({
      expiryToday: 'expiry' in scenario,
      ...('votes' in scenario ? { votes: scenario.votes } : {}),
      ...('rsi' in scenario ? { rsi: scenario.rsi } : {}),
      ...('dayAverage' in scenario ? { dayAverage: scenario.dayAverage } : {}),
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

  it('skips a NIFTY trade while Bank NIFTY moves the other way', () => {
    const gates = (
      bankNiftyMovePct: number | null,
      votes: Partial<Record<SignalName, Vote>> = {},
    ) => {
      const decision = decideEntry(
        { now, readings: [reading({ bankNiftyMovePct, votes })], day: quietDay, vixPct: 0 },
        params,
      );
      return decision.action === 'SKIP' ? decision.blockedBy : [];
    };
    // A call while Bank NIFTY fell 0.12% in the last 30 minutes.
    expect(gates(-0.12)).toContain('bank-nifty-disagrees');
    expect(gates(-0.05)).not.toContain('bank-nifty-disagrees');
    expect(gates(0.3)).not.toContain('bank-nifty-disagrees');
    expect(gates(null)).not.toContain('bank-nifty-disagrees');
    // A put while Bank NIFTY rose 0.2%.
    const bearish = Object.fromEntries(SIGNAL_NAMES.map((name) => [name, -1]));
    expect(gates(0.2, bearish)).toContain('bank-nifty-disagrees');
  });

  it('does not buy straight after India VIX jumps 5% in 30 minutes, calls or puts', () => {
    const gates = (vixMovePct: number, votes: Partial<Record<SignalName, Vote>> = {}) => {
      const decision = decideEntry(
        { now, readings: [reading({ vixMovePct, votes })], day: quietDay, vixPct: 0 },
        params,
      );
      return decision.action === 'SKIP' ? decision.blockedBy : [];
    };
    expect(gates(5.5)).toContain('after-vix-spike');
    expect(gates(4)).not.toContain('after-vix-spike');
    const bearish = Object.fromEntries(SIGNAL_NAMES.map((name) => [name, -1]));
    expect(gates(6, bearish)).toContain('after-vix-spike');
  });

  it('does not buy from 30 minutes before a scheduled announcement until 30 minutes after', () => {
    const withEvent = { ...params, scheduledEvents: ['2026-10-21 10:00'] };
    const blocked = (at: string) => {
      const decision = decideEntry(
        { now: ist('2026-10-21', at), readings: [reading({})], day: quietDay, vixPct: 0 },
        withEvent,
      );
      return decision.action === 'SKIP' && decision.blockedBy.includes('scheduled-event');
    };
    expect(blocked('09:31')).toBe(true);
    expect(blocked('10:29')).toBe(true);
    expect(blocked('10:30')).toBe(false);
    expect(blocked('09:30')).toBe(false);
  });

  it('waits 10 minutes after a sale before buying again', () => {
    const coolingDown = (minutesSinceSale: number) => {
      const decision = decideEntry(
        {
          now,
          readings: [reading({})],
          day: { ...quietDay, lastExitAt: new Date(now.getTime() - minutesSinceSale * 60_000) },
          vixPct: 0,
        },
        params,
      );
      return decision.action === 'SKIP' && decision.blockedBy.includes('cooldown');
    };
    expect(coolingDown(9)).toBe(true);
    expect(coolingDown(10)).toBe(false);
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
      shapeConfirms: 'CE',
      closeLocation: 0.9,
      rangeAtr: 1.1,
      volumeRatio: 1.4,
      atLevel: "today's average price",
      ...candle,
    },
    support: { price: 24_985, kind: 'swing-low' },
    resistance: { price: 25_060, kind: 'swing-high' },
    plans: { CE: sidePlan('CE'), PE: sidePlan('PE') },
    basis: 60,
    swings: { highs: [], lows: [] },
    valueGapAtr: 0.3,
    trendAverage: null,
    fifteenMinuteCandle: null,
    fifteenMinuteAtr: null,
    ...rest,
  };
}

describe('candle rules', () => {
  const now = ist('2026-10-21', '10:30');
  const decide = (chart: ChartRead) =>
    decideEntry({ now, readings: [reading({ chart })], day: quietDay, vixPct: 0 }, current);
  const blockedBy = (chart: ChartRead) => {
    const decision = decide(chart);
    return decision.action === 'SKIP' ? decision.blockedBy : [];
  };

  it('buys a pullback on a bullish marubozu that closes strongly at a level', () => {
    expect(decide(chartRead())).toMatchObject({ action: 'BUY', side: 'CE' });
  });

  it('does not count three rising closes, which are not one of the confirming candles', () => {
    const push = {
      pattern: 'three_bar_push_up',
      side: null,
      confirms: null,
      shapeConfirms: null,
    } as const;
    expect(blockedBy(chartRead({ candle: push }))).toContain('no-candle-confirmation');
  });

  it('waits on a doji: the move is pausing', () => {
    const doji = { pattern: 'doji', side: null, confirms: null, shapeConfirms: null } as const;
    expect(blockedBy(chartRead({ candle: doji }))).toContain('doji-wait');
  });

  it('does not count a confirming candle away from every level', () => {
    expect(blockedBy(chartRead({ candle: { atLevel: null } }))).toContain('candle-not-at-level');
  });

  it('does not trade when the 15-minute and 5-minute candles point opposite ways', () => {
    const chart = chartRead({ fifteenMinuteCandle: { pattern: 'bearish_engulfing', side: 'PE' } });
    expect(blockedBy(chart)).toContain('candles-disagree');
    const agreeing = chartRead({ fifteenMinuteCandle: { pattern: 'bull_marubozu', side: 'CE' } });
    expect(decide(agreeing)).toMatchObject({ action: 'BUY', side: 'CE' });
  });

  it('explains the doji, level and disagreeing-candle skips in plain words', () => {
    const skip = describeSkip({
      now,
      blockedBy: ['doji-wait', 'candle-not-at-level', 'candles-disagree'],
      leaning: { index: 'NIFTY', side: 'CE', score: 4 },
      reading: reading({}),
      params: current,
    });
    expect(skip).not.toMatch(JARGON);
    expect(skip).toContain('a sign the move is pausing, so we wait');
    expect(skip).toContain('away from a level a candle is just noise');
    expect(skip).toContain(
      'the last 15-minute candle and the last 5-minute candle point opposite ways',
    );
  });
});

describe('chart setups in the entry decision', () => {
  const now = ist('2026-10-21', '10:45');
  const signal = (kind: SetupSignal['kind'], side: 'CE' | 'PE'): SetupSignal => ({
    kind,
    side,
    stopSpot: side === 'CE' ? 24_970 : 25_030,
    stopName: 'the setup level',
    targetSpot: side === 'CE' ? 25_060 : 24_940,
    reason: 'a setup',
  });
  const quiet = Object.fromEntries(SIGNAL_NAMES.map((name) => [name, 0]));
  const trendUp: TrendDay = { side: 'CE', flaggedAtMinute: 600, reasons: ['a', 'b', 'c'] };
  const decide = (overrides: Partial<IndexReading>) =>
    decideEntry(
      {
        now,
        readings: [reading({ votes: quiet, chart: chartRead({ valueGapAtr: 3 }), ...overrides })],
        day: quietDay,
        vixPct: 0,
      },
      current,
    );
  const blockedBy = (overrides: Partial<IndexReading>) => {
    const decision = decide(overrides);
    return decision.action === 'SKIP' ? decision.blockedBy : [];
  };

  it('buys a failed breakout on a range-bound day without waiting for a pullback or the votes', () => {
    expect(decide({ dayType: 'range', setup: signal('failed-breakout', 'PE') })).toMatchObject({
      action: 'BUY',
      side: 'PE',
    });
  });

  it('buys a flag only on a trend day in its direction, with the 15-minute trend agreeing', () => {
    const flag = signal('flag', 'CE');
    expect(decide({ dayType: 'trend', trendDay: trendUp, setup: flag })).toMatchObject({
      action: 'BUY',
      side: 'CE',
    });
    expect(blockedBy({ dayType: 'range', setup: flag })).toContain('not-for-this-day-type');
    const trendDown = chartRead({ valueGapAtr: 3, higherTrend: 'down' });
    expect(blockedBy({ dayType: 'trend', trendDay: trendUp, setup: flag, chart: trendDown })).toContain(
      'chart-trend-disagrees',
    );
  });

  it('takes no double bottom or failed breakout on a trend day', () => {
    const trendDown: TrendDay = { side: 'PE', flaggedAtMinute: 600, reasons: ['a', 'b', 'c'] };
    expect(
      blockedBy({ dayType: 'trend', trendDay: trendDown, setup: signal('failed-breakout', 'PE') }),
    ).toContain('not-for-this-day-type');
    expect(
      blockedBy({ dayType: 'trend', trendDay: trendUp, setup: signal('double-bottom', 'CE') }),
    ).toContain('not-for-this-day-type');
  });

  it('sells a range-day setup at its target on the index, even after the profit lock has armed', () => {
    const position: OpenPosition = {
      symbol: 'NIFTY26OCT25000CE',
      index: 'NIFTY',
      side: 'CE',
      strike: 25_000,
      expiry: '2026-10-27',
      token: 1,
      entryPrice: 120.2,
      enteredAt: ist('2026-10-21', '10:45'),
      peakPrice: 135,
      troughPrice: 120.2,
      lotSize: 65,
      entryDelta: 0.45,
      entrySpot: 25_000,
      stopSpot: 24_970,
      premiumStop: 110.2,
      targetSpot: 25_060,
    };
    const at = (spot: number) =>
      checkPositionExit(
        { now: ist('2026-10-21', '11:15'), position, price: 134, spot },
        current,
      );
    expect(at(25_061)).toEqual({ action: 'EXIT', reason: 'target-reached' });
    expect(at(25_055)).toEqual({ action: 'HOLD' });
  });
});

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
    expect(decision).toMatchObject({
      action: 'SKIP',
      blockedBy: expect.arrayContaining(['chasing', 'low-reward']),
    });
    // The pullback rules skip it too: no clear 15-minute trend, and nothing came back to value.
    const pullback = decideEntry(
      {
        now: ist('2026-11-09', '10:45'),
        readings: [reading({ spot: 24_855.15, rsi: 33, putWall: 24_800, callWall: 25_000, chart })],
        day: quietDay,
        vixPct: -6,
      },
      current,
    );
    expect(pullback.action === 'SKIP' && pullback.blockedBy).toContain('no-pullback');
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
    expect(decision).toMatchObject({
      action: 'SKIP',
      blockedBy: expect.arrayContaining(['near-chart-level']),
    });
    const pullback = decideEntry(
      {
        now: ist('2026-11-11', '11:20'),
        readings: [reading({ spot: 25_384.5, callWall: 25_500, putWall: 25_300, chart })],
        day: quietDay,
        vixPct: 0,
      },
      current,
    );
    expect(pullback.action === 'SKIP' && pullback.blockedBy).toContain('no-pullback');
  });
});

describe('pullback entries (the defaults)', () => {
  const now = ist('2026-11-13', '10:55');
  /** 11-13 10:55: the 15-minute trend was down and NIFTY had bounced back to its average. */
  const bounceInDowntrend = (
    chart: Partial<Omit<ChartRead, 'candle'>> & {
      candle?: Partial<ChartRead['candle']>;
    } = {},
  ) =>
    chartRead({
      higherTrend: 'down',
      structure: 'up',
      valueGapAtr: 0.2,
      burstAtr: -0.5,
      ...chart,
      candle: {
        pattern: 'bear_marubozu',
        side: 'PE',
        confirms: null,
        shapeConfirms: 'PE',
        volumeRatio: 0.45,
        ...chart.candle,
      },
    });
  // Votes leaning down, −3, like the winning 11-12 and 11-13 puts.
  const bearishVotes = {
    averagePrice: -1,
    trend: -1,
    openingRange: 0,
    volume: 0,
    optionFlow: -1,
    futuresPositioning: 0,
    breadth: 0,
    globalMood: 0,
  } as const;
  // A bounce that turned the price votes up: +5 against the put.
  const bullishVotes = {
    averagePrice: 1,
    trend: 1,
    openingRange: 1,
    volume: 1,
    optionFlow: 1,
    futuresPositioning: 0,
    breadth: 0,
    globalMood: 0,
  } as const;
  const decide = (chart: ChartRead, votes: Partial<Record<SignalName, Vote>> = bearishVotes) =>
    decideEntry(
      {
        now,
        readings: [
          reading({
            votes,
            rsi: 55,
            chart,
            lastCandle: { pattern: chart.candle.pattern, side: chart.candle.side },
          }),
        ],
        day: quietDay,
        vixPct: 0,
      },
      current,
    );

  it('buys a put on a bounce to value in a 15-minute downtrend when the votes agree', () => {
    // Swings up and below-usual volume no longer block a pullback.
    expect(decide(bounceInDowntrend())).toMatchObject({ action: 'BUY', side: 'PE' });
  });

  it('skips when the 8 votes lean the other way (6 of 8 such entries lost in the 10-day replay)', () => {
    expect(decide(bounceInDowntrend(), bullishVotes)).toMatchObject({
      action: 'SKIP',
      blockedBy: ['signals-disagree'],
    });
    const flat = { ...bearishVotes, averagePrice: 0, trend: 0, optionFlow: 0 } as const;
    expect(decide(bounceInDowntrend(), flat)).toMatchObject({
      action: 'SKIP',
      blockedBy: ['signals-disagree'],
    });
    expect(decide(bounceInDowntrend(), { ...flat, trend: -1 })).toMatchObject({ action: 'BUY' });
    const text = describeSkip({
      now,
      blockedBy: ['signals-disagree'],
      leaning: { index: 'NIFTY', side: 'PE', score: 5 },
      reading: reading({ chart: bounceInDowntrend() }),
      params: current,
    });
    expect(text).toContain('the 8 market signals lean the other way');
  });

  it('accepts a shallower pullback, up to 1 normal swing from value, when the votes agree strongly', () => {
    // 2026-11-05: votes +5 to +7 all day, the price never back within 0.5 of value.
    const strongVotes = { ...bearishVotes, openingRange: -1, volume: -1 } as const;
    const shallow = bounceInDowntrend({ valueGapAtr: 0.8 });
    expect(decide(shallow, strongVotes)).toMatchObject({ action: 'BUY', side: 'PE' });
    expect(decide(shallow)).toMatchObject({ action: 'SKIP', blockedBy: ['no-pullback'] });
    expect(decide(bounceInDowntrend({ valueGapAtr: 1.2 }), strongVotes)).toMatchObject({
      action: 'SKIP',
      blockedBy: ['no-pullback'],
    });
  });

  it.each([
    ['without a clear 15-minute trend', bounceInDowntrend({ higherTrend: 'flat' }), 'no-pullback'],
    ['before the price is back near value', bounceInDowntrend({ valueGapAtr: 0.8 }), 'no-pullback'],
    [
      'without a candle turning back down',
      bounceInDowntrend({ candle: { shapeConfirms: null } }),
      'no-candle-confirmation',
    ],
    ['on a climax run down', bounceInDowntrend({ burstAtr: -3 }), 'chasing'],
  ] as const)('skips %s', (_label, chart, gate) => {
    const decision = decide(chart);
    expect(decision.action === 'SKIP' && decision.blockedBy).toContain(gate);
  });

  it('ignores a swing level just ahead and a short room to it', () => {
    // 11-13 10:55: a swing low 13 points below; the put still reached +₹15.
    const crowded = bounceInDowntrend({
      plan: {
        nearLevel: { price: 24_998, kind: 'swing-low' },
        rewardPoints: 13,
        rewardToRisk: 0.6,
      },
    });
    expect(decide(crowded)).toMatchObject({ action: 'BUY', side: 'PE' });
  });

  it('counts only the market backdrop votes as opposing: two against is too many', () => {
    // Large stocks and global mood both up: two backdrop votes against the put.
    expect(
      decide(bounceInDowntrend(), { ...bearishVotes, breadth: 1, globalMood: 1 }),
    ).toMatchObject({ action: 'SKIP', blockedBy: ['too-many-opposing'] });
    expect(decide(bounceInDowntrend(), { ...bearishVotes, breadth: 1 })).toMatchObject({
      action: 'BUY',
    });
  });

  it('records the trend side as the leaning and says so in plain words', () => {
    const decision = decide(bounceInDowntrend({ valueGapAtr: 0.8 }));
    expect(decision).toMatchObject({ action: 'SKIP', leaning: { side: 'PE' } });
    if (decision.action === 'SKIP') {
      const text = describeSkip({ now, ...decision, params: current });
      expect(text).toContain('The 15-minute trend for NIFTY points down');
      expect(text).toContain('come back to its average');
      expect(text).not.toMatch(JARGON);
    }
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
      'hold at the planned loss limit: that sale belongs to the stop-loss order',
      { now: '10:10', price: 92, spot: 24_990, stopSpot: 24_985, premiumStop: 92 },
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

describe('checkPositionExit with the ₹10-step profit ratchet and pullback rules', () => {
  const position: OpenPosition = {
    symbol: 'NIFTY26N1725150PE',
    index: 'NIFTY',
    side: 'PE',
    strike: 25_150,
    expiry: '2026-11-17',
    token: 1,
    entryPrice: 120.3,
    enteredAt: ist('2026-11-13', '10:55'),
    peakPrice: 120.3,
    troughPrice: 120.3,
    lotSize: 65,
    entryDelta: 0.41,
    entrySpot: 25_225,
    stopSpot: 25_260,
    premiumStop: 110.3,
  };
  const at = (
    time: string,
    price: number,
    reading: IndexReading | null = null,
    peakPrice = Math.max(120.3, price),
    spot = 25_200,
  ) =>
    checkPositionExit(
      { now: ist('2026-11-13', time), position: { ...position, peakPrice }, price, spot, reading },
      current,
    );

  it('moves the stop to the buy price at +₹10, then ₹5 higher for every further ₹5 gain', () => {
    expect(profitLockLevelInr(120.3, 130.2, current)).toBeNull();
    expect(profitLockLevelInr(120.3, 130.3, current)).toBe(0);
    expect(profitLockLevelInr(120.3, 135.29, current)).toBe(0);
    expect(profitLockLevelInr(120.3, 135.3, current)).toBe(5);
    expect(profitLockLevelInr(120.3, 140.3, current)).toBe(10);
    expect(profitLockLevelInr(120.3, 150.29, current)).toBe(15);
    expect(profitLockLevelInr(120.3, 165.3, current)).toBe(35);
    // Best ₹130.30 (+₹10): the stop is at the buy price, so ₹125 still holds and ₹120.25 sells.
    expect(at('11:05', 125, null, 130.3)).toEqual({ action: 'HOLD' });
    expect(at('11:05', 120.3, null, 130.3)).toEqual({ action: 'HOLD' });
    expect(at('11:05', 120.25, null, 130.3)).toEqual({ action: 'EXIT', reason: 'profit-lock' });
    // Best ₹136 (+₹15.70): the stop is ₹5 above the buy price, at ₹125.30.
    expect(at('11:05', 126, null, 136)).toEqual({ action: 'HOLD' });
    expect(at('11:05', 125.25, null, 136)).toEqual({ action: 'EXIT', reason: 'profit-lock' });
    // Best ₹141 (+₹20.70): the stop is ₹10 above the buy price, at ₹130.30.
    expect(at('11:05', 130.3, null, 141)).toEqual({ action: 'HOLD' });
    expect(at('11:05', 130.25, null, 141)).toEqual({ action: 'EXIT', reason: 'profit-lock' });
    // There is no target sell however high it goes.
    expect(at('11:05', 200)).toEqual({ action: 'HOLD' });
  });

  it('triggers the lock on the last traded price, like a GTT, not on a bid a few paise lower', () => {
    const check = (bid: number, lastPrice: number) =>
      checkPositionExit(
        {
          now: ist('2026-11-13', '11:05'),
          position: { ...position, peakPrice: 140.32 },
          price: bid,
          lastPrice,
          spot: 25_200,
        },
        current,
      );
    // Best +₹20.02: the lock is at ₹130.30. The bid is ₹130.22, the last trade ₹130.32.
    expect(check(130.22, 130.32)).toEqual({ action: 'HOLD' });
    expect(check(130.15, 130.25)).toEqual({ action: 'EXIT', reason: 'profit-lock' });
  });

  it('leaves the ₹10 stop to the stop-loss order: a review holds at that price', () => {
    expect(at('11:05', 110.3)).toEqual({ action: 'HOLD' });
  });

  it('lets only the ratchet and the 3:15 PM square-off close an armed trade', () => {
    const turned = reading({ chart: chartRead({ higherTrend: 'up' }), newsLevel: 'high' });
    // 2 hours in, trend turned, major news, NIFTY above the chart stop: still held above the lock.
    expect(at('12:55', 131, turned, 132, 25_300)).toEqual({ action: 'HOLD' });
    expect(at('15:15', 131, turned, 132)).toEqual({ action: 'EXIT', reason: 'square-off' });
  });

  it('reverses only when the 15-minute trend turns, not on the price votes', () => {
    const bullishVotes = reading({ chart: chartRead({ higherTrend: 'down' }) });
    // All 8 votes point up after the minimum hold, but the 15-minute trend is still down.
    expect(at('11:15', 118, bullishVotes)).toEqual({ action: 'HOLD' });
    const turned = reading({ chart: chartRead({ higherTrend: 'up' }) });
    expect(at('11:15', 118, turned)).toEqual({ action: 'EXIT', reason: 'trend-reversal' });
  });
});

describe('20-day average', () => {
  it('is the average close of the last 20 days, and unknown with fewer', () => {
    const { data, backdrop } = bullishMarket();
    const now = ist('2026-10-21', '10:30');
    // 25 daily closes: 24,000, 24,010 … 24,240. The last 20 average 24,145.
    const dailyBars = Array.from({ length: 25 }, (_, day) => {
      const close = 24_000 + day * 10;
      return { d: `2026-09-${String(day + 1).padStart(2, '0')}`, o: close, h: close, l: close, c: close, v: 0 };
    });
    expect(readIndex({ ...data, dailyBars }, backdrop, current, now).dayAverage).toBeCloseTo(24_145);
    expect(
      readIndex({ ...data, dailyBars: dailyBars.slice(0, 19) }, backdrop, current, now).dayAverage,
    ).toBeNull();
  });
});

describe('checkStopOrder: the stop-loss order placed at BUY', () => {
  // Bought at ₹120.30: the order triggers at ₹110.30 and sells with a limit of ₹105.30.
  const position: OpenPosition = {
    symbol: 'NIFTY26N1725150PE',
    index: 'NIFTY',
    side: 'PE',
    strike: 25_150,
    expiry: '2026-11-17',
    token: 1,
    entryPrice: 120.3,
    enteredAt: ist('2026-11-13', '10:55'),
    peakPrice: 120.3,
    troughPrice: 120.3,
    lotSize: 65,
    entryDelta: 0.41,
    entrySpot: 25_225,
    stopSpot: 25_260,
    premiumStop: 110.3,
  };
  const candle = (open: number, low: number, close: number) => ({
    t: ist('2026-11-13', '11:04').toISOString(),
    o: open,
    h: Math.max(open, close),
    l: low,
    c: close,
    v: 1_000,
  });
  const check = (input: {
    time?: string;
    bars?: ReturnType<typeof candle>[];
    lastPrice: number;
    bid: number;
    reprice?: boolean;
    enteredAt?: Date;
    peakPrice?: number;
  }) =>
    checkStopOrder(
      {
        now: ist('2026-11-13', input.time ?? '11:05'),
        position: {
          ...position,
          enteredAt: input.enteredAt ?? position.enteredAt,
          peakPrice: input.peakPrice ?? position.peakPrice,
        },
        bars: input.bars ?? [],
        lastPrice: input.lastPrice,
        bid: input.bid,
        reprice: input.reprice ?? false,
      },
      current,
    );

  it('rests while the option trades above the stop', () => {
    expect(check({ bars: [candle(118, 110.35, 116)], lastPrice: 116, bid: 115.9 })).toEqual({
      action: 'HOLD',
    });
  });

  it('sells one tick under the stop, at the bid, when a candle traded down through it', () => {
    // The low touched ₹110.00 and the price came back to ₹116: the order had already sold.
    expect(check({ bars: [candle(118, 110, 116)], lastPrice: 116, bid: 115.9 })).toEqual({
      action: 'SOLD',
      price: 110.15,
    });
  });

  it('sells at the open, not at the stop, when a candle opened below it', () => {
    expect(check({ bars: [candle(108, 107, 107.5)], lastPrice: 107.5, bid: 107.4 })).toEqual({
      action: 'SOLD',
      price: 107.9,
    });
  });

  it('sells at the bid when only the quote shows a trade at the stop', () => {
    expect(check({ lastPrice: 110.3, bid: 110.2 })).toEqual({ action: 'SOLD', price: 110.2 });
  });

  it('stays unfilled under its ₹5 limit, then is re-priced to the bid', () => {
    const gapped = { bars: [candle(103, 102, 104)], lastPrice: 104, bid: 103.9 };
    expect(check(gapped)).toEqual({ action: 'UNFILLED' });
    expect(check({ ...gapped, reprice: true })).toEqual({ action: 'SOLD', price: 103.9 });
  });

  it('moves up to the buy price once the option has been ₹10 up, then ₹5 higher for every further ₹5', () => {
    // Never more than ₹10 up: the order still rests at ₹110.30.
    expect(check({ lastPrice: 120.3, bid: 120.2, peakPrice: 130 })).toEqual({ action: 'HOLD' });
    // Best ₹131 (+₹10.70): the order has moved up to the buy price, ₹120.30.
    expect(check({ lastPrice: 120.3, bid: 120.2, peakPrice: 131 })).toEqual({
      action: 'SOLD',
      price: 120.2,
    });
    // Best ₹136 (+₹15.70): ₹5 above the buy price, ₹125.30. A candle traded down to ₹125.
    expect(
      check({ bars: [candle(127, 125, 126)], lastPrice: 126, bid: 125.9, peakPrice: 136 }),
    ).toEqual({ action: 'SOLD', price: 125.15 });
    expect(check({ lastPrice: 126, bid: 125.9, peakPrice: 136 })).toEqual({ action: 'HOLD' });
  });

  it('closes a trade at 3:15 PM and one left open from an earlier day', () => {
    expect(check({ time: '15:15', lastPrice: 125, bid: 124.9 })).toEqual({
      action: 'EXIT',
      reason: 'square-off',
    });
    expect(
      check({ time: '09:20', lastPrice: 125, bid: 124.9, enteredAt: ist('2026-11-12', '14:00') }),
    ).toEqual({ action: 'EXIT', reason: 'stale-position' });
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

  it('explains a breakout buy on a trend day in plain words', () => {
    const { data, backdrop } = bullishMarket();
    const trendDay: TrendDay = {
      side: 'CE',
      flaggedAtMinute: 10 * 60,
      reasons: ['one', 'two', 'three'],
    };
    const breakout = readIndex(data, backdrop, current, now, trendDay);
    const stopSpot = breakout.chart?.plans.CE.stopSpot ?? NaN;
    const plan = {
      stopSpot,
      targetSpot: 25_060,
      riskPoints: 25_000 - stopSpot,
      rewardPoints: 60,
      rewardPerUnit: 30.8,
      riskPerUnit: 9.03,
      premiumStop: 110.2,
      lockPrice: 130.2,
      maxLossInr: 657.4,
      lockedProfitInr: 576.3,
      targetPrice: null,
      targetProfitInr: null,
    };
    const buy = describeBuy({
      now,
      candidate: { ...candidate, plan },
      fillPrice: 120.2,
      reading: breakout,
      candidateCount: 3,
      params: current,
    });
    expect(buy).not.toMatch(JARGON);
    expect(buy.length).toBeLessThanOrEqual(1200);
    expect(buy.endsWith('…')).toBe(false);
    expect(buy).toMatch(
      /Chart: today is a trend day upward \(flagged at 10:00 AM, all 3 checks agree\); NIFTY futures closed above the last hour's high \([\d,]+\) on 3\.0× the day's usual volume, so we bought without waiting for a pullback\./,
    );
    expect(buy).toContain("(just under the last hour's high, the level it broke)");
  });

  it('explains a failed-breakout buy on a range-bound day in plain words', () => {
    const setup: SetupSignal = {
      kind: 'failed-breakout',
      side: 'PE',
      stopSpot: 25_040,
      stopName: "the failed breakout's high",
      targetSpot: 24_960,
      reason:
        "NIFTY futures broke above yesterday's high (25,090) and a 15-minute bearish engulfing candle closed back below it, then a 5-minute candle closed below that candle",
    };
    const chart = chartRead({ plan: { stopSpot: 25_040, stopBeyondBrokenLevel: true } });
    const plan = {
      stopSpot: 25_040,
      targetSpot: 24_940,
      riskPoints: 40,
      rewardPoints: 60,
      rewardPerUnit: 30.8,
      riskPerUnit: 10,
      premiumStop: 110.2,
      lockPrice: 130.2,
      maxLossInr: 721.4,
      lockedProfitInr: -53.8,
      targetPrice: null,
      targetProfitInr: null,
    };
    const buy = describeBuy({
      now,
      candidate: { ...candidate, side: 'PE', symbol: 'NIFTY26OCT25000PE', plan },
      fillPrice: 120.2,
      reading: reading({ chart, setup, dayType: 'range' }),
      candidateCount: 3,
      params: current,
    });
    expect(buy).not.toMatch(JARGON);
    expect(buy).toContain(
      'Chart: NIFTY futures broke above yesterday\'s high (25,090) and a 15-minute bearish engulfing candle closed back below it, then a 5-minute candle closed below that candle, so we bought a put; on a range-bound day we sell at its target, 24,960.',
    );
    expect(buy).toContain("NIFTY rises above 25,040 (over the failed breakout's high)");
  });

  it('explains a shallow-pullback buy on a trend day in plain words', () => {
    const { data, backdrop } = bullishMarket();
    // Flat volume: no breakout.
    const futuresBars = data.futuresBars.map((bar) => ({ ...bar, v: 1_000 }));
    const futuresPrice =
      ema(
        futuresBars.map((bar) => bar.c),
        9,
      )! + 2;
    const trendDay: TrendDay = { side: 'CE', flaggedAtMinute: 10 * 60, reasons: ['a', 'b', 'c'] };
    const dip = readIndex(
      { ...data, futuresBars, futuresPrice, futuresVwap: futuresPrice - 30 },
      backdrop,
      current,
      now,
      trendDay,
    );
    expect(dip.trendDayEntry?.trigger).toBeNull();
    const buy = describeBuy({
      now,
      candidate: {
        ...candidate,
        plan: {
          stopSpot: 24_983.4,
          targetSpot: 25_060,
          riskPoints: 16.6,
          rewardPoints: 60,
          rewardPerUnit: 30.8,
          riskPerUnit: 10,
          premiumStop: 110.2,
          lockPrice: 130.2,
          maxLossInr: 721.4,
          lockedProfitInr: 576.3,
          targetPrice: null,
          targetProfitInr: null,
        },
      },
      fillPrice: 120.2,
      reading: dip,
      candidateCount: 3,
      params: current,
    });
    expect(buy).toContain(
      'Chart: today is a trend day upward, and NIFTY dipped to its 9-candle average instead of coming all the way back to its average price',
    );
    expect(buy).not.toMatch(JARGON);
    expect(buy.length).toBeLessThanOrEqual(1200);
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
      targetPrice: null,
      targetProfitInr: null,
    };
    const chartReading = reading({ chart: chartRead() });
    const buy = describeBuy({
      now,
      candidate: { ...candidate, plan },
      fillPrice: 120.2,
      reading: chartReading,
      candidateCount: 3,
      params,
    });
    expect(buy).not.toMatch(JARGON);
    expect(buy.length).toBeLessThanOrEqual(1200);
    expect(buy.endsWith('…')).toBe(false);
    expect(buy).toContain(
      'Plan: sell if NIFTY falls below 24,983 (under the low of the last two 5-minute candles); a stop-loss order sells if the option trades at ₹111.15, a planned loss of about ₹657.40 on 1 lot after charges.',
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
    expect(armed).toContain(
      'Exit if NIFTY falls below 24,983; the stop-loss order sells if the option trades at ₹111.15',
    );
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
      'the option had gained ₹10.80 and slipped back to its profit lock at ₹130.20 (₹10 above the buy price), so the gain was kept',
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

  it('states the ₹10 stop, the stop moving to the buy price at +₹10 and the pullback on a BUY with the defaults', () => {
    const plan = {
      stopSpot: 24_983.4,
      targetSpot: 25_060,
      riskPoints: 16.6,
      rewardPoints: 60,
      rewardPerUnit: 30.8,
      riskPerUnit: 10,
      premiumStop: 110.2,
      lockPrice: 130.2,
      maxLossInr: 721.4,
      lockedProfitInr: -53.8,
      targetPrice: null,
      targetProfitInr: null,
    };
    const buy = describeBuy({
      now,
      candidate: { ...candidate, plan },
      fillPrice: 120.2,
      reading: reading({ chart: chartRead() }),
      candidateCount: 3,
      params: current,
    });
    expect(buy).not.toMatch(JARGON);
    expect(buy.length).toBeLessThanOrEqual(1200);
    expect(buy.endsWith('…')).toBe(false);
    expect(buy).toContain(
      'Plan: a stop-loss order sells if the option trades at ₹110.20 (₹10 below the buy price), a planned loss of about ₹721.40 on 1 lot after charges, or we sell earlier if NIFTY falls below 24,983',
    );
    expect(buy).toContain(
      'Once it reaches ₹130.20 (₹10 above the buy price), the stop-loss order moves up to the buy price, ₹120.20 (about −₹53.80 after charges), then ₹5 higher for every further ₹5 gain; it is never sold at a target.',
    );
    expect(buy).toContain(
      'Chart: the 15-minute trend is up and NIFTY came back to its average price; the last 5-minute candles show a strong up candle',
    );
    const hold = describeHold({
      position: { ...position, peakPrice: 125, stopSpot: 24_983.4, premiumStop: 110.2 },
      price: 124,
      netPnlInr: 180,
      reading: null,
      params: current,
    });
    expect(hold).toContain('the stop-loss order sells if the option trades at ₹110.20');
    expect(buy).toContain('It was the best-ranked of 3 options that passed our checks.');
    expect(hold).not.toContain('takes profit');
    const armed = describeHold({
      position: { ...position, peakPrice: 137 },
      price: 136,
      netPnlInr: 900,
      reading: null,
      params: current,
    });
    // Best ₹137 (+₹16.80): the stop-loss order is ₹5 above the buy price.
    expect(armed).toContain(
      'the stop-loss order has moved up to ₹125.20 (₹5 above the buy price) and rises ₹5 with every further ₹5 gain',
    );
    expect(armed).toContain('Safety exit at ₹125.20');
    const exit = describeExit({
      now: ist('2026-10-21', '10:50'),
      position: { ...position, peakPrice: 142 },
      exitPrice: 130.1,
      reason: 'profit-lock',
      netPnlInr: 560,
      params: current,
    });
    expect(exit).toContain(
      'the option had gained ₹21.80 and slipped back to its profit lock at ₹130.20 (₹10 above the buy price)',
    );
    const atBuyPrice = describeExit({
      now: ist('2026-10-21', '10:50'),
      position: { ...position, peakPrice: 131 },
      exitPrice: 120.1,
      reason: 'profit-lock',
      netPnlInr: -60,
      params: current,
    });
    expect(atBuyPrice).toContain(
      'the option had gained ₹10.80 and slipped back to the buy price, ₹120.20, where its stop-loss order moved once it was ₹10 up, so the trade did not turn into a loss before charges',
    );
    for (const text of [hold, armed, exit, atBuyPrice]) {
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

  it('explains the Bank NIFTY, India VIX, announcement and 20-day skips in plain words', () => {
    const skip = describeSkip({
      now,
      blockedBy: ['bank-nifty-disagrees', 'after-vix-spike', 'scheduled-event'],
      leaning: { index: 'NIFTY', side: 'CE', score: 4 },
      reading: marketReading,
      params: current,
    });
    expect(skip).not.toMatch(JARGON);
    expect(skip).toContain(
      'Bank NIFTY is moving the other way (0.1% or more in the last 30 minutes)',
    );
    expect(skip).toContain('the fear index (India VIX) jumped 5% or more in the last 30 minutes');
    expect(skip).toContain(
      'a scheduled announcement, such as an RBI policy decision, is less than 30 minutes away',
    );
    const against = describeSkip({
      now,
      blockedBy: ['against-day-average'],
      leaning: { index: 'NIFTY', side: 'CE', score: 4 },
      reading: marketReading,
      params: current,
    });
    expect(against).toContain('a trade against it needs at least 5 of the 8 signals on its side');
  });
});

describe('day types', () => {
  const day = '2026-10-21';
  const at = (hhmm: string) => new Date(ist(day, hhmm).getTime() + 20_000);
  /**
   * Yesterday flat around 25,000; today from 09:15 every 15-minute candle swings 20 points
   * the other way (25,020, 24,980, 25,020 …), so the price keeps crossing today's average.
   */
  const choppy = (todayCandles: number) => {
    const flat = Array.from({ length: 75 }, (_, i) => {
      const o = 25_000 + (i % 2 === 0 ? -3 : 3);
      const c = 25_000 + (i % 2 === 0 ? 3 : -3);
      return [o, Math.max(o, c) + 1, Math.min(o, c) - 1, c] as const;
    });
    const today: Array<readonly [number, number, number, number]> = [];
    let price = 25_000;
    for (let candle = 0; candle < todayCandles; candle += 1) {
      const target = candle % 2 === 0 ? 25_020 : 24_980;
      for (let step = 1; step <= 3; step += 1) {
        const next = price + ((target - price) * step) / (4 - step) / 3;
        const close = step === 3 ? target : next;
        today.push([price, Math.max(price, close) + 2, Math.min(price, close) - 2, close]);
        price = close;
      }
    }
    return [...fiveMinuteBars('2026-10-20', '09:15', flat), ...fiveMinuteBars(day, '09:15', today)];
  };
  const range = (hhmm: string, bars: IntradayBar[]) =>
    checkRangeDay({ now: at(hhmm), bars, trendEmaPeriod: 20 }, current.trendDay);

  it("calls a day range-bound when the 15-minute average is flat and the price keeps crossing today's average", () => {
    const reason = range('11:00', choppy(7));
    expect(reason).toMatch(
      /^the 15-minute average is flat and NIFTY crossed today's average price \d+ times$/,
    );
    expect(reason).not.toMatch(JARGON);
    // Not before 10:00.
    expect(range('09:55', choppy(2))).toBeNull();
    // A steady climb is not range-bound.
    expect(
      range('10:30', uptrendFuturesBars({ yesterday: '2026-10-20', today: day, todayBars: 15 })),
    ).toBeNull();
  });

  it('waits until 10:30 on a day that is neither a trend day nor range-bound', () => {
    const blocked = (hhmm: string) => {
      const decision = decideEntry(
        {
          now: ist(day, hhmm),
          readings: [reading({ dayType: 'unclear', chart: chartRead() })],
          day: quietDay,
          vixPct: 0,
        },
        current,
      );
      return decision.action === 'SKIP' && decision.blockedBy.includes('unclear-day-wait');
    };
    expect(blocked('10:15')).toBe(true);
    expect(blocked('10:30')).toBe(false);
  });

  it("trades only the trend day's direction on a trend day, and no pullback on a range-bound day", () => {
    const now = ist(day, '10:45');
    const trendDown: TrendDay = { side: 'PE', flaggedAtMinute: 600, reasons: ['a', 'b', 'c'] };
    const gates = (overrides: Partial<IndexReading>) => {
      const decision = decideEntry(
        {
          now,
          readings: [reading({ chart: chartRead(), ...overrides })],
          day: quietDay,
          vixPct: 0,
        },
        current,
      );
      return decision.action === 'SKIP' ? decision.blockedBy : [];
    };
    // A call pullback (the 15-minute trend is up) on a day flagged a trend day downward.
    expect(gates({ dayType: 'trend', trendDay: trendDown })).toContain('not-for-this-day-type');
    expect(gates({ dayType: 'range' })).toContain('not-for-this-day-type');
    expect(gates({ dayType: 'unclear' })).not.toContain('not-for-this-day-type');
  });

  it('explains the day-type skips in plain words', () => {
    const skip = describeSkip({
      now: ist(day, '10:15'),
      blockedBy: ['unclear-day-wait', 'not-for-this-day-type'],
      leaning: { index: 'NIFTY', side: 'CE', score: 4 },
      reading: reading({}),
      params: current,
    });
    expect(skip).not.toMatch(JARGON);
    expect(skip).toContain(
      'the day is neither clearly trending nor range-bound yet, so we wait until 10:30 AM',
    );
    expect(skip).toContain('on a range-bound day only reversals at a level');
  });
});

describe('trend days', () => {
  const today = '2026-10-21';
  const at = (hhmm: string) => new Date(ist(today, hhmm).getTime() + 20_000);
  /** A steady climb (+12 / −6 a candle) with today's last three candles on 3× the volume. */
  const climb = (todayBars: number) =>
    uptrendFuturesBars({ yesterday: '2026-10-20', today, todayBars });
  const check = (hhmm: string, todayBars: number) =>
    checkTrendDay({ now: at(hhmm), bars: climb(todayBars) }, current.trendDay);
  const flaggedUp: TrendDay = {
    side: 'CE',
    flaggedAtMinute: 10 * 60,
    reasons: ['one', 'two', 'three'],
  };
  const decideAt = (hhmm: string, read: IndexReading) =>
    decideEntry({ now: at(hhmm), readings: [read], day: quietDay, vixPct: 0 }, current);

  it('flags a trend day only when all three checks agree between 09:45 and 10:30', () => {
    const flagged = check('10:15', 12);
    expect(flagged).toMatchObject({ side: 'CE', flaggedAtMinute: 10 * 60 + 15 });
    expect(flagged?.reasons).toEqual([
      'it broke above the first-15-minute range and held for 2 candles',
      "its last 6 closes are above today's average price",
      'the 15-minute trend is strong (100 on a 0–100 trend-strength scale)',
    ]);
    for (const reason of flagged?.reasons ?? []) {
      expect(reason).not.toMatch(JARGON);
    }
    // At 10:00 there are too few finished 15-minute candles to read the trend's strength.
    expect(check('10:00', 9)).toBeNull();
    // The last candle drops back under today's average price and the opening range.
    const bars = climb(12);
    const last = bars.at(-1)!;
    bars[bars.length - 1] = { ...last, c: last.o - 200, l: last.o - 202 };
    expect(checkTrendDay({ now: at('10:15'), bars }, current.trendDay)).toBeNull();
  });

  it('does not flag a trend day before 09:45 or after 10:30', () => {
    expect(check('09:40', 5)).toBeNull();
    expect(check('10:35', 16)).toBeNull();
  });

  it("on a trend day, buys a close above the last hour's high on 1.5× the usual volume without waiting for a pullback", () => {
    // The last candle, a bullish engulfing, closes above the last hour's high on 3× the usual
    // volume. Today's average price sits at its low, so the candle is at a level, but the close
    // is about a normal swing above it: too far for a pullback entry.
    const { data: climbing, backdrop } = bullishMarket();
    const data = { ...climbing, futuresVwap: climbing.futuresPrice! - 12 };
    const read = readIndex(data, backdrop, current, at('10:30'), flaggedUp);
    expect(read.chart?.candle).toMatchObject({
      pattern: 'bullish_engulfing',
      atLevel: "today's average price",
    });
    expect(read.trendDay).toBe(flaggedUp);
    expect(read.trendDayEntry?.trigger).toMatchObject({
      kind: 'breakout',
      name: "the last hour's high",
    });
    expect(read.chart?.valueGapAtr).toBeGreaterThan(current.chart.maxValueGapAtr);
    expect(decideAt('10:30', read)).toMatchObject({ action: 'BUY', side: 'CE' });
  });

  it('does not buy the same breakout on a day that is not a trend day', () => {
    // 10:35: after the trend-day check, and no earlier reading flagged the day.
    const { data, backdrop } = bullishMarket();
    const read = readIndex(data, backdrop, current, at('10:35'));
    expect(read.trendDay).toBeNull();
    expect(read.trendDayEntry).toBeNull();
    expect(decideAt('10:35', read)).toMatchObject({
      action: 'SKIP',
      blockedBy: expect.arrayContaining(['no-pullback']),
    });
  });

  it('does not buy a breakout on thin volume', () => {
    const { data, backdrop } = bullishMarket();
    const thin = { ...data, futuresBars: data.futuresBars.map((bar) => ({ ...bar, v: 1_000 })) };
    const read = readIndex(thin, backdrop, current, at('10:30'), flaggedUp);
    expect(read.trendDay?.side).toBe('CE');
    expect(read.trendDayEntry?.trigger).toBeNull();
    expect(decideAt('10:30', read)).toMatchObject({
      action: 'SKIP',
      blockedBy: expect.arrayContaining(['no-pullback']),
    });
  });

  /** The trend-day climb on flat volume (no breakout), the futures 2 points over its 9-candle average. */
  const dipToShortAverage = () => {
    const { data: climbing, backdrop } = bullishMarket();
    const data = {
      ...climbing,
      futuresBars: climbing.futuresBars.map((bar) => ({ ...bar, v: 1_000 })),
    };
    const futuresPrice = ema(
      data.futuresBars.map((bar) => bar.c),
      9,
    )! + 2;
    return { data: { ...data, futuresPrice, futuresVwap: futuresPrice - 30 }, backdrop };
  };

  it('on a trend day, a dip to the 9-candle average is pullback enough, but its candle must still be at a level', () => {
    const { data, backdrop } = dipToShortAverage();
    const read = readIndex(data, backdrop, current, at('10:30'), flaggedUp);
    expect(read.trendDayEntry?.shallowPullback).toBe('dipped to its 9-candle average');
    // Still more than half a normal swing from the average price.
    expect(read.chart?.valueGapAtr).toBeGreaterThan(current.chart.maxValueGapAtr);
    // No longer waiting for a pullback; the bullish engulfing candle is just away from every level.
    expect(decideAt('10:30', read)).toMatchObject({
      action: 'SKIP',
      blockedBy: ['candle-not-at-level'],
    });
  });

  it('on other days the same dip still waits for the average price or the 21-candle average', () => {
    const { data, backdrop } = dipToShortAverage();
    const read = readIndex(data, backdrop, current, at('10:35'));
    expect(read.trendDayEntry).toBeNull();
    expect(decideAt('10:35', read)).toMatchObject({
      action: 'SKIP',
      blockedBy: expect.arrayContaining(['no-pullback']),
    });
  });

  it('puts the index stop just under the level the breakout cleared', () => {
    const { data, backdrop } = bullishMarket();
    const read = readIndex(data, backdrop, current, at('10:30'), flaggedUp);
    const level = read.trendDayEntry?.trigger?.level ?? NaN;
    const chart = read.chart!;
    expect(chart.plans.CE.stopBeyondBrokenLevel).toBe(true);
    expect(chart.plans.CE.stopSpot).toBeCloseTo(
      level - chart.basis - current.chart.stopBufferAtr * chart.atr,
      6,
    );
    expect(chart.plans.CE.riskPoints).toBeCloseTo(25_000 - chart.plans.CE.stopSpot, 6);
    // Without a trend day the stop stays under the setup candles.
    const plain = readIndex(data, backdrop, current, at('10:35'));
    expect(plain.chart?.plans.CE.stopBeyondBrokenLevel).toBeUndefined();
  });
});
