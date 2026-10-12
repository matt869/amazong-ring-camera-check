import type { RingDevice, RingEvent } from '../ring/types';
import { activityFilter, DAY_START_MINUTE, median } from './baseline';
import { detectOutings } from './presence';
import { inWindow } from './rules';
import { addDays, formatMinuteOfDay, localParts } from './time';

/**
 * Routine drift: slow changes over weeks that no single day reveals, such as
 * getting up a little later each week or going out less. The daily rules
 * compare today with the learned routine; this compares the last two weeks
 * with the month before, so a gradual decline can't quietly become "normal".
 */

export interface DayMetrics {
  dateKey: string;
  /** First movement after DAY_START_MINUTE (minute of day), or null. */
  wakeMinute: number | null;
  /** Movements that count as the resident's activity. */
  activity: number;
  /** Outings that began this day. */
  outings: number;
  /** Movements during the night that began this evening. */
  nightActivity: number;
}

export interface WeekMetrics {
  start: string;
  end: string;
  /** Days with data in this week (paused or empty days are left out). */
  days: number;
  wake: number | null;
  /** Average movements per day. */
  activity: number | null;
  /** Outings per week, scaled up if some days had no data. */
  outings: number | null;
  /** Average movements per night. */
  night: number | null;
}

export type DriftMetric = 'wake' | 'outings' | 'activity' | 'night';

export interface DriftFinding {
  metric: DriftMetric;
  title: string;
  detail: string;
}

/** Compare this many recent days... */
export const DRIFT_RECENT_DAYS = 14;
/** ...with this many days before them. */
export const DRIFT_REFERENCE_DAYS = 28;
/** Days of history needed: the windows above plus slack for days without data. */
export const DRIFT_HISTORY_DAYS = 63;

