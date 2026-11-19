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
  /** A candle is at a level when its range comes within this many ATRs of it. */
  levelTouchAtr: number;
  /** Bigger-picture trend: an EMA of `trendEmaPeriod` bars of `trendMinutes` minutes. */
  trendMinutes: number;
  trendEmaPeriod: number;
  /** Target when no level lies ahead of the price, in ATRs. */
  targetFallbackAtr: number;
  /** The index move the ₹ target needs must be within this many ATRs (else a dead market). */
  maxTargetAtr: number;
  /** Pullback entries: the price must be back within this many ATRs of VWAP or the 21-bar EMA. */
  maxValueGapAtr: number;
  /** When the votes agree with the trend by at least this score, a shallower pullback will do... */
  strongTrendScore: number;
  /** ...up to this many ATRs from value (strong trend days never come all the way back). */
  strongTrendMaxValueGapAtr: number;
};

/**
 * Trend days (trendDay.ts): a day the index runs one way. Trades in its direction may also enter
 * on a breakout, without waiting for a pullback to value.
 */
export type TrendDayParams = {
  /** The day is checked from this minute until `checkUntilMinute`; once flagged it stays flagged. */
  checkFromMinute: number;
  checkUntilMinute: number;
  /** VWAP check: the last this many 5-minute closes are on one side of today's average price. */
  vwapSideBars: number;
  /** Trend-strength check: ADX(14) of the completed 15-minute candles is at least this. */
  trendStrengthMin: number;
  /** A range day is checked from this minute... */
  rangeFromMinute: number;
  /** ...when the 15-minute average moved less than this many 15-minute ATRs... */
  flatAverageAtr: number;
  /** ...over its last this many candles... */
  flatAverageCandles: number;
  /** ...and today's 15-minute closes crossed today's average price at least this many times. */
  rangeVwapCrossings: number;
  /** On a day that is neither a trend day nor a range day, no new trade before this minute. */
  unclearWaitUntilMinute: number;
  /** Breakout entries start at this minute... */
  breakoutFromMinute: number;
  /** ...and need a candle with at least this multiple of the day's median 5-minute volume. */
  breakoutVolumeMultiple: number;
};

/** The chart setups of 2026-11-19 (setups.ts). Times are minutes after midnight IST. */
export type SetupParams = {
  /** Flag: a pole of at least this many 15-minute swings (ATR)... */
  flagPoleAtr: number;
  /** ...in up to this many 15-minute candles... */
  flagPoleMaxCandles: number;
  /** ...then a pause of this many to `flagMaxCandles` candles... */
  flagMinCandles: number;
  flagMaxCandles: number;
  /** ...broken on at least this multiple of the 20-candle average volume... */
  flagVolumeMultiple: number;
  /** ...between these minutes... */
  flagFromMinute: number;
  flagUntilMinute: number;
  /** ...and not within this many 15-minute swings under yesterday's high or the call-OI strike. */
  flagClearanceAtr: number;
  /** Opening-range retest: only between these minutes... */
  retestFromMinute: number;
  retestUntilMinute: number;
  /** ...when the opening range is no wider than this many 15-minute swings. */
  retestMaxRangeAtr: number;
  /** Double bottom or top: two lows (highs) within this %... */
  doubleBottomTolerancePct: number;
  /** ...at least this many 15-minute candles apart. */
  doubleBottomMinGap: number;
  /** Double bottom or top and failed breakout: not before this minute. */
  reversalFromMinute: number;
};

/**
 * `pullback`: the 15-minute trend picks the side and a BUY waits for the price to come back to
 * value with a confirming candle; only the market-backdrop votes can block it. `momentum`: the
 * earlier rules, where the 8 votes pick the side and must agree.
 */
export type EntryMode = 'pullback' | 'momentum';

