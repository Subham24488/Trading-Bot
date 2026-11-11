import type { InstrumentExchange, KiteBroker } from '../broker/KiteBroker.js';
import type { SessionLogger } from '../broker/kite/KiteTickerStream.js';
import { loadIndexUnderlyings, type IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import { loadKiteInstruments } from '../instruments/kiteInstruments.js';
import type { NewsService, SymbolNews } from '../news/NewsService.js';
import {
  atmStrike,
  chooseTradingExpiry,
  expiryToYmd,
  nearestFuture,
  nfoNameToIndex,
  parseNfoIndexOptions,
  type FutureContract,
  type KiteRawInstrument,
} from '../options/nfoChain.js';
import {
  CHAIN_WINGS,
  DAILY_LOOKBACK_DAYS,
  FUTURES_LOOKBACK_DAYS,
  MACRO_QUERIES,
  MIN_DAYS_TO_EXPIRY,
  VIX_KEY,
  spotKey,
} from '../services/LiveMarketFeed.js';
import { addCalendarDays, istYmd } from '../universe/dates.js';
import type { DailyBar, IntradayBar } from '../universe/types.js';

export const RECORDING_VERSION = 1;

/** Kite's instrument token for INDIA VIX (NSE index, history only). */
const VIX_TOKEN = 264969;
/** Enough daily bars to find the previous close across a long weekend or holiday. */
const PREV_CLOSE_LOOKBACK_DAYS = 10;
/** A weekly contract further out than this means the date's own expiry has since expired. */
const WEEKLY_EXPIRY_MAX_DAYS = 7;

export type RecorderBroker = Pick<
  KiteBroker,
  'getDayInstruments' | 'getMinuteCandles' | 'getFiveMinuteCandles' | 'getDailyCandles'
>;

/** One quoted instrument: its 1-minute bars for the day, replayed as live quotes. */
export type RecordedSeries = {
  /** Quote key as LiveMarketFeed asks for it, e.g. `NSE:NIFTY 50` or `NFO:NIFTY26N1724900CE`. */
  key: string;
  token: number;
  /** Bar `t` is the bar's start, as Kite returns it. */
  minuteBars: IntradayBar[];
  /** Close of the previous trading day (the quote's `prevClose`). */
  prevClose: number | null;
  /** Options get a modelled bid/ask; Kite history has none. */
  option: boolean;
};

export type MarketRecording = {
  version: number;
  date: string;
  indexes: IndexOptionName[];
  recordedAt: string;
  /** Today's dump filtered to what the replay needs; expiries normalised to `YYYY-MM-DD`. */
  instruments: Record<InstrumentExchange, KiteRawInstrument[]>;
  series: RecordedSeries[];
  /** Futures 5-minute bars with OI by token, from FUTURES_LOOKBACK_DAYS before the date. */
  fiveMinuteBars: Record<string, IntradayBar[]>;
  /** Daily bars by token, up to and including the date. */
  dailyBars: Record<string, DailyBar[]>;
  headlines: SymbolNews[];
  dataGaps: string[];
};

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function calendarDays(fromYmd: string, toYmd: string): number {
  return Math.round(
    (Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000,
  );
}

function prevClose(bars: readonly DailyBar[], ymd: string): number | null {
  const before = bars.filter((bar) => bar.d < ymd);
  return before.at(-1)?.c ?? null;
}

function withYmdExpiry(row: KiteRawInstrument): KiteRawInstrument {
  return { ...row, expiry: expiryToYmd(row.expiry) };
}

function isFuture(row: KiteRawInstrument, name: string): boolean {
  return (
    String(row.instrument_type ?? '').toUpperCase() === 'FUT' &&
    String(row.name ?? '')
      .trim()
      .toUpperCase() === name
  );
}

/**
 * Downloads everything one replayed day needs from Kite history and the news search: the
 * inputs LiveMarketFeed reads each cycle, as 1-minute bars for the day plus the futures and
 * daily history behind the signals. About 200 history calls at the broker's throttle.
 */
export async function recordMarketDay(input: {
  kite: RecorderBroker;
  news: Pick<NewsService, 'fetchIndexNewsOn'>;
  logger: SessionLogger;
  date: string;
  indexes: readonly IndexOptionName[];
}): Promise<MarketRecording> {
  const { kite, date } = input;
  const gaps: string[] = [];
  const dayFrom = `${date} 09:15:00`;
  const dayTo = `${date} 15:30:00`;
  const series: RecordedSeries[] = [];
  const dailyBars: Record<string, DailyBar[]> = {};
  const fiveMinuteBars: Record<string, IntradayBar[]> = {};

  const minuteBars = async (
    label: string,
    token: number,
    includeOi: boolean,
  ): Promise<IntradayBar[]> => {
    try {
      return await kite.getMinuteCandles(token, dayFrom, dayTo, { includeOi });
    } catch (error: unknown) {
      input.logger.warn({ err: error, label }, 'Simulation: 1-minute candles failed.');
      gaps.push(`${label} 1-minute candles unavailable`);
      return [];
    }
  };
  const daily = async (label: string, token: number, lookbackDays: number): Promise<DailyBar[]> => {
    try {
      const bars = await kite.getDailyCandles(token, addCalendarDays(date, -lookbackDays), date);
      dailyBars[String(token)] = bars;
      return bars;
    } catch (error: unknown) {
      input.logger.warn({ err: error, label }, 'Simulation: daily candles failed.');
      gaps.push(`${label} daily candles unavailable`);
      return [];
    }
  };
  const record = async (key: string, token: number, options: { oi: boolean; option?: boolean }) => {
    const bars = await minuteBars(key, token, options.oi);
    const closes = options.option ? [] : await daily(key, token, PREV_CLOSE_LOOKBACK_DAYS);
    series.push({
      key,
      token,
      minuteBars: bars,
      prevClose: prevClose(closes, date),
      option: options.option ?? false,
    });
    return bars;
  };

  // Index spots: all three, since the open-position check quotes every index.
  const underlyings = loadIndexUnderlyings();
  const spotBars = new Map<IndexOptionName, IntradayBar[]>();
  for (const row of underlyings) {
    const index = row.tradingsymbol as IndexOptionName;
    let bars: IntradayBar[];
    try {
      bars = await kite.getMinuteCandles(row.instrumentToken, dayFrom, dayTo, { includeOi: false });
    } catch (error: unknown) {
      throw httpError(
        `Kite history for ${index} on ${date} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }
    const history = await daily(index, row.instrumentToken, DAILY_LOOKBACK_DAYS);
    series.push({
      key: spotKey(row),
      token: row.instrumentToken,
      minuteBars: bars,
      prevClose: prevClose(history, date),
      option: false,
    });
    spotBars.set(index, bars);
  }
  const missing = input.indexes.filter((index) => (spotBars.get(index) ?? []).length === 0);
  if (missing.length > 0) {
    throw httpError(
      `No market data for ${missing.join(', ')} on ${date}; it was not a trading day or is outside Kite's history.`,
      422,
    );
  }

  await record(VIX_KEY, VIX_TOKEN, { oi: false });

  // The instrument dump only lists contracts that trade today; expired ones have no history.
  const dump = async (exchange: InstrumentExchange): Promise<KiteRawInstrument[]> => {
    try {
      return (await kite.getDayInstruments(exchange, istYmd())).map(withYmdExpiry);
    } catch (error: unknown) {
      input.logger.warn({ err: error, exchange }, 'Simulation: instrument dump failed.');
      gaps.push(`${exchange} instruments unavailable`);
      return [];
    }
  };
  const nfoRows = (await dump('NFO')).filter((row) => {
    const index = nfoNameToIndex(String(row.name ?? ''));
    return index !== null && input.indexes.includes(index);
  });
  const cdsRows = (await dump('CDS')).filter((row) => isFuture(row, 'USDINR'));
  const mcxRows = (await dump('MCX')).filter((row) => isFuture(row, 'CRUDEOIL'));

  const recordFuture = async (
    label: string,
    exchange: InstrumentExchange,
    future: FutureContract | null,
  ) => {
    if (!future) {
      gaps.push(`${label} futures contract not listed`);
      return;
    }
    await record(`${exchange}:${future.tradingsymbol}`, future.instrumentToken, {
      oi: exchange === 'NFO',
    });
  };
  for (const index of input.indexes) {
    const future = nearestFuture(nfoRows, index, date, MIN_DAYS_TO_EXPIRY);
    await recordFuture(index, 'NFO', future);
    if (future) {
      try {
        fiveMinuteBars[String(future.instrumentToken)] = await kite.getFiveMinuteCandles(
          future.instrumentToken,
          `${addCalendarDays(date, -FUTURES_LOOKBACK_DAYS)} 00:00:00`,
          dayTo,
          { includeOi: true },
        );
      } catch (error: unknown) {
        input.logger.warn({ err: error, index }, 'Simulation: futures 5-minute candles failed.');
        gaps.push(`${index} futures candles unavailable`);
      }
    }
  }
  await recordFuture('USDINR', 'CDS', nearestFuture(cdsRows, 'USDINR', date, MIN_DAYS_TO_EXPIRY));
  await recordFuture(
    'CRUDEOIL',
    'MCX',
    nearestFuture(mcxRows, 'CRUDEOIL', date, MIN_DAYS_TO_EXPIRY),
  );

  // Breadth: the same catalog stocks LiveMarketFeed counts.
  for (const stock of loadKiteInstruments()) {
    if (!stock.tradingsymbol.endsWith('BEES')) {
      await record(`NSE:${stock.tradingsymbol}`, stock.instrumentToken, { oi: false });
    }
  }

  // Options: every strike the ATM band can reach as the index moves through the day.
  const contracts = parseNfoIndexOptions(nfoRows, input.indexes);
  for (const row of underlyings) {
    const index = row.tradingsymbol as IndexOptionName;
    if (!input.indexes.includes(index)) {
      continue;
    }
    const own = contracts.filter((contract) => contract.name === index);
    const expiry = chooseTradingExpiry(
      own.map((contract) => contract.expiry),
      date,
      MIN_DAYS_TO_EXPIRY,
    );
    if (!expiry) {
      gaps.push(`${index} options: no listed expiry after ${date}`);
      continue;
    }
    if (calendarDays(date, expiry) > WEEKLY_EXPIRY_MAX_DAYS) {
      gaps.push(
        `${index} options: nearest listed expiry ${expiry} used; contracts that expired since ${date} have no history`,
      );
    }
    const bars = spotBars.get(index) ?? [];
    const low = Math.min(...bars.map((bar) => bar.l));
    const high = Math.max(...bars.map((bar) => bar.h));
    const min = atmStrike(low, row.strikeStep) - CHAIN_WINGS * row.strikeStep;
    const max = atmStrike(high, row.strikeStep) + CHAIN_WINGS * row.strikeStep;
    for (const contract of own) {
      if (contract.expiry === expiry && contract.strike >= min && contract.strike <= max) {
        await record(`NFO:${contract.tradingsymbol}`, contract.instrumentToken, {
          oi: true,
          option: true,
        });
      }
    }
  }
  const optionSeries = series.filter((item) => item.option);
  if (optionSeries.length > 0 && optionSeries.every((item) => item.minuteBars.length === 0)) {
    gaps.push(`no option history for ${date}; every cycle will find no liquid contract`);
  }

  let headlines: SymbolNews[] = [];
  try {
    headlines = await input.news.fetchIndexNewsOn(
      [
        ...underlyings
          .filter((row) => input.indexes.includes(row.tradingsymbol as IndexOptionName))
          .map((row) => ({ symbol: row.tradingsymbol, query: row.googleQuery })),
        ...MACRO_QUERIES,
      ],
      date,
    );
  } catch (error: unknown) {
    input.logger.warn({ err: error }, 'Simulation: headline search failed.');
    gaps.push('headlines unavailable');
  }

  input.logger.info(
    { date, indexes: input.indexes, series: series.length, dataGaps: gaps },
    'Simulation: recorded market day.',
  );
  return {
    version: RECORDING_VERSION,
    date,
    indexes: [...input.indexes],
    recordedAt: new Date().toISOString(),
    instruments: { NFO: nfoRows, CDS: cdsRows, MCX: mcxRows },
    series,
    fiveMinuteBars,
    dailyBars,
    headlines,
    dataGaps: gaps,
  };
}
