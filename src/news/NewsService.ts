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
  nseBaseUrl?: string;
};

const NSE_BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-IN,en;q=0.9',
} as const;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

export function parseNseAnnouncements(payload: unknown, symbol: string, limit: number): NewsItem[] {
  const root = asRecord(payload);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.announcements)
        ? root.announcements
        : [];

  const items: NewsItem[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) {
      continue;
    }
    const desc = readString(record, ['desc', 'subject', 'attchmntText', 'headline']);
    const detail = readString(record, ['attchmntText', 'details', 'desc']);
    const title = desc && detail && desc !== detail ? `${desc} — ${detail}` : desc || detail;
    if (!title) {
      continue;
    }
    const link =
      readString(record, ['attchmntFile', 'attchmntfile', 'fileUrl', 'url']) ||
      `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`;
    items.push({
      symbol,
      title,
      link,
      publishedAt: readString(record, ['an_dt', 'exchdisstime', 'sort_date', 'datetime']) || null,
      source: 'nse-corporate-announcements',
    });
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

export function formatIstDdMmYyyy(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);
  const day = parts.find((part) => part.type === 'day')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const year = parts.find((part) => part.type === 'year')?.value;
  return `${day}-${month}-${year}`;
}

function mergeSetCookie(headers: Headers, jar: Map<string, string>): void {
  const cookies =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter((value): value is string => Boolean(value));
  for (const header of cookies) {
    for (const part of header.split(/,(?=\s*[^;=]+=[^;]*)/)) {
      const pair = part.split(';')[0]?.trim();
      if (!pair || !pair.includes('=')) {
        continue;
      }
      const [name, ...rest] = pair.split('=');
      if (name) {
        jar.set(name.trim(), rest.join('=').trim());
      }
    }
  }
}

export class NewsService {
  private readonly lookbackDays: number;
  private readonly itemsPerSymbol: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nseBaseUrl: string;
  private cookieHeader: string | undefined;

  public constructor(options: NewsServiceOptions = {}) {
    this.lookbackDays = options.lookbackDays ?? config.llm.newsLookbackDays;
    this.itemsPerSymbol = options.itemsPerSymbol ?? config.llm.newsItemsPerSymbol;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.nseBaseUrl = (options.nseBaseUrl ?? 'https://www.nseindia.com').replace(/\/$/, '');
  }

  public async fetchMonthOfNews(symbols: readonly string[]): Promise<SymbolNews[]> {
    const to = new Date();
    const from = new Date(to.getTime() - this.lookbackDays * 24 * 60 * 60 * 1000);
    return this.fetchNewsForRange(symbols, from, to, { requireSome: true });
  }

  public async fetchNewsForRange(
    symbols: readonly string[],
    from: Date,
    to: Date,
    options: { requireSome?: boolean } = {},
  ): Promise<SymbolNews[]> {
    const unique = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
    await this.ensureNseSession();
    const results: SymbolNews[] = [];
    const concurrency = 4;
    const spanDays = Math.max(
      1,
      Math.ceil(Math.abs(to.getTime() - from.getTime()) / 86_400_000),
    );

    for (let index = 0; index < unique.length; index += concurrency) {
      const chunk = unique.slice(index, index + concurrency);
      const fetched = await Promise.all(
        chunk.map(async (symbol) => ({
          symbol,
          items: await this.fetchForSymbol(symbol, from, to, spanDays),
        })),
      );
      results.push(...fetched);
    }

    const total = results.reduce((sum, entry) => sum + entry.items.length, 0);
    if (options.requireSome && total === 0) {
      throw new Error(
        'News ingest returned zero items. Check NSE corporate announcements and Google News RSS access.',
      );
    }

    return results;
  }

  private async fetchForSymbol(
    symbol: string,
    from: Date,
    to: Date,
    spanDays: number,
  ): Promise<NewsItem[]> {
    const filings = await this.fetchNseAnnouncements(symbol, from, to);
    if (filings.length > 0) {
      return filings;
    }

    const googleUrl =
      `https://news.google.com/rss/search?q=${encodeURIComponent(`${symbol} NSE India stock`)}` +
      `+when:${spanDays}d&hl=en-IN&gl=IN&ceid=IN:en`;
    return this.fetchRss(googleUrl, symbol, 'google-news-rss');
  }

  private async fetchNseAnnouncements(symbol: string, from: Date, to: Date): Promise<NewsItem[]> {
    const params = new URLSearchParams({
      index: 'equities',
      symbol,
      from_date: formatIstDdMmYyyy(from),
      to_date: formatIstDdMmYyyy(to),
    });
    const url = `${this.nseBaseUrl}/api/corporate-announcements?${params.toString()}`;

    try {
      const response = await this.request(url, {
        Accept: 'application/json, text/plain, */*',
        Referer: `${this.nseBaseUrl}/companies-listing/corporate-filings-announcements`,
      });
      if (!response?.ok) {
        return [];
      }
      const text = await response.text();
      if (!text.trim()) {
        return [];
      }
      return parseNseAnnouncements(JSON.parse(text) as unknown, symbol, this.itemsPerSymbol);
    } catch {
      return [];
    }
  }

  private async ensureNseSession(): Promise<void> {
    if (this.cookieHeader) {
      return;
    }
    const jar = new Map<string, string>();
    const warmupPaths = ['/', '/companies-listing/corporate-filings-announcements'];
    for (const path of warmupPaths) {
      const response = await this.request(`${this.nseBaseUrl}${path}`, {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${this.nseBaseUrl}/`,
      });
      if (response) {
        mergeSetCookie(response.headers, jar);
      }
    }
    if (jar.size > 0) {
      this.cookieHeader = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }
  }

  private async fetchRss(url: string, symbol: string, source: string): Promise<NewsItem[]> {
    try {
      const response = await this.request(url, {
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': 'nse-trading-bot/0.1 (personal news ingest)',
      });
      if (!response?.ok) {
        return [];
      }
      const xml = await response.text();
      return parseRssItems(xml, symbol, source, this.itemsPerSymbol);
    } catch {
      return [];
    }
  }

  private async request(url: string, headers: Record<string, string>): Promise<Response | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          ...NSE_BROWSER_HEADERS,
          ...headers,
          ...(this.cookieHeader ? { Cookie: this.cookieHeader } : {}),
        },
        signal: controller.signal,
      });
      return response;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