/** Every number the decision engine uses. Times are minutes after midnight IST. */
export type StrategyParams = {
  entryMode: EntryMode;
  entryStartMinute: number;
  lastEntryMinute: number;
  expiryDayLastEntryMinute: number;
  /**
   * New trades use the nearest expiry at least this many trading days away: with 2, expiry day
   * and the trading day before it use the next contract.
   */
  minTradingDaysToExpiry: number;
  /**
   * Calls are bought only above the index's average close of this many days, puts only below
   * it; 0 turns the filter off.
   */
  trendAverageDays: number;
  /**
   * A trade against the 20-day average is allowed only when at least this many of the 8 votes
   * (net) point its way: a stronger setup.
   */
  againstDayAverageMinScore: number;
  /** Minutes over which Bank NIFTY's and India VIX's latest move is measured. */
  recentMoveMinutes: number;
  /** Skip a trade when Bank NIFTY moved at least this % the other way over `recentMoveMinutes`. */
  bankNiftyAgainstPct: number;
  /** No buying while India VIX is up at least this % over `recentMoveMinutes` (a fear spike). */
  vixSpikePct: number;
  /**
   * Scheduled announcements inside market hours (RBI policy), as "YYYY-MM-DD HH:MM" in IST. US Fed
   * and CPI releases come after 15:30 IST, so they never fall in market hours.
   */
  scheduledEvents: readonly string[];
  /** No new trade from this many minutes before a scheduled announcement until this many after. */
  eventBlockMinutes: number;
  squareOffMinute: number;
  minEntryScore: number;
  maxOpposingVotes: number;
  /** Pullback entries: the vote score must lean the trade's way by at least this (−8 turns it off). */
  minAgreeingScore: number;
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
  /** Minutes after a sale before the next trade may be bought. */
  cooldownMinutes: number;
  /** Widest stop on the option price; the planned stop from the chart is never looser. */
  stopLossPct: number;
  /** Without a chart stop: sell when the index has moved this % against the trade since entry. */
  indexStopPct: number;
  /**
   * ₹ per unit. A trade needs room to gain this much over its buy price; once it has, the
   * stop-loss order moves up to buy price + `profitLockStartInr`.
   */
  profitLockInr: number;
  /**
   * ₹ per unit above the buy price where the stop-loss order moves once the option is
   * `profitLockInr` up: 0 is the buy price itself.
   */
  profitLockStartInr: number;
  /** ₹ per unit: the most a trade may lose at its chart stop, spread included (`stopLossInr` 0). */
  maxRiskPerUnitInr: number;
  /** ₹ per unit: fixed stop on the option price, buy price − this; 0 uses the chart stop. */
  stopLossInr: number;
  /** ₹ per unit: the stop-loss order sells with a limit this far below its trigger price. */
  stopLimitGapInr: number;
  /** A triggered stop-loss order still unfilled after this many seconds is re-priced to the bid. */
  stopRepriceSeconds: number;
  /**
   * Minutes between full reviews of an open trade (ratchet, chart stop, time stop, reversal);
   * the stop-loss order placed at BUY is still checked every 15 seconds in between.
   */
  openPositionCycleMinutes: number;
  /** ₹ per unit: sell once the option is this much above its buy price; 0 means no target. */
  takeProfitInr: number;
  /**
   * ₹ per unit: once `profitLockInr` is reached, the stop rises by this for each further step of
   * profit (with the defaults: +₹10 → the buy price, +₹15 → buy + ₹5, +₹20 → buy + ₹10 …), and
   * only that stop or the square-off can close the trade. 0 keeps a single lock at
   * `profitLockInr`.
   */
  profitStepInr: number;
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
  /** Contracts are ranked by how close their delta is to this. */
  targetDelta: number;
  maxIvToHv: number;
  maxSpreadPct: number;
  minPremium: number;
  /** Options costing more than this (₹ a unit) are not bought. */
  maxPremium: number;
  minOptionOi: number;
  signals: SignalThresholds;
  chart: ChartParams;
  trendDay: TrendDayParams;
  setups: SetupParams;
};

