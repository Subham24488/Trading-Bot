import type { Tick } from 'kiteconnect';

export type CachedQuote = {
  instrumentToken: number;
  lastPrice: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  change?: number;
  volume?: number;
  receivedAt: string;
};

export class QuoteCache {
  private readonly quotes = new Map<number, CachedQuote>();

  public upsertTick(tick: Tick): CachedQuote {
    const quote: CachedQuote = {
      instrumentToken: tick.instrument_token,
      lastPrice: tick.last_price,
      receivedAt: new Date().toISOString(),
    };

    if ('ohlc' in tick && tick.ohlc) {
      quote.open = tick.ohlc.open;
      quote.high = tick.ohlc.high;
      quote.low = tick.ohlc.low;
      quote.close = tick.ohlc.close;
    }
    if ('change' in tick && typeof tick.change === 'number') {
      quote.change = tick.change;
    }
    if ('volume_traded' in tick && typeof tick.volume_traded === 'number') {
      quote.volume = tick.volume_traded;
    }

    this.quotes.set(tick.instrument_token, quote);
    return quote;
  }

  public get(instrumentToken: number): CachedQuote | undefined {
    return this.quotes.get(instrumentToken);
  }

  public getMany(instrumentTokens: number[]): CachedQuote[] {
    const result: CachedQuote[] = [];
    for (const token of instrumentTokens) {
      const quote = this.quotes.get(token);
      if (quote) {
        result.push(quote);
      }
    }
    return result;
  }

  public clear(): void {
    this.quotes.clear();
  }
}
