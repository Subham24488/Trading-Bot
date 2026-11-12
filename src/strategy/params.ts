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

/**
 * Chart reading on completed 5-minute futures bars (chart.ts). "ATR" is the 14-bar average true
 * range: the size of a normal 5-minute swing, which scales every distance below.
 */
export type ChartParams = {
  /** Gain to the next level must be at least this many times the loss at the stop (Varsity: 1.5). */
  minRewardToRisk: number;
  atrPeriod: number;
  /** A swing high (low) is above (below) this many bars on each side. */
  swingBars: number;
  /** The stop sits this many ATRs beyond the low (calls) or high (puts) of the last two candles. */
  stopBufferAtr: number;
  /** Stops closer than this many ATRs to the price get hit by normal 5-minute noise. */
  minStopAtr: number;
  /** A level this close (in ATRs) ahead of the price counts as being at it. */
  levelBufferAtr: number;
  /** A net move of `maxBurstAtr` ATRs or more over the last `burstBars` bars is a climax. */
  burstBars: number;
  maxBurstAtr: number;
  /** A confirming candle closes in this top (calls) or bottom (puts) share of its range... */
  confirmCloseLocation: number;
  /** ...is at least this many ATRs tall... */
  minSignalRangeAtr: number;
  /** ...and trades at least this multiple of the usual volume for its time of day. */
  minSignalVolumeRatio: number;
  /** Bigger-picture trend: an EMA of `trendEmaPeriod` bars of `trendMinutes` minutes. */
  trendMinutes: number;
  trendEmaPeriod: number;
  /** Target when no level lies ahead of the price, in ATRs. */
  targetFallbackAtr: number;
  /** The index move the ₹ profit lock needs must be within this many ATRs (else a dead market). */
  maxTargetAtr: number;
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
  /**
   * Without a chart reading: room to the next big option level must be at least this many times
   * `indexStopPct`. With one, `chart.minRewardToRisk` applies to the chart stop and target.
   */
  minRewardToRisk: number;
  maxTradesPerDay: number;
  maxLosingTradesPerDay: number;
  /** No new trades once today's closed trades are net above this (₹), so a green day stays green. */
  dayProfitLockInr: number;
  cooldownMinutes: number;
  /** Widest stop on the option price; the planned stop from the chart is never looser. */
  stopLossPct: number;
  /** Without a chart stop: sell when the index has moved this % against the trade since entry. */
  indexStopPct: number;
  /**
   * ₹ per unit. A trade needs room to gain this much over its buy price; once it has, the exit
   * moves up to buy price + this, so the gain is kept.
   */
  profitLockInr: number;
  /** ₹ per unit: the most a trade may lose at its chart stop, spread included. */
  maxRiskPerUnitInr: number;
  /** Once the best gain reaches this %, the exit moves up to cost plus `breakevenLockPct`. */
  breakevenActivatePct: number;
  /** Gain (%) the break-even exit keeps, enough to cover charges and the spread. */
  breakevenLockPct: number;
  trailActivatePct: number;
  trailKeepFraction: number;
  /** Larger gains keep a larger share: from `fromPct` best gain, keep at least `keep`. */
  trailTiers: ReadonlyArray<{ fromPct: number; keep: number }>;
  /** Share of the best gain kept once the index reaches a big option-seller level. */
  bigLevelKeepFraction: number;
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
  chart: ChartParams;
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
  // Three losing puts had 0.15–0.27% room to the put wall; no winner had less than 0.34%.
  minRewardToRisk: 2,
  maxTradesPerDay: 3,
  maxLosingTradesPerDay: 2,
  dayProfitLockInr: 0,
  cooldownMinutes: 30,
  // Stopped trades never showed a profit; the one deep dip that recovered bottomed at −16%.
  stopLossPct: 20,
  // The premium moves ~70× the index in %, so 0.25% cost −17% on 2026-11-09; 0.15% ≈ −10%.
  // Winners' index pullbacks stayed within 0.08%.
  indexStopPct: 0.15,
  // Three trades reached +₹13 to +₹23 a unit and still closed at a loss (2026-10-23, 11-03, 11-04).
  profitLockInr: 10,
  // About ₹1,050 on a 65-unit NIFTY lot with charges; past stopped trades lost ₹1,650–3,340.
  maxRiskPerUnitInr: 15,
  // Three trades reached +9% to +15% and still closed at a loss before this lock existed.
  breakevenActivatePct: 8,
  breakevenLockPct: 2,
  trailActivatePct: 10,
  trailKeepFraction: 0.5,
  trailTiers: [
    { fromPct: 25, keep: 0.65 },
    { fromPct: 40, keep: 0.75 },
  ],
  bigLevelKeepFraction: 0.8,
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
  chart: {
    minRewardToRisk: 1.5,
    atrPeriod: 14,
    swingBars: 2,
    stopBufferAtr: 0.25,
    minStopAtr: 1,
    levelBufferAtr: 0.3,
    burstBars: 3,
    // 2026-11-09: a 72-point fall in 15 minutes (about 7 normal swings) right before the put buy.
    maxBurstAtr: 2.5,
    confirmCloseLocation: 0.6,
    minSignalRangeAtr: 0.5,
    minSignalVolumeRatio: 1,
    trendMinutes: 15,
    trendEmaPeriod: 20,
    targetFallbackAtr: 2,
    maxTargetAtr: 3,
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
