import type { InstrumentExchange, KiteBroker, MarketQuote } from '../broker/KiteBroker.js';
import type { SessionLogger } from '../broker/kite/KiteTickerStream.js';
import {
  loadIndexUnderlyings,
  type IndexOptionName,
  type IndexUnderlying,
} from '../instruments/kiteIndexUnderlyings.js';
import { getCatalogTradingsymbols } from '../instruments/kiteInstruments.js';
import type { NewsItem, NewsService } from '../news/NewsService.js';
import { scoreOptionNewsRisk, type OptionNewsRiskLevel } from '../options/greeksIv.js';
import {
  filterNearestWeeklyAtmBand,
  nearestFuture,
  parseNfoIndexOptions,
  type FutureContract,
  type KiteRawInstrument,
  type NfoOptionContract,
} from '../options/nfoChain.js';
import { formatIstWallClock, istClock, istDayStart } from '../strategy/clock.js';
import type { ChainQuote } from '../strategy/contracts.js';
import { completedBars, pctChange } from '../strategy/indicators.js';
import { headlineTone, type IndexMarketData, type MarketBackdrop } from '../strategy/signals.js';
import { addCalendarDays } from '../universe/dates.js';
import type { DailyBar, IntradayBar } from '../universe/types.js';

export type MarketDataSource = Pick<
  KiteBroker,
  'getQuotes' | 'getDayInstruments' | 'getFiveMinuteCandles' | 'getDailyCandles'
>;

export type HeadlineSource = Pick<NewsService, 'fetchIndexNews'>;

export type MarketView = {
  todayYmd: string;
  /** False on weekends, holidays and before the first 5-minute bar of the day. */
  isTradingDay: boolean;
  indexes: IndexMarketData[];
  backdrop: MarketBackdrop;
  spots: Partial<Record<IndexOptionName, number>>;
  indexDaily: Partial<Record<IndexOptionName, DailyBar[]>>;
  /** Quotes for symbols requested outside the chain band (e.g. the open position). */
  extraQuotes: Record<string, MarketQuote>;
  news: Partial<Record<IndexOptionName, OptionNewsRiskLevel>>;
  headlines: string[];
  dataGaps: string[];
};

const VIX_KEY = 'NSE:INDIA VIX';
const CHAIN_WINGS = 5;
/** New positions never use a contract that expires today. */
const MIN_DAYS_TO_EXPIRY = 1;
const FUTURES_LOOKBACK_DAYS = 7;
const DAILY_LOOKBACK_DAYS = 45;
const INDEX_NEWS_WINDOW_MS = 2 * 60 * 60_000;
const MACRO_NEWS_WINDOW_MS = 3 * 60 * 60_000;
/** Macro headlines move slowly; they are re-fetched at most this often. */
const MACRO_NEWS_CACHE_MS = 15 * 60_000;
const MIN_BREADTH_STOCKS = 20;
const MACRO_QUERIES = [
  { symbol: 'GLOBAL', query: 'global markets Wall Street Fed' },
  { symbol: 'MACRO', query: 'crude oil rupee dollar' },
];

function spotKey(row: IndexUnderlying): string {
  return `${row.exchange}:${row.kiteQuoteSymbol}`;
}

function readQuote(quotes: Record<string, MarketQuote>, key: string): MarketQuote | undefined {
  return quotes[key] ?? quotes[key.toUpperCase()];
}

function publishedWithin(item: NewsItem, sinceMs: number): boolean {
  if (!item.publishedAt) {
    return true;
  }
  const published = Date.parse(item.publishedAt);
  return Number.isFinite(published) ? published >= sinceMs : true;
}

/**
 * Loads everything one decision cycle needs from Kite (two batched quote calls,
 * 5-minute futures bars, cached daily bars) plus headlines. Missing pieces are
 * recorded in `dataGaps` instead of failing the cycle.
 */
export class LiveMarketFeed {
  private readonly kite: MarketDataSource;
  private readonly news: HeadlineSource;
  private readonly logger: SessionLogger;
  private readonly breadthSymbols: string[];
  private day = LiveMarketFeed.emptyDay('');
  private macroNews: {
    fetchedAtMs: number;
    entries: Awaited<ReturnType<HeadlineSource['fetchIndexNews']>>;
  } | null = null;

  public constructor(options: {
    kite: MarketDataSource;
    news: HeadlineSource;
    logger: SessionLogger;
  }) {
    this.kite = options.kite;
    this.news = options.news;
    this.logger = options.logger;
    this.breadthSymbols = getCatalogTradingsymbols().filter((symbol) => !symbol.endsWith('BEES'));
  }

