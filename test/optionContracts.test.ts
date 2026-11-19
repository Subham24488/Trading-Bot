import { describe, expect, it } from 'vitest';

import { blackScholesPrice } from '../src/options/greeksIv.js';
import {
  chooseTradingExpiry,
  indexExpiries,
  nearestFuture,
  parseNfoIndexOptions,
} from '../src/options/nfoChain.js';
import { tradingDaysUntil } from '../src/strategy/clock.js';
import { estimateOptionsRoundTripCost } from '../src/llm/optionTradeCosts.js';
import {
  buildCandidates,
  type ChainQuote,
  type TradePlanInput,
} from '../src/strategy/contracts.js';
import { DEFAULT_STRATEGY, type StrategyParams } from '../src/strategy/params.js';
import { MOMENTUM_RULES } from './marketFixtures.js';

function callQuote(strike: number, overrides: Partial<ChainQuote> = {}): ChainQuote {
  const ltp = Number(blackScholesPrice(25_000, strike, 6 / 365, 0.065, 0.12, 'CE').toFixed(2));
  return {
    symbol: `NIFTY26OCT${strike}CE`,
    index: 'NIFTY',
    side: 'CE',
    strike,
    expiry: '2026-10-27',
    token: strike,
    lotSize: 65,
    ltp,
    bid: ltp - 0.1,
    ask: ltp + 0.1,
    oi: 2_000_000,
    volume: 40_000,
    oiChangeToday: null,
    ...overrides,
  };
}

function candidatesFor(
  chain: ChainQuote[],
  params: StrategyParams = DEFAULT_STRATEGY,
  plan?: TradePlanInput,
) {
  return buildCandidates(
    {
      chain,
      index: 'NIFTY',
      side: 'CE',
      spot: 25_000,
      step: 50,
      todayYmd: '2026-10-21',
      indexDaily: [],
      ...(plan ? { plan } : {}),
    },
    params,
  );
}

const nearMoney = () => [24_900, 24_950, 25_000, 25_050, 25_100].map((strike) => callQuote(strike));

describe('the option itself', () => {
  it('buys only options with delta 0.40–0.55 that cost ₹200 or less', () => {
    const { candidates } = candidatesFor(nearMoney());
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.delta).toBeGreaterThanOrEqual(0.4);
      expect(candidate.delta).toBeLessThanOrEqual(0.55);
    }
    // A ₹150 call 100 points in the money moves almost one-for-one with the index.
    const deep = candidatesFor([callQuote(24_900, { ltp: 150, bid: 149.9, ask: 150.1 })]);
    expect(deep.rejected[0]?.reason).toBe('moves too little or too much with the index');
    const pricey = candidatesFor([callQuote(25_000, { ltp: 230, bid: 229.9, ask: 230.1 })]);
    expect(pricey.candidates).toHaveLength(0);
    expect(pricey.rejected[0]?.reason).toBe('price above ₹200');
  });
});

