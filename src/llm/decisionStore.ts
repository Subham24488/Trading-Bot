import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LlmTradeAction, Prisma } from '@prisma/client';

import { config } from '../config.js';
import { database } from '../database.js';
import type { DecisionBatch } from './schemas.js';
import type { UniverseSuggestion } from './schemas.js';
import type { SessionInstrument } from '../domain.js';

export type StoredUniverseFile = {
  generatedAt: string;
  asOfIst: string;
  model: string;
  newsItemCount: number;
  suggestion: UniverseSuggestion;
  includedSymbols: string[];
  sessionStartPayload: { instruments: SessionInstrument[] };
  unmappedSymbols: string[];
  knowledgeFile?: string | null;
  candidateSymbols?: string[];
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

export function hashPrompt(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export const LLM_EXECUTION_BLOCKED_REASON = 'LLM decisions are never sent to the broker.';

export type DecisionRowInput = {
  asOf: Date;
  batch: DecisionBatch;
  model: string;
  promptHash: string;
  rawCompletion: string;
  marketSnapshot: Prisma.InputJsonValue;
  watchlistFile: string | null;
  lastPriceBySymbol?: Record<string, number | null>;
  priorBuyPriceBySymbol?: Record<string, string | null>;
};

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
    return {
      asOf: input.asOf,
      symbol: decision.symbol,
      action: decision.action,
      rationale: decision.rationale,
      model: input.model,
      promptHash: input.promptHash,
      rawCompletion: input.rawCompletion,
      marketSnapshot: input.marketSnapshot,
      executed: false as const,
      executionBlockedReason: LLM_EXECUTION_BLOCKED_REASON,
      ...(decision.confidence === undefined ? {} : { confidence: decision.confidence.toFixed(4) }),
      ...(input.watchlistFile === null ? {} : { watchlistFile: input.watchlistFile }),
      ...(prices.buyPrice === null ? {} : { buyPrice: prices.buyPrice }),
      ...(prices.sellPrice === null ? {} : { sellPrice: prices.sellPrice }),
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
        where: { symbol },
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
