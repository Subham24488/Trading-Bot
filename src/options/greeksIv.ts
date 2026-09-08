import type { DailyBar } from '../universe/types.js';
import { calendarDayDiff } from '../universe/dates.js';

export const GREEKS_IV_ALGORITHMS = ['greeks_iv_atm', 'greeks_iv_otm', 'greeks_iv_skip'] as const;
export type GreeksIvAlgorithmId = (typeof GREEKS_IV_ALGORITHMS)[number];

export const DEFAULT_GREEKS_IV_ALGORITHM: GreeksIvAlgorithmId = 'greeks_iv_atm';
export const RISK_FREE_RATE = 0.065;
export const IV_HV_SKIP_THRESHOLD = 1.4;

export type GreeksIvVariant = {
  id: GreeksIvAlgorithmId;
  deltaMin: number;
  deltaMax: number;
  ivHvEnterMax: number;
};

export const GREEKS_IV_CATALOG: Record<GreeksIvAlgorithmId, GreeksIvVariant> = {
  greeks_iv_atm: { id: 'greeks_iv_atm', deltaMin: 0.4, deltaMax: 0.7, ivHvEnterMax: 1.15 },
  greeks_iv_otm: { id: 'greeks_iv_otm', deltaMin: 0.25, deltaMax: 0.4, ivHvEnterMax: 1.1 },
  greeks_iv_skip: { id: 'greeks_iv_skip', deltaMin: 0, deltaMax: 0, ivHvEnterMax: 0 },
};

export type OptionContractMeta = {
  symbol: string;
  index: string;
  side: 'CE' | 'PE';
  strike: number;
  expiry: string;
  algorithm: GreeksIvAlgorithmId;
};

export function isGreeksIvAlgorithm(value: string | null | undefined): value is GreeksIvAlgorithmId {
  return GREEKS_IV_ALGORITHMS.includes(value as GreeksIvAlgorithmId);
}

export function parseGreeksIvAlgorithm(
  value: string | null | undefined,
): GreeksIvAlgorithmId | typeof DEFAULT_GREEKS_IV_ALGORITHM {
  return isGreeksIvAlgorithm(value) ? value : DEFAULT_GREEKS_IV_ALGORITHM;
}

export function strikeFromOptionSymbol(tradingsymbol: string): number | null {
  const match = tradingsymbol.trim().toUpperCase().match(/(\d{5})(CE|PE)$/);
  if (!match?.[1]) {
    return null;
  }
  const strike = Number(match[1]);
  return Number.isFinite(strike) && strike > 0 ? strike : null;
}

/** True when LTP looks like an option premium, not an index spot. */
export function isOptionPremium(ltp: number | null | undefined, spot: number | null | undefined): boolean {
  if (ltp === null || ltp === undefined || !Number.isFinite(ltp) || ltp <= 0) {
    return false;
  }
  if (spot === null || spot === undefined || !Number.isFinite(spot) || spot <= 0) {
    return ltp < 10_000;
  }
  return ltp < spot * 0.2;
}

export function yearFractionToExpiry(asOfYmd: string, expiryYmd: string): number {
  const days = calendarDayDiff(asOfYmd, expiryYmd);
  return Math.max(days, 0) / 365;
}

export function realizedHv20(bars: readonly DailyBar[]): number | null {
  if (bars.length < 21) {
    return null;
  }
  const closes = bars.slice(-21).map((bar) => bar.c);
  const logs: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const previous = closes[index - 1]!;
    const current = closes[index]!;
    if (previous > 0 && current > 0) {
      logs.push(Math.log(current / previous));
    }
  }
  if (logs.length < 15) {
    return null;
  }
  const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  const variance = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (logs.length - 1);
  if (!(variance > 0)) {
    return null;
  }
  return Math.sqrt(variance) * Math.sqrt(252);
}

