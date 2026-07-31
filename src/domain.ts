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
