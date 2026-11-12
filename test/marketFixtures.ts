import type { IntradayBar } from '../src/universe/types.js';

export function ist(ymd: string, hhmm: string): Date {
  return new Date(`${ymd}T${hhmm}:00+05:30`);
}

/**
 * 5-minute futures bars: a full session on `yesterday` plus `todayBars` bars from 09:15 today.
 * A steady uptrend with pullbacks (+12 / −6, about NIFTY's normal 5-minute swing), so trend
 * votes are up while the chase limit is not hit; open interest rises and the last three bars
 * carry heavy volume.
 */
export function uptrendFuturesBars(input: {
  yesterday: string;
  today: string;
  todayBars?: number;
  startPrice?: number;
  up?: number;
  down?: number;
}): IntradayBar[] {
  const up = input.up ?? 12;
  const down = input.down ?? 6;
  const sessions = [
    { ymd: input.yesterday, bars: 75 },
    { ymd: input.today, bars: input.todayBars ?? 15 },
  ];
  const total = sessions.reduce((sum, session) => sum + session.bars, 0);
  const bars: IntradayBar[] = [];
  let close = input.startPrice ?? 24_000;
  let oi = 10_000_000;
  for (const session of sessions) {
    for (let slot = 0; slot < session.bars; slot += 1) {
      const fromEnd = total - 1 - bars.length;
      const open = close;
      close = open + (fromEnd % 2 === 0 ? up : -down);
      const isToday = session.ymd === input.today;
      oi += isToday ? 8_000 : 0;
      bars.push({
        t: new Date(ist(session.ymd, '09:15').getTime() + slot * 5 * 60_000).toISOString(),
        o: open,
        h: Math.max(open, close) + 2,
        l: Math.min(open, close) - 2,
        c: close,
        v: isToday && fromEnd < 3 ? 3_000 : 1_000,
        oi,
      });
    }
  }
  return bars;
}

/** Consecutive 5-minute bars from `from` on `ymd`, each given as [open, high, low, close, volume?]. */
export function fiveMinuteBars(
  ymd: string,
  from: string,
  specs: ReadonlyArray<readonly [number, number, number, number, number?]>,
): IntradayBar[] {
  const start = ist(ymd, from).getTime();
  return specs.map(([o, h, l, c, v], index) => ({
    t: new Date(start + index * 5 * 60_000).toISOString(),
    o,
    h,
    l,
    c,
    v: v ?? 1_000,
  }));
}

/**
 * `count` bars from `open`, each closing `step` points from its open with 2.5-point wicks, so a
 * ±5 step makes every bar (and the ATR) exactly 10 points.
 */
export function steppingBars(
  ymd: string,
  from: string,
  open: number,
  step: number,
  count: number,
  volume = 1_000,
): IntradayBar[] {
  const specs: Array<[number, number, number, number, number]> = [];
  let price = open;
  for (let index = 0; index < count; index += 1) {
    const close = price + step;
    specs.push([price, Math.max(price, close) + 2.5, Math.min(price, close) - 2.5, close, volume]);
    price = close;
  }
  return fiveMinuteBars(ymd, from, specs);
}
