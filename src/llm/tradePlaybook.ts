import type { DailyBar, FeatureSnapshot, IntradayBar } from '../universe/types.js';
import { computeFeatures } from '../universe/features.js';
import type { LlmTradeActionName } from './schemas.js';
import type { DecisionBatch } from './schemas.js';

/**
 * Cash-equity playbook used *before* the LLM.
 *
 * Implementable desk research (not a live JPM feed):
 * - Time-series momentum: J.P. Morgan QDS “Momentum Strategies Across Asset Classes”
 *   (Kolanovic / Wei, 2015) and Moskowitz–Ooi–Pedersen (2012): prefer names with
 *   positive medium-horizon trend vs a market proxy; slower trend (SMA20>SMA50)
 *   over noisy 1-day noise.
 * - Relative strength vs NIFTYBEES as the NSE cash index proxy (same idea as RS vs beta).
 * - Volume confirmation: skip dead tape vs 20-day average.
 * - Volatility filter: skip new buys when ATR% is extreme (trend-following degrades
 *   at vol spikes — same JPM note on turning-point risk).
 * - Intraday: last 15m close vs session VWAP (participation / not buying a dump).
 * - Overlay: hard +20% take-profit / −10% stop on the stored buy price (book rule).
 *
 * The LLM only confirms among allowed ∩ playbook-safe actions. No live orders.
 */

export const TAKE_PROFIT_PCT = 20;
export const STOP_LOSS_PCT = 10;
export const MAX_ATR_PCT_FOR_BUY = 6;
export const MIN_VOL_VS_20_FOR_BUY = 0.7;
export const MAX_DIST_FROM_20_HIGH_PCT = 8;

export type PlaybookBias = 'ENTER' | 'STAY' | 'LEAVE' | 'WAIT';

export type PlaybookSignal = {
  symbol: string;
  suggested: LlmTradeActionName;
  bias: PlaybookBias;
  reasons: string[];
  lastPrice: number | null;
  pnlPct: number | null;
  features: Pick<
    FeatureSnapshot,
    'sma20' | 'sma50' | 'atrPct' | 'rsNifty20' | 'volVs20' | 'distFrom20HighPct'
  > & { vwap15: number | null; last15: number | null };
};

export function sessionVwap(bars: readonly IntradayBar[]): number | null {
  let notional = 0;
  let volume = 0;
  for (const bar of bars) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    notional += typical * bar.v;
    volume += bar.v;
  }
  if (volume <= 0) {
    return null;
  }
  return notional / volume;
}

export function pnlPercent(lastPrice: number | null, buyPrice: number | null): number | null {
  if (lastPrice === null || buyPrice === null || buyPrice <= 0) {
    return null;
  }
  return ((lastPrice - buyPrice) / buyPrice) * 100;
}

function mapBiasToAction(bias: PlaybookBias, allowed: readonly LlmTradeActionName[]): LlmTradeActionName {
  const prefer: Record<PlaybookBias, LlmTradeActionName[]> = {
    ENTER: ['BUY', 'SKIP'],
    STAY: ['HOLD', 'SKIP'],
    LEAVE: ['EXIT', 'SKIP'],
    WAIT: ['SKIP', 'HOLD'],
  };
  for (const action of prefer[bias]) {
    if (allowed.includes(action)) {
      return action;
    }
  }
  return allowed[0] ?? 'SKIP';
}