  private static emptyDay(ymd: string) {
    return {
      ymd,
      unavailable: new Set<InstrumentExchange>(),
      indexDaily: {} as Partial<Record<IndexOptionName, DailyBar[]>>,
      firstOi: new Map<string, number>(),
      /** Parsed index option contracts by requested indexes; the dump is fixed for the day. */
      contracts: new Map<string, NfoOptionContract[]>(),
      /** Futures bars from earlier days by instrument token; only today's bars are re-fetched. */
      futuresHistory: new Map<number, IntradayBar[]>(),
    };
  }

  public async load(
    indexes: readonly IndexOptionName[],
    now: Date,
    options: { extraSymbols?: readonly string[]; newsLookbackMinutes: number },
  ): Promise<MarketView> {
    const clock = istClock(now);
    if (this.day.ymd !== clock.ymd) {
      this.day = LiveMarketFeed.emptyDay(clock.ymd);
    }
    const gaps: string[] = [];
    const underlyings = loadIndexUnderlyings();
    const wanted = underlyings.filter((row) =>
      indexes.includes(row.tradingsymbol as IndexOptionName),
    );
    const newsPromise = this.loadNews(wanted, now, options.newsLookbackMinutes, gaps);

    const nfoRows = await this.instruments('NFO', clock.ymd, gaps);
    const cdsRows = await this.instruments('CDS', clock.ymd, gaps);
    const mcxRows = await this.instruments('MCX', clock.ymd, gaps);
    const futures = new Map(
      wanted.map((row) => [
        row.tradingsymbol,
        nearestFuture(nfoRows, row.tradingsymbol, clock.ymd, MIN_DAYS_TO_EXPIRY),
      ]),
    );
    const usdInr = nearestFuture(cdsRows, 'USDINR', clock.ymd, MIN_DAYS_TO_EXPIRY);
    const crude = nearestFuture(mcxRows, 'CRUDEOIL', clock.ymd, MIN_DAYS_TO_EXPIRY);

    const marketQuotes = await this.quotes(
      [
        ...underlyings.map(spotKey),
        VIX_KEY,
        ...[...futures.values()].flatMap((future) =>
          future ? [`NFO:${future.tradingsymbol}`] : [],
        ),
        ...(usdInr ? [`CDS:${usdInr.tradingsymbol}`] : []),
        ...(crude ? [`MCX:${crude.tradingsymbol}`] : []),
        ...this.breadthSymbols.map((symbol) => `NSE:${symbol}`),
      ],
      'market quotes',
      gaps,
    );
    const spots: Partial<Record<IndexOptionName, number>> = {};
    for (const row of underlyings) {
      const last = readQuote(marketQuotes, spotKey(row))?.lastPrice;
      if (last && last > 0) {
        spots[row.tradingsymbol as IndexOptionName] = last;
      }
    }

    const contractsKey = [...indexes].sort().join(',');
    let contracts = this.day.contracts.get(contractsKey);
    if (!contracts) {
      contracts = parseNfoIndexOptions(nfoRows, indexes);
      if (nfoRows.length > 0) {
        this.day.contracts.set(contractsKey, contracts);
      }
    }
    const steps = Object.fromEntries(
      wanted.map((row) => [row.tradingsymbol, row.strikeStep]),
    ) as Partial<Record<IndexOptionName, number>>;
    const band = filterNearestWeeklyAtmBand(
      contracts,
      spots,
      steps,
      clock.ymd,
      CHAIN_WINGS,
      MIN_DAYS_TO_EXPIRY,
    );
    const extraSymbols = [...new Set(options.extraSymbols ?? [])];
    const chainQuotes = await this.quotes(
      [
        ...new Set([
          ...band.map((contract) => `NFO:${contract.tradingsymbol}`),
          ...extraSymbols.map((symbol) => `NFO:${symbol}`),
        ]),
      ],
      'option chain quotes',
      gaps,
    );
    const chain = band.map((contract) =>
      this.toChainQuote(contract, readQuote(chainQuotes, `NFO:${contract.tradingsymbol}`)),
    );

    const indexData: IndexMarketData[] = [];
    const indexDaily: Partial<Record<IndexOptionName, DailyBar[]>> = {};
    for (const row of wanted) {
      const index = row.tradingsymbol as IndexOptionName;
      const future = futures.get(row.tradingsymbol) ?? null;
      const futureQuote = future
        ? readQuote(marketQuotes, `NFO:${future.tradingsymbol}`)
        : undefined;
      indexDaily[index] = await this.dailyBars(row, clock.ymd, gaps);
      indexData.push({
        index,
        spot: spots[index] ?? null,
        step: row.strikeStep,
        futures: future ? { symbol: future.tradingsymbol, token: future.instrumentToken } : null,
        futuresPrice: futureQuote?.lastPrice ?? null,
        futuresVwap: futureQuote?.vwap ?? null,
        futuresBars: await this.futuresBars(index, future, now, gaps),
        chain: chain.filter((quote) => quote.index === index),
        expiryToday: contracts.some(
          (contract) => contract.name === index && contract.expiry === clock.ymd,
        ),
        newsLevel: 'none',
      });
    }

    const news = await newsPromise;
    for (const data of indexData) {
      data.newsLevel = news.levels[data.index] ?? 'none';
    }
    const quoteChange = (key: string | null) => {
      const quote = key ? readQuote(marketQuotes, key) : undefined;
      return pctChange(quote?.prevClose ?? null, quote?.lastPrice ?? null);
    };
    const gapRow = underlyings.find((row) => row.tradingsymbol === 'NIFTY') ?? underlyings[0];
    const gapQuote = gapRow ? readQuote(marketQuotes, spotKey(gapRow)) : undefined;

    return {
      todayYmd: clock.ymd,
      isTradingDay:
        clock.isWeekday &&
        indexData.some((data) =>
          data.futuresBars.some((bar) => istClock(new Date(bar.t)).ymd === clock.ymd),
        ),
      indexes: indexData,
      backdrop: {
        vixPct: quoteChange(VIX_KEY),
        usdInrPct: quoteChange(usdInr ? `CDS:${usdInr.tradingsymbol}` : null),
        crudePct: quoteChange(crude ? `MCX:${crude.tradingsymbol}` : null),
        gapPct: pctChange(gapQuote?.prevClose ?? null, gapQuote?.open ?? null),
        advancersPct: this.advancersPct(marketQuotes),
        headlineTone: news.tone,
      },
      spots,
      indexDaily,
      extraQuotes: Object.fromEntries(
        extraSymbols.flatMap((symbol) => {
          const quote = readQuote(chainQuotes, `NFO:${symbol}`);
          return quote ? [[symbol, quote]] : [];
        }),
      ),
      news: news.levels,
      headlines: news.headlines,
      dataGaps: gaps,
    };
  }

