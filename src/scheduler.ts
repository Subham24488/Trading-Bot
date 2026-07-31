import { PgBoss } from 'pg-boss';

import { config } from './config.js';
import type { TradingService } from './services/TradingService.js';

const DAILY_TRADING_JOB = 'daily-trading-cycle';

export async function startScheduler(tradingService: TradingService): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: config.databaseUrl });
  await boss.start();
  await boss.createQueue(DAILY_TRADING_JOB);
  await boss.schedule(DAILY_TRADING_JOB, '0 15 8 * * 1-5', undefined, {
    tz: 'Asia/Kolkata',
  });
  await boss.work(DAILY_TRADING_JOB, async () => {
    await tradingService.runDailyCycle();
  });
  return boss;
}
