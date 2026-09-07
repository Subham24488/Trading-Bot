import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    session: { maxInstruments: 20 },
    llm: {
      kiteInstrumentsPath: 'data/kite-instruments.json',
      kiteIndexUnderlyingsPath: 'data/kite-index-underlyings.json',
    },
  },
}));

const { loadIndexUnderlyings, indexNameFromOptionSymbol, optionSideFromSymbol } = await import(
  '../src/instruments/kiteIndexUnderlyings.js'
);
const { filterNearestWeeklyAtmBand, parseNfoIndexOptions } = await import('../src/options/nfoChain.js');
const { indexOptionBias, pickOptionContracts, screenIndexOptions } = await import(
  '../src/options/optionsScreen.js'
);
const { evaluateOptionPlaybook } = await import('../src/llm/tradePlaybook.js');
const { parseSessionStartBody } = await import('../src/session/sessionStartSchema.js');
const { universeBookBodySchema } = await import('../src/llm/schemas.js');

function risingBars(count = 60): Array<{ d: string; o: number; h: number; l: number; c: number; v: number }> {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const close = 24_000 + index * 20;
    out.push({
      d: `2026-06-${String((index % 28) + 1).padStart(2, '0')}`,
      o: close - 5,
      h: close + 10,
      l: close - 10,
      c: close,
      v: 1_000_000,
    });
  }
  return out;
}

describe('index options universe helpers', () => {
  it('loads NIFTY, BANKNIFTY and FINNIFTY underlyings', () => {
    const rows = loadIndexUnderlyings(path.resolve('data/kite-index-underlyings.json'));
    expect(rows.map((row) => row.tradingsymbol)).toEqual(['NIFTY', 'BANKNIFTY', 'FINNIFTY']);
  });

  it('maps option symbols to index and side with BANKNIFTY before NIFTY', () => {
    expect(indexNameFromOptionSymbol('BANKNIFTY2590025500CE')).toBe('BANKNIFTY');
    expect(indexNameFromOptionSymbol('NIFTY2590025000PE')).toBe('NIFTY');
    expect(optionSideFromSymbol('NIFTY2590025000CE')).toBe('CE');
    expect(optionSideFromSymbol('NIFTY2590025000PE')).toBe('PE');
  });

  it('keeps the nearest weekly expiry ATM band', () => {
    const contracts = parseNfoIndexOptions([
      {
        instrument_token: 1,
        tradingsymbol: 'NIFTY25SEP25000CE',
        name: 'NIFTY',
        expiry: '2026-09-01',
        strike: 25000,
        instrument_type: 'CE',
      },
      {
        instrument_token: 2,
        tradingsymbol: 'NIFTY25OCT25200CE',
        name: 'NIFTY',
        expiry: '2026-10-06',
        strike: 25200,
        instrument_type: 'CE',
      },
    ]);
    expect(
      filterNearestWeeklyAtmBand(contracts, { NIFTY: 25010 }, { NIFTY: 50 }, '2026-08-31').map(
        (row) => row.tradingsymbol,
      ),
    ).toEqual(['NIFTY25SEP25000CE']);
  });

  it('screens CE only on an uptrend and keeps a single contract', () => {
    const bias = indexOptionBias('NIFTY', risingBars());
    expect(bias.side).toBe('CE');
    const rows = screenIndexOptions({
      contracts: [
        {
          instrumentToken: 1,
          tradingsymbol: 'NIFTY25SEP25000CE',
          name: 'NIFTY',
          expiry: '2026-09-01',
          strike: 25000,
          instrumentType: 'CE',
        },
        {
          instrumentToken: 2,
          tradingsymbol: 'NIFTY25SEP25000PE',
          name: 'NIFTY',
          expiry: '2026-09-01',
          strike: 25000,
          instrumentType: 'PE',
        },
        {
          instrumentToken: 3,
          tradingsymbol: 'NIFTY25SEP25050CE',
          name: 'NIFTY',
          expiry: '2026-09-01',
          strike: 25050,
          instrumentType: 'CE',
        },
        {
          instrumentToken: 4,
          tradingsymbol: 'NIFTY25SEP25100CE',
          name: 'NIFTY',
          expiry: '2026-09-01',
          strike: 25100,
          instrumentType: 'CE',
        },
      ],
      quotes: {
        NIFTY25SEP25000CE: { lastPrice: 120, volume: 50_000, oi: 200_000 },
        NIFTY25SEP25000PE: { lastPrice: 110, volume: 50_000, oi: 200_000 },
        NIFTY25SEP25050CE: { lastPrice: 90, volume: 40_000, oi: 150_000 },
        NIFTY25SEP25100CE: { lastPrice: 40, volume: 10_000, oi: 80_000 },
      },
      biases: [bias],
      spots: { NIFTY: 25010 },
      steps: { NIFTY: 50 },
      newsByIndex: {},
      indexFeatures: {},
    });
    const picked = pickOptionContracts(rows);
    expect(picked.every((row) => row.side === 'CE')).toBe(true);
    expect(picked).toHaveLength(1);
    expect(picked.map((row) => row.symbol)).toEqual(['NIFTY25SEP25000CE']);
  });

  it('exits an option when premium is down 10%', () => {
    const signal = evaluateOptionPlaybook({
      symbol: 'NIFTY25SEP25000CE',
      side: 'CE',
      lastAction: 'BUY',
      allowed: ['HOLD', 'EXIT'],
      lastPrice: 90,
      buyPrice: 100,
      indexDaily: risingBars(),
    });
    expect(signal.bias).toBe('LEAVE');
    expect(signal.suggested).toBe('EXIT');
  });

  it('allows NFO session/start only from the last options universe payload', () => {
    const nfo = {
      instrumentToken: 11,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY25SEP25000CE',
    };
    expect(
      parseSessionStartBody({ instruments: [nfo] }, { nfoAllowlist: [nfo] }).instruments,
    ).toEqual([nfo]);
    expect(() => parseSessionStartBody({ instruments: [nfo] }, { nfoAllowlist: [] })).toThrow(
      /last options universe/,
    );
  });

  it('requires a book flag on the universe payload', () => {
    expect(universeBookBodySchema.parse({ book: 'options' })).toEqual({ book: 'options' });
    expect(() => universeBookBodySchema.parse({})).toThrow();
  });
});
