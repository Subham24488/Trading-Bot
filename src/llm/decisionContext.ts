import type { DailyBar, IntradayBar } from '../universe/types.js';
import type { IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import type { OptionNewsRisk } from '../options/greeksIv.js';
import { config } from '../config.js';
import type { LlmTradeActionName } from './schemas.js';
import type { OptionRoundTripCost } from './optionTradeCosts.js';

export type TrendLabel = 'up' | 'down' | 'flat' | 'unknown';

export type IndexCandlePack = {
  index: IndexOptionName;
  spot: number | null;
  minute: IntradayBar[];
  session15: IntradayBar[];
  weekDaily: DailyBar[];
  monthDaily: DailyBar[];
  trend: { day: TrendLabel; week: TrendLabel; month: TrendLabel };
  structure: string[];
};

export type ChainQuoteRow = {
  symbol: string;
  index: IndexOptionName;
  side: 'CE' | 'PE';
  strike: number;
  expiry: string;
  token: number;
  ltp: number | null;
  oi: number;
  volume: number;
  dOi: number | null;
  dVolume: number | null;
};

export type ChainSnapshot = {
  rows: ChainQuoteRow[];
  pcr: number | null;
  ceOi: number;
  peOi: number;
};

export type OpenPositionContext = {
  symbol: string;
  buyPrice: number | null;
  heldMinutes: number;
  instrumentToken: number | null;
};

export type OptionSide = 'CE' | 'PE';

export type CandlePatternName =
  | 'bullish_engulfing'
  | 'bearish_engulfing'
  | 'hammer'
  | 'shooting_star'
  | 'inside_bar'
  | 'bull_marubozu'
  | 'bear_marubozu'
  | 'three_bar_push_up'
  | 'three_bar_push_down'
  | 'none';

export type TapeConfluence = {
  structure: boolean;
  candles: boolean;
  chain: boolean;
  news: boolean;
  score: number;
  legs: string[];
};

export type DecisionTape = {
  index: IndexOptionName | null;
  trend: { day: TrendLabel; week: TrendLabel; month: TrendLabel } | null;
  structure: string[];
  structureOk: boolean;
  pattern: CandlePatternName;
  candle1to3: string;
  sideFromCandles: OptionSide | null;
  chainNote: string;
  newsLevel: OptionNewsRisk['level'];
  confluence: TapeConfluence;
};

export type LiveOptionDecisionContext = {
  asOfIst: string;
  indexes: IndexOptionName[];
  candles: IndexCandlePack[];
  chain: ChainSnapshot;
  newsRiskByIndex: Partial<Record<IndexOptionName, OptionNewsRisk>>;
  newsHeadlines: Array<{ s: string; t: string }>;
  open: OpenPositionContext | null;
  allowed: LlmTradeActionName[];
  fees: OptionRoundTripCost | null;
  targetNetPnlPct: number;
  minHoldMinutes: number;
  candleLookbackMinutes: number;
  tape: DecisionTape;
};

const WEAK_STRUCTURE = new Set(['mixed swings', 'insufficient structure', 'expanding range']);

type Ohlc = { o: number; h: number; l: number; c: number };

function body(bar: Ohlc): number {
  return Math.abs(bar.c - bar.o);
}

function range(bar: Ohlc): number {
  return Math.max(bar.h - bar.l, 1e-9);
}

export function classifyLastCandles(bars: readonly Ohlc[]): {
  pattern: CandlePatternName;
  candle1to3: string;
  side: OptionSide | null;
} {
  if (bars.length === 0) {
    return { pattern: 'none', candle1to3: 'no bars', side: null };
  }
  const last3 = bars.slice(-3);
  const last = last3.at(-1)!;
  const prior = last3.length >= 2 ? last3.at(-2)! : null;
  const first = last3.length >= 3 ? last3.at(-3)! : null;
  const lastBull = last.c > last.o;
  const lastBear = last.c < last.o;
  const lastBody = body(last);
  const lastRange = range(last);
  const upper = last.h - Math.max(last.o, last.c);
  const lower = Math.min(last.o, last.c) - last.l;

  let pattern: CandlePatternName = 'none';
  if (prior) {
    const priorBull = prior.c > prior.o;
    const priorBear = prior.c < prior.o;
    if (lastBull && priorBear && last.o <= prior.c && last.c >= prior.o && lastBody > body(prior) * 0.9) {
      pattern = 'bullish_engulfing';
    } else if (lastBear && priorBull && last.o >= prior.c && last.c <= prior.o && lastBody > body(prior) * 0.9) {
      pattern = 'bearish_engulfing';
    } else if (last.h <= prior.h && last.l >= prior.l) {
      pattern = 'inside_bar';
    }
  }
  if (pattern === 'none' || pattern === 'inside_bar') {
    if (lower >= lastBody * 2 && upper <= lastBody * 0.5 && lastBull) {
      pattern = 'hammer';
    } else if (upper >= lastBody * 2 && lower <= lastBody * 0.5 && lastBear) {
      pattern = 'shooting_star';
    } else if (lastBody / lastRange >= 0.7 && lastBull) {
      pattern = 'bull_marubozu';
    } else if (lastBody / lastRange >= 0.7 && lastBear) {
      pattern = 'bear_marubozu';
    }
  }
  if (pattern === 'none' && first && prior) {
    if (last.c > prior.c && prior.c > first.c && last.c > last.o) {
      pattern = 'three_bar_push_up';
    } else if (last.c < prior.c && prior.c < first.c && last.c < last.o) {
      pattern = 'three_bar_push_down';
    }
  }

  const bullish: CandlePatternName[] = [
    'bullish_engulfing',
    'hammer',
    'bull_marubozu',
    'three_bar_push_up',
  ];
  const bearish: CandlePatternName[] = [
    'bearish_engulfing',
    'shooting_star',
    'bear_marubozu',
    'three_bar_push_down',
  ];
  const side: OptionSide | null = bullish.includes(pattern)
    ? 'CE'
    : bearish.includes(pattern)
      ? 'PE'
      : null;
  const candle1to3 = last3
    .map((bar, index) => `c${index + 1}:${bar.o.toFixed(0)}/${bar.h.toFixed(0)}/${bar.l.toFixed(0)}/${bar.c.toFixed(0)}`)
    .join(' ');
  return { pattern, candle1to3: candle1to3 || 'no bars', side };
}

export function structureConfluence(structure: readonly string[]): boolean {
  if (structure.length === 0) {
    return false;
  }
  const onlyWeak = structure.every((note) => WEAK_STRUCTURE.has(note));
  if (onlyWeak) {
    return false;
  }
  return structure.some(
    (note) =>
      note === 'HH+HL' ||
      note === 'LH+LL' ||
      note.includes('broke prior high') ||
      note.includes('broke prior low'),
  );
}

export function chainConfluence(
  chain: ChainSnapshot,
  side: OptionSide | null,
): { ok: boolean; note: string } {
  const pcr = chain.pcr;
  const dCeOi = chain.rows
    .filter((row) => row.side === 'CE')
    .reduce((sum, row) => sum + (row.dOi ?? 0), 0);
  const dPeOi = chain.rows
    .filter((row) => row.side === 'PE')
    .reduce((sum, row) => sum + (row.dOi ?? 0), 0);
  const dVol = chain.rows.reduce((sum, row) => sum + (row.dVolume ?? 0), 0);
  const note = `pcr=${pcr ?? 'na'} dCeOi=${dCeOi} dPeOi=${dPeOi} dVol=${dVol}`;
  if (side === 'CE') {
    const ok = (pcr !== null && pcr < 0.95) || (dCeOi > 0 && dPeOi <= 0) || dVol > 0;
    return { ok, note };
  }
  if (side === 'PE') {
    const ok = (pcr !== null && pcr > 1.05) || (dPeOi > 0 && dCeOi <= 0) || dVol > 0;
    return { ok, note };
  }
  return { ok: false, note };
}

export function newsConfluence(level: OptionNewsRisk['level'] | undefined): boolean {
  return level === 'elevated' || level === 'high';
}

export function scoreConfluence(input: {
  structure: boolean;
  candles: boolean;
  chain: boolean;
  news: boolean;
}): TapeConfluence {
  const legs = (['structure', 'candles', 'chain', 'news'] as const).filter((key) => input[key]);
  return {
    ...input,
    score: legs.length,
    legs: [...legs],
  };
}

export function buildDecisionTape(input: {
  pack: IndexCandlePack | undefined;
  chain: ChainSnapshot;
  newsLevel: OptionNewsRisk['level'] | undefined;
  preferredSide: OptionSide | null;
}): DecisionTape {
  const pack = input.pack;
  const bars: Ohlc[] =
    pack && pack.minute.length >= 3
      ? pack.minute
      : pack && pack.session15.length >= 3
        ? pack.session15
        : [];
  const classified = classifyLastCandles(bars);
  const structure = pack?.structure ?? ['insufficient structure'];
  const structureOk = structureConfluence(structure);
  const side = classified.side ?? input.preferredSide;
  const chain = chainConfluence(input.chain, side);
  const newsOk = newsConfluence(input.newsLevel);
  const candlesOk = classified.pattern !== 'none';
  return {
    index: pack?.index ?? null,
    trend: pack?.trend ?? null,
    structure,
    structureOk,
    pattern: classified.pattern,
    candle1to3: classified.candle1to3,
    sideFromCandles: classified.side,
    chainNote: chain.note,
    newsLevel: input.newsLevel ?? 'none',
    confluence: scoreConfluence({
      structure: structureOk,
      candles: candlesOk,
      chain: chain.ok,
      news: newsOk,
    }),
  };
}

export const RATIONALE_MAX_CHARS = 1200;

export function formatStructuredRationale(input: {
  tape: DecisionTape;
  decision: string;
  why: string;
}): string {
  const trend = input.tape.trend
    ? `d=${input.tape.trend.day}/w=${input.tape.trend.week}/m=${input.tape.trend.month}`
    : 'unknown';
  const text =
    `trend=${trend}; structure=${input.tape.structure.join(',') || 'na'}; ` +
    `pattern=${input.tape.pattern}; candle1to3=${input.tape.candle1to3}; ` +
    `chain=${input.tape.chainNote}; news=${input.tape.newsLevel}; ` +
    `decision=${input.decision}; why=${input.why}`;
  return text.slice(0, RATIONALE_MAX_CHARS);
}

export function isWeakTape(tape: DecisionTape): boolean {
  if (tape.confluence.score < 2) {
    return true;
  }
  if (!tape.structureOk) {
    return true;
  }
  if (tape.pattern === 'none' && !tape.confluence.chain) {
    return true;
  }
  return false;
}

export function sanitizeExitWhy(input: {
  why: string;
  pnlPct: number | null;
  targetNetPnlPct: number;
  newsLevel: OptionNewsRisk['level'];
}): string {
  let why = input.why.trim();
  const lossOrMiss = input.pnlPct === null || input.pnlPct < input.targetNetPnlPct;
  if (lossOrMiss) {
    why = why.replace(/\b(target achieved|take[- ]?profit|hit target)\b/gi, '').trim();
  }
  if (input.newsLevel === 'none') {
    why = why.replace(/\b(news risk|event risk|headline risk)\b/gi, '').trim();
  }
  why = why.replace(/\s{2,}/g, ' ').replace(/^[,;.\s]+|[,;.\s]+$/g, '');
  if (!why) {
    if (input.pnlPct !== null && input.pnlPct <= -25) {
      return 'premium stop';
    }
    return 'exit on structure/session; no invented edge';
  }
  return why;
}

export function trendFromCloses(closes: readonly number[]): TrendLabel {
  if (closes.length < 3) {
    return 'unknown';
  }
  const first = closes[0]!;
  const last = closes.at(-1)!;
  if (!(first > 0) || !(last > 0)) {
    return 'unknown';
  }
  const changePct = ((last - first) / first) * 100;
  if (changePct > 0.35) {
    return 'up';
  }
  if (changePct < -0.35) {
    return 'down';
  }
  return 'flat';
}

export function structureNotesFromBars(bars: readonly { h: number; l: number; c: number }[]): string[] {
  if (bars.length < 4) {
    return ['insufficient structure'];
  }
  const recent = bars.slice(-6);
  const notes: string[] = [];
  const highs = recent.map((bar) => bar.h);
  const lows = recent.map((bar) => bar.l);
  const higherHighs = highs.every((value, index) => index === 0 || value >= highs[index - 1]! * 0.999);
  const higherLows = lows.every((value, index) => index === 0 || value >= lows[index - 1]! * 0.999);
  const lowerHighs = highs.every((value, index) => index === 0 || value <= highs[index - 1]! * 1.001);
  const lowerLows = lows.every((value, index) => index === 0 || value <= lows[index - 1]! * 1.001);
  if (higherHighs && higherLows) {
    notes.push('HH+HL');
  } else if (lowerHighs && lowerLows) {
    notes.push('LH+LL');
  } else if (higherHighs && lowerLows) {
    notes.push('expanding range');
  } else {
    notes.push('mixed swings');
  }
  const last = recent.at(-1)!;
  const prior = recent.at(-2)!;
  if (last.c > prior.h) {
    notes.push('close broke prior high');
  } else if (last.c < prior.l) {
    notes.push('close broke prior low');
  }
  return notes.slice(0, 3);
}

export function compactCandlesForPrompt(pack: IndexCandlePack) {
  const lastMinutes = pack.minute.slice(-12).map((bar) => ({
    t: bar.t.slice(11, 16),
    c: Number(bar.c.toFixed(2)),
    v: bar.v,
  }));
  const sessionTail = pack.session15.slice(-8).map((bar) => ({
    t: bar.t.slice(11, 16),
    c: Number(bar.c.toFixed(2)),
    v: bar.v,
  }));
  return {
    index: pack.index,
    spot: pack.spot,
    trend: pack.trend,
    structure: pack.structure,
    minuteTail: lastMinutes,
    session15Tail: sessionTail,
    weekCloses: pack.weekDaily.slice(-5).map((bar) => ({ d: bar.d, c: Number(bar.c.toFixed(2)) })),
    monthCloses: pack.monthDaily.slice(-8).map((bar) => ({ d: bar.d, c: Number(bar.c.toFixed(2)) })),
  };
}

export function compactChainForPrompt(chain: ChainSnapshot) {
  return {
    pcr: chain.pcr,
    ceOi: chain.ceOi,
    peOi: chain.peOi,
    rows: chain.rows.slice(0, 40).map((row) => ({
      s: row.symbol,
      idx: row.index,
      side: row.side,
      k: row.strike,
      exp: row.expiry,
      ltp: row.ltp,
      oi: row.oi,
      dOi: row.dOi,
      vol: row.volume,
      dVol: row.dVolume,
    })),
  };
}

export function compactTapeForPrompt(tape: DecisionTape) {
  return {
    index: tape.index,
    trend: tape.trend,
    structure: tape.structure,
    pattern: tape.pattern,
    candle1to3: tape.candle1to3,
    sideFromCandles: tape.sideFromCandles,
    chain: tape.chainNote,
    news: tape.newsLevel,
    confluence: tape.confluence.score,
    legs: tape.confluence.legs,
  };
}

/** Last hour of the IST session, or after SESSION_END_HOUR. */
export function isNearOrAfterSessionClose(date: Date = new Date()): boolean {
  const hourPart = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  })
    .formatToParts(date)
    .find((part) => part.type === 'hour')?.value;
  const hour = Number(hourPart === '24' ? '0' : (hourPart ?? date.getUTCHours()));
  return hour >= config.session.endHour - 1;
}

/** Format Date as IST `YYYY-MM-DD HH:mm:ss` for Kite historical. */
export function formatIstWallClock(date: Date): string {
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(safe);
    const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
    const hour = read('hour') === '24' ? '00' : read('hour');
    return `${read('year')}-${read('month')}-${read('day')} ${hour}:${read('minute')}:${read('second')}`;
  } catch {
    // Fallback: shift UTC by +05:30 when ICU/timezone data is unavailable.
    const shifted = new Date(safe.getTime() + 5.5 * 60 * 60 * 1000);
    const iso = shifted.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  }
}
