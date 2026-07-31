import { z } from 'zod';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1),
    TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
    MAX_ORDER_NOTIONAL_INR: z.coerce.number().positive().default(5000),
    MAX_ORDERS_PER_RUN: z.coerce.number().int().positive().max(10).default(5),
    ALLOWED_SYMBOLS: z.string().default('NIFTYBEES,LIQUIDBEES'),
    DAILY_ORDER_CUTOFF_HOUR: z.coerce.number().int().min(9).max(15).default(14),
    ADMIN_TOKEN: z.string().min(24),
    KITE_API_KEY: z.string().optional(),
    KITE_API_SECRET: z.string().optional(),
    KITE_ACCESS_TOKEN: z.string().optional(),
    LIVE_TRADING_ACKNOWLEDGEMENT: z.string().optional(),
  })
  .superRefine((environment, context) => {
    if (
      environment.TRADING_MODE === 'live' &&
      environment.LIVE_TRADING_ACKNOWLEDGEMENT !== 'I_UNDERSTAND_LIVE_TRADING_RISKS'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'LIVE_TRADING_ACKNOWLEDGEMENT must equal I_UNDERSTAND_LIVE_TRADING_RISKS in live mode.',
        path: ['LIVE_TRADING_ACKNOWLEDGEMENT'],
      });
    }
  });

const parsedEnvironment = environmentSchema.parse(process.env);

export const config = {
  environment: parsedEnvironment.NODE_ENV,
  port: parsedEnvironment.PORT,
  logLevel: parsedEnvironment.LOG_LEVEL,
  databaseUrl: parsedEnvironment.DATABASE_URL,
  tradingMode: parsedEnvironment.TRADING_MODE,
  maxOrderNotionalInr: parsedEnvironment.MAX_ORDER_NOTIONAL_INR,
  maxOrdersPerRun: parsedEnvironment.MAX_ORDERS_PER_RUN,
  allowedSymbols: new Set(
    parsedEnvironment.ALLOWED_SYMBOLS.split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean),
  ),
  dailyOrderCutoffHour: parsedEnvironment.DAILY_ORDER_CUTOFF_HOUR,
  adminToken: parsedEnvironment.ADMIN_TOKEN,
  kite: {
    apiKey: parsedEnvironment.KITE_API_KEY,
    apiSecret: parsedEnvironment.KITE_API_SECRET,
    accessToken: parsedEnvironment.KITE_ACCESS_TOKEN,
  },
} as const;
