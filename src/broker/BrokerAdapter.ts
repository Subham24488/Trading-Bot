import type {
  BrokerOrderResult,
  IntendedOrder,
  PortfolioDetails,
  PortfolioSnapshot,
} from '../domain.js';

export interface BrokerAdapter {
  readonly name: string;
  getPortfolio(): Promise<PortfolioSnapshot>;
  getPortfolioDetails(): Promise<PortfolioDetails>;
  placeLimitOrder(order: IntendedOrder): Promise<BrokerOrderResult>;
}
