import { estimateOptionsRoundTripCost } from '../llm/optionTradeCosts.js';
import type { LevelKind } from './chart.js';
import { formatClockTime, formatIstTime, minutesBetween } from './clock.js';
import type { ContractCandidate, ContractPlan } from './contracts.js';
import {
  levelRoomPct,
  profitFloor,
  type ExitReason,
  type GateId,
  type Leaning,
  type OpenPosition,
} from './decisionEngine.js';
import { pctChange, type CandlePatternName, type OptionSide } from './indicators.js';
import type { StrategyParams } from './params.js';
import type { IndexReading } from './signals.js';

/** Plain-English rationale stored in the `rationale` column; technical detail lives in the snapshot. */
export const RATIONALE_MAX_CHARS = 1200;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const rupees = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const wholeNumber = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function formatInr(value: number): string {
  return `₹${rupees.format(value)}`;
}

function formatSignedInr(value: number): string {
  return `${value < 0 ? '−' : '+'}${formatInr(Math.abs(value))}`;
}

function formatPct(value: number): string {
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1)}%`;
}

function formatExpiry(ymd: string): string {
  const [, month, day] = ymd.split('-').map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]}`;
}

function finish(text: string): string {
  return text.length <= RATIONALE_MAX_CHARS ? text : `${text.slice(0, RATIONALE_MAX_CHARS - 1)}…`;
}

function joinReasons(reasons: readonly string[]): string {
  return reasons.join('; ');
}

/** "NIFTY 25,000 Call (expires 28 Oct)"; falls back to the trading symbol without a strike. */
export function describeContract(input: {
  symbol: string;
  index: string;
  side: OptionSide;
  strike: number | null;
  expiry: string | null;
}): string {
  if (input.strike === null) {
    return input.symbol;
  }
  const kind = input.side === 'CE' ? 'Call' : 'Put';
  const expiry = input.expiry ? ` (expires ${formatExpiry(input.expiry)})` : '';
  return `${input.index} ${wholeNumber.format(input.strike)} ${kind}${expiry}`;
}

function supportingReasons(reading: IndexReading, side: OptionSide, limit = 4): string[] {
  const direction = side === 'CE' ? 1 : -1;
  return reading.signals
    .filter((signal) => signal.vote === direction)
    .slice(0, limit)
    .map((signal) => signal.plain);
}

const GATE_TEXT: Record<GateId, (params: StrategyParams) => string> = {
  'entry-window': (p) =>
    `new trades are only opened between ${formatClockTime(p.entryStartMinute)} and ${formatClockTime(p.lastEntryMinute)}`,
  'daily-trade-limit': (p) => `we already made the maximum of ${p.maxTradesPerDay} trades today`,
  'daily-loss-limit': (p) =>
    `we already had ${p.maxLosingTradesPerDay} losing trades today, so we stop for the day to protect capital`,
  cooldown: (p) =>
    `we closed a trade less than ${p.cooldownMinutes} minutes ago and wait before trading again`,
  'data-missing': () => 'some market data we rely on was not available',
  'expiry-day-cutoff': (p) =>
    `today is an expiry day and it is past ${formatClockTime(p.expiryDayLastEntryMinute)}, when prices often get stuck near popular levels`,
  'weak-signal': (p) =>
    `the signals are not strong enough (we need at least ${p.minEntryScore} of 8 pointing the same way)`,
  'trend-disagrees': () =>
    "the price is not clearly moving one way against today's average price and the short-term trend",
  'too-many-opposing': () => 'too many signals point the other way',
  chasing: () => 'the move has already run too far, too fast, and buying now would be chasing it',
  'opposite-candle': () => 'the last 5-minute candle pushed strongly the other way',
  'fear-spike': (p) =>
    `the fear index (India VIX) has jumped ${p.maxVixRiseForCallsPct}% or more, which makes calls risky`,
  'high-news': (p) =>
    `major market-moving news came out in the last ${p.newsLookbackMinutes} minutes`,
  'near-big-level': () =>
    'the price is right next to a level that many option sellers are betting it will not cross',
  'no-liquid-contract': () =>
    'no option passed our checks for price, trading costs and how easily it can be bought and sold',
  'low-reward': (p) =>
    `the next level where the price may turn back is too close: the possible gain is less than ${p.chart.minRewardToRisk}× the loss at our stop`,
  'day-in-profit': (p) =>
    `today's closed trades are already ${p.dayProfitLockInr > 0 ? `up more than ${formatInr(p.dayProfitLockInr)}` : 'in profit'}, so we stop for the day to keep it`,
  'no-candle-confirmation': () =>
    'the last 5-minute candle did not confirm the move (we wait for one that closes strongly past the candle before it, on at least the usual volume)',
  'near-chart-level': () =>
    'the price is right at a level where it turned back before, so we wait for a clear break through it',
  'chart-trend-disagrees': () =>
    "the chart's bigger picture points the other way (the 15-minute trend or the run of highs and lows)",
  'target-out-of-reach': (p) =>
    `no option could gain ₹${p.profitLockInr} before the next level where the price may turn back`,
  'risk-too-wide': (p) =>
    `the stop the chart calls for is too far away: the loss there would be more than ₹${p.maxRiskPerUnitInr} a unit`,
};