  /** One quote call for the open option plus the index spots (used every minute). */
  public async quotePosition(
    symbol: string,
  ): Promise<{ quote: MarketQuote | null; spots: Partial<Record<IndexOptionName, number>> }> {
    const underlyings = loadIndexUnderlyings();
    const quotes = await this.kite.getQuotes([`NFO:${symbol}`, ...underlyings.map(spotKey)]);
    const spots: Partial<Record<IndexOptionName, number>> = {};
    for (const row of underlyings) {
      const last = readQuote(quotes, spotKey(row))?.lastPrice;
      if (last && last > 0) {
        spots[row.tradingsymbol as IndexOptionName] = last;
      }
    }
    return { quote: readQuote(quotes, `NFO:${symbol}`) ?? null, spots };
  }

  private toChainQuote(contract: NfoOptionContract, quote: MarketQuote | undefined): ChainQuote {
    const oi = quote?.oi ?? 0;
    let oiChangeToday: number | null = null;
    if (oi > 0) {
      const first = this.day.firstOi.get(contract.tradingsymbol);
      if (first === undefined) {
        this.day.firstOi.set(contract.tradingsymbol, oi);
      } else {
        oiChangeToday = oi - first;
      }
    }
    return {
      symbol: contract.tradingsymbol,
      index: contract.name,
      side: contract.instrumentType,
      strike: contract.strike,
      expiry: contract.expiry,
      token: contract.instrumentToken,
      lotSize: contract.lotSize ?? null,
      ltp: quote?.lastPrice && quote.lastPrice > 0 ? quote.lastPrice : null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      oi,
      volume: quote?.volume ?? 0,
      oiChangeToday,
    };
  }

  private advancersPct(quotes: Record<string, MarketQuote>): number | null {
    let up = 0;
    let counted = 0;
    for (const symbol of this.breadthSymbols) {
      const quote = readQuote(quotes, `NSE:${symbol}`);
      if (quote?.lastPrice && quote.prevClose) {
        counted += 1;
        up += quote.lastPrice > quote.prevClose ? 1 : 0;
      }
    }
    return counted >= MIN_BREADTH_STOCKS ? (up / counted) * 100 : null;
  }

  private async instruments(
    exchange: InstrumentExchange,
    ymd: string,
    gaps: string[],
  ): Promise<KiteRawInstrument[]> {
    if (this.day.unavailable.has(exchange)) {
      gaps.push(`${exchange} instruments unavailable`);
      return [];
    }
    try {
      return await this.kite.getDayInstruments(exchange, ymd);
    } catch (error: unknown) {
      this.logger.warn({ err: error, exchange }, 'Instrument dump failed; continuing without it.');
      if (exchange !== 'NFO') {
        this.day.unavailable.add(exchange);
      }
      gaps.push(`${exchange} instruments unavailable`);
      return [];
    }
  }

