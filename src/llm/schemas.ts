import { z } from 'zod';

export const llmTradeActionSchema = z.enum(['BUY', 'HOLD', 'EXIT', 'SKIP']);
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
    if (value === 'NONE' || value === 'WAIT' || value === 'NO_TRADE' || value === 'PASS') {
      return 'SKIP';
    }
    return value;
  })
  .pipe(llmTradeActionSchema);

export const watchlistItemSchema = z.object({
  symbol: z.string().trim().min(1).transform((value) => value.toUpperCase()),
  include: z.boolean(),
  rationale: z.string().trim().min(1),
  rank: z.number().int().min(1).max(2).optional(),
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

export function clampWatchlistToTop(suggestion: UniverseSuggestion, maxInclude = 2): UniverseSuggestion {
  const included = suggestion.watchlist.filter((item) => item.include);
  const dropped = included.slice(maxInclude).map((item) => ({
    symbol: item.symbol,
    reason: `Clamped to at most ${maxInclude} names.`,
  }));
  const kept = included.slice(0, maxInclude).map((item, index) => ({
    ...item,
    include: true as const,
    rank: (index + 1) as 1 | 2,
  }));

  return {
    ...suggestion,
    watchlist: kept,
    exclude: [...suggestion.exclude, ...dropped],
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

export function allowedActionsForLatest(
  latest: LlmTradeActionName | null | undefined,
): LlmTradeActionName[] {
  if (latest === 'BUY') {
    return ['HOLD', 'EXIT'];
  }
  if (latest === 'HOLD') {
    return ['EXIT'];
  }
  return ['BUY', 'SKIP'];
}

/** Prompt uses SELL; stored enum is EXIT. */
export function promptActionLabels(
  actions: readonly LlmTradeActionName[],
): Array<'BUY' | 'HOLD' | 'SELL' | 'SKIP'> {
  return actions.map((action) => (action === 'EXIT' ? 'SELL' : action));
}

export function clampDecisionsToAllowed(
  batch: DecisionBatch,
  allowedBySymbol: ReadonlyMap<string, readonly LlmTradeActionName[]>,
): { batch: DecisionBatch; dropped: Array<{ symbol: string; action: LlmTradeActionName }> } {
  const kept = [];
  const dropped: Array<{ symbol: string; action: LlmTradeActionName }> = [];
  for (const item of batch.decisions) {
    const allowed = allowedBySymbol.get(item.symbol);
    if (!allowed || !allowed.includes(item.action)) {
      dropped.push({ symbol: item.symbol, action: item.action });
      continue;
    }
    kept.push(item);
  }
  return { batch: { ...batch, decisions: kept }, dropped };
}