/** Where a target level comes from, in everyday words. */
const LEVEL_TEXT: Record<LevelKind, string> = {
  'swing-high': 'a recent high where it turned back',
  'swing-low': 'a recent low where it turned back',
  'previous-high': "yesterday's high",
  'previous-low': "yesterday's low",
  'previous-close': "yesterday's close",
  'day-high': "today's high",
  'day-low': "today's low",
  'opening-high': "the first 15 minutes' high",
  'opening-low': "the first 15 minutes' low",
  'hour-high': "the last hour's high",
  'hour-low': "the last hour's low",
  'call-wall': 'where many option sellers bet it will not cross',
  'put-wall': 'where many option sellers bet it will not cross',
  projection: 'two normal 5-minute swings, with no level in the way',
};

/** Candle patterns that confirm a trade, in everyday words. */
const PATTERN_TEXT: Partial<Record<CandlePatternName, string>> = {
  bullish_engulfing: 'an up candle that swallowed the drop before it',
  bearish_engulfing: 'a down candle that swallowed the rise before it',
  morning_star: 'a three-candle turn upward',
  evening_star: 'a three-candle turn downward',
  piercing: 'an up candle that won back over half of the drop before it',
  dark_cloud: 'a down candle that gave back over half of the rise before it',
  hammer: 'a candle that dipped after a fall and recovered to close high',
  shooting_star: 'a candle that spiked after a rise and fell back to close low',
  bull_marubozu: 'a strong up candle with almost no pullback',
  bear_marubozu: 'a strong down candle with almost no bounce',
  three_bar_push_up: 'three rising closes in a row',
  three_bar_push_down: 'three falling closes in a row',
};

/** "Chart: the last 5-minute candles show …; the 15-minute trend agrees." Empty without a chart. */
function chartText(reading: IndexReading, side: OptionSide): string {
  const chart = reading.chart;
  if (!chart) {
    return '';
  }
  const up = side === 'CE';
  const { candle } = chart;
  const pattern = candle.side === side ? PATTERN_TEXT[candle.pattern] : undefined;
  const shape = pattern
    ? `candles show ${pattern}`
    : `candle closed near its ${up ? 'high' : 'low'}, ${up ? 'above' : 'below'} the candle before`;
  const volume =
    candle.volumeRatio === null
      ? ''
      : ` on ${candle.volumeRatio.toFixed(1)}× the usual volume for the time of day`;
  const trend = chart.higherTrend === (up ? 'up' : 'down') ? '; the 15-minute trend agrees' : '';
  return `Chart: the last 5-minute ${shape}${volume}${trend}. `;
}

/** Stop, target and profit lock of a BUY made from a chart plan. */
function planText(input: {
  index: string;
  side: OptionSide;
  plan: ContractPlan;
  targetKind: LevelKind;
  rewardToRisk: number;
  params: StrategyParams;
}): string {
  const { plan, params } = input;
  const up = input.side === 'CE';
  const target =
    input.targetKind === 'projection'
      ? `Nothing on the chart stands in the way up to ${wholeNumber.format(plan.targetSpot)} (${LEVEL_TEXT.projection})`
      : `Next level: ${wholeNumber.format(plan.targetSpot)} (${LEVEL_TEXT[input.targetKind]})`;
  return (
    `Plan: sell if ${input.index} ${up ? 'falls below' : 'rises above'} ${wholeNumber.format(plan.stopSpot)} ` +
    `(${up ? 'under the low' : 'over the high'} of the last two 5-minute candles) or the option falls to ` +
    `${formatInr(plan.premiumStop)}, a planned loss of about ${formatInr(plan.maxLossInr)} on 1 lot after charges. ` +
    `${target}, ${Math.round(plan.rewardPoints)} points away, worth about ${formatInr(plan.rewardPerUnit)} ` +
    `on this option (${input.rewardToRisk.toFixed(1)}× the risk). ` +
    `Once it reaches ${formatInr(plan.lockPrice)} (₹${params.profitLockInr} above the buy price), the exit moves up to ` +
    `${formatInr(plan.lockPrice)}, locking about ${formatInr(plan.lockedProfitInr)} after charges; bigger gains keep ` +
    `a growing share. Sell by ${formatClockTime(params.squareOffMinute)} at the latest.`
  );
}

