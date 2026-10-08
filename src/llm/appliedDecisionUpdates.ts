import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const APPLIED_UPDATE_IDS = ['chain-dvol', 'pattern-side', 'exit-facts', 'flat-1520'] as const;
export type AppliedUpdateId = (typeof APPLIED_UPDATE_IDS)[number];

const FILE_PATH = path.resolve('data/applied-decision-updates.json');

function isAppliedUpdateId(value: string): value is AppliedUpdateId {
  return (APPLIED_UPDATE_IDS as readonly string[]).includes(value);
}

export function readAppliedUpdates(): AppliedUpdateId[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(FILE_PATH, 'utf8'));
    const ids = parsed && typeof parsed === 'object' && Array.isArray((parsed as { ids?: unknown }).ids)
      ? (parsed as { ids: unknown[] }).ids
      : [];
    return [...new Set(ids.filter((id): id is AppliedUpdateId => typeof id === 'string' && isAppliedUpdateId(id)))];
  } catch {
    return [];
  }
}

export function isUpdateApplied(id: AppliedUpdateId): boolean {
  return readAppliedUpdates().includes(id);
}

export function applyDecisionUpdates(ids: readonly string[]): { applied: AppliedUpdateId[]; active: AppliedUpdateId[] } {
  const incoming = [...new Set(ids)];
  if (incoming.length === 0) {
    throw Object.assign(new Error('ids must include at least one update.'), { statusCode: 400 });
  }
  const unknown = incoming.filter((id) => !isAppliedUpdateId(id));
  if (unknown.length > 0) {
    throw Object.assign(new Error(`Unknown update id: ${unknown.join(', ')}`), { statusCode: 400 });
  }
  const active = [...new Set([...readAppliedUpdates(), ...(incoming as AppliedUpdateId[])])];
  mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  writeFileSync(FILE_PATH, `${JSON.stringify({ ids: active }, null, 2)}\n`, 'utf8');
  return { applied: incoming as AppliedUpdateId[], active };
}
