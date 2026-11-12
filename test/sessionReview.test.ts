import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LedgerContext } from '../src/review/enhancementLedger.js';
import type { RuleHit } from '../src/review/enhancementRules.js';
import type { ReviewRow, SkipEpisode } from '../src/review/tradeAnalysis.js';
import type { DecisionSnapshot } from '../src/strategy/snapshot.js';

vi.mock('../src/config.js', () => ({
  config: {
    llm: { minHoldMinutes: 15, targetNetPnlPct: 8 },
    review: { ledgerPath: 'data/strategy-enhancements.json' },
  },
}));

const findMany = vi.fn();

vi.mock('../src/database.js', () => ({
  database: { llmTradeDecision: { findMany } },
}));

const { DEFAULT_STRATEGY, tunableValues } = await import('../src/strategy/params.js');
const { buildSkipEpisodes, buildTrades, simulateExitRules } =
  await import('../src/review/tradeAnalysis.js');
const { evaluateRules, ruleMinSamples } = await import('../src/review/enhancementRules.js');
const { emptyLedger, planLedgerUpdate } = await import('../src/review/enhancementLedger.js');
const { reviewTradingSessions } = await import('../src/review/sessionReview.js');

const params = DEFAULT_STRATEGY;

function ist(time: string, ymd = '2026-10-21'): Date {
  return new Date(`${ymd}T${time}:00+05:30`);
}

function snapshot(overrides: Partial<DecisionSnapshot> = {}): DecisionSnapshot {
  return {
    schema: 'rules-v1',
    paramsVersion: 'abc12345',
    tunables: tunableValues(params),
    trigger: 'cycle',
    asOfIst: '2026-10-21T10:00:00+05:30',
    spots: { NIFTY: 25_000 },
    readings: [],
    market: { vixPct: 0, usdInrPct: 0, crudePct: 0, gapPct: 0, advancersPct: 50, headlineTone: 0 },
    news: {},
    headlines: [],
    blockedBy: [],
    leaning: null,
    dataGaps: [],
    ...overrides,
  };
}

function row(
  time: string,
  action: ReviewRow['action'],
  overrides: Partial<ReviewRow> = {},
): ReviewRow {
  return {
    decidedAt: ist(time),
    symbol: 'NIFTY26OCT25000CE',
    action,
    rationale: `${action} explained in plain words`,
    marketSnapshot: snapshot(),
    buyPrice: null,
    currentPrice: null,
    sellPrice: null,
    ...overrides,
  };
}

const position = {
  symbol: 'NIFTY26OCT25000CE',
  index: 'NIFTY',
  side: 'CE' as const,
  strike: 25_000,
  expiry: '2026-10-27',
  lotSize: 65,
  entryPrice: 100,
  enteredAt: ist('10:00').toISOString(),
  heldMinutes: 0,
  lastPrice: 100,
  pnlPct: 0,
  netPnlInr: 0,
  peakPrice: 100,
  troughPrice: 100,
  entryDelta: 0.5,
};

function skipRow(time: string, blockedBy: string[], spot: number): ReviewRow {
  return row(time, 'SKIP', {
    symbol: 'NIFTY26OCT25000CE',
    marketSnapshot: snapshot({
      spots: { NIFTY: spot },
      blockedBy,
      leaning: {
        index: 'NIFTY',
        side: 'CE',
        score: 4,
        symbol: 'NIFTY26OCT25000CE',
        premium: 100,
        delta: 0.5,
      },
    }),
  });
}

