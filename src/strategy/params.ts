import { createHash } from 'node:crypto';

/** Thresholds behind the eight market votes (see signals.ts). */
export type SignalThresholds = {
  vwapBandPct: number;
  positioningBars: number;
  futuresOiChangePct: number;
  futuresPriceChangePct: number;
  optionFlowStrikes: number;
  optionFlowPct: number;
  volumeSurgeMultiple: number;
  volumeValidFromMinute: number;
  breadthUpPct: number;
  breadthDownPct: number;
  vixMovePct: number;
  usdInrMovePct: number;
  crudeMovePct: number;
  gapPct: number;
  headlineTone: number;
};

/** Every number the decision engine uses. Times are minutes after midnight IST. */
export type StrategyParams = {
  entryStartMinute: number;
  lastEntryMinute: number;
  expiryDayLastEntryMinute: number;
  squareOffMinute: number;
  minEntryScore: number;
  maxOpposingVotes: number;
  rsiChaseLimit: number;
  maxVixRiseForCallsPct: number;
  newsLookbackMinutes: number;
  bigLevelBufferPct: number;
  maxTradesPerDay: number;
  maxLosingTradesPerDay: number;
  cooldownMinutes: number;
  stopLossPct: number;
  /** Sell when the index has moved this % against the trade since entry. */
  indexStopPct: number;
  trailActivatePct: number;
  trailKeepFraction: number;
  timeStopMinutes: number;
  timeStopMinGainPct: number;
  reversalScore: number;
  minHoldMinutes: number;
  targetNetPnlPct: number;
  strikeBand: number;
  minDelta: number;
  maxDelta: number;
  maxIvToHv: number;
  maxSpreadPct: number;
  minPremium: number;
  minOptionOi: number;
  signals: SignalThresholds;
};

export const DEFAULT_STRATEGY: StrategyParams = {
  entryStartMinute: 9 * 60 + 30,
  lastEntryMinute: 14 * 60 + 30,
  expiryDayLastEntryMinute: 13 * 60 + 30,
  squareOffMinute: 15 * 60 + 15,
  minEntryScore: 4,
  maxOpposingVotes: 1,
  rsiChaseLimit: 75,
  maxVixRiseForCallsPct: 8,
  newsLookbackMinutes: 60,
  bigLevelBufferPct: 0.15,
  maxTradesPerDay: 3,
  maxLosingTradesPerDay: 2,
  cooldownMinutes: 30,
  stopLossPct: 25,
  indexStopPct: 0.25,
  trailActivatePct: 15,
  trailKeepFraction: 0.5,
  timeStopMinutes: 45,
  timeStopMinGainPct: 5,
  reversalScore: 3,
  minHoldMinutes: 15,
  targetNetPnlPct: 8,
  strikeBand: 2,
  minDelta: 0.35,
  maxDelta: 0.65,
  maxIvToHv: 1.4,
  maxSpreadPct: 1,
  minPremium: 20,
  minOptionOi: 10_000,
  signals: {
    vwapBandPct: 0.05,
    positioningBars: 6,
    // 30-minute futures OI change: 0.3% fired on ~6% of NIFTY readings, 0.15% on ~14%.
    futuresOiChangePct: 0.15,
    futuresPriceChangePct: 0.05,
    optionFlowStrikes: 2,
    optionFlowPct: 5,
    volumeSurgeMultiple: 1.5,
    volumeValidFromMinute: 10 * 60,
    breadthUpPct: 65,
    breadthDownPct: 35,
    vixMovePct: 5,
    usdInrMovePct: 0.2,
    crudeMovePct: 1.5,
    gapPct: 0.4,
    headlineTone: 2,
  },
};

/** Settings the session review may suggest changing, one step at a time. */
export const TUNABLE_PARAMS = [
  'stopLossPct',
  'trailKeepFraction',
  'timeStopMinutes',
  'minEntryScore',
  'maxOpposingVotes',
  'entryStartMinute',
  'lastEntryMinute',
  'maxLosingTradesPerDay',
  'maxVixRiseForCallsPct',
  'maxIvToHv',
  'rsiChaseLimit',
  'newsLookbackMinutes',
] as const;

export type TunableParam = (typeof TUNABLE_PARAMS)[number];

export type ParamLimit = { min: number; max: number; step: number; label: string };

export const PARAM_LIMITS: Record<TunableParam, ParamLimit> = {
  stopLossPct: { min: 15, max: 40, step: 5, label: 'Stop-loss on the option price (%)' },
  trailKeepFraction: {
    min: 0.3,
    max: 0.8,
    step: 0.1,
    label: 'Share of the best gain the trailing stop protects',
  },
  timeStopMinutes: { min: 30, max: 120, step: 15, label: 'Minutes before a flat trade is closed' },
  minEntryScore: { min: 3, max: 6, step: 1, label: 'Signals needed to buy (out of 8)' },
  maxOpposingVotes: { min: 0, max: 1, step: 1, label: 'Opposing signals allowed when buying' },
  entryStartMinute: { min: 570, max: 630, step: 15, label: 'Earliest time for a new trade' },
  lastEntryMinute: { min: 780, max: 885, step: 15, label: 'Latest time for a new trade' },
  maxLosingTradesPerDay: {
    min: 1,
    max: 3,
    step: 1,
    label: 'Losing trades before stopping for the day',
  },
  maxVixRiseForCallsPct: {
    min: 4,
    max: 12,
    step: 2,
    label: 'Fear-index rise (%) that blocks calls',
  },
  maxIvToHv: { min: 1.1, max: 1.4, step: 0.1, label: 'Most expensive option allowed (IV/HV)' },
  rsiChaseLimit: { min: 65, max: 85, step: 5, label: 'Momentum level treated as chasing' },
  newsLookbackMinutes: {
    min: 15,
    max: 60,
    step: 15,
    label: 'Minutes a major headline blocks new trades',
  },
};

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Defaults plus the two settings that already come from the environment. */
export function strategyParams(env: {
  minHoldMinutes?: number | undefined;
  targetNetPnlPct?: number | undefined;
}): StrategyParams {
  return {
    ...DEFAULT_STRATEGY,
    minHoldMinutes: positiveOr(env.minHoldMinutes, DEFAULT_STRATEGY.minHoldMinutes),
    targetNetPnlPct: positiveOr(env.targetNetPnlPct, DEFAULT_STRATEGY.targetNetPnlPct),
  };
}

export function tunableValues(params: StrategyParams): Record<TunableParam, number> {
  return Object.fromEntries(TUNABLE_PARAMS.map((key) => [key, params[key]])) as Record<
    TunableParam,
    number
  >;
}

/** Short fingerprint stored on every decision so results can be split by settings. */
export function paramsVersion(params: StrategyParams): string {
  return createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 8);
}
