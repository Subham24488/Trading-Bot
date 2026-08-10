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
  StockPosition,
} from '../domain.js';
import type { BrokerAdapter } from './BrokerAdapter.js';

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
  | 'getMargins'
  | 'getHoldings'
  | 'getMFHoldings'
  | 'placeOrder'
  | 'getOrderHistory'
>;

export type KiteBrokerOptions = {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  requestToken?: string;
  client?: KiteClient;
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
  private readonly apiSecret: string | undefined;
  private readonly requestTokenFromOptions: string | undefined;
  private accessToken: string | null = null;
  private readonly submittedOrderIds = new Set<string>();

  public constructor(options: KiteBrokerOptions = {}) {
    const apiKey = normalizeToken(options.apiKey ?? config.kite.apiKey);
    const accessToken = normalizeToken(options.accessToken ?? config.kite.accessToken);

    if (!apiKey) {
      throw new Error('KiteBroker requires KITE_API_KEY.');
    }

    this.apiSecret = normalizeToken(options.apiSecret ?? config.kite.apiSecret);
    this.requestTokenFromOptions = normalizeToken(options.requestToken);
    this.client = options.client ?? new KiteConnect({ api_key: apiKey });

    if (accessToken) {
      this.setAccessToken(accessToken);
    }
  }

  /** Current in-memory access token used for Kite API calls, if set. */
  public getAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * Exchange `KITE_REQUEST_TOKEN` (or an explicit request token) for an access
   * token, store it in memory, and apply it to the Kite client for API calls.
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

    const session = await this.client.generateSession(token, apiSecret);
    this.setAccessToken(session.access_token);
    return session.access_token;
  }

  /** Use the in-memory token, or exchange the request token when none is set. */
  public async ensureAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    return this.generateAccessToken();
  }

  private setAccessToken(accessToken: string): void {
    this.accessToken = accessToken;
    this.client.setAccessToken(accessToken);
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
