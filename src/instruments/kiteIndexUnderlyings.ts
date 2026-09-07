import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { SessionInstrument } from '../domain.js';
import { config } from '../config.js';

const indexUnderlyingSchema = z.object({
  tradingsymbol: z.string().trim().min(1).transform((value) => value.toUpperCase()),
  kiteQuoteSymbol: z.string().trim().min(1),
  googleQuery: z.string().trim().min(1),
  exchange: z.string().trim().min(1).transform((value) => value.toUpperCase()),
  instrumentToken: z.number().int().positive(),
  strikeStep: z.number().int().positive(),
});

const fileSchema = z.object({
  instruments: z.array(indexUnderlyingSchema).min(1),
});

export type IndexUnderlying = z.infer<typeof indexUnderlyingSchema>;

export const INDEX_OPTION_NAMES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'] as const;
export type IndexOptionName = (typeof INDEX_OPTION_NAMES)[number];

let cached: IndexUnderlying[] | undefined;
let cachedPath: string | undefined;

export function loadIndexUnderlyings(
  filePath = path.resolve(config.llm.kiteIndexUnderlyingsPath),
): IndexUnderlying[] {
  if (cached && cachedPath === filePath) {
    return cached;
  }
  const parsed = fileSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
  cached = parsed.instruments;
  cachedPath = filePath;
  return cached;
}

export function indexNameFromOptionSymbol(tradingsymbol: string): IndexOptionName | null {
  const symbol = tradingsymbol.trim().toUpperCase();
  if (symbol.startsWith('BANKNIFTY')) {
    return 'BANKNIFTY';
  }
  if (symbol.startsWith('FINNIFTY')) {
    return 'FINNIFTY';
  }
  if (symbol.startsWith('NIFTY')) {
    return 'NIFTY';
  }
  return null;
}

export function optionSideFromSymbol(tradingsymbol: string): 'CE' | 'PE' | null {
  const symbol = tradingsymbol.trim().toUpperCase();
  if (symbol.endsWith('CE')) {
    return 'CE';
  }
  if (symbol.endsWith('PE')) {
    return 'PE';
  }
  return null;
}

export function matchesNfoAllowlist(
  instrument: SessionInstrument,
  allowlist: readonly SessionInstrument[],
): boolean {
  if (instrument.exchange.trim().toUpperCase() !== 'NFO') {
    return false;
  }
  return allowlist.some(
    (allowed) =>
      allowed.exchange === 'NFO' &&
      allowed.instrumentToken === instrument.instrumentToken &&
      allowed.tradingsymbol === instrument.tradingsymbol.trim().toUpperCase(),
  );
}
