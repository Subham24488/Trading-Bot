import { istYmd } from '../universe/dates.js';
import type { IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import { INDEX_OPTION_NAMES } from '../instruments/kiteIndexUnderlyings.js';

export type NfoRawInstrument = {
  instrument_token?: unknown;
  tradingsymbol?: unknown;
  name?: unknown;
  expiry?: unknown;
  strike?: unknown;
  instrument_type?: unknown;
  exchange?: unknown;
};

export type NfoOptionContract = {
  instrumentToken: number;
  tradingsymbol: string;
  name: IndexOptionName;
  expiry: string;
  strike: number;
  instrumentType: 'CE' | 'PE';
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
  if (normalized === 'FINNIFTY' || normalized === 'NIFTY FIN SERVICE' || normalized.includes('FIN SERVICE')) {
    return 'FINNIFTY';
  }
  if (normalized === 'NIFTY' || normalized === 'NIFTY 50') {
    return 'NIFTY';
  }
  return null;
}

export function parseNfoIndexOptions(
  rows: readonly NfoRawInstrument[],
  names: readonly IndexOptionName[] = INDEX_OPTION_NAMES,
): NfoOptionContract[] {
  const wanted = new Set(names);
  const out: NfoOptionContract[] = [];
  for (const row of rows) {
    const index = nfoNameToIndex(String(row.name ?? ''));
    if (!index || !wanted.has(index)) {
      continue;
    }
    const instrumentType = String(row.instrument_type ?? '').trim().toUpperCase();
    if (instrumentType !== 'CE' && instrumentType !== 'PE') {
      continue;
    }
    const token = Number(row.instrument_token);
    const strike = Number(row.strike);
    const tradingsymbol = String(row.tradingsymbol ?? '').trim().toUpperCase();
    const expiry = expiryToYmd(row.expiry);
    if (!Number.isInteger(token) || token <= 0 || !tradingsymbol || expiry === null || !Number.isFinite(strike)) {
      continue;
    }
    out.push({
      instrumentToken: token,
      tradingsymbol,
      name: index,
      expiry,
      strike,
      instrumentType,
    });
  }
  return out;
}

export function nearestExpiryOnOrAfter(expiries: readonly string[], asOfYmd: string): string | null {
  const future = [...new Set(expiries)].filter((expiry) => expiry >= asOfYmd).sort();
  return future[0] ?? null;
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
): NfoOptionContract[] {
  const picked: NfoOptionContract[] = [];
  const names = [...new Set(contracts.map((contract) => contract.name))];
  for (const name of names) {
    const spot = spots[name];
    const step = steps[name];
    if (spot === undefined || step === undefined || spot <= 0) {
      continue;
    }
    const expiry = nearestExpiryOnOrAfter(
      contracts.filter((contract) => contract.name === name).map((contract) => contract.expiry),
      asOfYmd,
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
