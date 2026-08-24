import { describe, expect, it } from 'vitest';

import { computeFetchWindow } from '../src/universe/dates.js';
import { attachFeatures, rankCandidates } from '../src/universe/features.js';
import type { DailyBar, SymbolKnowledge } from '../src/universe/types.js';

function bars(closeStart: number, closeEnd: number, volume: number, count = 25): DailyBar[] {
  const out: DailyBar[] = [];
  for (let index = 0; index < count; index += 1) {
    const close = closeStart + ((closeEnd - closeStart) * index) / Math.max(count - 1, 1);
    out.push({
      d: `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
      o: close,
      h: close + 1,
      l: close - 1,
      c: close,
      v: volume,
    });
  }
  return out;
}

function knowledge(
  symbol: string,
  closeStart: number,
  closeEnd: number,
  title: string,
  volume = 1_000_000,
): SymbolKnowledge {
  return {
    symbol,
    instrumentToken: 1,
    filings: [
      {
        symbol,
        title,
        link: `https://nse.test/${symbol}`,
        publishedAt: '21-Aug-2026',
        source: 'nse-corporate-announcements',
      },
    ],
    bars: bars(closeStart, closeEnd, volume),
    features: null,
  };
}

describe('computeFetchWindow', () => {
  it('seeds 30 news days and the requested bar lookback when there is no coverage', () => {
    const window = computeFetchWindow(null, '2026-08-22', 30, 60);
    expect(window.isSeed).toBe(true);
    expect(window.skipRemote).toBe(false);
    expect(window.newsFrom).toBe('2026-07-23');
    expect(window.barsFrom).toBe('2026-06-23');
    expect(window.newsTo).toBe('2026-08-22');
  });

  it('fetches only the missing calendar day when coverage ended yesterday', () => {
    const window = computeFetchWindow('2026-08-21', '2026-08-22', 30, 60);
    expect(window.isSeed).toBe(false);
    expect(window.skipRemote).toBe(false);
    expect(window.newsFrom).toBe('2026-08-22');
    expect(window.newsTo).toBe('2026-08-22');
    expect(window.barsFrom).toBe('2026-08-22');
  });

  it('skips remote fetches when coverage is already today', () => {
    const window = computeFetchWindow('2026-08-22', '2026-08-22', 30, 60);
    expect(window.skipRemote).toBe(true);
  });
});

describe('rankCandidates', () => {
  it('prefers higher relative strength plus a RESULT filing over empty OTHER news', () => {
    const symbols: Record<string, SymbolKnowledge> = {
      NIFTYBEES: {
        symbol: 'NIFTYBEES',
        instrumentToken: 2,
        filings: [],
        bars: bars(100, 101, 500_000),
        features: null,
      },
      RELIANCE: knowledge('RELIANCE', 100, 120, 'Audited financial results for the quarter'),
      TCS: knowledge('TCS', 100, 95, 'Updates'),
    };

    const withFeatures = attachFeatures(symbols);
    const ranked = rankCandidates(withFeatures, 8);
    expect(ranked[0]?.symbol).toBe('RELIANCE');
    expect(ranked.find((row) => row.symbol === 'RELIANCE')?.features.eventScore).toBeGreaterThan(
      ranked.find((row) => row.symbol === 'TCS')?.features.eventScore ?? 0,
    );
  });
});

describe('evaluatePlaybook', () => {
  it('blocks a new BUY when 15m tape is below VWAP even if daily trend is up', async () => {
    const { evaluatePlaybook, applyPlaybookClamp } = await import('../src/llm/tradePlaybook.js');
    const daily = bars(100, 130, 1_000_000, 55);
    const nifty = bars(100, 105, 500_000, 55);
    const minutes15 = [
      { t: '2026-08-24T03:45:00.000Z', o: 130, h: 131, l: 128, c: 128, v: 10_000 },
      { t: '2026-08-24T04:00:00.000Z', o: 128, h: 129, l: 120, c: 121, v: 80_000 },
    ];
    const signal = evaluatePlaybook({
      symbol: 'RELIANCE',
      lastAction: null,
      allowed: ['BUY', 'SKIP'],
      lastPrice: 121,
      buyPrice: null,
      daily,
      niftyDaily: nifty,
      minutes15,
    });
    expect(signal.suggested).toBe('SKIP');
    expect(signal.bias).toBe('WAIT');

    const clamped = applyPlaybookClamp(
      { decisions: [{ symbol: 'RELIANCE', action: 'BUY', rationale: 'llm wanted long' }] },
      [signal],
      new Map([['RELIANCE', ['BUY', 'SKIP']]]),
    );
    expect(clamped.batch.decisions[0]?.action).toBe('SKIP');
  });

  it('forces EXIT at a -10% stop even if the model wants HOLD', async () => {
    const { evaluatePlaybook, applyPlaybookClamp } = await import('../src/llm/tradePlaybook.js');
    const daily = bars(100, 90, 1_000_000, 55);
    const signal = evaluatePlaybook({
      symbol: 'RELIANCE',
      lastAction: 'BUY',
      allowed: ['HOLD', 'EXIT'],
      lastPrice: 89,
      buyPrice: 100,
      daily,
      niftyDaily: bars(100, 101, 500_000, 55),
      minutes15: [],
    });
    expect(signal.bias).toBe('LEAVE');
    const clamped = applyPlaybookClamp(
      { decisions: [{ symbol: 'RELIANCE', action: 'HOLD', rationale: 'wait' }] },
      [signal],
      new Map([['RELIANCE', ['HOLD', 'EXIT']]]),
    );
    expect(clamped.batch.decisions[0]?.action).toBe('EXIT');
  });
});
