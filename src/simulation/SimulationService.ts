import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SessionLogger } from '../broker/kite/KiteTickerStream.js';
import { config } from '../config.js';
import { INDEX_OPTION_NAMES, type IndexOptionName } from '../instruments/kiteIndexUnderlyings.js';
import type { DecisionRunLock } from '../llm/decisionRunLock.js';
import { findDecisionsSince, type StoredDecisionRow } from '../llm/decisionStore.js';
import type { LlmChatClient } from '../llm/llmChatClient.js';
import { LlmTradeAdvisorService, storedNetPnlInr } from '../llm/LlmTradeAdvisorService.js';
import type { NewsService } from '../news/NewsService.js';
import { istClock, istDayStart, istTimeOnDay } from '../strategy/clock.js';
import { parseDecisionSnapshot } from '../strategy/snapshot.js';
import {
  RECORDING_VERSION,
  recordMarketDay,
  type MarketRecording,
  type RecorderBroker,
} from './marketRecorder.js';
import { ReplayBroker, ReplayHeadlines, SimulationClock } from './replayMarket.js';

/** The replay starts at the open (plus the cycle offset) and runs past the 15:15 square-off. */
const REPLAY_START_MINUTE = 9 * 60 + 15;
const REPLAY_END_MINUTE = 15 * 60 + 30;
const CYCLE_OFFSET_MS = 20_000;

export type SimulatedTrade = {
  tuuid: string | null;
  symbol: string;
  buyAt: string;
  buyPrice: number | null;
  exitAt: string | null;
  sellPrice: number | null;
  exitReason: string | null;
  netPnlInr: number | null;
};

export type SimulationResult = {
  simulationId: string;
  date: string;
  indexes: IndexOptionName[];
  dataFile: string;
  /** True when the market data was downloaded for this run; false when the saved file was reused. */
  recorded: boolean;
  decisions: Record<'BUY' | 'HOLD' | 'EXIT' | 'SKIP', number>;
  trades: SimulatedTrade[];
  netPnlInr: number;
  dataGaps: string[];
};

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** A past IST weekday, or today once the market has closed. */
function assertReplayableDate(date: string, now: Date): Date {
  const day = new Date(`${date}T00:00:00+05:30`);
  if (Number.isNaN(day.getTime()) || istClock(day).ymd !== date) {
    throw httpError(`date must be a real calendar date (YYYY-MM-DD); got ${date}.`, 400);
  }
  if (!istClock(day).isWeekday) {
    throw httpError(`${date} is a weekend; pick a trading day.`, 400);
  }
  const today = istClock(now);
  if (date > today.ymd || (date === today.ymd && today.minute < REPLAY_END_MINUTE)) {
    throw httpError(`${date} has not finished trading yet; simulate a past trading day.`, 400);
  }
  return day;
}

function summarize(
  rows: readonly StoredDecisionRow[],
): Pick<SimulationResult, 'decisions' | 'trades' | 'netPnlInr'> {
  const decisions = { BUY: 0, HOLD: 0, EXIT: 0, SKIP: 0 };
  for (const row of rows) {
    decisions[row.action] += 1;
  }
  const trades = rows
    .filter((row) => row.action === 'BUY')
    .map((buy): SimulatedTrade => {
      const exit = rows.find(
        (row) => row.action === 'EXIT' && row.tuuid !== null && row.tuuid === buy.tuuid,
      );
      const snapshot = exit ? parseDecisionSnapshot(exit.marketSnapshot) : null;
      return {
        tuuid: buy.tuuid,
        symbol: buy.symbol,
        buyAt: buy.decidedAt.toISOString(),
        buyPrice: buy.buyPrice,
        exitAt: exit?.decidedAt.toISOString() ?? null,
        sellPrice: exit?.sellPrice ?? null,
        exitReason: snapshot?.exit?.reason ?? null,
        netPnlInr: exit ? storedNetPnlInr(exit, snapshot) : null,
      };
    });
  const netPnlInr = trades.reduce((sum, trade) => sum + (trade.netPnlInr ?? 0), 0);
  return { decisions, trades, netPnlInr: Number(netPnlInr.toFixed(2)) };
}

