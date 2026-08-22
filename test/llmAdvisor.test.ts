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
      decisionIntervalMinutes: 15,
      newsLookbackDays: 30,
      newsItemsPerSymbol: 8,
      tradesDir: 'trades',
      universeDir: 'universe',
      kiteInstrumentsPath: 'data/kite-instruments.json',
    },
    session: {
      quoteLogPath: 'logs/session-quotes.jsonl',
    },
  },
}));

const createMany = vi.fn().mockResolvedValue({ count: 1 });
const findFirst = vi.fn().mockResolvedValue(null);

vi.mock('../src/database.js', () => ({
  database: {
    llmTradeDecision: {
      createMany,
      findFirst,
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
const { persistDecisions, LLM_EXECUTION_BLOCKED_REASON, pricesForDecision } = await import('../src/llm/decisionStore.js');
const { filterSnapshotsToSymbols, lastPricesFromSnapshots } = await import('../src/llm/quoteLogReader.js');
const { compactNewsForPrompt, buildUniverseMessages, buildDecisionMessages } = await import('../src/llm/prompts.js');
const { parseRssItems } = await import('../src/news/NewsService.js');

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
    const client = new HuggingFaceClient({ token: 'hf_test_token_value', fetchImpl, maxTokens: 1200 });
    await client.connect();
    await client.completeJson([{ role: 'user', content: '{"n":[]}' }], { maxTokens: 400 });
    const chatCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes('/chat/completions'));
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
    expect(messages[0]?.content).toContain('at most 2');
    expect(messages[0]?.content).toContain('Zero includes is valid');
    expect(messages[1]?.content).toContain('"maxInclude":2');
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
    const filtered = intersectWatchlistWithCatalog(
      suggestion,
      new Set(['RELIANCE', 'NIFTYBEES']),
    );
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

  it('clamps more than two includes and allows an empty pick', () => {
    const clamped = clampWatchlistToTop(
      universeSuggestionSchema.parse({
        watchlist: [
          { symbol: 'RELIANCE', include: true, rationale: 'results plus rs' },
          { symbol: 'TCS', include: true, rationale: 'buyback' },
          { symbol: 'INFY', include: true, rationale: 'third' },
        ],
      }),
    );
    expect(clamped.watchlist.map((item) => item.symbol)).toEqual(['RELIANCE', 'TCS']);
    expect(clamped.watchlist.every((item) => item.include)).toBe(true);
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
    expect(allowedActionsForLatest('HOLD')).toEqual(['EXIT']);
    expect(decisionBatchSchema.parse({
      decisions: [{ symbol: 'RELIANCE', action: 'SKIP', rationale: 'no setup this interval' }],
    }).decisions[0]?.action).toBe('SKIP');
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
      [{ ts: '2026-08-22T09:30:00.000Z', instruments: [{ tradingsymbol: 'RELIANCE', lastPrice: 1400 }] }],
      [{ symbol: 'RELIANCE', last: 'BUY', allowed: ['HOLD', 'EXIT'] }],
    );
    expect(messages[0]?.content).toContain('do not force BUY');
    const payload = JSON.parse(messages[1]?.content ?? '{}') as {
      allowed: Array<{ s: string; last: string; opts: string[] }>;
    };
    expect(payload.allowed).toEqual([{ s: 'RELIANCE', last: 'BUY', opts: ['HOLD', 'SELL'] }]);
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
      model: 'Qwen/Qwen3-14B:fastest',
      promptHash: 'abc',
      rawCompletion: '{"decisions":[]}',
      marketSnapshot: [{ ts: '2026-08-21T10:15:00.000Z', instruments: [] }],
      watchlistFile: 'trades/example.json',
      lastPriceBySymbol: { RELIANCE: 1400.5 },
    });

    expect(count).toBe(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          symbol: 'RELIANCE',
          action: 'BUY',
          buyPrice: '1400.5000',
          executed: false,
          executionBlockedReason: LLM_EXECUTION_BLOCKED_REASON,
        }),
      ],
    });
    expect(createMany.mock.calls[0]?.[0]?.data[0]).not.toHaveProperty('sellPrice');
  });

  it('stores sellPrice on EXIT and carries the prior buyPrice', () => {
    expect(pricesForDecision('BUY', 100.5, null)).toEqual({ buyPrice: '100.5000', sellPrice: null });
    expect(pricesForDecision('HOLD', 110, '100.5000')).toEqual({ buyPrice: '100.5000', sellPrice: null });
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

describe('LlmTradeAdvisorService safety', () => {
  it('does not place orders or auto-start a market-data session', async () => {
    const sourcePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/llm/LlmTradeAdvisorService.ts',
    );
    const source = await readFile(sourcePath, 'utf8');
    expect(source).not.toMatch(/placeLimitOrder/);
    expect(source).not.toMatch(/PaperBroker/);
    expect(source).not.toMatch(/sessionService\.start/);
    expect(source).not.toMatch(/maybeStartMarketDataSession/);
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
    const { LlmTradeAdvisorService } = await import('../src/llm/LlmTradeAdvisorService.js');
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const advisor = new LlmTradeAdvisorService({
      llm: {} as never,
      news: {} as never,
      kite: {} as never,
      logger,
    });

    expect(advisor.getDecisionLoopStatus().running).toBe(false);
    expect(advisor.stop().running).toBe(false);

    const started = advisor.startDecisionLoop();
    expect(started.running).toBe(true);
    expect(() => advisor.startDecisionLoop()).toThrow(/already running/);

    advisor.stop();
    expect(advisor.isDecisionLoopRunning()).toBe(false);
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