/** " or if NIFTY falls to 24,963 (0.15% against us)"; empty when the entry spot is unknown. */
function indexStopText(
  index: string,
  side: OptionSide,
  spot: number | null,
  params: StrategyParams,
): string {
  if (spot === null) {
    return '';
  }
  const against = side === 'CE' ? -1 : 1;
  return (
    ` or if ${index} ${against > 0 ? 'rises' : 'falls'} to ` +
    `${wholeNumber.format(spot * (1 + (against * params.indexStopPct) / 100))} ` +
    `(${params.indexStopPct}% against us)`
  );
}

/** Room to the next big option level, stated as the reward side of the trade; empty when unknown. */
function roomText(reading: IndexReading, side: OptionSide, params: StrategyParams): string {
  const room = levelRoomPct(reading, side);
  const wall = side === 'CE' ? reading.callWall : reading.putWall;
  if (room === null || wall === null) {
    return '';
  }
  return (
    `${reading.index} has room to ${side === 'CE' ? 'rise' : 'fall'} to ${wholeNumber.format(wall)} ` +
    `(${room.toFixed(2)}% away) before a level many option sellers are betting it will not cross, ` +
    `at least ${params.minRewardToRisk}× the ${params.indexStopPct}% loss limit. `
  );
}

export function describeGate(gate: GateId, params: StrategyParams): string {
  return GATE_TEXT[gate](params);
}

export function describeBuy(input: {
  now: Date;
  candidate: ContractCandidate;
  fillPrice: number;
  reading: IndexReading;
  pickedBy: 'llm' | 'only-candidate' | 'fallback';
  candidateCount: number;
  params: StrategyParams;
}): string {
  const { candidate, fillPrice, params } = input;
  const direction = candidate.side === 'CE' ? 'rise' : 'fall';
  const chartPlan = input.reading.chart?.plans[candidate.side];
  const opening =
    `Bought 1 lot (${candidate.lotSize} units) of ${describeContract(candidate)} at ${formatInr(fillPrice)} ` +
    `at ${formatIstTime(input.now)}, betting that ${candidate.index} will ${direction}. `;
  if (candidate.plan && chartPlan) {
    const pick =
      input.pickedBy === 'llm'
        ? `The AI assistant chose this strike from ${input.candidateCount} that passed our checks.`
        : input.pickedBy === 'only-candidate'
          ? 'It was the only option that passed our checks.'
          : `It was the best-ranked of ${input.candidateCount} options that passed our checks.`;
    return finish(
      opening +
        `Why: ${joinReasons(supportingReasons(input.reading, candidate.side, 3))}. ` +
        `${chartText(input.reading, candidate.side)}${pick} ` +
        planText({
          index: candidate.index,
          side: candidate.side,
          plan: candidate.plan,
          targetKind: chartPlan.targetKind,
          rewardToRisk: chartPlan.rewardToRisk,
          params,
        }),
    );
  }
  const stopPrice = fillPrice * (1 - params.stopLossPct / 100);
  const protectFrom = fillPrice * (1 + params.breakevenActivatePct / 100);
  const lockAt = fillPrice * (1 + params.breakevenLockPct / 100);
  const indexStop = indexStopText(candidate.index, candidate.side, input.reading.spot, params);
  const pick =
    input.pickedBy === 'llm'
      ? `The AI assistant chose this strike from ${input.candidateCount} options that passed our checks.`
      : input.pickedBy === 'only-candidate'
        ? 'It was the only option that passed our checks for price, trading costs and ease of trading.'
        : `It was the best-ranked of ${input.candidateCount} options that passed our checks.`;
  return finish(
    opening +
      `Why: ${joinReasons(supportingReasons(input.reading, candidate.side))}. ` +
      `${roomText(input.reading, candidate.side, params)}${pick} ` +
      `Plan: sell if the price falls to ${formatInr(stopPrice)} (−${params.stopLossPct}%)${indexStop}, ` +
      `protect profits once it reaches ${formatInr(protectFrom)} (+${params.breakevenActivatePct}%) ` +
      `by moving the exit up to ${formatInr(lockAt)}, keep a growing share of bigger gains, ` +
      `and sell by ${formatClockTime(params.squareOffMinute)} at the latest.`,
  );
}

