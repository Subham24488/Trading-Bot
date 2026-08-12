import { KiteTicker } from 'kiteconnect';
import type { Tick } from 'kiteconnect';
import type { Logger } from 'pino';

import type { KiteBroker } from '../KiteBroker.js';
import type { QuoteCache } from './QuoteCache.js';

export type SessionLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export type KiteWsMode = 'ltp' | 'quote' | 'full';

export type KiteTickerStreamOptions = {
  broker: KiteBroker;
  quoteCache: QuoteCache;
  logger: SessionLogger;
  mode: KiteWsMode;
  connectTimeoutMs?: number;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export class KiteTickerStream {
  private readonly broker: KiteBroker;
  private readonly quoteCache: QuoteCache;
  private readonly logger: SessionLogger;
  private readonly mode: KiteWsMode;
  private readonly connectTimeoutMs: number;
  private ticker: InstanceType<typeof KiteTicker> | undefined;
  private tokens: number[] = [];
  private connected = false;

  public constructor(options: KiteTickerStreamOptions) {
    this.broker = options.broker;
    this.quoteCache = options.quoteCache;
    this.logger = options.logger;
    this.mode = options.mode;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  public isConnected(): boolean {
    return this.connected && (this.ticker?.connected() ?? false);
  }

  /**
   * Establish the Kite WebSocket transport and wait until connected.
   * Does not require instrument subscriptions. Throws on timeout/failure.
   */
  public async connect(): Promise<void> {
    if (this.isConnected()) {
      this.logger.info('Kite ticker WebSocket already connected.');
      return;
    }

    await this.disconnect();

    const accessToken = await this.broker.ensureAccessToken();
    this.ticker = new KiteTicker({
      api_key: this.broker.getApiKey(),
      access_token: accessToken,
    });
    this.ticker.autoReconnect(true, 50, 5);
    this.bindTickerEvents(this.ticker);

    this.logger.info('Connecting Kite ticker WebSocket.');
    await this.waitForConnection(this.ticker);
    this.logger.info('Kite ticker WebSocket connected.');
  }

  /** Subscribe (or replace subscription) for the given instrument tokens. */
  public subscribe(instrumentTokens: number[]): void {
    if (instrumentTokens.length === 0) {
      throw Object.assign(new Error('At least one instrument token is required to subscribe.'), {
        statusCode: 400,
      });
    }
    if (!this.ticker || !this.isConnected()) {
      throw new Error('Kite ticker WebSocket is not connected. Call connect() before subscribe().');
    }

    if (this.tokens.length > 0) {
      this.ticker.unsubscribe(this.tokens);
    }

    this.tokens = [...instrumentTokens];
    this.subscribeActiveTokens();
  }

  /** Remove active instrument subscriptions; keeps the WebSocket connected. */
  public unsubscribe(): void {
    if (!this.ticker || this.tokens.length === 0) {
      this.tokens = [];
      return;
    }

    try {
      this.ticker.unsubscribe(this.tokens);
      this.logger.info({ instrumentCount: this.tokens.length }, 'Unsubscribed Kite ticker instruments.');
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'Failed to unsubscribe Kite ticker instruments.');
    }
    this.tokens = [];
  }

  /**
   * Ensure WebSocket is up, then subscribe to instruments.
   * Used by market-data sessions after boot-time connect.
   */
  public async start(instrumentTokens: number[]): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
    this.subscribe(instrumentTokens);
  }

  /** Full teardown used on process shutdown. */
  public async disconnect(): Promise<void> {
    const ticker = this.ticker;
    if (!ticker) {
      this.connected = false;
      this.tokens = [];
      return;
    }

    this.unsubscribe();

    try {
      ticker.disconnect();
      this.logger.info('Kite ticker disconnected.');
    } catch (error: unknown) {
      this.logger.warn({ err: error }, 'Failed to disconnect Kite ticker cleanly.');
    }

    this.ticker = undefined;
    this.connected = false;
  }

  /** @deprecated Prefer disconnect(); kept for callers that still invoke stop(). */
  public async stop(): Promise<void> {
    await this.disconnect();
  }

  private bindTickerEvents(ticker: InstanceType<typeof KiteTicker>): void {
    ticker.on('connect', () => {
      this.connected = true;
      this.logger.info('Kite ticker connect event received.');
      if (this.tokens.length > 0) {
        this.subscribeActiveTokens();
      }
    });

    ticker.on('ticks', (ticks: Tick[]) => {
      for (const tick of ticks) {
        this.quoteCache.upsertTick(tick);
      }
    });

    ticker.on('disconnect', (error: Error) => {
      this.connected = false;
      this.logger.warn({ err: error }, 'Kite ticker disconnected.');
    });

    ticker.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'Kite ticker error.');
    });

    ticker.on('close', (reason: string) => {
      this.connected = false;
      this.logger.info({ reason }, 'Kite ticker closed.');
    });

    ticker.on('reconnect', (reconnectCount: number, reconnectInterval: number) => {
      this.logger.info({ reconnectCount, reconnectInterval }, 'Kite ticker reconnecting.');
    });

    ticker.on('noreconnect', () => {
      this.connected = false;
      this.logger.error('Kite ticker exhausted reconnect attempts.');
    });
  }

  private waitForConnection(ticker: InstanceType<typeof KiteTicker>): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new Error(
            `Kite ticker WebSocket failed to connect within ${this.connectTimeoutMs}ms.`,
          ),
        );
      }, this.connectTimeoutMs);

      const onConnect = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        resolve();
      };

      const onError = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Kite ticker WebSocket connect error: ${error.message}`));
      };

      ticker.on('connect', onConnect);
      ticker.on('error', onError);
      ticker.connect();
    });
  }

  private subscribeActiveTokens(): void {
    if (!this.ticker || this.tokens.length === 0) {
      return;
    }
    this.ticker.subscribe(this.tokens);
    this.ticker.setMode(this.mode, this.tokens);
    this.logger.info(
      { instrumentCount: this.tokens.length, mode: this.mode },
      'Subscribed Kite ticker instruments.',
    );
  }
}
