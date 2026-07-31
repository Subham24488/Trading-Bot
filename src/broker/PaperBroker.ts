import { Decimal } from 'decimal.js';

import type { BrokerAdapter } from './BrokerAdapter.js';
import type { BrokerOrderResult, IntendedOrder, PortfolioSnapshot } from '../domain.js';

export class PaperBroker implements BrokerAdapter {
  public readonly name = 'paper';
  private readonly submittedOrderIds = new Set<string>();

  public async getPortfolio(): Promise<PortfolioSnapshot> {
    return {
      cashAvailable: '100000.00',
      positions: new Map(),
      asOf: new Date(),
    };
  }

  public async placeLimitOrder(order: IntendedOrder): Promise<BrokerOrderResult> {
    if (this.submittedOrderIds.has(order.clientOrderId)) {
      return {
        brokerOrderId: `paper-${order.clientOrderId}`,
        status: 'REJECTED',
        filledQuantity: 0,
        averagePrice: null,
        reason: 'Duplicate client order ID',
      };
    }

    const limitPrice = new Decimal(order.limitPrice);
    this.submittedOrderIds.add(order.clientOrderId);

    return {
      brokerOrderId: `paper-${order.clientOrderId}`,
      status: 'FILLED',
      filledQuantity: order.quantity,
      averagePrice: limitPrice.toFixed(2),
    };
  }
}