function erf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function blackScholesPrice(
  spot: number,
  strike: number,
  timeYears: number,
  rate: number,
  sigma: number,
  side: 'CE' | 'PE',
): number {
  if (timeYears <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) {
    const intrinsic = side === 'CE' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    return intrinsic;
  }
  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * sigma * sigma) * timeYears) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discount = Math.exp(-rate * timeYears);
  if (side === 'CE') {
    return spot * normCdf(d1) - strike * discount * normCdf(d2);
  }
  return strike * discount * normCdf(-d2) - spot * normCdf(-d1);
}

export function blackScholesDelta(
  spot: number,
  strike: number,
  timeYears: number,
  rate: number,
  sigma: number,
  side: 'CE' | 'PE',
): number | null {
  if (timeYears <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) {
    return null;
  }
  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * sigma * sigma) * timeYears) / (sigma * sqrtT);
  return side === 'CE' ? normCdf(d1) : normCdf(d1) - 1;
}

export function impliedVolatility(input: {
  premium: number;
  spot: number;
  strike: number;
  timeYears: number;
  side: 'CE' | 'PE';
  rate?: number;
}): number | null {
  const { premium, spot, strike, timeYears, side } = input;
  const rate = input.rate ?? RISK_FREE_RATE;
  if (!(premium > 0) || !(spot > 0) || !(strike > 0) || !(timeYears > 0)) {
    return null;
  }
  const intrinsic = side === 'CE' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const discountedIntrinsic = intrinsic * Math.exp(-rate * timeYears);
  if (premium < discountedIntrinsic * 0.5 && premium < 0.05) {
    return null;
  }

  let low = 1e-4;
  let high = 5;
  const target = premium;
  for (let step = 0; step < 60; step += 1) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice(spot, strike, timeYears, rate, mid, side);
    if (!Number.isFinite(price)) {
      return null;
    }
    if (price > target) {
      high = mid;
    } else {
      low = mid;
    }
  }
  const iv = (low + high) / 2;
  const vega =
    spot *
    Math.sqrt(timeYears) *
    normPdf(
      (Math.log(spot / strike) + (rate + 0.5 * iv * iv) * timeYears) / (iv * Math.sqrt(timeYears)),
    );
  if (!Number.isFinite(iv) || iv <= 0 || vega < 1e-8) {
    return null;
  }
  return Number(iv.toFixed(6));
}

export type OptionGreeksSnapshot = {
  iv: number | null;
  delta: number | null;
  absDelta: number | null;
  ivHv: number | null;
  hv20: number | null;
  timeYears: number;
};

export function computeOptionGreeks(input: {
  premium: number | null;
  spot: number | null;
  strike: number;
  expiryYmd: string;
  asOfYmd: string;
  side: 'CE' | 'PE';
  indexDaily: readonly DailyBar[];
}): OptionGreeksSnapshot {
  const timeYears = yearFractionToExpiry(input.asOfYmd, input.expiryYmd);
  const hv20 = realizedHv20(input.indexDaily);
  const premiumOk = isOptionPremium(input.premium, input.spot);
  if (!premiumOk || input.spot === null || input.spot === undefined || input.spot <= 0) {
    return { iv: null, delta: null, absDelta: null, ivHv: null, hv20, timeYears };
  }
  const iv = impliedVolatility({
    premium: input.premium!,
    spot: input.spot,
    strike: input.strike,
    timeYears: Math.max(timeYears, 1 / 365),
    side: input.side,
  });
  const delta =
    iv === null
      ? null
      : blackScholesDelta(
          input.spot,
          input.strike,
          Math.max(timeYears, 1 / 365),
          RISK_FREE_RATE,
          iv,
          input.side,
        );
  const absDelta = delta === null ? null : Math.abs(delta);
  const ivHv = iv !== null && hv20 !== null && hv20 > 0 ? iv / hv20 : null;
  return { iv, delta, absDelta, ivHv, hv20, timeYears };
}

export function greeksIvCatalogForPrompt() {
  return GREEKS_IV_ALGORITHMS.map((id) => {
    const row = GREEKS_IV_CATALOG[id];
    return {
      id,
      deltaMin: row.deltaMin,
      deltaMax: row.deltaMax,
      ivHvEnterMax: row.ivHvEnterMax,
    };
  });
}
