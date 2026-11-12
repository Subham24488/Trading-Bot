import type { IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import { buyClearsFeeTarget, estimateOptionsRoundTripCost } from '../llm/optionTradeCosts.js';
import { computeOptionGreeks } from '../options/greeksIv.js';
import { atmStrike } from '../options/nfoChain.js';
import type { DailyBar } from '../universe/types.js';
import type { OptionSide } from './indicators.js';
import type { StrategyParams } from './params.js';

export type ChainQuote = {
  symbol: string;
  index: IndexOptionName;
  side: OptionSide;
  strike: number;
  expiry: string;
  token: number;
  lotSize: number | null;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  oi: number;
  volume: number;
  /** Open-interest change since the first quote seen today; null on first sight. */
  oiChangeToday: number | null;
};

export type Moneyness = 'in the money' | 'at the money' | 'out of the money';

/** The chart's stop and target for the trade (spot terms), from chart.ts. */
export type TradePlanInput = {
  stopSpot: number;
  targetSpot: number;
  riskPoints: number;
  rewardPoints: number;
  /** Size of a normal 5-minute swing in index points. */
  atr: number;
};

/** What the chart's stop and target mean for one contract, per unit and per lot. */
export type ContractPlan = {
  stopSpot: number;
  targetSpot: number;
  riskPoints: number;
  rewardPoints: number;
  /** Bid the option should reach at the target, less its buy price (delta × points − spread). */
  rewardPerUnit: number;
  /** Bought at the ask, sold at the bid once the index reaches the stop (delta × points + spread). */
  riskPerUnit: number;
  /** Option price that ends the trade: buy price less `riskPerUnit`, on the ₹0.05 tick. */
  premiumStop: number;
  /** Buy price + the ₹ profit lock; once reached, the exit moves up to it. */
  lockPrice: number;
  /** Loss on 1 lot if sold at `premiumStop`, charges included. */
  maxLossInr: number;
  /** Profit on 1 lot if sold at `lockPrice`, after charges. */
  lockedProfitInr: number;
};

export type PlanRejectionCode = 'target-out-of-reach' | 'risk-too-wide';

export type ContractCandidate = {
  symbol: string;
  index: IndexOptionName;
  side: OptionSide;
  strike: number;
  expiry: string;
  token: number;
  lotSize: number;
  ltp: number;
  bid: number;
  ask: number;
  spreadPct: number;
  oi: number;
  volume: number;
  /** Absolute option delta (0–1). */
  delta: number;
  ivToHv: number | null;
  /** Strikes away from at-the-money; positive means a higher strike. */
  stepsFromAtm: number;
  moneyness: Moneyness;
  feeInr: number;
  /** Stop, target and money at risk from the chart; null when no chart plan was given. */
  plan: ContractPlan | null;
  rank: number;
};

/** `code` marks a contract that was liquid and fairly priced but failed the chart plan. */
export type CandidateRejection = { symbol: string; reason: string; code?: PlanRejectionCode };

/** Option prices move in ₹0.05 steps. */
const TICK = 0.05;

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function formatRupees(value: number): string {
  return `₹${value.toFixed(2)}`;
}

/**
 * The ₹ profit-lock check and the loss limit for one contract. The option must be able to gain
 * `profitLockInr` before the target (and the move that needs must be a normal one), and the
 * loss at the chart stop must stay within `maxRiskPerUnitInr`.
 */
function planContract(
  row: { ask: number; bid: number; lotSize: number },
  delta: number,
  plan: TradePlanInput,
  params: StrategyParams,
): { plan: ContractPlan } | { code: PlanRejectionCode; reason: string } {
  const spread = row.ask - row.bid;
  const rewardPerUnit = delta * plan.rewardPoints - spread;
  if (rewardPerUnit < params.profitLockInr) {
    return {
      code: 'target-out-of-reach',
      reason:
        `the next level is worth only about ${formatRupees(Math.max(rewardPerUnit, 0))} on it, ` +
        `short of the ₹${params.profitLockInr} target`,
    };
  }
  const pointsForLock = (params.profitLockInr + spread) / delta;
  if (pointsForLock > params.chart.maxTargetAtr * plan.atr) {
    return {
      code: 'target-out-of-reach',
      reason:
        `₹${params.profitLockInr} needs a ${Math.round(pointsForLock)}-point move, more than ` +
        `${params.chart.maxTargetAtr} normal 5-minute swings`,
    };
  }
  const riskPerUnit = delta * plan.riskPoints + spread;
  if (riskPerUnit > params.maxRiskPerUnitInr) {
    return {
      code: 'risk-too-wide',
      reason:
        `it would lose about ${formatRupees(riskPerUnit)} a unit at the chart stop, ` +
        `more than the ₹${params.maxRiskPerUnitInr} limit`,
    };
  }
  const widest = row.ask * (1 - params.stopLossPct / 100);
  const onTick = Math.floor((row.ask - riskPerUnit) / TICK + 1e-6) * TICK;
  const premiumStop = round2(Math.max(widest, onTick));
  const lockPrice = round2(row.ask + params.profitLockInr);
  const atStop = estimateOptionsRoundTripCost({
    buyPremium: row.ask,
    sellPremium: premiumStop,
    quantity: row.lotSize,
  });
  const atLock = estimateOptionsRoundTripCost({
    buyPremium: row.ask,
    sellPremium: lockPrice,
    quantity: row.lotSize,
  });
  return {
    plan: {
      stopSpot: round2(plan.stopSpot),
      targetSpot: round2(plan.targetSpot),
      riskPoints: round2(plan.riskPoints),
      rewardPoints: round2(plan.rewardPoints),
      rewardPerUnit: round2(rewardPerUnit),
      riskPerUnit: round2(riskPerUnit),
      premiumStop,
      lockPrice,
      maxLossInr: round2((row.ask - premiumStop) * row.lotSize + atStop.totalInr),
      lockedProfitInr: round2((lockPrice - row.ask) * row.lotSize - atLock.totalInr),
    },
  };
}

export function spreadPct(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || !(bid > 0) || ask < bid) {
    return null;
  }
  return ((ask - bid) / ((ask + bid) / 2)) * 100;
}

