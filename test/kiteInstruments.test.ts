import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { lookupSessionStartInstruments, loadKiteInstruments } from '../src/instruments/kiteInstruments.js';

const catalogPath = path.resolve('data/kite-instruments.json');

describe('kite instrument catalog', () => {
  it('maps LLM symbols to session/start instruments from the Kite JSON', () => {
    const catalog = loadKiteInstruments(catalogPath);
    const result = lookupSessionStartInstruments(['reliance', 'FAKENS', 'TCS'], catalog);

    expect(result.unmappedSymbols).toEqual(['FAKENS']);
    expect(result.instruments).toEqual([
      { tradingsymbol: 'RELIANCE', exchange: 'NSE', instrumentToken: 738561 },
      { tradingsymbol: 'TCS', exchange: 'NSE', instrumentToken: 2953217 },
    ]);
  });
});
