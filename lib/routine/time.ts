/**
 * Timezone helpers. Routines are about the wall clock in the monitored home,
 * not the server's clock, so every hour/day calculation goes through here.
 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** YYYY-MM-DD in the home's timezone. */
  dateKey: string;
  /** Minutes since local midnight, 0-1439. */
  minuteOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(ts: number, tz: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const { year, month, day, hour, minute } = parts;
  const dateKey = `${year}-${pad(month)}-${pad(day)}`;
  return { year, month, day, hour, minute, dateKey, minuteOfDay: hour * 60 + minute };
}

/** Offset (ms) of `tz` from UTC at instant `ts`. */
function tzOffset(ts: number, tz: string): number {
  const p = localParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(ts / 60_000) * 60_000;
}

/** Epoch ms for a wall-clock time (dateKey + minutes after midnight) in `tz`. */
export function zonedToUtc(dateKey: string, minuteOfDay: number, tz: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const first = guess - tzOffset(guess, tz);
  // Re-check at the result in case we crossed a DST boundary.
  return guess - tzOffset(first, tz);
}

export function startOfLocalDay(ts: number, tz: string): number {
  return zonedToUtc(localParts(ts, tz).dateKey, 0, tz);
}

/** dateKey shifted by `days` (calendar arithmetic, timezone-independent). */
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Whole calendar days from dateKey `a` to `b` (negative if b is earlier). */
export function daysBetween(a: string, b: string): number {
  const utc = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

/** Day of the week for a dateKey: 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Tue, Mar 17" for a dateKey (calendar date, no timezone involved). */
export function formatDateKey(dateKey: string, opts: { weekday?: 'short' | 'long' | false; month?: boolean } = {}): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    ...(opts.weekday === false ? {} : { weekday: opts.weekday ?? 'short' }),
    ...(opts.month === false ? {} : { month: 'short', day: 'numeric' }),
  });
}

export function formatMinuteOfDay(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = Math.round(min % 60);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)}${suffix}`;
}

export function formatTime(ts: number, tz: string): string {
  return formatMinuteOfDay(localParts(ts, tz).minuteOfDay);
}

/** e.g. "Sun, Oct 18, 6:00pm" in the home's timezone. */
export function formatDateTime(ts: number, tz: string): string {
  const date = new Date(ts).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  return `${date}, ${formatTime(ts, tz)}`;
}

/** "just now", "12m ago", "3h 5m ago". */
export function formatAgo(ms: number): string {
  return ms < 60_000 ? 'just now' : `${formatDuration(ms)} ago`;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  // "4d 13h" reads better than "109h 37m"; minutes stop mattering by then.
  if (h >= 48) return h % 24 === 0 ? `${h / 24}d` : `${Math.floor(h / 24)}d ${h % 24}h`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