/** Per-day measures for the `days` full local days before `now` (today excluded). */
export function dailyMetrics(
  events: RingEvent[],
  devices: RingDevice[],
  opts: {
    now: number;
    timezone: string;
    days: number;
    nightStartMinute: number;
    nightEndMinute: number;
    /** Days to leave out, e.g. ones when alerts were paused because they were away. */
    skip?: (dateKey: string) => boolean;
  },
): DayMetrics[] {
  const tz = opts.timezone;
  const today = localParts(opts.now, tz).dateKey;
  const first = addDays(today, -opts.days);
  const counts = activityFilter(devices);
  const byDay = new Map<string, DayMetrics>();
  const day = (dateKey: string) => {
    let d = byDay.get(dateKey);
    if (!d) byDay.set(dateKey, (d = { dateKey, wakeMinute: null, activity: 0, outings: 0, nightActivity: 0 }));
    return d;
  };

  const chrono = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  for (const e of chrono) {
    if (!counts(e)) continue;
    const p = localParts(e.occurredAt, tz);
    const d = day(p.dateKey);
    d.activity++;
    if (d.wakeMinute == null && p.minuteOfDay >= DAY_START_MINUTE) d.wakeMinute = p.minuteOfDay;
    if (inWindow(p.minuteOfDay, opts.nightStartMinute, opts.nightEndMinute)) {
      // Small hours belong to the night that started the evening before.
      day(p.minuteOfDay < opts.nightEndMinute ? addDays(p.dateKey, -1) : p.dateKey).nightActivity++;
    }
  }
  for (const o of detectOutings(chrono, devices, opts.now)) day(localParts(o.left, tz).dateKey).outings++;

  return [...byDay.values()]
    .filter((d) => d.dateKey >= first && d.dateKey < today && d.activity > 0 && !opts.skip?.(d.dateKey))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function summarize(days: DayMetrics[]) {
  return {
    days: days.length,
    wake: median(days.flatMap((d) => (d.wakeMinute == null ? [] : [d.wakeMinute]))),
    activity: mean(days.map((d) => d.activity)),
    outings: days.length ? (days.reduce((a, d) => a + d.outings, 0) / days.length) * 7 : null,
    night: mean(days.map((d) => d.nightActivity)),
  };
}

/** Seven-day buckets ending on `lastDay`, oldest first. */
export function weeklyMetrics(days: DayMetrics[], lastDay: string, weeks: number): WeekMetrics[] {
  const out: WeekMetrics[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const end = addDays(lastDay, -7 * w);
    const start = addDays(end, -6);
    out.push({ start, end, ...summarize(days.filter((d) => d.dateKey >= start && d.dateKey <= end)) });
  }
  return out;
}

/** "1", "1.5", "4": outings per week read better rounded to halves. */
const halves = (n: number) => String(Math.round(n * 2) / 2);
const plural = (n: number, word: string) => `${word}${halves(n) === '1' ? '' : 's'}`;

/**
 * Compares the last two weeks (ending `lastDay`) with the four weeks before.
 * Needs at least 8 recent and 14 earlier days with data; says nothing otherwise.
 */
export type WindowSummary = ReturnType<typeof summarize>;

/** The last two weeks and the four before them, summarized; `enough` when both have sufficient days. */
export function compareWindows(days: DayMetrics[], lastDay: string): { recent: WindowSummary; reference: WindowSummary; enough: boolean } {
  const recentStart = addDays(lastDay, -(DRIFT_RECENT_DAYS - 1));
  const refStart = addDays(recentStart, -DRIFT_REFERENCE_DAYS);
  const recentDays = days.filter((d) => d.dateKey >= recentStart && d.dateKey <= lastDay);
  const refDays = days.filter((d) => d.dateKey >= refStart && d.dateKey < recentStart);
  return { recent: summarize(recentDays), reference: summarize(refDays), enough: recentDays.length >= 8 && refDays.length >= 14 };
}

export function detectDrift(days: DayMetrics[], lastDay: string, name: string): DriftFinding[] {
  const { recent, reference: ref, enough } = compareWindows(days, lastDay);
  if (!enough) return [];
  const out: DriftFinding[] = [];

  if (recent.wake != null && ref.wake != null) {
    const shift = recent.wake - ref.wake;
    // A steady slide reads differently from one odd fortnight, so say which it is.
    const weekly = weeklyMetrics(days, lastDay, 6).map((w) => w.wake);
    let later = 0;
    for (let i = 1; i < weekly.length; i++) if (weekly[i] != null && weekly[i - 1] != null && weekly[i]! >= weekly[i - 1]! - 5) later++;
    if (shift >= 30) {
      out.push({
        metric: 'wake',
        title: 'Getting up later',
        detail:
          `${name} has been up around ${formatMinuteOfDay(recent.wake)} lately, compared with ` +
          `${formatMinuteOfDay(ref.wake)} the month before${later >= 4 ? ', a little later each week' : ''}.`,
      });
    } else if (shift <= -45) {
      out.push({
        metric: 'wake',
        title: 'Getting up earlier',
        detail: `${name} has been up around ${formatMinuteOfDay(recent.wake)} lately, compared with ${formatMinuteOfDay(ref.wake)} the month before.`,
      });
    }
  }

  if (recent.outings != null && ref.outings != null && ref.outings >= 2 && recent.outings <= ref.outings * 0.6 && ref.outings - recent.outings >= 1) {
    out.push({
      metric: 'outings',
      title: 'Going out less often',
      detail:
        `About ${halves(recent.outings)} ${plural(recent.outings, 'outing')} a week lately, ` +
        `down from ${halves(ref.outings)} a week the month before.`,
    });
  }

  if (recent.activity != null && ref.activity != null && ref.activity >= 10 && recent.activity <= ref.activity * 0.75) {
    out.push({
      metric: 'activity',
      title: 'Moving around less at home',
      detail: `About ${Math.round(recent.activity)} movements a day lately, down from ${Math.round(ref.activity)} the month before.`,
    });
  }

  if (recent.night != null && ref.night != null && recent.night >= ref.night + 1.5 && recent.night >= ref.night * 2) {
    out.push({
      metric: 'night',
      title: 'More movement at night',
      detail: `About ${Math.round(recent.night)} movements a night lately, up from ${Math.round(ref.night * 10) / 10} the month before.`,
    });
  }

  return out;
}
