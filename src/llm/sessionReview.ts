import type { LlmTradeAction } from '@prisma/client';

import { database } from '../database.js';
import type { AppliedUpdateId } from './appliedDecisionUpdates.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const SUGGESTIONS: Record<
  AppliedUpdateId,
  { id: AppliedUpdateId; what: string; why: string; expectedEffect: string; source: string }
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
  rootCauses: Array<{ id: AppliedUpdateId; where: string; detail: string }>;
  suggestedUpdates: Array<(typeof SUGGESTIONS)[AppliedUpdateId]>;
};

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

function rationaleField(rationale: string, key: string): string {
  const match = rationale.match(new RegExp(`(?:^|;)\\s*${key}=([^;]*)`, 'i'));
  return match?.[1]?.trim() ?? '';
}

function snapshotNews(snapshot: Record<string, unknown>): string {
  const tape = asRecord(snapshot.tape);
  if (typeof tape.newsLevel === 'string') {
    return tape.newsLevel;
  }
  if (typeof tape.news === 'string') {
    return tape.news;
  }
  const risk = snapshot.newsRisk;
  if (risk && typeof risk === 'object') {
    const levels = Object.values(risk as Record<string, { level?: string }>).map((row) => row?.level ?? 'none');
    if (levels.includes('high')) {
      return 'high';
    }
    if (levels.includes('elevated')) {
      return 'elevated';
    }
  }
  return rationaleField('', 'news') || 'none';
}

