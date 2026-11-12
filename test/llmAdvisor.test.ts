import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    huggingface: {
      token: 'hf_test_token_value',
      baseUrl: 'https://router.huggingface.co/v1',
      model: 'Qwen/Qwen3-14B:fastest',
      timeoutMs: 5_000,
      maxTokens: 200,
    },
    llm: {
      decisionIntervalMinutes: 5,
      minHoldMinutes: 15,
      targetNetPnlPct: 8,
      newsLookbackDays: 30,
      newsItemsPerSymbol: 8,
      tradesDir: 'trades',
      universeDir: 'universe',
      kiteInstrumentsPath: 'data/kite-instruments.json',
      kiteIndexUnderlyingsPath: 'data/kite-index-underlyings.json',
    },
    session: {
      quoteLogPath: 'logs/session-quotes.jsonl',
    },
  },
}));

const createMany = vi.fn().mockResolvedValue({ count: 1 });
const findFirst = vi.fn().mockResolvedValue(null);
const findMany = vi.fn().mockResolvedValue([]);

vi.mock('../src/database.js', () => ({
  database: {
    llmTradeDecision: {
      createMany,
      findFirst,
      findMany,
    },
  },
}));

const { HuggingFaceClient } = await import('../src/llm/huggingfaceClient.js');
const {
  allowedActionsForLatest,
  clampDecisionsToAllowed,
  clampWatchlistToTop,
  decisionBatchSchema,
  intersectWatchlistWithCatalog,
  universeSuggestionSchema,
} = await import('../src/llm/schemas.js');
const { persistDecisions, LLM_EXECUTION_BLOCKED_REASON, pricesForDecision } =
  await import('../src/llm/decisionStore.js');
const { filterSnapshotsToSymbols, lastPricesFromSnapshots } =
  await import('../src/llm/quoteLogReader.js');
const { compactNewsForPrompt, buildUniverseMessages, buildDecisionMessages } =
  await import('../src/llm/prompts.js');
const { parseRssItems } = await import('../src/news/NewsService.js');
const { blackScholesPrice } = await import('../src/options/greeksIv.js');
const { fiveMinuteBars, ist, uptrendFuturesBars } = await import('./marketFixtures.js');

describe('parseRssItems', () => {
  it('reads Google-style RSS items', () => {
    const xml = `
      <rss><channel>
        <item><title>Reliance earnings</title><link>https://example.com/1</link><pubDate>Fri, 21 Aug 2026 10:00:00 GMT</pubDate></item>
        <item><title></title><link>https://example.com/2</link></item>
      </channel></rss>
    `;
    expect(parseRssItems(xml, 'RELIANCE', 'google-news-rss', 8)).toEqual([
      {
        symbol: 'RELIANCE',
        title: 'Reliance earnings',
        link: 'https://example.com/1',
        publishedAt: 'Fri, 21 Aug 2026 10:00:00 GMT',
        source: 'google-news-rss',
      },
    ]);
  });
});

describe('HuggingFaceClient.connect', () => {
  it('fails fast when the models endpoint is unauthorized', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid token',
    });
    const client = new HuggingFaceClient({ token: 'hf_test_token_value', fetchImpl });
    await expect(client.connect()).rejects.toThrow(/boot check failed \(401/);
    expect(client.isConnected()).toBe(false);
  });

  it('marks the client connected after a successful models list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ data: [] }),
    });
    const client = new HuggingFaceClient({ token: 'hf_test_token_value', fetchImpl });
    await client.connect();
    expect(client.isConnected()).toBe(true);
  });

  it('caps chat max_tokens to the per-call budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"watchlist":[]}' } }] }),
    });
    const client = new HuggingFaceClient({
      token: 'hf_test_token_value',
      fetchImpl,
      maxTokens: 1200,
    });
    await client.connect();
    await client.completeJson([{ role: 'user', content: '{"n":[]}' }], { maxTokens: 400 });
    const chatCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).includes('/chat/completions'),
    );
    expect(JSON.parse(String(chatCall?.[1]?.body)).max_tokens).toBe(400);
  });
});

describe('compact universe prompts', () => {
  it('keeps material NSE filing text, drops PDF links, and prefers results over noise', () => {
    const news = [
      {
        symbol: 'RELIANCE',
        items: [
          {
            symbol: 'RELIANCE',
            title:
              'Financial Results — Audited standalone and consolidated results for the quarter and year ended 31 Mar 2026 with dividend recommendation',
            link: 'https://nsearchives.nseindia.com/corporate/very-long-attachment-name.pdf',
            publishedAt: '21-Aug-2026 18:30:00',
            source: 'nse-corporate-announcements',
          },
          {
            symbol: 'RELIANCE',
            title: 'Updates',
            link: 'https://example.com/noise',
            publishedAt: '20-Aug-2026',
            source: 'google-news-rss',
          },
          {
            symbol: 'RELIANCE',
            title: 'Newspaper clipping',
            link: 'https://example.com/3',
            publishedAt: '19-Aug-2026',
            source: 'nse-corporate-announcements',
          },
        ],
      },
    ];
    const compact = compactNewsForPrompt(news);
    expect(compact[0]?.k).toBe('RESULT');
    expect(compact[0]?.t).toContain('Audited standalone');
    expect(compact[0]?.t.length).toBeGreaterThan(80);
    expect(JSON.stringify(compact)).not.toContain('nsearchives');
    expect(compact.some((row) => row.t === 'Newspaper clipping')).toBe(false);

    const messages = buildUniverseMessages('2026-08-22T09:00:00+05:30', [
      {
        symbol: 'RELIANCE',
        score: 20,
        pass: true,
        failReasons: [],
        momRiskAdj: 1.2,
        features: {
          sma20: 1400,
          sma50: 1350,
          atrPct: 1.2,
          rsNifty20: 3.1,
          volVs20: 1.4,
          distFrom20HighPct: -1.2,
          ret20Pct: 5,
          eventScore: 10,
          score: 20,
        },
        filings: compact.map((row) => ({ k: row.k, d: row.d, t: row.t, src: row.src })),
      },
    ]);
    expect(messages[1]?.content.length).toBeLessThan(12_000);
    expect(messages[0]?.content).toContain('at most 1');
    expect(messages[0]?.content).toContain('Zero includes is valid');
    expect(messages[1]?.content).toContain('"maxInclude":1');
    expect(messages[1]?.content).not.toContain('outputSchema');
    expect(messages[1]?.content).not.toContain('kiteTradingsymbols');
  });
});

