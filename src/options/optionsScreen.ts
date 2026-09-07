import type { SessionInstrument } from '../domain.js';
import type { IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import { computeFeatures } from '../universe/features.js';
import type { DailyBar, UniverseCandidate } from '../universe/types.js';
import type { NewsItem } from '../news/NewsService.js';
import { classifyFilingKind } from '../llm/prompts.js';
import { MAX_ATR_PCT_FOR_BUY } from '../llm/tradePlaybook.js';
import type { NfoOptionContract } from './nfoChain.js';
import { atmStrike } from './nfoChain.js';

export const OPTIONS_MAX_INCLUDES = 1;
export const OPTIONS_MAX_PER_INDEX = 2;
export const OPTIONS_MIN_OI = 10_000;

export type OptionQuote = {
  lastPrice: number | null;
  volume: number;
  oi: number;
};

export type IndexOptionBias = {
  index: IndexOptionName;
  side: 'CE' | 'PE' | null;
  sma20: number | null;
  sma50: number | null;
  ret20Pct: number | null;
  atrPct: number | null;
  failReasons: string[];
};

export type OptionScreenRow = {
  symbol: string;
  index: IndexOptionName;
  side: 'CE' | 'PE';
  strike: number;
  expiry: string;
  instrumentToken: number;
  ltp: number | null;
  oi: number;
  volume: number;
  score: number;
  pass: boolean;
  failReasons: string[];
  features: UniverseCandidate['features'];
  filings: UniverseCandidate['filings'];
};

export function indexOptionBias(index: IndexOptionName, bars: DailyBar[]): IndexOptionBias {
  const features = computeFeatures(bars, [], bars);
  const failReasons: string[] = [];
  const smaUp = features.sma20 !== null && features.sma50 !== null && features.sma20 > features.sma50;
  const smaDown = features.sma20 !== null && features.sma50 !== null && features.sma20 < features.sma50;
  const retUp = features.ret20Pct !== null && features.ret20Pct > 0;
  const retDown = features.ret20Pct !== null && features.ret20Pct < 0;
  const atrOk = features.atrPct === null || features.atrPct < MAX_ATR_PCT_FOR_BUY;

  if (features.sma20 === null || features.sma50 === null) {
    failReasons.push('need SMA20/SMA50');
  }
  if (features.ret20Pct === null) {
    failReasons.push('need 20d return');
  }
  if (!atrOk) {
    failReasons.push('ATR% too high');
  }

  let side: 'CE' | 'PE' | null = null;
  if (atrOk && smaUp && retUp) {
    side = 'CE';
  } else if (atrOk && smaDown && retDown) {
    side = 'PE';
  } else if (atrOk && smaUp) {
    side = 'CE';
  } else if (atrOk && smaDown) {
    side = 'PE';
  } else if (failReasons.length === 0) {
    failReasons.push('mixed trend; skip index');
  }

  return {
    index,
    side,
    sma20: features.sma20,
    sma50: features.sma50,
    ret20Pct: features.ret20Pct,
    atrPct: features.atrPct,
    failReasons,
  };
}

function strikePreference(side: 'CE' | 'PE', strike: number, atm: number, step: number): number {
  if (strike === atm) {
    return 2;
  }
  if (side === 'CE' && strike === atm + step) {
    return 1.5;
  }
  if (side === 'PE' && strike === atm - step) {
    return 1.5;
  }
  return 0.4;
}

function compactFilings(items: readonly NewsItem[]): UniverseCandidate['filings'] {
  return items.slice(0, 6).map((item) => ({
    k: classifyFilingKind(item.title),
    d: item.publishedAt?.slice(0, 10) ?? '',
    t: item.title.slice(0, 80),
    src: item.source,
  }));
}

export function screenIndexOptions(input: {
  contracts: readonly NfoOptionContract[];
  quotes: Record<string, OptionQuote>;
  biases: readonly IndexOptionBias[];
  spots: Partial<Record<IndexOptionName, number>>;
  steps: Partial<Record<IndexOptionName, number>>;
  newsByIndex: Record<string, NewsItem[]>;
  indexFeatures: Record<string, UniverseCandidate['features']>;
}): OptionScreenRow[] {
  const biasByIndex = new Map(input.biases.map((bias) => [bias.index, bias]));
  const rows: OptionScreenRow[] = [];

  for (const contract of input.contracts) {
    const bias = biasByIndex.get(contract.name);
    const failReasons: string[] = [...(bias?.failReasons ?? [])];
    if (!bias?.side) {
      failReasons.push('no directional bias');
    } else if (contract.instrumentType !== bias.side) {
      failReasons.push(`bias is ${bias.side}`);
    }

    const quote = input.quotes[contract.tradingsymbol];
    const oi = quote?.oi ?? 0;
    const volume = quote?.volume ?? 0;
    const ltp = quote?.lastPrice ?? null;
    if (quote && oi > 0 && oi < OPTIONS_MIN_OI) {
      failReasons.push('dead OI');
    }

    const step = input.steps[contract.name];
    const spot = input.spots[contract.name];
    const atm = spot !== undefined && step !== undefined ? atmStrike(spot, step) : contract.strike;
    const pref = step ? strikePreference(contract.instrumentType, contract.strike, atm, step) : 1;
    const liq = Math.log10(Math.max(oi, 1) * Math.max(volume, 1));
    const score = pref * 10 + liq;
    const pass = failReasons.length === 0 && pref >= 1.5;

    rows.push({
      symbol: contract.tradingsymbol,
      index: contract.name,
      side: contract.instrumentType,
      strike: contract.strike,
      expiry: contract.expiry,
      instrumentToken: contract.instrumentToken,
      ltp,
      oi,
      volume,
      score: Number(score.toFixed(3)),
      pass,
      failReasons,
      features: input.indexFeatures[contract.name] ?? {
        sma20: bias?.sma20 ?? null,
        sma50: bias?.sma50 ?? null,
        atrPct: bias?.atrPct ?? null,
        rsNifty20: null,
        volVs20: null,
        distFrom20HighPct: null,
        ret20Pct: bias?.ret20Pct ?? null,
        eventScore: 0,
        score: 0,
      },
      filings: compactFilings(input.newsByIndex[contract.name] ?? []),
    });
  }

  return rows.sort((left, right) => right.score - left.score);
}

export function pickOptionContracts(
  rows: readonly OptionScreenRow[],
  maxInclude = OPTIONS_MAX_INCLUDES,
  maxPerIndex = OPTIONS_MAX_PER_INDEX,
): OptionScreenRow[] {
  const picked: OptionScreenRow[] = [];
  const perIndex = new Map<IndexOptionName, number>();
  for (const row of rows) {
    if (!row.pass) {
      continue;
    }
    const used = perIndex.get(row.index) ?? 0;
    if (used >= maxPerIndex || picked.length >= maxInclude) {
      continue;
    }
    picked.push(row);
    perIndex.set(row.index, used + 1);
  }
  return picked;
}

export function toSessionInstruments(rows: readonly OptionScreenRow[]): SessionInstrument[] {
  return rows.map((row) => ({
    instrumentToken: row.instrumentToken,
    exchange: 'NFO',
    tradingsymbol: row.symbol,
  }));
}

export function toUniverseCandidates(rows: readonly OptionScreenRow[]): UniverseCandidate[] {
  return rows.map((row) => ({
    symbol: row.symbol,
    score: row.score,
    pass: row.pass,
    failReasons: row.failReasons,
    momRiskAdj: row.score,
    features: row.features,
    filings: row.filings,
  }));
}
