import type { DailyBar } from '../universe/types.js';
import { computeFeatures } from '../universe/features.js';
import { MAX_ATR_PCT_FOR_BUY, TAKE_PROFIT_PCT, STOP_LOSS_PCT } from '../llm/tradePlaybook.js';

export const OPTION_BAR_LOOKBACK_DAYS = 30;

export type OptionRuleSet = {
  id: string;
  stopLossPct: number;
  takeProfitPct: number;
};

export const OPTION_RULE_SETS: readonly OptionRuleSet[] = [
  { id: 'stop10_tp20', stopLossPct: 10, takeProfitPct: 20 },
  { id: 'stop8_tp15', stopLossPct: 8, takeProfitPct: 15 },
  { id: 'stop12_tp25', stopLossPct: 12, takeProfitPct: 25 },
];

export type OptionRuleScore = OptionRuleSet & {
  returnPct: number;
  trades: number;
};

function barsThrough(bars: readonly DailyBar[], ymd: string): DailyBar[] {
  return bars.filter((bar) => bar.d <= ymd);
}

function sideFits(side: 'CE' | 'PE', indexSlice: DailyBar[]): boolean {
  const features = computeFeatures(indexSlice, [], indexSlice);
  const smaUp = features.sma20 !== null && features.sma50 !== null && features.sma20 > features.sma50;
  const smaDown = features.sma20 !== null && features.sma50 !== null && features.sma20 < features.sma50;
  const retUp = features.ret20Pct !== null && features.ret20Pct > 0;
  const retDown = features.ret20Pct !== null && features.ret20Pct < 0;
  const calm = features.atrPct === null || features.atrPct < MAX_ATR_PCT_FOR_BUY;
  if (!calm) {
    return false;
  }
  return side === 'CE' ? smaUp && retUp : smaDown && retDown;
}

function smaReversed(side: 'CE' | 'PE', indexSlice: DailyBar[]): boolean {
  const features = computeFeatures(indexSlice, [], indexSlice);
  if (features.sma20 === null || features.sma50 === null) {
    return false;
  }
  return side === 'CE' ? features.sma20 < features.sma50 : features.sma20 > features.sma50;
}

function simulateRule(
  optionDaily: readonly DailyBar[],
  indexDaily: readonly DailyBar[],
  side: 'CE' | 'PE',
  rule: OptionRuleSet,
): OptionRuleScore {
  let inPosition = false;
  let entry = 0;
  let trades = 0;
  let compounded = 1;
  for (const bar of optionDaily) {
    const indexSlice = barsThrough(indexDaily, bar.d);
    if (indexSlice.length < 20) {
      continue;
    }
    if (!inPosition) {
      if (sideFits(side, indexSlice) && bar.c > 0) {
        inPosition = true;
        entry = bar.c;
      }
      continue;
    }
    const pnl = ((bar.c - entry) / entry) * 100;
    if (pnl <= -rule.stopLossPct || pnl >= rule.takeProfitPct || smaReversed(side, indexSlice)) {
      compounded *= 1 + pnl / 100;
      trades += 1;
      inPosition = false;
      entry = 0;
    }
  }
  const returnPct = trades === 0 ? 0 : (compounded - 1) * 100;
  return { ...rule, returnPct: Number(returnPct.toFixed(3)), trades };
}

export function pickBestOptionRule(
  optionDaily: readonly DailyBar[],
  indexDaily: readonly DailyBar[],
  side: 'CE' | 'PE',
): OptionRuleScore {
  const scored = OPTION_RULE_SETS.map((rule) => simulateRule(optionDaily, indexDaily, side, rule));
  scored.sort((left, right) => {
    if (right.returnPct !== left.returnPct) {
      return right.returnPct - left.returnPct;
    }
    return right.trades - left.trades;
  });
  return (
    scored[0] ?? {
      id: 'stop10_tp20',
      stopLossPct: STOP_LOSS_PCT,
      takeProfitPct: TAKE_PROFIT_PCT,
      returnPct: 0,
      trades: 0,
    }
  );
}
