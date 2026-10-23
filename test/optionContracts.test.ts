import { describe, expect, it, vi } from 'vitest';

import { pickContract } from '../src/llm/contractPicker.js';
import { blackScholesPrice } from '../src/options/greeksIv.js';
import {
  chooseTradingExpiry,
  nearestFuture,
  parseNfoIndexOptions,
} from '../src/options/nfoChain.js';
import { buildCandidates, type ChainQuote } from '../src/strategy/contracts.js';
import { DEFAULT_STRATEGY } from '../src/strategy/params.js';

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

function candidatesFor(chain: ChainQuote[]) {
  return buildCandidates(
    {
      chain,
      index: 'NIFTY',
      side: 'CE',
      spot: 25_000,
      step: 50,
      todayYmd: '2026-10-21',
      indexDaily: [],
    },
    DEFAULT_STRATEGY,
  );
}

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
  it('keeps liquid, fairly priced strikes near the money, closest to at-the-money first', () => {
    const { candidates, rejected } = candidatesFor([
      callQuote(24_850),
      callQuote(24_900),
      callQuote(24_950, { bid: 150, ask: 160 }),
      callQuote(25_000),
      callQuote(25_050, { oi: 500 }),
      callQuote(25_100),
    ]);
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