export function evaluatePlaybook(input: {
  symbol: string;
  lastAction: LlmTradeActionName | null;
  allowed: readonly LlmTradeActionName[];
  lastPrice: number | null;
  buyPrice: number | null;
  daily: DailyBar[];
  niftyDaily: DailyBar[];
  minutes15: IntradayBar[];
}): PlaybookSignal {
  const features = computeFeatures(input.daily, [], input.niftyDaily);
  const vwap15 = sessionVwap(input.minutes15);
  const last15 = input.minutes15.at(-1)?.c ?? null;
  const lastPrice = input.lastPrice ?? last15 ?? input.daily.at(-1)?.c ?? null;
  const pnlPct = pnlPercent(lastPrice, input.buyPrice);
  const reasons: string[] = [];
  const inPosition = input.lastAction === 'BUY' || input.lastAction === 'HOLD';

  let bias: PlaybookBias = inPosition ? 'STAY' : 'WAIT';

  if (inPosition && pnlPct !== null && pnlPct <= -STOP_LOSS_PCT) {
    bias = 'LEAVE';
    reasons.push(`stop ${pnlPct.toFixed(1)}% ≤ −${STOP_LOSS_PCT}%`);
  } else if (inPosition && pnlPct !== null && pnlPct >= TAKE_PROFIT_PCT) {
    bias = 'LEAVE';
    reasons.push(`take-profit ${pnlPct.toFixed(1)}% ≥ +${TAKE_PROFIT_PCT}%`);
  } else if (inPosition && features.sma20 !== null && features.sma50 !== null && features.sma20 < features.sma50) {
    bias = 'LEAVE';
    reasons.push('daily SMA20 lost SMA50');
  } else if (!inPosition) {
    const trendUp = features.sma20 !== null && features.sma50 !== null && features.sma20 > features.sma50;
    const rsUp = features.rsNifty20 !== null && features.rsNifty20 > 0;
    const liquid = features.volVs20 === null || features.volVs20 >= MIN_VOL_VS_20_FOR_BUY;
    const calm = features.atrPct === null || features.atrPct < MAX_ATR_PCT_FOR_BUY;
    const nearHigh =
      features.distFrom20HighPct === null || features.distFrom20HighPct >= -MAX_DIST_FROM_20_HIGH_PCT;
    const tapeOk = vwap15 === null || last15 === null ? false : last15 >= vwap15;

    if (!trendUp) {
      reasons.push('need SMA20>SMA50');
    }
    if (!rsUp) {
      reasons.push('need 20d RS vs NIFTYBEES');
    }
    if (!liquid) {
      reasons.push('dead volume vs 20d');
    }
    if (!calm) {
      reasons.push('ATR% too high for a new cash buy');
    }
    if (!nearHigh) {
      reasons.push('too far from 20d high');
    }
    if (!tapeOk) {
      reasons.push('15m close below session VWAP or no 15m tape');
    }

    bias = trendUp && rsUp && liquid && calm && nearHigh && tapeOk ? 'ENTER' : 'WAIT';
    if (bias === 'ENTER') {
      reasons.length = 0;
      reasons.push('trend+RS+volume+VWAP aligned');
    }
  } else {
    reasons.push('structure intact; hold');
  }

  const suggested = mapBiasToAction(bias, input.allowed);
  return {
    symbol: input.symbol,
    suggested,
    bias,
    reasons: reasons.slice(0, 4),
    lastPrice,
    pnlPct: pnlPct === null ? null : Number(pnlPct.toFixed(2)),
    features: {
      sma20: features.sma20,
      sma50: features.sma50,
      atrPct: features.atrPct,
      rsNifty20: features.rsNifty20,
      volVs20: features.volVs20,
      distFrom20HighPct: features.distFrom20HighPct,
      vwap15,
      last15,
    },
  };
}

