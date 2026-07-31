import { describe, expect, it } from 'vitest';

import { PaperBroker } from '../src/broker/PaperBroker.js';

describe('PaperBroker', () => {
  it('rejects duplicate client order IDs', async () => {
    const broker = new PaperBroker();
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
  });
});