function moneynessOf(side: OptionSide, strike: number, atm: number): Moneyness {
  if (strike === atm) {
    return 'at the money';
  }
  const inTheMoney = side === 'CE' ? strike < atm : strike > atm;
  return inTheMoney ? 'in the money' : 'out of the money';
}

/**
 * Liquid, fairly priced contracts near the money for the side the rules chose,
 * best first: delta closest to 0.5, then tightest spread, then deepest open interest.
 * With a chart `plan`, each contract also needs room for the ₹ profit lock and a loss at the
 * chart stop within the limit; those rejections carry a `code`.
 */
export function buildCandidates(
  input: {
    chain: readonly ChainQuote[];
    index: IndexOptionName;
    side: OptionSide;
    spot: number;
    step: number;
    todayYmd: string;
    indexDaily: readonly DailyBar[];
    plan?: TradePlanInput;
  },
  params: StrategyParams,
): { candidates: ContractCandidate[]; rejected: CandidateRejection[] } {
  const atm = atmStrike(input.spot, input.step);
  const rejected: CandidateRejection[] = [];
  const accepted: Array<Omit<ContractCandidate, 'rank'>> = [];

  for (const row of input.chain) {
    if (row.index !== input.index || row.side !== input.side) {
      continue;
    }
    const stepsFromAtm = Math.round((row.strike - atm) / input.step);
    if (Math.abs(stepsFromAtm) > params.strikeBand) {
      continue;
    }
    const reject = (reason: string) => rejected.push({ symbol: row.symbol, reason });
    if (row.lotSize === null) {
      reject('lot size unknown');
      continue;
    }
    if (row.ltp === null || row.bid === null || row.ask === null) {
      reject('no live buy and sell prices');
      continue;
    }
    if (row.ask < params.minPremium) {
      reject(`price below ₹${params.minPremium}`);
      continue;
    }
    const spread = spreadPct(row.bid, row.ask);
    if (spread === null || spread > params.maxSpreadPct) {
      reject('gap between buy and sell prices is too wide');
      continue;
    }
    if (row.oi < params.minOptionOi || row.volume <= 0) {
      reject('too little trading interest');
      continue;
    }
    const greeks = computeOptionGreeks({
      premium: row.ltp,
      spot: input.spot,
      strike: row.strike,
      expiryYmd: row.expiry,
      asOfYmd: input.todayYmd,
      side: row.side,
      indexDaily: input.indexDaily,
    });
    if (
      greeks.absDelta === null ||
      greeks.absDelta < params.minDelta ||
      greeks.absDelta > params.maxDelta
    ) {
      reject('moves too little or too much with the index');
      continue;
    }
    if (greeks.ivHv !== null && greeks.ivHv > params.maxIvToHv) {
      reject('expensive compared with normal market swings');
      continue;
    }
    const clearsFees = buyClearsFeeTarget({
      premium: row.ask,
      quantity: row.lotSize,
      targetNetPnlPct: params.targetNetPnlPct,
    });
    if (!clearsFees) {
      reject('charges would eat the profit target');
      continue;
    }
    let plan: ContractPlan | null = null;
    if (input.plan) {
      const checked = planContract(
        { ask: row.ask, bid: row.bid, lotSize: row.lotSize },
        greeks.absDelta,
        input.plan,
        params,
      );
      if (!('plan' in checked)) {
        rejected.push({ symbol: row.symbol, reason: checked.reason, code: checked.code });
        continue;
      }
      plan = checked.plan;
    }
    const fees = estimateOptionsRoundTripCost({
      buyPremium: row.ask,
      sellPremium: row.ask * (1 + params.targetNetPnlPct / 100),
      quantity: row.lotSize,
    });
    accepted.push({
      symbol: row.symbol,
      index: row.index,
      side: row.side,
      strike: row.strike,
      expiry: row.expiry,
      token: row.token,
      lotSize: row.lotSize,
      ltp: row.ltp,
      bid: row.bid,
      ask: row.ask,
      spreadPct: Number(spread.toFixed(3)),
      oi: row.oi,
      volume: row.volume,
      delta: Number(greeks.absDelta.toFixed(3)),
      ivToHv: greeks.ivHv === null ? null : Number(greeks.ivHv.toFixed(3)),
      stepsFromAtm,
      moneyness: moneynessOf(row.side, row.strike, atm),
      feeInr: fees.totalInr,
      plan,
    });
  }

  accepted.sort(
    (left, right) =>
      Math.abs(left.delta - 0.5) - Math.abs(right.delta - 0.5) ||
      left.spreadPct - right.spreadPct ||
      right.oi - left.oi,
  );
  return {
    candidates: accepted.map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    rejected,
  };
}
