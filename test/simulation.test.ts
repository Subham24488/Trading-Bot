import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarketRecording } from '../src/simulation/marketRecorder.js';
import type { IntradayBar } from '../src/universe/types.js';

const simulationDir = await mkdtemp(path.join(os.tmpdir(), 'simulation-test-'));

vi.mock('../src/config.js', () => ({
  config: {
    llm: {
      decisionIntervalMinutes: 5,
      minHoldMinutes: 15,
      targetNetPnlPct: 8,
      newsLookbackDays: 30,
      newsItemsPerSymbol: 8,
      tradesDir: 'trades',
      universeDir: 'universe',
      simulationDir,
      kiteInstrumentsPath: 'data/kite-instruments.json',
      kiteIndexUnderlyingsPath: 'data/kite-index-underlyings.json',
    },
  },
}));

/** A tiny stand-in for the decisions table that understands the filters the store uses. */
type Row = Record<string, unknown> & { decidedAt: Date };
const rows: Row[] = [];
function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const range = condition as { gte?: Date; lte?: Date };
      const time = (value as Date).getTime();
      return (
        (range.gte === undefined || time >= range.gte.getTime()) &&
        (range.lte === undefined || time <= range.lte.getTime())
      );
    }
    return (value ?? (key === 'simulated' ? false : null)) === condition;
  });
}
function query(args: { where?: Record<string, unknown>; orderBy?: unknown }): Row[] {
  const found = rows.filter((row) => matches(row, args.where));
  const descending = JSON.stringify(args.orderBy ?? '').includes('desc');
  return found.sort(
    (left, right) => (left.decidedAt.getTime() - right.decidedAt.getTime()) * (descending ? -1 : 1),
  );
}
const createMany = vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
  for (const row of data) {
    rows.push({ ...row, decidedAt: (row.decidedAt as Date | undefined) ?? new Date() });
  }
  return { count: data.length };
});

vi.mock('../src/database.js', () => ({
  database: {
    llmTradeDecision: {
      createMany,
      findFirst: vi.fn(async (args: { where?: Record<string, unknown> }) => query(args)[0] ?? null),
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => query(args)),
    },
  },
}));

const { ist, uptrendFuturesBars } = await import('./marketFixtures.js');
const { blackScholesPrice } = await import('../src/options/greeksIv.js');
const { getCatalogTradingsymbols, loadKiteInstruments } =
  await import('../src/instruments/kiteInstruments.js');
const { ReplayBroker, ReplayHeadlines, SimulationClock, SIMULATED_SPREAD_PCT } =
  await import('../src/simulation/replayMarket.js');
const { SimulationService } = await import('../src/simulation/SimulationService.js');
const { DecisionRunLock } = await import('../src/llm/decisionRunLock.js');
const { LlmTradeAdvisorService } = await import('../src/llm/LlmTradeAdvisorService.js');
const { persistDecisions } = await import('../src/llm/decisionStore.js');

afterAll(async () => {
  await rm(simulationDir, { recursive: true, force: true });
});

beforeEach(() => {
  rows.length = 0;
  createMany.mockClear();
});

const DAY = '2026-10-21';
const FUT_TOKEN = 9001;
const NIFTY_TOKEN = 256265;
const BASIS = 75;
const STRIKES = Array.from({ length: 11 }, (_, index) => 24_750 + index * 50);
const WALLS = new Set(['NIFTY26OCT25250CE', 'NIFTY26OCT24750PE']);
const optionToken = (strike: number, side: 'CE' | 'PE') => strike * 10 + (side === 'CE' ? 1 : 2);

function bar(t: Date, o: number, c: number, v: number, oi?: number): IntradayBar {
  return {
    t: t.toISOString(),
    o,
    h: Math.max(o, c) + 1,
    l: Math.min(o, c) - 1,
    c,
    v,
    ...(oi === undefined ? {} : { oi }),
  };
}

/** Each 5-minute bar as five 1-minute bars walking from its open to its close. */
function toMinuteBars(bars: readonly IntradayBar[]): IntradayBar[] {
  return bars.flatMap((five) =>
    Array.from({ length: 5 }, (_, minute) => {
      const open = five.o + ((five.c - five.o) * minute) / 5;
      const close = five.o + ((five.c - five.o) * (minute + 1)) / 5;
      return bar(new Date(Date.parse(five.t) + minute * 60_000), open, close, five.v / 5, five.oi);
    }),
  );
}

/**
 * 2026-10-21: the uptrend from the live-loop tests until 10:30, with heavy volume from 10:15
 * (the rules BUY a call on the first 5-minute slot after it), then a quiet drift to the close.
 */
