import crypto from 'node:crypto';

import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Decimal } from 'decimal.js';
import Fastify from 'fastify';
import { ZodError } from 'zod';

import { KiteBroker } from './broker/KiteBroker.js';
import { config } from './config.js';
import { database } from './database.js';
import { RiskGate } from './risk/RiskGate.js';
import { AuditService } from './services/AuditService.js';
import { MarketDataSessionService } from './services/MarketDataSessionService.js';
import { SessionControl } from './services/SessionControl.js';
import { TradingControl } from './services/TradingControl.js';
import { TradingService } from './services/TradingService.js';
import { HuggingFaceClient } from './llm/huggingfaceClient.js';
import { LlmTradeAdvisorService } from './llm/LlmTradeAdvisorService.js';
import { NewsService } from './news/NewsService.js';
import { getCatalogTradingsymbols } from './instruments/kiteInstruments.js';
import { parseSessionStartBody } from './session/sessionStartSchema.js';

const application = Fastify({ logger: { level: config.logLevel } });
const control = new TradingControl();
const broker = new KiteBroker();
const riskGate = new RiskGate({
  maxOrderNotionalInr: new Decimal(config.maxOrderNotionalInr),
  maxOrdersPerRun: config.maxOrdersPerRun,
  catalogSymbols: new Set(getCatalogTradingsymbols()),
});
const tradingService = new TradingService(
  config.tradingMode === 'live' ? 'LIVE' : 'PAPER',
  broker,
  riskGate,
  new AuditService(),
  control,
);
const sessionControl = new SessionControl();
const sessionService = new MarketDataSessionService({
  broker,
  sessionControl,
  logger: application.log,
});
const llmClient = new HuggingFaceClient();
const llmAdvisor = new LlmTradeAdvisorService({
  llm: llmClient,
  news: new NewsService(),
  logger: application.log,
});

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

await application.register(swagger, {
  openapi: {
    info: {
      title: 'NSE Trading Bot API',
      description: 'Operational and market-data session APIs for the local trading bot.',
      version: '0.1.0',
    },
    components: {
      securitySchemes: {
        adminToken: {
          type: 'apiKey',
          name: 'x-admin-token',
          in: 'header',
        },
      },
    },
  },
});

await application.register(swaggerUi, {
  routePrefix: '/docs',
});

const sessionInstrumentSchema = {
  type: 'object',
  required: ['instrumentToken', 'exchange', 'tradingsymbol'],
  properties: {
    instrumentToken: { type: 'integer', minimum: 1 },
    exchange: { type: 'string' },
    tradingsymbol: { type: 'string' },
  },
} as const;

const sessionStatusSchema = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['stopped', 'running'] },
    running: { type: 'boolean' },
    instruments: { type: 'array', items: sessionInstrumentSchema },
    streamConnected: { type: 'boolean' },
    startedAt: { type: ['string', 'null'] },
    elapsedSeconds: { type: 'integer' },
    lastSnapshotAt: { type: ['string', 'null'] },
    insideMarketWindow: { type: 'boolean' },
    tickSeconds: { type: 'integer' },
  },
} as const;

application.get(
  '/health',
  {
    schema: {
      tags: ['ops'],
      summary: 'Health check',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            mode: { type: 'string' },
          },
        },
      },
    },
  },
  async () => {
    await database.$queryRaw`SELECT 1`;
    return { status: 'ok', mode: config.tradingMode };
  },
);

application.get(
  '/api/v1/readiness',
  {
    schema: {
      tags: ['ops'],
      summary: 'Readiness snapshot',
      response: {
        200: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
            broker: { type: 'string' },
            paused: { type: 'boolean' },
            reason: { type: ['string', 'null'] },
            strategyEnabled: { type: 'boolean' },
          },
        },
      },
    },
  },
  async () => tradingService.getReadiness(),
);

application.get(
  '/api/v1/portfolio',
  {
    schema: {
      tags: ['portfolio'],
      summary: 'Broker portfolio details',
      security: [{ adminToken: [] }],
    },
  },
  async (request) => {
    await requireAdmin(request);
    return tradingService.getPortfolio();
  },
);

