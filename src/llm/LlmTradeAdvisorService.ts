import { randomUUID } from 'node:crypto';
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
import { completeJsonWithRetry, type LlmChatClient } from './llmChatClient.js';
import {
  buildOptionsUniverseMessages,
  buildUniverseMessages,
  UNIVERSE_MAX_OUTPUT_TOKENS,
} from './prompts.js';
import {
  clampWatchlistToTop,
  dropIncludesNotPassing,
  intersectWatchlistWithCatalog,
  universeSuggestionSchema,
  type UniverseSuggestion,
} from './schemas.js';
import {
  findDecisionsSince,
  findOpenTrade,
  formatIstTimestamp,
  persistDecisions,
  writeUniverseFile,
  type DecisionMeta,
  type OpenTradeRecord,
} from './decisionStore.js';
import {
  UNIVERSE_BAR_LOOKBACK_DAYS,
  UNIVERSE_MIN_BARS_FOR_MOMENTUM,
  addCalendarDays,
  computeFetchWindow,
  istYmd,
  ymdToUtcDate,
} from '../universe/dates.js';
import {
  mergeKnowledge,
  readLatestKnowledge,
  writeKnowledgeFile,
} from '../universe/knowledgeStore.js';
import {
  diversifyByCorrelation,
  screenUniverse,
  UNIVERSE_MAX_INCLUDES,
} from '../universe/universeScreen.js';
import type { DailyBar } from '../universe/types.js';
import {
  INDEX_OPTION_NAMES,
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
  parseGreeksIvAlgorithm,
  strikeFromOptionSymbol,
  type GreeksIvAlgorithmId,
  type OptionContractMeta,
} from '../options/greeksIv.js';
import type { NewsService } from '../news/NewsService.js';
import type { UniverseBook } from '../universe/types.js';
import type { MarketQuote } from '../broker/KiteBroker.js';
import { LiveMarketFeed, type MarketView } from '../services/LiveMarketFeed.js';
import { istClock, istDayStart, minutesBetween, msUntilNextCycle } from '../strategy/clock.js';
import {
  buildCandidates,
  type CandidateRejection,
  type ContractCandidate,
} from '../strategy/contracts.js';
import {
  checkPositionExit,
  decideEntry,
  summarizeDay,
  type DayRow,
  type ExitReason,
  type GateId,
  type Leaning,
  type OpenPosition,
} from '../strategy/decisionEngine.js';
import { pctChange } from '../strategy/indicators.js';
import {
  paramsVersion,
  strategyParams,
  tunableValues,
  type StrategyParams,
} from '../strategy/params.js';
import {
  describeBuy,
  describeExit,
  describeHold,
  describeSkip,
  describeUnrestorableExit,
} from '../strategy/rationale.js';
import { readIndex, SIGNAL_NAMES, type IndexReading } from '../strategy/signals.js';
import {
  parseDecisionSnapshot,
  SNAPSHOT_SCHEMA,
  type DecisionSnapshot,
} from '../strategy/snapshot.js';
import { pickContract, type ContractPickResult } from './contractPicker.js';
import { estimateOptionsRoundTripCost } from './optionTradeCosts.js';

/** Read-only Kite access; order placement is deliberately not part of this type. */
export type MarketDataBroker = Pick<
  KiteBroker,
  | 'getQuotes'
  | 'getNfoIndexOptions'
  | 'getDailyCandles'
  | 'getDayInstruments'
  | 'getFiveMinuteCandles'
>;

export type LlmTradeAdvisorOptions = {
  llm: LlmChatClient;
  news: NewsService;
  kite: MarketDataBroker;
  logger: SessionLogger;
};

/** Stops are checked this often between cycles, so a fast move is sold close to its level. */
const MONITOR_INTERVAL_MS = 15_000;

/** The single open trade; `tuuid` ties its BUY, HOLDs and EXIT rows together. */
type OpenTrade = OpenPosition & { tuuid: string };

const EMPTY_BACKDROP: DecisionSnapshot['market'] = {
  vixPct: null,
  usdInrPct: null,
  crudePct: null,
  gapPct: null,
  advancersPct: null,
  headlineTone: 0,
};