describe('LLM schemas', () => {
  it('maps ENTER_LONG, WAIT, and SELL onto buy/skip/exit and drops leaked tickers', () => {
    const suggestion = universeSuggestionSchema.parse({
      watchlist: [
        { symbol: 'reliance', include: true, rationale: 'earnings follow through' },
        { symbol: 'FAKENS', include: true, rationale: 'hallucinated' },
      ],
    });
    const filtered = intersectWatchlistWithCatalog(suggestion, new Set(['RELIANCE', 'NIFTYBEES']));
    expect(filtered.watchlist.map((item) => item.symbol)).toEqual(['RELIANCE']);
    expect(filtered.exclude.some((item) => item.symbol === 'FAKENS')).toBe(true);

    const batch = decisionBatchSchema.parse({
      decisions: [
        { symbol: 'NIFTYBEES', action: 'ENTER_LONG', rationale: 'breakout' },
        { symbol: 'RELIANCE', action: 'wait', rationale: 'no setup' },
      ],
    });
    expect(batch.decisions[0]?.action).toBe('BUY');
    expect(batch.decisions[1]?.action).toBe('SKIP');
  });

  it('clamps more than one include and allows an empty pick', () => {
    const clamped = clampWatchlistToTop(
      universeSuggestionSchema.parse({
        watchlist: [
          { symbol: 'RELIANCE', include: true, rationale: 'one' },
          { symbol: 'TCS', include: true, rationale: 'two' },
          { symbol: 'INFY', include: true, rationale: 'three' },
        ],
      }),
    );
    expect(clamped.watchlist.map((item) => item.symbol)).toEqual(['RELIANCE']);
    expect(clamped.exclude.some((item) => item.symbol === 'TCS')).toBe(true);
    expect(clamped.exclude.some((item) => item.symbol === 'INFY')).toBe(true);

    const empty = clampWatchlistToTop(
      universeSuggestionSchema.parse({
        watchlist: [{ symbol: 'RELIANCE', include: false, rationale: 'no setup' }],
      }),
    );
    expect(empty.watchlist).toEqual([]);
  });

  it('maps allowed next actions from the latest stored decision', () => {
    expect(allowedActionsForLatest(null)).toEqual(['BUY', 'SKIP']);
    expect(allowedActionsForLatest('EXIT')).toEqual(['BUY', 'SKIP']);
    expect(allowedActionsForLatest('SKIP')).toEqual(['BUY', 'SKIP']);
    expect(allowedActionsForLatest('BUY')).toEqual(['HOLD', 'EXIT']);
    expect(allowedActionsForLatest('HOLD')).toEqual(['HOLD', 'EXIT']);
    expect(
      decisionBatchSchema.parse({
        decisions: [{ symbol: 'RELIANCE', action: 'SKIP', rationale: 'no setup this interval' }],
      }).decisions[0]?.action,
    ).toBe('SKIP');
  });

  it('drops decisions whose action is not allowed for the symbol', () => {
    const parsed = decisionBatchSchema.parse({
      decisions: [
        { symbol: 'RELIANCE', action: 'BUY', rationale: 'illegal after buy' },
        { symbol: 'TCS', action: 'SELL', rationale: 'exit hold' },
      ],
    });
    const { batch, dropped } = clampDecisionsToAllowed(
      parsed,
      new Map([
        ['RELIANCE', ['HOLD', 'EXIT']],
        ['TCS', ['EXIT']],
      ]),
    );
    expect(batch.decisions.map((item) => `${item.symbol}:${item.action}`)).toEqual(['TCS:EXIT']);
    expect(dropped).toEqual([{ symbol: 'RELIANCE', action: 'BUY' }]);
  });
});

describe('decision prompts', () => {
  it('includes per-symbol opts in the user payload', () => {
    const messages = buildDecisionMessages(
      '2026-08-22T15:00:00+05:30',
      ['RELIANCE'],
      [
        {
          ts: '2026-08-22T09:30:00.000Z',
          instruments: [{ tradingsymbol: 'RELIANCE', lastPrice: 1400 }],
        },
      ],
      [{ symbol: 'RELIANCE', last: 'BUY', allowed: ['HOLD', 'EXIT'] }],
    );
    expect(messages[0]?.content).toContain('do not force BUY');
    expect(messages[0]?.content).toContain('pb[]');
    const payload = JSON.parse(messages[1]?.content ?? '{}') as {
      allowed: Array<{ s: string; last: string; opts: string[] }>;
      pb: unknown[];
    };
    expect(payload.allowed).toEqual([{ s: 'RELIANCE', last: 'BUY', opts: ['HOLD', 'SELL'] }]);
    expect(payload.pb).toEqual([]);
  });
});

