import type { Prisma, TradingMode, TradingRunStatus } from '@prisma/client';

import { database } from '../database.js';

export class AuditService {
  public async startRun(mode: TradingMode): Promise<string> {
    const run = await database.tradingRun.create({ data: { mode, status: 'STARTED' } });
    return run.id;
  }

  public async event(
    runId: string,
    category: string,
    message: string,
    payload?: Prisma.InputJsonValue,
  ) {
    await database.auditEvent.create({
      data: { runId, category, message, ...(payload === undefined ? {} : { payload }) },
    });
  }

  public async finishRun(runId: string, status: TradingRunStatus, reason?: string): Promise<void> {
    await database.tradingRun.update({
      where: { id: runId },
      data: { status, endedAt: new Date(), ...(reason === undefined ? {} : { reason }) },
    });
  }
}
