import path from 'node:path';

import type { KiteBroker } from '../broker/KiteBroker.js';
import type { SessionLogger } from '../broker/kite/KiteTickerStream.js';
import { config } from '../config.js';
import type { SessionInstrument } from '../domain.js';
import {
  getCatalogTradingsymbols,
  findKiteInstrument,
  loadKiteInstruments,
  lookupSessionStartInstruments,
  type KiteInstrumentRef,
} from '../instruments/kiteInstruments.js';
import type { HuggingFaceClient } from './huggingfaceClient.js';
import {
  buildDecisionMessages,
  buildOptionsUniverseMessages,
  buildUniverseMessages,
  DECISION_MAX_OUTPUT_TOKENS,
  UNIVERSE_MAX_OUTPUT_TOKENS,
} from './prompts.js';
import { filterSnapshotsToSymbols, lastPricesFromSnapshots, readRecentQuoteSnapshots } from './quoteLogReader.js';
import {
  clampWatchlistToTop,
  dropIncludesNotPassing,
  decisionBatchSchema,
  filterDecisionsToSymbols,
  clampDecisionsToAllowed,
  allowedActionsForLatest,
  intersectWatchlistWithCatalog,
  universeSuggestionSchema,
  type UniverseSuggestion,
} from './schemas.js';
import { formatIstTimestamp, latestActionsForSymbols, persistDecisions, writeUniverseFile } from './decisionStore.js';
import type { NewsService } from '../news/NewsService.js';
import { UNIVERSE_BAR_LOOKBACK_DAYS, UNIVERSE_MIN_BARS_FOR_MOMENTUM, addCalendarDays, computeFetchWindow, istYmd, ymdToUtcDate } from '../universe/dates.js';
import { mergeKnowledge, readLatestKnowledge, writeKnowledgeFile } from '../universe/knowledgeStore.js';
import { diversifyByCorrelation, screenUniverse, UNIVERSE_MAX_INCLUDES } from '../universe/universeScreen.js';
import type { DailyBar, IntradayBar } from '../universe/types.js';
import { applyPlaybookClamp, evaluateGreeksIvPlaybook, evaluatePlaybook, type PlaybookSignal } from './tradePlaybook.js';
import {
  indexNameFromOptionSymbol,
  loadIndexUnderlyings,
  optionSideFromSymbol,
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
  computeOptionGreeks,
  isOptionPremium,
  parseGreeksIvAlgorithm,
  strikeFromOptionSymbol,
  type GreeksIvAlgorithmId,
  type OptionContractMeta,
} from '../options/greeksIv.js';
import type { UniverseBook } from '../universe/types.js';

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
    instruments: readonly SessionInstrument[],
  ): Promise<ReturnType<LlmTradeAdvisorService['getDecisionLoopStatus']>> {
    if (this.timer) {
      throw Object.assign(new Error('The LLM decision loop is already running.'), { statusCode: 400 });
    }
    if (instruments.length === 0) {
      throw Object.assign(new Error('At least one instrument is required to start the decision loop.'), {
        statusCode: 400,
      });
    }

    this.sessionStartPayload = { instruments: [...instruments] };
    this.includedSymbols = instruments.map((instrument) => instrument.tradingsymbol);
    this.book = instruments.some((instrument) => instrument.exchange === 'NFO') ? 'options' : 'equity';
    this.lastQuotedPriceBySymbol = await this.fetchLiveLastPrices();

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
        symbols: this.includedSymbols,
        book: this.book,
      },
      'Started LLM buy/hold/exit decision loop. Decisions are stored only; no broker orders.',
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
    if (this.includedSymbols.length === 0) {
      this.logger.info('Skipping LLM decision cycle because no watchlist has been suggested yet.');
      return 0;
    }

    const symbols = new Set(this.includedSymbols);
    const snapshots = filterSnapshotsToSymbols(await readRecentQuoteSnapshots(), symbols);
    const fromLog = lastPricesFromSnapshots(snapshots, this.includedSymbols);
    const fromQuotes = await this.fetchLiveLastPrices();
    this.lastQuotedPriceBySymbol = { ...fromQuotes };
    const indexSpots = this.book === 'options' ? await this.fetchIndexSpots() : {};
    const lastPriceBySymbol: Record<string, number | null> = {};
    for (const symbol of this.includedSymbols) {
      const listed = this.sessionStartPayload.instruments.find(
        (instrument) => instrument.tradingsymbol === symbol,
      );
      const logged = fromLog[symbol];
      const quoted = fromQuotes[symbol];
      if (listed?.exchange === 'NFO') {
        const index = indexNameFromOptionSymbol(symbol);
        const spot = index ? (indexSpots[index] ?? null) : null;
        lastPriceBySymbol[symbol] = isOptionPremium(quoted, spot)
          ? quoted
          : isOptionPremium(logged, spot)
            ? logged
            : null;
        this.lastQuotedPriceBySymbol[symbol] = lastPriceBySymbol[symbol];
      } else {
        lastPriceBySymbol[symbol] =
          quoted !== null && quoted !== undefined && Number.isFinite(quoted)
            ? quoted
            : logged ?? null;
      }
    }
    const hasAnyPrice = this.includedSymbols.some((symbol) => {
      const price = lastPriceBySymbol[symbol];
      return price !== null && price !== undefined && Number.isFinite(price);
    });
    if (!hasAnyPrice) {
      this.logger.info(
        { symbols: this.includedSymbols, logPath: config.session.quoteLogPath },
        'Skipping LLM decision cycle; no Kite quotes or JSONL last prices for the watchlist yet.',
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
    const priorBuyPriceBySymbol = Object.fromEntries(
      this.includedSymbols.map((symbol) => [symbol, latestBySymbol[symbol]?.buyPrice ?? null]),
    );
    const tokenBySymbol = Object.fromEntries(
      this.sessionStartPayload.instruments.map((instrument) => [
        instrument.tradingsymbol,
        instrument.instrumentToken,
      ]),
    );
    const playbook = await this.buildPlaybookSignals({
      lastPriceBySymbol,
      priorBuyPriceBySymbol,
      allowedRows,
      indexSpots,
    });
    const messages = buildDecisionMessages(
      asOfIst,
      this.includedSymbols,
      snapshots,
      allowedRows,
      playbook,
      this.book,
    );
    const completion = await this.completeWithRetry(messages, 'decision');
    const filtered = filterDecisionsToSymbols(decisionBatchSchema.parse(completion.parsed), symbols);
    const { batch: allowedBatch, dropped } = clampDecisionsToAllowed(filtered, allowedBySymbol);
    if (dropped.length > 0) {
      this.logger.warn(
        { dropped },
        'Dropped LLM decisions whose action was not in the allowed set for that symbol.',
      );
    }
    const { batch, overrides } = applyPlaybookClamp(allowedBatch, playbook, allowedBySymbol);
    if (overrides.length > 0) {
      this.logger.warn({ overrides }, 'Overrode LLM actions that fought the candle playbook.');
    }

    const persistable = {
      ...batch,
      decisions: batch.decisions.filter((item) => {
        const listed = this.sessionStartPayload.instruments.find(
          (instrument) => instrument.tradingsymbol === item.symbol,
        );
        if (listed?.exchange !== 'NFO') {
          return true;
        }
        return lastPriceBySymbol[item.symbol] !== null;
      }),
    };
    const marketSnapshotBySymbol = Object.fromEntries(
      persistable.decisions.map((item) => {
        const signal = playbook.find((row) => row.symbol === item.symbol);
        return [
          item.symbol,
          {
            algorithm: signal?.algorithm ?? this.algorithmsBySymbol[item.symbol] ?? null,
            ltp: signal?.lastPrice ?? lastPriceBySymbol[item.symbol] ?? null,
            spot: signal?.spot ?? null,
            iv: signal?.iv ?? null,
            delta: signal?.delta ?? null,
          },
        ];
      }),
    );
    const stored = await persistDecisions({
      asOf,
      batch: persistable,
      lastPriceBySymbol,
      priorBuyPriceBySymbol,
      tokenBySymbol,
      marketSnapshotBySymbol,
    });

    this.logger.info(
      { stored, symbols: batch.decisions.map((item) => `${item.symbol}:${item.action}`) },
      'Stored LLM trade decisions in Postgres without executing them.',
    );

    return stored;
  }

  private async buildPlaybookSignals(input: {
    lastPriceBySymbol: Record<string, number | null>;
    priorBuyPriceBySymbol: Record<string, string | null>;
    indexSpots?: Partial<Record<IndexOptionName, number>>;
    allowedRows: Array<{
      symbol: string;
      last: import('./schemas.js').LlmTradeActionName | null;
      allowed: readonly import('./schemas.js').LlmTradeActionName[];
    }>;
  }): Promise<PlaybookSignal[]> {
    const today = istYmd();
    const fromYmd = addCalendarDays(today, -UNIVERSE_BAR_LOOKBACK_DAYS);
    const hasNfo = this.sessionStartPayload.instruments.some((instrument) => instrument.exchange === 'NFO');
    const hasNse = this.sessionStartPayload.instruments.some((instrument) => instrument.exchange !== 'NFO');

    const knowledgeEquity = hasNse ? await readLatestKnowledge() : null;
    const knowledgeOptions = hasNfo ? await readLatestKnowledge(undefined, 'options') : null;

    let niftyDaily: DailyBar[] = knowledgeEquity?.symbols.NIFTYBEES?.bars ?? [];
    if (hasNse && niftyDaily.length < 50) {
      const niftyRef = findKiteInstrument('NIFTYBEES');
      if (niftyRef) {
        try {
          niftyDaily = await this.kite.getDailyCandles(niftyRef.instrumentToken, fromYmd, today);
        } catch (error: unknown) {
          this.logger.warn({ err: error }, 'Kite daily historical for NIFTYBEES failed.');
        }
      }
    }

    const indexBars: Partial<Record<IndexOptionName, DailyBar[]>> = {};
    if (hasNfo) {
      for (const underlying of loadIndexUnderlyings()) {
        const name = underlying.tradingsymbol as IndexOptionName;
        let daily = knowledgeOptions?.symbols[name]?.bars ?? [];
        if (daily.length < 50) {
          try {
            daily = await this.kite.getDailyCandles(underlying.instrumentToken, fromYmd, today);
          } catch (error: unknown) {
            this.logger.warn({ err: error, index: name }, 'Kite index daily historical failed for option playbook.');
          }
        }
        indexBars[name] = daily;
      }
    }

    const signals: PlaybookSignal[] = [];
    for (const row of input.allowedRows) {
      const listed = this.sessionStartPayload.instruments.find(
        (instrument) => instrument.tradingsymbol === row.symbol,
      );
      const buyRaw = input.priorBuyPriceBySymbol[row.symbol];
      const buyPrice = buyRaw === null || buyRaw === undefined ? null : Number(buyRaw);
      const lastPrice = input.lastPriceBySymbol[row.symbol] ?? null;

      if (listed?.exchange === 'NFO') {
        const index = indexNameFromOptionSymbol(row.symbol);
        const side = optionSideFromSymbol(row.symbol) ?? 'CE';
        const indexDaily = index ? (indexBars[index] ?? []) : [];
        const meta = this.optionContracts.find((contract) => contract.symbol === row.symbol);
        const strike = meta?.strike ?? strikeFromOptionSymbol(row.symbol) ?? 0;
        const expiryYmd = meta?.expiry ?? addCalendarDays(today, 30);
        const algorithm =
          this.algorithmsBySymbol[row.symbol] ?? meta?.algorithm ?? DEFAULT_GREEKS_IV_ALGORITHM;
        const spot = index ? (input.indexSpots?.[index] ?? indexDaily.at(-1)?.c ?? null) : null;
        signals.push(
          evaluateGreeksIvPlaybook({
            symbol: row.symbol,
            side,
            lastAction: row.last as import('./schemas.js').LlmTradeActionName | null,
            allowed: row.allowed,
            lastPrice,
            buyPrice: buyPrice !== null && Number.isFinite(buyPrice) ? buyPrice : null,
            indexDaily,
            spot,
            strike,
            expiryYmd,
            asOfYmd: today,
            algorithm,
          }),
        );
        continue;
      }

      const catalogRef = findKiteInstrument(row.symbol);
      const token = listed?.instrumentToken ?? catalogRef?.instrumentToken;
      let daily = knowledgeEquity?.symbols[row.symbol]?.bars ?? [];
      if (daily.length < 50 && token) {
        try {
          daily = await this.kite.getDailyCandles(token, fromYmd, today);
        } catch (error: unknown) {
          this.logger.warn({ err: error, symbol: row.symbol }, 'Kite daily historical failed for playbook.');
        }
      }
      let minutes15: IntradayBar[] = [];
      if (token) {
        try {
          minutes15 = await this.kite.getFifteenMinuteCandles(token, today);
        } catch (error: unknown) {
          this.logger.warn({ err: error, symbol: row.symbol }, 'Kite 15-minute historical failed for playbook.');
        }
      }
      signals.push(
        evaluatePlaybook({
          symbol: row.symbol,
          lastAction: row.last as import('./schemas.js').LlmTradeActionName | null,
          allowed: row.allowed,
          lastPrice,
          buyPrice: buyPrice !== null && Number.isFinite(buyPrice) ? buyPrice : null,
          daily,
          niftyDaily,
          minutes15,
        }),
      );
    }
    return signals;
  }

  private async fetchLiveLastPrices(): Promise<Record<string, number | null>> {
    const keys = this.sessionStartPayload.instruments.map(
      (instrument) => `${instrument.exchange}:${instrument.tradingsymbol}`,
    );
    if (keys.length === 0) {
      return {};
    }
    try {
      const quotes = await this.kite.getQuotes(keys);
      const out: Record<string, number | null> = {};
      for (const instrument of this.sessionStartPayload.instruments) {
        const quote =
          quotes[`${instrument.exchange}:${instrument.tradingsymbol}`] ?? quotes[instrument.tradingsymbol];
        out[instrument.tradingsymbol] =
          quote?.lastPrice && quote.lastPrice > 0 ? quote.lastPrice : null;
      }
      return out;
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'Kite getQuotes failed for the decision cycle.');
      return {};
    }
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
