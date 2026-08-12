import { z } from 'zod';

import { config } from '../config.js';
import type { SessionInstrument, SessionStartRequest } from '../domain.js';

export const sessionInstrumentSchema = z.object({
  instrumentToken: z.number().int().positive(),
  exchange: z.string().trim().min(1),
  tradingsymbol: z.string().trim().min(1),
});

export const sessionStartBodySchema = z
  .object({
    instruments: z
      .array(sessionInstrumentSchema)
      .min(1, 'At least one instrument is required.')
      .max(config.session.maxInstruments),
  })
  .superRefine((body, context) => {
    const seen = new Set<number>();
    for (const [index, instrument] of body.instruments.entries()) {
      const symbol = instrument.tradingsymbol.trim().toUpperCase();
      if (!config.allowedSymbols.has(symbol)) {
        context.addIssue({
          code: 'custom',
          message: `Symbol ${symbol} is not in ALLOWED_SYMBOLS.`,
          path: ['instruments', index, 'tradingsymbol'],
        });
      }
      if (seen.has(instrument.instrumentToken)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate instrumentToken ${instrument.instrumentToken}.`,
          path: ['instruments', index, 'instrumentToken'],
        });
      }
      seen.add(instrument.instrumentToken);
    }
  });

export function parseSessionStartBody(body: unknown): SessionStartRequest {
  const parsed = sessionStartBodySchema.parse(body);
  const instruments: SessionInstrument[] = parsed.instruments.map((instrument) => ({
    instrumentToken: instrument.instrumentToken,
    exchange: instrument.exchange.trim().toUpperCase(),
    tradingsymbol: instrument.tradingsymbol.trim().toUpperCase(),
  }));
  return { instruments };
}
