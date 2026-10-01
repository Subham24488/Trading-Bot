/**
 * Minimal NSE index-options fee approximations for store-only decision gates.
 * Not a brokerage invoice — constants are conservative order-of-magnitude estimates.
 */

/** Fixed brokerage per order leg (discount broker style cap). */
export const OPTIONS_BROKERAGE_PER_ORDER = 20;
/** STT on options sell (premium notional), approx. */
export const OPTIONS_STT_SELL_RATE = 0.001;
/** Exchange + clearing + SEBI combined on premium notional, both sides. */
export const OPTIONS_EXCHANGE_RATE = 0.00053;
/** GST on (brokerage + exchange fees). */
export const OPTIONS_GST_RATE = 0.18;
/** Default lot size hint when unknown (NIFTY-style). */
export const DEFAULT_INDEX_OPTION_LOT = 25;

export type OptionRoundTripCost = {
  brokerageInr: number;
  sttInr: number;
  exchangeInr: number;
  gstInr: number;
  totalInr: number;
  costPctOfNotional: number;
};

/** Estimated round-trip cost to buy then sell one options lot at the given premiums. */
export function estimateOptionsRoundTripCost(input: {
  buyPremium: number;
  sellPremium: number;
  quantity: number;
}): OptionRoundTripCost {
  const qty = Math.max(1, Math.floor(input.quantity));
  const buyNotional = Math.max(0, input.buyPremium) * qty;
  const sellNotional = Math.max(0, input.sellPremium) * qty;
  const brokerageInr = OPTIONS_BROKERAGE_PER_ORDER * 2;
  const sttInr = sellNotional * OPTIONS_STT_SELL_RATE;
  const exchangeInr = (buyNotional + sellNotional) * OPTIONS_EXCHANGE_RATE;
  const gstInr = (brokerageInr + exchangeInr) * OPTIONS_GST_RATE;
  const totalInr = brokerageInr + sttInr + exchangeInr + gstInr;
  const midNotional = (buyNotional + sellNotional) / 2;
  const costPctOfNotional = midNotional > 0 ? (totalInr / midNotional) * 100 : 100;
  return {
    brokerageInr: Number(brokerageInr.toFixed(2)),
    sttInr: Number(sttInr.toFixed(2)),
    exchangeInr: Number(exchangeInr.toFixed(2)),
    gstInr: Number(gstInr.toFixed(2)),
    totalInr: Number(totalInr.toFixed(2)),
    costPctOfNotional: Number(costPctOfNotional.toFixed(3)),
  };
}

/** Gross premium PnL % before fees. */
export function premiumPnlPct(entry: number, exit: number): number | null {
  if (!(entry > 0) || !Number.isFinite(exit)) {
    return null;
  }
  return ((exit - entry) / entry) * 100;
}

/** Net PnL % after estimated round-trip fees (exit vs entry). */
export function netPnlPctAfterFees(input: {
  entryPremium: number;
  exitPremium: number;
  quantity: number;
}): number | null {
  const gross = premiumPnlPct(input.entryPremium, input.exitPremium);
  if (gross === null) {
    return null;
  }
  const costs = estimateOptionsRoundTripCost({
    buyPremium: input.entryPremium,
    sellPremium: input.exitPremium,
    quantity: input.quantity,
  });
  const entryNotional = input.entryPremium * Math.max(1, Math.floor(input.quantity));
  if (!(entryNotional > 0)) {
    return null;
  }
  const netInr = (input.exitPremium - input.entryPremium) * input.quantity - costs.totalInr;
  return Number(((netInr / entryNotional) * 100).toFixed(3));
}

/**
 * True when a BUY targeting +targetNetPnlPct on premium clears estimated round-trip fees.
 */
export function buyClearsFeeTarget(input: {
  premium: number;
  quantity: number;
  targetNetPnlPct: number;
}): boolean {
  if (!(input.premium > 0)) {
    return false;
  }
  const targetExit = input.premium * (1 + input.targetNetPnlPct / 100);
  const net = netPnlPctAfterFees({
    entryPremium: input.premium,
    exitPremium: targetExit,
    quantity: input.quantity,
  });
  return net !== null && net > 0;
}