  private async quotes(
    keys: readonly string[],
    label: string,
    gaps: string[],
  ): Promise<Record<string, MarketQuote>> {
    if (keys.length === 0) {
      return {};
    }
    try {
      return await this.kite.getQuotes(keys);
    } catch (error: unknown) {
      this.logger.warn({ err: error, label }, 'Kite quotes failed; continuing without them.');
      gaps.push(`${label} unavailable`);
      return {};
    }
  }

  private async futuresBars(
    index: IndexOptionName,
    future: FutureContract | null,
    now: Date,
    gaps: string[],
  ): Promise<IntradayBar[]> {
    if (!future) {
      gaps.push(`${index} futures contract not found`);
      return [];
    }
    const today = istClock(now).ymd;
    const history = this.day.futuresHistory.get(future.instrumentToken);
    try {
      const from = history
        ? istDayStart(now)
        : new Date(now.getTime() - FUTURES_LOOKBACK_DAYS * 86_400_000);
      const bars = await this.kite.getFiveMinuteCandles(
        future.instrumentToken,
        formatIstWallClock(from),
        formatIstWallClock(now),
        { includeOi: true },
      );
      const ymdOf = (bar: IntradayBar) => istClock(new Date(bar.t)).ymd;
      const earlier = history ?? bars.filter((bar) => ymdOf(bar) < today);
      if (!history && earlier.length > 0) {
        this.day.futuresHistory.set(future.instrumentToken, earlier);
      }
      const todayBars = bars.filter((bar) => ymdOf(bar) === today);
      return completedBars([...earlier, ...todayBars], 5, now);
    } catch (error: unknown) {
      this.logger.warn({ err: error, index }, 'Futures 5-minute candles failed.');
      gaps.push(`${index} futures candles unavailable`);
      return [];
    }
  }

  private async dailyBars(row: IndexUnderlying, ymd: string, gaps: string[]): Promise<DailyBar[]> {
    const index = row.tradingsymbol as IndexOptionName;
    const cached = this.day.indexDaily[index];
    if (cached) {
      return cached;
    }
    try {
      const bars = await this.kite.getDailyCandles(
        row.instrumentToken,
        addCalendarDays(ymd, -DAILY_LOOKBACK_DAYS),
        addCalendarDays(ymd, -1),
      );
      this.day.indexDaily[index] = bars;
      return bars;
    } catch (error: unknown) {
      this.logger.warn({ err: error, index }, 'Index daily candles failed.');
      gaps.push(`${index} daily candles unavailable`);
      return [];
    }
  }

  private async macroHeadlines(
    now: Date,
  ): Promise<Awaited<ReturnType<HeadlineSource['fetchIndexNews']>>> {
    const age = this.macroNews ? now.getTime() - this.macroNews.fetchedAtMs : -1;
    if (this.macroNews && age >= 0 && age < MACRO_NEWS_CACHE_MS) {
      return this.macroNews.entries;
    }
    const entries = await this.news.fetchIndexNews(
      MACRO_QUERIES,
      new Date(now.getTime() - MACRO_NEWS_WINDOW_MS),
      now,
    );
    this.macroNews = { fetchedAtMs: now.getTime(), entries };
    return entries;
  }

  private async loadNews(
    wanted: readonly IndexUnderlying[],
    now: Date,
    lookbackMinutes: number,
    gaps: string[],
  ): Promise<{
    levels: Partial<Record<IndexOptionName, OptionNewsRiskLevel>>;
    tone: number;
    headlines: string[];
  }> {
    const levels: Partial<Record<IndexOptionName, OptionNewsRiskLevel>> = {};
    try {
      const [indexNews, macroNews] = await Promise.all([
        this.news.fetchIndexNews(
          wanted.map((row) => ({ symbol: row.tradingsymbol, query: row.googleQuery })),
          new Date(now.getTime() - INDEX_NEWS_WINDOW_MS),
          now,
        ),
        this.macroHeadlines(now),
      ]);
      const indexSince = now.getTime() - lookbackMinutes * 60_000;
      const headlines: string[] = [];
      for (const entry of indexNews) {
        const recent = entry.items.filter((item) => publishedWithin(item, indexSince));
        levels[entry.symbol.toUpperCase() as IndexOptionName] = scoreOptionNewsRisk(recent).level;
        headlines.push(...recent.slice(0, 1).map((item) => item.title));
      }
      const macroSince = now.getTime() - MACRO_NEWS_WINDOW_MS;
      const macroTitles = macroNews.flatMap((entry) =>
        entry.items.filter((item) => publishedWithin(item, macroSince)).map((item) => item.title),
      );
      headlines.push(...macroTitles.slice(0, 2));
      return {
        levels,
        tone: headlineTone(macroTitles),
        headlines: headlines.slice(0, 3).map((title) => title.slice(0, 140)),
      };
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'Headline fetch failed; treating news as quiet.');
      gaps.push('headlines unavailable');
      return { levels, tone: 0, headlines: [] };
    }
  }
}
