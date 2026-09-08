import { describe, expect, it } from 'vitest';

import type { DailyBar } from '../src/universe/types.js';
import {
  GREEKS_IV_ALGORITHMS,
  blackScholesPrice,
  computeOptionGreeks,
  impliedVolatility,
  isOptionPremium,
  realizedHv20,
  strikeFromOptionSymbol,
} from '../src/options/greeksIv.js';
import { applyPlaybookClamp, evaluateGreeksIvPlaybook } from '../src/llm/tradePlaybook.js';

function trendingHvBars(count = 60, start = 24_000): DailyBar[] {
  const out: DailyBar[] = [];
  let close = start;
  const dailyVol = 0.15 / Math.sqrt(252);
  for (let index = 0; index < count; index += 1) {
    close *= 1 + 0.0015 + (index % 2 === 0 ? dailyVol : -dailyVol * 0.7);
    out.push({
      d: `2026-06-${String((index % 28) + 1).padStart(2, '0')}`,
      o: close - 20,
      h: close + 30,
      l: close - 30,
      c: close,
      v: 1_000_000,
    });
  }
  return out;
}

describe('greeks IV helpers', () => {
  it('parses the last five strike digits and rejects index-like LTP', () => {
    expect(strikeFromOptionSymbol('NIFTY25SEP25000CE')).toBe(25_000);
    expect(strikeFromOptionSymbol('BANKNIFTY2590025500CE')).toBe(25_500);
    expect(isOptionPremium(120, 25_010)).toBe(true);
    expect(isOptionPremium(25_010, 25_010)).toBe(false);
    expect(isOptionPremium(0, 25_010)).toBe(false);
  });

  it('inverts Black-Scholes IV near the input sigma', () => {
    const spot = 25_000;
    const strike = 25_000;
    const timeYears = 30 / 365;
    const sigma = 0.16;
    const premium = blackScholesPrice(spot, strike, timeYears, 0.065, sigma, 'CE');
    const iv = impliedVolatility({ premium, spot, strike, timeYears, side: 'CE' });
    expect(iv).toBeGreaterThan(0.1);
    expect(Math.abs((iv ?? 0) - sigma)).toBeLessThan(0.02);
  });

  it('computes HV20 on noisy index bars', () => {
    const hv = realizedHv20(trendingHvBars());
    expect(hv).toBeGreaterThan(0.05);
  });
});

describe('evaluateGreeksIvPlaybook', () => {
  const indexDaily = trendingHvBars();
  const spot = indexDaily.at(-1)!.c;
  const strike = Math.round(spot / 50) * 50;
  const timeYears = 30 / 365;
  const premium = blackScholesPrice(spot, strike, timeYears, 0.065, 0.15, 'CE');
  const greeks = computeOptionGreeks({
    premium,
    spot,
    strike,
    expiryYmd: '2026-10-06',
    asOfYmd: '2026-09-07',
    side: 'CE',
    indexDaily,
  });

  it('never treats index spot as option LTP', () => {
    const signal = evaluateGreeksIvPlaybook({
      symbol: 'NIFTY25SEP25000CE',
      side: 'CE',
      lastAction: 'BUY',
      allowed: ['HOLD', 'EXIT'],
      lastPrice: spot,
      buyPrice: 120,
      indexDaily,
      spot,
      strike,
      expiryYmd: '2026-10-06',
      asOfYmd: '2026-09-07',
      algorithm: 'greeks_iv_atm',
    });
    expect(signal.lastPrice).toBeNull();
    expect(signal.bias).toBe('STAY');
  });

  it('exits when premium is down 10%', () => {
    const signal = evaluateGreeksIvPlaybook({
      symbol: 'NIFTY25SEP25000CE',
      side: 'CE',
      lastAction: 'BUY',
      allowed: ['HOLD', 'EXIT'],
      lastPrice: 90,
      buyPrice: 100,
      indexDaily,
      spot,
      strike,
      expiryYmd: '2026-10-06',
      asOfYmd: '2026-09-07',
      algorithm: 'greeks_iv_atm',
    });
    expect(signal.bias).toBe('LEAVE');
    expect(signal.suggested).toBe('EXIT');
  });

  it('waits when algorithm is greeks_iv_skip', () => {
    const signal = evaluateGreeksIvPlaybook({
      symbol: 'NIFTY25SEP25000CE',
      side: 'CE',
      lastAction: null,
      allowed: ['BUY', 'SKIP'],
      lastPrice: premium,
      buyPrice: null,
      indexDaily,
      spot,
      strike,
      expiryYmd: '2026-10-06',
      asOfYmd: '2026-09-07',
      algorithm: 'greeks_iv_skip',
    });
    expect(signal.bias).toBe('WAIT');
    expect(signal.suggested).toBe('SKIP');
  });

  it('can ENTER on greeks_iv_atm when delta and IV/HV fit', () => {
    expect(greeks.absDelta).not.toBeNull();
    const signal = evaluateGreeksIvPlaybook({
      symbol: 'NIFTY25SEP25000CE',
      side: 'CE',
      lastAction: null,
      allowed: ['BUY', 'SKIP'],
      lastPrice: premium,
      buyPrice: null,
      indexDaily,
      spot,
      strike,
      expiryYmd: '2026-10-06',
      asOfYmd: '2026-09-07',
      algorithm: 'greeks_iv_atm',
    });
    if (greeks.absDelta !== null && greeks.absDelta >= 0.4 && greeks.absDelta <= 0.7 && (greeks.ivHv ?? 99) <= 1.15) {
      expect(signal.bias).toBe('ENTER');
      expect(signal.suggested).toBe('BUY');
    } else {
      expect(signal.bias).toBe('WAIT');
    }
  });
});

