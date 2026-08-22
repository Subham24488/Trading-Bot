import { z } from 'zod';

export const llmTradeActionSchema = z.enum(['BUY', 'HOLD', 'EXIT']);
export type LlmTradeActionName = z.infer<typeof llmTradeActionSchema>;

const rawActionSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase().replace(/[\s-]+/g, '_'))
  .transform((value) => {
    if (value === 'ENTER_LONG' || value === 'ENTER' || value === 'LONG') {
      return 'BUY';
    }
    if (value === 'SELL' || value === 'EXIT_LONG' || value === 'CLOSE') {
      return 'EXIT';
    }
    if (value === 'SKIP' || value === 'NONE' || value === 'WAIT') {
      return 'HOLD';
    }
    return value;
  })
  .pipe(llmTradeActionSchema);

export const watchlistItemSchema = z.object({
  symbol: z.string().trim().min(1).transform((value) => value.toUpperCase()),
  include: z.boolean(),
  rationale: z.string().trim().min(1),
  maxPositionInr: z.number().positive().optional(),
});

export const universeSuggestionSchema = z.object({
  asOfIst: z.string().trim().min(1).optional(),
  watchlist: z.array(watchlistItemSchema).default([]),
  exclude: z
    .array(
      z.object({
        symbol: z.string().trim().min(1).transform((value) => value.toUpperCase()),
        reason: z.string().trim().min(1),
      }),
    )
    .default([]),
});

export type UniverseSuggestion = z.infer<typeof universeSuggestionSchema>;

export const decisionItemSchema = z.object({
  symbol: z.string().trim().min(1).transform((value) => value.toUpperCase()),
  action: rawActionSchema,
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().trim().min(1),
});

export const decisionBatchSchema = z.object({
  asOfIst: z.string().trim().min(1).optional(),
  decisions: z.array(decisionItemSchema).default([]),
});

export type DecisionBatch = z.infer<typeof decisionBatchSchema>;

export function intersectWatchlistWithCatalog(
  suggestion: UniverseSuggestion,
  catalogSymbols: ReadonlySet<string>,
): UniverseSuggestion {
  const watchlist = suggestion.watchlist.filter((item) => catalogSymbols.has(item.symbol));
  const leaked = suggestion.watchlist
    .filter((item) => !catalogSymbols.has(item.symbol))
    .map((item) => ({
      symbol: item.symbol,
      reason: 'Symbol is not in data/kite-instruments.json.',
    }));

  return {
    ...suggestion,
    watchlist,
    exclude: [...suggestion.exclude, ...leaked],
  };
}

export function filterDecisionsToSymbols(
  batch: DecisionBatch,
  symbols: ReadonlySet<string>,
): DecisionBatch {
  return {
    ...batch,
    decisions: batch.decisions.filter((item) => symbols.has(item.symbol)),
  };
}
