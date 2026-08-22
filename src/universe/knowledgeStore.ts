import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { tradesFileName } from '../llm/decisionStore.js';
import type { NewsItem } from '../news/NewsService.js';
import { attachFeatures } from './features.js';
import type { DailyBar, SymbolKnowledge, UniverseKnowledgeFile } from './types.js';

const knowledgeSchemaHint = 'coverageTo';

function universeDir(): string {
  return path.resolve(config.llm.universeDir);
}

function isKnowledgeFile(value: unknown): value is UniverseKnowledgeFile {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record[knowledgeSchemaHint] === 'string' && typeof record.symbols === 'object';
}

export async function readLatestKnowledge(
  directory = universeDir(),
): Promise<UniverseKnowledgeFile | null> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }

  const jsonFiles = names.filter((name) => name.endsWith('.json')).sort();
  let latest: UniverseKnowledgeFile | null = null;
  for (const name of jsonFiles) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (!isKnowledgeFile(parsed)) {
        continue;
      }
      if (!latest || parsed.coverageTo > latest.coverageTo) {
        latest = parsed;
      }
    } catch {
      // Skip corrupt files.
    }
  }
  return latest;
}

export function mergeBars(existing: DailyBar[], incoming: DailyBar[], keep = 60): DailyBar[] {
  const byDate = new Map<string, DailyBar>();
  for (const bar of [...existing, ...incoming]) {
    byDate.set(bar.d, bar);
  }
  return [...byDate.values()].sort((left, right) => left.d.localeCompare(right.d)).slice(-keep);
}

export function mergeFilings(existing: NewsItem[], incoming: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const item of [...existing, ...incoming]) {
    const key = `${item.publishedAt ?? ''}|${item.title}|${item.link}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }
  return merged.slice(-40);
}

export function mergeKnowledge(options: {
  previous: UniverseKnowledgeFile | null;
  asOfIst: string;
  today: string;
  coverageFrom: string;
  fetchedFrom: string | null;
  fetchedTo: string | null;
  catalogPath: string;
  news: Array<{ symbol: string; items: NewsItem[] }>;
  bars: Record<string, DailyBar[]>;
  tokens: Record<string, number>;
}): UniverseKnowledgeFile {
  const symbols: Record<string, SymbolKnowledge> = { ...(options.previous?.symbols ?? {}) };
  const newsBySymbol = new Map(options.news.map((entry) => [entry.symbol, entry.items]));
  const allSymbols = new Set([
    ...Object.keys(symbols),
    ...Object.keys(options.bars),
    ...newsBySymbol.keys(),
    ...Object.keys(options.tokens),
  ]);

  for (const symbol of allSymbols) {
    const prior = symbols[symbol];
    symbols[symbol] = {
      symbol,
      instrumentToken: options.tokens[symbol] ?? prior?.instrumentToken ?? 0,
      filings: mergeFilings(prior?.filings ?? [], newsBySymbol.get(symbol) ?? []),
      bars: mergeBars(prior?.bars ?? [], options.bars[symbol] ?? []),
      features: null,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    asOfIst: options.asOfIst,
    coverageFrom: options.previous?.coverageFrom ?? options.coverageFrom,
    coverageTo: options.today,
    fetchedFrom: options.fetchedFrom,
    fetchedTo: options.fetchedTo,
    catalogPath: options.catalogPath,
    symbols: attachFeatures(symbols),
  };
}

export async function writeKnowledgeFile(
  payload: UniverseKnowledgeFile,
  directory = universeDir(),
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, tradesFileName());
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}
