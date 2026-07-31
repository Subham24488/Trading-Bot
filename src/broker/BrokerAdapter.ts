import type { BrokerOrderResult, IntendedOrder, PortfolioSnapshot } from '../domain.js';

export interface BrokerAdapter {
  readonly name: string;
  getPortfolio(): Promise<PortfolioSnapshot>;
  placeLimitOrder(order: IntendedOrder): Promise<BrokerOrderResult>;
}
