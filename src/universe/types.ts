import type { NewsItem } from '../news/NewsService.js';

export type DailyBar = {
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type FeatureSnapshot = {
  sma20: number | null;
  sma50: number | null;
  atrPct: number | null;
  rsNifty20: number | null;
  volVs20: number | null;
  distFrom20HighPct: number | null;
  ret20Pct: number | null;
  eventScore: number;
  score: number;
};

export type SymbolKnowledge = {
  symbol: string;
  instrumentToken: number;
  filings: NewsItem[];
  bars: DailyBar[];
  features: FeatureSnapshot | null;
};

export type UniverseKnowledgeFile = {
  generatedAt: string;
  asOfIst: string;
  coverageFrom: string;
  coverageTo: string;
  fetchedFrom: string | null;
  fetchedTo: string | null;
  catalogPath: string;
  symbols: Record<string, SymbolKnowledge>;
};

export type UniverseCandidate = {
  symbol: string;
  score: number;
  features: FeatureSnapshot;
  filings: Array<{ k: string; d: string; t: string; src: string }>;
};