function round(value: number | null, digits = 2): number | null {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

/** Stops compare against the bid (what a sell would get), falling back to the last trade. */
function exitCheckPrice(quote: MarketQuote | null, lastPrice: number | null): number | null {
  return quote?.bid && quote.bid > 0 ? quote.bid : lastPrice;
}

function summarizeRejections(rejected: readonly CandidateRejection[]): string {
  if (rejected.length === 0) {
    return 'No option near the current price was available.';
  }
  const counts = new Map<string, number>();
  for (const rejection of rejected) {
    counts.set(rejection.reason, (counts.get(rejection.reason) ?? 0) + 1);
  }
  const reasons = [...counts.entries()].map(([reason, count]) => `${reason} (${count})`);
  return `Checked ${rejected.length} options near the current price: ${reasons.join('; ')}.`;
}

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
  private readonly llm: LlmChatClient;
  private readonly news: NewsService;
  private readonly kite: MarketDataBroker;
  private readonly logger: SessionLogger;
  private readonly feed: LiveMarketFeed;
  private readonly params: StrategyParams;
  private running = false;
  private loopGeneration = 0;
  private cycleTimer: NodeJS.Timeout | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;
  /** Serialises the 15-minute cycle and the 1-minute monitor. */
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  /** At most one open trade: while set, cycles only HOLD or EXIT it and never BUY. */
  private position: OpenTrade | null = null;
  private includedSymbols: string[] = [];
  private sessionStartPayload: { instruments: SessionInstrument[] } = { instruments: [] };
  private watchlistFile: string | null = null;
  private book: UniverseBook = 'equity';
  private algorithmsBySymbol: Record<string, GreeksIvAlgorithmId> = {};
  private optionContracts: OptionContractMeta[] = [];
  private lastQuotedPriceBySymbol: Record<string, number | null> = {};
  private decisionIndexes: IndexOptionName[] = [...INDEX_OPTION_NAMES];
  /** Today's rows for the daily limits: read from the DB once a day, then updated in memory. */
  private dayRows: { ymd: string; rows: DayRow[] } | null = null;

  public constructor(options: LlmTradeAdvisorOptions) {
    this.llm = options.llm;
    this.news = options.news;
    this.kite = options.kite;
    this.logger = options.logger;
    this.feed = new LiveMarketFeed({
      kite: options.kite,
      news: options.news,
      logger: options.logger,
    });
    this.params = strategyParams({
      minHoldMinutes: config.llm.minHoldMinutes,
      targetNetPnlPct: config.llm.targetNetPnlPct,
    });
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
    const passing = new Set(
      candidates.filter((candidate) => candidate.pass).map((candidate) => candidate.symbol),
    );
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
    const diversified = diversifyByCorrelation(
      includedCandidates,
      knowledge.symbols,
      UNIVERSE_MAX_INCLUDES,
    );
    const diversifiedSymbols = new Set(diversified.map((candidate) => candidate.symbol));
    const cloneDropped = parsed.watchlist
      .filter((item) => item.include && !diversifiedSymbols.has(item.symbol))
      .map((item) => ({
        symbol: item.symbol,
        reason: 'Dropped as a 20d-return clone of a higher-ranked pick.',
      }));
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
    const { instruments, unmappedSymbols } = lookupSessionStartInstruments(
      includedSymbols,
      catalog,
    );

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
      indexOptionBias(
        row.tradingsymbol as IndexOptionName,
        knowledge.symbols[row.tradingsymbol]?.bars ?? [],
      ),
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
    const steps = Object.fromEntries(
      underlyings.map((row) => [row.tradingsymbol, row.strikeStep]),
    ) as Partial<Record<IndexOptionName, number>>;
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
        biases: biases.map((bias) => ({
          index: bias.index,
          side: bias.side,
          reasons: bias.failReasons,
        })),
      },
      'Index-options local screen finished.',
    );
    const candidates = toUniverseCandidates(passingRows);
    const passing = new Set(passingRows.map((row) => row.symbol));
    const rowBySymbol = new Map(screened.map((row) => [row.symbol, row]));
    const indexDailyByName = Object.fromEntries(
      underlyings.map((row) => [
        row.tradingsymbol,
        knowledge.symbols[row.tradingsymbol]?.bars ?? [],
      ]),
    );
    const greeksBySymbol: Record<
      string,
      { delta: number | null; iv: number | null; ivHv: number | null }
    > = {};
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
        intersectWatchlistWithCatalog(
          universeSuggestionSchema.parse(completion.parsed),
          allowedSymbols,
        ),
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
          this.logger.info(
            { symbol: row.symbol, algorithm },
            'Options universe defaulted algorithm.',
          );
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
          .map((item) => ({
            symbol: item.symbol,
            reason: 'Dropped by per-index cap or local screen.',
          })),
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
    return this.running;
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
      tuuid: this.position?.tuuid ?? null,
    };
  }

  /**
   * Rules decide BUY/HOLD/EXIT/SKIP every cycle (aligned to the clock); the LLM only picks
   * the strike for a BUY. An open position is also checked every minute. Store-only.
   */
  public async startDecisionLoop(
    indexes?: readonly IndexOptionName[],
  ): Promise<ReturnType<LlmTradeAdvisorService['getDecisionLoopStatus']>> {
    if (this.running) {
      throw Object.assign(new Error('The LLM decision loop is already running.'), {
        statusCode: 400,
      });
    }

    this.book = 'options';
    this.decisionIndexes = indexes && indexes.length > 0 ? [...indexes] : [...INDEX_OPTION_NAMES];
    this.includedSymbols = [];
    this.sessionStartPayload = { instruments: [] };
    this.dayRows = null;
    this.running = true;
    this.loopGeneration += 1;
    const generation = this.loopGeneration;
    try {
      await this.runExclusive(() => this.restoreOpenPosition());
      await this.runExclusive(() => this.runDecisionCycle());
    } catch (error: unknown) {
      this.stop();
      throw error;
    }

    this.scheduleNextCycle(generation);
    this.monitorTimer = setInterval(() => {
      void this.monitorTick();
    }, MONITOR_INTERVAL_MS);
    this.monitorTimer.unref?.();

    this.logger.info(
      {
        intervalMinutes: config.llm.decisionIntervalMinutes,
        indexes: this.decisionIndexes,
        openSymbol: this.position?.symbol ?? null,
        paramsVersion: paramsVersion(this.params),
      },
      'Started rules-based options decision loop (LLM picks the strike only). Store-only.',
    );
    return this.getDecisionLoopStatus();
  }

  public stop(): ReturnType<LlmTradeAdvisorService['getDecisionLoopStatus']> {
    this.running = false;
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = undefined;
    }
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
    return this.getDecisionLoopStatus();
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const run = this.queue.then(task).finally(() => {
      this.queued -= 1;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** `generation` stops a cycle from a stopped-and-restarted loop scheduling a second timer. */
  private scheduleNextCycle(generation: number): void {
    if (!this.running || generation !== this.loopGeneration) {
      return;
    }
    const delay = msUntilNextCycle(new Date(), config.llm.decisionIntervalMinutes);
    this.cycleTimer = setTimeout(() => {
      void this.runExclusive(() => this.runDecisionCycle())
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Decision cycle failed.');
        })
        .finally(() => this.scheduleNextCycle(generation));
    }, delay);
    this.cycleTimer.unref?.();
  }

  private async monitorTick(): Promise<void> {
    if (!this.running || !this.position || this.queued > 0) {
      return;
    }
    try {
      await this.runExclusive(() => this.checkOpenPositionNow('monitor'));
    } catch (error: unknown) {
      this.logger.error({ err: error }, 'Position monitor check failed.');
    }
  }

  /** One decision cycle. Returns the number of rows stored (0 when nothing to decide). */
  public async runDecisionCycle(): Promise<number> {
    const now = new Date();
    const clock = istClock(now);
    const open = this.position;
    const outsideDecisionHours =
      !clock.isWeekday ||
      clock.minute < this.params.entryStartMinute ||
      clock.minute > this.params.squareOffMinute;
    if (!open && outsideDecisionHours) {
      return 0;
    }

    // An open trade is the only thing analysed until it is sold: its index alone, HOLD or EXIT.
    const indexes = open ? [open.index] : this.decisionIndexes;
    const view = await this.feed.load(indexes, now, {
      extraSymbols: open ? [open.symbol] : [],
      newsLookbackMinutes: this.params.newsLookbackMinutes,
    });
    if (!open && !view.isTradingDay) {
      this.logger.info(
        { dataGaps: view.dataGaps },
        'No market data for today yet; nothing stored.',
      );
      return 0;
    }
    const readings = view.indexes.map((data) => readIndex(data, view.backdrop, this.params, now));
    return open
      ? this.reviewOpenPosition(open, view, readings, now)
      : this.lookForEntry(view, readings, now);
  }

  private async lookForEntry(
    view: MarketView,
    readings: IndexReading[],
    now: Date,
  ): Promise<number> {
    const day = summarizeDay(await this.todayRows(now), now);
    const entry = decideEntry({ now, readings, day, vixPct: view.backdrop.vixPct }, this.params);
    if (entry.action === 'SKIP') {
      return this.storeSkip({
        view,
        readings,
        now,
        blockedBy: entry.blockedBy,
        leaning: entry.leaning,
        reading: entry.reading,
      });
    }

    const data = view.indexes.find((item) => item.index === entry.index);
    const { candidates, rejected } =
      data && data.spot !== null
        ? buildCandidates(
            {
              chain: data.chain,
              index: entry.index,
              side: entry.side,
              spot: data.spot,
              step: data.step,
              todayYmd: view.todayYmd,
              indexDaily: view.indexDaily[entry.index] ?? [],
            },
            this.params,
          )
        : { candidates: [], rejected: [] };
    if (candidates.length === 0) {
      return this.storeSkip({
        view,
        readings,
        now,
        blockedBy: ['no-liquid-contract'],
        leaning: { index: entry.index, side: entry.side, score: entry.score },
        reading: entry.reading,
        detail: summarizeRejections(rejected),
      });
    }

    const pick = await pickContract(
      this.llm,
      {
        index: entry.index,
        side: entry.side,
        score: entry.score,
        minutesToSquareOff: this.params.squareOffMinute - istClock(now).minute,
        candidates,
      },
      this.logger,
    );
    return this.storeBuy({ view, readings, now, reading: entry.reading, pick, candidates });
  }

  private async todayRows(now: Date): Promise<DayRow[]> {
    const ymd = istClock(now).ymd;
    if (this.dayRows?.ymd !== ymd) {
      const stored = await findDecisionsSince(istDayStart(now));
      this.dayRows = {
        ymd,
        rows: stored.map((row) => ({
          ...row,
          trigger: parseDecisionSnapshot(row.marketSnapshot)?.trigger ?? null,
        })),
      };
    }
    return this.dayRows.rows;
  }

  /** Keeps the in-memory day rows in step with a stored BUY or EXIT. */
  private recordDayRow(row: DayRow): void {
    if (this.dayRows?.ymd === istClock(row.decidedAt).ymd) {
      this.dayRows.rows.push(row);
    }
  }

  private async reviewOpenPosition(
    position: OpenTrade,
    view: MarketView,
    readings: IndexReading[],
    now: Date,
  ): Promise<number> {
    const quote = view.extraQuotes[position.symbol] ?? null;
    const price = this.trackPrice(position, quote);
    const reading = readings.find((item) => item.index === position.index) ?? null;
    const check = checkPositionExit(
      {
        now,
        position,
        price: exitCheckPrice(quote, price),
        spot: view.spots[position.index] ?? null,
        reading,
      },
      this.params,
    );
    if (check.action === 'EXIT') {
      return this.storeExit({
        position,
        quote,
        reason: check.reason,
        now,
        trigger: 'cycle',
        spots: view.spots,
        view,
        readings,
      });
    }
    const netPnlInr = this.netPnlInr(position, price);
    const rationale = describeHold({ position, price, netPnlInr, reading, params: this.params });
    const stored = await persistDecisions({
      asOf: now,
      batch: { decisions: [{ symbol: position.symbol, action: 'HOLD', rationale }] },
      lastPriceBySymbol: { [position.symbol]: price },
      priorBuyPriceBySymbol: { [position.symbol]: position.entryPrice.toFixed(4) },
      tokenBySymbol: { [position.symbol]: position.token },
      tuuidBySymbol: { [position.symbol]: position.tuuid },
      marketSnapshotBySymbol: {
        [position.symbol]: this.snapshot({
          now,
          trigger: 'cycle',
          spots: view.spots,
          view,
          readings,
          blockedBy: [],
          leaning: null,
          position: this.positionSnapshot(position, now, price),
        }),
      },
    });
    this.applyDecisionState('HOLD', position.symbol, position.token);
    return stored;
  }

  /** Minute check (and start-up check) of the open position: stops, trailing, time, 15:15. */
  private async checkOpenPositionNow(trigger: 'monitor' | 'startup'): Promise<void> {
    const position = this.position;
    if (!position) {
      return;
    }
    const now = new Date();
    let quote: MarketQuote | null = null;
    let spots: Partial<Record<IndexOptionName, number>> = {};
    try {
      ({ quote, spots } = await this.feed.quotePosition(position.symbol));
    } catch (error: unknown) {
      this.logger.warn({ err: error, symbol: position.symbol }, 'Position quote failed.');
    }
    const price = this.trackPrice(position, quote);
    const check = checkPositionExit(
      {
        now,
        position,
        price: exitCheckPrice(quote, price),
        spot: spots[position.index] ?? null,
      },
      this.params,
    );
    if (check.action === 'EXIT') {
      await this.storeExit({ position, quote, reason: check.reason, now, trigger, spots });
    }
  }

  /** Rebuilds the open position from the DB on start; closes it at once if it is from an earlier day. */
  private async restoreOpenPosition(): Promise<void> {
    this.position = null;
    const trade = await findOpenTrade();
    if (!trade) {
      return;
    }
    const index = indexNameFromOptionSymbol(trade.symbol);
    const side = optionSideFromSymbol(trade.symbol);
    const buySnapshot = parseDecisionSnapshot(trade.buySnapshot);
    const bought = buySnapshot?.position;
    const latest = parseDecisionSnapshot(trade.latestSnapshot)?.position;
    const entryPrice = trade.buyPrice ?? bought?.entryPrice ?? trade.holdPrices[0] ?? null;
    if (!index || !side || entryPrice === null || !(entryPrice > 0)) {
      await this.closeUnrestorableTrade(trade);
      return;
    }
    const seenPrices = [entryPrice, ...trade.holdPrices];
    this.position = {
      tuuid: trade.tuuid ?? randomUUID(),
      symbol: trade.symbol,
      index,
      side,
      strike: bought?.strike ?? strikeFromOptionSymbol(trade.symbol),
      expiry: bought?.expiry ?? null,
      token: trade.instrumentToken,
      entryPrice,
      enteredAt: trade.enteredAt,
      peakPrice: Math.max(...seenPrices, latest?.peakPrice ?? entryPrice),
      troughPrice: Math.min(...seenPrices, latest?.troughPrice ?? entryPrice),
      lotSize: bought?.lotSize ?? null,
      entryDelta: bought?.entryDelta ?? null,
      entrySpot: buySnapshot?.spots[index] ?? null,
    };
    this.applyDecisionState('HOLD', trade.symbol, trade.instrumentToken);
    if (istClock(trade.enteredAt).ymd < istClock(new Date()).ymd) {
      await this.checkOpenPositionNow('startup');
    }
  }

  /**
   * Stores a SELL for an open trade that cannot be rebuilt (e.g. a leftover stock BUY or a row
   * with no entry price), so the one-open-trade rule holds and the loop can trade again.
   */
  private async closeUnrestorableTrade(trade: OpenTradeRecord): Promise<void> {
    const now = new Date();
    const tuuid = trade.tuuid ?? randomUUID();
    const rationale = describeUnrestorableExit({
      symbol: trade.symbol,
      exitPrice: trade.lastPrice,
      buyPrice: trade.buyPrice,
    });
    await persistDecisions({
      asOf: now,
      batch: { decisions: [{ symbol: trade.symbol, action: 'EXIT', rationale }] },
      lastPriceBySymbol: { [trade.symbol]: trade.lastPrice },
      priorBuyPriceBySymbol: { [trade.symbol]: trade.buyPrice?.toFixed(4) ?? null },
      tokenBySymbol: { [trade.symbol]: trade.instrumentToken },
      tuuidBySymbol: { [trade.symbol]: tuuid },
      marketSnapshotBySymbol: {
        [trade.symbol]: this.snapshot({
          now,
          trigger: 'startup',
          spots: {},
          view: null,
          readings: [],
          blockedBy: [],
          leaning: null,
          exit: { reason: 'unrestorable', priceSource: 'last-known' },
        }),
      },
    });
    this.recordDayRow({
      action: 'EXIT',
      decidedAt: now,
      buyPrice: trade.buyPrice,
      sellPrice: trade.lastPrice,
      trigger: 'startup',
    });
    this.applyDecisionState('EXIT', trade.symbol, trade.instrumentToken);
    this.logger.warn(
      { symbol: trade.symbol, tuuid, exitPrice: trade.lastPrice },
      'Open trade could not be restored; stored a SELL for it so only one trade is ever open.',
    );
  }

  private async storeBuy(input: {
    view: MarketView;
    readings: IndexReading[];
    now: Date;
    reading: IndexReading;
    pick: ContractPickResult;
    candidates: ContractCandidate[];
  }): Promise<number> {
    if (this.position) {
      throw new Error(
        `A trade is already open (${this.position.symbol}, tuuid ${this.position.tuuid}); BUY refused.`,
      );
    }
    const { candidate, pickedBy, note, llm } = input.pick;
    const fillPrice = candidate.ask;
    const position: OpenTrade = {
      tuuid: randomUUID(),
      symbol: candidate.symbol,
      index: candidate.index,
      side: candidate.side,
      strike: candidate.strike,
      expiry: candidate.expiry,
      token: candidate.token,
      entryPrice: fillPrice,
      enteredAt: input.now,
      peakPrice: fillPrice,
      troughPrice: fillPrice,
      lotSize: candidate.lotSize,
      entryDelta: candidate.delta,
      entrySpot: input.view.spots[candidate.index] ?? input.reading.spot ?? null,
    };
    const rationale = describeBuy({
      now: input.now,
      candidate,
      fillPrice,
      reading: input.reading,
      pickedBy,
      candidateCount: input.candidates.length,
      params: this.params,
    });
    const meta: DecisionMeta = {
      confidence: Math.abs(input.reading.score) / SIGNAL_NAMES.length,
      ...(llm
        ? { model: llm.model, promptHash: llm.promptHash, rawCompletion: llm.rawCompletion }
        : {}),
    };
    const stored = await persistDecisions({
      asOf: input.now,
      batch: { decisions: [{ symbol: candidate.symbol, action: 'BUY', rationale }] },
      lastPriceBySymbol: { [candidate.symbol]: fillPrice },
      tokenBySymbol: { [candidate.symbol]: candidate.token },
      tuuidBySymbol: { [candidate.symbol]: position.tuuid },
      metaBySymbol: { [candidate.symbol]: meta },
      marketSnapshotBySymbol: {
        [candidate.symbol]: this.snapshot({
          now: input.now,
          trigger: 'cycle',
          spots: input.view.spots,
          view: input.view,
          readings: input.readings,
          blockedBy: [],
          leaning: null,
          entry: {
            index: candidate.index,
            side: candidate.side,
            score: input.reading.score,
            chosen: candidate.symbol,
            pickedBy,
            pickerNote: note,
            candidates: input.candidates.map((item) => ({
              symbol: item.symbol,
              strike: item.strike,
              ask: item.ask,
              spreadPct: item.spreadPct,
              delta: item.delta,
              ivToHv: item.ivToHv,
              rank: item.rank,
            })),
          },
          position: this.positionSnapshot(position, input.now, candidate.ltp),
          fees: { totalInr: candidate.feeInr, lotSize: candidate.lotSize },
        }),
      },
    });
    this.position = position;
    this.recordDayRow({
      action: 'BUY',
      decidedAt: input.now,
      buyPrice: fillPrice,
      sellPrice: null,
      trigger: 'cycle',
    });
    this.lastQuotedPriceBySymbol[candidate.symbol] = candidate.ltp;
    this.applyDecisionState('BUY', candidate.symbol, candidate.token);
    this.logger.info(
      {
        symbol: candidate.symbol,
        tuuid: position.tuuid,
        fillPrice,
        pickedBy,
        score: input.reading.score,
      },
      'Stored rules-based BUY without executing.',
    );
    return stored;
  }

  private async storeSkip(input: {
    view: MarketView;
    readings: IndexReading[];
    now: Date;
    blockedBy: GateId[];
    leaning: Leaning | null;
    reading: IndexReading | null;
    detail?: string;
  }): Promise<number> {
    if (this.position) {
      throw new Error(
        `A trade is open (${this.position.symbol}, tuuid ${this.position.tuuid}); only HOLD or EXIT are allowed.`,
      );
    }
    const shadow = input.leaning ? this.shadowContract(input.view, input.leaning) : null;
    const index =
      input.leaning?.index ?? input.reading?.index ?? this.decisionIndexes[0] ?? 'NIFTY';
    const data = input.view.indexes.find((item) => item.index === index);
    // A SKIP is not a trade, so it is stored under the index futures contract, never an option;
    // the option it would have bought stays in the snapshot's `leaning`.
    const row = data?.futures
      ? { symbol: data.futures.symbol, price: data.futuresPrice, token: data.futures.token }
      : {
          symbol: shadow?.symbol ?? index,
          price: shadow?.premium ?? null,
          token: shadow?.token ?? null,
        };
    const { symbol } = row;
    const rationale = describeSkip({
      now: input.now,
      blockedBy: input.blockedBy,
      leaning: input.leaning,
      reading: input.reading,
      params: this.params,
      ...(input.detail ? { detail: input.detail } : {}),
    });
    const stored = await persistDecisions({
      asOf: input.now,
      batch: { decisions: [{ symbol, action: 'SKIP', rationale }] },
      lastPriceBySymbol: { [symbol]: row.price },
      tokenBySymbol: { [symbol]: row.token },
      marketSnapshotBySymbol: {
        [symbol]: this.snapshot({
          now: input.now,
          trigger: 'cycle',
          spots: input.view.spots,
          view: input.view,
          readings: input.readings,
          blockedBy: input.blockedBy,
          leaning: input.leaning
            ? {
                ...input.leaning,
                symbol: shadow?.symbol ?? null,
                premium: shadow?.premium ?? null,
                delta: shadow?.delta ?? null,
              }
            : null,
        }),
      },
    });
    this.applyDecisionState('SKIP', symbol, null);
    return stored;
  }

  private async storeExit(input: {
    position: OpenTrade;
    quote: MarketQuote | null;
    reason: ExitReason;
    now: Date;
    trigger: DecisionSnapshot['trigger'];
    spots: Partial<Record<IndexOptionName, number>>;
    view?: MarketView;
    readings?: IndexReading[];
  }): Promise<number> {
    const { position } = input;
    const last = input.quote?.lastPrice && input.quote.lastPrice > 0 ? input.quote.lastPrice : null;
    const bid = input.quote?.bid ?? null;
    const exitPrice = bid ?? last ?? this.lastQuotedPriceBySymbol[position.symbol] ?? null;
    const priceSource = bid !== null ? 'bid' : last !== null ? 'last-trade' : 'last-known';
    const netPnlInr = this.netPnlInr(position, exitPrice);
    const rationale = describeExit({
      now: input.now,
      position,
      exitPrice,
      reason: input.reason,
      netPnlInr,
      params: this.params,
    });
    const stored = await persistDecisions({
      asOf: input.now,
      batch: { decisions: [{ symbol: position.symbol, action: 'EXIT', rationale }] },
      lastPriceBySymbol: { [position.symbol]: exitPrice },
      priorBuyPriceBySymbol: { [position.symbol]: position.entryPrice.toFixed(4) },
      tokenBySymbol: { [position.symbol]: position.token },
      tuuidBySymbol: { [position.symbol]: position.tuuid },
      marketSnapshotBySymbol: {
        [position.symbol]: this.snapshot({
          now: input.now,
          trigger: input.trigger,
          spots: input.spots,
          view: input.view ?? null,
          readings: input.readings ?? [],
          blockedBy: [],
          leaning: null,
          position: this.positionSnapshot(position, input.now, last ?? exitPrice),
          exit: { reason: input.reason, priceSource },
          ...(position.lotSize
            ? {
                fees: {
                  totalInr:
                    exitPrice === null
                      ? 0
                      : estimateOptionsRoundTripCost({
                          buyPremium: position.entryPrice,
                          sellPremium: exitPrice,
                          quantity: position.lotSize,
                        }).totalInr,
                  lotSize: position.lotSize,
                },
              }
            : {}),
        }),
      },
    });
    this.position = null;
    this.recordDayRow({
      action: 'EXIT',
      decidedAt: input.now,
      buyPrice: position.entryPrice,
      sellPrice: exitPrice,
      trigger: input.trigger,
    });
    this.applyDecisionState('EXIT', position.symbol, position.token);
    this.logger.info(
      {
        symbol: position.symbol,
        tuuid: position.tuuid,
        reason: input.reason,
        exitPrice,
        priceSource,
        trigger: input.trigger,
      },
      'Stored rules-based EXIT without executing.',
    );
    return stored;
  }

  /** Updates the last price and the best/worst premium seen; returns the usable price. */
  private trackPrice(position: OpenPosition, quote: MarketQuote | null): number | null {
    const price = quote?.lastPrice && quote.lastPrice > 0 ? quote.lastPrice : null;
    if (price !== null) {
      position.peakPrice = Math.max(position.peakPrice, price);
      position.troughPrice = Math.min(position.troughPrice, price);
      this.lastQuotedPriceBySymbol[position.symbol] = price;
    }
    return price;
  }

  private netPnlInr(position: OpenPosition, price: number | null): number | null {
    if (position.lotSize === null || price === null) {
      return null;
    }
    const costs = estimateOptionsRoundTripCost({
      buyPremium: position.entryPrice,
      sellPremium: price,
      quantity: position.lotSize,
    });
    return round((price - position.entryPrice) * position.lotSize - costs.totalInr);
  }

  /** The contract a SKIP would have bought, so the review can estimate what was missed. */
  private shadowContract(
    view: MarketView,
    leaning: Leaning,
  ): { symbol: string; premium: number | null; delta: number | null; token: number } | null {
    const data = view.indexes.find((item) => item.index === leaning.index);
    if (!data || data.spot === null) {
      return null;
    }
    const spot = data.spot;
    const { candidates } = buildCandidates(
      {
        chain: data.chain,
        index: leaning.index,
        side: leaning.side,
        spot,
        step: data.step,
        todayYmd: view.todayYmd,
        indexDaily: view.indexDaily[leaning.index] ?? [],
      },
      this.params,
    );
    const best = candidates[0];
    if (best) {
      return { symbol: best.symbol, premium: best.ask, delta: best.delta, token: best.token };
    }
    const nearest = data.chain
      .filter((row) => row.side === leaning.side && row.ltp !== null)
      .sort((left, right) => Math.abs(left.strike - spot) - Math.abs(right.strike - spot))[0];
    return nearest
      ? {
          symbol: nearest.symbol,
          premium: nearest.ask ?? nearest.ltp,
          delta: null,
          token: nearest.token,
        }
      : null;
  }

  private positionSnapshot(
    position: OpenPosition,
    now: Date,
    lastPrice: number | null,
  ): NonNullable<DecisionSnapshot['position']> {
    return {
      symbol: position.symbol,
      index: position.index,
      side: position.side,
      strike: position.strike,
      expiry: position.expiry,
      lotSize: position.lotSize,
      entryPrice: position.entryPrice,
      enteredAt: position.enteredAt.toISOString(),
      heldMinutes: minutesBetween(position.enteredAt, now),
      lastPrice,
      pnlPct: round(pctChange(position.entryPrice, lastPrice)),
      netPnlInr: this.netPnlInr(position, lastPrice),
      peakPrice: position.peakPrice,
      troughPrice: position.troughPrice,
      entryDelta: position.entryDelta,
    };
  }

  private snapshot(input: {
    now: Date;
    trigger: DecisionSnapshot['trigger'];
    spots: Partial<Record<IndexOptionName, number>>;
    view: MarketView | null;
    readings: readonly IndexReading[];
    blockedBy: readonly GateId[];
    leaning: DecisionSnapshot['leaning'];
    entry?: NonNullable<DecisionSnapshot['entry']>;
    position?: NonNullable<DecisionSnapshot['position']>;
    exit?: NonNullable<DecisionSnapshot['exit']>;
    fees?: NonNullable<DecisionSnapshot['fees']>;
  }): DecisionSnapshot {
    const backdrop = input.view?.backdrop;
    return {
      schema: SNAPSHOT_SCHEMA,
      paramsVersion: paramsVersion(this.params),
      tunables: tunableValues(this.params),
      trigger: input.trigger,
      asOfIst: formatIstTimestamp(input.now),
      spots: Object.fromEntries(
        Object.entries(input.spots).filter(
          (entry): entry is [string, number] => entry[1] !== undefined,
        ),
      ),
      readings: input.readings.map((reading) => ({
        index: reading.index,
        score: reading.score,
        votes: reading.votes,
        rsi: round(reading.rsi, 1),
        futuresPrice: reading.futuresPrice,
        vwap: round(reading.vwap),
        callWall: reading.callWall,
        putWall: reading.putWall,
        pcr: reading.pcr,
        expiryToday: reading.expiryToday,
      })),
      market: backdrop
        ? {
            vixPct: round(backdrop.vixPct),
            usdInrPct: round(backdrop.usdInrPct, 3),
            crudePct: round(backdrop.crudePct),
            gapPct: round(backdrop.gapPct),
            advancersPct: round(backdrop.advancersPct, 1),
            headlineTone: backdrop.headlineTone,
          }
        : EMPTY_BACKDROP,
      news: input.view?.news ?? {},
      headlines: input.view?.headlines ?? [],
      blockedBy: [...input.blockedBy],
      leaning: input.leaning,
      ...(input.entry ? { entry: input.entry } : {}),
      ...(input.position ? { position: input.position } : {}),
      ...(input.exit ? { exit: input.exit } : {}),
      ...(input.fees ? { fees: input.fees } : {}),
      dataGaps: input.view?.dataGaps ?? [],
    };
  }

  private applyDecisionState(action: string, symbol: string, token: number | null): void {
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
    label: 'universe',
  ) {
    return completeJsonWithRetry(this.llm, messages, UNIVERSE_MAX_OUTPUT_TOKENS, this.logger, label);
  }
}