describe('buildTrades', () => {
  it('reports legacy, rules-based and unclosed trades with plain notes', () => {
    const legacyBuy = row('09:45', 'BUY', {
      symbol: 'NIFTY26OCT24900PE',
      rationale: 'trend=d=up; decision=BUY; why=breakout',
      marketSnapshot: { tape: { pattern: 'none' } },
      buyPrice: 100,
    });
    const legacyHold = row('10:00', 'HOLD', {
      symbol: 'NIFTY26OCT24900PE',
      currentPrice: 130,
      marketSnapshot: {},
    });
    const legacyExit = row('10:15', 'EXIT', {
      symbol: 'NIFTY26OCT24900PE',
      rationale: 'decision=EXIT; why=premium stop',
      marketSnapshot: {},
      buyPrice: 100,
      sellPrice: 90,
    });
    const tuuid = '6f1c2a4e-0b7d-4c1e-9a52-3d8e7f6a1b20';
    const buy = row('11:00', 'BUY', {
      buyPrice: 100,
      tuuid,
      marketSnapshot: snapshot({
        entry: {
          index: 'NIFTY',
          side: 'CE',
          score: 5,
          chosen: 'NIFTY26OCT25000CE',
          pickedBy: 'llm',
          pickerNote: 'closest to the money',
          candidates: [
            {
              symbol: 'NIFTY26OCT25000CE',
              strike: 25_000,
              ask: 100,
              spreadPct: 0.2,
              delta: 0.5,
              ivToHv: 1.2,
              rank: 1,
            },
          ],
        },
        position,
      }),
    });
    const exit = row('11:40', 'EXIT', {
      buyPrice: 100,
      sellPrice: 120,
      tuuid,
      marketSnapshot: snapshot({
        position: { ...position, peakPrice: 160, troughPrice: 98, netPnlInr: 1_230 },
        exit: { reason: 'trailing-stop', priceSource: 'bid' },
      }),
    });
    const unclosed = row('14:00', 'BUY', {
      symbol: 'NIFTY26OCT25100CE',
      buyPrice: 80,
      marketSnapshot: snapshot(),
    });

    const [legacy, rulesBased, open] = buildTrades([
      legacyBuy,
      legacyHold,
      legacyExit,
      buy,
      exit,
      unclosed,
    ]);

    expect(legacy).toMatchObject({
      legacy: true,
      tuuid: null,
      pnlPct: -10,
      bestPct: 30,
      exitReason: 'premium stop',
    });
    expect(legacy?.notes.join(' ')).toContain('previous LLM-based logic');
    expect(rulesBased).toMatchObject({
      legacy: false,
      tuuid,
      pnlPct: 20,
      bestPct: 60,
      netPnlInr: 1_230,
      exitReason: 'trailing-stop',
      afterLossSameDay: true,
      entry: { score: 5, ivToHv: 1.2, delta: 0.5 },
    });
    expect(rulesBased?.notes.join(' ')).toContain('Reached +60.0% but sold at +20.0%');
    expect(open).toMatchObject({ unclosed: true, exitAt: null });
  });
});

describe('buildSkipEpisodes', () => {
  it('groups repeated SKIPs and estimates the move that was missed', () => {
    const rows = [
      skipRow('10:00', ['chasing'], 25_000),
      skipRow('10:15', ['chasing'], 25_000),
      skipRow('10:30', ['chasing'], 25_000),
      skipRow('10:45', ['high-news'], 25_060),
      skipRow('15:15', ['entry-window'], 25_050),
    ];
    const [chasing, news] = buildSkipEpisodes(rows, params);
    expect(chasing).toMatchObject({
      rows: 3,
      blockedBy: ['chasing'],
      outcome: 'missed-winner',
      estPnlPct: 25,
    });
    expect(news).toMatchObject({ rows: 1, blockedBy: ['high-news'] });
  });
});

