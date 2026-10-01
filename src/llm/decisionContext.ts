import type { DailyBar, IntradayBar } from '../universe/types.js';
import type { IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import type { OptionNewsRisk } from '../options/greeksIv.js';
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
};

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
