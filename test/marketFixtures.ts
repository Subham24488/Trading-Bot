import type { IntradayBar } from '../src/universe/types.js';

export function ist(ymd: string, hhmm: string): Date {
  return new Date(`${ymd}T${hhmm}:00+05:30`);
}

/**
 * 5-minute futures bars: a full session on `yesterday` plus `todayBars` bars from 09:15 today.
 * A steady uptrend with pullbacks (+30 / −15), so trend votes are up while the chase limit
 * is not hit; open interest rises and the last three bars carry heavy volume.
 */
export function uptrendFuturesBars(input: {
  yesterday: string;
  today: string;
  todayBars?: number;
  startPrice?: number;
}): IntradayBar[] {
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
      close = open + (fromEnd % 2 === 0 ? 30 : -15);
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
