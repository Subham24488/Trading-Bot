import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { TUNABLE_PARAMS, type TunableParam } from '../strategy/params.js';
import { calendarDayDiff } from '../universe/dates.js';
import { formatParamValue, type RuleHit } from './enhancementRules.js';

/**
 * Date-wise history of every strategy change the session review has suggested, and what
 * happened to it. Consulted on each review so suggestions do not repeat or flip-flop.
 * To reject a suggestion, set `"userStatus": "rejected"` on its entry.
 */
export const LEDGER_EVENTS = [
  'suggested',
  'repeated',
  'held-back',
  'applied',
  'result',
  'superseded',
] as const;

const entrySchema = z.object({
  id: z.string(),
  runKey: z.string(),
  ruleKey: z.string(),
  param: z.enum(TUNABLE_PARAMS),
  direction: z.enum(['increase', 'decrease']),
  fromValue: z.number(),
  toValue: z.number(),
  paramsVersion: z.string(),
  event: z.enum(LEDGER_EVENTS),
  evidence: z.object({ sample: z.number(), summary: z.string() }),
  what: z.string(),
  why: z.string(),
  expectedEffect: z.string(),
  citations: z.array(z.string()),
  note: z.string().optional(),
  refId: z.string().optional(),
  userStatus: z.literal('rejected').optional(),
});

const ledgerSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  days: z.record(z.string(), z.array(entrySchema)),
});

export type LedgerEntry = z.infer<typeof entrySchema>;
export type LedgerFile = z.infer<typeof ledgerSchema>;

export type LedgerOutcome = {
  suggested: LedgerEntry[];
  repeated: LedgerEntry[];
  heldBack: LedgerEntry[];
  applied: LedgerEntry[];
  results: LedgerEntry[];
};

export type LedgerContext = {
  todayYmd: string;
  nowIso: string;
  /** Review range, e.g. "2026-10-13..2026-10-17"; re-running the same range replaces its entries. */
  runKey: string;
  paramsVersion: string;
  currentValues: Record<TunableParam, number>;
  /** Rules-based trades in the review, with the settings each one was made under. */
  trades: ReadonlyArray<{
    entryYmd: string;
    pnlPct: number | null;
    tunables: Record<string, number> | null;
  }>;
  minSampleByRule: Record<string, number>;
};

/** Suggestions per review; changing one thing at a time keeps results attributable. */
export const MAX_NEW_SUGGESTIONS = 2;
/** Days before a suggestion may be contradicted or an applied change reversed. */
export const COOLDOWN_DAYS = 10;
/** Days a rejected suggestion stays silent unless the evidence doubles. */
export const REJECTION_MEMORY_DAYS = 30;

type Dated = { day: string; entry: LedgerEntry };

type RuleState = {
  open: Dated | null;
  applied: Dated | null;
  rejected: Dated | null;
  measured: Set<string>;
};

export function emptyLedger(nowIso: string): LedgerFile {
  return { version: 1, updatedAt: nowIso, days: {} };
}

export async function loadLedger(
  filePath: string,
  nowIso: string,
): Promise<{ ledger: LedgerFile; note: string | null }> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ledger: emptyLedger(nowIso), note: null };
    }
    throw error;
  }
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return { ledger: parsed.data, note: null };
    }
  } catch {
    // Falls through to the reset below.
  }
  const aside = `${filePath}.unreadable-${nowIso.replace(/[:.]/g, '-')}`;
  await rename(filePath, aside);
  return {
    ledger: emptyLedger(nowIso),
    note: `The suggestion history file could not be read; it was moved to ${aside} and a new one was started.`,
  };
}

