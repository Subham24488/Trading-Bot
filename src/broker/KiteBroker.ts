import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import { Decimal } from 'decimal.js';
import { KiteConnect } from 'kiteconnect';
import type { Connect, MFHolding, Order, PortfolioHolding } from 'kiteconnect';

import { config } from '../config.js';
import type {
  BrokerOrderResult,
  HoldingDetail,
  IntendedOrder,
  MutualFundHolding,
  PortfolioDetails,
  PortfolioSnapshot,
  SessionInstrument,
  StockPosition,
} from '../domain.js';
import type { DailyBar } from '../universe/types.js';
import { istYmd } from '../universe/dates.js';
import type { BrokerAdapter } from './BrokerAdapter.js';

const HISTORICAL_MIN_INTERVAL_MS = 350;

const DEFAULT_SESSION_FILE = path.resolve('.kite-session.json');

/**
 * Zerodha Kite Connect adapter for NSE cash-delivery limit orders.
 *
 * BrokerOrderResult only allows FILLED | REJECTED. Orders that are accepted but
 * not yet COMPLETE are reported as REJECTED with an explanatory reason so callers
 * never assume a fill. Widen the domain status enum before treating resting orders
 * as success.
 */
export type KiteClient = Pick<
  Connect,
  | 'setAccessToken'
  | 'generateSession'
  | 'getProfile'
  | 'getMargins'
  | 'getHoldings'
  | 'getMFHoldings'
  | 'placeOrder'
  | 'getOrderHistory'
  | 'getInstruments'
  | 'getHistoricalData'
>;

export type KiteBrokerOptions = {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  requestToken?: string;
  client?: KiteClient;
  sessionFilePath?: string;
};

function money(value: number): string {
  return new Decimal(value).toFixed(2);
}

function mapHolding(holding: PortfolioHolding): HoldingDetail {
  return {
    tradingsymbol: holding.tradingsymbol,
    exchange: holding.exchange,
    isin: holding.isin,
    product: holding.product,
    quantity: holding.quantity,
    usedQuantity: holding.used_quantity,
    t1Quantity: holding.t1_quantity,
    realisedQuantity: holding.realised_quantity,
    averagePrice: money(holding.average_price),
    lastPrice: money(holding.last_price),
    closePrice: money(holding.close_price),
    pnl: money(holding.pnl),
    dayChange: money(holding.day_change),
    dayChangePercentage: money(holding.day_change_percentage),
  };
}

function mapStock(holding: PortfolioHolding): StockPosition {
  return {
    tradingsymbol: holding.tradingsymbol,
    exchange: holding.exchange,
    isin: holding.isin,
    quantity: holding.quantity,
    averagePrice: money(holding.average_price),
    lastPrice: money(holding.last_price),
    pnl: money(holding.pnl),
    dayChange: money(holding.day_change),
    dayChangePercentage: money(holding.day_change_percentage),
  };
}

function mapMutualFund(holding: MFHolding): MutualFundHolding {
  return {
    fund: holding.fund,
    tradingsymbol: holding.tradingsymbol,
    folio: holding.folio,
    quantity: holding.quantity,
    averagePrice: money(holding.average_price),
    lastPrice: money(holding.last_price),
    lastPriceDate: holding.last_price_date,
    pledgedQuantity: holding.pledged_quantity,
    pnl: money(holding.pnl),
  };
}

export class KiteBroker implements BrokerAdapter {
  public readonly name = 'kite';
  private readonly client: KiteClient;
  private readonly apiKey: string;
  private readonly apiSecret: string | undefined;
  private readonly requestTokenFromOptions: string | undefined;
  private readonly sessionFilePath: string;
  private accessToken: string | null = null;
  private readonly submittedOrderIds = new Set<string>();
  private nseInstrumentCache: Awaited<ReturnType<KiteClient['getInstruments']>> | undefined;
  private lastHistoricalMs = 0;

