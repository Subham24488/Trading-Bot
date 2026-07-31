import type { BrokerAdapter } from './BrokerAdapter.js';
import type { BrokerOrderResult, IntendedOrder, PortfolioSnapshot } from '../domain.js';

/**
 * Deliberately disabled placeholder. A reviewed implementation must use Zerodha's
 * documented authentication flow, static-IP whitelist, broker risk controls and
 * daily session handling before it can replace PaperBroker in production.
 */
export class KiteBroker implements BrokerAdapter {
  public readonly name = 'kite';

  public async getPortfolio(): Promise<PortfolioSnapshot> {
    throw new Error('KiteBroker is not implemented. Paper trading remains the only enabled mode.');
  }

  public async placeLimitOrder(order: IntendedOrder): Promise<BrokerOrderResult> {
    void order;
    throw new Error('KiteBroker is not implemented. No live orders can be sent.');
  }
}
