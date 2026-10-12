import type { RingDevice, RingEvent } from '../ring/types';
import { addDays, localParts } from './time';

/** Events at or after this local time count toward "the day has started". */
export const DAY_START_MINUTE = 4 * 60;

/** Minimum days of history before the learned routine is trusted. */
export const MIN_BASELINE_DAYS = 3;

export interface Baseline {
  /** Days in the window that had any activity. */
  daysObserved: number;
  /** Average number of activity events per local hour of day. */
  hourlyMean: number[];
  /** Fraction of observed days with any activity in each hour (0-1). */
  hourlyPresence: number[];
  /** Hours where activity is normal on most days. */
  activeHours: boolean[];
  /** Median minute-of-day of the first activity after DAY_START_MINUTE. */
  typicalFirstMinute: number | null;
  /** 90th percentile of first activity: the late end of a normal morning. */
  lateFirstMinute: number | null;
  /** Median minute-of-day of the last activity of the day. */
  typicalLastMinute: number | null;
  /** Median of each day's longest gap between activity, between first and last activity (ms). */
  typicalLongestGapMs: number | null;
}

export type ActivityFilter = (e: RingEvent) => boolean;

/**
 * Whether an event means the resident is up and about. Doorbell presses are
 * visitors; devices flagged `countsAsActivity: false` (doorbells by default)
 * mostly see delivery drivers and passers-by.
 */
export function activityFilter(devices: RingDevice[]): ActivityFilter {
  const ignored = new Set(devices.filter((d) => !d.countsAsActivity).map((d) => d.id));
  return (e) => e.kind !== 'ding' && !ignored.has(e.deviceId);
}

/** Device-agnostic fallback: everything except doorbell presses. */
export const isActivity: ActivityFilter = (e) => e.kind !== 'ding';

export function emptyBaseline(): Baseline {
  return {
    daysObserved: 0,
    hourlyMean: Array(24).fill(0),
    hourlyPresence: Array(24).fill(0),
    activeHours: Array(24).fill(false),
    typicalFirstMinute: null,
    lateFirstMinute: null,
    typicalLastMinute: null,
    typicalLongestGapMs: null,
  };
}

/**
 * Learn the resident's routine from the `days` full local days before `now`.
 * Today is excluded so a partial day can't skew the averages.
 */
export function computeBaseline(
  events: RingEvent[],
  opts: { now: number; timezone: string; days: number; isActivity?: ActivityFilter },
): Baseline {
  const counts = opts.isActivity ?? isActivity;
  const today = localParts(opts.now, opts.timezone).dateKey;
  const firstDay = addDays(today, -opts.days);

  const byDay = new Map<string, { ts: number; minute: number; hour: number }[]>();
  for (const e of events) {
    if (!counts(e)) continue;
    const p = localParts(e.occurredAt, opts.timezone);
    if (p.dateKey < firstDay || p.dateKey >= today) continue;
    const list = byDay.get(p.dateKey) ?? [];
    list.push({ ts: e.occurredAt, minute: p.minuteOfDay, hour: p.hour });
    byDay.set(p.dateKey, list);
  }

  const daysObserved = byDay.size;
  if (daysObserved === 0) return emptyBaseline();

  const hourlyTotals = Array(24).fill(0);
  const hourlyDays = Array(24).fill(0);
  const firsts: number[] = [];
  const lasts: number[] = [];
  const longestGaps: number[] = [];

  for (const list of byDay.values()) {
    list.sort((a, b) => a.ts - b.ts);
    const seenHours = new Set<number>();
    for (const item of list) {
      hourlyTotals[item.hour]++;
      seenHours.add(item.hour);
    }
    for (const h of seenHours) hourlyDays[h]++;

    const daytime = list.filter((i) => i.minute >= DAY_START_MINUTE);
    if (daytime.length > 0) {
      firsts.push(daytime[0].minute);
      lasts.push(daytime[daytime.length - 1].minute);
      let longest = 0;
      for (let i = 1; i < daytime.length; i++) {
        longest = Math.max(longest, daytime[i].ts - daytime[i - 1].ts);
      }
      longestGaps.push(longest);
    }
  }

  const hourlyMean = hourlyTotals.map((t) => t / daysObserved);
  const hourlyPresence = hourlyDays.map((d) => d / daysObserved);

  return {
    daysObserved,
    hourlyMean,
    hourlyPresence,
    activeHours: hourlyPresence.map((p) => p >= 0.6),
    typicalFirstMinute: median(firsts),
    lateFirstMinute: percentile(firsts, 0.9),
    typicalLastMinute: median(lasts),
    typicalLongestGapMs: median(longestGaps),
  };
}

export function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

/** Linear-interpolated percentile (p in 0-1). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Count of activity events per local hour for one day. */
export function hourlyCounts(
  events: RingEvent[],
  dateKey: string,
  timezone: string,
  counts: ActivityFilter = isActivity,
): number[] {
  const out = Array(24).fill(0);
  for (const e of events) {
    if (!counts(e)) continue;
    const p = localParts(e.occurredAt, timezone);
    if (p.dateKey === dateKey) out[p.hour]++;
  }
  return out;
}
