export type OrderSide = 'BUY' | 'SELL';

export interface IntendedOrder {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  limitPrice: string;
}

export interface PortfolioSnapshot {
  cashAvailable: string;
  positions: ReadonlyMap<string, number>;
  asOf: Date;
}

/** Full equity/ETF demat holding as returned for portfolio APIs. */
export interface HoldingDetail {
  tradingsymbol: string;
  exchange: string;
  isin: string;
  product: string;
  quantity: number;
  usedQuantity: number;
  t1Quantity: number;
  realisedQuantity: number;
  averagePrice: string;
  lastPrice: string;
  closePrice: string;
  pnl: string;
  dayChange: string;
  dayChangePercentage: string;
}

/** Per-instrument stock/ETF line item (focused view of each holding). */
export interface StockPosition {
  tradingsymbol: string;
  exchange: string;
  isin: string;
  quantity: number;
  averagePrice: string;
  lastPrice: string;
  pnl: string;
  dayChange: string;
  dayChangePercentage: string;
}

export interface MutualFundHolding {
  fund: string;
  tradingsymbol: string;
  folio: string | null;
  quantity: number;
  averagePrice: string;
  lastPrice: string;
  lastPriceDate: string;
  pledgedQuantity: number;
  pnl: string;
}

export interface PortfolioProfitAndLoss {
  holdingsPnl: string;
  holdingsDayChange: string;
  mutualFundsPnl: string;
  totalPnl: string;
}

export interface PortfolioDetails {
  cashAvailable: string;
  asOf: Date;
  holdings: HoldingDetail[];
  stocks: StockPosition[];
  mutualFunds: MutualFundHolding[];
  profitAndLoss: PortfolioProfitAndLoss;
}

export interface BrokerOrderResult {
  brokerOrderId: string;
  status: 'FILLED' | 'REJECTED';
  filledQuantity: number;
  averagePrice: string | null;
  reason?: string;
}

export interface RiskDecision {
  allowed: boolean;
  reasons: string[];
  notional: string | null;
}

export interface SessionInstrument {
  instrumentToken: number;
  exchange: string;
  tradingsymbol: string;
}

export type SessionRunState = 'stopped' | 'running';

export interface SessionStatusView {
  state: SessionRunState;
  running: boolean;
  instruments: SessionInstrument[];
  streamConnected: boolean;
  startedAt: string | null;
  elapsedSeconds: number;
  lastSnapshotAt: string | null;
  insideMarketWindow: boolean;
  tickSeconds: number;
}

export interface SessionStartRequest {
  instruments: SessionInstrument[];
}

