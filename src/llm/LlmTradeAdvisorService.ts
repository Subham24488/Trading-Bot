import type { Prisma } from '@prisma/client';
import path from 'node:path';

import type { KiteBroker } from '../broker/KiteBroker.js';
import type { SessionLogger } from '../broker/kite/KiteTickerStream.js';
import { config } from '../config.js';
import type { SessionInstrument } from '../domain.js';
import {
  getCatalogTradingsymbols,
  loadKiteInstruments,
  lookupSessionStartInstruments,
  type KiteInstrumentRef,
} from '../instruments/kiteInstruments.js';
import type { HuggingFaceClient } from './huggingfaceClient.js';
import {
  buildDecisionMessages,
  buildUniverseMessages,
  DECISION_MAX_OUTPUT_TOKENS,
  UNIVERSE_MAX_OUTPUT_TOKENS,
} from './prompts.js';
import { filterSnapshotsToSymbols, lastPricesFromSnapshots, readRecentQuoteSnapshots } from './quoteLogReader.js';
import {
  clampWatchlistToTop,
  decisionBatchSchema,
  filterDecisionsToSymbols,
  clampDecisionsToAllowed,
  allowedActionsForLatest,
  intersectWatchlistWithCatalog,
  universeSuggestionSchema,
  type UniverseSuggestion,
} from './schemas.js';
import { formatIstTimestamp, hashPrompt, latestActionsForSymbols, persistDecisions, writeUniverseFile } from './decisionStore.js';
import type { NewsService } from '../news/NewsService.js';
import {
  UNIVERSE_BAR_LOOKBACK_DAYS,
  computeFetchWindow,
  istYmd,
  ymdToUtcDate,
} from '../universe/dates.js';
import { rankCandidates } from '../universe/features.js';
import { mergeKnowledge, readLatestKnowledge, writeKnowledgeFile } from '../universe/knowledgeStore.js';
import type { DailyBar } from '../universe/types.js';

export type LlmTradeAdvisorOptions = {
  llm: HuggingFaceClient;
  news: NewsService;
  kite: KiteBroker;
  logger: SessionLogger;
};

export type UniverseSuggestResult = {
  filePath: string;
  asOfIst: string;
  model: string;
  newsItemCount: number;
  knowledgeFile: string | null;
  candidateSymbols: string[];
  includedSymbols: string[];
  unmappedSymbols: string[];
  sessionStartPayload: { instruments: SessionInstrument[] };
  suggestion: UniverseSuggestion;
};

export class LlmTradeAdvisorService {
  private readonly llm: HuggingFaceClient;
  private readonly news: NewsService;
  private readonly kite: KiteBroker;
  private readonly logger: SessionLogger;
  private timer: NodeJS.Timeout | undefined;
  private includedSymbols: string[] = [];
  private sessionStartPayload: { instruments: SessionInstrument[] } = { instruments: [] };
  private watchlistFile: string | null = null;

  public constructor(options: LlmTradeAdvisorOptions) {
    this.llm = options.llm;
    this.news = options.news;
    this.kite = options.kite;
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
   * Incremental Kite dailies + NSE filings, local rank, LLM confirms 0–2 names.
   * Writes knowledge under universe/ and the pick under trades/. Does not place orders.
   */
  public async suggestUniverse(): Promise<UniverseSuggestResult> {
    const catalogPath = path.resolve(config.llm.kiteInstrumentsPath);
    const catalog = loadKiteInstruments(catalogPath);
    const kiteTradingsymbols = getCatalogTradingsymbols(catalogPath);
    const asOfIst = formatIstTimestamp();
    const today = istYmd();
    const previous = await readLatestKnowledge();
    const window = computeFetchWindow(
      previous?.coverageTo ?? null,
      today,
      config.llm.newsLookbackDays,
      UNIVERSE_BAR_LOOKBACK_DAYS,
    );

    this.logger.info(
      {
        catalogCount: kiteTradingsymbols.length,
        coverageTo: previous?.coverageTo ?? null,
        skipRemote: window.skipRemote,
        newsFrom: window.newsFrom,
        newsTo: window.newsTo,
        barsFrom: window.barsFrom,
        barsTo: window.barsTo,
      },
      'Building universe knowledge from Kite dailies and NSE filings (Google RSS fallback).',
    );

    let news: Awaited<ReturnType<NewsService['fetchNewsForRange']>> = [];
    let bars: Record<string, DailyBar[]> = {};
    let knowledgeFile: string | null = null;
    let knowledge = previous;

    if (!window.skipRemote) {
      news = await this.news.fetchNewsForRange(
        kiteTradingsymbols,
        ymdToUtcDate(window.newsFrom),
        ymdToUtcDate(window.newsTo),
        { requireSome: window.isSeed },
      );
      bars = await this.fetchDailyBars(catalog, window.barsFrom, window.barsTo);
      const tokens = Object.fromEntries(
        catalog.map((instrument) => [instrument.tradingsymbol, instrument.instrumentToken]),
      );
      knowledge = mergeKnowledge({
        previous,
        asOfIst,
        today,
        coverageFrom: window.isSeed ? window.newsFrom : (previous?.coverageFrom ?? window.newsFrom),
        fetchedFrom: window.newsFrom,
        fetchedTo: window.newsTo,
        catalogPath,
        news,
        bars,
        tokens,
      });
      knowledgeFile = await writeKnowledgeFile(knowledge);
    }

    if (!knowledge) {
      throw new Error('Universe knowledge is empty after selection; cannot rank candidates.');
    }

    const newsItemCount = window.skipRemote
      ? Object.values(knowledge.symbols).reduce((sum, entry) => sum + entry.filings.length, 0)
      : news.reduce((sum, entry) => sum + entry.items.length, 0);

    const candidates = rankCandidates(knowledge.symbols, 8);
    const candidateSymbols = candidates.map((candidate) => candidate.symbol);
    const messages = buildUniverseMessages(asOfIst, candidates);
    const completion = await this.completeWithRetry(messages, 'universe');
    const parsed = clampWatchlistToTop(
      intersectWatchlistWithCatalog(
        universeSuggestionSchema.parse(completion.parsed),
        new Set(kiteTradingsymbols),
      ),
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
      knowledgeFile,
      candidateSymbols,
    });

    this.includedSymbols = instruments.map((instrument) => instrument.tradingsymbol);
    this.sessionStartPayload = sessionStartPayload;
    this.watchlistFile = filePath;

    this.logger.info(
      {
        filePath,
        knowledgeFile,
        candidateSymbols,
        includedSymbols: this.includedSymbols,
        unmappedSymbols,
        excludedCount: parsed.exclude.length,
        newsItemCount,
      },
      'Wrote universe knowledge and LLM pick JSON. No broker orders were sent.',
    );

    return {
      filePath,
      asOfIst,
      model: this.llm.getModel(),
      newsItemCount,
      knowledgeFile,
      candidateSymbols,
      includedSymbols: this.includedSymbols,
      unmappedSymbols,
      sessionStartPayload,
      suggestion: parsed,
    };
  }