  public constructor(options: KiteBrokerOptions = {}) {
    const apiKey = normalizeToken(options.apiKey ?? config.kite.apiKey);
    const accessToken = normalizeToken(options.accessToken ?? config.kite.accessToken);

    if (!apiKey) {
      throw new Error('KiteBroker requires KITE_API_KEY.');
    }

    this.apiKey = apiKey;
    this.apiSecret = normalizeToken(options.apiSecret ?? config.kite.apiSecret);
    this.requestTokenFromOptions = normalizeToken(options.requestToken);
    this.sessionFilePath = options.sessionFilePath ?? DEFAULT_SESSION_FILE;
    this.client = options.client ?? new KiteConnect({ api_key: apiKey });

    if (accessToken) {
      this.setAccessToken(accessToken);
    }
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  /** Current in-memory access token used for Kite API calls, if set. */
  public getAccessToken(): string | null {
    return this.accessToken;
  }

  /** Clear the in-memory access token (persisted session file is kept for next boot). */
  public clearAccessToken(): void {
    this.accessToken = null;
    this.client.setAccessToken('');
  }

  /**
   * Exchange `KITE_REQUEST_TOKEN` (or an explicit request token) for an access
   * token, store it in memory + `.kite-session.json`, and apply it to the client.
   */
  public async generateAccessToken(requestToken?: string): Promise<string> {
    const token =
      normalizeToken(requestToken) ??
      this.requestTokenFromOptions ??
      normalizeToken(config.kite.requestToken);
    const apiSecret = this.apiSecret;

    if (!token) {
      throw new Error('KiteBroker requires KITE_REQUEST_TOKEN to generate an access token.');
    }
    if (!apiSecret) {
      throw new Error('KiteBroker requires KITE_API_SECRET to generate an access token.');
    }

    try {
      const session = await this.client.generateSession(token, apiSecret);
      this.setAccessToken(session.access_token);
      await this.persistAccessToken(session.access_token);
      return session.access_token;
    } catch (error: unknown) {
      throw toKiteError(
        error,
        'KITE_REQUEST_TOKEN is invalid or expired. Complete Kite login again, set a fresh KITE_REQUEST_TOKEN (single-use), then restart.',
      );
    }
  }

  /** Use in-memory, env, or persisted access token; otherwise exchange the request token. */
  public async ensureAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    const fromEnv = normalizeToken(config.kite.accessToken);
    if (fromEnv) {
      this.setAccessToken(fromEnv);
      return fromEnv;
    }

    const fromDisk = await this.readPersistedAccessToken();
    if (fromDisk) {
      this.setAccessToken(fromDisk);
      return fromDisk;
    }

    return this.generateAccessToken();
  }

  /**
   * Authenticate against Kite REST.
   * Prefers env/persisted access token; exchanges KITE_REQUEST_TOKEN only when needed
   * (request tokens are single-use and must not be reused on every boot).
   */
  public async connect(): Promise<void> {
    this.clearAccessToken();

    try {
      const existing =
        normalizeToken(config.kite.accessToken) ?? (await this.readPersistedAccessToken());

      if (existing) {
        this.setAccessToken(existing);
        try {
          await this.verifyProfile();
          return;
        } catch {
          this.clearAccessToken();
          await this.clearPersistedAccessToken();
        }
      }

      await this.generateAccessToken();
      await this.verifyProfile();
    } catch (error: unknown) {
      const normalized = toKiteError(error, 'Unknown Kite connection error.');
      throw new Error(
        `KiteBroker connect failed: ${normalized.message}. If using KITE_REQUEST_TOKEN, paste a fresh single-use request_token from the login redirect and restart once; the access token is then cached in .kite-session.json for later boots.`,
      );
    }
  }

  private async verifyProfile(): Promise<void> {
    const profile = await this.client.getProfile();
    if (!profile?.user_id) {
      throw new Error('KiteBroker connect failed: profile response did not include user_id.');
    }
  }

  private setAccessToken(accessToken: string): void {
    this.accessToken = accessToken;
    this.client.setAccessToken(accessToken);
  }

  private async persistAccessToken(accessToken: string): Promise<void> {
    try {
      await writeFile(
        this.sessionFilePath,
        JSON.stringify({ accessToken, savedAt: new Date().toISOString() }),
        'utf8',
      );
    } catch {
      // Best-effort; in-memory token still works for this process.
    }
  }