describe('simulateExitRules', () => {
  const start = { premium: 100, delta: 0.5, side: 'CE' as const, spot: 25_000, at: ist('10:00') };
  const path = (moves: Array<[string, number]>) =>
    moves.map(([time, spot]) => ({ at: ist(time), spot }));

  it('replays the ₹10 profit lock, the break-even lock and the stepped trailing stop like the live rules', () => {
    // ₹100 option: +₹12 (index +24 points), then back to +₹3: sold on the ₹10 profit lock.
    const locked = simulateExitRules(
      start,
      path([
        ['10:05', 25_024],
        ['10:10', 25_006],
      ]),
      params,
    );
    expect(locked).toMatchObject({ reason: 'profit-lock' });
    expect(locked?.bestPct).toBeCloseTo(12);
    expect(locked?.pnlPct).toBeCloseTo(3);

    // ₹200 option: +12% (₹24) keeps half, +6% (₹12), above the ₹10 lock: the trailing stop sells.
    expect(
      simulateExitRules(
        { ...start, premium: 200 },
        path([
          ['10:05', 25_048],
          ['10:10', 25_012],
        ]),
        params,
      ),
    ).toMatchObject({ reason: 'trailing-stop' });

    // +9% (₹9, short of the lock), then back to +1%: the break-even exit.
    expect(
      simulateExitRules(
        start,
        path([
          ['10:05', 25_018],
          ['10:10', 25_002],
        ]),
        params,
      ),
    ).toMatchObject({ reason: 'breakeven-stop' });
  });
});

describe('evaluateRules', () => {
  function newsEpisodes(count: number): SkipEpisode[] {
    return Array.from({ length: count }, (_, index) => ({
      startAt: ist('11:00'),
      endAt: ist('11:00'),
      rows: 1,
      index: 'NIFTY',
      side: 'CE' as const,
      score: 4 + (index % 2),
      blockedBy: ['high-news'],
      symbol: null,
      estPnlPct: 20,
      outcome: 'missed-winner' as const,
      rationale: 'skip',
    }));
  }

  it('suggests nothing until the evidence reaches the minimum sample', () => {
    expect(evaluateRules({ trades: [], episodes: newsEpisodes(7) }, params)).toEqual([]);
    expect(evaluateRules({ trades: [], episodes: newsEpisodes(8) }, params)).toEqual([
      expect.objectContaining({
        ruleKey: 'news-window',
        param: 'newsLookbackMinutes',
        direction: 'decrease',
        fromValue: 60,
        toValue: 45,
        sample: 8,
      }),
    ]);
  });
});