export const DEFAULT_STRATEGY: StrategyParams = {
  // Replays of 10-22, 11-11 and 11-13: vote-led entries won 38% at ₹10/₹10, pullbacks 60–80%.
  entryMode: 'pullback',
  entryStartMinute: 9 * 60 + 30,
  lastEntryMinute: 14 * 60 + 30,
  expiryDayLastEntryMinute: 13 * 60 + 30,
  // 39-day backtest: skipping a contract's last two sessions made +₹1,480 on weekly prices.
  minTradingDaysToExpiry: 2,
  // 39-day backtest: the filter added ₹4,167 on real prices and ₹3,563 on weekly prices.
  trendAverageDays: 20,
  // 2026-11-19: against the 20-day trend only with 5 of the 8 votes on the trade's side.
  againstDayAverageMinScore: 5,
  recentMoveMinutes: 30,
  bankNiftyAgainstPct: 0.1,
  vixSpikePct: 5,
  // Add RBI policy announcements here, for example '2026-12-04 10:00'.
  scheduledEvents: [],
  eventBlockMinutes: 30,
  squareOffMinute: 15 * 60 + 15,
  minEntryScore: 4,
  maxOpposingVotes: 1,
  // 10-day replay: 6 of 8 entries with the votes against lost; 6 of 8 with them agreeing won.
  minAgreeingScore: 1,
  rsiChaseLimit: 75,
  maxVixRiseForCallsPct: 8,
  // No new trade within 30 minutes of a high-impact headline (60 before 2026-11-19).
  newsLookbackMinutes: 30,
  bigLevelBufferPct: 0.15,
  // Three losing puts had 0.15–0.27% room to the put wall; no winner had less than 0.34%.
  minRewardToRisk: 2,
  maxTradesPerDay: 3,
  maxLosingTradesPerDay: 2,
  // With ₹10–15 targets, keep trading after a winner until the day is up this much.
  dayProfitLockInr: 1_500,
  // 10 minutes since 2026-11-19 (was 30).
  cooldownMinutes: 10,
  // Stopped trades never showed a profit; the one deep dip that recovered bottomed at −16%.
  stopLossPct: 20,
  // The premium moves ~70× the index in %, so 0.25% cost −17% on 2026-11-09; 0.15% ≈ −10%.
  // Winners' index pullbacks stayed within 0.08%.
  indexStopPct: 0.15,
  // Three trades reached +₹13 to +₹23 a unit and still closed at a loss (2026-10-23, 11-03, 11-04).
  profitLockInr: 10,
  // Once the option is ₹10 up, the stop-loss order moves to the buy price.
  profitLockStartInr: 0,
  // About ₹1,050 on a 65-unit NIFTY lot with charges; past stopped trades lost ₹1,650–3,340.
  maxRiskPerUnitInr: 15,
  stopLossInr: 10,
  stopLimitGapInr: 5,
  stopRepriceSeconds: 5,
  // 21 real days: reviewing every 5 minutes with the ₹10 stop checked in between made +₹8,888,
  // against +₹1,226 with 1-minute reviews (the ratchet stopped selling on small dips).
  openPositionCycleMinutes: 5,
  // No target sell: the profit lock ratchets up instead (10-day replay +₹4,400 vs +₹3,751).
  takeProfitInr: 0,
  // Then ₹5 higher for every further ₹5 gain (2026-11-19).
  profitStepInr: 5,
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
  // 2026-11-19: delta 0.40–0.55 (was 0.35–0.65).
  minDelta: 0.4,
  maxDelta: 0.55,
  // One strike out of the money: a ₹10 stop leaves ~25 index points instead of ~20 at 0.5.
  targetDelta: 0.4,
  maxIvToHv: 1.4,
  maxSpreadPct: 1,
  minPremium: 20,
  maxPremium: 200,
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
    levelTouchAtr: 0.25,
    trendMinutes: 15,
    trendEmaPeriod: 20,
    targetFallbackAtr: 2,
    maxTargetAtr: 3,
    maxValueGapAtr: 0.5,
    // 2026-11-05: votes +5 to +7 all day, price never back within 0.5 ATR of value, no trade.
    strongTrendScore: 5,
    strongTrendMaxValueGapAtr: 1,
  },
  // 42-session backtest (2026-11-18): breakout entries on trend days made +₹15,608 against
  // +₹7,402; the pullback rule alone had missed 43 of 44 rallies of 0.5% in 90 minutes.
  trendDay: {
    checkFromMinute: 9 * 60 + 45,
    checkUntilMinute: 10 * 60 + 30,
    // 2026-11-19: all three checks (opening range held, one side of VWAP, ADX 25+), was 3 of 5.
    vwapSideBars: 6,
    trendStrengthMin: 25,
    rangeFromMinute: 10 * 60,
    flatAverageAtr: 0.3,
    flatAverageCandles: 4,
    rangeVwapCrossings: 3,
    unclearWaitUntilMinute: 10 * 60 + 30,
    breakoutFromMinute: 10 * 60,
    breakoutVolumeMultiple: 1.5,
  },
  // The chart setups of 2026-11-19, as given: flag, opening-range retest, double bottom or top,
  // failed breakout.
  setups: {
    flagPoleAtr: 1.5,
    flagPoleMaxCandles: 4,
    flagMinCandles: 3,
    flagMaxCandles: 8,
    flagVolumeMultiple: 1.5,
    flagFromMinute: 10 * 60,
    flagUntilMinute: 13 * 60 + 30,
    flagClearanceAtr: 0.5,
    retestFromMinute: 9 * 60 + 45,
    retestUntilMinute: 11 * 60,
    retestMaxRangeAtr: 1.5,
    doubleBottomTolerancePct: 0.1,
    doubleBottomMinGap: 4,
    reversalFromMinute: 10 * 60,
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
