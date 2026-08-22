import type { SymbolNews } from '../news/NewsService.js';
import type { UniverseCandidate } from '../universe/types.js';
import type { QuoteLogSnapshot } from './quoteLogReader.js';
import type { LlmTradeActionName } from './schemas.js';
import { promptActionLabels } from './schemas.js';

/** Keep completion small so input+output stays under typical 40k context. */
export const UNIVERSE_MAX_OUTPUT_TOKENS = 700;
export const DECISION_MAX_OUTPUT_TOKENS = 400;

const MAX_NEWS_ROWS = 48;
const MAX_HEADLINES_PER_SYMBOL = 3;
const NSE_TITLE_CHARS = 200;
const GOOGLE_TITLE_CHARS = 120;
const MAX_UNIVERSE_USER_CHARS = 12_000;
const MAX_DECISION_SNAPSHOTS = 2;

export type FilingKind =
  | 'RESULT'
  | 'DIVIDEND'
  | 'BUYBACK'
  | 'MERGER'
  | 'DEFAULT'
  | 'RAISE'
  | 'INSIDER'
  | 'BOARD'
  | 'OTHER';

export type CompactNewsRow = {
  s: string;
  k: FilingKind;
  src: 'nse' | 'g';
  d: string;
  t: string;
};

const KIND_PATTERNS: Array<{ kind: FilingKind; pattern: RegExp; weight: number }> = [
  { kind: 'DEFAULT', pattern: /\b(default|insolvency|npa|downgrade|sebi.?order|ban)\b/i, weight: 12 },
  { kind: 'MERGER', pattern: /\b(merger|amalgamat|acquire|acquisition|takeover|demerger)\b/i, weight: 11 },
  { kind: 'BUYBACK', pattern: /\b(buy.?back|delisting)\b/i, weight: 10 },
  { kind: 'RESULT', pattern: /\b(financial results?|quarterly|q[1-4]\b|earnings|profit|loss|audited)\b/i, weight: 10 },
  { kind: 'DIVIDEND', pattern: /\b(dividend|interim|bonus|split|record date)\b/i, weight: 9 },
  { kind: 'RAISE', pattern: /\b(qip|preferential|fund rais|rights issue|ncd|fccb)\b/i, weight: 8 },
  { kind: 'INSIDER', pattern: /\b(insider|sast|bulk.?deal|block.?deal|pledged?)\b/i, weight: 7 },
  { kind: 'BOARD', pattern: /\b(board meeting|outcome of board|agm|egm)\b/i, weight: 5 },
];

export function classifyFilingKind(title: string): FilingKind {
  for (const entry of KIND_PATTERNS) {
    if (entry.pattern.test(title)) {
      return entry.kind;
    }
  }
  return 'OTHER';
}

export function kindWeight(kind: FilingKind): number {
  return KIND_PATTERNS.find((entry) => entry.kind === kind)?.weight ?? 1;
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function shortDate(value: string | null): string {
  if (!value) {
    return '';
  }
  const iso = value.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) {
    return iso[0];
  }
  const dmy = value.match(/(\d{1,2})[-/ ]([A-Za-z]{3}|\d{1,2})[-/ ](\d{2,4})/);
  return dmy ? dmy[0] : clip(value, 11);
}

function sourceTag(source: string): 'nse' | 'g' {
  return source.includes('nse') ? 'nse' : 'g';
}

function itemScore(title: string, source: string): number {
  const kind = classifyFilingKind(title);
  return kindWeight(kind) + (source.includes('nse') ? 3 : 0);
}

function toRow(
  symbol: string,
  title: string,
  source: string,
  publishedAt: string | null,
): CompactNewsRow {
  const src = sourceTag(source);
  return {
    s: symbol,
    k: classifyFilingKind(title),
    src,
    d: shortDate(publishedAt),
    t: clip(title, src === 'nse' ? NSE_TITLE_CHARS : GOOGLE_TITLE_CHARS),
  };
}

function payloadSize(rows: CompactNewsRow[]): number {
  return JSON.stringify(rows).length;
}

function trimToBudget(rows: CompactNewsRow[]): CompactNewsRow[] {
  const next = [...rows];
  const dropIf = (predicate: (row: CompactNewsRow, index: number) => boolean) => {
    for (let index = next.length - 1; index >= 0 && payloadSize(next) > MAX_UNIVERSE_USER_CHARS; index -= 1) {
      if (predicate(next[index]!, index)) {
        next.splice(index, 1);
      }
    }
  };

  dropIf((row) => row.src === 'g' && row.k === 'OTHER');
  dropIf((row) => row.k === 'OTHER' && next.some((other) => other.s === row.s && other.k !== 'OTHER'));
  dropIf((row) => {
    const forSymbol = next.filter((other) => other.s === row.s);
    return forSymbol.length > 1 && row.k === 'BOARD';
  });

  while (payloadSize(next) > MAX_UNIVERSE_USER_CHARS && next.length > 0) {
    const ranked = [...next.entries()].sort((left, right) => itemScore(left[1].t, left[1].src) - itemScore(right[1].t, right[1].src));
    const weakest = ranked[0];
    if (!weakest) {
      break;
    }
    next.splice(weakest[0], 1);
  }

  return next;
}