describe('persistDecisions', () => {
  beforeEach(() => {
    createMany.mockClear();
  });

  it('writes BUY/HOLD/EXIT rows with executed forced false', async () => {
    const count = await persistDecisions({
      asOf: new Date('2026-08-21T10:15:00.000Z'),
      batch: {
        decisions: [{ symbol: 'RELIANCE', action: 'BUY', rationale: 'news + quote' }],
      },
      lastPriceBySymbol: { RELIANCE: 1400.5 },
      tokenBySymbol: { RELIANCE: 738561 },
    });

    expect(count).toBe(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          symbol: 'RELIANCE',
          action: 'BUY',
          buyPrice: '1400.5000',
          currentPrice: '1400.5000',
          instrumentToken: 738561,
          executed: false,
          executionBlockedReason: LLM_EXECUTION_BLOCKED_REASON,
        }),
      ],
    });
    expect(createMany.mock.calls[0]?.[0]?.data[0]).not.toHaveProperty('sellPrice');
    expect(createMany.mock.calls[0]?.[0]?.data[0]).toMatchObject({
      promptHash: '',
      rawCompletion: '',
      marketSnapshot: {},
    });
  });

  it('writes the tuuid on BUY/HOLD/EXIT rows but never on SKIP', async () => {
    const tuuid = '6f1c2a4e-0b7d-4c1e-9a52-3d8e7f6a1b20';
    for (const action of ['BUY', 'HOLD', 'EXIT', 'SKIP'] as const) {
      await persistDecisions({
        asOf: new Date('2026-08-21T10:15:00.000Z'),
        batch: { decisions: [{ symbol: 'NIFTY26OCT25000CE', action, rationale: 'test' }] },
        tuuidBySymbol: { NIFTY26OCT25000CE: tuuid },
      });
    }
    const rows = createMany.mock.calls.map((call) => call[0]?.data[0] as Record<string, unknown>);
    expect(rows.slice(0, 3).map((row) => row.tuuid)).toEqual([tuuid, tuuid, tuuid]);
    expect(rows[3]).toMatchObject({ action: 'SKIP' });
    expect(rows[3]).not.toHaveProperty('tuuid');
  });

  it('stores sellPrice on EXIT and carries the prior buyPrice', () => {
    expect(pricesForDecision('BUY', 100.5, null)).toEqual({
      buyPrice: '100.5000',
      sellPrice: null,
    });
    expect(pricesForDecision('HOLD', 110, '100.5000')).toEqual({
      buyPrice: '100.5000',
      sellPrice: null,
    });
    expect(pricesForDecision('SKIP', 110, null)).toEqual({ buyPrice: null, sellPrice: null });
    expect(pricesForDecision('EXIT', 99.25, '100.5000')).toEqual({
      buyPrice: '100.5000',
      sellPrice: '99.2500',
    });
  });
});

