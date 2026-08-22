import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KiteClient } from '../src/broker/KiteBroker.js';

vi.mock('../src/config.js', () => ({
  config: {
    kite: {
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
      accessToken: '',
      requestToken: 'test-request-token',
    },
  },
}));

vi.mock('kiteconnect', () => ({
  KiteConnect: vi.fn(),
}));

const { KiteBroker } = await import('../src/broker/KiteBroker.js');

function createMockClient(overrides: Partial<KiteClient> = {}): KiteClient {
  return {
    setAccessToken: vi.fn(),
    generateSession: vi.fn().mockResolvedValue({ access_token: 'generated-access-token' }),
    getProfile: vi.fn().mockResolvedValue({ user_id: 'AB1234' }),
    getMargins: vi.fn().mockResolvedValue({
      equity: {
        enabled: true,
        net: 50_000,
        available: {
          adhoc_margin: 0,
          cash: 50_000.5,
          opening_balance: 50_000,
          live_balance: 50_000.5,
          collateral: 0,
          intraday_payin: 0,
        },
        utilised: {
          debits: 0,
          exposure: 0,
          m2m_realised: 0,
          m2m_unrealised: 0,
          option_premium: 0,
          payout: 0,
          span: 0,
          holding_sales: 0,
          turnover: 0,
        },
      },
    }),
    getHoldings: vi.fn().mockResolvedValue([
      {
        tradingsymbol: 'NIFTYBEES',
        exchange: 'NSE',
        instrument_token: 1,
        isin: 'INF204KB14I2',
        product: 'CNC',
        price: 250,
        quantity: 10,
        used_quantity: 0,
        t1_quantity: 0,
        realised_quantity: 10,
        authorised_quantity: 10,
        authorised_date: '',
        opening_quantity: 10,
        collateral_quantity: 0,
        collateral_type: '',
        discrepancy: false,
        average_price: 240,
        last_price: 250,
        close_price: 249,
        pnl: 100,
        day_change: 1,
        day_change_percentage: 0.4,
      },
      {
        tradingsymbol: 'ZEROQTY',
        exchange: 'NSE',
        instrument_token: 2,
        isin: 'ZERO',
        product: 'CNC',
        price: 1,
        quantity: 0,
        used_quantity: 0,
        t1_quantity: 0,
        realised_quantity: 0,
        authorised_quantity: 0,
        authorised_date: '',
        opening_quantity: 0,
        collateral_quantity: 0,
        collateral_type: '',
        discrepancy: false,
        average_price: 0,
        last_price: 1,
        close_price: 1,
        pnl: 0,
        day_change: 0,
        day_change_percentage: 0,
      },
    ]),
    getMFHoldings: vi.fn().mockResolvedValue([]),
    placeOrder: vi.fn().mockResolvedValue({ order_id: 'kite-order-1' }),
    getOrderHistory: vi.fn().mockResolvedValue([
      {
        order_id: 'kite-order-1',
        parent_order_id: null,
        exchange_order_id: 'ex-1',
        placed_by: 'AB1234',
        variety: 'regular',
        status: 'COMPLETE',
        tradingsymbol: 'NIFTYBEES',
        exchange: 'NSE',
        instrument_token: 1,
        transaction_type: 'BUY',
        order_type: 'LIMIT',
        product: 'CNC',
        validity: 'DAY',
        price: 250,
        quantity: 1,
        trigger_price: 0,
        average_price: 250.1,
        pending_quantity: 0,
        filled_quantity: 1,
        disclosed_quantity: 0,
        order_timestamp: new Date(),
        exchange_timestamp: new Date(),
        exchange_update_timestamp: null,
        status_message: null,
        status_message_raw: null,
        cancelled_quantity: 0,
        market_protection: 0,
        meta: {},
        tag: null,
        guid: '',
      },
    ]),
    getInstruments: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('KiteBroker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when credentials are missing', () => {
    expect(() => new KiteBroker({ apiKey: '' })).toThrow('KiteBroker requires KITE_API_KEY.');
  });

  it('generates an access token from the request token and stores it in memory', async () => {
    const client = createMockClient();
    const broker = new KiteBroker({
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
      client,
      sessionFilePath: 'logs/test-kite-session-generate.json',
    });

    await expect(broker.generateAccessToken()).resolves.toBe('generated-access-token');
    expect(client.generateSession).toHaveBeenCalledWith('test-request-token', 'test-api-secret');
    expect(client.setAccessToken).toHaveBeenCalledWith('generated-access-token');
    expect(broker.getAccessToken()).toBe('generated-access-token');
  });

  it('exchanges the request token before portfolio calls when no access token is set', async () => {
    const client = createMockClient();
    const broker = new KiteBroker({
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
      accessToken: '',
      client,
      sessionFilePath: `logs/test-kite-session-missing-${Date.now()}.json`,
    });

    await broker.getPortfolio();

    expect(client.generateSession).toHaveBeenCalledWith('test-request-token', 'test-api-secret');
    expect(client.setAccessToken).toHaveBeenCalledWith('generated-access-token');
    expect(client.getHoldings).toHaveBeenCalled();
  });

  it('maps margins and holdings into a portfolio snapshot', async () => {
    const client = createMockClient();
    const broker = new KiteBroker({
      apiKey: 'test-api-key',
      accessToken: 'test-access-token',
      client,
    });

    const portfolio = await broker.getPortfolio();

    expect(portfolio.cashAvailable).toBe('50000.50');
    expect(portfolio.positions.get('NIFTYBEES')).toBe(10);
    expect(portfolio.positions.has('ZEROQTY')).toBe(false);
    expect(portfolio.asOf).toBeInstanceOf(Date);
  });

  it('maps a COMPLETE order to FILLED', async () => {
    const client = createMockClient();
    const broker = new KiteBroker({
      apiKey: 'test-api-key',
      accessToken: 'test-access-token',
      client,
    });

    const result = await broker.placeLimitOrder({
      clientOrderId: 'stable-order-id',
      symbol: 'NIFTYBEES',
      side: 'BUY',
      quantity: 1,
      limitPrice: '250.00',
    });

    expect(client.placeOrder).toHaveBeenCalledWith(
      'regular',
      expect.objectContaining({
        exchange: 'NSE',
        tradingsymbol: 'NIFTYBEES',
        transaction_type: 'BUY',
        quantity: 1,
        product: 'CNC',
        order_type: 'LIMIT',
        price: 250,
        validity: 'DAY',
        tag: 'stable-order-id',
      }),
    );
    expect(result).toMatchObject({
      brokerOrderId: 'kite-order-1',
      status: 'FILLED',
      filledQuantity: 1,
      averagePrice: '250.10',
    });
  });

  it('rejects duplicate client order IDs', async () => {
    const client = createMockClient();
    const broker = new KiteBroker({
      apiKey: 'test-api-key',
      accessToken: 'test-access-token',
      client,
    });
    const order = {
      clientOrderId: 'stable-order-id',
      symbol: 'NIFTYBEES',
      side: 'BUY' as const,
      quantity: 1,
      limitPrice: '250.00',
    };

    await expect(broker.placeLimitOrder(order)).resolves.toMatchObject({ status: 'FILLED' });
    await expect(broker.placeLimitOrder(order)).resolves.toMatchObject({
      status: 'REJECTED',
      reason: 'Duplicate client order ID',
    });
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('returns REJECTED with the broker message when placement fails', async () => {
    const client = createMockClient({
      placeOrder: vi.fn().mockRejectedValue(new Error('Insufficient funds')),
    });
    const broker = new KiteBroker({
      apiKey: 'test-api-key',
      accessToken: 'test-access-token',
      client,
    });

    await expect(
      broker.placeLimitOrder({
        clientOrderId: 'failing-order',
        symbol: 'NIFTYBEES',
        side: 'BUY',
        quantity: 1,
        limitPrice: '250.00',
      }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      reason: 'Insufficient funds',
      filledQuantity: 0,
      averagePrice: null,
    });
  });

  it('resolves NSE EQ instrument tokens for watchlist symbols', async () => {
    const client = createMockClient({
      getInstruments: vi.fn().mockResolvedValue([
        {
          instrument_token: 738561,
          tradingsymbol: 'RELIANCE',
          instrument_type: 'EQ',
          exchange: 'NSE',
        },
        {
          instrument_token: 999,
          tradingsymbol: 'RELIANCE',
          instrument_type: 'FUT',
          exchange: 'NFO',
        },
      ]),
    });
    const broker = new KiteBroker({
      accessToken: 'persisted-token',
      client,
      sessionFilePath: 'C:\\tmp\\unused-kite-session.json',
    });

    await expect(broker.resolveNseInstruments(['reliance'])).resolves.toEqual([
      { instrumentToken: 738561, exchange: 'NSE', tradingsymbol: 'RELIANCE' },
    ]);
  });
});
