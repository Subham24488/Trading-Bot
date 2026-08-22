/** IST calendar date as YYYY-MM-DD. */
export function istYmd(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

export function addCalendarDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  return new Date(utc + days * 86_400_000).toISOString().slice(0, 10);
}

export const UNIVERSE_BAR_LOOKBACK_DAYS = 60;

/** Calendar YMD as a Date whose IST date matches `ymd`. */
export function ymdToUtcDate(ymd: string): Date {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 6, 30, 0));
}

export function calendarDayDiff(fromYmd: string, toYmd: string): number {
  const [y1, m1, d1] = fromYmd.split('-').map(Number);
  const [y2, m2, d2] = toYmd.split('-').map(Number);
  const a = Date.UTC(y1 ?? 1970, (m1 ?? 1) - 1, d1 ?? 1);
  const b = Date.UTC(y2 ?? 1970, (m2 ?? 1) - 1, d2 ?? 1);
  return Math.round((b - a) / 86_400_000);
}

export type FetchWindow = {
  skipRemote: boolean;
  isSeed: boolean;
  newsFrom: string;
  newsTo: string;
  barsFrom: string;
  barsTo: string;
};

export function computeFetchWindow(
  coverageTo: string | null,
  today: string,
  newsLookbackDays: number,
  barLookbackDays: number,
): FetchWindow {
  if (!coverageTo) {
    return {
      skipRemote: false,
      isSeed: true,
      newsFrom: addCalendarDays(today, -newsLookbackDays),
      newsTo: today,
      barsFrom: addCalendarDays(today, -barLookbackDays),
      barsTo: today,
    };
  }

  if (coverageTo >= today) {
    return {
      skipRemote: true,
      isSeed: false,
      newsFrom: today,
      newsTo: today,
      barsFrom: today,
      barsTo: today,
    };
  }

  const from = addCalendarDays(coverageTo, 1);
  return {
    skipRemote: false,
    isSeed: false,
    newsFrom: from,
    newsTo: today,
    barsFrom: from,
    barsTo: today,
  };
}