  private async readPersistedAccessToken(): Promise<string | undefined> {
    try {
      const raw = await readFile(this.sessionFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { accessToken?: unknown };
      return typeof parsed.accessToken === 'string'
        ? normalizeToken(parsed.accessToken)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async clearPersistedAccessToken(): Promise<void> {
    try {
      await unlink(this.sessionFilePath);
    } catch {
      // Ignore missing file.
    }
  }

  public async resolveNseInstruments(symbols: readonly string[]): Promise<SessionInstrument[]> {
    await this.ensureAccessToken();
    if (!this.nseInstrumentCache) {
      this.nseInstrumentCache = await this.client.getInstruments('NSE');
    }

    const wanted = new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
    const resolved = new Map<string, SessionInstrument>();

    for (const row of this.nseInstrumentCache) {
      const tradingsymbol = String(row.tradingsymbol ?? '').trim().toUpperCase();
      if (!wanted.has(tradingsymbol) || resolved.has(tradingsymbol)) {
        continue;
      }

      const instrumentType = String(row.instrument_type ?? 'EQ').toUpperCase();
      if (instrumentType !== 'EQ') {
        continue;
      }

      const token = Number(row.instrument_token);
      if (!Number.isInteger(token) || token <= 0) {
        continue;
      }

      resolved.set(tradingsymbol, {
        instrumentToken: token,
        exchange: 'NSE',
        tradingsymbol,
      });
    }

    return [...resolved.values()];
  }

  public async getPortfolio(): Promise<PortfolioSnapshot> {
    const details = await this.getPortfolioDetails();
    const positions = new Map<string, number>();
    for (const holding of details.holdings) {
      if (holding.quantity > 0) {
        positions.set(holding.tradingsymbol, holding.quantity);
      }
    }

    return {
      cashAvailable: details.cashAvailable,
      positions,
      asOf: details.asOf,
    };
  }

  public async getPortfolioDetails(): Promise<PortfolioDetails> {
    await this.ensureAccessToken();

    const [margins, holdings, mutualFunds] = await Promise.all([
      this.client.getMargins(),
      this.client.getHoldings(),
      this.client.getMFHoldings(),
    ]);

    const cash = margins.equity?.available.cash ?? 0;
    const holdingsPnl = holdings.reduce((sum, holding) => sum + holding.pnl, 0);
    const holdingsDayChange = holdings.reduce((sum, holding) => sum + holding.day_change, 0);
    const mutualFundsPnl = mutualFunds.reduce((sum, holding) => sum + holding.pnl, 0);

    return {
      cashAvailable: money(cash),
      asOf: new Date(),
      holdings: holdings.map(mapHolding),
      stocks: holdings.map(mapStock),
      mutualFunds: mutualFunds.map(mapMutualFund),
      profitAndLoss: {
        holdingsPnl: money(holdingsPnl),
        holdingsDayChange: money(holdingsDayChange),
        mutualFundsPnl: money(mutualFundsPnl),
        totalPnl: money(holdingsPnl + mutualFundsPnl),
      },
    };
  }

  private async throttleHistorical(): Promise<void> {
    const wait = this.lastHistoricalMs + HISTORICAL_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, wait);
      });
    }
    this.lastHistoricalMs = Date.now();
  }

  public async getDailyCandles(
    instrumentToken: number,
    fromYmd: string,
    toYmd: string,
  ): Promise<DailyBar[]> {
    await this.ensureAccessToken();
    await this.throttleHistorical();
    const rows = await this.client.getHistoricalData(
      instrumentToken,
      'day',
      `${fromYmd} 00:00:00`,
      `${toYmd} 23:59:59`,
      false,
      false,
    );
    return rows.map((row) => {
      const date = row.date instanceof Date ? row.date : new Date(String(row.date));
      return {
        d: istYmd(date),
        o: row.open,
        h: row.high,
        l: row.low,
        c: row.close,
        v: row.volume,
      };
    });
  }

  public async placeLimitOrder(order: IntendedOrder): Promise<BrokerOrderResult> {
    if (this.submittedOrderIds.has(order.clientOrderId)) {
      return {
        brokerOrderId: `kite-${order.clientOrderId}`,
        status: 'REJECTED',
        filledQuantity: 0,
        averagePrice: null,
        reason: 'Duplicate client order ID',
      };
    }

    try {
      await this.ensureAccessToken();

      const placed = await this.client.placeOrder('regular', {
        exchange: 'NSE',
        tradingsymbol: order.symbol,
        transaction_type: order.side,
        quantity: order.quantity,
        product: 'CNC',
        order_type: 'LIMIT',
        price: Number(order.limitPrice),
        validity: 'DAY',
        tag: order.clientOrderId.slice(0, 20),
      });

      this.submittedOrderIds.add(order.clientOrderId);

      const history = await this.client.getOrderHistory(placed.order_id);
      const latest = history.at(-1);
      if (!latest) {
        return {
          brokerOrderId: placed.order_id,
          status: 'REJECTED',
          filledQuantity: 0,
          averagePrice: null,
          reason: 'Order placed but no order history was returned.',
        };
      }

      return this.mapOrderResult(placed.order_id, latest);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Kite order placement failed.';
      return {
        brokerOrderId: '',
        status: 'REJECTED',
        filledQuantity: 0,
        averagePrice: null,
        reason: message,
      };
    }
  }

  private mapOrderResult(brokerOrderId: string, latest: Order): BrokerOrderResult {
    const status = latest.status.toUpperCase();

    if (status === 'COMPLETE') {
      return {
        brokerOrderId,
        status: 'FILLED',
        filledQuantity: latest.filled_quantity,
        averagePrice: new Decimal(latest.average_price).toFixed(2),
      };
    }

    if (status === 'REJECTED' || status === 'CANCELLED') {
      return {
        brokerOrderId,
        status: 'REJECTED',
        filledQuantity: latest.filled_quantity,
        averagePrice: null,
        reason: latest.status_message ?? `Order ${status.toLowerCase()}.`,
      };
    }

    return {
      brokerOrderId,
      status: 'REJECTED',
      filledQuantity: latest.filled_quantity,
      averagePrice: null,
      reason: `Order placed (status=${latest.status}) but not filled yet`,
    };
  }
}

function normalizeToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toKiteError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  if (error && typeof error === 'object') {
    const kiteError = error as { message?: unknown; error_type?: unknown };
    const message =
      typeof kiteError.message === 'string' && kiteError.message.trim()
        ? kiteError.message
        : fallback;
    const typed = new Error(message);
    if (typeof kiteError.error_type === 'string') {
      (typed as Error & { error_type?: string }).error_type = kiteError.error_type;
    }
    return typed;
  }
  return new Error(fallback);
}
