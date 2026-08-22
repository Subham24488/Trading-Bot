import type { FilingKind } from '../llm/prompts.js';
import { classifyFilingKind, kindWeight } from '../llm/prompts.js';
import type { NewsItem } from '../news/NewsService.js';
import type { DailyBar, FeatureSnapshot, SymbolKnowledge, UniverseCandidate } from './types.js';

const BENCHMARK = 'NIFTYBEES';
const EXCLUDE_FROM_PICKS = new Set(['NIFTYBEES', 'LIQUIDBEES']);

function sma(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function atrPct(bars: DailyBar[], period = 14): number | null {
  if (bars.length < period + 1) {
    return null;
  }
  const trs: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index]!;
    const previous = bars[index - 1]!;
    const tr = Math.max(
      current.h - current.l,
      Math.abs(current.h - previous.c),
      Math.abs(current.l - previous.c),
    );
    trs.push(tr);
  }
  const average = sma(trs, period);
  const lastClose = bars[bars.length - 1]?.c;
  if (average === null || !lastClose) {
    return null;
  }
  return (average / lastClose) * 100;
}

function returnPct(bars: DailyBar[], lookback: number): number | null {
  if (bars.length < lookback + 1) {
    return null;
  }
  const last = bars[bars.length - 1]!.c;
  const prior = bars[bars.length - 1 - lookback]!.c;
  if (prior === 0) {
    return null;
  }
  return ((last - prior) / prior) * 100;
}

export function eventScore(filings: readonly NewsItem[]): number {
  let best = 0;
  for (const item of filings) {
    const kind: FilingKind = classifyFilingKind(item.title);
    let weight = kindWeight(kind);
    if (/incorporat|ifsc private|holding llp|newspaper clipping/i.test(item.title)) {
      weight = Math.min(weight, 2);
    }
    best = Math.max(best, weight);
  }
  return best;
}

export function computeFeatures(
  bars: DailyBar[],
  filings: readonly NewsItem[],
  niftyBars: DailyBar[],
): FeatureSnapshot {
  const closes = bars.map((bar) => bar.c);
  const volumes = bars.map((bar) => bar.v);
  const highs = bars.map((bar) => bar.h);
  const ret20 = returnPct(bars, 20);
  const niftyRet20 = returnPct(niftyBars, 20);
  const rsNifty20 = ret20 !== null && niftyRet20 !== null ? ret20 - niftyRet20 : null;
  const last = bars[bars.length - 1];
  const high20 = highs.length >= 20 ? Math.max(...highs.slice(-20)) : null;
  const vol20 = sma(volumes, 20);
  const events = eventScore(filings);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const volVs20 = last && vol20 ? last.v / vol20 : null;
  const distFrom20HighPct = last && high20 ? ((last.c / high20 - 1) * 100) : null;

  let score = events;
  if (rsNifty20 !== null) {
    score += rsNifty20;
  }
  if (sma20 !== null && sma50 !== null) {
    score += sma20 > sma50 ? 8 : -6;
  }
  if (volVs20 !== null && volVs20 < 0.3) {
    score -= 40;
  } else if (volVs20 !== null) {
    score += Math.min(volVs20, 2) * 3;
  }
  if (distFrom20HighPct !== null && distFrom20HighPct > -8) {
    score += 4;
  }

  return {
    sma20,
    sma50,
    atrPct: atrPct(bars),
    rsNifty20,
    volVs20,
    distFrom20HighPct,
    ret20Pct: ret20,
    eventScore: events,
    score: Number(score.toFixed(3)),
  };
}

export function attachFeatures(symbols: Record<string, SymbolKnowledge>): Record<string, SymbolKnowledge> {
  const nifty = symbols[BENCHMARK]?.bars ?? [];
  const next: Record<string, SymbolKnowledge> = {};
  for (const [symbol, knowledge] of Object.entries(symbols)) {
    next[symbol] = {
      ...knowledge,
      features: computeFeatures(knowledge.bars, knowledge.filings, nifty),
    };
  }
  return next;
}

export function rankCandidates(symbols: Record<string, SymbolKnowledge>, limit = 8): UniverseCandidate[] {
  const ranked = Object.values(symbols)
    .filter((knowledge) => !EXCLUDE_FROM_PICKS.has(knowledge.symbol))
    .filter((knowledge) => knowledge.features && (knowledge.features.volVs20 === null || knowledge.features.volVs20 >= 0.3))
    .sort((left, right) => (right.features?.score ?? 0) - (left.features?.score ?? 0))
    .slice(0, limit);

  return ranked.map((knowledge) => ({
    symbol: knowledge.symbol,
    score: knowledge.features?.score ?? 0,
    features: knowledge.features ?? computeFeatures(knowledge.bars, knowledge.filings, symbols[BENCHMARK]?.bars ?? []),
    filings: knowledge.filings.slice(0, 2).map((item) => ({
      k: classifyFilingKind(item.title),
      d: item.publishedAt ?? '',
      t: item.title.replace(/\s+/g, ' ').trim().slice(0, 160),
      src: item.source.includes('nse') ? 'nse' : 'g',
    })),
  }));
}
