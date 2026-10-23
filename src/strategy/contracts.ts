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
  rank: number;
};

export type CandidateRejection = { symbol: string; reason: string };

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