export function describeSkip(input: {
  now: Date;
  blockedBy: readonly GateId[];
  leaning: Leaning | null;
  reading: IndexReading | null;
  params: StrategyParams;
  detail?: string;
}): string {
  const reasons = input.blockedBy.slice(0, 3).map((gate) => describeGate(gate, input.params));
  const situation = input.leaning
    ? `${input.leaning.index} is leaning ${input.leaning.side === 'CE' ? 'upward' : 'downward'} ` +
      `(${Math.abs(input.leaning.score)} of 8 signals agree), but we held back because ${joinReasons(reasons)}.`
    : `The market shows no clear direction, and we held back because ${joinReasons(reasons)}.`;
  const seen =
    input.leaning && input.reading
      ? supportingReasons(input.reading, input.leaning.side, 2)
      : input.reading
        ? input.reading.signals.slice(0, 2).map((signal) => signal.plain)
        : [];
  return finish(
    `No trade at ${formatIstTime(input.now)}. ${situation}` +
      (seen.length > 0 ? ` What we see: ${joinReasons(seen)}.` : '') +
      (input.detail ? ` ${input.detail}` : ''),
  );
}

export function describeHold(input: {
  position: OpenPosition;
  price: number | null;
  netPnlInr: number | null;
  reading: IndexReading | null;
  params: StrategyParams;
}): string {
  const { position, params } = input;
  const contract = describeContract(position);
  const stopPrice = position.premiumStop ?? position.entryPrice * (1 - params.stopLossPct / 100);
  const pnlPct = pctChange(position.entryPrice, input.price);
  if (input.price === null || pnlPct === null) {
    return finish(
      `Holding ${contract}, bought at ${formatInr(position.entryPrice)}. The latest price was not ` +
        `available; the safety exit at ${formatInr(stopPrice)} and the ${formatClockTime(params.squareOffMinute)} sell-off still apply.`,
    );
  }
  const money =
    input.netPnlInr === null
      ? ''
      : `, about ${formatSignedInr(input.netPnlInr)} on 1 lot after estimated charges`;
  const peakGainPct =
    pctChange(position.entryPrice, Math.max(position.peakPrice, input.price)) ?? 0;
  const floor = profitFloor(peakGainPct, params, false, position.entryPrice);
  const floorPrice = floor ? position.entryPrice * (1 + floor.floorPct / 100) : null;
  const lockPrice = position.entryPrice + params.profitLockInr;
  const breakevenFrom = position.entryPrice * (1 + params.breakevenActivatePct / 100);
  const protection =
    floor === null || floorPrice === null
      ? lockPrice <= breakevenFrom
        ? `the ₹${params.profitLockInr} profit lock starts at ${formatInr(lockPrice)}`
        : `profit protection starts at ${formatInr(breakevenFrom)} and the ₹${params.profitLockInr} profit lock at ${formatInr(lockPrice)}`
      : floor.kind === 'lock'
        ? `the ₹${params.profitLockInr} profit lock is on, so it sells below ${formatInr(floorPrice)}`
        : floor.kind === 'breakeven'
          ? `the exit has moved up to ${formatInr(floorPrice)} so this trade cannot turn into a loss`
          : `profit protection is on and sells below ${formatInr(floorPrice)}`;
  const exits =
    position.stopSpot !== null
      ? `Exit if ${position.index} ${position.side === 'CE' ? 'falls below' : 'rises above'} ` +
        `${wholeNumber.format(position.stopSpot)} or the option falls to ${formatInr(stopPrice)}`
      : `Safety exit at ${formatInr(stopPrice)}` +
        indexStopText(position.index, position.side, position.entrySpot, params);
  const support = input.reading ? supportingReasons(input.reading, position.side, 1) : [];
  const trend =
    support.length > 0
      ? ` The move is still on track: ${support[0]}.`
      : input.reading
        ? ' Signals are mixed, so the safety rules stay in charge.'
        : '';
  return finish(
    `Holding ${contract}. Bought at ${formatInr(position.entryPrice)}, now ${formatInr(input.price)} ` +
      `(${formatPct(pnlPct)}${money}).${trend} ${exits}; ${protection}; ` +
      `sells by ${formatClockTime(params.squareOffMinute)} at the latest.`,
  );
}

const UNRESTORABLE_TEXT =
  'this open trade could not be rebuilt on start-up, so it was marked sold to keep one trade at a time';

