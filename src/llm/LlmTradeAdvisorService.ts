import type { Prisma } from '@prisma/client';
import path from 'node:path';

import type { SessionLogger } from '../broker/kite/KiteTickerStream.js';
import { config } from '../config.js';
import type { SessionInstrument } from '../domain.js';
import {
  getCatalogTradingsymbols,
  loadKiteInstruments,
  lookupSessionStartInstruments,
} from '../instruments/kiteInstruments.js';
import type { HuggingFaceClient } from './huggingfaceClient.js';
import { buildDecisionMessages, buildUniverseMessages } from './prompts.js';
import { filterSnapshotsToSymbols, readRecentQuoteSnapshots } from './quoteLogReader.js';
import {
  decisionBatchSchema,
  filterDecisionsToSymbols,
  intersectWatchlistWithCatalog,
  universeSuggestionSchema,
  type UniverseSuggestion,
} from './schemas.js';
import { formatIstTimestamp, hashPrompt, persistDecisions, writeUniverseFile } from './decisionStore.js';
import type { NewsService } from '../news/NewsService.js';

export type LlmTradeAdvisorOptions = {
  llm: HuggingFaceClient;
  news: NewsService;
  logger: SessionLogger;
};

export type UniverseSuggestResult = {
  filePath: string;
  asOfIst: string;
  model: string;
  newsItemCount: number;
  includedSymbols: string[];
  unmappedSymbols: string[];
  sessionStartPayload: { instruments: SessionInstrument[] };
  suggestion: UniverseSuggestion;
};

export class LlmTradeAdvisorService {
  private readonly llm: HuggingFaceClient;
  private readonly news: NewsService;
  private readonly logger: SessionLogger;
  private timer: NodeJS.Timeout | undefined;
  private includedSymbols: string[] = [];
  private sessionStartPayload: { instruments: SessionInstrument[] } = { instruments: [] };
  private watchlistFile: string | null = null;

  public constructor(options: LlmTradeAdvisorOptions) {
    this.llm = options.llm;
    this.news = options.news;
    this.logger = options.logger;
  }

  public getIncludedSymbols(): readonly string[] {
    return this.includedSymbols;
  }

  public getWatchlistFile(): string | null {
    return this.watchlistFile;
  }

  public getSessionStartPayload(): { instruments: SessionInstrument[] } {
    return this.sessionStartPayload;
  }

  /**
   * Fetch ~1 month of news, ask the LLM for a watchlist, map hits onto data/kite-instruments.json,
   * and write timestamped JSON under trades/. Does not start a market-data session.
   */
  public async suggestUniverse(): Promise<UniverseSuggestResult> {
    const catalogPath = path.resolve(config.llm.kiteInstrumentsPath);
    const catalog = loadKiteInstruments(catalogPath);
    const kiteTradingsymbols = getCatalogTradingsymbols(catalogPath);
    const asOfIst = formatIstTimestamp();
    this.logger.info(
      { catalogCount: kiteTradingsymbols.length, lookbackDays: config.llm.newsLookbackDays },
      'Fetching roughly one month of news for LLM universe suggestion.',
    );

    const news = await this.news.fetchMonthOfNews(kiteTradingsymbols);
    const newsItemCount = news.reduce((sum, entry) => sum + entry.items.length, 0);
    const messages = buildUniverseMessages(asOfIst, kiteTradingsymbols, news);
    const completion = await this.completeWithRetry(messages, 'universe');
    const parsed = intersectWatchlistWithCatalog(
      universeSuggestionSchema.parse(completion.parsed),
      new Set(kiteTradingsymbols),
    );
    const includedSymbols = parsed.watchlist
      .filter((item) => item.include)
      .map((item) => item.symbol);
    const { instruments, unmappedSymbols } = lookupSessionStartInstruments(includedSymbols, catalog);

    const sessionStartPayload = { instruments };
    const filePath = await writeUniverseFile({
      generatedAt: new Date().toISOString(),
      asOfIst,
      model: this.llm.getModel(),
      newsItemCount,
      suggestion: parsed,
      includedSymbols,
      sessionStartPayload,
      unmappedSymbols,
    });

    this.includedSymbols = instruments.map((instrument) => instrument.tradingsymbol);
    this.sessionStartPayload = sessionStartPayload;
    this.watchlistFile = filePath;

    this.logger.info(
      {
        filePath,
        includedSymbols: this.includedSymbols,
        unmappedSymbols,
        excludedCount: parsed.exclude.length,
        newsItemCount,
      },
      'Wrote LLM trade universe JSON with session/start payload from the Kite instrument catalog.',
    );

    return {
      filePath,
      asOfIst,
      model: this.llm.getModel(),
      newsItemCount,
      includedSymbols: this.includedSymbols,
      unmappedSymbols,
      sessionStartPayload,
      suggestion: parsed,
    };
  }

  public startDecisionLoop(): void {
    if (this.timer) {
      return;
    }

    const intervalMs = config.llm.decisionIntervalMinutes * 60_000;
    this.timer = setInterval(() => {
      void this.runDecisionCycle();
    }, intervalMs);
    this.timer.unref?.();

    this.logger.info(
      { intervalMinutes: config.llm.decisionIntervalMinutes },
      'Started LLM buy/hold/exit decision loop. Decisions are stored only; no broker orders.',
    );
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async runDecisionCycle(): Promise<number> {
    if (this.includedSymbols.length === 0) {
      this.logger.info('Skipping LLM decision cycle because no watchlist has been suggested yet.');
      return 0;
    }

    const symbols = new Set(this.includedSymbols);
    const snapshots = filterSnapshotsToSymbols(await readRecentQuoteSnapshots(), symbols);
    if (snapshots.length === 0) {
      this.logger.info(
        { symbols: this.includedSymbols, logPath: config.session.quoteLogPath },
        'Skipping LLM decision cycle; no Kite quote snapshots in logs for the watchlist yet.',
      );
      return 0;
    }

    const asOf = new Date();
    const asOfIst = formatIstTimestamp(asOf);
    const messages = buildDecisionMessages(asOfIst, this.includedSymbols, snapshots);
    const completion = await this.completeWithRetry(messages, 'decision');
    const batch = filterDecisionsToSymbols(decisionBatchSchema.parse(completion.parsed), symbols);

    const stored = await persistDecisions({
      asOf,
      batch,
      model: this.llm.getModel(),
      promptHash: hashPrompt(messages),
      rawCompletion: completion.text,
      marketSnapshot: JSON.parse(JSON.stringify(snapshots)) as Prisma.InputJsonValue,
      watchlistFile: this.watchlistFile,
    });

    this.logger.info(
      { stored, symbols: batch.decisions.map((item) => `${item.symbol}:${item.action}`) },
      'Stored LLM trade decisions in Postgres without executing them.',
    );

    return stored;
  }

  private async completeWithRetry(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    label: string,
  ) {
    try {
      return await this.llm.completeJson(messages);
    } catch (error: unknown) {
      this.logger.warn({ err: error, label }, 'First Hugging Face JSON completion failed; retrying once.');
      return this.llm.completeJson(messages);
    }
  }
}
