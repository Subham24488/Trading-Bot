import type { LlmTradeAction } from '@prisma/client';

import { database } from '../database.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

type UpdateId = 'chain-dvol' | 'pattern-side' | 'exit-facts' | 'flat-1520';

const PROMPT_LINES: Record<UpdateId, string> = {
  'chain-dvol': 'chain-dvol: chainConfluence ok = PCR band OR signed dOI. Remove dVol>0.',
  'pattern-side': 'pattern-side: isWeakTape true unless pattern!=none AND candle side==CE/PE.',
  'exit-facts': 'exit-facts: EXIT why is only "premium stop"|"session close"|"structure flip" from pnl and clock.',
  'flat-1520': 'flat-1520: weekday flat at 15:20 IST, not SESSION_END_HOUR-1.',
};

const SUGGESTIONS: Record<
  UpdateId,
  { id: UpdateId; what: string; why: string; expectedEffect: string; source: string }
> = {
  'chain-dvol': {
    id: 'chain-dvol',
    what: 'Drop || dVol > 0 from chainConfluence. Count the chain pillar only when PCR is in the side band or signed delta-OI agrees with CE/PE.',
    why: 'chainConfluence treats any positive delta-volume as confirmation, so scoreConfluence can reach 2 without OI or PCR support and a mixed-swings BUY still passes.',
    expectedEffect: 'Fewer long-premium entries that only had noisy volume, which is how weak tapes become realized premium losses.',
    source:
      'Vilkov et al. 0DTE notes: long-premium PnL is entry cost plus the signed move, not a volume print. https://github.com/vilkovgr/0dte-strategies/blob/main/docs/paper/paper-annotated.md',
  },
  'pattern-side': {
    id: 'pattern-side',
    what: 'Treat the tape as weak unless pattern is not none and the last 1-3 candle side matches the contract (CE/PE).',
    why: 'isWeakTape still passes when structure plus a noisy chain pillar both count, so CE/PE can be chosen from trend while pattern is none.',
    expectedEffect: 'Blocks the mixed-swings entry that later exits at a large premium loss.',
    source:
      '0DTE Quant Lab: rules-based confirmation, not a single loose filter. https://0dteoption.com/research/delta-neutral-0dte-strategy/',
  },
  'exit-facts': {
    id: 'exit-facts',
    what: 'Set EXIT why only to premium stop, session close, or structure flip from price and the clock. Do not keep free-text claims of a target or news.',
    why: 'sanitizeExitWhy only strips phrases. The stored why can still say target achieved or news risk when pnl is negative and news is none.',
    expectedEffect: 'Exit rows match the fill. A loss cannot be labeled as a target or as news.',
    source:
      'Vilkov et al.: narrative targets do not change entry-cost PnL. https://github.com/vilkovgr/0dte-strategies/blob/main/docs/paper/paper-annotated.md',
  },
  'flat-1520': {
    id: 'flat-1520',
    what: 'Flatten weekday premium at 15:20 IST instead of only SESSION_END_HOUR - 1.',
    why: 'isNearOrAfterSessionClose follows SESSION_END_HOUR. If that hour is after 15:00 IST the book can stay long through the cash close.',
    expectedEffect: 'No overnight gap on index premium after the cash session.',
    source:
      'Numerix, Stress testing at lunchtime (2026): intraday option books flatten inside the session. https://www.numerix.com/sites/default/files/file/2026-01/Numerix_White_Paper_Stress_Testing_at_Lunchtime.pdf',
  },
};

export type SessionReviewMistake = {
  symbol: string;
  action: LlmTradeAction;
  decidedAt: string;
  evidence: string;
  lossCause: string;
  whyDecision: string;
};

export type SessionReviewResult = {
  sessionsReviewed: Array<{ date: string; decisionCount: number }>;
  mistakes: SessionReviewMistake[];
  rootCauses: Array<{ id: UpdateId; where: string; detail: string; count: number }>;
  suggestedUpdates: Array<(typeof SUGGESTIONS)[UpdateId]>;
  suggestedUpdatesPrompt: string;
};

function suggestedUpdatesPrompt(ids: readonly UpdateId[]): string {
  if (ids.length === 0) {
    return '';
  }
  const lines = ids.map((id) => PROMPT_LINES[id]);
  return `Implement only these gates. Do not change other routes.\n${lines.join('\n')}\nReturn a minimal diff. No tests.`;
}

type ReviewRow = {
  decidedAt: Date;
  symbol: string;
  action: LlmTradeAction;
  rationale: string;
  marketSnapshot: unknown;
  buyPrice: unknown;
  currentPrice: unknown;
  sellPrice: unknown;
};

function istYmd(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return parts;
}

