import type { TradingMode } from '@prisma/client';

import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import type { PortfolioDetails } from '../domain.js';
import type { RiskGate } from '../risk/RiskGate.js';
import type { AuditService } from './AuditService.js';
import type { TradingControl } from './TradingControl.js';

/**
 * The strategy intentionally emits no orders until a separately reviewed and
 * versioned strategy specification is implemented. This is a safe project scaffold.
 */
export class TradingService {
  public constructor(
    private readonly mode: TradingMode,
    private readonly broker: BrokerAdapter,
    private readonly riskGate: RiskGate,
    private readonly audit: AuditService,
    private readonly control: TradingControl,
  ) {}

  public getReadiness() {
    return {
      mode: this.mode,
      broker: this.broker.name,
      ...this.control.snapshot(),
      strategyEnabled: false,
    };
  }

  public async getPortfolio(): Promise<PortfolioDetails> {
    return this.broker.getPortfolioDetails();
  }

  public async runDailyCycle(): Promise<{
    runId?: string;
    status: 'blocked' | 'completed';
    reason: string;
  }> {
    const readiness = this.control.snapshot();
    if (readiness.paused) {
      return { status: 'blocked', reason: readiness.reason ?? 'Trading is paused.' };
    }

    const runId = await this.audit.startRun(this.mode);
    try {
      // Touch the dependencies so a future strategy cannot bypass the broker or risk gate.
      await this.broker.getPortfolio();
      void this.riskGate;
      await this.audit.event(
        runId,
        'strategy',
        'Daily cycle completed without orders because no approved strategy is enabled.',
      );
      await this.audit.finishRun(runId, 'COMPLETED');
      return { runId, status: 'completed', reason: 'No approved strategy is enabled.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown trading-cycle failure.';
      await this.audit.event(runId, 'error', 'Daily cycle failed.', { message });
      await this.audit.finishRun(runId, 'FAILED', message);
      throw error;
    }
  }
}
