import type { RingDevice, RingEvent } from '../ring/types';
import { detectOutings } from './presence';
import { addDays, formatTime, localParts, weekdayOf, WEEKDAYS } from './time';

/**
 * Visitor awareness from doorbell events. A visit is a doorbell press (or Ring
 * flagging someone loitering) plus whatever happens around it: did a door open
 * soon after, and does it match a visit the family expects or one that recurs
 * every week? No faces or video: only times, so "unexpected" means "outside
 * any known pattern", not "a stranger".
 */

export interface ExpectedVisit {
  label: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekdays: number[];
  /** Minutes after midnight. */
  start: number;
  end: number;
}

export type VisitKind = 'expected' | 'regular' | 'dropoff' | 'unexpected';

export interface Visit {
  id: string;
  start: number;
  end: number;
  dateKey: string;
  minute: number;
  rang: boolean;
  /** Ring's own "someone is lingering at the door" detection. */
  loitering: boolean;
  /** A door opened within 10 minutes. Null when there's no door sensor to tell. */
  answered: boolean | null;
  kind: VisitKind;
  /** The expected visit it matched, e.g. "Home aide". */
  label: string | null;
}

const MINUTE = 60_000;
/** Doorbell events this close together are one visit. */
const VISIT_GAP_MS = 5 * MINUTE;
/** A door opening this soon after the doorbell means it was answered. */
const ANSWER_WINDOW_MS = 10 * MINUTE;
/** Rang briefly and nobody answered: a parcel or a flyer. */
const DROPOFF_MAX_MS = 3 * MINUTE;
/** Expected windows are matched with this much slack either side. */
const EXPECTED_SLACK_MIN = 30;

export const VISIT_KIND_LABEL: Record<VisitKind, string> = {
  expected: 'Expected',
  regular: 'Regular',
  dropoff: 'Rang, no answer (likely a delivery)',
  unexpected: 'Unexpected',
};

// --- expected visits, as the family types them -------------------------------------

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseDays(text: string): number[] | null {
  const t = text.toLowerCase();
  if (/\b(daily|every ?day)\b/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  const days = new Set<number>();
  if (/\bweekdays?\b/.test(t)) [1, 2, 3, 4, 5].forEach((d) => days.add(d));
  if (/\bweekends?\b/.test(t)) [0, 6].forEach((d) => days.add(d));
  for (const m of t.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:\s*-\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*)?/g)) {
    const a = DAY_NAMES.indexOf(m[1]);
    const b = m[2] ? DAY_NAMES.indexOf(m[2]) : a;
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  return days.size ? [...days].sort() : null;
}

function toMinute(h: string, m: string | undefined, ampm: string | undefined): number {
  let hour = Number(h) % 24;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return hour * 60 + Number(m ?? 0);
}

/** One visit per line: "Home aide: Tue Thu 9:30-11:00", "Meals on Wheels: weekdays 11:30am-12:30pm". */
export function parseExpectedVisits(text: string): { visits: ExpectedVisit[]; errors: string[] } {
  const visits: ExpectedVisit[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.+?):\s+(.+)$/.exec(line);
    const time = m && /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(m[2]);
    const days = m && parseDays(m[2].slice(0, time?.index ?? m[2].length));
    if (!m || !time || !days) {
      errors.push(line);
      continue;
    }
    const endAmPm = time[6]?.toLowerCase();
    const startAmPm = time[3]?.toLowerCase() ?? (endAmPm === 'pm' && Number(time[1]) <= Number(time[4]) ? 'pm' : endAmPm);
    visits.push({
      label: m[1].trim().slice(0, 40),
      weekdays: days,
      start: toMinute(time[1], time[2], startAmPm),
      end: toMinute(time[4], time[5], endAmPm),
    });
  }
  return { visits, errors };
}

export function describeExpected(v: ExpectedVisit): string {
  const days = v.weekdays.length === 7 ? 'Every day' : v.weekdays.map((d) => WEEKDAYS[d].slice(0, 3)).join(' ');
  const t = (min: number) => `${Math.floor(min / 60) % 12 || 12}${min % 60 ? `:${String(min % 60).padStart(2, '0')}` : ''}${min < 720 ? 'am' : 'pm'}`;
  return `${days}, ${t(v.start)}–${t(v.end)}`;
}

// --- visits --------------------------------------------------------------------------

/**
 * All visits in `events`, oldest first, each classified. Pass all events (indoor
 * motion tells a visitor apart from an outing) and 5+ weeks to learn regulars.
 */
