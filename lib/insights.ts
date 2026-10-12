import { getSettings, listDevices, listEvents, listPauseWindows } from './db';
import type { RingDevice } from './ring/types';
import {
  compareWindows,
  dailyMetrics,
  detectDrift,
  DRIFT_HISTORY_DAYS,
  weeklyMetrics,
  type DayMetrics,
  type DriftFinding,
  type WeekMetrics,
  type WindowSummary,
} from './routine/drift';
import type { CheckinSettings } from './routine/rules';
import { addDays, localParts, zonedToUtc } from './routine/time';
import { detectVisits, parseExpectedVisits, type Visit } from './routine/visitors';

/** Longer-range views built on the stored events: routine drift and visitors. */

const DAY_MS = 24 * 60 * 60_000;

/** Local dates touched by any pause: away or private, so not a fair sample of their routine. */
function pausedDays(tz: string): Set<string> {
  const days = new Set<string>();
  for (const w of listPauseWindows()) {
    for (let d = localParts(w.from, tz).dateKey; d <= localParts(w.until, tz).dateKey; d = addDays(d, 1)) days.add(d);
  }
  return days;
}

export interface TrendsReport {
  days: DayMetrics[];
  weeks: WeekMetrics[];
  findings: DriftFinding[];
  /** Levels over the month before the last two weeks: the comparison point. */
  reference: WindowSummary;
  /** Enough days in both windows to compare at all. */
  enough: boolean;
  /** Last day included (yesterday): today is still in progress. */
  lastDay: string;
  /** Days with data in the window. Findings need about six weeks. */
  daysWithData: number;
}

export function getTrends(now = Date.now(), settings: CheckinSettings = getSettings(), devices: RingDevice[] = listDevices()): TrendsReport {
  const tz = settings.timezone;
  const lastDay = addDays(localParts(now, tz).dateKey, -1);
  const skip = pausedDays(tz);
  const days = dailyMetrics(listEvents(now - (DRIFT_HISTORY_DAYS + 1) * DAY_MS, now + 1, 200_000), devices, {
    now,
    timezone: tz,
    days: DRIFT_HISTORY_DAYS,
    nightStartMinute: settings.nightStartMinute,
    nightEndMinute: settings.nightEndMinute,
    skip: (d) => skip.has(d),
  });
  const { reference, enough } = compareWindows(days, lastDay);
  return {
    days,
    weeks: weeklyMetrics(days, lastDay, 8),
    findings: detectDrift(days, lastDay, settings.residentName),
    reference,
    enough,
    lastDay,
    daysWithData: days.length,
  };
}

/** Days of doorbell history used to learn which visits are regular. */
export const VISIT_HISTORY_DAYS = 36;

/** Visits from `from` to `to`, classified with enough earlier history to spot regulars. */
export function getVisits(
  from: number,
  to: number,
  settings: CheckinSettings = getSettings(),
  devices: RingDevice[] = listDevices(),
): Visit[] {
  const events = listEvents(from - VISIT_HISTORY_DAYS * DAY_MS, to, 200_000);
  const expected = parseExpectedVisits(settings.expectedVisits).visits;
  return detectVisits(events, devices, { timezone: settings.timezone, expected }).filter((v) => v.start >= from && v.start < to);
}

/** Visits on one local day. */
export function getDayVisits(dateKey: string, settings: CheckinSettings = getSettings(), devices: RingDevice[] = listDevices()): Visit[] {
  const tz = settings.timezone;
  return getVisits(zonedToUtc(dateKey, 0, tz), zonedToUtc(addDays(dateKey, 1), 0, tz), settings, devices);
}
