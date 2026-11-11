import path from 'node:path';

import { config } from '../config.js';
import { database } from '../database.js';
import { formatIstTime, istClock } from '../strategy/clock.js';
import { GATE_IDS, type GateId } from '../strategy/decisionEngine.js';
import { paramsVersion, strategyParams, tunableValues } from '../strategy/params.js';
import { describeGate, formatInr } from '../strategy/rationale.js';
import { parseDecisionSnapshot } from '../strategy/snapshot.js';
import { CITATIONS, evaluateRules, ruleMinSamples, type CitationKey } from './enhancementRules.js';
import {
  loadLedger,
  planLedgerUpdate,
  saveLedger,
  type LedgerEntry,
  type LedgerOutcome,
} from './enhancementLedger.js';
import {
  buildSkipEpisodes,
  buildTrades,
  gateStats,
  legacySkipReasons,
  type AnalyzedTrade,
  type ReviewRow,
  type SkipEpisode,
} from './tradeAnalysis.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MIN_TRADES_FOR_TUNING = 10;
const NOTABLE_SKIPS = 5;

export type SessionReviewMistake = {
  symbol: string;
  action: string;
  decidedAt: string;
  evidence: string;
  lossCause: string;
  whyDecision: string;
};

export type TradeReport = {
  symbol: string;
  tuuid: string | null;
  entryAt: string;
  exitAt: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlPct: number | null;
  netPnlInr: number | null;
  heldMinutes: number | null;
  exitReason: string | null;
  bestPct: number | null;
  worstPct: number | null;
  legacy: boolean;
  notes: string[];
  rationale: string;
  exitRationale: string | null;
};

export type SessionReviewResult = {
  sessionsReviewed: Array<{ date: string; decisionCount: number }>;
  summary: string[];
  trades: TradeReport[];
  skips: {
    total: number;
    rulesBased: number;
    situations: number;
    missedWinners: number;
    avoidedLosers: number;
    neutral: number;
    byGate: Array<{
      gate: string;
      meaning: string;
      situations: number;
      missedWinners: number;
      avoidedLosers: number;
      neutral: number;
    }>;
    notableMissed: Array<{
      at: string;
      index: string;
      side: string;
      signalScore: number;
      blockedBy: string[];
      estimatedPnlPct: number | null;
      rationale: string;
    }>;
    legacyReasons: Array<{ reason: string; count: number }>;
  };
  mistakes: SessionReviewMistake[];
  rootCauses: Array<{ id: string; where: string; detail: string; count: number }>;
  suggestedUpdates: Array<{
    id: string;
    what: string;
    why: string;
    expectedEffect: string;
    source: string;
  }>;
  suggestedUpdatesPrompt: string;
  enhancements: LedgerOutcome;
  notes: string[];
  ledgerFile: string;
};

function parseRange(startDate: string, endDate: string): { from: Date; to: Date } {
  if (!YMD.test(startDate) || !YMD.test(endDate) || startDate > endDate) {
    throw Object.assign(
      new Error('startDate and endDate must be YYYY-MM-DD and startDate <= endDate.'),
      { statusCode: 400 },
    );
  }
  const from = new Date(`${startDate}T00:00:00+05:30`);
  const to = new Date(`${endDate}T23:59:59.999+05:30`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Object.assign(new Error('Invalid startDate or endDate.'), { statusCode: 400 });
  }
  return { from, to };
}

function storedNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isGateId(value: string): value is GateId {
  return (GATE_IDS as readonly string[]).includes(value);
}