const EXIT_TEXT: Record<ExitReason, (params: StrategyParams, position: OpenPosition) => string> = {
  'square-off': (p) =>
    `it is ${formatClockTime(p.squareOffMinute)}, when every position is closed so nothing is carried overnight`,
  'stale-position': () =>
    'this position was left open from an earlier day, so it was closed at the first chance',
  'stop-loss': (p, position) =>
    position.premiumStop !== null
      ? `the price fell to our planned loss limit of ${formatInr(position.premiumStop)}`
      : `the price fell to our safety limit (−${p.stopLossPct}% from the buy price)`,
  'trailing-stop': (_, position) =>
    `the price fell back from its best level of ${formatInr(position.peakPrice)}, so we locked in part of the gain`,
  'time-stop': (p) =>
    `the option had not gained after ${p.timeStopMinutes} minutes, and options lose value as time passes`,
  'trend-reversal': () => 'the market turned against the trade',
  'news-risk': () => 'major market-moving news came out while the trade was losing',
  unrestorable: () => UNRESTORABLE_TEXT,
  'index-stop': (p) =>
    `the index moved ${p.indexStopPct}% against the trade since we bought, so the reason for the trade no longer held`,
  'breakeven-stop': (p) =>
    `the option had gained ${p.breakevenActivatePct}% and then fell back to our break-even exit, so a winning trade was not allowed to turn into a loss`,
  'level-reached': (_, position) =>
    `the index reached a level many option sellers are betting it will not cross, and the price slipped from its best of ${formatInr(position.peakPrice)}, so we locked in most of the gain`,
  'chart-stop': (_, position) =>
    position.stopSpot === null
      ? 'the index broke the chart level that supported the trade'
      : `${position.index} ${position.side === 'CE' ? 'fell below' : 'rose above'} ${wholeNumber.format(position.stopSpot)}, ` +
        `past the ${position.side === 'CE' ? 'low' : 'high'} that supported the trade, so the chart no longer backed it`,
  'profit-lock': (p, position) =>
    `the option had gained ₹${p.profitLockInr} and slipped back to the profit lock at ${formatInr(position.entryPrice + p.profitLockInr)}, so the gain was kept`,
};

/** Planned loss on 1 lot at the premium stop, charges included; null without a planned stop. */
function plannedLossInr(position: OpenPosition): number | null {
  if (position.premiumStop === null || position.lotSize === null) {
    return null;
  }
  const costs = estimateOptionsRoundTripCost({
    buyPremium: position.entryPrice,
    sellPremium: position.premiumStop,
    quantity: position.lotSize,
  });
  return (position.entryPrice - position.premiumStop) * position.lotSize + costs.totalInr;
}

/** SELL for an open trade that start-up could not rebuild into a position. */
export function describeUnrestorableExit(input: {
  symbol: string;
  exitPrice: number | null;
  buyPrice: number | null;
}): string {
  const result =
    input.exitPrice === null ? 'at the last known price' : `at ${formatInr(input.exitPrice)}`;
  const bought = input.buyPrice === null ? '' : ` It was bought at ${formatInr(input.buyPrice)}.`;
  return finish(
    `Sold ${input.symbol} ${result}. Reason: ${UNRESTORABLE_TEXT}.${bought}`,
  );
}

export function describeExit(input: {
  now: Date;
  position: OpenPosition;
  exitPrice: number | null;
  reason: ExitReason;
  netPnlInr: number | null;
  params: StrategyParams;
  /** The exit price is that day's 3:15 PM price, not today's (a position left open overnight). */
  pricedAtSquareOff?: boolean;
}): string {
  const { position } = input;
  const pnlPct = pctChange(position.entryPrice, input.exitPrice);
  const result =
    input.exitPrice === null || pnlPct === null
      ? 'at the last known price'
      : `at ${formatInr(input.exitPrice)} (${formatPct(pnlPct)}` +
        (input.netPnlInr === null
          ? ')'
          : `, about ${formatSignedInr(input.netPnlInr)} after estimated charges on 1 lot)`);
  const reason = EXIT_TEXT[input.reason](input.params, position);
  const pricing = input.pricedAtSquareOff
    ? ` It is recorded at its ${formatClockTime(input.params.squareOffMinute)} price on the day it was bought, when it should have been sold.`
    : '';
  const planned = plannedLossInr(position);
  const plan =
    planned !== null && input.netPnlInr !== null && input.netPnlInr < 0
      ? ` The planned loss limit was about ${formatInr(planned)}.`
      : '';
  return finish(
    `Sold ${describeContract(position)} ${result}. Reason: ${reason}. ` +
      `It was bought at ${formatInr(position.entryPrice)} at ${formatIstTime(position.enteredAt)} ` +
      `and held for ${minutesBetween(position.enteredAt, input.now)} minutes.${pricing}${plan}`,
  );
}