describe('lastPricesFromSnapshots', () => {
  it('uses the newest lastPrice per symbol', () => {
    const prices = lastPricesFromSnapshots(
      [
        {
          ts: '2026-08-21T10:00:00.000Z',
          instruments: [{ tradingsymbol: 'RELIANCE', lastPrice: 1390 }],
        },
        {
          ts: '2026-08-21T10:15:00.000Z',
          instruments: [{ tradingsymbol: 'RELIANCE', lastPrice: 1400.5 }],
        },
      ],
      ['RELIANCE'],
    );
    expect(prices.RELIANCE).toBe(1400.5);
  });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type StoredRow = Record<string, unknown> & {
  marketSnapshot: {
    trigger?: string;
    exit?: { reason: string };
    readings?: Array<{ index: string; chart?: { atr: number } | null }>;
    entry?: {
      plan?: { stopSpot: number; premiumStop: number; maxLossInr: number; lockPrice: number };
    };
    position?: { stopSpot?: number | null; premiumStop?: number | null };
  };
};

function storedRows(): StoredRow[] {
  return createMany.mock.calls.map((call) => call[0]?.data[0] as StoredRow);
}

/** Biggest option open interest: resistance at 25,250 and support at 24,750, away from spot. */
const WALL_KEYS = new Set(['NFO:NIFTY26OCT25250CE', 'NFO:NIFTY26OCT24750PE']);

/**
 * A NIFTY uptrend on 2026-10-21 where the rules BUY a call and the LLM picks 25,000 CE.
 * `setOptionPriceFactor` scales every option quote, e.g. 0.5 to trigger the stop-loss.
 */
async function optionsAdvisorScenario() {
  const { LlmTradeAdvisorService } = await import('../src/llm/LlmTradeAdvisorService.js');
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const futuresBars = uptrendFuturesBars({
    yesterday: '2026-10-20',
    today: '2026-10-21',
    startPrice: 24_400,
  });
  const futuresPrice = futuresBars.at(-1)!.c;
  const strikes = Array.from({ length: 11 }, (_, index) => 24_750 + index * 50);
  const nfoRows = [
    {
      instrument_token: 9001,
      tradingsymbol: 'NIFTY26OCTFUT',
      name: 'NIFTY',
      expiry: '2026-10-27',
      instrument_type: 'FUT',
      lot_size: 65,
    },
    ...strikes.flatMap((strike) =>
      (['CE', 'PE'] as const).map((side) => ({
        instrument_token: strike * 10 + (side === 'CE' ? 1 : 2),
        tradingsymbol: `NIFTY26OCT${strike}${side}`,
        name: 'NIFTY',
        expiry: '2026-10-27',
        strike,
        instrument_type: side,
        lot_size: 65,
      })),
    ),
  ];
  const optionPrice = (symbol: string) => {
    const [, strike, side] = symbol.match(/(\d{5})(CE|PE)$/) ?? [];
    return Number(
      blackScholesPrice(25_000, Number(strike), 6 / 365, 0.065, 0.12, side as 'CE' | 'PE').toFixed(
        2,
      ),
    );
  };
  let optionPriceFactor = 1;
  let niftySpot = 25_000;
  const getQuotes = vi.fn(async (keys: string[]) => {
    const quotes: Record<string, object> = {};
    for (const key of keys) {
      const base = {
        volume: 40_000,
        oi: 0,
        open: null,
        prevClose: null,
        vwap: null,
        bid: null,
        ask: null,
      };
      if (key === 'NSE:NIFTY 50') {
        quotes[key] = { ...base, lastPrice: niftySpot, open: 25_150, prevClose: 25_000 };
      } else if (key === 'NFO:NIFTY26OCTFUT') {
        quotes[key] = {
          ...base,
          lastPrice: futuresPrice,
          vwap: futuresPrice - 30,
          oi: 10_000_000,
        };
      } else if (key.startsWith('NFO:NIFTY26OCT')) {
        const price = Number((optionPrice(key) * optionPriceFactor).toFixed(2));
        quotes[key] = {
          ...base,
          lastPrice: price,
          bid: price - 0.1,
          ask: price + 0.1,
          oi: WALL_KEYS.has(key) ? 6_000_000 : 2_000_000,
        };
      } else if (key.startsWith('NSE:')) {
        quotes[key] = { ...base, lastPrice: 101, prevClose: 100 };
      }
    }
    return quotes;
  });
  const completeJson = vi.fn().mockResolvedValue({
    text: '{"symbol":"NIFTY26OCT25000CE","reason":"Closest to the current price with a tight spread."}',
    parsed: {
      symbol: 'NIFTY26OCT25000CE',
      reason: 'Closest to the current price with a tight spread.',
    },
  });
  const fetchIndexNews = vi.fn().mockResolvedValue([]);
  const getFiveMinuteCandles = vi.fn().mockResolvedValue(futuresBars);
  const advisor = new LlmTradeAdvisorService({
    llm: { completeJson, getModel: () => 'test-model' } as never,
    news: { fetchIndexNews } as never,
    kite: {
      getQuotes,
      getDayInstruments: vi.fn(async (exchange: string) => (exchange === 'NFO' ? nfoRows : [])),
      getFiveMinuteCandles,
      getDailyCandles: vi.fn().mockResolvedValue([]),
    } as never,
    logger,
  });
  return {
    advisor,
    completeJson,
    fetchIndexNews,
    getFiveMinuteCandles,
    logger,
    optionPrice,
    setOptionPriceFactor: (factor: number) => {
      optionPriceFactor = factor;
    },
    setNiftySpot: (spot: number) => {
      niftySpot = spot;
    },
  };
}

describe('LlmTradeAdvisorService safety', () => {
  it('does not place orders or auto-start a market-data session', async () => {
    const loopFiles = [
      '../src/llm/LlmTradeAdvisorService.ts',
      '../src/services/LiveMarketFeed.ts',
      '../src/llm/contractPicker.ts',
    ];
    for (const file of loopFiles) {
      const source = await readFile(
        path.join(path.dirname(fileURLToPath(import.meta.url)), file),
        'utf8',
      );
      expect(source).not.toMatch(/placeLimitOrder/);
      expect(source).not.toMatch(/PaperBroker/);
      expect(source).not.toMatch(/sessionService\.start/);
      expect(source).not.toMatch(/maybeStartMarketDataSession/);
    }
  });

  it('does not auto-start the decision loop in main()', async () => {
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/server.ts');
    const source = await readFile(sourcePath, 'utf8');
    const mainBlock = source.slice(source.indexOf('async function main()'));
    expect(mainBlock).not.toMatch(/startDecisionLoop/);
    expect(source).toContain("'/api/v1/llm/decisions/start'");
    expect(source).toContain("'/api/v1/llm/decisions/stop'");
  });

  it('rejects a second start and allows stop while idle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ist('2026-10-24', '11:00'));
    try {
      const { LlmTradeAdvisorService } = await import('../src/llm/LlmTradeAdvisorService.js');
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const getQuotes = vi.fn().mockResolvedValue({});
      const advisor = new LlmTradeAdvisorService({
        llm: {} as never,
        news: { fetchIndexNews: vi.fn().mockResolvedValue([]) } as never,
        kite: { getQuotes } as never,
        logger,
      });

      expect(advisor.getDecisionLoopStatus().running).toBe(false);
      expect(advisor.stop().running).toBe(false);

      const started = await advisor.startDecisionLoop(['NIFTY']);
      expect(started.running).toBe(true);
      expect(getQuotes).not.toHaveBeenCalled();
      await expect(advisor.startDecisionLoop(['NIFTY'])).rejects.toThrow(/already running/);

      advisor.stop();
      expect(advisor.isDecisionLoopRunning()).toBe(false);
      expect(createMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores a rules-based BUY with an LLM-picked strike and a plain-English rationale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
    try {
      createMany.mockClear();
      const { advisor, completeJson, logger, optionPrice } = await optionsAdvisorScenario();

      const started = await advisor.startDecisionLoop(['NIFTY']);
      advisor.stop();

      expect(started).toMatchObject({
        running: true,
        book: 'options',
        includedSymbols: ['NIFTY26OCT25000CE'],
      });
      expect(completeJson).toHaveBeenCalledTimes(1);
      const stored = createMany.mock.calls[0]?.[0]?.data[0] as Record<string, unknown> & {
        marketSnapshot: {
          schema: string;
          entry: { pickedBy: string };
          position: { lotSize: number };
        };
      };
      const ask = optionPrice('NIFTY26OCT25000CE') + 0.1;
      expect(stored).toMatchObject({
        symbol: 'NIFTY26OCT25000CE',
        action: 'BUY',
        buyPrice: ask.toFixed(4),
        model: 'test-model',
        executed: false,
      });
      expect(stored.marketSnapshot).toMatchObject({
        schema: 'rules-v1',
        entry: { pickedBy: 'llm' },
        position: { lotSize: 65 },
      });
      expect(stored.rationale).toEqual(
        expect.stringContaining('Bought 1 lot (65 units) of NIFTY 25,000 Call'),
      );
      expect(stored.rationale).not.toMatch(/\b(VWAP|EMA|RSI|PCR|OI|delta|IV)\b/i);
      // The chart plan: a stop under the setup, a loss within ₹15 a unit, the ₹10 lock.
      const plan = (stored.marketSnapshot as StoredRow['marketSnapshot']).entry?.plan;
      expect(plan?.lockPrice).toBeCloseTo(ask + 10, 2);
      expect(plan?.premiumStop).toBeLessThan(ask);
      expect(plan?.premiumStop).toBeGreaterThanOrEqual(ask - 15);
      expect(plan?.maxLossInr).toBeLessThan(15 * 65 + 100);
      expect(stored.rationale).toContain('a planned loss of about ₹');
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BUY',
          stopSpot: plan?.stopSpot,
          premiumStop: plan?.premiumStop,
          lockPrice: plan?.lockPrice,
          maxLossInr: plan?.maxLossInr,
        }),
        'Stored rules-based BUY without executing.',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LlmTradeAdvisorService one open trade at a time', () => {
  beforeEach(() => {
    createMany.mockClear();
    findFirst.mockReset().mockResolvedValue(null);
    findMany.mockReset().mockResolvedValue([]);
  });

  it('blocks a BUY while a trade is open, keeps one tuuid from BUY to SELL, then allows a new BUY', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
      const { advisor, completeJson, fetchIndexNews, getFiveMinuteCandles, setOptionPriceFactor } =
        await optionsAdvisorScenario();
      const started = await advisor.startDecisionLoop(['NIFTY']);
      advisor.stop();

      const [buy] = storedRows();
      expect(buy).toMatchObject({ action: 'BUY', symbol: 'NIFTY26OCT25000CE' });
      expect(buy?.tuuid).toMatch(UUID);
      expect(started.tuuid).toBe(buy?.tuuid);

      // Entry signals are unchanged, but the open trade only gets a HOLD.
      vi.setSystemTime(ist('2026-10-21', '10:31'));
      await advisor.runDecisionCycle();
      expect(completeJson).toHaveBeenCalledTimes(1);
      expect(storedRows()[1]).toMatchObject({ action: 'HOLD', tuuid: buy?.tuuid });
      expect(storedRows().filter((row) => row.action === 'BUY')).toHaveLength(1);

      // A 50% drop hits the stop-loss: SELL (stored as EXIT) with the same tuuid.
      setOptionPriceFactor(0.5);
      vi.setSystemTime(ist('2026-10-21', '10:32'));
      await advisor.runDecisionCycle();
      expect(storedRows()[2]).toMatchObject({ action: 'EXIT', tuuid: buy?.tuuid });
      expect(advisor.getDecisionLoopStatus().tuuid).toBeNull();

      // Flat again but inside the 30-minute cooldown after the SELL: no BUY yet.
      setOptionPriceFactor(1);
      vi.setSystemTime(ist('2026-10-21', '10:33'));
      await advisor.runDecisionCycle();
      expect(storedRows()[3]).toMatchObject({
        action: 'SKIP',
        marketSnapshot: { blockedBy: expect.arrayContaining(['cooldown']) },
      });

      // After the cooldown the next cycle may BUY, under a new tuuid.
      vi.setSystemTime(ist('2026-10-21', '11:05'));
      await advisor.runDecisionCycle();
      const rebuy = storedRows()[4];
      expect(rebuy).toMatchObject({ action: 'BUY' });
      expect(rebuy?.tuuid).toMatch(UUID);
      expect(rebuy?.tuuid).not.toBe(buy?.tuuid);
      expect(completeJson).toHaveBeenCalledTimes(2);

      // Caches: today's rows for the daily limits are read from the DB once; after the first
      // cycle only today's futures bars are fetched; macro news is re-fetched after 15 minutes.
      expect(findMany).toHaveBeenCalledTimes(1);
      const barsFrom = getFiveMinuteCandles.mock.calls.map((call) => call[1] as string);
      expect(barsFrom[0]?.startsWith('2026-10-14')).toBe(true);
      expect(barsFrom.slice(1).every((from) => from === '2026-10-21 00:00:00')).toBe(true);
      const macroCalls = fetchIndexNews.mock.calls.filter((call) =>
        (call[0] as Array<{ symbol: string }>).some((query) => query.symbol === 'GLOBAL'),
      );
      expect(macroCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only HOLDs or EXITs the open trade, analysing just its index, until it is sold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
      const { advisor, setOptionPriceFactor } = await optionsAdvisorScenario();
      await advisor.startDecisionLoop(['NIFTY', 'BANKNIFTY']);
      advisor.stop();
      const [buy] = storedRows();
      expect(buy).toMatchObject({ action: 'BUY', symbol: 'NIFTY26OCT25000CE' });

      // In profit, so no exit rule fires. 14:45 is after the last entry time, where a flat
      // book would store a SKIP; with the trade open it must be a HOLD.
      setOptionPriceFactor(1.1);
      for (const time of ['10:31', '12:00', '14:45']) {
        vi.setSystemTime(ist('2026-10-21', time));
        await advisor.runDecisionCycle();
      }
      setOptionPriceFactor(0.5);
      vi.setSystemTime(ist('2026-10-21', '14:46'));
      await advisor.runDecisionCycle();

      const whileOpen = storedRows().slice(1);
      expect(whileOpen.map((row) => row.action)).toEqual(['HOLD', 'HOLD', 'HOLD', 'EXIT']);
      for (const row of whileOpen) {
        expect(row).toMatchObject({ symbol: buy?.symbol, tuuid: buy?.tuuid });
        if (row.action === 'HOLD') {
          expect(row.marketSnapshot.readings?.map((item) => item.index)).toEqual(['NIFTY']);
        }
      }

      // Sold: the next cycle is flat again and may SKIP.
      vi.setSystemTime(ist('2026-10-21', '14:50'));
      await advisor.runDecisionCycle();
      expect(storedRows().at(-1)).toMatchObject({ action: 'SKIP', symbol: 'NIFTY26OCTFUT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks the stop-loss against the bid, the price a sell would get', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
      const { advisor, optionPrice, setOptionPriceFactor } = await optionsAdvisorScenario();
      await advisor.startDecisionLoop(['NIFTY']);
      advisor.stop();
      const entry = Number(storedRows()[0]?.buyPrice);
      const stop = storedRows()[0]?.marketSnapshot.entry?.plan?.premiumStop ?? NaN;
      expect(stop).toBeLessThan(entry);
      // Last trade 0.05 above the planned premium stop, bid 0.05 below it.
      setOptionPriceFactor((stop + 0.05) / optionPrice('NIFTY26OCT25000CE'));
      vi.setSystemTime(ist('2026-10-21', '10:31'));
      await advisor.runDecisionCycle();
      const exit = storedRows()[1];
      expect(exit).toMatchObject({
        action: 'EXIT',
        marketSnapshot: { exit: { reason: 'stop-loss' } },
      });
      expect(Number(exit?.sellPrice)).toBeLessThan(stop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sells when NIFTY breaks the chart stop under the setup candles', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
      const { advisor, setNiftySpot } = await optionsAdvisorScenario();
      await advisor.startDecisionLoop(['NIFTY']);
      advisor.stop();
      const stopSpot = storedRows()[0]?.marketSnapshot.entry?.plan?.stopSpot ?? NaN;
      // Under the low of the last two 5-minute candles by a quarter of a normal swing.
      expect(stopSpot).toBeCloseTo(24_982.72, 1);
      expect(storedRows()[0]?.rationale).toContain('sell if NIFTY falls below 24,983');

      setNiftySpot(24_984);
      vi.setSystemTime(ist('2026-10-21', '10:31'));
      await advisor.runDecisionCycle();
      setNiftySpot(24_982);
      vi.setSystemTime(ist('2026-10-21', '10:32'));
      await advisor.runDecisionCycle();

      expect(storedRows().slice(1).map((row) => row.action)).toEqual(['HOLD', 'EXIT']);
      expect(storedRows()[2]?.marketSnapshot.exit?.reason).toBe('chart-stop');
      expect(storedRows()[2]?.rationale).toContain('NIFTY fell below 24,983');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the planned stops of a trade restored after a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
      const first = await optionsAdvisorScenario();
      await first.advisor.startDecisionLoop(['NIFTY']);
      first.advisor.stop();
      const [buy] = storedRows();
      const plan = buy?.marketSnapshot.entry?.plan;
      expect(plan).toBeDefined();
      // The next start finds that BUY still open.
      findFirst
        .mockResolvedValueOnce({
          symbol: buy?.symbol,
          action: 'BUY',
          instrumentToken: buy?.instrumentToken,
          marketSnapshot: buy?.marketSnapshot,
          decidedAt: ist('2026-10-21', '10:30'),
          currentPrice: Number(buy?.buyPrice),
          tuuid: buy?.tuuid,
        })
        .mockResolvedValueOnce({
          asOf: ist('2026-10-21', '10:30'),
          decidedAt: ist('2026-10-21', '10:30'),
          buyPrice: Number(buy?.buyPrice),
          instrumentToken: buy?.instrumentToken,
          marketSnapshot: buy?.marketSnapshot,
          tuuid: buy?.tuuid,
        });
      vi.setSystemTime(new Date(ist('2026-10-21', '10:35').getTime() + 20_000));
      const second = await optionsAdvisorScenario();
      await second.advisor.startDecisionLoop(['NIFTY']);
      second.advisor.stop();
      expect(storedRows().at(-1)).toMatchObject({
        action: 'HOLD',
        tuuid: buy?.tuuid,
        marketSnapshot: { position: { stopSpot: plan?.stopSpot, premiumStop: plan?.premiumStop } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('raises the chart stop under a new swing low and sells when NIFTY breaks it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
      const { advisor, getFiveMinuteCandles, setNiftySpot } = await optionsAdvisorScenario();
      await advisor.startDecisionLoop(['NIFTY']);
      advisor.stop();
      const initial = storedRows()[0]?.marketSnapshot.entry?.plan?.stopSpot ?? NaN;

      // After the buy: two higher candles, a dip to a higher low (24,664), then two more higher
      // candles that confirm it as a swing low.
      const before = uptrendFuturesBars({
        yesterday: '2026-10-20',
        today: '2026-10-21',
        startPrice: 24_400,
      });
      getFiveMinuteCandles.mockResolvedValue([
        ...before,
        ...fiveMinuteBars('2026-10-21', '10:30', [
          [24_670, 24_692, 24_668, 24_690],
          [24_690, 24_702, 24_688, 24_700],
          [24_700, 24_702, 24_664, 24_668],
          [24_668, 24_682, 24_666, 24_680],
          [24_680, 24_694, 24_678, 24_692],
        ]),
      ]);
      vi.setSystemTime(new Date(ist('2026-10-21', '10:55').getTime() + 20_000));
      await advisor.runDecisionCycle();
      const hold = storedRows()[1];
      expect(hold?.action).toBe('HOLD');
      const atr = hold?.marketSnapshot.readings?.[0]?.chart?.atr ?? NaN;
      // Futures trade 330 under spot here: 24,664 on futures is 24,994 on NIFTY.
      const trailed = hold?.marketSnapshot.position?.stopSpot ?? NaN;
      expect(trailed).toBeGreaterThan(initial);
      expect(trailed).toBeCloseTo(24_664 + 330 - 0.25 * atr, 1);

      setNiftySpot(Math.floor(trailed));
      vi.setSystemTime(ist('2026-10-21', '10:56'));
      await advisor.runDecisionCycle();
      expect(storedRows()[2]).toMatchObject({
        action: 'EXIT',
        marketSnapshot: { exit: { reason: 'chart-stop' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops buying for the day once a closed trade leaves the day in profit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
      const { advisor, setOptionPriceFactor } = await optionsAdvisorScenario();
      await advisor.startDecisionLoop(['NIFTY']);
      advisor.stop();

      // Best +30%, then back to +10%: the trailing stop sells at a profit.
      setOptionPriceFactor(1.3);
      vi.setSystemTime(ist('2026-10-21', '10:31'));
      await advisor.runDecisionCycle();
      setOptionPriceFactor(1.1);
      vi.setSystemTime(ist('2026-10-21', '10:32'));
      await advisor.runDecisionCycle();
      const exit = storedRows()[2];
      expect(exit?.marketSnapshot.exit?.reason).toBe('trailing-stop');
      expect(Number(exit?.sellPrice)).toBeGreaterThan(Number(exit?.buyPrice));

      // Past the cool-down, the same market would buy again; the green day stays green.
      vi.setSystemTime(ist('2026-10-21', '11:15'));
      await advisor.runDecisionCycle();
      expect(storedRows().at(-1)).toMatchObject({
        action: 'SKIP',
        marketSnapshot: { blockedBy: ['day-in-profit'] },
      });
      expect(storedRows().at(-1)?.rationale).toContain(
        "today's closed trades are already in profit",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reviews an open trade every minute and returns to the .env interval once it is sold', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    // setImmediate stays real, so each step lets the cycle's promise chain settle.
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await new Promise((resolve) => setImmediate(resolve));
    };
    let stop: (() => unknown) | undefined;
    try {
      vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
      const { advisor, setOptionPriceFactor } = await optionsAdvisorScenario();
      stop = () => advisor.stop();
      const started = await advisor.startDecisionLoop(['NIFTY']);
      expect(started).toMatchObject({ decisionIntervalMinutes: 5, currentIntervalMinutes: 1 });
      expect(storedRows().map((row) => row.action)).toEqual(['BUY']);

      // The open trade gets its next full review a minute later, not at the 5-minute slot.
      await advance(60_000);
      expect(storedRows()[1]).toMatchObject({
        action: 'HOLD',
        asOf: new Date(ist('2026-10-21', '10:31').getTime() + 20_000),
      });

      // The 15-second monitor sells on the stop-loss before the 10:32 review.
      setOptionPriceFactor(0.5);
      await advance(15_000);
      expect(storedRows()[2]).toMatchObject({
        action: 'EXIT',
        marketSnapshot: { trigger: 'monitor', exit: { reason: 'stop-loss' } },
      });
      expect(advisor.getDecisionLoopStatus().currentIntervalMinutes).toBe(5);

      // Flat again: the leftover 10:32 slot stores nothing; the next row is the 10:35 SKIP.
      setOptionPriceFactor(1);
      await advance(60_000);
      expect(storedRows()).toHaveLength(3);
      await advance(3 * 60_000);
      expect(storedRows()).toHaveLength(4);
      expect(storedRows()[3]).toMatchObject({
        action: 'SKIP',
        asOf: new Date(ist('2026-10-21', '10:35').getTime() + 20_000),
      });
    } finally {
      stop?.();
      vi.useRealTimers();
    }
  });

  it('stores SKIP rows without a tuuid', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // After the last entry time and before square-off: flat, so the cycle stores a SKIP.
      vi.setSystemTime(ist('2026-10-21', '14:45'));
      const { advisor, completeJson } = await optionsAdvisorScenario();
      await advisor.runDecisionCycle();

      const [skip] = storedRows();
      // Stored under the futures contract, never an option or the bare index name.
      expect(skip).toMatchObject({ action: 'SKIP', symbol: 'NIFTY26OCTFUT', instrumentToken: 9001 });
      expect(skip).not.toHaveProperty('tuuid');
      expect(skip?.marketSnapshot).toMatchObject({ leaning: { symbol: expect.stringMatching(/CE$/) } });
      expect(completeJson).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the stored tuuid onto HOLDs of a restored trade', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(ist('2026-10-21', '10:35'));
      const { advisor, completeJson, optionPrice } = await optionsAdvisorScenario();
      const tuuid = '6f1c2a4e-0b7d-4c1e-9a52-3d8e7f6a1b20';
      const buyPrice = optionPrice('NIFTY26OCT25000CE') + 0.1;
      findFirst
        .mockResolvedValueOnce({
          symbol: 'NIFTY26OCT25000CE',
          action: 'BUY',
          instrumentToken: 250001,
          marketSnapshot: {},
          decidedAt: ist('2026-10-21', '10:30'),
          currentPrice: buyPrice,
          tuuid,
        })
        .mockResolvedValueOnce({
          asOf: ist('2026-10-21', '10:30'),
          decidedAt: ist('2026-10-21', '10:30'),
          buyPrice,
          instrumentToken: 250001,
          marketSnapshot: {},
          tuuid,
        });

      const started = await advisor.startDecisionLoop(['NIFTY']);
      advisor.stop();

      expect(started.tuuid).toBe(tuuid);
      expect(completeJson).not.toHaveBeenCalled();
      expect(storedRows()).toEqual([
        expect.objectContaining({ action: 'HOLD', symbol: 'NIFTY26OCT25000CE', tuuid }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a trade left open overnight at its own day's 3:15 PM price", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(ist('2026-10-21', '10:35'));
      const { advisor, getFiveMinuteCandles } = await optionsAdvisorScenario();
      const tuuid = '3b7d9e1f-2a4c-4e6b-8d0f-1a3c5e7b9d2f';
      findFirst
        .mockResolvedValueOnce({
          symbol: 'NIFTY26OCT25000CE',
          action: 'HOLD',
          instrumentToken: 250001,
          marketSnapshot: {},
          decidedAt: ist('2026-10-20', '11:40'),
          currentPrice: 118,
          tuuid,
        })
        .mockResolvedValueOnce({
          asOf: ist('2026-10-20', '11:35'),
          decidedAt: ist('2026-10-20', '11:35'),
          buyPrice: 120,
          instrumentToken: 250001,
          marketSnapshot: {},
          tuuid,
        });
      const bar = (time: string, close: number) => ({
        t: ist('2026-10-20', time).toISOString(),
        o: close,
        h: close,
        l: close,
        c: close,
        v: 1_000,
      });
      // The 15:10 bar closes at 3:15 PM; the 15:15 bar is after the square-off.
      getFiveMinuteCandles.mockResolvedValueOnce([
        bar('15:05', 131),
        bar('15:10', 133.5),
        bar('15:15', 135),
      ]);

      await advisor.startDecisionLoop(['NIFTY']);
      advisor.stop();

      expect(getFiveMinuteCandles).toHaveBeenNthCalledWith(
        1,
        250001,
        '2026-10-20 14:45:00',
        '2026-10-20 15:15:00',
      );
      const [sell] = storedRows();
      expect(sell).toMatchObject({
        action: 'EXIT',
        symbol: 'NIFTY26OCT25000CE',
        tuuid,
        buyPrice: '120.0000',
        sellPrice: '133.5000',
        marketSnapshot: {
          trigger: 'startup',
          exit: { reason: 'stale-position', priceSource: 'square-off-candle' },
        },
      });
      expect(sell?.rationale).toContain('held for 220 minutes');
      expect(sell?.rationale).toContain('recorded at its 3:15 PM price on the day it was bought');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sells an open trade it cannot restore before trading again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(ist('2026-10-21', '10:30').getTime() + 20_000));
      const { advisor, logger } = await optionsAdvisorScenario();
      const tuuid = '0a9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c';
      // A leftover stock BUY from the old equity loop: not an index option.
      findFirst
        .mockResolvedValueOnce({
          symbol: 'RELIANCE',
          action: 'BUY',
          instrumentToken: 738561,
          marketSnapshot: {},
          decidedAt: ist('2026-10-21', '09:45'),
          currentPrice: 1410,
          tuuid,
        })
        .mockResolvedValueOnce({
          asOf: ist('2026-10-21', '09:45'),
          decidedAt: ist('2026-10-21', '09:45'),
          buyPrice: 1400,
          instrumentToken: 738561,
          marketSnapshot: {},
          tuuid,
        });

      await advisor.startDecisionLoop(['NIFTY']);
      advisor.stop();

      const [sell, buy] = storedRows();
      expect(sell).toMatchObject({
        action: 'EXIT',
        symbol: 'RELIANCE',
        tuuid,
        buyPrice: '1400.0000',
        sellPrice: '1410.0000',
        marketSnapshot: { trigger: 'startup', exit: { reason: 'unrestorable' } },
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'RELIANCE', tuuid }),
        expect.stringContaining('could not be restored'),
      );
      expect(buy).toMatchObject({ action: 'BUY', symbol: 'NIFTY26OCT25000CE' });
      expect(buy?.tuuid).toMatch(UUID);
      expect(buy?.tuuid).not.toBe(tuuid);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('filterSnapshotsToSymbols', () => {
  it('keeps only watchlist names from Kite JSONL snapshots', () => {
    const filtered = filterSnapshotsToSymbols(
      [
        {
          ts: '2026-08-21T10:15:00.000Z',
          instruments: [
            { tradingsymbol: 'RELIANCE', lastPrice: 1400 },
            { tradingsymbol: 'TCS', lastPrice: 3000 },
          ],
        },
      ],
      new Set(['RELIANCE']),
    );
    expect(filtered[0]?.instruments).toEqual([{ tradingsymbol: 'RELIANCE', lastPrice: 1400 }]);
  });
});