function formatPct(value: number): string {
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1)}%`;
}

function citationText(keys: readonly string[]): string {
  return keys.map((key) => (key in CITATIONS ? CITATIONS[key as CitationKey] : key)).join(' | ');
}

function toTradeReport(trade: AnalyzedTrade): TradeReport {
  return {
    symbol: trade.symbol,
    tuuid: trade.tuuid,
    entryAt: trade.entryAt.toISOString(),
    exitAt: trade.exitAt?.toISOString() ?? null,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    pnlPct: trade.pnlPct === null ? null : Number(trade.pnlPct.toFixed(2)),
    netPnlInr: trade.netPnlInr,
    heldMinutes: trade.heldMinutes,
    exitReason: trade.exitReason,
    bestPct: trade.bestPct === null ? null : Number(trade.bestPct.toFixed(2)),
    worstPct: trade.worstPct === null ? null : Number(trade.worstPct.toFixed(2)),
    legacy: trade.legacy,
    notes: trade.notes,
    rationale: trade.rationale,
    exitRationale: trade.exitRationale,
  };
}

function mistakesFrom(
  trades: readonly AnalyzedTrade[],
  episodes: readonly SkipEpisode[],
): SessionReviewMistake[] {
  const losingTrades = trades
    .filter((trade) => trade.pnlPct !== null && trade.pnlPct < 0)
    .map((trade) => ({
      symbol: trade.symbol,
      action: 'BUY',
      decidedAt: trade.entryAt.toISOString(),
      evidence: trade.notes.join(' ') || `Exit reason: ${trade.exitReason ?? 'unknown'}.`,
      lossCause: `Bought at ${formatInr(trade.entryPrice ?? 0)} and sold at ${formatInr(trade.exitPrice ?? 0)} (${formatPct(trade.pnlPct ?? 0)}).`,
      whyDecision: trade.rationale,
    }));
  const missedMoves = episodes
    .filter((episode) => episode.outcome === 'missed-winner')
    .map((episode) => ({
      symbol: episode.symbol ?? episode.index,
      action: 'SKIP',
      decidedAt: episode.startAt.toISOString(),
      evidence: `Blocked by: ${episode.blockedBy.join(', ')}.`,
      lossCause: `Missed an estimated ${formatPct(episode.estPnlPct ?? 0)} move.`,
      whyDecision: episode.rationale,
    }));
  return [...losingTrades, ...missedMoves];
}

function summaryLines(input: {
  startDate: string;
  endDate: string;
  days: number;
  decisions: number;
  trades: readonly AnalyzedTrade[];
  skipRows: number;
  episodes: readonly SkipEpisode[];
  legacyRows: number;
  outcome: LedgerOutcome;
}): string[] {
  const closed = input.trades.filter((trade) => trade.pnlPct !== null);
  const wins = closed.filter((trade) => (trade.pnlPct ?? 0) > 0).length;
  const withMoney = closed.filter((trade) => trade.netPnlInr !== null);
  const netInr = withMoney.reduce((sum, trade) => sum + (trade.netPnlInr ?? 0), 0);
  const known = input.episodes.filter((episode) => episode.outcome !== 'unknown');
  const lines = [
    `Reviewed ${input.days} trading day(s) from ${input.startDate} to ${input.endDate}: ${input.decisions} decisions.`,
    closed.length === 0
      ? 'No completed trades in this period.'
      : `Trades: ${closed.length} completed (${wins} won, ${closed.length - wins} lost)` +
        (withMoney.length > 0
          ? `, about ${netInr < 0 ? '−' : '+'}${formatInr(Math.abs(netInr))} after estimated charges on the trades with a known lot size.`
          : '.'),
    `Skips: ${input.skipRows} in total, ${input.episodes.length} distinct situations from the rules-based loop; ` +
      `${known.filter((episode) => episode.outcome === 'missed-winner').length} would likely have won and ` +
      `${known.filter((episode) => episode.outcome === 'avoided-loser').length} would likely have lost (estimated from later index moves).`,
    `Suggestions: ${input.outcome.suggested.length} new, ${input.outcome.repeated.length} still open from earlier reviews, ` +
      `${input.outcome.heldBack.length} held back to avoid repeats or flip-flops.`,
  ];
  if (input.legacyRows > 0) {
    lines.push(
      `${input.legacyRows} decisions came from the previous LLM-based logic; they are reported but not used to tune the rules.`,
    );
  }
  return lines;
}

function updatePrompt(suggested: readonly LedgerEntry[]): string {
  if (suggested.length === 0) {
    return '';
  }
  const lines = suggested.map(
    (entry) =>
      `- ${entry.param}: ${entry.fromValue} → ${entry.toValue} (${entry.ruleKey}: ${entry.evidence.summary})`,
  );
  return (
    'Edit DEFAULT_STRATEGY in src/strategy/params.ts and change only:\n' +
    `${lines.join('\n')}\n` +
    'Keep everything else unchanged; the next session review measures the effect.'
  );
}

/**
 * Reviews every stored decision in the range: all trades (BUY → HOLD → EXIT) and all SKIPs.
 * Suggestions come from fixed rules with research citations and are checked against the
 * date-wise ledger so the same change is not repeated or reversed back and forth.
 */
export async function reviewTradingSessions(
  startDate: string,
  endDate: string,
  options: { ledgerPath?: string; now?: Date } = {},
): Promise<SessionReviewResult> {
  const { from, to } = parseRange(startDate, endDate);
  const now = options.now ?? new Date();
  const params = strategyParams({
    minHoldMinutes: config.llm.minHoldMinutes,
    targetNetPnlPct: config.llm.targetNetPnlPct,
  });
  const stored = await database.llmTradeDecision.findMany({
    where: { simulated: false, decidedAt: { gte: from, lte: to } },
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
      tuuid: true,
    },
  });
  const rows: ReviewRow[] = stored.map((row) => ({
    decidedAt: row.decidedAt,
    symbol: row.symbol,
    action: row.action,
    rationale: row.rationale,
    marketSnapshot: row.marketSnapshot,
    buyPrice: storedNumber(row.buyPrice),
    currentPrice: storedNumber(row.currentPrice),
    sellPrice: storedNumber(row.sellPrice),
    tuuid: row.tuuid,
  }));

  const byDate = new Map<string, number>();
  for (const row of rows) {
    const date = istClock(row.decidedAt).ymd;
    byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }

  const trades = buildTrades(rows);
  const episodes = buildSkipEpisodes(rows, params);
  const tuningTrades = trades.filter(
    (trade) => !trade.legacy && !trade.unclosed && !trade.startupExit,
  );
  const knownEpisodes = episodes.filter((episode) => episode.outcome !== 'unknown');
  const hits = evaluateRules({ trades: tuningTrades, episodes: knownEpisodes }, params);

  const ledgerFile = path.resolve(options.ledgerPath ?? config.review.ledgerPath);
  const { ledger, note: ledgerNote } = await loadLedger(ledgerFile, now.toISOString());
  const { ledger: updated, outcome } = planLedgerUpdate(ledger, hits, {
    todayYmd: istClock(now).ymd,
    nowIso: now.toISOString(),
    runKey: `${startDate}..${endDate}`,
    paramsVersion: paramsVersion(params),
    currentValues: tunableValues(params),
    trades: tuningTrades.map((trade) => ({
      entryYmd: istClock(trade.entryAt).ymd,
      pnlPct: trade.pnlPct,
      tunables: trade.tunables,
    })),
    minSampleByRule: ruleMinSamples(),
  });
  await saveLedger(ledgerFile, updated);

  const notes: string[] = [];
  if (ledgerNote) {
    notes.push(ledgerNote);
  }
  if (tuningTrades.length < MIN_TRADES_FOR_TUNING) {
    notes.push(
      `Only ${tuningTrades.length} rules-based trades in this period; trade-based suggestions need more data. ` +
        `Small samples are easy to over-read (${CITATIONS['harvey-liu-zhu-2016']}; ${CITATIONS['bailey-et-al-2017']}).`,
    );
  }
  notes.push(
    'Skip and after-exit outcomes are estimates from later index moves and the option’s sensitivity to the index; ' +
      'they ignore time decay and are used only to decide the direction of a suggestion.',
  );

  const legacyRows = rows.filter(
    (row) => parseDecisionSnapshot(row.marketSnapshot) === null,
  ).length;
  return {
    sessionsReviewed: [...byDate.entries()].map(([date, decisionCount]) => ({
      date,
      decisionCount,
    })),
    summary: summaryLines({
      startDate,
      endDate,
      days: byDate.size,
      decisions: rows.length,
      trades,
      skipRows: rows.filter((row) => row.action === 'SKIP').length,
      episodes,
      legacyRows,
      outcome,
    }),
    trades: trades.map(toTradeReport),
    skips: {
      total: rows.filter((row) => row.action === 'SKIP').length,
      rulesBased: rows.filter(
        (row) => row.action === 'SKIP' && parseDecisionSnapshot(row.marketSnapshot) !== null,
      ).length,
      situations: episodes.length,
      missedWinners: knownEpisodes.filter((episode) => episode.outcome === 'missed-winner').length,
      avoidedLosers: knownEpisodes.filter((episode) => episode.outcome === 'avoided-loser').length,
      neutral: knownEpisodes.filter((episode) => episode.outcome === 'neutral').length,
      byGate: gateStats(episodes).map((stats) => ({
        gate: stats.gate,
        meaning: isGateId(stats.gate) ? describeGate(stats.gate, params) : stats.gate,
        situations: stats.episodes,
        missedWinners: stats.missedWinners,
        avoidedLosers: stats.avoidedLosers,
        neutral: stats.neutral,
      })),
      notableMissed: knownEpisodes
        .filter((episode) => episode.outcome === 'missed-winner')
        .sort((left, right) => (right.estPnlPct ?? 0) - (left.estPnlPct ?? 0))
        .slice(0, NOTABLE_SKIPS)
        .map((episode) => ({
          at: `${istClock(episode.startAt).ymd} ${formatIstTime(episode.startAt)}`,
          index: episode.index,
          side: episode.side,
          signalScore: episode.score,
          blockedBy: episode.blockedBy,
          estimatedPnlPct: episode.estPnlPct,
          rationale: episode.rationale,
        })),
      legacyReasons: legacySkipReasons(rows),
    },
    mistakes: mistakesFrom(trades, knownEpisodes),
    rootCauses: outcome.suggested.map((entry) => ({
      id: entry.ruleKey,
      where: `src/strategy/params.ts → ${entry.param}`,
      detail: entry.evidence.summary,
      count: entry.evidence.sample,
    })),
    suggestedUpdates: outcome.suggested.map((entry) => ({
      id: entry.ruleKey,
      what: entry.what,
      why: entry.why,
      expectedEffect: entry.expectedEffect,
      source: citationText(entry.citations),
    })),
    suggestedUpdatesPrompt: updatePrompt(outcome.suggested),
    enhancements: outcome,
    notes,
    ledgerFile,
  };
}
