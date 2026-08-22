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
      kiteInstrumentsPath: 'data/kite-instruments.json',
    },
    session: {
      quoteLogPath: 'logs/session-quotes.jsonl',
    },
  },
}));

const createMany = vi.fn().mockResolvedValue({ count: 1 });

vi.mock('../src/database.js', () => ({
  database: {
    llmTradeDecision: {
      createMany,
    },
  },
}));

const { HuggingFaceClient } = await import('../src/llm/huggingfaceClient.js');
const { decisionBatchSchema, intersectWatchlistWithCatalog, universeSuggestionSchema } =
  await import('../src/llm/schemas.js');
const { persistDecisions, LLM_EXECUTION_BLOCKED_REASON } = await import('../src/llm/decisionStore.js');
const { filterSnapshotsToSymbols } = await import('../src/llm/quoteLogReader.js');
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
});

describe('LLM schemas', () => {
  it('maps ENTER_LONG and SKIP onto buy/hold/exit and drops leaked tickers', () => {
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
        { symbol: 'RELIANCE', action: 'skip', rationale: 'wait' },
      ],
    });
    expect(batch.decisions[0]?.action).toBe('BUY');
    expect(batch.decisions[1]?.action).toBe('HOLD');
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
    });

    expect(count).toBe(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          symbol: 'RELIANCE',
          action: 'BUY',
          executed: false,
          executionBlockedReason: LLM_EXECUTION_BLOCKED_REASON,
        }),
      ],
    });
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
