import { Decimal } from 'decimal.js';

import type { IntendedOrder, PortfolioSnapshot, RiskDecision } from '../domain.js';

export interface RiskPolicy {
  maxOrderNotionalInr: Decimal;
  maxOrdersPerRun: number;
  catalogSymbols: ReadonlySet<string>;
}

export class RiskGate {
  public constructor(private readonly policy: RiskPolicy) {}

  public evaluate(
    order: IntendedOrder,
    portfolio: PortfolioSnapshot,
    ordersAlreadyApproved: number,
  ): RiskDecision {
    const reasons: string[] = [];
    const limitPrice = new Decimal(order.limitPrice);
    const notional = limitPrice.mul(order.quantity);

    if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
      reasons.push('Quantity must be a positive integer.');
    }
    if (!limitPrice.isFinite() || limitPrice.lte(0)) {
      reasons.push('Limit price must be a positive finite number.');
    }
    if (!this.policy.catalogSymbols.has(order.symbol.toUpperCase())) {
      reasons.push(`Symbol ${order.symbol} is not in the Kite instrument catalog.`);
    }
    if (ordersAlreadyApproved >= this.policy.maxOrdersPerRun) {
      reasons.push('Maximum orders per run has been reached.');
    }
    if (notional.gt(this.policy.maxOrderNotionalInr)) {
      reasons.push('Order notional exceeds the configured safety limit.');
    }
    if (order.side === 'BUY' && notional.gt(new Decimal(portfolio.cashAvailable))) {
      reasons.push('Insufficient cash for buy order.');
    }
    if (order.side === 'SELL' && (portfolio.positions.get(order.symbol) ?? 0) < order.quantity) {
      reasons.push('Insufficient settled position for sell order.');
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      notional: limitPrice.isFinite() ? notional.toFixed(2) : null,
    };
  }
}