/**
 * Replays a past trading day through the live decision logic: the day's market data is
 * downloaded once into `SIMULATION_DIR/<date>.json`, then a separate LlmTradeAdvisorService
 * runs on a virtual clock against it. Rows are stored flagged as simulated under a run id.
 */
export class SimulationService {
  private readonly llm: LlmChatClient;
  private readonly kite: RecorderBroker;
  private readonly news: Pick<NewsService, 'fetchIndexNewsOn'>;
  private readonly logger: SessionLogger;
  private readonly runLock: DecisionRunLock;

  public constructor(options: {
    llm: LlmChatClient;
    kite: RecorderBroker;
    news: Pick<NewsService, 'fetchIndexNewsOn'>;
    logger: SessionLogger;
    runLock: DecisionRunLock;
  }) {
    this.llm = options.llm;
    this.kite = options.kite;
    this.news = options.news;
    this.logger = options.logger;
    this.runLock = options.runLock;
  }

  public async run(input: {
    date: string;
    indexes?: readonly IndexOptionName[] | undefined;
  }): Promise<SimulationResult> {
    const indexes =
      input.indexes && input.indexes.length > 0 ? [...input.indexes] : [...INDEX_OPTION_NAMES];
    const day = assertReplayableDate(input.date, new Date());
    this.runLock.acquire('simulation');
    try {
      const { recording, dataFile, recorded } = await this.loadOrRecord(input.date, indexes);
      const start = new Date(istTimeOnDay(day, REPLAY_START_MINUTE).getTime() + CYCLE_OFFSET_MS);
      const clock = new SimulationClock(start);
      const simulationId = randomUUID();
      const advisor = new LlmTradeAdvisorService({
        llm: this.llm,
        kite: new ReplayBroker(recording, clock.now),
        news: new ReplayHeadlines(recording, clock.now),
        logger: this.logger,
        now: clock.now,
        simulationId,
      });
      this.logger.info(
        { simulationId, date: input.date, indexes, dataFile },
        'Simulation started.',
      );
      await advisor.replayDay({
        indexes,
        end: istTimeOnDay(day, REPLAY_END_MINUTE),
        advanceTo: clock.advanceTo,
      });
      const rows = await findDecisionsSince(istDayStart(day), simulationId);
      const result: SimulationResult = {
        simulationId,
        date: input.date,
        indexes,
        dataFile,
        recorded,
        ...summarize(rows),
        dataGaps: recording.dataGaps,
      };
      this.logger.info(
        { simulationId, decisions: result.decisions, netPnlInr: result.netPnlInr },
        'Simulation finished.',
      );
      return result;
    } finally {
      this.runLock.release('simulation');
    }
  }

  /** Reuses the saved day when it covers the indexes; otherwise records it for all of them. */
  private async loadOrRecord(
    date: string,
    indexes: readonly IndexOptionName[],
  ): Promise<{ recording: MarketRecording; dataFile: string; recorded: boolean }> {
    const directory = path.resolve(config.llm.simulationDir);
    const dataFile = path.join(directory, `${date}.json`);
    const saved = await readFile(dataFile, 'utf8')
      .then((text) => JSON.parse(text) as MarketRecording)
      .catch(() => null);
    if (
      saved?.version === RECORDING_VERSION &&
      saved.date === date &&
      indexes.every((index) => saved.indexes.includes(index))
    ) {
      return { recording: saved, dataFile, recorded: false };
    }
    const wanted = INDEX_OPTION_NAMES.filter(
      (index) => indexes.includes(index) || (saved?.indexes ?? []).includes(index),
    );
    const recording = await recordMarketDay({
      kite: this.kite,
      news: this.news,
      logger: this.logger,
      date,
      indexes: wanted,
    });
    await mkdir(directory, { recursive: true });
    await writeFile(dataFile, `${JSON.stringify(recording)}\n`, 'utf8');
    return { recording, dataFile, recorded: true };
  }
}
