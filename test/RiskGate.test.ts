import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { RiskGate } from '../src/risk/RiskGate.js';

const portfolio = {
  cashAvailable: '10000.00',
  positions: new Map<string, number>([['NIFTYBEES', 20]]),
  asOf: new Date(),
};

const gate = new RiskGate({
  maxOrderNotionalInr: new Decimal(5000),
  maxOrdersPerRun: 3,
  allowedSymbols: new Set(['NIFTYBEES']),
});

describe('RiskGate', () => {
  it('approves a cash-funded order in the approved universe', () => {
    const result = gate.evaluate(
      { clientOrderId: 'one', symbol: 'NIFTYBEES', side: 'BUY', quantity: 10, limitPrice: '250' },
      portfolio,
      0,
    );

    expect(result).toEqual({ allowed: true, reasons: [], notional: '2500.00' });
  });

  it('blocks unsafe orders with explicit reasons', () => {
    const result = gate.evaluate(
      { clientOrderId: 'two', symbol: 'UNAPPROVED', side: 'BUY', quantity: 100, limitPrice: '100' },
      portfolio,
      3,
    );

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('Symbol UNAPPROVED is not on the approved universe.');
    expect(result.reasons).toContain('Maximum orders per run has been reached.');
    expect(result.reasons).toContain('Order notional exceeds the configured safety limit.');
  });
});
