import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Prisma } from '@prisma/client';

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
};

export async function persistDecisions(input: DecisionRowInput): Promise<number> {
  if (input.batch.decisions.length === 0) {
    return 0;
  }

  await database.llmTradeDecision.createMany({
    data: input.batch.decisions.map((decision) => ({
      asOf: input.asOf,
      symbol: decision.symbol,
      action: decision.action,
      ...(decision.confidence === undefined
        ? {}
        : { confidence: decision.confidence.toFixed(4) }),
      rationale: decision.rationale,
      model: input.model,
      promptHash: input.promptHash,
      rawCompletion: input.rawCompletion,
      marketSnapshot: input.marketSnapshot,
      ...(input.watchlistFile === null ? {} : { watchlistFile: input.watchlistFile }),
      executed: false,
      executionBlockedReason: LLM_EXECUTION_BLOCKED_REASON,
    })),
  });

  return input.batch.decisions.length;
}
