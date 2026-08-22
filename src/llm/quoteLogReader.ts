import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';

export type QuoteLogInstrument = {
  instrumentToken?: number;
  exchange?: string;
  tradingsymbol?: string;
  lastPrice?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  change?: number | null;
  volume?: number | null;
  receivedAt?: string | null;
};

export type QuoteLogSnapshot = {
  ts: string;
  sessionStartedAt?: string;
  elapsedSeconds?: number;
  streamConnected?: boolean;
  instruments: QuoteLogInstrument[];
};

function isSnapshot(value: unknown): value is QuoteLogSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as { ts?: unknown; instruments?: unknown };
  return typeof record.ts === 'string' && Array.isArray(record.instruments);
}

export async function readRecentQuoteSnapshots(
  logPath = config.session.quoteLogPath,
  maxSnapshots = 8,
): Promise<QuoteLogSnapshot[]> {
  let raw: string;
  try {
    raw = await readFile(path.resolve(logPath), 'utf8');
  } catch {
    return [];
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const recent = lines.slice(-Math.max(1, maxSnapshots));
  const snapshots: QuoteLogSnapshot[] = [];
  for (const line of recent) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isSnapshot(parsed)) {
        snapshots.push(parsed);
      }
    } catch {
      // Skip a corrupt JSONL line.
    }
  }
  return snapshots;
}

export function filterSnapshotsToSymbols(
  snapshots: QuoteLogSnapshot[],
  symbols: ReadonlySet<string>,
): QuoteLogSnapshot[] {
  return snapshots
    .map((snapshot) => ({
      ...snapshot,
      instruments: snapshot.instruments.filter((instrument) => {
        const symbol = instrument.tradingsymbol?.trim().toUpperCase();
        return symbol ? symbols.has(symbol) : false;
      }),
    }))
    .filter((snapshot) => snapshot.instruments.length > 0);
}

/** Last traded price from the newest snapshot that quotes the symbol. */
export function lastPricesFromSnapshots(
  snapshots: readonly QuoteLogSnapshot[],
  symbols: readonly string[],
): Record<string, number | null> {
  const wanted = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  const prices: Record<string, number | null> = {};
  for (const symbol of wanted) {
    prices[symbol] = null;
  }

  for (const snapshot of snapshots) {
    for (const instrument of snapshot.instruments) {
      const symbol = instrument.tradingsymbol?.trim().toUpperCase();
      if (!symbol || !wanted.has(symbol)) {
        continue;
      }
      if (typeof instrument.lastPrice === 'number' && Number.isFinite(instrument.lastPrice)) {
        prices[symbol] = instrument.lastPrice;
      }
    }
  }
  return prices;
}