function parseRange(startDate: string, endDate: string): { from: Date; to: Date } {
  if (!YMD.test(startDate) || !YMD.test(endDate) || startDate > endDate) {
    throw Object.assign(new Error('startDate and endDate must be YYYY-MM-DD and startDate <= endDate.'), {
      statusCode: 400,
    });
  }
  const from = new Date(`${startDate}T00:00:00+05:30`);
  const to = new Date(`${endDate}T23:59:59.999+05:30`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Object.assign(new Error('Invalid startDate or endDate.'), { statusCode: 400 });
  }
  return { from, to };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const CAUSE_ORDER: UpdateId[] = ['chain-dvol', 'pattern-side', 'exit-facts', 'flat-1520'];
const TOP_N = 2;

const CAUSE_WHERE: Record<UpdateId, string> = {
  'chain-dvol': 'decisionContext.chainConfluence',
  'pattern-side': 'decisionContext.isWeakTape',
  'exit-facts': 'decisionContext.sanitizeExitWhy',
  'flat-1520': 'decisionContext.isNearOrAfterSessionClose',
};

const PAIR_SELECT = {
  decidedAt: true,
  symbol: true,
  action: true,
  rationale: true,
  marketSnapshot: true,
  buyPrice: true,
  currentPrice: true,
  sellPrice: true,
} as const;

type TapeEvidence = {
  pattern: string | null;
  sideFromCandles: string | null;
  chainNote: string | null;
  newsLevel: string | null;
  chainOk: boolean | null;
  structure: string[];
};

type ChainParts = { pcr: number | null; dCeOi: number; dPeOi: number; dVol: number };

function tapeOf(snapshot: Record<string, unknown>): TapeEvidence | null {
  const tape = asRecord(snapshot.tape);
  if (Object.keys(tape).length === 0) {
    return null;
  }
  const confluence = asRecord(tape.confluence);
  const pattern = typeof tape.pattern === 'string' ? tape.pattern : null;
  const sideFromCandles = typeof tape.sideFromCandles === 'string' ? tape.sideFromCandles : null;
  const chainNote = typeof tape.chainNote === 'string' ? tape.chainNote : null;
  const newsLevel = typeof tape.newsLevel === 'string' ? tape.newsLevel : null;
  const chainOk = typeof confluence.chain === 'boolean' ? confluence.chain : null;
  const structure = Array.isArray(tape.structure) ? tape.structure.filter((item) => typeof item === 'string') : [];
  return { pattern, sideFromCandles, chainNote, newsLevel, chainOk, structure };
}

function contractSide(symbol: string): 'CE' | 'PE' | null {
  if (symbol.endsWith('CE')) {
    return 'CE';
  }
  if (symbol.endsWith('PE')) {
    return 'PE';
  }
  return null;
}

function parseChainNote(note: string): ChainParts | null {
  const match = note.match(
    /pcr=(na|-?\d+(?:\.\d+)?)\s+dCeOi=(-?\d+(?:\.\d+)?)\s+dPeOi=(-?\d+(?:\.\d+)?)\s+dVol=(-?\d+(?:\.\d+)?)/,
  );
  if (!match) {
    return null;
  }
  const pcr = match[1] === 'na' ? null : Number(match[1]);
  const dCeOi = Number(match[2]);
  const dPeOi = Number(match[3]);
  const dVol = Number(match[4]);
  if (![dCeOi, dPeOi, dVol].every(Number.isFinite) || (pcr !== null && !Number.isFinite(pcr))) {
    return null;
  }
  return { pcr, dCeOi, dPeOi, dVol };
}

function directionalChain(side: 'CE' | 'PE', parts: ChainParts): boolean {
  if (side === 'CE') {
    return (parts.pcr !== null && parts.pcr < 0.95) || (parts.dCeOi > 0 && parts.dPeOi <= 0);
  }
  return (parts.pcr !== null && parts.pcr > 1.05) || (parts.dPeOi > 0 && parts.dCeOi <= 0);
}

function labeledWhy(rationale: string): string {
  const match = rationale.match(/(?:^|;)\s*why=([^;]*)/i);
  return match?.[1]?.trim() ?? '';
}

function canonicalExitWhy(why: string): boolean {
  const text = why.trim().toLowerCase();
  return text.startsWith('premium stop') || text.startsWith('session close') || text.startsWith('structure flip');
}

function istClock(date: Date): { weekday: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const hourRaw = read('hour');
  return {
    weekday: read('weekday'),
    hour: Number(hourRaw === '24' ? '0' : hourRaw || '0'),
    minute: Number(read('minute') || '0'),
  };
}

function causesForPair(input: {
  symbol: string;
  buyTape: TapeEvidence | null;
  exitTape: TapeEvidence | null;
  exitWhy: string;
  exitAt: Date;
}): UpdateId[] {
  const ids: UpdateId[] = [];
  const side = contractSide(input.symbol);
  const buy = input.buyTape;
  if (buy && side && buy.chainOk === true && buy.chainNote) {
    const parts = parseChainNote(buy.chainNote);
    if (parts && parts.dVol > 0 && !directionalChain(side, parts)) {
      ids.push('chain-dvol');
    }
  }
  if (buy && side && buy.pattern !== null && (buy.pattern === 'none' || buy.sideFromCandles !== side)) {
    ids.push('pattern-side');
  }
  if (input.exitTape?.newsLevel === 'none' && input.exitWhy.length > 0 && !canonicalExitWhy(input.exitWhy)) {
    ids.push('exit-facts');
  }
  const clock = istClock(input.exitAt);
  const weekday = clock.weekday !== 'Sat' && clock.weekday !== 'Sun';
  if (weekday && (clock.hour > 15 || (clock.hour === 15 && clock.minute >= 20))) {
    ids.push('flat-1520');
  }
  return ids;
}

function rankCauses(counts: Map<UpdateId, number>, pairCount: number): UpdateId[] {
  const minCount = pairCount >= 3 ? 2 : 1;
  return CAUSE_ORDER.filter((id) => (counts.get(id) ?? 0) >= minCount)
    .sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0))
    .slice(0, TOP_N);
}

