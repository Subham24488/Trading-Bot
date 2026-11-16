import { describe, expect, it, vi } from 'vitest';

import { pickContract } from '../src/llm/contractPicker.js';
import { blackScholesPrice } from '../src/options/greeksIv.js';
import {
  chooseTradingExpiry,
  nearestFuture,
  parseNfoIndexOptions,
} from '../src/options/nfoChain.js';
import { estimateOptionsRoundTripCost } from '../src/llm/optionTradeCosts.js';
import {
  buildCandidates,
  type ChainQuote,
  type TradePlanInput,
} from '../src/strategy/contracts.js';
import { DEFAULT_STRATEGY, type StrategyParams } from '../src/strategy/params.js';
import { MOMENTUM_RULES } from './marketFixtures.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

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

describe('expiry and futures selection', () => {
  it('can skip a contract that expires today', () => {
    expect(chooseTradingExpiry(['2026-10-28', '2026-10-21'], '2026-10-21')).toBe('2026-10-21');
    expect(chooseTradingExpiry(['2026-10-28', '2026-10-21'], '2026-10-21', 1)).toBe('2026-10-28');
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

  it('puts the stop ₹10 under the buy price on the tick, the lock ₹10 over it and no target', () => {
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
      expect(stopped.lockedProfitInr).toBeGreaterThan(10 * 65 - 100);
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
    expect(candidatesFor(nearMoney(), MOMENTUM_RULES, far).rejected[0]).toMatchObject({
      code: 'risk-too-wide',
    });
  });
});

describe('pickContract', () => {
  const { candidates } = candidatesFor([callQuote(24_900), callQuote(25_000), callQuote(25_100)]);
  const input = {
    index: 'NIFTY',
    side: 'CE' as const,
    score: 6,
    minutesToSquareOff: 280,
    candidates,
  };

  it('uses the LLM pick when it is one of the candidates', async () => {
    const llm = {
      getModel: () => 'test-model',
      completeJson: vi.fn().mockResolvedValue({
        text: '{"symbol":"nifty26oct25100ce","reason":"Cheaper with a tight spread."}',
        parsed: { symbol: 'nifty26oct25100ce', reason: 'Cheaper with a tight spread.' },
      }),
    };
    const result = await pickContract(llm, input, logger);
    expect(result).toMatchObject({
      pickedBy: 'llm',
      note: 'Cheaper with a tight spread.',
      candidate: { symbol: 'NIFTY26OCT25100CE' },
      llm: { model: 'test-model' },
    });
    const userPayload = JSON.parse(llm.completeJson.mock.calls[0]?.[0]?.[1]?.content ?? '{}') as {
      candidates: Array<{ s: string }>;
    };
    expect(userPayload.candidates.map((candidate) => candidate.s)).toEqual(
      candidates.map((candidate) => candidate.symbol),
    );
  });

  it('falls back to the top-ranked contract on an invalid answer or an LLM failure', async () => {
    const invalid = {
      getModel: () => 'test-model',
      completeJson: vi.fn().mockResolvedValue({
        text: '{}',
        parsed: { symbol: 'BANKNIFTY26OCT55000CE', reason: 'Not offered.' },
      }),
    };
    const failing = {
      getModel: () => 'test-model',
      completeJson: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    await expect(pickContract(invalid, input, logger)).resolves.toMatchObject({
      pickedBy: 'fallback',
      candidate: { symbol: candidates[0]?.symbol },
    });
    await expect(pickContract(failing, input, logger)).resolves.toMatchObject({
      pickedBy: 'fallback',
      llm: null,
    });
  });

  it('retries with a larger budget when the model runs out of tokens before writing JSON', async () => {
    const llm = {
      getModel: () => 'test-model',
      completeJson: vi
        .fn()
        .mockRejectedValueOnce(new Error('Groq chat completion failed (400 ): json_validate_failed'))
        .mockResolvedValueOnce({
          text: '{"symbol":"NIFTY26OCT25000CE","reason":"At the money."}',
          parsed: { symbol: 'NIFTY26OCT25000CE', reason: 'At the money.' },
        }),
    };
    const result = await pickContract(llm, input, logger);
    expect(result).toMatchObject({ pickedBy: 'llm', candidate: { symbol: 'NIFTY26OCT25000CE' } });
    expect(llm.completeJson).toHaveBeenCalledTimes(2);
    expect(llm.completeJson.mock.calls[1]?.[1]).toEqual({ maxTokens: 4096 });
  });

  it('does not call the LLM when only one contract qualifies', async () => {
    const llm = { getModel: () => 'test-model', completeJson: vi.fn() };
    const result = await pickContract(
      llm,
      { ...input, candidates: candidates.slice(0, 1) },
      logger,
    );
    expect(result.pickedBy).toBe('only-candidate');
    expect(llm.completeJson).not.toHaveBeenCalled();
  });
});