export function evaluateOptionPlaybook(input: {
  symbol: string;
  side: 'CE' | 'PE';
  lastAction: LlmTradeActionName | null;
  allowed: readonly LlmTradeActionName[];
  lastPrice: number | null;
  buyPrice: number | null;
  indexDaily: DailyBar[];
  stopLossPct?: number;
  takeProfitPct?: number;
  ruleId?: string;
}): PlaybookSignal {
  const stopLossPct = input.stopLossPct ?? STOP_LOSS_PCT;
  const takeProfitPct = input.takeProfitPct ?? TAKE_PROFIT_PCT;
  const features = computeFeatures(input.indexDaily, [], input.indexDaily);
  const lastPrice = input.lastPrice ?? input.indexDaily.at(-1)?.c ?? null;
  const pnlPct = pnlPercent(lastPrice, input.buyPrice);
  const reasons: string[] = [];
  const inPosition = input.lastAction === 'BUY' || input.lastAction === 'HOLD';
  const smaUp = features.sma20 !== null && features.sma50 !== null && features.sma20 > features.sma50;
  const smaDown = features.sma20 !== null && features.sma50 !== null && features.sma20 < features.sma50;
  const retUp = features.ret20Pct !== null && features.ret20Pct > 0;
  const retDown = features.ret20Pct !== null && features.ret20Pct < 0;
  const calm = features.atrPct === null || features.atrPct < MAX_ATR_PCT_FOR_BUY;
  const sideFits =
    input.side === 'CE' ? smaUp && retUp : input.side === 'PE' ? smaDown && retDown : false;

  let bias: PlaybookBias = inPosition ? 'STAY' : 'WAIT';

  if (inPosition && pnlPct !== null && pnlPct <= -stopLossPct) {
    bias = 'LEAVE';
    reasons.push(`premium stop ${pnlPct.toFixed(1)}% ≤ −${stopLossPct}%`);
  } else if (inPosition && pnlPct !== null && pnlPct >= takeProfitPct) {
    bias = 'LEAVE';
    reasons.push(`premium take-profit ${pnlPct.toFixed(1)}% ≥ +${takeProfitPct}%`);
  } else if (inPosition && input.side === 'CE' && smaDown) {
    bias = 'LEAVE';
    reasons.push('index SMA20 lost SMA50; exit CE');
  } else if (inPosition && input.side === 'PE' && smaUp) {
    bias = 'LEAVE';
    reasons.push('index SMA20 regained SMA50; exit PE');
  } else if (!inPosition) {
    if (!calm) {
      reasons.push('index ATR% too high');
    }
    if (!sideFits) {
      reasons.push(`need ${input.side === 'CE' ? 'uptrend' : 'downtrend'} on the index`);
    }
    bias = calm && sideFits ? 'ENTER' : 'WAIT';
    if (bias === 'ENTER') {
      reasons.length = 0;
      reasons.push(
        `${input.side} aligned with index trend` +
          (input.ruleId ? ` (${input.ruleId})` : ''),
      );
    }
  } else {
    reasons.push('index structure intact; hold premium');
  }

  const suggested = mapBiasToAction(bias, input.allowed);
  return {
    symbol: input.symbol,
    suggested,
    bias,
    reasons: reasons.slice(0, 4),
    lastPrice,
    pnlPct: pnlPct === null ? null : Number(pnlPct.toFixed(2)),
    features: {
      sma20: features.sma20,
      sma50: features.sma50,
      atrPct: features.atrPct,
      rsNifty20: features.ret20Pct,
      volVs20: null,
      distFrom20HighPct: null,
      vwap15: null,
      last15: null,
    },
  };
}

export function compactPlaybookForPrompt(signals: readonly PlaybookSignal[]) {
  return signals.map((signal) => ({
    s: signal.symbol,
    bias: signal.bias,
    rec: signal.suggested === 'EXIT' ? 'SELL' : signal.suggested,
    pnl: signal.pnlPct,
    sma20: signal.features.sma20,
    sma50: signal.features.sma50,
    rs: signal.features.rsNifty20,
    vol: signal.features.volVs20,
    atr: signal.features.atrPct,
    distH: signal.features.distFrom20HighPct,
    vwap15: signal.features.vwap15,
    last15: signal.features.last15,
    why: signal.reasons,
  }));
}

/** Hard risk: never BUY against WAIT; never HOLD through a LEAVE stop/target. */
export function applyPlaybookClamp(
  batch: DecisionBatch,
  signals: readonly PlaybookSignal[],
  allowedBySymbol: ReadonlyMap<string, readonly LlmTradeActionName[]>,
): { batch: DecisionBatch; overrides: Array<{ symbol: string; from: LlmTradeActionName; to: LlmTradeActionName }> } {
  const bySymbol = new Map(signals.map((signal) => [signal.symbol, signal]));
  const overrides: Array<{ symbol: string; from: LlmTradeActionName; to: LlmTradeActionName }> = [];
  const decisions = batch.decisions.map((item) => {
    const signal = bySymbol.get(item.symbol);
    const allowed = allowedBySymbol.get(item.symbol) ?? [];
    if (!signal) {
      return item;
    }
    let next = item.action;
    if (signal.bias === 'LEAVE' && allowed.includes('EXIT') && item.action !== 'EXIT') {
      next = 'EXIT';
    } else if (item.action === 'BUY' && signal.bias === 'WAIT' && allowed.includes('SKIP')) {
      next = 'SKIP';
    }
    if (next !== item.action) {
      overrides.push({ symbol: item.symbol, from: item.action, to: next });
      return {
        ...item,
        action: next,
        rationale: `${signal.reasons[0] ?? 'playbook'}: ${item.rationale}`.slice(0, 180),
      };
    }
    return item;
  });
  return { batch: { ...batch, decisions }, overrides };
}