function recordedDay(): MarketRecording {
  const trend = uptrendFuturesBars({ yesterday: '2026-10-20', today: DAY, startPrice: 24_400 });
  const fiveMinute = [...trend];
  let last = trend.at(-1)!;
  for (let slot = 15; slot < 75; slot += 1) {
    const open = last.c;
    const close = open + (slot % 2 === 0 ? 4 : -3);
    last = bar(
      new Date(ist(DAY, '09:15').getTime() + slot * 5 * 60_000),
      open,
      close,
      1_000,
      last.oi,
    );
    fiveMinute.push(last);
  }
  const futuresMinutes = toMinuteBars(
    fiveMinute.filter((item) => item.t >= ist(DAY, '09:15').toISOString()),
  );
  const spotMinutes = futuresMinutes.map((item) =>
    bar(new Date(item.t), item.o - BASIS, item.c - BASIS, 0),
  );
  const optionSeries = STRIKES.flatMap((strike) =>
    (['CE', 'PE'] as const).map((side) => {
      const symbol = `NIFTY26OCT${strike}${side}`;
      const price = (spot: number) =>
        Number(blackScholesPrice(spot, strike, 6 / 365, 0.065, 0.12, side).toFixed(2));
      return {
        key: `NFO:${symbol}`,
        token: optionToken(strike, side),
        minuteBars: spotMinutes.map((item) =>
          bar(
            new Date(item.t),
            price(item.o),
            price(item.c),
            400,
            WALLS.has(symbol) ? 6_000_000 : 2_000_000,
          ),
        ),
        prevClose: null,
        option: true,
      };
    }),
  );
  const stocks = loadKiteInstruments()
    .filter((stock) => !stock.tradingsymbol.endsWith('BEES'))
    .map((stock) => ({
      key: `NSE:${stock.tradingsymbol}`,
      token: stock.instrumentToken,
      minuteBars: spotMinutes.map((item) => bar(new Date(item.t), 101, 101, 100)),
      prevClose: 100,
      option: false,
    }));
  const prevSpotClose =
    trend.filter((item) => item.t < ist(DAY, '09:15').toISOString()).at(-1)!.c - BASIS;
  return {
    version: 1,
    date: DAY,
    indexes: ['NIFTY'],
    recordedAt: '2026-10-22T12:00:00.000Z',
    instruments: {
      NFO: [
        {
          instrument_token: FUT_TOKEN,
          tradingsymbol: 'NIFTY26OCTFUT',
          name: 'NIFTY',
          expiry: '2026-10-27',
          instrument_type: 'FUT',
          lot_size: 65,
        },
        ...STRIKES.flatMap((strike) =>
          (['CE', 'PE'] as const).map((side) => ({
            instrument_token: optionToken(strike, side),
            tradingsymbol: `NIFTY26OCT${strike}${side}`,
            name: 'NIFTY',
            expiry: '2026-10-27',
            strike,
            instrument_type: side,
            lot_size: 65,
          })),
        ),
      ],
      CDS: [],
      MCX: [],
    },
    series: [
      {
        key: 'NSE:NIFTY 50',
        token: NIFTY_TOKEN,
        minuteBars: spotMinutes,
        prevClose: prevSpotClose,
        option: false,
      },
      {
        key: 'NFO:NIFTY26OCTFUT',
        token: FUT_TOKEN,
        minuteBars: futuresMinutes,
        prevClose: null,
        option: false,
      },
      ...optionSeries,
      ...stocks,
    ],
    fiveMinuteBars: { [String(FUT_TOKEN)]: fiveMinute },
    dailyBars: {
      [String(NIFTY_TOKEN)]: [{ d: '2026-10-20', o: 0, h: 0, l: 0, c: prevSpotClose, v: 0 }],
    },
    headlines: [],
    dataGaps: [],
  };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const pickLlm = () =>
  ({
    completeJson: vi.fn().mockResolvedValue({
      text: '{"symbol":"NIFTY26OCT25000CE","reason":"Closest to the current price."}',
      parsed: { symbol: 'NIFTY26OCT25000CE', reason: 'Closest to the current price.' },
    }),
    getModel: () => 'test-model',
  }) as never;

describe('ReplayBroker', () => {
  const recording: MarketRecording = {
    ...recordedDay(),
    series: [
      {
        key: 'NFO:NIFTY26OCT25000CE',
        token: 1,
        minuteBars: [
          bar(ist(DAY, '09:15'), 100, 102, 10, 500),
          bar(ist(DAY, '09:16'), 102, 110, 30, 600),
        ],
        prevClose: 90,
        option: true,
      },
    ],
  };

  it('quotes the last 1-minute bar that had finished, never a later one', async () => {
    const clock = new SimulationClock(new Date(ist(DAY, '09:16').getTime() + 59_000));
    const broker = new ReplayBroker(recording, clock.now);
    const [early] = Object.values(await broker.getQuotes(['NFO:NIFTY26OCT25000CE']));
    expect(early).toMatchObject({ lastPrice: 102, volume: 10, oi: 500, open: 100, prevClose: 90 });

    clock.advanceTo(ist(DAY, '09:17'));
    const quote = (await broker.getQuotes(['NFO:NIFTY26OCT25000CE']))['NFO:NIFTY26OCT25000CE'];
    expect(quote).toMatchObject({ lastPrice: 110, volume: 40, oi: 600, open: 100 });
    // Day VWAP from typical prices (high + low + close) / 3, weighted by volume.
    expect(quote?.vwap).toBeCloseTo(((304 / 3) * 10 + (322 / 3) * 30) / 40, 2);
    expect(quote?.bid).toBeCloseTo(110 * (1 - SIMULATED_SPREAD_PCT / 200), 2);
    expect(quote?.ask).toBeCloseTo(110 * (1 + SIMULATED_SPREAD_PCT / 200), 2);

    clock.advanceTo(ist(DAY, '09:16'));
    expect(
      (await broker.getQuotes(['NFO:NIFTY26OCT25000CE']))['NFO:NIFTY26OCT25000CE']?.lastPrice,
    ).toBe(110);
  });

  it('has no quote before the first bar finishes and serves candles only up to now', async () => {
    const day = recordedDay();
    const clock = new SimulationClock(new Date(ist(DAY, '09:15').getTime() + 20_000));
    const broker = new ReplayBroker(day, clock.now);
    expect(await broker.getQuotes(['NSE:NIFTY 50'])).toEqual({});

    clock.advanceTo(new Date(ist(DAY, '10:30').getTime() + 20_000));
    const bars = await broker.getFiveMinuteCandles(
      FUT_TOKEN,
      '2026-10-14 00:00:00',
      '2026-10-21 15:30:00',
    );
    expect(bars.at(-1)?.t).toBe(new Date(ist(DAY, '10:30')).toISOString());
    expect(await broker.getDailyCandles(NIFTY_TOKEN, '2026-09-01', '2026-10-20')).toHaveLength(1);
    expect(await broker.getDayInstruments('CDS')).toEqual([]);
  });
});

describe('ReplayHeadlines', () => {
  it('hides headlines published after the replay clock and ones without a time', async () => {
    const item = (title: string, publishedAt: string | null) => ({
      symbol: 'NIFTY',
      title,
      link: 'https://example.com',
      publishedAt,
      source: 'google-news-rss',
    });
    const clock = new SimulationClock(ist(DAY, '11:00'));
    const headlines = new ReplayHeadlines(
      {
        ...recordedDay(),
        headlines: [
          {
            symbol: 'NIFTY',
            items: [
              item('before', ist(DAY, '10:00').toUTCString()),
              item('after', ist(DAY, '12:00').toUTCString()),
              item('undated', null),
            ],
          },
        ],
      },
      clock.now,
    );
    const [nifty] = await headlines.fetchIndexNews(
      [{ symbol: 'NIFTY', query: 'Nifty' }],
      ist(DAY, '09:00'),
      ist(DAY, '15:00'),
    );
    expect(nifty?.items.map((entry) => entry.title)).toEqual(['before']);
  });
});

describe('simulated replay of a day', () => {
  it('runs the live rules on the replay clock and stores flagged rows at virtual times', async () => {
    const day = recordedDay();
    const clock = new SimulationClock(new Date(ist(DAY, '09:15').getTime() + 20_000));
    const advisor = new LlmTradeAdvisorService({
      llm: pickLlm(),
      kite: new ReplayBroker(day, clock.now),
      news: new ReplayHeadlines(day, clock.now),
      logger: logger(),
      now: clock.now,
      simulationId: '00000000-0000-4000-8000-000000000001',
    });
    await advisor.replayDay({
      indexes: ['NIFTY'],
      end: ist(DAY, '15:30'),
      advanceTo: clock.advanceTo,
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({
        simulated: true,
        simulationId: '00000000-0000-4000-8000-000000000001',
      });
      expect(row.decidedAt).toEqual(row.asOf);
    }
    const actions = rows.map((row) => row.action);
    // Flat from 09:30: one SKIP per 5-minute slot until the 10:20 BUY.
    const skipsBefore = rows.slice(0, actions.indexOf('BUY'));
    expect(skipsBefore.map((row) => (row.decidedAt as Date).toISOString())).toEqual(
      Array.from({ length: 10 }, (_, slot) =>
        new Date(ist(DAY, '09:30').getTime() + slot * 5 * 60_000 + 20_000).toISOString(),
      ),
    );
    const buyIndex = actions.indexOf('BUY');
    expect(rows[buyIndex]).toMatchObject({ symbol: 'NIFTY26OCT25000CE' });
    expect(rows[buyIndex]?.decidedAt).toEqual(new Date(ist(DAY, '10:20').getTime() + 20_000));
    // The open trade is reviewed every minute until it is sold.
    const exitIndex = actions.indexOf('EXIT');
    expect(exitIndex).toBeGreaterThan(buyIndex + 1);
    const holds = rows.slice(buyIndex + 1, exitIndex);
    expect(holds.every((row) => row.action === 'HOLD')).toBe(true);
    expect(
      holds.map(
        (row) => (row.decidedAt as Date).getTime() - (rows[buyIndex]!.decidedAt as Date).getTime(),
      ),
    ).toEqual(holds.map((_, index) => (index + 1) * 60_000));
    expect(
      rows
        .filter((row) => row.tuuid === rows[buyIndex]?.tuuid)
        .map((row) => row.action)
        .at(-1),
    ).toBe('EXIT');
    // Nothing is stored after the 15:15 square-off.
    expect(
      rows.every(
        (row) => (row.decidedAt as Date) <= new Date(ist(DAY, '15:15').getTime() + 20_000),
      ),
    ).toBe(true);
  });

  it('logs every stored BUY, HOLD, EXIT and SKIP once, at its replay time', async () => {
    const day = recordedDay();
    const clock = new SimulationClock(new Date(ist(DAY, '09:15').getTime() + 20_000));
    const log = logger();
    const advisor = new LlmTradeAdvisorService({
      llm: pickLlm(),
      kite: new ReplayBroker(day, clock.now),
      news: new ReplayHeadlines(day, clock.now),
      logger: log,
      now: clock.now,
      simulationId: '00000000-0000-4000-8000-000000000002',
    });
    await advisor.replayDay({
      indexes: ['NIFTY'],
      end: ist(DAY, '15:30'),
      advanceTo: clock.advanceTo,
    });

    const decisionLines = log.info.mock.calls.filter(([, message]) =>
      String(message).startsWith('Stored rules-based '),
    );
    expect(decisionLines.map(([details]) => (details as { action: string }).action)).toEqual(
      rows.map((row) => row.action),
    );
    const firstHold = decisionLines.find(([details]) => details.action === 'HOLD')?.[0];
    expect(firstHold).toMatchObject({
      simulationId: '00000000-0000-4000-8000-000000000002',
      symbol: 'NIFTY26OCT25000CE',
      at: '2026-10-21 10:21:20',
    });
    expect(firstHold).toHaveProperty('pnlPct');
    const firstSkip = decisionLines[0]?.[0];
    expect(firstSkip).toMatchObject({ action: 'SKIP', at: '2026-10-21 09:30:20' });
    expect(firstSkip).toHaveProperty('blockedBy');
  });
});

describe('decision store scoping', () => {
  it('flags simulated rows and dates them at the virtual time; live rows are unchanged', async () => {
    const batch = {
      decisions: [{ symbol: 'NIFTY26OCTFUT', action: 'SKIP' as const, rationale: 'quiet' }],
    };
    await persistDecisions({ asOf: ist(DAY, '10:00'), batch, simulationId: 'run-1' });
    await persistDecisions({ asOf: ist(DAY, '10:00'), batch });
    const [simulated, live] = createMany.mock.calls.map((call) => call[0].data[0]);
    expect(simulated).toMatchObject({
      simulated: true,
      simulationId: 'run-1',
      decidedAt: ist(DAY, '10:00'),
    });
    expect(live).not.toHaveProperty('simulated');
    expect(live).not.toHaveProperty('decidedAt');
  });
});

/** Kite history served from the recorded day, as the recorder would download it. */
function recorderBroker(day: MarketRecording) {
  const byToken = new Map(day.series.map((item) => [item.token, item] as const));
  return {
    getMinuteCandles: vi.fn(async (token: number) => byToken.get(token)?.minuteBars ?? []),
    getFiveMinuteCandles: vi.fn(async (token: number) => day.fiveMinuteBars[String(token)] ?? []),
    getDailyCandles: vi.fn(async (token: number) => {
      const prev = byToken.get(token)?.prevClose;
      return prev ? [{ d: '2026-10-20', o: prev, h: prev, l: prev, c: prev, v: 0 }] : [];
    }),
    getDayInstruments: vi.fn(async (exchange: 'NFO' | 'CDS' | 'MCX') => day.instruments[exchange]),
  };
}

describe('SimulationService', () => {
  const service = (lock = new DecisionRunLock(), kite = recorderBroker(recordedDay())) =>
    new SimulationService({
      llm: pickLlm(),
      kite,
      news: { fetchIndexNewsOn: vi.fn().mockResolvedValue([]) },
      logger: logger(),
      runLock: lock,
    });

  it('records the day once, replays it, and reports the trades of each run separately', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ist('2026-10-22', '18:00'));
    try {
      const kite = recorderBroker(recordedDay());
      const simulator = service(new DecisionRunLock(), kite);
      const first = await simulator.run({ date: DAY, indexes: ['NIFTY'] });
      expect(first).toMatchObject({ date: DAY, indexes: ['NIFTY'], recorded: true });
      expect(first.dataFile).toBe(path.join(simulationDir, `${DAY}.json`));
      const saved = JSON.parse(await readFile(first.dataFile, 'utf8')) as MarketRecording;
      expect(saved.series.some((item) => item.key === 'NFO:NIFTY26OCT25000CE')).toBe(true);
      expect(first.decisions.BUY).toBeGreaterThan(0);
      expect(first.trades[0]).toMatchObject({
        symbol: 'NIFTY26OCT25000CE',
        buyAt: new Date(ist(DAY, '10:20').getTime() + 20_000).toISOString(),
      });
      expect(first.trades[0]?.exitReason).not.toBeNull();
      const calls = kite.getMinuteCandles.mock.calls.length;

      const second = await simulator.run({ date: DAY, indexes: ['NIFTY'] });
      expect(second.recorded).toBe(false);
      expect(kite.getMinuteCandles.mock.calls.length).toBe(calls);
      expect(second.simulationId).not.toBe(first.simulationId);
      // The first run's trades do not count toward the second run's daily limits.
      expect(second.trades.map((trade) => trade.buyAt)).toEqual(
        first.trades.map((trade) => trade.buyAt),
      );
      expect(second.netPnlInr).toBe(first.netPnlInr);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects dates that cannot be replayed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ist('2026-10-22', '12:00'));
    try {
      const simulator = service();
      await expect(simulator.run({ date: '2026-10-24' })).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(simulator.run({ date: '2026-10-22' })).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(simulator.run({ date: '2026-10-23' })).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(simulator.run({ date: '2026-02-30' })).rejects.toMatchObject({
        statusCode: 400,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows only one of the live loop and a simulation at a time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ist('2026-10-22', '18:00'));
    try {
      const lock = new DecisionRunLock();
      lock.acquire('live');
      await expect(service(lock).run({ date: '2026-10-20' })).rejects.toMatchObject({
        statusCode: 409,
      });
      lock.release('live');

      lock.acquire('simulation');
      const live = new LlmTradeAdvisorService({
        llm: pickLlm(),
        kite: recorderBroker(recordedDay()) as never,
        news: { fetchIndexNews: vi.fn().mockResolvedValue([]) } as never,
        logger: logger(),
        runLock: lock,
      });
      await expect(live.startDecisionLoop(['NIFTY'])).rejects.toMatchObject({ statusCode: 409 });
      expect(live.isDecisionLoopRunning()).toBe(false);
      lock.release('simulation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('frees the lock when a simulation fails, with 502 for a Kite failure and 422 for no data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ist('2026-10-22', '18:00'));
    try {
      const lock = new DecisionRunLock();
      const failing = recorderBroker(recordedDay());
      failing.getMinuteCandles.mockRejectedValue(new Error('TokenException'));
      await expect(service(lock, failing).run({ date: '2026-10-20' })).rejects.toMatchObject({
        statusCode: 502,
      });
      expect(lock.current()).toBeNull();

      const empty = recorderBroker(recordedDay());
      empty.getMinuteCandles.mockResolvedValue([]);
      await expect(service(lock, empty).run({ date: '2026-10-19' })).rejects.toMatchObject({
        statusCode: 422,
      });
      expect(lock.current()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('simulation safety', () => {
  it('never places orders', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ['marketRecorder.ts', 'replayMarket.ts', 'SimulationService.ts']) {
      const source = await readFile(path.join(here, '../src/simulation', file), 'utf8');
      expect(source).not.toMatch(/placeLimitOrder|placeOrder|PaperBroker/);
    }
    expect(getCatalogTradingsymbols().length).toBeGreaterThan(20);
  });
});
