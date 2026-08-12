import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import type { KiteBroker } from '../broker/KiteBroker.js';
import { KiteTickerStream } from '../broker/kite/KiteTickerStream.js';
import type { SessionLogger } from '../broker/kite/KiteTickerStream.js';
import { QuoteCache } from '../broker/kite/QuoteCache.js';
import { config } from '../config.js';
import type { SessionInstrument, SessionStatusView } from '../domain.js';
import type { SessionControl } from './SessionControl.js';

export type MarketDataSessionServiceOptions = {
  broker: KiteBroker;
  sessionControl: SessionControl;
  logger: SessionLogger;
  quoteCache?: QuoteCache;
  tickerStream?: KiteTickerStream;
};

function getIstHour(date: Date = new Date()): number {
  const hourPart = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  })
    .formatToParts(date)
    .find((part) => part.type === 'hour')?.value;

  if (!hourPart) {
    return date.getUTCHours();
  }
  return Number(hourPart === '24' ? '0' : hourPart);
}

export function isInsideMarketWindow(date: Date = new Date()): boolean {
  const hour = getIstHour(date);
  return hour >= config.session.startHour && hour < config.session.endHour;
}

function formatElapsed(elapsedSeconds: number): string {
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

export class MarketDataSessionService {
  private readonly broker: KiteBroker;
  private readonly sessionControl: SessionControl;
  private readonly logger: SessionLogger;
  private readonly quoteCache: QuoteCache;
  private readonly tickerStream: KiteTickerStream;
  private timer: NodeJS.Timeout | undefined;
  private lastOutsideWindowLogAt = 0;

  public constructor(options: MarketDataSessionServiceOptions) {
    this.broker = options.broker;
    this.sessionControl = options.sessionControl;
    this.logger = options.logger;
    this.quoteCache = options.quoteCache ?? new QuoteCache();
    this.tickerStream =
      options.tickerStream ??
      new KiteTickerStream({
        broker: this.broker,
        quoteCache: this.quoteCache,
        logger: this.logger,
        mode: config.session.wsMode,
      });
  }

  public getStatus(): SessionStatusView {
    const startedAt = this.sessionControl.getStartedAt();
    const elapsedSeconds = startedAt
      ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))
      : 0;
    const lastSnapshotAt = this.sessionControl.getLastSnapshotAt();

    return {
      state: this.sessionControl.isRunning() ? 'running' : 'stopped',
      running: this.sessionControl.isRunning(),
      instruments: this.sessionControl.getInstruments(),
      streamConnected: this.tickerStream.isConnected(),
      startedAt: startedAt?.toISOString() ?? null,
      elapsedSeconds,
      lastSnapshotAt: lastSnapshotAt?.toISOString() ?? null,
      insideMarketWindow: isInsideMarketWindow(),
      tickSeconds: config.session.tickSeconds,
    };
  }

  /**
   * Boot-time Kite REST auth + WebSocket connect. Throws if either step fails.
   */
  public async connectAtBoot(): Promise<void> {
    this.logger.info('Connecting Kite broker at application boot.');
    try {
      await this.broker.connect();
    } catch (error: unknown) {
      this.logger.error({ err: error }, 'Kite broker boot connection failed.');
      if (error instanceof Error) {
        throw error;
      }
      const message =
        error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
          ? error.message
          : 'Kite broker boot connection failed.';
      throw new Error(message);
    }
    this.logger.info('Kite broker REST session verified.');

    this.logger.info('Establishing Kite ticker WebSocket at application boot.');
    try {
      await this.tickerStream.connect();
    } catch (error: unknown) {
      this.logger.error({ err: error }, 'Kite ticker WebSocket boot connection failed.');
      throw error instanceof Error
        ? error
        : new Error('Kite ticker WebSocket boot connection failed.');
    }

    if (!this.tickerStream.isConnected()) {
      throw new Error('Kite ticker WebSocket reported disconnected after connect().');
    }

    this.logger.info('Kite ticker WebSocket established at boot.');
  }

  public async start(instruments: SessionInstrument[]): Promise<SessionStatusView> {
    if (this.sessionControl.isRunning()) {
      throw Object.assign(new Error('A market-data session is already running.'), { statusCode: 400 });
    }

    this.logger.info(
      {
        instrumentCount: instruments.length,
        tokens: instruments.map((instrument) => instrument.instrumentToken),
        tickSeconds: config.session.tickSeconds,
      },
      'Starting market-data session.',
    );

    if (!this.tickerStream.isConnected()) {
      throw Object.assign(
        new Error('Kite ticker WebSocket is not connected. Restart the application.'),
        { statusCode: 503 },
      );
    }

    this.quoteCache.clear();
    this.sessionControl.start(instruments);

    try {
      await this.tickerStream.start(instruments.map((instrument) => instrument.instrumentToken));
    } catch (error: unknown) {
      this.sessionControl.stop();
      this.logger.error({ err: error }, 'Failed to subscribe Kite ticker for session.');
      throw error;
    }

    this.timer = setInterval(() => {
      void this.onTick();
    }, config.session.tickSeconds * 1000);
    this.timer.unref?.();

    this.logger.info(
      {
        startedAt: this.sessionControl.getStartedAt()?.toISOString(),
        instrumentCount: instruments.length,
      },
      'Market-data session started.',
    );

    return this.getStatus();
  }

  public async stop(): Promise<SessionStatusView> {
    if (!this.sessionControl.isRunning()) {
      this.logger.info('Stop requested while session is already stopped.');
      return this.getStatus();
    }

    const startedAt = this.sessionControl.getStartedAt();
    const elapsedSeconds = startedAt
      ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))
      : 0;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.tickerStream.unsubscribe();
    this.sessionControl.stop();
    this.quoteCache.clear();

    this.logger.info(
      {
        elapsedSeconds,
        elapsedHuman: formatElapsed(elapsedSeconds),
        streamConnected: this.tickerStream.isConnected(),
      },
      'Market-data session stopped; WebSocket left connected for boot session.',
    );

    return this.getStatus();
  }

  /** Stop any active session and disconnect the boot-time WebSocket. */
  public async shutdown(): Promise<void> {
    await this.stop();
    await this.tickerStream.disconnect();
    this.broker.clearAccessToken();
    this.logger.info('Cleared Kite access token from memory on shutdown.');
  }
  private async onTick(): Promise<void> {
    if (!this.sessionControl.isRunning()) {
      return;
    }

    const startedAt = this.sessionControl.getStartedAt();
    if (!startedAt) {
      return;
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
    const elapsedHuman = formatElapsed(elapsedSeconds);

    if (!isInsideMarketWindow()) {
      const now = Date.now();
      if (now - this.lastOutsideWindowLogAt >= 60_000) {
        this.lastOutsideWindowLogAt = now;
        this.logger.info(
          {
            elapsedSeconds,
            elapsedHuman,
            startHour: config.session.startHour,
            endHour: config.session.endHour,
          },
          'Session running outside IST market window; skipping quote snapshot.',
        );
      }
      return;
    }

    const instruments = this.sessionControl.getInstruments();
    const quotes = this.quoteCache.getMany(instruments.map((instrument) => instrument.instrumentToken));
    const byToken = new Map(quotes.map((quote) => [quote.instrumentToken, quote]));
    const now = new Date();

    const line = {
      ts: now.toISOString(),
      sessionStartedAt: startedAt.toISOString(),
      elapsedSeconds,
      streamConnected: this.tickerStream.isConnected(),
      instruments: instruments.map((instrument) => {
        const quote = byToken.get(instrument.instrumentToken);
        return {
          instrumentToken: instrument.instrumentToken,
          exchange: instrument.exchange,
          tradingsymbol: instrument.tradingsymbol,
          lastPrice: quote?.lastPrice ?? null,
          open: quote?.open ?? null,
          high: quote?.high ?? null,
          low: quote?.low ?? null,
          close: quote?.close ?? null,
          change: quote?.change ?? null,
          volume: quote?.volume ?? null,
          receivedAt: quote?.receivedAt ?? null,
        };
      }),
    };

    try {
      await this.appendSnapshot(line);
      this.sessionControl.markSnapshot(now);
      this.logger.info(
        {
          elapsedSeconds,
          elapsedHuman,
          instrumentCount: instruments.length,
          quotedCount: quotes.length,
          logPath: config.session.quoteLogPath,
        },
        'Wrote market-data session quote snapshot.',
      );
    } catch (error: unknown) {
      this.logger.error({ err: error }, 'Failed to write market-data session quote snapshot.');
    }
  }

  private async appendSnapshot(line: unknown): Promise<void> {
    const logPath = path.resolve(config.session.quoteLogPath);
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(line)}\n`, 'utf8');
  }
}
