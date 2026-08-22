import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { SessionInstrument } from '../domain.js';

export const kiteInstrumentRefSchema = z.object({
  tradingsymbol: z.string().trim().min(1).transform((value) => value.toUpperCase()),
  exchange: z.string().trim().min(1).transform((value) => value.toUpperCase()),
  instrumentToken: z.number().int().positive(),
});

export type KiteInstrumentRef = z.infer<typeof kiteInstrumentRefSchema>;

const kiteInstrumentFileSchema = z.object({
  instruments: z.array(kiteInstrumentRefSchema).min(1),
});

const DEFAULT_INSTRUMENTS_PATH = path.resolve('data/kite-instruments.json');

let cached: KiteInstrumentRef[] | undefined;
let cachedPath: string | undefined;

export function loadKiteInstruments(filePath = DEFAULT_INSTRUMENTS_PATH): KiteInstrumentRef[] {
  if (cached && cachedPath === filePath) {
    return cached;
  }

  const raw = readFileSync(filePath, 'utf8');
  const parsed = kiteInstrumentFileSchema.parse(JSON.parse(raw) as unknown);
  const unique = new Map<string, KiteInstrumentRef>();
  for (const instrument of parsed.instruments) {
    unique.set(instrument.tradingsymbol, instrument);
  }
  cached = [...unique.values()];
  cachedPath = filePath;
  return cached;
}

export function getCatalogTradingsymbols(filePath?: string): string[] {
  return loadKiteInstruments(filePath).map((instrument) => instrument.tradingsymbol);
}

export function findKiteInstrument(
  tradingsymbol: string,
  filePath?: string,
): KiteInstrumentRef | undefined {
  const symbol = tradingsymbol.trim().toUpperCase();
  return loadKiteInstruments(filePath).find((instrument) => instrument.tradingsymbol === symbol);
}

export function isCatalogInstrument(tradingsymbol: string, filePath?: string): boolean {
  return findKiteInstrument(tradingsymbol, filePath) !== undefined;
}

export function matchesCatalogInstrument(instrument: SessionInstrument, filePath?: string): boolean {
  const listed = findKiteInstrument(instrument.tradingsymbol, filePath);
  if (!listed) {
    return false;
  }
  return (
    listed.instrumentToken === instrument.instrumentToken &&
    listed.exchange === instrument.exchange.trim().toUpperCase()
  );
}

export type SessionStartLookup = {
  instruments: SessionInstrument[];
  unmappedSymbols: string[];
};

export function lookupSessionStartInstruments(
  symbols: readonly string[],
  catalog = loadKiteInstruments(),
): SessionStartLookup {
  const bySymbol = new Map(catalog.map((instrument) => [instrument.tradingsymbol, instrument]));
  const instruments: SessionInstrument[] = [];
  const unmappedSymbols: string[] = [];
  const seen = new Set<string>();

  for (const raw of symbols) {
    const symbol = raw.trim().toUpperCase();
    if (!symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    const listed = bySymbol.get(symbol);
    if (!listed) {
      unmappedSymbols.push(symbol);
      continue;
    }
    instruments.push({
      instrumentToken: listed.instrumentToken,
      exchange: listed.exchange,
      tradingsymbol: listed.tradingsymbol,
    });
  }

  return { instruments, unmappedSymbols };
}

/** Test helper to clear the in-process catalog cache. */
export function resetKiteInstrumentCache(): void {
  cached = undefined;
  cachedPath = undefined;
}