export function compactNewsForPrompt(news: readonly SymbolNews[]): CompactNewsRow[] {
  const perSymbol = new Map<string, CompactNewsRow[]>();

  for (const entry of news) {
    const rankedItems = [...entry.items].sort(
      (left, right) => itemScore(right.title, right.source) - itemScore(left.title, left.source),
    );
    const rows: CompactNewsRow[] = [];
    for (const item of rankedItems) {
      if (rows.length >= MAX_HEADLINES_PER_SYMBOL) {
        break;
      }
      const kind = classifyFilingKind(item.title);
      const hasMaterial = rows.some((row) => row.k !== 'OTHER');
      if (kind === 'OTHER' && hasMaterial) {
        continue;
      }
      rows.push(toRow(entry.symbol, item.title, item.source, item.publishedAt));
    }
    if (rows.length > 0) {
      perSymbol.set(entry.symbol, rows);
    }
  }

  const symbolsByStrength = [...perSymbol.entries()].sort((left, right) => {
    const score = (rows: CompactNewsRow[]) => rows.reduce((sum, row) => sum + kindWeight(row.k) + (row.src === 'nse' ? 3 : 0), 0);
    return score(right[1]) - score(left[1]);
  });

  const selected: CompactNewsRow[] = [];
  for (const [, rows] of symbolsByStrength) {
    if (selected.length >= MAX_NEWS_ROWS) {
      break;
    }
    selected.push(...rows.slice(0, Math.min(rows.length, MAX_NEWS_ROWS - selected.length)));
  }

  return trimToBudget(selected);
}

export function compactSnapshotsForPrompt(snapshots: readonly QuoteLogSnapshot[]) {
  return snapshots.slice(-MAX_DECISION_SNAPSHOTS).map((snapshot) => ({
    ts: snapshot.ts,
    q: snapshot.instruments.map((instrument) => ({
      s: instrument.tradingsymbol,
      ltp: instrument.lastPrice,
      o: instrument.open,
      h: instrument.high,
      l: instrument.low,
      c: instrument.close,
      ch: instrument.change,
      v: instrument.volume,
    })),
  }));
}

export function buildUniverseMessages(
  asOfIst: string,
  candidates: readonly UniverseCandidate[],
): Array<{ role: 'system' | 'user'; content: string }> {
  const allowed = candidates.map((candidate) => candidate.symbol);
  const compact = candidates.map((candidate) => ({
    s: candidate.symbol,
    score: candidate.score,
    sma20: candidate.features.sma20,
    sma50: candidate.features.sma50,
    rs: candidate.features.rsNifty20,
    vol: candidate.features.volVs20,
    distH: candidate.features.distFrom20HighPct,
    ev: candidate.features.eventScore,
    n: candidate.filings,
  }));

  return [
    {
      role: 'system',
      content:
        'NSE cash-equity desk. Ranked candidates already passed liquidity and structure filters. ' +
        'Pick at most 2 include=true names from allowed[] that combine (1) real catalyst in n[] (RESULT,BUYBACK,DEFAULT,RAISE, not shell MERGER/incorporation) and (2) rs/sma20>sma50 or vol. ' +
        'Zero includes is valid if nothing qualifies. JSON only: {watchlist:[{symbol,include,rationale,rank}]}. rank 1 or 2. No live orders. /no_think',
    },
    {
      role: 'user',
      content: JSON.stringify({ asOfIst, allowed, maxInclude: 2, c: compact }),
    },
  ];
}

export type DecisionAllowedRow = {
  symbol: string;
  last: LlmTradeActionName | null;
  allowed: readonly LlmTradeActionName[];
};

export function buildDecisionMessages(
  asOfIst: string,
  watchlistSymbols: readonly string[],
  snapshots: readonly QuoteLogSnapshot[],
  allowedRows: readonly DecisionAllowedRow[] = [],
): Array<{ role: 'system' | 'user'; content: string }> {
  const bySymbol = new Map(allowedRows.map((row) => [row.symbol, row]));
  const allowed = watchlistSymbols.map((symbol) => {
    const row = bySymbol.get(symbol);
    const stored = row?.allowed ?? (['BUY', 'SKIP'] as const);
    return {
      s: symbol,
      last: row?.last ?? null,
      opts: promptActionLabels([...stored]),
    };
  });

  return [
    {
      role: 'system',
      content:
        'NSE paper assistant. For every wl symbol pick action only from that symbol opts. ' +
        'When opts include SKIP, not taking a trade is valid — do not force BUY. ' +
        'Do not invent other actions. Use quote bars (ltp, ohlc, ch, v). ' +
        'JSON only: {decisions:[{symbol,action,rationale}]}. One row per wl name. Rationale ≤12 words. No live orders. /no_think',
    },
    {
      role: 'user',
      content: JSON.stringify({
        asOfIst,
        wl: watchlistSymbols,
        allowed,
        q: compactSnapshotsForPrompt(snapshots),
      }),
    },
  ];
}
