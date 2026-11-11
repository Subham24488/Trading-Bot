import { formatClockTime, formatIstTime, minutesBetween } from './clock.js';
import type { ContractCandidate } from './contracts.js';
import {
  levelRoomPct,
  profitFloor,
  type ExitReason,
  type GateId,
  type Leaning,
  type OpenPosition,
} from './decisionEngine.js';
import { pctChange, type OptionSide } from './indicators.js';
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
    `the next level many option sellers are betting the price will not cross is less than ${p.minRewardToRisk}× our ${p.indexStopPct}% loss limit away, so the possible gain is too small for the risk`,
  'day-in-profit': (p) =>
    `today's closed trades are already ${p.dayProfitLockInr > 0 ? `up more than ${formatInr(p.dayProfitLockInr)}` : 'in profit'}, so we stop for the day to keep it`,
};

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
    `Bought 1 lot (${candidate.lotSize} units) of ${describeContract(candidate)} at ${formatInr(fillPrice)} ` +
      `at ${formatIstTime(input.now)}, betting that ${candidate.index} will ${direction}. ` +
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
  const stopPrice = position.entryPrice * (1 - params.stopLossPct / 100);
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
  const floor = profitFloor(peakGainPct, params);
  const floorPrice = floor ? position.entryPrice * (1 + floor.floorPct / 100) : null;
  const protection =
    floor === null || floorPrice === null
      ? `profit protection starts at ${formatInr(position.entryPrice * (1 + params.breakevenActivatePct / 100))}`
      : floor.kind === 'breakeven'
        ? `the exit has moved up to ${formatInr(floorPrice)} so this trade cannot turn into a loss`
        : `profit protection is on and sells below ${formatInr(floorPrice)}`;
  const support = input.reading ? supportingReasons(input.reading, position.side, 1) : [];
  const trend =
    support.length > 0
      ? ` The move is still on track: ${support[0]}.`
      : input.reading
        ? ' Signals are mixed, so the safety rules stay in charge.'
        : '';
  return finish(
    `Holding ${contract}. Bought at ${formatInr(position.entryPrice)}, now ${formatInr(input.price)} ` +
      `(${formatPct(pnlPct)}${money}).${trend} Safety exit at ${formatInr(stopPrice)}` +
      `${indexStopText(position.index, position.side, position.entrySpot, params)}; ${protection}; ` +
      `sells by ${formatClockTime(params.squareOffMinute)} at the latest.`,
  );
}

const UNRESTORABLE_TEXT =
  'this open trade could not be rebuilt on start-up, so it was marked sold to keep one trade at a time';

const EXIT_TEXT: Record<ExitReason, (params: StrategyParams, peakPrice: number) => string> = {
  'square-off': (p) =>
    `it is ${formatClockTime(p.squareOffMinute)}, when every position is closed so nothing is carried overnight`,
  'stale-position': () =>
    'this position was left open from an earlier day, so it was closed at the first chance',
  'stop-loss': (p) => `the price fell to our safety limit (−${p.stopLossPct}% from the buy price)`,
  'trailing-stop': (_, peakPrice) =>
    `the price fell back from its best level of ${formatInr(peakPrice)}, so we locked in part of the gain`,
  'time-stop': (p) =>
    `the option had not gained after ${p.timeStopMinutes} minutes, and options lose value as time passes`,
  'trend-reversal': () => 'the market turned against the trade',
  'news-risk': () => 'major market-moving news came out while the trade was losing',
  unrestorable: () => UNRESTORABLE_TEXT,
  'index-stop': (p) =>
    `the index moved ${p.indexStopPct}% against the trade since we bought, so the reason for the trade no longer held`,
  'breakeven-stop': (p) =>
    `the option had gained ${p.breakevenActivatePct}% and then fell back to our break-even exit, so a winning trade was not allowed to turn into a loss`,
  'level-reached': (_, peakPrice) =>
    `the index reached a level many option sellers are betting it will not cross, and the price slipped from its best of ${formatInr(peakPrice)}, so we locked in most of the gain`,
};

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
  const reason = EXIT_TEXT[input.reason](input.params, position.peakPrice);
  const pricing = input.pricedAtSquareOff
    ? ` It is recorded at its ${formatClockTime(input.params.squareOffMinute)} price on the day it was bought, when it should have been sold.`
    : '';
  return finish(
    `Sold ${describeContract(position)} ${result}. Reason: ${reason}. ` +
      `It was bought at ${formatInr(position.entryPrice)} at ${formatIstTime(position.enteredAt)} ` +
      `and held for ${minutesBetween(position.enteredAt, input.now)} minutes.${pricing}`,
  );
}