  public isDecisionLoopRunning(): boolean {
    return this.timer !== undefined;
  }

  public getDecisionLoopStatus() {
    return {
      running: this.isDecisionLoopRunning(),
      decisionIntervalMinutes: config.llm.decisionIntervalMinutes,
      includedSymbols: [...this.includedSymbols],
      watchlistFile: this.watchlistFile,
    };
  }

  public startDecisionLoop(): ReturnType<LlmTradeAdvisorService['getDecisionLoopStatus']> {
    if (this.timer) {
      throw Object.assign(new Error('The LLM decision loop is already running.'), { statusCode: 400 });
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

    void this.runDecisionCycle();
    return this.getDecisionLoopStatus();
  }

  public stop(): ReturnType<LlmTradeAdvisorService['getDecisionLoopStatus']> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return this.getDecisionLoopStatus();
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
    const latestBySymbol = await latestActionsForSymbols(this.includedSymbols);
    const allowedRows = this.includedSymbols.map((symbol) => ({
      symbol,
      last: latestBySymbol[symbol]?.action ?? null,
      allowed: allowedActionsForLatest(latestBySymbol[symbol]?.action ?? null),
    }));
    const allowedBySymbol = new Map(allowedRows.map((row) => [row.symbol, row.allowed]));
    const lastPriceBySymbol = lastPricesFromSnapshots(snapshots, this.includedSymbols);
    const priorBuyPriceBySymbol = Object.fromEntries(
      this.includedSymbols.map((symbol) => [symbol, latestBySymbol[symbol]?.buyPrice ?? null]),
    );
    const messages = buildDecisionMessages(asOfIst, this.includedSymbols, snapshots, allowedRows);
    const completion = await this.completeWithRetry(messages, 'decision');
    const filtered = filterDecisionsToSymbols(decisionBatchSchema.parse(completion.parsed), symbols);
    const { batch, dropped } = clampDecisionsToAllowed(filtered, allowedBySymbol);
    if (dropped.length > 0) {
      this.logger.warn(
        { dropped },
        'Dropped LLM decisions whose action was not in the allowed set for that symbol.',
      );
    }

    const stored = await persistDecisions({
      asOf,
      batch,
      model: this.llm.getModel(),
      promptHash: hashPrompt(messages),
      rawCompletion: completion.text,
      marketSnapshot: JSON.parse(JSON.stringify(snapshots)) as Prisma.InputJsonValue,
      watchlistFile: this.watchlistFile,
      lastPriceBySymbol,
      priorBuyPriceBySymbol,
    });

    this.logger.info(
      { stored, symbols: batch.decisions.map((item) => `${item.symbol}:${item.action}`) },
      'Stored LLM trade decisions in Postgres without executing them.',
    );

    return stored;
  }

  private async fetchDailyBars(
    catalog: readonly KiteInstrumentRef[],
    fromYmd: string,
    toYmd: string,
  ): Promise<Record<string, DailyBar[]>> {
    const bars: Record<string, DailyBar[]> = {};
    for (const instrument of catalog) {
      try {
        bars[instrument.tradingsymbol] = await this.kite.getDailyCandles(
          instrument.instrumentToken,
          fromYmd,
          toYmd,
        );
      } catch (error: unknown) {
        this.logger.warn(
          { err: error, symbol: instrument.tradingsymbol },
          'Kite daily historical failed; continuing with empty bars for this symbol.',
        );
        bars[instrument.tradingsymbol] = [];
      }
    }
    return bars;
  }

  private async completeWithRetry(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    label: 'universe' | 'decision',
  ) {
    const maxTokens = label === 'universe' ? UNIVERSE_MAX_OUTPUT_TOKENS : DECISION_MAX_OUTPUT_TOKENS;
    try {
      return await this.llm.completeJson(messages, { maxTokens });
    } catch (error: unknown) {
      this.logger.warn({ err: error, label }, 'First Hugging Face JSON completion failed; retrying once.');
      return this.llm.completeJson(messages, { maxTokens });
    }
  }
}
