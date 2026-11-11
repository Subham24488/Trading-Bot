import type { InstrumentExchange, MarketQuote } from '../broker/KiteBroker.js';
import { config } from '../config.js';
import { loadIndexUnderlyings, type IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import type { MarketDataBroker } from '../llm/LlmTradeAdvisorService.js';
import type { NewsService, SymbolNews } from '../news/NewsService.js';
import {
  filterNearestWeeklyAtmBand,
  parseNfoIndexOptions,
  type KiteRawInstrument,
  type NfoOptionContract,
} from '../options/nfoChain.js';
import type { DailyBar, IntradayBar } from '../universe/types.js';
import type { MarketRecording, RecordedSeries } from './marketRecorder.js';

/** Median spread of the option candidates stored with live BUYs (0.06–0.35%, 102 rows). */
export const SIMULATED_SPREAD_PCT = 0.25;

const MINUTE_MS = 60_000;

/** The simulator's clock: the replayed service reads `now`, the replay loop moves it forward. */
export class SimulationClock {
  private at: number;

  public constructor(start: Date) {
    this.at = start.getTime();
  }

  public readonly now = (): Date => new Date(this.at);

  public readonly advanceTo = (at: Date): void => {
    this.at = Math.max(this.at, at.getTime());
  };
}

/** `YYYY-MM-DD HH:mm:ss` IST wall clock (Kite's history format) to an instant. */
function fromIstWallClock(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}+05:30`);
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

type ReplaySeries = RecordedSeries & {
  /** Bar end times, and running volume and price × volume through each bar. */
  ends: number[];
  cumVolume: number[];
  cumValue: number[];
};

function prepare(series: RecordedSeries): ReplaySeries {
  const bars = [...series.minuteBars].sort(
    (left, right) => Date.parse(left.t) - Date.parse(right.t),
  );
  const ends: number[] = [];
  const cumVolume: number[] = [];
  const cumValue: number[] = [];
  let volume = 0;
  let value = 0;
  for (const bar of bars) {
    volume += bar.v;
    value += ((bar.h + bar.l + bar.c) / 3) * bar.v;
    ends.push(Date.parse(bar.t) + MINUTE_MS);
    cumVolume.push(volume);
    cumValue.push(value);
  }
  return { ...series, minuteBars: bars, ends, cumVolume, cumValue };
}

/** Index of the last bar that finished at or before `nowMs`, or -1. */
function lastFinished(series: ReplaySeries, nowMs: number): number {
  let low = 0;
  let high = series.ends.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (series.ends[middle]! <= nowMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Serves a recorded day through the same read-only Kite calls LiveMarketFeed makes, as of the
 * simulator's clock: a quote is the last 1-minute bar that had finished, so nothing later leaks.
 */
export class ReplayBroker implements MarketDataBroker {
  private readonly recording: MarketRecording;
  private readonly now: () => Date;
  private readonly series: Map<string, ReplaySeries>;

  public constructor(recording: MarketRecording, now: () => Date) {
    this.recording = recording;
    this.now = now;
    this.series = new Map(
      recording.series.map((item) => [item.key.toUpperCase(), prepare(item)] as const),
    );
  }

  public getQuotes(keys: readonly string[]): Promise<Record<string, MarketQuote>> {
    const nowMs = this.now().getTime();
    const out: Record<string, MarketQuote> = {};
    for (const key of keys) {
      const series = this.series.get(key.toUpperCase());
      const at = series ? lastFinished(series, nowMs) : -1;
      if (!series || at < 0) {
        continue;
      }
      const bar = series.minuteBars[at]!;
      const volume = series.cumVolume[at]!;
      const halfSpread = SIMULATED_SPREAD_PCT / 200;
      out[key] = {
        lastPrice: bar.c,
        volume,
        oi: bar.oi ?? 0,
        open: series.minuteBars[0]!.o,
        prevClose: series.prevClose,
        vwap: volume > 0 ? round(series.cumValue[at]! / volume) : null,
        bid: series.option ? round(bar.c * (1 - halfSpread)) : null,
        ask: series.option ? round(bar.c * (1 + halfSpread)) : null,
      };
    }
    return Promise.resolve(out);
  }

  public getDayInstruments(exchange: InstrumentExchange): Promise<KiteRawInstrument[]> {
    return Promise.resolve(this.recording.instruments[exchange] ?? []);
  }

  public getFiveMinuteCandles(
    instrumentToken: number,
    fromIst: string,
    toIst: string,
  ): Promise<IntradayBar[]> {
    const from = fromIstWallClock(fromIst);
    const to = Math.min(fromIstWallClock(toIst), this.now().getTime());
    const bars = this.recording.fiveMinuteBars[String(instrumentToken)] ?? [];
    return Promise.resolve(
      bars.filter((bar) => {
        const start = Date.parse(bar.t);
        return start >= from && start <= to;
      }),
    );
  }

  public getDailyCandles(
    instrumentToken: number,
    fromYmd: string,
    toYmd: string,
  ): Promise<DailyBar[]> {
    const bars = this.recording.dailyBars[String(instrumentToken)] ?? [];
    return Promise.resolve(bars.filter((bar) => bar.d >= fromYmd && bar.d <= toYmd));
  }

  public getNfoIndexOptions(input: {
    names?: readonly IndexOptionName[];
    spots: Partial<Record<IndexOptionName, number>>;
    asOfYmd?: string;
  }): Promise<NfoOptionContract[]> {
    const contracts = parseNfoIndexOptions(this.recording.instruments.NFO, input.names);
    const steps = Object.fromEntries(
      loadIndexUnderlyings().map((row) => [row.tradingsymbol, row.strikeStep]),
    ) as Partial<Record<IndexOptionName, number>>;
    return Promise.resolve(
      filterNearestWeeklyAtmBand(
        contracts,
        input.spots,
        steps,
        input.asOfYmd ?? this.recording.date,
      ),
    );
  }
}

/** Recorded headlines as of the simulator's clock; items without a time are dropped. */
export class ReplayHeadlines implements Pick<NewsService, 'fetchIndexNews' | 'fetchNewsForRange'> {
  private readonly headlines: SymbolNews[];
  private readonly now: () => Date;

  public constructor(recording: MarketRecording, now: () => Date) {
    this.headlines = recording.headlines;
    this.now = now;
  }

  public fetchIndexNews(
    queries: readonly { symbol: string; query: string }[],
    from: Date,
    to: Date,
  ): Promise<SymbolNews[]> {
    const until = Math.min(to.getTime(), this.now().getTime());
    return Promise.resolve(
      queries.map((query) => {
        const symbol = query.symbol.toUpperCase();
        const items = (this.headlines.find((entry) => entry.symbol === symbol)?.items ?? [])
          .map((item) => ({
            item,
            at: item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN,
          }))
          .filter(({ at }) => Number.isFinite(at) && at >= from.getTime() && at <= until)
          .sort((left, right) => right.at - left.at)
          .slice(0, config.llm.newsItemsPerSymbol)
          .map(({ item }) => item);
        return { symbol, items };
      }),
    );
  }

  public fetchNewsForRange(): Promise<never> {
    return Promise.reject(new Error('Stock news is not part of a simulated options replay.'));
  }
}