describe('expiry and futures selection', () => {
  it('can skip a contract that expires today', () => {
    expect(chooseTradingExpiry(['2026-10-28', '2026-10-21'], '2026-10-21')).toBe('2026-10-21');
    expect(chooseTradingExpiry(['2026-10-28', '2026-10-21'], '2026-10-21', 1)).toBe('2026-10-28');
  });

  it('counts trading days without weekends and market holidays', () => {
    // Fri 20 Nov to Mon 23 Nov is one trading day; Tue 24 Nov is a holiday.
    expect(tradingDaysUntil('2026-11-20', '2026-11-23')).toBe(1);
    expect(tradingDaysUntil('2026-11-23', '2026-11-25')).toBe(1);
    expect(tradingDaysUntil('2026-11-16', '2026-11-16')).toBe(0);
  });

  it('uses next week from the day before expiry: at least 2 trading days away', () => {
    // The exchange lists Mon 23 Nov because Tue 24 Nov is a holiday.
    const expiries = ['2026-11-17', '2026-11-23', '2026-12-01'];
    const expiryOn = (day: string) => chooseTradingExpiry(expiries, day, 2);
    expect(expiryOn('2026-11-13')).toBe('2026-11-17');
    expect(expiryOn('2026-11-16')).toBe('2026-11-23');
    expect(expiryOn('2026-11-17')).toBe('2026-11-23');
    expect(expiryOn('2026-11-19')).toBe('2026-11-23');
    expect(expiryOn('2026-11-20')).toBe('2026-12-01');
    expect(expiryOn('2026-11-23')).toBe('2026-12-01');
  });

  it("reads each index's own expiry dates from the listed contracts", () => {
    const option = (name: string, expiry: string, token: number) => ({
      instrument_token: token,
      tradingsymbol: `${name}${token}CE`,
      name,
      expiry,
      strike: 25_000,
      instrument_type: 'CE',
      lot_size: 65,
    });
    // NIFTY has weekly expiries; BANKNIFTY only the monthly one.
    const contracts = parseNfoIndexOptions([
      option('NIFTY', '2026-11-17', 1),
      option('NIFTY', '2026-11-23', 2),
      option('BANKNIFTY', '2026-11-23', 3),
      option('BANKNIFTY', '2026-12-29', 4),
    ]);
    expect(indexExpiries(contracts, ['NIFTY', 'BANKNIFTY'], '2026-11-17', 2)).toEqual([
      { index: 'NIFTY', nextExpiry: '2026-11-17', expiryToday: true, tradingExpiry: '2026-11-23' },
      {
        index: 'BANKNIFTY',
        nextExpiry: '2026-11-23',
        expiryToday: false,
        tradingExpiry: '2026-11-23',
      },
    ]);
    // Mon 23 Nov is expiry day for both, taken from the list, not from the weekday.
    expect(
      indexExpiries(contracts, ['NIFTY', 'BANKNIFTY'], '2026-11-23', 2).map(
        (item) => item.expiryToday,
      ),
    ).toEqual([true, true]);
  });

  it('finds the nearest future and reads lot sizes from the instrument dump', () => {
    const rows = [
      {
        instrument_token: 1,
        tradingsymbol: 'NIFTY26OCTFUT',
        name: 'NIFTY',
        expiry: '2026-10-27',
        instrument_type: 'FUT',
        lot_size: 65,
      },
      {
        instrument_token: 2,
        tradingsymbol: 'NIFTY26NOVFUT',
        name: 'NIFTY',
        expiry: '2026-11-24',
        instrument_type: 'FUT',
        lot_size: 65,
      },
      {
        instrument_token: 3,
        tradingsymbol: 'CRUDEOILM26NOVFUT',
        name: 'CRUDEOILM',
        expiry: '2026-11-18',
        instrument_type: 'FUT',
      },
      {
        instrument_token: 4,
        tradingsymbol: 'NIFTY26OCT25000CE',
        name: 'NIFTY',
        expiry: '2026-10-27',
        strike: 25_000,
        instrument_type: 'CE',
        lot_size: '65',
      },
    ];
    expect(nearestFuture(rows, 'NIFTY', '2026-10-21')).toMatchObject({
      tradingsymbol: 'NIFTY26OCTFUT',
      lotSize: 65,
    });
    expect(nearestFuture(rows, 'NIFTY', '2026-10-27', 1)?.tradingsymbol).toBe('NIFTY26NOVFUT');
    expect(nearestFuture(rows, 'CRUDEOIL', '2026-10-21')).toBeNull();
    expect(parseNfoIndexOptions(rows)).toEqual([
      expect.objectContaining({ tradingsymbol: 'NIFTY26OCT25000CE', lotSize: 65 }),
    ]);
  });
});

describe('buildCandidates', () => {
  it('keeps liquid, fairly priced strikes near the money, at-the-money first under the earlier rules', () => {
    const { candidates, rejected } = candidatesFor(
      [
        callQuote(24_850),
        callQuote(24_900),
        callQuote(24_950, { bid: 150, ask: 160 }),
        callQuote(25_000),
        callQuote(25_050, { oi: 500 }),
        callQuote(25_100),
      ],
      MOMENTUM_RULES,
    );
    expect(candidates[0]).toMatchObject({
      symbol: 'NIFTY26OCT25000CE',
      moneyness: 'at the money',
      rank: 1,
    });
    expect(candidates.map((candidate) => candidate.symbol)).not.toContain('NIFTY26OCT24850CE');
    expect(
      candidates.every((candidate) => candidate.delta >= 0.35 && candidate.delta <= 0.65),
    ).toBe(true);
    expect(rejected).toEqual(
      expect.arrayContaining([
        { symbol: 'NIFTY26OCT24950CE', reason: 'gap between buy and sell prices is too wide' },
        { symbol: 'NIFTY26OCT25050CE', reason: 'too little trading interest' },
      ]),
    );
  });
});

