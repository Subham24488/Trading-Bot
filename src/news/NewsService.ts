import { config } from '../config.js';

export type NewsItem = {
  symbol: string;
  title: string;
  link: string;
  publishedAt: string | null;
  source: string;
};

export type SymbolNews = {
  symbol: string;
  items: NewsItem[];
};

export type NewsServiceOptions = {
  lookbackDays?: number;
  itemsPerSymbol?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function decodeXml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('<![CDATA[', '')
    .replaceAll(']]>', '');
}

function tagValue(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1] ? decodeXml(match[1].trim()) : '';
}

export function parseRssItems(xml: string, symbol: string, source: string, limit: number): NewsItem[] {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const items: NewsItem[] = [];
  for (const block of blocks) {
    const title = tagValue(block, 'title');
    if (!title) {
      continue;
    }
    items.push({
      symbol,
      title,
      link: tagValue(block, 'link'),
      publishedAt: tagValue(block, 'pubDate') || null,
      source,
    });
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

export class NewsService {
  private readonly lookbackDays: number;
  private readonly itemsPerSymbol: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: NewsServiceOptions = {}) {
    this.lookbackDays = options.lookbackDays ?? config.llm.newsLookbackDays;
    this.itemsPerSymbol = options.itemsPerSymbol ?? config.llm.newsItemsPerSymbol;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  public async fetchMonthOfNews(symbols: readonly string[]): Promise<SymbolNews[]> {
    const unique = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
    const results: SymbolNews[] = [];
    const concurrency = 6;

    for (let index = 0; index < unique.length; index += concurrency) {
      const chunk = unique.slice(index, index + concurrency);
      const fetched = await Promise.all(
        chunk.map(async (symbol) => ({ symbol, items: await this.fetchForSymbol(symbol) })),
      );
      results.push(...fetched);
    }

    const total = results.reduce((sum, entry) => sum + entry.items.length, 0);
    if (total === 0) {
      throw new Error(
        'News ingest returned zero headlines for the Kite instrument catalog. Check outbound HTTPS access to Google News / Yahoo Finance RSS.',
      );
    }

    return results;
  }

  private async fetchForSymbol(symbol: string): Promise<NewsItem[]> {
    const googleUrl =
      `https://news.google.com/rss/search?q=${encodeURIComponent(`${symbol} NSE India stock`)}` +
      `+when:${this.lookbackDays}d&hl=en-IN&gl=IN&ceid=IN:en`;
    const yahooUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(`${symbol}.NS`)}&region=IN&lang=en-IN`;

    const google = await this.fetchRss(googleUrl, symbol, 'google-news-rss');
    if (google.length > 0) {
      return google;
    }
    return this.fetchRss(yahooUrl, symbol, 'yahoo-finance-rss');
  }

  private async fetchRss(url: string, symbol: string, source: string): Promise<NewsItem[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          headers: { 'User-Agent': 'nse-trading-bot/0.1 (personal news ingest)' },
          signal: controller.signal,
        });
        if (!response.ok) {
          return [];
        }
        const xml = await response.text();
        return parseRssItems(xml, symbol, source, this.itemsPerSymbol);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return [];
    }
  }
}
