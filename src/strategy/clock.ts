/** India has no daylight saving, so IST is always UTC+05:30. */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type IstClock = {
  ymd: string;
  /** Minutes after midnight IST. */
  minute: number;
  weekday: (typeof WEEKDAYS)[number];
  isWeekday: boolean;
};

export function istClock(date: Date): IstClock {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  const weekday = WEEKDAYS[shifted.getUTCDay()]!;
  return {
    ymd: shifted.toISOString().slice(0, 10),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday,
    isWeekday: weekday !== 'Sat' && weekday !== 'Sun',
  };
}

/** Midnight IST of the given instant's IST date. */
export function istDayStart(date: Date): Date {
  const shifted = date.getTime() + IST_OFFSET_MS;
  return new Date(shifted - (shifted % DAY_MS) - IST_OFFSET_MS);
}

/** The instant at `minute` after midnight IST on `date`'s IST day. */
export function istTimeOnDay(date: Date, minute: number): Date {
  return new Date(istDayStart(date).getTime() + minute * 60_000);
}

/** `YYYY-MM-DD HH:mm:ss` in IST, the format Kite historical expects. */
export function formatIstWallClock(date: Date): string {
  const iso = new Date(date.getTime() + IST_OFFSET_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** 870 → "2:30 PM". */
export function formatClockTime(minuteOfDay: number): string {
  const hour24 = Math.floor(minuteOfDay / 60) % 24;
  const minute = minuteOfDay % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`;
}

export function formatIstTime(date: Date): string {
  return formatClockTime(istClock(date).minute);
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
}

/**
 * Delay until the next cycle slot: multiples of `intervalMinutes` after midnight IST,
 * plus `offsetSeconds` so the 5-minute candle that just ended has been published.
 */
export function msUntilNextCycle(now: Date, intervalMinutes: number, offsetSeconds = 20): number {
  const minutes = Number.isFinite(intervalMinutes) && intervalMinutes >= 1 ? intervalMinutes : 15;
  const intervalMs = minutes * 60_000;
  const sinceMidnight = (now.getTime() + IST_OFFSET_MS) % DAY_MS;
  const sinceSlot =
    (((sinceMidnight - offsetSeconds * 1_000) % intervalMs) + intervalMs) % intervalMs;
  return intervalMs - sinceSlot;
}