describe('contract plans with the fixed ₹10 stop and ₹15 target', () => {
  const plan: TradePlanInput = {
    stopSpot: 24_980,
    targetSpot: 25_080,
    riskPoints: 20,
    rewardPoints: 80,
    atr: 15,
  };

  it('ranks the strike with delta nearest 0.40 first: one strike out of the money', () => {
    const { candidates } = candidatesFor(nearMoney(), DEFAULT_STRATEGY, plan);
    expect(candidates[0]).toMatchObject({
      symbol: 'NIFTY26OCT25100CE',
      moneyness: 'out of the money',
    });
    expect(candidates[0]!.delta).toBeGreaterThan(0.38);
    expect(candidates[0]!.delta).toBeLessThan(0.46);
  });

  it('puts the stop ₹10 under the buy price on the tick, moves it to the buy price at ₹10 over it, and has no target', () => {
    const { candidates } = candidatesFor(nearMoney(), DEFAULT_STRATEGY, plan);
    for (const candidate of candidates) {
      const stopped = candidate.plan!;
      // Rounded up to the ₹0.05 tick, so the loss is at most ₹10.
      expect(candidate.ask - stopped.premiumStop).toBeLessThanOrEqual(10 + 1e-9);
      expect(candidate.ask - stopped.premiumStop).toBeGreaterThan(9.95 - 1e-9);
      expect(Math.round(stopped.premiumStop * 20)).toBeCloseTo(stopped.premiumStop * 20, 6);
      expect(stopped.riskPerUnit).toBe(10);
      expect(stopped.targetPrice).toBeNull();
      expect(stopped.lockPrice).toBeCloseTo(candidate.ask + 10, 2);
      const atStop = estimateOptionsRoundTripCost({
        buyPremium: candidate.ask,
        sellPremium: stopped.premiumStop,
        quantity: 65,
      });
      expect(stopped.maxLossInr).toBeCloseTo(
        (candidate.ask - stopped.premiumStop) * 65 + atStop.totalInr,
        1,
      );
      expect(stopped.targetProfitInr).toBeNull();
      // Once ₹10 up, the stop-loss order moves to the buy price: sold there, only the charges are lost.
      const atBuyPrice = estimateOptionsRoundTripCost({
        buyPremium: candidate.ask,
        sellPremium: candidate.ask,
        quantity: 65,
      });
      expect(stopped.lockedProfitInr).toBeCloseTo(-atBuyPrice.totalInr, 1);
    }
  });

  it('needs a normal-sized move for ₹15; a near level or a far chart stop no longer rejects', () => {
    // Pullback entries: 13 points to the next level is fine (the 11-13 winners went through).
    const near = candidatesFor(nearMoney(), DEFAULT_STRATEGY, { ...plan, rewardPoints: 13 });
    expect(near.candidates.length).toBeGreaterThan(0);
    // The earlier vote-led rules still want room: 30 points is about ₹13, short of ₹15.
    const momentumTarget = { ...MOMENTUM_RULES, takeProfitInr: 15 };
    const short = candidatesFor(nearMoney(), momentumTarget, { ...plan, rewardPoints: 30 });
    expect(short.rejected.find((item) => item.symbol === 'NIFTY26OCT25100CE')).toMatchObject({
      code: 'target-out-of-reach',
      reason: expect.stringContaining('short of the ₹15 target'),
    });
    // A dead market: the ₹10 lock needs ~24 points, more than 3 swings of 7.
    const quiet = candidatesFor(nearMoney(), DEFAULT_STRATEGY, { ...plan, atr: 7 });
    expect(quiet.rejected.find((item) => item.symbol === 'NIFTY26OCT25100CE')).toMatchObject({
      code: 'target-out-of-reach',
      reason: expect.stringContaining('normal 5-minute swings'),
    });
    // A 60-point chart stop is beyond the ₹15 limit under the earlier rules, but not with ₹10.
    const far = { ...plan, riskPoints: 60 };
    expect(candidatesFor(nearMoney(), DEFAULT_STRATEGY, far).candidates.length).toBeGreaterThan(0);
    expect(
      candidatesFor(nearMoney(), MOMENTUM_RULES, far).rejected.some(
        (item) => item.code === 'risk-too-wide',
      ),
    ).toBe(true);
  });
});