export async function reviewTradingSessions(startDate: string, endDate: string): Promise<SessionReviewResult> {
  const { from, to } = parseRange(startDate, endDate);
  const rows = await database.llmTradeDecision.findMany({
    where: { decidedAt: { gte: from, lte: to } },
    orderBy: [{ decidedAt: 'asc' }, { asOf: 'asc' }],
    select: PAIR_SELECT,
  });

  const byDate = new Map<string, number>();
  for (const row of rows) {
    const date = istYmd(row.decidedAt);
    byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }

  const openBuy = new Map<string, ReviewRow>();
  const roundTrips: Array<{ buy: ReviewRow; exit: ReviewRow }> = [];
  for (const row of rows) {
    if (row.action === 'BUY') {
      openBuy.set(row.symbol, row);
    } else if (row.action === 'EXIT') {
      const buy = openBuy.get(row.symbol);
      if (buy) {
        roundTrips.push({ buy, exit: row });
        openBuy.delete(row.symbol);
      }
    }
  }

  const losses: Array<{ buy: ReviewRow; exit: ReviewRow; entry: number; leave: number; pnlPct: number }> = [];
  for (const trip of roundTrips) {
    const entry = num(trip.buy.buyPrice) ?? num(trip.buy.currentPrice);
    const leave = num(trip.exit.sellPrice) ?? num(trip.exit.currentPrice);
    if (entry === null || leave === null || !(entry > 0)) {
      continue;
    }
    const pnlPct = ((leave - entry) / entry) * 100;
    if (pnlPct < 0) {
      losses.push({ ...trip, entry, leave, pnlPct });
    }
  }

  const counts = new Map<UpdateId, number>();
  const mistakes: SessionReviewMistake[] = [];

  for (const loss of losses) {
    const buyTape = tapeOf(asRecord(loss.buy.marketSnapshot));
    const exitTape = tapeOf(asRecord(loss.exit.marketSnapshot));
    const exitWhy = labeledWhy(loss.exit.rationale);
    const holds = rows.filter(
      (row) =>
        row.action === 'HOLD' &&
        row.symbol === loss.buy.symbol &&
        row.decidedAt.getTime() >= loss.buy.decidedAt.getTime() &&
        row.decidedAt.getTime() <= loss.exit.decidedAt.getTime(),
    ).length;
    const fired = causesForPair({
      symbol: loss.buy.symbol,
      buyTape,
      exitTape,
      exitWhy,
      exitAt: loss.exit.decidedAt,
    });
    for (const id of fired) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const evidence = [
      `pattern=${buyTape?.pattern ?? 'na'}`,
      `sideFromCandles=${buyTape?.sideFromCandles ?? 'na'}`,
      `chainNote=${buyTape?.chainNote ?? 'na'}`,
      `confluence.chain=${buyTape === null || buyTape.chainOk === null ? 'na' : String(buyTape.chainOk)}`,
      `structure=${buyTape?.structure.join(',') || 'na'}`,
      `newsLevel=${exitTape?.newsLevel ?? 'na'}`,
      `exitWhy=${exitWhy || 'na'}`,
      `holds=${holds}`,
    ].join('; ');
    mistakes.push({
      symbol: loss.buy.symbol,
      action: 'BUY',
      decidedAt: loss.buy.decidedAt.toISOString(),
      evidence,
      lossCause: `Round trip BUY ${loss.entry} → EXIT ${loss.leave} (${loss.pnlPct.toFixed(1)}%)`,
      whyDecision: `action=BUY→EXIT; pattern=${buyTape?.pattern ?? 'na'}; chain=${buyTape?.chainNote ?? 'na'}; news=${exitTape?.newsLevel ?? 'na'}; why=${exitWhy || 'na'}`,
    });
  }

  const ranked = rankCauses(counts, losses.length);
  const rootCauses = ranked.map((id) => ({
    id,
    where: CAUSE_WHERE[id],
    detail: `n=${counts.get(id) ?? 0}/${losses.length}. ${SUGGESTIONS[id].why}`,
    count: counts.get(id) ?? 0,
  }));
  const suggestedUpdates = ranked.map((id) => SUGGESTIONS[id]);
  return {
    sessionsReviewed: [...byDate.entries()].map(([date, decisionCount]) => ({ date, decisionCount })),
    mistakes,
    rootCauses,
    suggestedUpdates,
    suggestedUpdatesPrompt: suggestedUpdatesPrompt(ranked),
  };
}
