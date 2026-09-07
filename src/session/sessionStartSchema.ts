import { z } from 'zod';

import type { SessionInstrument, SessionStartRequest } from '../domain.js';
import { matchesCatalogInstrument } from '../instruments/kiteInstruments.js';
import { matchesNfoAllowlist } from '../instruments/kiteIndexUnderlyings.js';
import { config } from '../config.js';

export const sessionInstrumentSchema = z.object({
  instrumentToken: z.number().int().positive(),
  exchange: z.string().trim().min(1),
  tradingsymbol: z.string().trim().min(1),
});

export type SessionStartParseOptions = {
  nfoAllowlist?: readonly SessionInstrument[];
};

export function parseSessionStartBody(
  body: unknown,
  options: SessionStartParseOptions = {},
): SessionStartRequest {
  const nfoAllowlist = options.nfoAllowlist ?? [];
  const schema = z
    .object({
      instruments: z
        .array(sessionInstrumentSchema)
        .min(1, 'At least one instrument is required.')
        .max(config.session.maxInstruments),
    })
    .superRefine((parsed, context) => {
      const seen = new Set<number>();
      for (const [index, instrument] of parsed.instruments.entries()) {
        const normalized: SessionInstrument = {
          instrumentToken: instrument.instrumentToken,
          exchange: instrument.exchange.trim().toUpperCase(),
          tradingsymbol: instrument.tradingsymbol.trim().toUpperCase(),
        };
        if (normalized.exchange === 'NFO') {
          if (!matchesNfoAllowlist(normalized, nfoAllowlist)) {
            context.addIssue({
              code: 'custom',
              message: `NFO ${normalized.tradingsymbol} is not on the last options universe payload.`,
              path: ['instruments', index, 'tradingsymbol'],
            });
          }
        } else if (!matchesCatalogInstrument(normalized)) {
          context.addIssue({
            code: 'custom',
            message: `Symbol ${normalized.tradingsymbol} is not in data/kite-instruments.json (or token/exchange does not match Kite).`,
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

  const parsed = schema.parse(body);
  const instruments: SessionInstrument[] = parsed.instruments.map((instrument) => ({
    instrumentToken: instrument.instrumentToken,
    exchange: instrument.exchange.trim().toUpperCase(),
    tradingsymbol: instrument.tradingsymbol.trim().toUpperCase(),
  }));
  return { instruments };
}