export function detectVisits(
  events: RingEvent[],
  devices: RingDevice[],
  opts: { timezone: string; expected: ExpectedVisit[] },
): Visit[] {
  const tz = opts.timezone;
  const doorbells = new Set(devices.filter((d) => d.kind === 'doorbell').map((d) => d.id));
  const hasDoorSensor = devices.some((d) => d.kind === 'contact_sensor');
  const chrono = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  const atDoor = chrono.filter((e) => e.kind === 'ding' || (e.kind === 'motion' && doorbells.has(e.deviceId)));
  // A door opening that starts or ends an outing is the resident coming or going, not answering.
  const outings = detectOutings(chrono, devices, chrono[chrono.length - 1]?.occurredAt ?? 0);
  const comingOrGoing = new Set(outings.flatMap((o) => (o.returned == null ? [o.left] : [o.left, o.returned])));
  const opens = chrono.filter((e) => e.kind === 'door_open' && !comingOrGoing.has(e.occurredAt)).map((e) => e.occurredAt);

  // 1. Cluster doorbell activity; keep clusters where someone rang or lingered.
  const clusters: RingEvent[][] = [];
  for (const e of atDoor) {
    const last = clusters[clusters.length - 1];
    if (last && e.occurredAt - last[last.length - 1].occurredAt <= VISIT_GAP_MS) last.push(e);
    else clusters.push([e]);
  }

  const visits: Visit[] = [];
  for (const c of clusters) {
    const rang = c.some((e) => e.kind === 'ding');
    const loitering = c.some((e) => e.payload?.detection === 'loitering');
    if (!rang && !loitering) continue; // passers-by, and the resident's own comings and goings
    const first = c.find((e) => e.kind === 'ding') ?? c[0];
    const start = c[0].occurredAt;
    const end = c[c.length - 1].occurredAt;
    const p = localParts(first.occurredAt, tz);
    const answered = hasDoorSensor ? opens.some((t) => t >= start && t <= first.occurredAt + ANSWER_WINDOW_MS) : null;
    const exp = opts.expected.find(
      (x) =>
        x.weekdays.includes(weekdayOf(p.dateKey)) &&
        p.minuteOfDay >= x.start - EXPECTED_SLACK_MIN &&
        p.minuteOfDay <= x.end + EXPECTED_SLACK_MIN,
    );
    visits.push({
      id: first.id,
      start,
      end,
      dateKey: p.dateKey,
      minute: p.minuteOfDay,
      rang,
      loitering,
      answered,
      kind: exp ? 'expected' : rang && !loitering && answered !== true && end - start <= DROPOFF_MAX_MS ? 'dropoff' : 'unexpected',
      label: exp?.label ?? null,
    });
  }

  // 2. A visit at about the same time on the same weekday in 3 of the previous 4 weeks is regular.
  for (const v of visits) {
    if (v.kind !== 'unexpected' && v.kind !== 'dropoff') continue;
    let weeks = 0;
    for (let w = 1; w <= 4; w++) {
      const date = addDays(v.dateKey, -7 * w);
      if (visits.some((o) => o.dateKey === date && Math.abs(o.minute - v.minute) <= 60)) weeks++;
    }
    if (weeks >= 3) v.kind = 'regular';
  }
  return visits;
}

export interface VisitCounts {
  total: number;
  expected: number;
  regular: number;
  dropoff: number;
  unexpected: number;
  /** Unexpected visits where a door opened afterwards. */
  unexpectedAnswered: number;
}

export function countVisits(visits: Visit[]): VisitCounts {
  const c: VisitCounts = { total: visits.length, expected: 0, regular: 0, dropoff: 0, unexpected: 0, unexpectedAnswered: 0 };
  for (const v of visits) {
    c[v.kind]++;
    if (v.kind === 'unexpected' && v.answered) c.unexpectedAnswered++;
  }
  return c;
}

/**
 * Several unexpected callers in the past week, clearly more than usual. With a
 * door sensor, only visits the resident opened the door to count: that's the
 * moment a doorstep scam can start. Keyed per calendar week, so it's raised
 * at most once a week.
 */
export function detectVisitorPattern(
  visits: Visit[],
  opts: { now: number; timezone: string; name: string },
): { key: string; title: string; message: string; occurredAt: number } | null {
  const { now, timezone: tz, name } = opts;
  const weekAgo = now - 7 * 24 * 60 * MINUTE;
  const byDoor = visits.some((v) => v.answered != null);
  const counts = (v: Visit) => v.kind === 'unexpected' && (!byDoor || v.answered === true);

  const recent = visits.filter((v) => v.start > weekAgo && v.start <= now && counts(v));
  const before = visits.filter((v) => v.start > weekAgo - 28 * 24 * 60 * MINUTE && v.start <= weekAgo && counts(v));
  const usualPerWeek = before.length / 4;
  if (recent.length < 3 || recent.length < 2 * usualPerWeek + 1) return null;

  const latest = recent[recent.length - 1];
  const weekStart = addDays(latest.dateKey, -((weekdayOf(latest.dateKey) + 6) % 7)); // Monday
  const when = recent.map((v) => `${WEEKDAYS[weekdayOf(v.dateKey)].slice(0, 3)} ${formatTime(v.start, tz)}`).join(', ');
  const usual = usualPerWeek > 0 ? ` (usually about ${Math.round(usualPerWeek * 10) / 10} a week)` : '';
  return {
    key: weekStart,
    title: byDoor ? `${name} opened the door to ${recent.length} unexpected visitors this week` : `${recent.length} unexpected visitors at ${name}'s door this week`,
    message:
      `Unexpected callers came to the door ${recent.length} times in the past 7 days (${when}), more than usual${usual}. ` +
      `Repeated visits from people the family doesn't know are a common pattern in scams that target older adults, ` +
      `so it may be worth asking ${name} who came by.`,
    occurredAt: latest.start,
  };
}
