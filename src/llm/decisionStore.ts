import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LlmTradeAction, Prisma } from '@prisma/client';

import { config } from '../config.js';
import { database } from '../database.js';
import type { DecisionBatch } from './schemas.js';
import type { UniverseSuggestion } from './schemas.js';
import type { SessionInstrument } from '../domain.js';
import type { GreeksIvAlgorithmId, OptionContractMeta } from '../options/greeksIv.js';

export type StoredUniverseFile = {
  generatedAt: string;
  asOfIst: string;
  model: string;
  book?: 'equity' | 'options';
  newsItemCount: number;
  suggestion: UniverseSuggestion;
  includedSymbols: string[];
  sessionStartPayload: { instruments: SessionInstrument[] };
  unmappedSymbols: string[];
  knowledgeFile?: string | null;
  candidateSymbols?: string[];
  algorithmsBySymbol?: Record<string, GreeksIvAlgorithmId>;
  optionContracts?: OptionContractMeta[];
};

export function formatIstTimestamp(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}:${read('second')}+05:30`;
}

export function tradesFileName(date: Date = new Date()): string {
  return `${date.toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`;
}

export async function writeUniverseFile(payload: StoredUniverseFile): Promise<string> {
  const directory = path.resolve(config.llm.tradesDir);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, tradesFileName());
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

export const LLM_EXECUTION_BLOCKED_REASON = 'LLM decisions are never sent to the broker.';

/** Optional audit fields: rule score as confidence, and the LLM call behind a strike pick. */
export type DecisionMeta = {
  confidence?: number;
  model?: string;
  promptHash?: string;
  rawCompletion?: string;
};

export type DecisionRowInput = {
  asOf: Date;
  batch: DecisionBatch;
  lastPriceBySymbol?: Record<string, number | null>;
  priorBuyPriceBySymbol?: Record<string, string | null>;
  tokenBySymbol?: Record<string, number | null>;
  marketSnapshotBySymbol?: Record<string, Record<string, unknown>>;
  metaBySymbol?: Record<string, DecisionMeta>;
  /** Trade id for BUY/HOLD/EXIT rows; never written on SKIP. */
  tuuidBySymbol?: Record<string, string>;
  /** Set for a simulated replay: rows are flagged and dated at the virtual `asOf`. */
  simulationId?: string;
};

/** Live reads see only live rows; a simulation sees only its own run. */
function runFilter(simulationId?: string): Prisma.LlmTradeDecisionWhereInput {
  return simulationId ? { simulationId } : { simulated: false };
}

export function pricesForDecision(
  action: DecisionBatch['decisions'][number]['action'],
  lastPrice: number | null | undefined,
  priorBuyPrice: string | null | undefined,
): { buyPrice: string | null; sellPrice: string | null } {
  const quote =
    lastPrice !== null && lastPrice !== undefined && Number.isFinite(lastPrice)
      ? lastPrice.toFixed(4)
      : null;
  if (action === 'BUY') {
    return { buyPrice: quote, sellPrice: null };
  }
  if (action === 'HOLD') {
    return { buyPrice: priorBuyPrice ?? quote, sellPrice: null };
  }
  if (action === 'SKIP') {
    return { buyPrice: null, sellPrice: null };
  }
  return { buyPrice: priorBuyPrice ?? null, sellPrice: quote };
}

export async function persistDecisions(input: DecisionRowInput): Promise<number> {
  if (input.batch.decisions.length === 0) {
    return 0;
  }

  const data = input.batch.decisions.map((decision) => {
    const prices = pricesForDecision(
      decision.action,
      input.lastPriceBySymbol?.[decision.symbol] ?? null,
      input.priorBuyPriceBySymbol?.[decision.symbol] ?? null,
    );
    const current = input.lastPriceBySymbol?.[decision.symbol];
    const token = input.tokenBySymbol?.[decision.symbol];
    const meta = input.metaBySymbol?.[decision.symbol];
    const tuuid = decision.action === 'SKIP' ? undefined : input.tuuidBySymbol?.[decision.symbol];
    const currentPrice =
      current !== null && current !== undefined && Number.isFinite(current)
        ? current.toFixed(4)
        : null;
    return {
      asOf: input.asOf,
      symbol: decision.symbol,
      action: decision.action,
      rationale: decision.rationale,
      executed: false as const,
      executionBlockedReason: LLM_EXECUTION_BLOCKED_REASON,
      promptHash: meta?.promptHash ?? '',
      rawCompletion: meta?.rawCompletion ?? '',
      ...(meta?.model ? { model: meta.model } : {}),
      ...(meta?.confidence !== undefined && Number.isFinite(meta.confidence)
        ? { confidence: meta.confidence.toFixed(4) }
        : {}),
      marketSnapshot: input.marketSnapshotBySymbol?.[decision.symbol] ?? {},
      ...(token !== null && token !== undefined && Number.isInteger(token) && token > 0
        ? { instrumentToken: token }
        : {}),
      ...(prices.buyPrice === null ? {} : { buyPrice: prices.buyPrice }),
      ...(currentPrice === null ? {} : { currentPrice }),
      ...(prices.sellPrice === null ? {} : { sellPrice: prices.sellPrice }),
      ...(tuuid ? { tuuid } : {}),
      ...(input.simulationId
        ? { simulated: true, simulationId: input.simulationId, decidedAt: input.asOf }
        : {}),
    };
  });

  await database.llmTradeDecision.createMany({
    data: data as Prisma.LlmTradeDecisionCreateManyInput[],
  });

  return input.batch.decisions.length;
}

export type LatestDecisionState = {
  action: LlmTradeAction | null;
  buyPrice: string | null;
};

function formatStoredPrice(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(numeric) ? numeric.toFixed(4) : String(value);
}

export async function latestActionsForSymbols(
  symbols: readonly string[],
): Promise<Record<string, LatestDecisionState>> {
  const unique = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
  const entries = await Promise.all(
    unique.map(async (symbol) => {
      const row = await database.llmTradeDecision.findFirst({
        where: { symbol, simulated: false },
        orderBy: [{ decidedAt: 'desc' }, { asOf: 'desc' }],
        select: { action: true, buyPrice: true },
      });
      return [
        symbol,
        {
          action: row?.action ?? null,
          buyPrice: formatStoredPrice(row?.buyPrice),
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function storedNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(numeric) ? numeric : null;
}

export type OpenTradeRecord = {
  symbol: string;
  instrumentToken: number | null;
  buyPrice: number | null;
  /** When the position was bought (BUY row `asOf`), not the latest HOLD. */
  enteredAt: Date;
  buySnapshot: unknown;
  latestSnapshot: unknown;
  holdPrices: number[];
  /** Price on the latest BUY/HOLD row. */
  lastPrice: number | null;
  /** Null for trades opened before the column existed. */
  tuuid: string | null;
};

/** The position left open by the latest BUY/HOLD row (EXIT/SKIP ⇒ flat), with its entry row. */
export async function findOpenTrade(simulationId?: string): Promise<OpenTradeRecord | null> {
  const run = runFilter(simulationId);
  const latest = await database.llmTradeDecision.findFirst({
    where: run,
    orderBy: [{ decidedAt: 'desc' }, { asOf: 'desc' }],
    select: {
      symbol: true,
      action: true,
      instrumentToken: true,
      marketSnapshot: true,
      decidedAt: true,
      currentPrice: true,
      tuuid: true,
    },
  });
  if (!latest || (latest.action !== 'BUY' && latest.action !== 'HOLD')) {
    return null;
  }
  const entry = await database.llmTradeDecision.findFirst({
    where: { ...run, symbol: latest.symbol, action: 'BUY', decidedAt: { lte: latest.decidedAt } },
    orderBy: [{ decidedAt: 'desc' }, { asOf: 'desc' }],
    select: {
      asOf: true,
      decidedAt: true,
      buyPrice: true,
      instrumentToken: true,
      marketSnapshot: true,
      tuuid: true,
    },
  });
  const holds = await database.llmTradeDecision.findMany({
    where: {
      ...run,
      symbol: latest.symbol,
      action: 'HOLD',
      decidedAt: { gte: entry?.decidedAt ?? latest.decidedAt },
    },
    orderBy: [{ decidedAt: 'asc' }],
    select: { currentPrice: true },
  });
  return {
    symbol: latest.symbol.toUpperCase(),
    instrumentToken: latest.instrumentToken ?? entry?.instrumentToken ?? null,
    buyPrice: storedNumber(entry?.buyPrice),
    enteredAt: entry?.asOf ?? latest.decidedAt,
    buySnapshot: entry?.marketSnapshot ?? null,
    latestSnapshot: latest.marketSnapshot ?? null,
    holdPrices: holds
      .map((row) => storedNumber(row.currentPrice))
      .filter((price): price is number => price !== null),
    lastPrice: storedNumber(latest.currentPrice),
    tuuid: entry?.tuuid ?? latest.tuuid ?? null,
  };
}

export type StoredDecisionRow = {
  action: LlmTradeAction;
  decidedAt: Date;
  symbol: string;
  tuuid: string | null;
  buyPrice: number | null;
  sellPrice: number | null;
  marketSnapshot: unknown;
};

export async function findDecisionsSince(
  from: Date,
  simulationId?: string,
): Promise<StoredDecisionRow[]> {
  const rows = await database.llmTradeDecision.findMany({
    where: { ...runFilter(simulationId), decidedAt: { gte: from } },
    orderBy: [{ decidedAt: 'asc' }, { asOf: 'asc' }],
    select: {
      action: true,
      decidedAt: true,
      symbol: true,
      tuuid: true,
      buyPrice: true,
      sellPrice: true,
      marketSnapshot: true,
    },
  });
  return rows.map((row) => ({
    action: row.action,
    decidedAt: row.decidedAt,
    symbol: row.symbol,
    tuuid: row.tuuid,
    buyPrice: storedNumber(row.buyPrice),
    sellPrice: storedNumber(row.sellPrice),
    marketSnapshot: row.marketSnapshot,
  }));
}
