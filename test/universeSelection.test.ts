import { describe, expect, it } from 'vitest';

import { computeFetchWindow } from '../src/universe/dates.js';
import { attachFeatures, rankCandidates } from '../src/universe/features.js';
import type { DailyBar, SymbolKnowledge } from '../src/universe/types.js';

function bars(closeStart: number, closeEnd: number, volume: number, count = 25): DailyBar[] {
  const out: DailyBar[] = [];
  for (let index = 0; index < count; index += 1) {
    const close = closeStart + ((closeEnd - closeStart) * index) / (count - 1);
    out.push({
      d: `2026-07-${String(index + 1).padStart(2, '0')}`,
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
  it('seeds 30 news days and 60 bar days when there is no coverage', () => {
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
