import crypto from 'node:crypto';

import cors from '@fastify/cors';
import { Decimal } from 'decimal.js';
import Fastify from 'fastify';
import type { PgBoss } from 'pg-boss';

import { PaperBroker } from './broker/PaperBroker.js';
import { config } from './config.js';
import { database } from './database.js';
import { RiskGate } from './risk/RiskGate.js';
import { startScheduler } from './scheduler.js';
import { AuditService } from './services/AuditService.js';
import { TradingControl } from './services/TradingControl.js';
import { TradingService } from './services/TradingService.js';

const application = Fastify({ logger: { level: config.logLevel } });
const control = new TradingControl();
const broker = new PaperBroker();
const riskGate = new RiskGate({
  maxOrderNotionalInr: new Decimal(config.maxOrderNotionalInr),
  maxOrdersPerRun: config.maxOrdersPerRun,
  allowedSymbols: config.allowedSymbols,
});
const tradingService = new TradingService(
  config.tradingMode === 'live' ? 'LIVE' : 'PAPER',
  broker,
  riskGate,
  new AuditService(),
  control,
);
let scheduler: PgBoss | undefined;

function hasValidAdminToken(token: unknown): boolean {
  if (typeof token !== 'string') {
    return false;
  }
  const expected = Buffer.from(config.adminToken);
  const received = Buffer.from(token);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

async function requireAdmin(request: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<void> {
  if (!hasValidAdminToken(request.headers['x-admin-token'])) {
    throw Object.assign(new Error('A valid x-admin-token is required.'), { statusCode: 401 });
  }
}

await application.register(cors, { origin: false });

application.get('/health', async () => {
  await database.$queryRaw`SELECT 1`;
  return { status: 'ok', mode: config.tradingMode };
});

application.get('/api/v1/readiness', async () => tradingService.getReadiness());

application.post('/api/v1/control/pause', async (request) => {
  await requireAdmin(request);
  control.pause('Paused by an authenticated operator.');
  return tradingService.getReadiness();
});

application.post('/api/v1/control/resume', async (request) => {
  await requireAdmin(request);
  control.resume();
  return tradingService.getReadiness();
});

application.post('/api/v1/runs/daily', async (request) => {
  await requireAdmin(request);
  return tradingService.runDailyCycle();
});

application.addHook('onClose', async () => {
  await scheduler?.stop();
  await database.$disconnect();
});

async function main(): Promise<void> {
  scheduler = await startScheduler(tradingService);
  await application.listen({ host: '0.0.0.0', port: config.port });
}

main().catch((error: unknown) => {
  application.log.fatal(error, 'Unable to start trading bot.');
  process.exitCode = 1;
});
