import type { SymbolNews } from '../news/NewsService.js';
import type { QuoteLogSnapshot } from './quoteLogReader.js';

export function buildUniverseMessages(
  asOfIst: string,
  kiteTradingsymbols: readonly string[],
  news: readonly SymbolNews[],
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You are an NSE cash-market research assistant. Suggest a watchlist only from the Kite tradingsymbols listed. ' +
        'Use the supplied ~1 month of headlines. Reply with a single JSON object. ' +
        'Do not invent tickers. Do not give order instructions for a live broker.',
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          asOfIst,
          kiteTradingsymbols,
          newsLookback: 'approximately one month of retrieved headlines per symbol',
          news,
          outputSchema: {
            asOfIst: 'string',
            watchlist: [
              {
                symbol: 'KITE_TRADINGSYMBOL',
                include: true,
                rationale: 'short reason grounded in the headlines',
              },
            ],
            exclude: [{ symbol: 'KITE_TRADINGSYMBOL', reason: 'string' }],
          },
        },
        null,
        2,
      ),
    },
  ];
}

export function buildDecisionMessages(
  asOfIst: string,
  watchlistSymbols: readonly string[],
  snapshots: readonly QuoteLogSnapshot[],
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content:
        'You are an NSE paper-trading assistant. For each watchlist symbol, decide BUY, HOLD, or EXIT from the Kite quote snapshots. ' +
        'Reply with a single JSON object. Never claim that an order was sent. These decisions are recorded only.',
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          asOfIst,
          watchlistSymbols,
          kiteQuoteSnapshotsFromLogs: snapshots,
          outputSchema: {
            asOfIst: 'string',
            decisions: [
              {
                symbol: 'WATCHLIST_SYMBOL',
                action: 'BUY | HOLD | EXIT',
                confidence: 0.0,
                rationale: 'short reason grounded in the snapshots',
              },
            ],
          },
        },
        null,
        2,
      ),
    },
  ];
}