describe('greeks_iv labeled replay precision', () => {
  const indexDaily = trendingHvBars();
  const spot = indexDaily.at(-1)!.c;
  const strike = Math.round(spot / 50) * 50;

  const labeled = [
    { lastAction: null as const, lastPrice: null as number | null, buyPrice: null as number | null, algorithm: 'greeks_iv_atm' as const, llm: 'BUY' as const },
    { lastAction: null, lastPrice: 120, buyPrice: null, algorithm: 'greeks_iv_skip' as const, llm: 'BUY' as const },
    { lastAction: 'BUY' as const, lastPrice: 90, buyPrice: 100, algorithm: 'greeks_iv_atm' as const, llm: 'HOLD' as const },
    { lastAction: 'BUY' as const, lastPrice: 125, buyPrice: 100, algorithm: 'greeks_iv_atm' as const, llm: 'HOLD' as const },
    { lastAction: 'HOLD' as const, lastPrice: 88, buyPrice: 100, algorithm: 'greeks_iv_otm' as const, llm: 'HOLD' as const },
    { lastAction: null, lastPrice: 25_000, buyPrice: null, algorithm: 'greeks_iv_atm' as const, llm: 'BUY' as const },
    { lastAction: 'BUY' as const, lastPrice: null, buyPrice: 100, algorithm: 'greeks_iv_atm' as const, llm: 'HOLD' as const },
    { lastAction: null, lastPrice: 110, buyPrice: null, algorithm: 'unknown' as const, llm: 'BUY' as const },
    { lastAction: 'HOLD' as const, lastPrice: 121, buyPrice: 100, algorithm: 'greeks_iv_atm' as const, llm: 'EXIT' as const },
    { lastAction: null, lastPrice: 95, buyPrice: null, algorithm: 'greeks_iv_otm' as const, llm: 'SKIP' as const },
    { lastAction: 'BUY' as const, lastPrice: 70, buyPrice: 100, algorithm: 'greeks_iv_atm' as const, llm: 'HOLD' as const },
    { lastAction: 'BUY' as const, lastPrice: 130, buyPrice: 100, algorithm: 'greeks_iv_atm' as const, llm: 'HOLD' as const },
    { lastAction: null, lastPrice: 80, buyPrice: null, algorithm: 'greeks_iv_atm' as const, llm: 'SKIP' as const },
    { lastAction: 'HOLD' as const, lastPrice: 99, buyPrice: 100, algorithm: 'greeks_iv_atm' as const, llm: 'HOLD' as const },
    { lastAction: null, lastPrice: 105, buyPrice: null, algorithm: 'greeks_iv_skip' as const, llm: 'SKIP' as const },
    { lastAction: 'BUY' as const, lastPrice: 101, buyPrice: 100, algorithm: 'greeks_iv_otm' as const, llm: 'EXIT' as const },
    { lastAction: null, lastPrice: 115, buyPrice: null, algorithm: 'greeks_iv_atm' as const, llm: 'SKIP' as const },
    { lastAction: 'HOLD' as const, lastPrice: 92, buyPrice: 100, algorithm: 'greeks_iv_atm' as const, llm: 'HOLD' as const },
    { lastAction: 'BUY' as const, lastPrice: 50, buyPrice: 100, algorithm: 'greeks_iv_atm' as const, llm: 'HOLD' as const },
    { lastAction: null, lastPrice: 140, buyPrice: null, algorithm: 'greeks_iv_otm' as const, llm: 'BUY' as const },
  ];

  it('clamped actions match the bound playbook on at least 98% of rows', () => {
    let matches = 0;
    for (const row of labeled) {
      const allowed =
        row.lastAction === 'BUY' || row.lastAction === 'HOLD'
          ? (['HOLD', 'EXIT'] as const)
          : (['BUY', 'SKIP'] as const);
      const signal = evaluateGreeksIvPlaybook({
        symbol: 'NIFTY25SEP25000CE',
        side: 'CE',
        lastAction: row.lastAction,
        allowed: [...allowed],
        lastPrice: row.lastPrice,
        buyPrice: row.buyPrice,
        indexDaily,
        spot,
        strike,
        expiryYmd: '2026-10-06',
        asOfYmd: '2026-09-07',
        algorithm: row.algorithm,
      });
      const { batch } = applyPlaybookClamp(
        {
          decisions: [{ symbol: 'NIFTY25SEP25000CE', action: row.llm, rationale: 'llm' }],
        },
        [signal],
        new Map([['NIFTY25SEP25000CE', [...allowed]]]),
      );
      const stored = batch.decisions[0]?.action;
      const expected =
        signal.bias === 'LEAVE' && allowed.includes('EXIT')
          ? 'EXIT'
          : row.llm === 'BUY' && signal.bias === 'WAIT' && allowed.includes('SKIP')
            ? 'SKIP'
            : row.llm;
      if (stored === expected) {
        matches += 1;
      }
    }
    expect(matches / labeled.length).toBeGreaterThanOrEqual(0.98);
    expect(GREEKS_IV_ALGORITHMS).toContain('greeks_iv_atm');
  });
});