/** Written to a temporary file first so a crash never leaves a half-written ledger. */
export async function saveLedger(filePath: string, ledger: LedgerFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function foldHistory(days: Record<string, LedgerEntry[]>): Map<string, RuleState> {
  const states = new Map<string, RuleState>();
  for (const day of Object.keys(days).sort()) {
    for (const entry of days[day] ?? []) {
      const state = states.get(entry.ruleKey) ?? {
        open: null,
        applied: null,
        rejected: null,
        measured: new Set<string>(),
      };
      if (entry.userStatus === 'rejected') {
        state.rejected = { day, entry };
        if (state.open?.entry.id === entry.id || state.open?.entry.id === entry.refId) {
          state.open = null;
        }
      } else if (entry.event === 'suggested') {
        state.open = { day, entry };
      } else if (entry.event === 'applied') {
        state.applied = { day, entry };
        state.open = null;
      } else if (entry.event === 'superseded' && state.open?.entry.id === entry.refId) {
        state.open = null;
      } else if (entry.event === 'result' && entry.refId) {
        state.measured.add(entry.refId);
      }
      states.set(entry.ruleKey, state);
    }
  }
  return states;
}

function winRate(trades: LedgerContext['trades']): number {
  return trades.length === 0
    ? 0
    : trades.filter((trade) => (trade.pnlPct ?? 0) > 0).length / trades.length;
}

function averagePnl(trades: LedgerContext['trades']): number {
  return trades.length === 0
    ? 0
    : trades.reduce((sum, trade) => sum + (trade.pnlPct ?? 0), 0) / trades.length;
}

function compareBeforeAfter(
  applied: LedgerEntry,
  context: LedgerContext,
): LedgerEntry['evidence'] | null {
  const minSample = context.minSampleByRule[applied.ruleKey] ?? 8;
  const before = context.trades.filter(
    (trade) => trade.tunables?.[applied.param] === applied.fromValue,
  );
  const after = context.trades.filter(
    (trade) => trade.tunables?.[applied.param] === applied.toValue,
  );
  if (before.length < minSample || after.length < minSample) {
    return null;
  }
  const otherChanged = TUNABLE_PARAMS.some((param) => {
    if (param === applied.param) {
      return false;
    }
    const values = new Set([...before, ...after].map((trade) => trade.tunables?.[param]));
    return values.size > 1;
  });
  const percent = (share: number) => `${Math.round(share * 100)}%`;
  return {
    sample: before.length + after.length,
    summary: otherChanged
      ? 'Unclear: other settings also changed between the two periods.'
      : `Win rate ${percent(winRate(before))} → ${percent(winRate(after))}; average trade ` +
        `${averagePnl(before).toFixed(1)}% → ${averagePnl(after).toFixed(1)}% ` +
        `(${before.length} trades before, ${after.length} after).`,
  };
}

/**
 * Applies the anti-repeat rules to this review's findings and returns the updated ledger.
 * Pure: the caller loads and saves the file.
 */
export function planLedgerUpdate(
  ledger: LedgerFile,
  hits: readonly RuleHit[],
  context: LedgerContext,
): { ledger: LedgerFile; outcome: LedgerOutcome } {
  const { todayYmd, runKey } = context;
  const days: Record<string, LedgerEntry[]> = Object.fromEntries(
    Object.entries(ledger.days).map(([day, entries]) => [day, [...entries]]),
  );
  days[todayYmd] = (days[todayYmd] ?? []).filter((entry) => entry.runKey !== runKey);
  const states = foldHistory(days);
  const outcome: LedgerOutcome = {
    suggested: [],
    repeated: [],
    heldBack: [],
    applied: [],
    results: [],
  };
  const added: LedgerEntry[] = [];
  const record = (entry: LedgerEntry, list?: LedgerEntry[]) => {
    added.push(entry);
    list?.push(entry);
  };
  const derive = (
    base: LedgerEntry,
    event: LedgerEntry['event'],
    extra: Partial<LedgerEntry>,
  ): LedgerEntry => ({
    ...base,
    id: `${todayYmd}|${runKey}|${base.ruleKey}|${event}`,
    runKey,
    event,
    paramsVersion: context.paramsVersion,
    refId: base.id,
    ...extra,
  });

  for (const state of states.values()) {
    const open = state.open;
    if (open) {
      const current = context.currentValues[open.entry.param];
      const moved =
        open.entry.direction === 'increase'
          ? current > open.entry.fromValue
          : current < open.entry.fromValue;
      if (moved) {
        const entry = derive(open.entry, 'applied', {
          toValue: current,
          note: `Setting changed from ${formatParamValue(open.entry.param, open.entry.fromValue)} to ${formatParamValue(open.entry.param, current)}.`,
        });
        record(entry, outcome.applied);
        state.applied = { day: todayYmd, entry };
        state.open = null;
      }
    }
    const applied = state.applied;
    if (applied && !state.measured.has(applied.entry.id)) {
      const evidence = compareBeforeAfter(applied.entry, context);
      if (evidence) {
        record(
          derive(applied.entry, 'result', { evidence, note: 'Effect of the applied change.' }),
          outcome.results,
        );
      }
    }
  }

  const tradesSince = (day: string) =>
    context.trades.filter((trade) => trade.entryYmd > day).length;
  const daysSince = (day: string) => calendarDayDiff(day, todayYmd);
  const candidates: Array<{ entry: LedgerEntry; score: number }> = [];

  for (const hit of hits) {
    const state = states.get(hit.ruleKey);
    const entry: LedgerEntry = {
      id: `${todayYmd}|${runKey}|${hit.ruleKey}|suggested`,
      runKey,
      ruleKey: hit.ruleKey,
      param: hit.param,
      direction: hit.direction,
      fromValue: hit.fromValue,
      toValue: hit.toValue,
      paramsVersion: context.paramsVersion,
      event: 'suggested',
      evidence: { sample: hit.sample, summary: hit.evidence },
      what: hit.what,
      why: hit.why,
      expectedEffect: hit.expectedEffect,
      citations: [...hit.citations],
    };
    const holdBack = (note: string, refId?: string) =>
      record(
        {
          ...entry,
          id: `${todayYmd}|${runKey}|${hit.ruleKey}|held-back`,
          event: 'held-back',
          note,
          ...(refId ? { refId } : {}),
        },
        outcome.heldBack,
      );
    const doubled = hit.sample >= 2 * hit.minSample;
    const rejected = state?.rejected;
    const applied = state?.applied;
    const open = state?.open;

    if (
      rejected &&
      rejected.entry.direction === hit.direction &&
      (daysSince(rejected.day) < REJECTION_MEMORY_DAYS || !doubled)
    ) {
      holdBack(`You rejected this change on ${rejected.day}.`, rejected.entry.id);
    } else if (
      applied &&
      applied.entry.direction === hit.direction &&
      tradesSince(applied.day) < hit.minSample
    ) {
      holdBack(
        `A change in this direction was applied on ${applied.day}; waiting for enough trades with the new setting.`,
        applied.entry.id,
      );
    } else if (
      applied &&
      applied.entry.direction !== hit.direction &&
      (daysSince(applied.day) < COOLDOWN_DAYS ||
        tradesSince(applied.day) < 2 * hit.minSample ||
        !doubled)
    ) {
      holdBack(
        `This would reverse the change applied on ${applied.day}; reversals need ${COOLDOWN_DAYS} days and twice the usual evidence.`,
        applied.entry.id,
      );
    } else if (open && open.entry.direction === hit.direction) {
      record(
        {
          ...entry,
          id: `${todayYmd}|${runKey}|${hit.ruleKey}|repeated`,
          event: 'repeated',
          refId: open.entry.id,
          note: `Still open since ${open.day}; not suggested again.`,
        },
        outcome.repeated,
      );
    } else if (open && daysSince(open.day) < COOLDOWN_DAYS) {
      holdBack(
        `Contradicts the open suggestion from ${open.day}; held back to avoid flip-flopping.`,
        open.entry.id,
      );
    } else {
      if (open) {
        record(
          derive(open.entry, 'superseded', {
            note: 'Replaced by a newer suggestion with fresh evidence.',
          }),
        );
      }
      candidates.push({
        entry:
          applied && applied.entry.direction !== hit.direction
            ? { ...entry, refId: applied.entry.id }
            : entry,
        score: hit.effect * Math.sqrt(hit.sample),
      });
    }
  }

  candidates
    .sort((left, right) => right.score - left.score)
    .forEach((candidate, rank) => {
      if (rank < MAX_NEW_SUGGESTIONS) {
        record(candidate.entry, outcome.suggested);
      } else {
        record(
          {
            ...candidate.entry,
            id: `${todayYmd}|${runKey}|${candidate.entry.ruleKey}|held-back`,
            event: 'held-back',
            note: `Only ${MAX_NEW_SUGGESTIONS} changes are suggested at a time so their effect can be measured.`,
          },
          outcome.heldBack,
        );
      }
    });

  days[todayYmd] = [...(days[todayYmd] ?? []), ...added];
  if (days[todayYmd]?.length === 0) {
    delete days[todayYmd];
  }
  return { ledger: { version: 1, updatedAt: context.nowIso, days }, outcome };
}
