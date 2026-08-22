import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    llm: {
      newsLookbackDays: 30,
      newsItemsPerSymbol: 8,
    },
  },
}));

const { NewsService, parseNseAnnouncements, parseRssItems, formatIstDdMmYyyy } =
  await import('../src/news/NewsService.js');

describe('parseNseAnnouncements', () => {
  it('maps NSE filing rows to NewsItem records', () => {
    const payload = [
      {
        symbol: 'RELIANCE',
        desc: 'Financial Results',
        attchmntText: 'Audited results for the quarter',
        attchmntFile: 'https://nsearchives.nseindia.com/corporate/RELIANCE.pdf',
        an_dt: '21-Aug-2026 18:30:00',
      },
      { desc: '' },
    ];
    expect(parseNseAnnouncements(payload, 'RELIANCE', 8)).toEqual([
      {
        symbol: 'RELIANCE',
        title: 'Financial Results — Audited results for the quarter',
        link: 'https://nsearchives.nseindia.com/corporate/RELIANCE.pdf',
        publishedAt: '21-Aug-2026 18:30:00',
        source: 'nse-corporate-announcements',
      },
    ]);
  });

  it('reads announcements nested under data', () => {
    const items = parseNseAnnouncements(
      { data: [{ desc: 'Board Meeting', an_dt: '01-Aug-2026' }] },
      'TCS',
      2,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.source).toBe('nse-corporate-announcements');
    expect(items[0]?.link).toContain('symbol=TCS');
  });
});

describe('parseRssItems', () => {
  it('reads Google-style RSS items', () => {
    const xml = `
      <rss><channel>
        <item><title>Reliance earnings</title><link>https://example.com/1</link><pubDate>Fri, 21 Aug 2026 10:00:00 GMT</pubDate></item>
        <item><title></title><link>https://example.com/2</link></item>
      </channel></rss>
    `;
    expect(parseRssItems(xml, 'RELIANCE', 'google-news-rss', 8)).toEqual([
      {
        symbol: 'RELIANCE',
        title: 'Reliance earnings',
        link: 'https://example.com/1',
        publishedAt: 'Fri, 21 Aug 2026 10:00:00 GMT',
        source: 'google-news-rss',
      },
    ]);
  });
});

describe('formatIstDdMmYyyy', () => {
  it('formats an IST calendar date as DD-MM-YYYY', () => {
    expect(formatIstDdMmYyyy(new Date('2026-08-21T18:30:00.000Z'))).toBe('22-08-2026');
  });
});

describe('NewsService fetch priority', () => {
  it('uses NSE corporate announcements first and skips Google when filings exist', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/corporate-announcements')) {
        return {
          ok: true,
          headers: { getSetCookie: () => [] },
          text: async () =>
            JSON.stringify([{ desc: 'Dividend', attchmntFile: 'https://nse/file.pdf', an_dt: '20-Aug-2026' }]),
        };
      }
      return {
        ok: true,
        headers: { getSetCookie: () => ['nsit=abc; Path=/'] },
        text: async () => '<html></html>',
      };
    });

    const news = new NewsService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nseBaseUrl: 'https://nse.test',
      itemsPerSymbol: 4,
      lookbackDays: 30,
    });
    const result = await news.fetchMonthOfNews(['RELIANCE']);

    expect(result[0]?.items[0]?.source).toBe('nse-corporate-announcements');
    expect(result[0]?.items[0]?.title).toContain('Dividend');
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes('news.google.com'))).toBe(false);
  });

  it('falls back to Google News RSS when NSE returns no filings', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/corporate-announcements')) {
        return { ok: true, headers: { getSetCookie: () => [] }, text: async () => '[]' };
      }
      if (url.includes('news.google.com')) {
        return {
          ok: true,
          headers: { getSetCookie: () => [] },
          text: async () =>
            '<rss><channel><item><title>Google headline</title><link>https://g/1</link></item></channel></rss>',
        };
      }
      return { ok: true, headers: { getSetCookie: () => ['nsit=abc'] }, text: async () => '' };
    });

    const news = new NewsService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nseBaseUrl: 'https://nse.test',
    });
    const result = await news.fetchMonthOfNews(['INFY']);

    expect(result[0]?.items).toEqual([
      {
        symbol: 'INFY',
        title: 'Google headline',
        link: 'https://g/1',
        publishedAt: null,
        source: 'google-news-rss',
      },
    ]);
  });

  it('fetches a one-day gap without requiring headlines', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/corporate-announcements')) {
        return { ok: true, headers: { getSetCookie: () => [] }, text: async () => '[]' };
      }
      if (url.includes('news.google.com')) {
        expect(url).toContain('when:1d');
        return { ok: true, headers: { getSetCookie: () => [] }, text: async () => '<rss><channel></channel></rss>' };
      }
      return { ok: true, headers: { getSetCookie: () => ['nsit=abc'] }, text: async () => '' };
    });

    const news = new NewsService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nseBaseUrl: 'https://nse.test',
    });
    const from = new Date('2026-08-22T06:30:00.000Z');
    const result = await news.fetchNewsForRange(['HDFCBANK'], from, from, { requireSome: false });
    expect(result[0]?.items).toEqual([]);
  });
});