describe('planLedgerUpdate', () => {
  function hit(overrides: Partial<RuleHit> = {}): RuleHit {
    return {
      ruleKey: 'news-window',
      param: 'newsLookbackMinutes',
      direction: 'decrease',
      fromValue: 60,
      toValue: 45,
      sample: 9,
      minSample: 8,
      effect: 0.7,
      evidence: '7 of 9 setups blocked by major headlines would have won (estimated).',
      what: 'Minutes a major headline blocks new trades: 60 → 45',
      why: 'Headlines block trades for too long.',
      expectedEffect: 'Headlines block new trades for a shorter time.',
      citations: ['savor-wilson-2013'],
      ...overrides,
    };
  }

  function context(overrides: Partial<LedgerContext> = {}): LedgerContext {
    return {
      todayYmd: '2026-10-19',
      nowIso: '2026-10-19T10:00:00.000Z',
      runKey: '2026-10-13..2026-10-17',
      paramsVersion: 'abc12345',
      currentValues: tunableValues(params),
      trades: [],
      minSampleByRule: ruleMinSamples(),
      ...overrides,
    };
  }

  it('suggests once, stays idempotent on a re-run and reports repeats instead of new suggestions', () => {
    const first = planLedgerUpdate(emptyLedger('x'), [hit()], context());
    expect(first.outcome.suggested).toHaveLength(1);

    const rerun = planLedgerUpdate(first.ledger, [hit()], context());
    expect(rerun.outcome.suggested).toHaveLength(1);
    expect(rerun.ledger.days['2026-10-19']).toHaveLength(1);

    const nextDay = planLedgerUpdate(
      rerun.ledger,
      [hit()],
      context({ todayYmd: '2026-10-20', runKey: 'B' }),
    );
    expect(nextDay.outcome.suggested).toHaveLength(0);
    expect(nextDay.outcome.repeated[0]?.note).toContain('Still open since 2026-10-19');
  });

  it('holds back a contradicting suggestion inside the cooldown', () => {
    const first = planLedgerUpdate(emptyLedger('x'), [hit()], context());
    const flip = planLedgerUpdate(
      first.ledger,
      [hit({ direction: 'increase', toValue: 60, fromValue: 45 })],
      context({ todayYmd: '2026-10-22', runKey: 'B' }),
    );
    expect(flip.outcome.suggested).toHaveLength(0);
    expect(flip.outcome.heldBack[0]?.note).toContain('avoid flip-flopping');
  });

  it('detects an applied change and waits for new trades before suggesting more', () => {
    const first = planLedgerUpdate(emptyLedger('x'), [hit()], context());
    const applied = planLedgerUpdate(
      first.ledger,
      [hit({ fromValue: 45, toValue: 30 })],
      context({
        todayYmd: '2026-10-23',
        runKey: 'B',
        currentValues: { ...tunableValues(params), newsLookbackMinutes: 45 },
      }),
    );
    expect(applied.outcome.applied[0]).toMatchObject({
      event: 'applied',
      fromValue: 60,
      toValue: 45,
    });
    expect(applied.outcome.suggested).toHaveLength(0);
    expect(applied.outcome.heldBack[0]?.note).toContain('waiting for enough trades');
  });

  it('respects a rejection and suggests at most two changes per review', () => {
    const first = planLedgerUpdate(emptyLedger('x'), [hit()], context());
    const entries = first.ledger.days['2026-10-19']!;
    entries[0] = { ...entries[0]!, userStatus: 'rejected' };
    const afterRejection = planLedgerUpdate(
      first.ledger,
      [hit()],
      context({ todayYmd: '2026-10-21', runKey: 'B' }),
    );
    expect(afterRejection.outcome.heldBack[0]?.note).toContain('You rejected this change');

    const many = planLedgerUpdate(
      emptyLedger('x'),
      [
        hit(),
        hit({
          ruleKey: 'chase-limit',
          param: 'rsiChaseLimit',
          fromValue: 75,
          toValue: 70,
          effect: 0.9,
        }),
        hit({
          ruleKey: 'stop-loss-width',
          param: 'stopLossPct',
          fromValue: 25,
          toValue: 20,
          effect: 0.1,
        }),
      ],
      context(),
    );
    expect(many.outcome.suggested.map((entry) => entry.ruleKey)).toEqual([
      'chase-limit',
      'news-window',
    ]);
    expect(many.outcome.heldBack[0]).toMatchObject({ ruleKey: 'stop-loss-width' });
  });
});

describe('reviewTradingSessions', () => {
  let directory = '';

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'session-review-'));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps the existing response keys and writes the ledger idempotently', async () => {
    findMany.mockResolvedValue([
      { ...row('10:00', 'BUY', { buyPrice: 100 }), buyPrice: '100.0000' },
      { ...row('10:40', 'EXIT', { sellPrice: 80 }), buyPrice: '100.0000', sellPrice: '80.0000' },
      skipRow('11:00', ['chasing'], 25_000),
    ]);
    const ledgerPath = path.join(directory, 'ledger.json');
    const now = ist('18:00');

    const result = await reviewTradingSessions('2026-10-21', '2026-10-21', { ledgerPath, now });
    await reviewTradingSessions('2026-10-21', '2026-10-21', { ledgerPath, now });

    expect(Object.keys(result)).toEqual(
      expect.arrayContaining([
        'sessionsReviewed',
        'mistakes',
        'rootCauses',
        'suggestedUpdates',
        'suggestedUpdatesPrompt',
        'summary',
        'trades',
        'skips',
        'enhancements',
        'notes',
        'ledgerFile',
      ]),
    );
    expect(result.sessionsReviewed).toEqual([{ date: '2026-10-21', decisionCount: 3 }]);
    expect(result.trades[0]).toMatchObject({ pnlPct: -20, legacy: false });
    expect(result.skips).toMatchObject({ total: 1, rulesBased: 1, situations: 1 });
    expect(result.mistakes[0]).toMatchObject({ action: 'BUY', symbol: 'NIFTY26OCT25000CE' });
    expect(result.notes.join(' ')).toContain('need more data');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      version: number;
      days: object;
    };
    expect(ledger.version).toBe(1);
    expect(ledger.days).toEqual({});
  });
});
