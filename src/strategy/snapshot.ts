import { z } from 'zod';

import { EXIT_REASONS } from './decisionEngine.js';

export const SNAPSHOT_SCHEMA = 'rules-v1';

const nullableNumber = z.number().nullable();
const sideSchema = z.enum(['CE', 'PE']);
const voteSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);

/** The chart reading behind a decision (chart.ts); absent on rows from before it existed. */
const chartSchema = z.object({
  atr: z.number(),
  structure: z.enum(['up', 'down', 'unclear']),
  higherTrend: z.enum(['up', 'down', 'flat']).nullable(),
  burstAtr: nullableNumber,
  candle: z.object({
    pattern: z.string(),
    confirms: sideSchema.nullable(),
    closeLocation: z.number(),
    rangeAtr: z.number(),
    volumeRatio: nullableNumber,
  }),
  support: nullableNumber,
  resistance: nullableNumber,
});

/** Stop, target and money at risk for the contract bought (contracts.ts `ContractPlan`). */
const entryPlanSchema = z.object({
  stopSpot: z.number(),
  targetSpot: z.number(),
  targetKind: z.string(),
  riskPoints: z.number(),
  rewardPoints: z.number(),
  rewardToRisk: z.number(),
  rewardPerUnit: z.number(),
  riskPerUnit: z.number(),
  premiumStop: z.number(),
  lockPrice: z.number(),
  maxLossInr: z.number(),
  lockedProfitInr: z.number(),
});

/**
 * Structured market snapshot stored with every rules-based decision (`marketSnapshot` column).
 * The decision loop writes it; the session review reads it back.
 */
export const decisionSnapshotSchema = z.object({
  schema: z.literal(SNAPSHOT_SCHEMA),
  paramsVersion: z.string(),
  tunables: z.record(z.string(), z.number()),
  trigger: z.enum(['cycle', 'monitor', 'startup']),
  asOfIst: z.string(),
  spots: z.record(z.string(), z.number()),
  readings: z.array(
    z.object({
      index: z.string(),
      score: z.number(),
      votes: z.record(z.string(), voteSchema),
      rsi: nullableNumber,
      futuresPrice: nullableNumber,
      vwap: nullableNumber,
      callWall: nullableNumber,
      putWall: nullableNumber,
      pcr: nullableNumber,
      expiryToday: z.boolean(),
      chart: chartSchema.nullable().optional(),
    }),
  ),
  market: z.object({
    vixPct: nullableNumber,
    usdInrPct: nullableNumber,
    crudePct: nullableNumber,
    gapPct: nullableNumber,
    advancersPct: nullableNumber,
    headlineTone: z.number(),
  }),
  news: z.record(z.string(), z.enum(['none', 'elevated', 'high'])),
  headlines: z.array(z.string()),
  blockedBy: z.array(z.string()),
  leaning: z
    .object({
      index: z.string(),
      side: sideSchema,
      score: z.number(),
      symbol: z.string().nullable(),
      premium: nullableNumber,
      delta: nullableNumber,
    })
    .nullable(),
  entry: z
    .object({
      index: z.string(),
      side: sideSchema,
      score: z.number(),
      chosen: z.string(),
      pickedBy: z.enum(['llm', 'only-candidate', 'fallback']),
      pickerNote: z.string(),
      candidates: z.array(
        z.object({
          symbol: z.string(),
          strike: z.number(),
          ask: z.number(),
          spreadPct: z.number(),
          delta: z.number(),
          ivToHv: nullableNumber,
          rank: z.number(),
        }),
      ),
      plan: entryPlanSchema.optional(),
    })
    .optional(),
  position: z
    .object({
      symbol: z.string(),
      index: z.string(),
      side: sideSchema,
      strike: nullableNumber,
      expiry: z.string().nullable(),
      lotSize: nullableNumber,
      entryPrice: z.number(),
      enteredAt: z.string(),
      heldMinutes: z.number(),
      lastPrice: nullableNumber,
      pnlPct: nullableNumber,
      netPnlInr: nullableNumber,
      peakPrice: z.number(),
      troughPrice: z.number(),
      entryDelta: nullableNumber,
      /** Current (trailed) chart stop on the index and the planned premium stop. */
      stopSpot: nullableNumber.optional(),
      premiumStop: nullableNumber.optional(),
    })
    .optional(),
  exit: z
    .object({
      reason: z.enum(EXIT_REASONS),
      /** `square-off-candle`: a position left open overnight, priced at its own day's 3:15 PM. */
      priceSource: z.enum(['bid', 'last-trade', 'last-known', 'square-off-candle']),
    })
    .optional(),
  fees: z.object({ totalInr: z.number(), lotSize: z.number() }).optional(),
  dataGaps: z.array(z.string()),
});

export type DecisionSnapshot = z.infer<typeof decisionSnapshotSchema>;

/** The rules-v1 snapshot, or null for legacy (LLM-era) rows and anything malformed. */
export function parseDecisionSnapshot(value: unknown): DecisionSnapshot | null {
  const parsed = decisionSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
