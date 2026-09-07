import { MAX_ATR_PCT_FOR_BUY, MAX_DIST_FROM_20_HIGH_PCT, MIN_VOL_VS_20_FOR_BUY } from '../llm/tradePlaybook.js';
import { classifyFilingKind } from '../llm/prompts.js';
import { UNIVERSE_MIN_BARS_FOR_MOMENTUM } from './dates.js';
import { computeFeatures } from './features.js';
import type { DailyBar, SymbolKnowledge, UniverseCandidate } from './types.js';

const BENCHMARK = 'NIFTYBEES';
const EXCLUDE_FROM_PICKS = new Set(['NIFTYBEES', 'LIQUIDBEES']);
const CORRELATION_MAX = 0.85;
export const UNIVERSE_MAX_INCLUDES = 1;
export const UNIVERSE_LLM_CANDIDATES = 12;

/**
 * 09:00 universe screen (Kite dailies + filings only).
 * Risk-adjusted momentum follows JPM Diversified Factor Equity: return / vol of daily returns.
 * Quality/value fundamentals are not on Kite; eventScore is the overlay.
 */

export function dailyCloseReturns(bars: readonly DailyBar[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1]!.c;
    const current = bars[index]!.c;
    if (previous !== 0) {
      out.push((current - previous) / previous);
    }
  }
  return out;
}

export function stdev(values: readonly number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function pearson(left: readonly number[], right: readonly number[]): number | null {
  const n = Math.min(left.length, right.length);
  if (n < 5) {
    return null;
  }
  const a = left.slice(-n);
  const b = right.slice(-n);
  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let index = 0; index < n; index += 1) {
    const da = a[index]! - meanA;
    const db = b[index]! - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den === 0) {
    return 1;
  }
  return num / den;
}

export function momRiskAdj(bars: DailyBar[]): number | null {
  const lookback = bars.length >= UNIVERSE_MIN_BARS_FOR_MOMENTUM + 1 ? 200 : bars.length >= 61 ? 60 : null;
  if (lookback === null) {
    return null;
  }
  const window = bars.slice(-(lookback + 1));
  const first = window[0]!.c;
  const last = window[window.length - 1]!.c;
  if (first === 0) {
    return null;
  }
  const ret = (last - first) / first;
  const vol = stdev(dailyCloseReturns(window));
  if (vol === null || vol === 0) {
    return null;
  }
  return Number((ret / vol).toFixed(4));
}

function filingsForPrompt(knowledge: SymbolKnowledge): UniverseCandidate['filings'] {
  return knowledge.filings.slice(0, 2).map((item) => ({
    k: classifyFilingKind(item.title),
    d: item.publishedAt ?? '',
    t: item.title.replace(/\s+/g, ' ').trim().slice(0, 160),
    src: item.source.includes('nse') ? 'nse' : 'g',
  }));
}

export function evaluateUniversePass(knowledge: SymbolKnowledge): {
  pass: boolean;
  failReasons: string[];
  momRiskAdj: number | null;
  score: number;
} {
  const features = knowledge.features;
  const reasons: string[] = [];
  if (EXCLUDE_FROM_PICKS.has(knowledge.symbol)) {
    reasons.push('benchmark/cash ETF');
  }
  if (!features) {
    reasons.push('no features');
  } else {
    if (features.volVs20 !== null && features.volVs20 < MIN_VOL_VS_20_FOR_BUY) {
      reasons.push('dead volume vs 20d');
    }
    if (features.sma20 === null || features.sma50 === null || features.sma20 <= features.sma50) {
      reasons.push('need SMA20>SMA50');
    }
    if (features.rsNifty20 === null || features.rsNifty20 <= 0) {
      reasons.push('need 20d RS vs NIFTYBEES');
    }
    if (features.atrPct !== null && features.atrPct >= MAX_ATR_PCT_FOR_BUY) {
      reasons.push('ATR% too high');
    }
    if (features.distFrom20HighPct !== null && features.distFrom20HighPct < -MAX_DIST_FROM_20_HIGH_PCT) {
      reasons.push('too far from 20d high');
    }
  }
  const riskAdj = momRiskAdj(knowledge.bars);
  const rs = features?.rsNifty20 ?? 0;
  const events = features?.eventScore ?? 0;
  const atr = features?.atrPct ?? 0;
  const score = Number(((riskAdj ?? 0) * 8 + rs + events - atr).toFixed(3));
  return { pass: reasons.length === 0, failReasons: reasons, momRiskAdj: riskAdj, score };
}

export function diversifyByCorrelation(
  ranked: UniverseCandidate[],
  symbols: Record<string, SymbolKnowledge>,
  limit = UNIVERSE_MAX_INCLUDES,
): UniverseCandidate[] {
  const picked: UniverseCandidate[] = [];
  for (const candidate of ranked) {
    if (picked.length >= limit) {
      break;
    }
    const candidateReturns = dailyCloseReturns(symbols[candidate.symbol]?.bars ?? []).slice(-20);
    const clone = picked.some((existing) => {
      const existingReturns = dailyCloseReturns(symbols[existing.symbol]?.bars ?? []).slice(-20);
      const corr = pearson(candidateReturns, existingReturns);
      return corr !== null && corr > CORRELATION_MAX;
    });
    if (clone) {
      continue;
    }
    picked.push(candidate);
  }
  return picked;
}

export function screenUniverse(
  symbols: Record<string, SymbolKnowledge>,
  llmLimit = UNIVERSE_LLM_CANDIDATES,
): { candidates: UniverseCandidate[]; preselected: UniverseCandidate[] } {
  const nifty = symbols[BENCHMARK]?.bars ?? [];
  const evaluated: UniverseCandidate[] = Object.values(symbols)
    .filter((knowledge) => !EXCLUDE_FROM_PICKS.has(knowledge.symbol))
    .map((knowledge) => {
      const features =
        knowledge.features ?? computeFeatures(knowledge.bars, knowledge.filings, nifty);
      const withFeatures = { ...knowledge, features };
      const result = evaluateUniversePass(withFeatures);
      return {
        symbol: knowledge.symbol,
        score: result.score,
        pass: result.pass,
        failReasons: result.failReasons,
        momRiskAdj: result.momRiskAdj,
        features,
        filings: filingsForPrompt(knowledge),
      };
    })
    .sort((left, right) => right.score - left.score);

  const passing = evaluated.filter((candidate) => candidate.pass);
  const candidates = passing.slice(0, llmLimit);
  const preselected = diversifyByCorrelation(candidates, symbols, UNIVERSE_MAX_INCLUDES);
  return { candidates, preselected };
}
