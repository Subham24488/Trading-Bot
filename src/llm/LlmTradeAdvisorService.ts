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
  buildLiveOptionDecisionMessages,
  buildOptionsUniverseMessages,
  buildUniverseMessages,
  DECISION_MAX_OUTPUT_TOKENS,
  UNIVERSE_MAX_OUTPUT_TOKENS,
} from './prompts.js';
import {
  clampWatchlistToTop,
  dropIncludesNotPassing,
  decisionBatchSchema,
  clampLiveOptionDecision,
  intersectWatchlistWithCatalog,
  universeSuggestionSchema,
  type UniverseSuggestion,
} from './schemas.js';
import {
  formatIstTimestamp,
  findLatestOpenPosition,
  persistDecisions,
  writeUniverseFile,
} from './decisionStore.js';
import { UNIVERSE_BAR_LOOKBACK_DAYS, UNIVERSE_MIN_BARS_FOR_MOMENTUM, addCalendarDays, computeFetchWindow, istYmd, ymdToUtcDate } from '../universe/dates.js';
import { mergeKnowledge, readLatestKnowledge, writeKnowledgeFile } from '../universe/knowledgeStore.js';
import { diversifyByCorrelation, screenUniverse, UNIVERSE_MAX_INCLUDES } from '../universe/universeScreen.js';
import type { DailyBar, IntradayBar } from '../universe/types.js';
import {
  INDEX_OPTION_NAMES,
  loadIndexUnderlyings,
  type IndexOptionName,
} from '../instruments/kiteIndexUnderlyings.js';
import {
  OPTIONS_MAX_INCLUDES,
  indexOptionBias,
  pickOptionContracts,
  screenIndexOptions,
  toSessionInstruments,
  toUniverseCandidates,
  type OptionQuote,
  type OptionScreenRow,
} from '../options/optionsScreen.js';
import {
  DEFAULT_GREEKS_IV_ALGORITHM,
  IV_HV_SKIP_THRESHOLD,
  OPTIONS_STOP_LOSS_PCT,
  computeOptionGreeks,
  parseGreeksIvAlgorithm,
  scoreOptionNewsRisk,
  type GreeksIvAlgorithmId,
  type OptionContractMeta,
  type OptionNewsRisk,
} from '../options/greeksIv.js';
import type { NewsService } from '../news/NewsService.js';
import type { UniverseBook } from '../universe/types.js';
import {
  formatIstWallClock,
  structureNotesFromBars,
  trendFromCloses,
  type ChainQuoteRow,
  type ChainSnapshot,
  type IndexCandlePack,
  type LiveOptionDecisionContext,
} from './decisionContext.js';
import {
  DEFAULT_INDEX_OPTION_LOT,
  buyClearsFeeTarget,
  estimateOptionsRoundTripCost,
} from './optionTradeCosts.js';

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
  book: UniverseBook;
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
  private book: UniverseBook = 'equity';
  private algorithmsBySymbol: Record<string, GreeksIvAlgorithmId> = {};
  private optionContracts: OptionContractMeta[] = [];
  private lastQuotedPriceBySymbol: Record<string, number | null> = {};
  private decisionIndexes: IndexOptionName[] = [...INDEX_OPTION_NAMES];
  private previousChainBySymbol: Record<string, { oi: number; volume: number }> = {};

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

  public getBook(): UniverseBook {
    return this.book;
  }

  /**
   * Incremental Kite dailies + NSE filings, local factor screen, LLM confirms 0–1 names.
   * Writes knowledge under universe/ and the pick under trades/. Does not place orders.
   */
  public async suggestUniverse(): Promise<UniverseSuggestResult> {
    this.book = 'equity';
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
    const tokens = Object.fromEntries(
      catalog.map((instrument) => [instrument.tradingsymbol, instrument.instrumentToken]),
    );

    if (!window.skipRemote) {
      news = await this.news.fetchNewsForRange(
        kiteTradingsymbols,
        ymdToUtcDate(window.newsFrom),
        ymdToUtcDate(window.newsTo),
        { requireSome: window.isSeed },
      );
      bars = await this.fetchDailyBars(catalog, window.barsFrom, window.barsTo);
      knowledge = mergeKnowledge({
        previous,
        asOfIst,
        today,
        book: 'equity',
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

    const backfill = await this.backfillShortDailyBars(catalog, knowledge, today);
    if (Object.keys(backfill).length > 0) {
      knowledge = mergeKnowledge({
        previous: knowledge,
        asOfIst,
        today,
        book: 'equity',
        coverageFrom: knowledge.coverageFrom,
        fetchedFrom: addCalendarDays(today, -UNIVERSE_BAR_LOOKBACK_DAYS),
        fetchedTo: today,
        catalogPath,
        news: [],
        bars: backfill,
        tokens,
      });
      knowledgeFile = await writeKnowledgeFile(knowledge);
    }

    const newsItemCount = window.skipRemote
      ? Object.values(knowledge.symbols).reduce((sum, entry) => sum + entry.filings.length, 0)
      : news.reduce((sum, entry) => sum + entry.items.length, 0);

    const { candidates, preselected } = screenUniverse(knowledge.symbols);
    const candidateSymbols = candidates.map((candidate) => candidate.symbol);
    const passing = new Set(candidates.filter((candidate) => candidate.pass).map((candidate) => candidate.symbol));
    const messages = buildUniverseMessages(
      asOfIst,
      candidates,
      preselected.map((candidate) => candidate.symbol),
    );
    const completion = await this.completeWithRetry(messages, 'universe');
    const parsed = clampWatchlistToTop(
      dropIncludesNotPassing(
        intersectWatchlistWithCatalog(
          universeSuggestionSchema.parse(completion.parsed),
          new Set(kiteTradingsymbols),
        ),
        passing,
      ),
      UNIVERSE_MAX_INCLUDES,
    );
    const includedCandidates = parsed.watchlist
      .filter((item) => item.include)
      .map((item) => candidates.find((candidate) => candidate.symbol === item.symbol))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const diversified = diversifyByCorrelation(includedCandidates, knowledge.symbols, UNIVERSE_MAX_INCLUDES);
    const diversifiedSymbols = new Set(diversified.map((candidate) => candidate.symbol));
    const cloneDropped = parsed.watchlist
      .filter((item) => item.include && !diversifiedSymbols.has(item.symbol))
      .map((item) => ({ symbol: item.symbol, reason: 'Dropped as a 20d-return clone of a higher-ranked pick.' }));
    const suggestion = {
      ...parsed,
      watchlist: diversified.map((candidate, index) => {
        const row = parsed.watchlist.find((item) => item.symbol === candidate.symbol)!;
        return { ...row, include: true as const, rank: index + 1 };
      }),
      exclude: [...parsed.exclude, ...cloneDropped],
    };
    const includedSymbols = suggestion.watchlist
      .filter((item) => item.include)
      .map((item) => item.symbol);
    const { instruments, unmappedSymbols } = lookupSessionStartInstruments(includedSymbols, catalog);

    const sessionStartPayload = { instruments };
    const filePath = await writeUniverseFile({
      generatedAt: new Date().toISOString(),
      asOfIst,
      model: this.llm.getModel(),
      book: 'equity',
      newsItemCount,
      suggestion,
      includedSymbols,
      sessionStartPayload,
      unmappedSymbols,
      knowledgeFile,
      candidateSymbols,
    });

    this.includedSymbols = instruments.map((instrument) => instrument.tradingsymbol);
    this.sessionStartPayload = sessionStartPayload;
    this.watchlistFile = filePath;
    this.algorithmsBySymbol = {};
    this.optionContracts = [];

    this.logger.info(
      {
        filePath,
        knowledgeFile,
        candidateSymbols,
        includedSymbols: this.includedSymbols,
        unmappedSymbols,
        excludedCount: suggestion.exclude.length,
        newsItemCount,
      },
      'Wrote universe knowledge and LLM pick JSON. No broker orders were sent.',
    );

    return {
      filePath,
      asOfIst,
      model: this.llm.getModel(),
      book: 'equity',
      newsItemCount,
      knowledgeFile,
      candidateSymbols,
      includedSymbols: this.includedSymbols,
      unmappedSymbols,
      sessionStartPayload,
      suggestion,
    };
  }

  public async suggestOptionsUniverse(): Promise<UniverseSuggestResult> {
    this.book = 'options';
    const underlyings = loadIndexUnderlyings();
    const catalogPath = path.resolve(config.llm.kiteIndexUnderlyingsPath);
    const asOfIst = formatIstTimestamp();
    const today = istYmd();
    const previous = await readLatestKnowledge(undefined, 'options');
    const window = computeFetchWindow(
      previous?.coverageTo ?? null,
      today,
      config.llm.newsLookbackDays,
      UNIVERSE_BAR_LOOKBACK_DAYS,
    );

    this.logger.info(
      {
        indexes: underlyings.map((row) => row.tradingsymbol),
        coverageTo: previous?.coverageTo ?? null,
        skipRemote: window.skipRemote,
      },
      'Building index-options universe from Kite NFO chain, index dailies, and Google RSS.',
    );

    let news: Awaited<ReturnType<NewsService['fetchIndexNews']>> = [];
    let bars: Record<string, DailyBar[]> = {};
    let knowledgeFile: string | null = null;
    let knowledge = previous;
    const tokens = Object.fromEntries(
      underlyings.map((row) => [row.tradingsymbol, row.instrumentToken]),
    );

    if (!window.skipRemote) {
      news = await this.news.fetchIndexNews(
        underlyings.map((row) => ({ symbol: row.tradingsymbol, query: row.googleQuery })),
        ymdToUtcDate(window.newsFrom),
        ymdToUtcDate(window.newsTo),
      );
      bars = await this.fetchDailyBars(
        underlyings.map((row) => ({
          tradingsymbol: row.tradingsymbol,
          exchange: row.exchange,
          instrumentToken: row.instrumentToken,
        })),
        window.barsFrom,
        window.barsTo,
      );
      knowledge = mergeKnowledge({
        previous,
        asOfIst,
        today,
        book: 'options',
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
      throw new Error('Index-options knowledge is empty after selection; cannot screen contracts.');
    }

    const backfill = await this.backfillShortDailyBars(
      underlyings.map((row) => ({
        tradingsymbol: row.tradingsymbol,
        exchange: row.exchange,
        instrumentToken: row.instrumentToken,
      })),
      knowledge,
      today,
    );
    if (Object.keys(backfill).length > 0) {
      knowledge = mergeKnowledge({
        previous: knowledge,
        asOfIst,
        today,
        book: 'options',
        coverageFrom: knowledge.coverageFrom,
        fetchedFrom: addCalendarDays(today, -UNIVERSE_BAR_LOOKBACK_DAYS),
        fetchedTo: today,
        catalogPath,
        news: [],
        bars: backfill,
        tokens,
      });
      knowledgeFile = await writeKnowledgeFile(knowledge);
    }

    const indexQuoteKeys = underlyings.map((row) => `${row.exchange}:${row.kiteQuoteSymbol}`);
    const indexQuotes = await this.kite.getQuotes(indexQuoteKeys);
    const spots: Partial<Record<IndexOptionName, number>> = {};
    for (const row of underlyings) {
      const quote =
        indexQuotes[`${row.exchange}:${row.kiteQuoteSymbol}`] ??
        indexQuotes[`${row.exchange}:${row.kiteQuoteSymbol}`.toUpperCase()] ??
        indexQuotes[row.kiteQuoteSymbol];
      const lastBar = knowledge.symbols[row.tradingsymbol]?.bars.at(-1)?.c;
      const spot = quote?.lastPrice && quote.lastPrice > 0 ? quote.lastPrice : lastBar;
      if (spot && spot > 0) {
        spots[row.tradingsymbol as IndexOptionName] = spot;
      }
    }

    const chain = await this.kite.getNfoIndexOptions({ spots, asOfYmd: today });
    const optionQuoteKeys = chain.map((contract) => `NFO:${contract.tradingsymbol}`);
    const rawOptionQuotes = await this.kite.getQuotes(optionQuoteKeys);
    const optionQuotes: Record<string, OptionQuote> = {};
    for (const [key, quote] of Object.entries(rawOptionQuotes)) {
      const symbol = (key.includes(':') ? key.slice(key.indexOf(':') + 1) : key).toUpperCase();
      optionQuotes[symbol] = { lastPrice: quote.lastPrice, volume: quote.volume, oi: quote.oi };
    }

    const newsByIndex: Record<string, (typeof news)[number]['items']> = {};
    for (const entry of news) {
      newsByIndex[entry.symbol] = entry.items;
    }
    if (window.skipRemote) {
      for (const name of Object.keys(knowledge.symbols)) {
        newsByIndex[name] = knowledge.symbols[name]?.filings ?? [];
      }
    }

    const biases = underlyings.map((row) =>
      indexOptionBias(row.tradingsymbol as IndexOptionName, knowledge.symbols[row.tradingsymbol]?.bars ?? []),
    );
    const indexFeatures = Object.fromEntries(
      underlyings.map((row) => [
        row.tradingsymbol,
        knowledge.symbols[row.tradingsymbol]?.features ?? {
          sma20: null,
          sma50: null,
          atrPct: null,
          rsNifty20: null,
          volVs20: null,
          distFrom20HighPct: null,
          ret20Pct: null,
          eventScore: 0,
          score: 0,
        },
      ]),
    );
    const steps = Object.fromEntries(underlyings.map((row) => [row.tradingsymbol, row.strikeStep])) as Partial<
      Record<IndexOptionName, number>
    >;
    const screened = screenIndexOptions({
      contracts: chain,
      quotes: optionQuotes,
      biases,
      spots,
      steps,
      newsByIndex,
      indexFeatures,
    });
    const passingRows = screened.filter((row) => row.pass);
    const preselected = pickOptionContracts(passingRows);
    this.logger.info(
      {
        spots,
        chainCount: chain.length,
        screenedCount: screened.length,
        passingCount: passingRows.length,
        biases: biases.map((bias) => ({ index: bias.index, side: bias.side, reasons: bias.failReasons })),
      },
      'Index-options local screen finished.',
    );
    const candidates = toUniverseCandidates(passingRows);
    const passing = new Set(passingRows.map((row) => row.symbol));
    const rowBySymbol = new Map(screened.map((row) => [row.symbol, row]));
    const indexDailyByName = Object.fromEntries(
      underlyings.map((row) => [row.tradingsymbol, knowledge.symbols[row.tradingsymbol]?.bars ?? []]),
    );
    const greeksBySymbol: Record<string, { delta: number | null; iv: number | null; ivHv: number | null }> = {};
    for (const row of passingRows) {
      const snapshot = computeOptionGreeks({
        premium: row.ltp,
        spot: spots[row.index] ?? null,
        strike: row.strike,
        expiryYmd: row.expiry,
        asOfYmd: today,
        side: row.side,
        indexDaily: indexDailyByName[row.index] ?? [],
      });
      greeksBySymbol[row.symbol] = { delta: snapshot.delta, iv: snapshot.iv, ivHv: snapshot.ivHv };
    }
    const messages = buildOptionsUniverseMessages(
      asOfIst,
      candidates,
      preselected.map((row) => row.symbol),
      greeksBySymbol,
    );
    const completion = await this.completeWithRetry(messages, 'universe');
    const allowedSymbols = new Set(passingRows.map((row) => row.symbol));
    const parsed = clampWatchlistToTop(
      dropIncludesNotPassing(
        intersectWatchlistWithCatalog(universeSuggestionSchema.parse(completion.parsed), allowedSymbols),
        passing,
      ),
      OPTIONS_MAX_INCLUDES,
    );
    const rankedIncludes = parsed.watchlist
      .filter((item) => item.include)
      .sort((left, right) => (left.rank ?? 99) - (right.rank ?? 99))
      .map((item) => item.symbol);
    const fromLlm = pickOptionContracts(
      rankedIncludes
        .map((symbol) => rowBySymbol.get(symbol))
        .filter((row): row is OptionScreenRow => Boolean(row)),
    );
    const keptRows = fromLlm.length > 0 ? fromLlm : preselected;
    const keptSymbols = keptRows.map((row) => row.symbol);
    const keptSet = new Set(keptSymbols);
    const suggestion = {
      ...parsed,
      watchlist: keptRows.map((row, index) => {
        const item = parsed.watchlist.find((entry) => entry.symbol === row.symbol);
        const ivHv = greeksBySymbol[row.symbol]?.ivHv ?? null;
        let algorithm = parseGreeksIvAlgorithm(item?.algorithm);
        if (ivHv !== null && ivHv > IV_HV_SKIP_THRESHOLD) {
          algorithm = 'greeks_iv_skip';
        }
        if (!item?.algorithm) {
          this.logger.info({ symbol: row.symbol, algorithm }, 'Options universe defaulted algorithm.');
        }
        return {
          symbol: row.symbol,
          include: true as const,
          rank: index + 1,
          rationale: item?.rationale ?? 'Local index-options screen.',
          algorithm,
        };
      }),
      exclude: [
        ...parsed.exclude,
        ...parsed.watchlist
          .filter((item) => item.include && !keptSet.has(item.symbol))
          .map((item) => ({ symbol: item.symbol, reason: 'Dropped by per-index cap or local screen.' })),
      ],
    };
    const instruments = toSessionInstruments(keptRows);
    const sessionStartPayload = { instruments };
    const algorithmsBySymbol: Record<string, GreeksIvAlgorithmId> = Object.fromEntries(
      suggestion.watchlist.map((item) => [item.symbol, item.algorithm]),
    );
    const optionContracts: OptionContractMeta[] = keptRows.map((row) => ({
      symbol: row.symbol,
      index: row.index,
      side: row.side,
      strike: row.strike,
      expiry: row.expiry,
      algorithm: algorithmsBySymbol[row.symbol] ?? DEFAULT_GREEKS_IV_ALGORITHM,
    }));
    const newsItemCount = window.skipRemote
      ? Object.values(knowledge.symbols).reduce((sum, entry) => sum + entry.filings.length, 0)
      : news.reduce((sum, entry) => sum + entry.items.length, 0);
    const candidateSymbols = candidates.map((candidate) => candidate.symbol);
    const unmappedSymbols: string[] = [];
    const filePath = await writeUniverseFile({
      generatedAt: new Date().toISOString(),
      asOfIst,
      model: this.llm.getModel(),
      book: 'options',
      newsItemCount,
      suggestion,
      includedSymbols: keptSymbols,
      sessionStartPayload,
      unmappedSymbols,
      knowledgeFile,
      candidateSymbols,
      algorithmsBySymbol,
      optionContracts,
    });

    this.includedSymbols = instruments.map((instrument) => instrument.tradingsymbol);
    this.sessionStartPayload = sessionStartPayload;
    this.watchlistFile = filePath;
    this.algorithmsBySymbol = algorithmsBySymbol;
    this.optionContracts = optionContracts;

    this.logger.info(
      {
        filePath,
        knowledgeFile,
        candidateSymbols,
        includedSymbols: this.includedSymbols,
        newsItemCount,
      },
      'Wrote index-options universe JSON. No broker orders were sent.',
    );

    return {
      filePath,
      asOfIst,
      model: this.llm.getModel(),
      book: 'options',
      newsItemCount,
      knowledgeFile,
      candidateSymbols,
      includedSymbols: this.includedSymbols,
      unmappedSymbols,
      sessionStartPayload,
      suggestion,
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
      instruments: this.sessionStartPayload.instruments.map((instrument) => ({
        ...instrument,
        currentPrice: this.lastQuotedPriceBySymbol[instrument.tradingsymbol] ?? null,
        algorithm: this.algorithmsBySymbol[instrument.tradingsymbol] ?? null,
      })),
      watchlistFile: this.watchlistFile,
      book: this.book,
    };
  }

  public async startDecisionLoop(
    indexes?: readonly IndexOptionName[],
  ): Promise<ReturnType<LlmTradeAdvisorService['getDecisionLoopStatus']>> {
    if (this.timer) {
      throw Object.assign(new Error('The LLM decision loop is already running.'), { statusCode: 400 });
    }

    this.book = 'options';
    this.decisionIndexes =
      indexes && indexes.length > 0 ? [...indexes] : [...INDEX_OPTION_NAMES];
    this.includedSymbols = [];
    this.previousChainBySymbol = {};
    const open = await findLatestOpenPosition();
    if (open) {
      this.includedSymbols = [open.symbol];
      this.sessionStartPayload = {
        instruments: [
          {
            instrumentToken: open.instrumentToken ?? 0,
            exchange: 'NFO',
            tradingsymbol: open.symbol,
          },
        ],
      };
    } else {
      this.sessionStartPayload = { instruments: [] };
    }

    const intervalMs = config.llm.decisionIntervalMinutes * 60_000;
    this.timer = setInterval(() => {
      void this.runDecisionCycle().catch((error: unknown) => {
        this.logger.error({ err: error }, 'LLM decision cycle failed.');
      });
    }, intervalMs);
    this.timer.unref?.();

    this.logger.info(
      {
        intervalMinutes: config.llm.decisionIntervalMinutes,
        indexes: this.decisionIndexes,
        openSymbol: open?.symbol ?? null,
      },
      'Started live options decision loop (picks contract + action each cycle). Store-only.',
    );

    try {
      await this.runDecisionCycle();
    } catch (error: unknown) {
      this.stop();
      throw error;
    }
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
    const asOf = new Date();
    const asOfIst = formatIstTimestamp(asOf);
    const openRow = await findLatestOpenPosition();
    const openBuy =
      openRow?.buyPrice !== null && openRow?.buyPrice !== undefined
        ? Number(openRow.buyPrice)
        : null;
    const heldMinutes = openRow
      ? Math.max(0, Math.floor((asOf.getTime() - openRow.decidedAt.getTime()) / 60_000))
      : 0;
    const allowed = openRow
      ? (['HOLD', 'EXIT'] as const)
      : (['BUY', 'SKIP'] as const);

    const context = await this.buildLiveOptionContext({
      asOf,
      asOfIst,
      open: openRow
        ? {
            symbol: openRow.symbol,
            buyPrice: openBuy !== null && Number.isFinite(openBuy) ? openBuy : null,
            heldMinutes,
            instrumentToken: openRow.instrumentToken,
          }
        : null,
      allowed: [...allowed],
    });

    if (context.chain.rows.length === 0 && !openRow) {
      this.logger.info({ indexes: this.decisionIndexes }, 'Skipping decision cycle; empty option chain.');
      return 0;
    }

    const messages = buildLiveOptionDecisionMessages(context);
    const completion = await this.completeWithRetry(messages, 'decision');
    const parsed = decisionBatchSchema.parse(completion.parsed);
    const chainSymbols = new Set(context.chain.rows.map((row) => row.symbol));
    if (openRow) {
      chainSymbols.add(openRow.symbol);
    }

    let { batch, overrides } = clampLiveOptionDecision({
      batch: parsed,
      openSymbol: openRow?.symbol ?? null,
      chainSymbols,
      allowed: [...allowed],
    });

    const decision = batch.decisions[0];
    if (!decision || decision.symbol === 'NONE') {
      this.logger.info('Skipping persist; no usable LLM decision symbol.');
      return 0;
    }

    const chainRow = context.chain.rows.find((row) => row.symbol === decision.symbol);
    const ltp =
      chainRow?.ltp ??
      (decision.symbol === openRow?.symbol ? this.lastQuotedPriceBySymbol[decision.symbol] ?? null : null);

    // Fee-aware BUY gate
    if (decision.action === 'BUY' && ltp !== null && ltp > 0) {
      const clears = buyClearsFeeTarget({
        premium: ltp,
        quantity: DEFAULT_INDEX_OPTION_LOT,
        targetNetPnlPct: config.llm.targetNetPnlPct,
      });
      if (!clears) {
        overrides = [
          ...overrides,
          { from: 'BUY', to: 'SKIP', reason: 'target net PnL does not clear estimated fees' },
        ];
        batch = {
          ...batch,
          decisions: [
            {
              ...decision,
              action: 'SKIP',
              rationale: `Fees block: ${decision.rationale}`.slice(0, 180),
            },
          ],
        };
      }
    }

    // Min-hold debounce: block EXIT unless high news or stop loss
    const final = batch.decisions[0]!;
    if (openRow && final.action === 'EXIT' && heldMinutes < config.llm.minHoldMinutes) {
      const newsHigh = Object.values(context.newsRiskByIndex).some((risk) => risk?.level === 'high');
      const entry = openBuy;
      const stopHit =
        entry !== null &&
        ltp !== null &&
        entry > 0 &&
        ((ltp - entry) / entry) * 100 <= -OPTIONS_STOP_LOSS_PCT;
      if (!newsHigh && !stopHit) {
        overrides = [
          ...overrides,
          {
            from: 'EXIT',
            to: 'HOLD',
            reason: `min hold ${heldMinutes}m < ${config.llm.minHoldMinutes}m`,
          },
        ];
        batch = {
          ...batch,
          decisions: [
            {
              ...final,
              action: 'HOLD',
              rationale: `Min hold: ${final.rationale}`.slice(0, 180),
            },
          ],
        };
      }
    }

    if (overrides.length > 0) {
      this.logger.warn({ overrides }, 'Clamped live option decision.');
    }

    const storedDecision = batch.decisions[0]!;
    const lastPriceBySymbol: Record<string, number | null> = {
      [storedDecision.symbol]: ltp,
    };
    this.lastQuotedPriceBySymbol = { ...this.lastQuotedPriceBySymbol, ...lastPriceBySymbol };

    const tokenBySymbol: Record<string, number | null> = {
      [storedDecision.symbol]:
        chainRow?.token ?? openRow?.instrumentToken ?? null,
    };

    const priorBuyPriceBySymbol: Record<string, string | null> = {
      [storedDecision.symbol]: openRow?.buyPrice ?? null,
    };

    const stored = await persistDecisions({
      asOf,
      batch,
      lastPriceBySymbol,
      priorBuyPriceBySymbol,
      tokenBySymbol,
      marketSnapshotBySymbol: {
        [storedDecision.symbol]: {
          pcr: context.chain.pcr,
          newsRisk: context.newsRiskByIndex,
          fees: context.fees,
          heldMinutes,
          ltp,
        },
      },
    });

    this.applyDecisionState(storedDecision.action, storedDecision.symbol, tokenBySymbol[storedDecision.symbol] ?? null);

    this.logger.info(
      {
        stored,
        symbol: storedDecision.symbol,
        action: storedDecision.action,
        indexes: this.decisionIndexes,
      },
      'Stored live LLM option decision without executing.',
    );

    return stored;
  }

  private applyDecisionState(
    action: string,
    symbol: string,
    token: number | null,
  ): void {
    if (action === 'BUY' || action === 'HOLD') {
      this.includedSymbols = [symbol];
      this.sessionStartPayload = {
        instruments: [
          {
            instrumentToken: token && token > 0 ? token : 0,
            exchange: 'NFO',
            tradingsymbol: symbol,
          },
        ],
      };
      return;
    }
    if (action === 'EXIT') {
      this.includedSymbols = [];
      // Keep last instrument visible on status for operators.
      return;
    }
    if (action === 'SKIP' && this.includedSymbols.length === 0) {
      this.sessionStartPayload = { instruments: [] };
    }
  }

  private async buildLiveOptionContext(input: {
    asOf: Date;
    asOfIst: string;
    open: LiveOptionDecisionContext['open'];
    allowed: LiveOptionDecisionContext['allowed'];
  }): Promise<LiveOptionDecisionContext> {
    const spots = await this.fetchIndexSpots();
    const candles = await this.fetchIndexCandlePacks(this.decisionIndexes, spots);
    const chain = await this.fetchLiveChainSnapshot(this.decisionIndexes, spots);
    const { newsRiskByIndex, newsHeadlines } = await this.fetchLastHourIndexNews(this.decisionIndexes);

    const samplePremium =
      input.open?.buyPrice ??
      chain.rows.find((row) => row.ltp !== null && row.ltp > 0)?.ltp ??
      null;
    const fees =
      samplePremium !== null && samplePremium > 0
        ? estimateOptionsRoundTripCost({
            buyPremium: samplePremium,
            sellPremium: samplePremium * (1 + config.llm.targetNetPnlPct / 100),
            quantity: DEFAULT_INDEX_OPTION_LOT,
          })
        : null;

    return {
      asOfIst: input.asOfIst,
      indexes: this.decisionIndexes,
      candles,
      chain,
      newsRiskByIndex,
      newsHeadlines,
      open: input.open,
      allowed: input.allowed,
      fees,
      targetNetPnlPct: config.llm.targetNetPnlPct,
      minHoldMinutes: config.llm.minHoldMinutes,
      candleLookbackMinutes: config.llm.candleLookbackMinutes,
    };
  }

  private async fetchIndexCandlePacks(
    indexes: readonly IndexOptionName[],
    spots: Partial<Record<IndexOptionName, number>>,
  ): Promise<IndexCandlePack[]> {
    const today = istYmd();
    const underlyings = loadIndexUnderlyings().filter((row) =>
      indexes.includes(row.tradingsymbol as IndexOptionName),
    );
    const lookbackMinutes =
      Number.isFinite(config.llm.candleLookbackMinutes) && config.llm.candleLookbackMinutes > 0
        ? config.llm.candleLookbackMinutes
        : 60;
    const lookbackMs = lookbackMinutes * 60_000;
    const now = Date.now();
    const toIst = formatIstWallClock(new Date(now));
    const fromIst = formatIstWallClock(new Date(now - lookbackMs));
    const weekFrom = addCalendarDays(today, -7);
    const monthFrom = addCalendarDays(today, -30);
    const packs: IndexCandlePack[] = [];

    for (const row of underlyings) {
      const index = row.tradingsymbol as IndexOptionName;
      let minute: IntradayBar[] = [];
      let session15: IntradayBar[] = [];
      let weekDaily: DailyBar[] = [];
      let monthDaily: DailyBar[] = [];
      try {
        minute = await this.kite.getMinuteCandles(row.instrumentToken, fromIst, toIst);
      } catch (error: unknown) {
        this.logger.warn({ err: error, index }, 'Minute candles failed.');
      }
      try {
        session15 = await this.kite.getFifteenMinuteCandles(row.instrumentToken, today);
      } catch (error: unknown) {
        this.logger.warn({ err: error, index }, 'Session 15m candles failed.');
      }
      try {
        weekDaily = await this.kite.getDailyCandles(row.instrumentToken, weekFrom, today);
      } catch (error: unknown) {
        this.logger.warn({ err: error, index }, 'Week dailies failed.');
      }
      try {
        monthDaily = await this.kite.getDailyCandles(row.instrumentToken, monthFrom, today);
      } catch (error: unknown) {
        this.logger.warn({ err: error, index }, 'Month dailies failed.');
      }

      const dayCloses = session15.map((bar) => bar.c);
      const weekCloses = weekDaily.map((bar) => bar.c);
      const monthCloses = monthDaily.map((bar) => bar.c);
      packs.push({
        index,
        spot: spots[index] ?? null,
        minute,
        session15,
        weekDaily,
        monthDaily,
        trend: {
          day: trendFromCloses(dayCloses.length >= 3 ? dayCloses : minute.map((bar) => bar.c)),
          week: trendFromCloses(weekCloses),
          month: trendFromCloses(monthCloses),
        },
        structure: structureNotesFromBars(
          session15.length >= 4 ? session15 : minute.length >= 4 ? minute : monthDaily,
        ),
      });
    }
    return packs;
  }

  private async fetchLiveChainSnapshot(
    indexes: readonly IndexOptionName[],
    spots: Partial<Record<IndexOptionName, number>>,
  ): Promise<ChainSnapshot> {
    let contracts: Awaited<ReturnType<KiteBroker['getNfoIndexOptions']>> = [];
    try {
      contracts = await this.kite.getNfoIndexOptions({
        names: indexes,
        spots,
      });
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'NFO chain fetch failed for decision cycle.');
      return { rows: [], pcr: null, ceOi: 0, peOi: 0 };
    }

    const keys = contracts.map((contract) => `NFO:${contract.tradingsymbol}`);
    let quotes: Awaited<ReturnType<KiteBroker['getQuotes']>> = {};
    if (keys.length > 0) {
      try {
        quotes = await this.kite.getQuotes(keys);
      } catch (error: unknown) {
        this.logger.warn({ err: error }, 'Option chain quotes failed.');
      }
    }

    const rows: ChainQuoteRow[] = [];
    let ceOi = 0;
    let peOi = 0;
    const nextPrev: Record<string, { oi: number; volume: number }> = {};

    for (const contract of contracts) {
      const quote =
        quotes[`NFO:${contract.tradingsymbol}`] ??
        quotes[`NFO:${contract.tradingsymbol}`.toUpperCase()] ??
        quotes[contract.tradingsymbol];
      const oi = quote?.oi ?? 0;
      const volume = quote?.volume ?? 0;
      const prev = this.previousChainBySymbol[contract.tradingsymbol];
      const dOi = prev ? oi - prev.oi : null;
      const dVolume = prev ? volume - prev.volume : null;
      if (contract.instrumentType === 'CE') {
        ceOi += oi;
      } else {
        peOi += oi;
      }
      nextPrev[contract.tradingsymbol] = { oi, volume };
      rows.push({
        symbol: contract.tradingsymbol,
        index: contract.name,
        side: contract.instrumentType,
        strike: contract.strike,
        expiry: contract.expiry,
        token: contract.instrumentToken,
        ltp: quote?.lastPrice && quote.lastPrice > 0 ? quote.lastPrice : null,
        oi,
        volume,
        dOi,
        dVolume,
      });
    }

    this.previousChainBySymbol = nextPrev;
    const pcr = ceOi > 0 ? Number((peOi / ceOi).toFixed(4)) : null;
    return { rows, pcr, ceOi, peOi };
  }

  private async fetchLastHourIndexNews(indexes: readonly IndexOptionName[]): Promise<{
    newsRiskByIndex: Partial<Record<IndexOptionName, OptionNewsRisk>>;
    newsHeadlines: Array<{ s: string; t: string }>;
  }> {
    const underlyings = loadIndexUnderlyings().filter((row) =>
      indexes.includes(row.tradingsymbol as IndexOptionName),
    );
    const to = new Date();
    const from = new Date(to.getTime() - 2 * 60 * 60 * 1000);
    const newsRiskByIndex: Partial<Record<IndexOptionName, OptionNewsRisk>> = {};
    const newsHeadlines: Array<{ s: string; t: string }> = [];
    try {
      const news = await this.news.fetchIndexNews(
        underlyings.map((row) => ({ symbol: row.tradingsymbol, query: row.googleQuery })),
        from,
        to,
      );
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const entry of news) {
        const name = entry.symbol.toUpperCase() as IndexOptionName;
        const recent = entry.items.filter((item) => {
          if (!item.publishedAt) {
            return true;
          }
          const parsed = Date.parse(item.publishedAt);
          return Number.isFinite(parsed) ? parsed >= cutoff : true;
        });
        newsRiskByIndex[name] = scoreOptionNewsRisk(recent);
        for (const item of recent.slice(0, 4)) {
          newsHeadlines.push({ s: name, t: item.title.slice(0, 120) });
        }
      }
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'Last-hour index news failed; fail-open.');
    }
    return { newsRiskByIndex, newsHeadlines };
  }

  private async fetchIndexSpots(): Promise<Partial<Record<IndexOptionName, number>>> {
    const underlyings = loadIndexUnderlyings();
    const keys = underlyings.map((row) => `${row.exchange}:${row.kiteQuoteSymbol}`);
    if (keys.length === 0) {
      return {};
    }
    try {
      const quotes = await this.kite.getQuotes(keys);
      const spots: Partial<Record<IndexOptionName, number>> = {};
      for (const row of underlyings) {
        const quote =
          quotes[`${row.exchange}:${row.kiteQuoteSymbol}`] ??
          quotes[`${row.exchange}:${row.kiteQuoteSymbol}`.toUpperCase()] ??
          quotes[row.kiteQuoteSymbol];
        if (quote?.lastPrice && quote.lastPrice > 0) {
          spots[row.tradingsymbol as IndexOptionName] = quote.lastPrice;
        }
      }
      return spots;
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'Kite getQuotes failed for index spots.');
      return {};
    }
  }

  private async backfillShortDailyBars(
    catalog: readonly KiteInstrumentRef[],
    knowledge: { symbols: Record<string, { bars: DailyBar[] }> },
    today: string,
  ): Promise<Record<string, DailyBar[]>> {
    const fromYmd = addCalendarDays(today, -UNIVERSE_BAR_LOOKBACK_DAYS);
    const bars: Record<string, DailyBar[]> = {};
    for (const instrument of catalog) {
      const existing = knowledge.symbols[instrument.tradingsymbol]?.bars ?? [];
      if (existing.length >= UNIVERSE_MIN_BARS_FOR_MOMENTUM) {
        continue;
      }
      try {
        bars[instrument.tradingsymbol] = await this.kite.getDailyCandles(
          instrument.instrumentToken,
          fromYmd,
          today,
        );
      } catch (error: unknown) {
        this.logger.warn(
          { err: error, symbol: instrument.tradingsymbol },
          'Kite daily backfill failed; ranking with stored bars only.',
        );
      }
    }
    return bars;
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