application.post(
  '/api/v1/session/start',
  {
    schema: {
      tags: ['session'],
      summary: 'Start market-data session',
      security: [{ adminToken: [] }],
      body: {
        type: 'object',
        required: ['instruments'],
        properties: {
          instruments: {
            type: 'array',
            minItems: 1,
            items: sessionInstrumentSchema,
          },
        },
      },
      response: {
        200: sessionStatusSchema,
      },
    },
  },
  async (request) => {
    await requireAdmin(request);
    try {
      const body = parseSessionStartBody(request.body);
      return await sessionService.start(body.instruments);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        throw Object.assign(new Error(error.issues.map((issue) => issue.message).join('; ')), {
          statusCode: 400,
        });
      }
      throw error;
    }
  },
);

application.post(
  '/api/v1/session/stop',
  {
    schema: {
      tags: ['session'],
      summary: 'Stop market-data session',
      security: [{ adminToken: [] }],
      response: {
        200: sessionStatusSchema,
      },
    },
  },
  async (request) => {
    await requireAdmin(request);
    return sessionService.stop();
  },
);

application.get(
  '/api/v1/session',
  {
    schema: {
      tags: ['session'],
      summary: 'Market-data session status',
      security: [{ adminToken: [] }],
      response: {
        200: sessionStatusSchema,
      },
    },
  },
  async (request) => {
    await requireAdmin(request);
    return sessionService.getStatus();
  },
);

application.post(
  '/api/v1/llm/universe',
  {
    schema: {
      tags: ['llm'],
      summary: 'Suggest stocks from news, mapped to Kite instruments for session/start',
      security: [{ adminToken: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            asOfIst: { type: 'string' },
            model: { type: 'string' },
            newsItemCount: { type: 'integer' },
            includedSymbols: { type: 'array', items: { type: 'string' } },
            unmappedSymbols: { type: 'array', items: { type: 'string' } },
            sessionStartPayload: {
              type: 'object',
              properties: {
                instruments: { type: 'array', items: sessionInstrumentSchema },
              },
            },
            suggestion: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  },
  async (request) => {
    await requireAdmin(request);
    try {
      return await llmAdvisor.suggestUniverse();
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        throw Object.assign(new Error(error.issues.map((issue) => issue.message).join('; ')), {
          statusCode: 502,
        });
      }
      throw error;
    }
  },
);

application.get(
  '/api/v1/llm/universe',
  {
    schema: {
      tags: ['llm'],
      summary: 'Current in-memory LLM watchlist (from last suggest call)',
      security: [{ adminToken: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            includedSymbols: { type: 'array', items: { type: 'string' } },
            watchlistFile: { type: ['string', 'null'] },
            sessionStartPayload: {
              type: 'object',
              properties: {
                instruments: { type: 'array', items: sessionInstrumentSchema },
              },
            },
            decisionIntervalMinutes: { type: 'integer' },
          },
        },
      },
    },
  },
  async (request) => {
    await requireAdmin(request);
    return {
      includedSymbols: [...llmAdvisor.getIncludedSymbols()],
      watchlistFile: llmAdvisor.getWatchlistFile(),
      sessionStartPayload: llmAdvisor.getSessionStartPayload(),
      decisionIntervalMinutes: config.llm.decisionIntervalMinutes,
    };
  },
);

// Control endpoints are disabled for now.
// application.post('/api/v1/control/pause', async (request) => {
//   await requireAdmin(request);
//   control.pause('Paused by an authenticated operator.');
//   return tradingService.getReadiness();
// });

// application.post('/api/v1/control/resume', async (request) => {
//   await requireAdmin(request);
//   control.resume();
//   return tradingService.getReadiness();
// });

// application.post('/api/v1/runs/daily', async (request) => {
//   await requireAdmin(request);
//   return tradingService.runDailyCycle();
// });

application.addHook('onClose', async () => {
  llmAdvisor.stop();
  await sessionService.shutdown();
  await database.$disconnect();
});

async function main(): Promise<void> {
  application.log.info('Bootstrapping Kite broker and WebSocket before listen.');
  await sessionService.connectAtBoot();

  application.log.info({ model: config.huggingface.model }, 'Connecting Hugging Face LLM before listen.');
  await llmClient.connect();
  application.log.info('Hugging Face LLM connected and ready.');

  llmAdvisor.startDecisionLoop();

  await application.listen({ host: '0.0.0.0', port: config.port });
  application.log.info({ docs: `http://localhost:${config.port}/docs` }, 'Swagger UI available.');
}

main().catch((error: unknown) => {
  application.log.fatal(error, 'Unable to start trading bot.');
  process.exitCode = 1;
});
