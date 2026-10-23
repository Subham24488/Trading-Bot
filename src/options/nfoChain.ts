import { calendarDayDiff, istYmd } from '../universe/dates.js';
import type { IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';

/** One row of a Kite instrument dump (NFO, CDS, MCX …); fields arrive loosely typed. */
export type KiteRawInstrument = {
  instrument_token?: unknown;
  tradingsymbol?: unknown;
  name?: unknown;
  expiry?: unknown;
  strike?: unknown;
  instrument_type?: unknown;
  exchange?: unknown;
  lot_size?: unknown;
};

export type NfoOptionContract = {
  instrumentToken: number;
  tradingsymbol: string;
  name: IndexOptionName;
  expiry: string;
  strike: number;
  instrumentType: 'CE' | 'PE';
  lotSize?: number;
};

export type FutureContract = {
  instrumentToken: number;
  tradingsymbol: string;
  name: string;
  expiry: string;
  lotSize?: number;
};

export function expiryToYmd(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return istYmd(value);
  }
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso?.[1]) {
    return iso[1];
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return istYmd(parsed);
  }
  return null;
}

export function nfoNameToIndex(name: string): IndexOptionName | null {
  const normalized = name.trim().toUpperCase().replace(/\s+/g, ' ');
  if (normalized === 'BANKNIFTY' || normalized === 'NIFTY BANK') {
    return 'BANKNIFTY';
  }
  if (
    normalized === 'FINNIFTY' ||
    normalized === 'NIFTY FIN SERVICE' ||
    normalized.includes('FIN SERVICE')
  ) {
    return 'FINNIFTY';
  }
  if (normalized === 'NIFTY' || normalized === 'NIFTY 50') {
    return 'NIFTY';
  }
  return null;
}

function parseLotSize(value: unknown): number | undefined {
  const lot = Number(value);
  return Number.isInteger(lot) && lot > 0 ? lot : undefined;
}

/** Index option contracts from an NFO dump; all supported indexes when `names` is omitted. */
export function parseNfoIndexOptions(
  rows: readonly KiteRawInstrument[],
  names?: readonly IndexOptionName[],
): NfoOptionContract[] {
  const wanted = names ? new Set(names) : null;
  const out: NfoOptionContract[] = [];
  for (const row of rows) {
    const index = nfoNameToIndex(String(row.name ?? ''));
    if (!index || (wanted && !wanted.has(index))) {
      continue;
    }
    const instrumentType = String(row.instrument_type ?? '')
      .trim()
      .toUpperCase();
    if (instrumentType !== 'CE' && instrumentType !== 'PE') {
      continue;
    }
    const token = Number(row.instrument_token);
    const strike = Number(row.strike);
    const tradingsymbol = String(row.tradingsymbol ?? '')
      .trim()
      .toUpperCase();
    const expiry = expiryToYmd(row.expiry);
    if (
      !Number.isInteger(token) ||
      token <= 0 ||
      !tradingsymbol ||
      expiry === null ||
      !Number.isFinite(strike)
    ) {
      continue;
    }
    const lotSize = parseLotSize(row.lot_size);
    out.push({
      instrumentToken: token,
      tradingsymbol,
      name: index,
      expiry,
      strike,
      instrumentType,
      ...(lotSize === undefined ? {} : { lotSize }),
    });
  }
  return out;
}

/**
 * Earliest expiry at least `minDaysToExpiry` calendar days away.
 * `minDaysToExpiry = 1` skips a contract that expires today.
 */
export function chooseTradingExpiry(
  expiries: readonly string[],
  asOfYmd: string,
  minDaysToExpiry = 0,
): string | null {
  const eligible = [...new Set(expiries)]
    .filter((expiry) => calendarDayDiff(asOfYmd, expiry) >= minDaysToExpiry)
    .sort();
  return eligible[0] ?? null;
}

/** Nearest futures contract for an underlying name (e.g. NIFTY, USDINR, CRUDEOIL). */
export function nearestFuture(
  rows: readonly KiteRawInstrument[],
  name: string,
  asOfYmd: string,
  minDaysToExpiry = 0,
): FutureContract | null {
  const wanted = name.trim().toUpperCase();
  const futures: FutureContract[] = [];
  for (const row of rows) {
    if (String(row.instrument_type ?? '').toUpperCase() !== 'FUT') {
      continue;
    }
    if (
      String(row.name ?? '')
        .trim()
        .toUpperCase() !== wanted
    ) {
      continue;
    }
    const token = Number(row.instrument_token);
    const tradingsymbol = String(row.tradingsymbol ?? '')
      .trim()
      .toUpperCase();
    const expiry = expiryToYmd(row.expiry);
    if (!Number.isInteger(token) || token <= 0 || !tradingsymbol || expiry === null) {
      continue;
    }
    const lotSize = parseLotSize(row.lot_size);
    futures.push({
      instrumentToken: token,
      tradingsymbol,
      name: wanted,
      expiry,
      ...(lotSize === undefined ? {} : { lotSize }),
    });
  }
  const expiry = chooseTradingExpiry(
    futures.map((future) => future.expiry),
    asOfYmd,
    minDaysToExpiry,
  );
  return futures.find((future) => future.expiry === expiry) ?? null;
}

export function atmStrike(spot: number, step: number): number {
  return Math.round(spot / step) * step;
}

export function filterNearestWeeklyAtmBand(
  contracts: readonly NfoOptionContract[],
  spots: Partial<Record<IndexOptionName, number>>,
  steps: Partial<Record<IndexOptionName, number>>,
  asOfYmd: string,
  wings = 3,
  minDaysToExpiry = 0,
): NfoOptionContract[] {
  const picked: NfoOptionContract[] = [];
  const names = [...new Set(contracts.map((contract) => contract.name))];
  for (const name of names) {
    const spot = spots[name];
    const step = steps[name];
    if (spot === undefined || step === undefined || spot <= 0) {
      continue;
    }
    const expiry = chooseTradingExpiry(
      contracts.filter((contract) => contract.name === name).map((contract) => contract.expiry),
      asOfYmd,
      minDaysToExpiry,
    );
    if (!expiry) {
      continue;
    }
    const atm = atmStrike(spot, step);
    const min = atm - wings * step;
    const max = atm + wings * step;
    picked.push(
      ...contracts.filter(
        (contract) =>
          contract.name === name &&
          contract.expiry === expiry &&
          contract.strike >= min &&
          contract.strike <= max,
      ),
    );
  }
  return picked;
}
