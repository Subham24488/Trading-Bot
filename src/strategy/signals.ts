import type { IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import type { OptionNewsRiskLevel } from '../options/greeksIv.js';
import { atmStrike } from '../options/nfoChain.js';
import type { IntradayBar } from '../universe/types.js';
import { istClock } from './clock.js';
import type { ChainQuote } from './contracts.js';
import {
  barsOnDay,
  classifyLastCandles,
  ema,
  median,
  openingRange,
  pctChange,
  rsi,
  type CandlePatternName,
  type OptionSide,
} from './indicators.js';
import type { SignalThresholds, StrategyParams } from './params.js';

export type Vote = -1 | 0 | 1;

export const SIGNAL_NAMES = [
  'averagePrice',
  'trend',
  'openingRange',
  'futuresPositioning',
  'optionFlow',
  'volume',
  'breadth',
  'globalMood',
] as const;

export type SignalName = (typeof SIGNAL_NAMES)[number];

/** One vote toward calls (+1) or puts (−1), with the reason in everyday words. */
export type Signal = { name: SignalName; vote: Vote; plain: string };

export type IndexMarketData = {
  index: IndexOptionName;
  spot: number | null;
  step: number;
  /** The near-month futures contract; SKIP rows are stored under it. */
  futures: { symbol: string; token: number } | null;
  futuresPrice: number | null;
  futuresVwap: number | null;
  /** Completed 5-minute futures bars over several days, oldest first, with open interest. */
  futuresBars: IntradayBar[];
  chain: ChainQuote[];
  expiryToday: boolean;
  newsLevel: OptionNewsRiskLevel;
};

export type MarketBackdrop = {
  vixPct: number | null;
  usdInrPct: number | null;
  crudePct: number | null;
  gapPct: number | null;
  advancersPct: number | null;
  headlineTone: number;
};

export type IndexReading = {
  index: IndexOptionName;
  score: number;
  votes: Record<SignalName, Vote>;
  signals: Signal[];
  rsi: number | null;
  lastCandle: { pattern: CandlePatternName; side: OptionSide | null };
  spot: number | null;
  futuresPrice: number | null;
  vwap: number | null;
  /** Strike above the price with the most call open interest (a likely ceiling). */
  callWall: number | null;
  /** Strike below the price with the most put open interest (a likely floor). */
  putWall: number | null;
  pcr: number | null;
  expiryToday: boolean;
  newsLevel: OptionNewsRiskLevel;
  /** Futures quote, enough futures bars and an option chain are all present. */
  coreDataOk: boolean;
};

const EMA_FAST = 9;
const EMA_SLOW = 21;
const OPENING_RANGE_END_MINUTE = 9 * 60 + 30;

function signal(name: SignalName, vote: Vote, plain: string): Signal {
  return { name, vote, plain };
}

function averagePriceSignal(data: IndexMarketData, thresholds: SignalThresholds): Signal {
  const gap = pctChange(data.futuresVwap, data.futuresPrice);
  if (gap === null) {
    return signal('averagePrice', 0, `today's average price for ${data.index} is not available`);
  }
  if (gap > thresholds.vwapBandPct) {
    return signal('averagePrice', 1, `${data.index} is trading above today's average price`);
  }
  if (gap < -thresholds.vwapBandPct) {
    return signal('averagePrice', -1, `${data.index} is trading below today's average price`);
  }
  return signal('averagePrice', 0, `${data.index} is hovering around today's average price`);
}

function trendSignal(closes: readonly number[]): Signal {
  const fast = ema(closes, EMA_FAST);
  const slow = ema(closes, EMA_SLOW);
  if (fast === null || slow === null) {
    return signal('trend', 0, 'there is not enough recent price history to read the trend');
  }
  if (fast > slow) {
    return signal('trend', 1, 'the short-term trend is up');
  }
  if (fast < slow) {
    return signal('trend', -1, 'the short-term trend is down');
  }
  return signal('trend', 0, 'the short-term trend is flat');
}

function openingRangeSignal(
  index: IndexOptionName,
  todayBars: readonly IntradayBar[],
  price: number | null,
): Signal {
  const range = openingRange(todayBars);
  if (!range || price === null) {
    return signal('openingRange', 0, 'the first 15 minutes of trading are not complete yet');
  }
  if (price > range.high) {
    return signal('openingRange', 1, `${index} has broken above its first-15-minute high`);
  }
  if (price < range.low) {
    return signal('openingRange', -1, `${index} has broken below its first-15-minute low`);
  }
  return signal('openingRange', 0, `${index} is still inside its first-15-minute range`);
}

function positioningSignal(
  todayBars: readonly IntradayBar[],
  thresholds: SignalThresholds,
): Signal {
  const withOi = todayBars.filter((bar) => bar.oi !== undefined);
  const span = Math.min(thresholds.positioningBars, withOi.length - 1);
  if (span < 3) {
    return signal('futuresPositioning', 0, 'there is not enough futures position data yet today');
  }
  const latest = withOi.at(-1)!;
  const earlier = withOi.at(-1 - span)!;
  const priceChange = pctChange(earlier.c, latest.c);
  const oiChange = pctChange(earlier.oi ?? null, latest.oi ?? null);
  if (priceChange === null || oiChange === null) {
    return signal('futuresPositioning', 0, 'futures position data is incomplete');
  }
  const priceMoved = Math.abs(priceChange) >= thresholds.futuresPriceChangePct;
  if (priceMoved && oiChange >= thresholds.futuresOiChangePct) {
    return priceChange > 0
      ? signal('futuresPositioning', 1, 'big traders are adding fresh buying positions in futures')
      : signal(
          'futuresPositioning',
          -1,
          'big traders are adding fresh selling positions in futures',
        );
  }
  if (priceMoved && oiChange <= -thresholds.futuresOiChangePct) {
    return priceChange > 0
      ? signal(
          'futuresPositioning',
          0,
          'the rise comes from sellers closing bets, not fresh buying',
        )
      : signal(
          'futuresPositioning',
          0,
          'the fall comes from buyers closing bets, not fresh selling',
        );
  }
  return signal('futuresPositioning', 0, 'futures positions are steady');
}

function optionFlowSignal(data: IndexMarketData, thresholds: SignalThresholds): Signal {
  if (data.spot === null) {
    return signal('optionFlow', 0, 'option data is not available');
  }
  const atm = atmStrike(data.spot, data.step);
  const band = data.chain.filter(
    (row) =>
      row.oiChangeToday !== null &&
      Math.abs(row.strike - atm) <= thresholds.optionFlowStrikes * data.step,
  );
  const totalOi = band.reduce((sum, row) => sum + row.oi, 0);
  if (band.length === 0 || totalOi <= 0) {
    return signal('optionFlow', 0, 'there is not enough option data yet today');
  }
  const added = (side: OptionSide) =>
    band.filter((row) => row.side === side).reduce((sum, row) => sum + (row.oiChangeToday ?? 0), 0);
  const flowPct = ((added('PE') - added('CE')) / totalOi) * 100;
  if (flowPct >= thresholds.optionFlowPct) {
    return signal('optionFlow', 1, 'option sellers are betting the market will not fall much');
  }
  if (flowPct <= -thresholds.optionFlowPct) {
    return signal('optionFlow', -1, 'option sellers are betting the market will not rise much');
  }
  return signal('optionFlow', 0, 'option sellers are not leaning either way');
}

function volumeSignal(
  todayBars: readonly IntradayBar[],
  minute: number,
  thresholds: SignalThresholds,
): Signal {
  if (minute < thresholds.volumeValidFromMinute) {
    return signal('volume', 0, 'it is too early in the day to judge trading volume');
  }
  const afterOpen = todayBars.filter(
    (bar) => istClock(new Date(bar.t)).minute >= OPENING_RANGE_END_MINUTE,
  );
  if (afterOpen.length < 6) {
    return signal('volume', 0, 'there is not enough trading volume data yet');
  }
  const recent = afterOpen.slice(-3);
  const typical = median(afterOpen.slice(0, -3).map((bar) => bar.v));
  const recentAverage = recent.reduce((sum, bar) => sum + bar.v, 0) / recent.length;
  const move = recent.at(-1)!.c - recent[0]!.o;
  if (typical && recentAverage >= thresholds.volumeSurgeMultiple * typical && move !== 0) {
    return move > 0
      ? signal('volume', 1, 'buying volume has picked up sharply')
      : signal('volume', -1, 'selling volume has picked up sharply');
  }
  return signal('volume', 0, 'trading volume is normal');
}

function breadthSignal(advancersPct: number | null, thresholds: SignalThresholds): Signal {
  if (advancersPct === null) {
    return signal('breadth', 0, 'the share of large stocks moving up is not available');
  }
  const share = Math.round(advancersPct);
  if (advancersPct >= thresholds.breadthUpPct) {
    return signal('breadth', 1, `${share}% of large stocks are up today`);
  }
  if (advancersPct <= thresholds.breadthDownPct) {
    return signal('breadth', -1, `only ${share}% of large stocks are up today`);
  }
  return signal('breadth', 0, `large stocks are mixed today (${share}% up)`);
}

function formatMove(value: number): string {
  return `${Math.abs(value).toFixed(1)}%`;
}

export function globalMoodSignal(backdrop: MarketBackdrop, thresholds: SignalThresholds): Signal {
  const positive: string[] = [];
  const negative: string[] = [];
  const { vixPct, usdInrPct, crudePct, gapPct, headlineTone } = backdrop;
  if (vixPct !== null && vixPct <= -thresholds.vixMovePct) {
    positive.push(`the fear index (India VIX) is down ${formatMove(vixPct)}`);
  } else if (vixPct !== null && vixPct >= thresholds.vixMovePct) {
    negative.push(`the fear index (India VIX) is up ${formatMove(vixPct)}`);
  }
  if (usdInrPct !== null && usdInrPct <= -thresholds.usdInrMovePct) {
    positive.push('the rupee is stronger against the dollar');
  } else if (usdInrPct !== null && usdInrPct >= thresholds.usdInrMovePct) {
    negative.push('the rupee is weaker against the dollar');
  }
  if (crudePct !== null && crudePct <= -thresholds.crudeMovePct) {
    positive.push(`crude oil is down ${formatMove(crudePct)}`);
  } else if (crudePct !== null && crudePct >= thresholds.crudeMovePct) {
    negative.push(`crude oil is up ${formatMove(crudePct)}`);
  }
  if (gapPct !== null && gapPct >= thresholds.gapPct) {
    positive.push(`the market opened ${formatMove(gapPct)} higher on overnight global moves`);
  } else if (gapPct !== null && gapPct <= -thresholds.gapPct) {
    negative.push(`the market opened ${formatMove(gapPct)} lower on overnight global moves`);
  }
  if (headlineTone >= thresholds.headlineTone) {
    positive.push('global news headlines are upbeat');
  } else if (headlineTone <= -thresholds.headlineTone) {
    negative.push('global news headlines are gloomy');
  }
  if (positive.length >= 2 && positive.length > negative.length) {
    return signal('globalMood', 1, `global mood is positive: ${positive.join(', ')}`);
  }
  if (negative.length >= 2 && negative.length > positive.length) {
    return signal('globalMood', -1, `global mood is negative: ${negative.join(', ')}`);
  }
  return signal('globalMood', 0, 'global mood is calm or mixed');
}

/**
 * Walls are the strikes with the most open interest on each side of spot. A strike within
 * `bufferPct` on the far side still counts, so a wall does not vanish when spot ticks
 * through it (spot 22,598.6 under a 22,600 put wall is still at that wall).
 */
function optionLevels(chain: readonly ChainQuote[], spot: number | null, bufferPct: number) {
  const strikeWithMostOi = (rows: readonly ChainQuote[]) =>
    rows.reduce<ChainQuote | null>((best, row) => (best && best.oi >= row.oi ? best : row), null)
      ?.strike ?? null;
  const callOi = chain.filter((row) => row.side === 'CE').reduce((sum, row) => sum + row.oi, 0);
  const putOi = chain.filter((row) => row.side === 'PE').reduce((sum, row) => sum + row.oi, 0);
  const buffer = spot === null ? 0 : (spot * bufferPct) / 100;
  return {
    callWall:
      spot === null
        ? null
        : strikeWithMostOi(
            chain.filter((row) => row.side === 'CE' && row.strike > spot - buffer),
          ),
    putWall:
      spot === null
        ? null
        : strikeWithMostOi(
            chain.filter((row) => row.side === 'PE' && row.strike < spot + buffer),
          ),
    pcr: callOi > 0 ? Number((putOi / callOi).toFixed(3)) : null,
  };
}

/** Reads one index into eight votes plus the extra facts the entry gates need. */
export function readIndex(
  data: IndexMarketData,
  backdrop: MarketBackdrop,
  params: StrategyParams,
  now: Date,
): IndexReading {
  const clock = istClock(now);
  const thresholds = params.signals;
  const closes = data.futuresBars.map((bar) => bar.c);
  const todayBars = barsOnDay(data.futuresBars, clock.ymd);
  const signals = [
    averagePriceSignal(data, thresholds),
    trendSignal(closes),
    openingRangeSignal(data.index, todayBars, data.futuresPrice),
    positioningSignal(todayBars, thresholds),
    optionFlowSignal(data, thresholds),
    volumeSignal(todayBars, clock.minute, thresholds),
    breadthSignal(backdrop.advancersPct, thresholds),
    globalMoodSignal(backdrop, thresholds),
  ];
  const votes = Object.fromEntries(signals.map((item) => [item.name, item.vote])) as Record<
    SignalName,
    Vote
  >;
  const levels = optionLevels(data.chain, data.spot, params.bigLevelBufferPct);
  return {
    index: data.index,
    score: signals.reduce((sum, item) => sum + item.vote, 0),
    votes,
    signals,
    rsi: rsi(closes),
    lastCandle: classifyLastCandles(data.futuresBars.slice(-3)),
    spot: data.spot,
    futuresPrice: data.futuresPrice,
    vwap: data.futuresVwap,
    ...levels,
    expiryToday: data.expiryToday,
    newsLevel: data.newsLevel,
    coreDataOk:
      data.spot !== null &&
      data.futuresPrice !== null &&
      data.futuresVwap !== null &&
      closes.length >= EMA_SLOW &&
      data.chain.length > 0,
  };
}

const UPBEAT_WORDS =
  /\b(rall(y|ies|ied)|surg(e|es|ed)|gains?|jump(s|ed)?|record high|rebound(s|ed)?|recover(y|s|ed)|optimism|rate cut|stimulus|upbeat|soar(s|ed)?|eases?|cools?)\b/i;
const GLOOMY_WORDS =
  /\b(slump(s|ed)?|plung(e|es|ed)|crash(es|ed)?|sell-?off|tumbl(e|es|ed)|slid(e|es)|fears?|worr(y|ies|ied)|tensions?|war|sanctions?|tariffs?|recession|rate hike|hawkish|downgrade[sd]?|sinks?|falls?|drops?)\b/i;

/** Net tone of macro headlines: +1 per upbeat headline, −1 per gloomy one. */
export function headlineTone(titles: readonly string[]): number {
  return titles.reduce((sum, title) => {
    const upbeat = UPBEAT_WORDS.test(title);
    const gloomy = GLOOMY_WORDS.test(title);
    return sum + (upbeat === gloomy ? 0 : upbeat ? 1 : -1);
  }, 0);
}