export async function reviewTradingSessions(startDate: string, endDate: string): Promise<SessionReviewResult> {
  const { from, to } = parseRange(startDate, endDate);
  const rows = await database.llmTradeDecision.findMany({
    where: { decidedAt: { gte: from, lte: to } },
    orderBy: [{ decidedAt: 'asc' }, { asOf: 'asc' }],
    select: {
      decidedAt: true,
      symbol: true,
      action: true,
      rationale: true,
      marketSnapshot: true,
      buyPrice: true,
      currentPrice: true,
      sellPrice: true,
    },
  });

  const byDate = new Map<string, number>();
  for (const row of rows) {
    const date = istYmd(row.decidedAt);
    byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }

  const nextExitByBuy = new Map<ReviewRow, ReviewRow>();
  const openBuy = new Map<string, ReviewRow>();
  for (const row of rows) {
    if (row.action === 'BUY') {
      openBuy.set(row.symbol, row);
    } else if (row.action === 'EXIT') {
      const buy = openBuy.get(row.symbol);
      if (buy) {
        nextExitByBuy.set(buy, row);
        openBuy.delete(row.symbol);
      }
    }
  }

  const losingSymbols = new Set<string>();
  const lossBySymbol = new Map<string, { buy: number; exit: number; pnlPct: number }>();
  for (const [buy, exit] of nextExitByBuy) {
    const entry = num(buy.buyPrice) ?? num(buy.currentPrice);
    const leave = num(exit.sellPrice) ?? num(exit.currentPrice);
    if (entry === null || leave === null || !(entry > 0)) {
      continue;
    }
    const pnlPct = ((leave - entry) / entry) * 100;
    if (pnlPct < 0) {
      losingSymbols.add(buy.symbol);
      lossBySymbol.set(`${buy.symbol}:${buy.decidedAt.toISOString()}`, { buy: entry, exit: leave, pnlPct });
      lossBySymbol.set(exit.symbol, { buy: entry, exit: leave, pnlPct });
    }
  }

  const causeIds = new Set<AppliedUpdateId>();
  const mistakes: SessionReviewMistake[] = [];

  for (const row of rows) {
    const snapshot = asRecord(row.marketSnapshot);
    const tape = asRecord(snapshot.tape);
    const structure = Array.isArray(tape.structure) ? tape.structure.map(String).join(',') : rationaleField(row.rationale, 'structure');
    const pattern = typeof tape.pattern === 'string' ? tape.pattern : rationaleField(row.rationale, 'pattern');
    const news = snapshotNews(snapshot) || rationaleField(row.rationale, 'news') || 'none';
    const why = rationaleField(row.rationale, 'why') || row.rationale;
    const chain = typeof tape.chainNote === 'string' ? tape.chainNote : rationaleField(row.rationale, 'chain');
    const whyDecision = `action=${row.action}; structure=${structure || 'na'}; pattern=${pattern || 'na'}; chain=${chain || 'na'}; news=${news}; why=${why}`;

    const paired = row.action === 'BUY' ? nextExitByBuy.get(row) : undefined;
    const entry = num(row.buyPrice) ?? num(row.currentPrice);
    const exitPrice = paired ? num(paired.sellPrice) ?? num(paired.currentPrice) : num(row.sellPrice) ?? num(row.currentPrice);
    const pnlFromSnap = num(snapshot.pnlPct);
    let lossCause = 'No realized loss on this row.';
    let lost = false;
    if (row.action === 'EXIT' && entry !== null && exitPrice !== null && entry > 0) {
      const pnl = ((exitPrice - entry) / entry) * 100;
      if (pnl < 0) {
        lost = true;
        lossCause = `BUY ${entry} → EXIT ${exitPrice} (${pnl.toFixed(1)}%)`;
      }
    } else if (row.action === 'BUY' && paired && entry !== null && exitPrice !== null && entry > 0) {
      const pnl = ((exitPrice - entry) / entry) * 100;
      if (pnl < 0) {
        lost = true;
        lossCause = `Round trip BUY ${entry} → EXIT ${exitPrice} (${pnl.toFixed(1)}%)`;
      }
    } else if ((row.action === 'HOLD' || row.action === 'SKIP') && losingSymbols.has(row.symbol)) {
      const known = lossBySymbol.get(row.symbol);
      if (known) {
        lost = true;
        lossCause = `Kept open on a losing round trip BUY ${known.buy} → EXIT ${known.exit} (${known.pnlPct.toFixed(1)}%)`;
      }
    } else if (pnlFromSnap !== null && pnlFromSnap < 0 && row.action === 'EXIT') {
      lost = true;
      lossCause = `Snapshot pnlPct ${pnlFromSnap.toFixed(1)}%`;
    }

    if (!lost) {
      continue;
    }
    const evidence = `rationale=${row.rationale.slice(0, 500)}; snapshot=${JSON.stringify(snapshot).slice(0, 500)}`;
    mistakes.push({
      symbol: row.symbol,
      action: row.action,
      decidedAt: row.decidedAt.toISOString(),
      evidence,
      lossCause,
      whyDecision,
    });

    const mixed = /mixed swings/i.test(structure) || /mixed swings/i.test(row.rationale);
    const chainBlob = `${chain} ${row.rationale}`;
    const dVolOnly = /dVol=[1-9]/.test(chainBlob) && !/dPeOi=[1-9]|dCeOi=[1-9]/.test(chainBlob);
    if ((row.action === 'BUY' || lost) && (mixed || dVolOnly || pattern === 'none' || pattern === '')) {
      causeIds.add('chain-dvol');
      causeIds.add('pattern-side');
    }
    const claimedTarget = /target achieved|take[- ]?profit|hit target/i.test(row.rationale);
    const claimedNews = /news risk|event risk|headline risk/i.test(row.rationale);
    if (row.action === 'EXIT' && lost && (claimedTarget || (claimedNews && news === 'none'))) {
      causeIds.add('exit-facts');
    }
    const hourIst = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false,
    }).format(row.decidedAt);
    const hour = Number(hourIst === '24' ? '0' : hourIst);
    if (lost && (row.action === 'HOLD' || row.action === 'BUY' || row.action === 'EXIT') && hour >= 15) {
      causeIds.add('flat-1520');
    }
  }

  const rootCauses = [...causeIds].map((id) => {
    const where =
      id === 'chain-dvol'
        ? 'decisionContext.chainConfluence'
        : id === 'pattern-side'
          ? 'decisionContext.isWeakTape'
          : id === 'exit-facts'
            ? 'decisionContext.sanitizeExitWhy'
            : 'decisionContext.isNearOrAfterSessionClose';
    return { id, where, detail: SUGGESTIONS[id].why };
  });

  return {
    sessionsReviewed: [...byDate.entries()].map(([date, decisionCount]) => ({ date, decisionCount })),
    mistakes,
    rootCauses,
    suggestedUpdates: [...causeIds].map((id) => SUGGESTIONS[id]),
  };
}
