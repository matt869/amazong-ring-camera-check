import type { FamilyLogEntry, FamilyLogKind } from '../db';
import type { EventKind, RingDevice, RingEvent } from './types';
import { addDays, localParts, weekdayOf, zonedToUtc } from '../routine/time';

/**
 * Demo data: a plausible household and a deterministic daily routine, so the
 * app runs end to end with no Ring account. The same day always generates the
 * same events, which makes re-seeding idempotent.
 */

export type DemoScenario =
  | 'normal'
  | 'late-start'
  | 'quiet-morning'
  | 'night-door'
  | 'inactive-afternoon'
  | 'long-outing'
  | 'gradual-decline'
  | 'repeat-visitor';

export const DEMO_SCENARIOS: Record<DemoScenario, string> = {
  normal: 'An ordinary day',
  'late-start': 'Sleeps in, gets up 10 minutes from now (alert, then all-clear)',
  'quiet-morning': 'No activity at all today (missed wake-up)',
  'night-door': 'Back door opened at 2:40am',
  'inactive-afternoon': 'Activity stops just after 11am',
  'long-outing': 'Goes out at 1pm and doesn’t come back',
  'gradual-decline': 'Over six weeks: up later, out less, quieter days (routine drift)',
  'repeat-visitor': 'Someone unexpected keeps calling in the late afternoon (visitor alert)',
};

/** Scenarios that reshape past weeks too, not just today. */
export const HISTORY_SCENARIOS: DemoScenario[] = ['gradual-decline', 'repeat-visitor'];

/** Days of simulated history: enough for routine drift (two weeks against the month before). */
export const DEMO_DAYS = 63;

export const MOCK_DEVICES: RingDevice[] = [
  { id: 'front-door', name: 'Front Door', kind: 'doorbell', location: 'Front door', battery: 78, online: true, lastSeen: null, countsAsActivity: false },
  { id: 'kitchen-motion', name: 'Kitchen Motion', kind: 'motion_sensor', location: 'Kitchen', battery: 64, online: true, lastSeen: null, countsAsActivity: true },
  { id: 'living-cam', name: 'Living Room Cam', kind: 'camera', location: 'Living room', battery: null, online: true, lastSeen: null, countsAsActivity: true },
  { id: 'bedroom-motion', name: 'Bedroom Motion', kind: 'motion_sensor', location: 'Bedroom', battery: 17, online: true, lastSeen: null, countsAsActivity: true },
  { id: 'back-door', name: 'Back Door', kind: 'contact_sensor', location: 'Back door', battery: 90, online: true, lastSeen: null, countsAsActivity: true },
  { id: 'front-door-contact', name: 'Front Door Sensor', kind: 'contact_sensor', location: 'Front door', battery: 85, online: true, lastSeen: null, countsAsActivity: true },
];

/** mulberry32: small seeded PRNG so each day's routine is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(dateKey: string): number {
  let h = 2166136261;
  for (const c of dateKey) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h;
}

interface Planned {
  minute: number;
  deviceId: string;
  kind: EventKind;
}

/**
 * One day of the resident's routine, as minute-of-day offsets. `decline`
 * (0-1) shifts it toward a slower routine: later mornings, fewer outings,
 * less movement, more restless nights.
 */
function planDay(dateKey: string, decline = 0): Planned[] {
  const r = rng(seedFor(dateKey));
  const jitter = (spread: number) => Math.round((r() - 0.5) * 2 * spread);
  const plan: Planned[] = [];
  const burst = (deviceId: string, start: number, end: number, count: number) => {
    for (let i = 0; i < count; i++) {
      plan.push({ minute: Math.round(start + r() * (end - start)), deviceId, kind: 'motion' });
    }
  };

  const wake = 7 * 60 + jitter(25) + Math.round(80 * decline);
  burst('bedroom-motion', wake, wake + 15, 3);
  burst('kitchen-motion', wake + 15, wake + 70, 6 + Math.floor(r() * 4));
  burst('living-cam', wake + 60, 11 * 60 + 30, 5 + Math.floor(r() * 4));
  burst('kitchen-motion', 12 * 60 + jitter(20), 13 * 60 + 10, 4 + Math.floor(r() * 3));

  // Afternoon errand or walk on most days.
  if (r() < 0.7 - 0.6 * decline) {
    const out = 14 * 60 + jitter(45);
    const back = out + 40 + Math.floor(r() * 50);
    plan.push({ minute: out - 1, deviceId: 'front-door', kind: 'motion' });
    plan.push({ minute: out, deviceId: 'back-door', kind: 'door_open' });
    plan.push({ minute: out + 1, deviceId: 'back-door', kind: 'door_close' });
    plan.push({ minute: back, deviceId: 'back-door', kind: 'door_open' });
    plan.push({ minute: back + 1, deviceId: 'back-door', kind: 'door_close' });
    burst('living-cam', back + 5, 17 * 60, 4);
  } else {
    burst('living-cam', 13 * 60 + 30, 17 * 60, 7);
  }

  // Deliveries: ring, leave the parcel, gone.
  if (r() < 0.35) {
    const at = 10 * 60 + Math.floor(r() * 6 * 60);
    plan.push({ minute: at - 1, deviceId: 'front-door', kind: 'motion' });
    plan.push({ minute: at, deviceId: 'front-door', kind: 'ding' });
  }

  burst('kitchen-motion', 17 * 60 + 30 + jitter(20), 18 * 60 + 40, 5 + Math.floor(r() * 3));
  burst('living-cam', 18 * 60 + 45, 21 * 60 + 30 + jitter(20), 6 + Math.floor(r() * 4));
  const bed = 22 * 60 + jitter(25);
  burst('bedroom-motion', bed - 10, bed + 5, 2);

  // The occasional night-time bathroom trip.
  if (r() < 0.4 + 0.5 * decline) plan.push({ minute: 2 * 60 + Math.floor(r() * 120), deviceId: 'bedroom-motion', kind: 'motion' });

  // A home aide comes Tuesday and Thursday mornings. Separate random stream, so
  // the rest of the day is unchanged.
  if (weekdayOf(dateKey) === 2 || weekdayOf(dateKey) === 4) {
    const ra = rng(seedFor(`${dateKey}aide`));
    const t = 10 * 60 + Math.round((ra() - 0.5) * 20);
    plan.push(
      { minute: t - 1, deviceId: 'front-door', kind: 'motion' },
      { minute: t, deviceId: 'front-door', kind: 'ding' },
      { minute: t + 1, deviceId: 'front-door-contact', kind: 'door_open' },
      { minute: t + 2, deviceId: 'front-door-contact', kind: 'door_close' },
      { minute: t + 15, deviceId: 'living-cam', kind: 'motion' },
      { minute: t + 40, deviceId: 'kitchen-motion', kind: 'motion' },
      { minute: t + 58, deviceId: 'front-door-contact', kind: 'door_open' },
      { minute: t + 59, deviceId: 'front-door-contact', kind: 'door_close' },
    );
  }

  // A slower routine also means less movement once the day is under way.
  if (decline > 0) {
    const rd = rng(seedFor(`${dateKey}decline`));
    return plan.filter((p) => p.kind !== 'motion' || p.minute < wake + 30 || rd() >= 0.55 * decline);
  }
  return plan;
}

/** An unexpected caller in the late afternoon who gets let in for a while. */
function strangerVisit(dateKey: string): Planned[] {
  const rv = rng(seedFor(`${dateKey}visitor`));
  const t = 16 * 60 + 20 + Math.floor(rv() * 30);
  return [
    { minute: t - 1, deviceId: 'front-door', kind: 'motion' },
    { minute: t, deviceId: 'front-door', kind: 'ding' },
    { minute: t + 1, deviceId: 'front-door', kind: 'ding' },
    { minute: t + 2, deviceId: 'front-door-contact', kind: 'door_open' },
    { minute: t + 9, deviceId: 'front-door-contact', kind: 'door_close' },
    { minute: t + 10, deviceId: 'front-door', kind: 'motion' },
  ];
}

/** `wakeMinute`: for 'late-start', the local minute they finally get up. */
function applyScenario(plan: Planned[], scenario: DemoScenario, wakeMinute: number): Planned[] {
  switch (scenario) {
    case 'late-start':
      return [
        ...plan.filter((p) => p.minute < 4 * 60 || p.minute > wakeMinute + 5),
        { minute: wakeMinute, deviceId: 'bedroom-motion', kind: 'motion' },
        { minute: wakeMinute + 3, deviceId: 'kitchen-motion', kind: 'motion' },
      ];
    case 'long-outing':
      return [
        ...plan.filter((p) => p.minute < 13 * 60 - 5),
        { minute: 13 * 60 - 2, deviceId: 'living-cam', kind: 'motion' },
        { minute: 13 * 60, deviceId: 'back-door', kind: 'door_open' },
        { minute: 13 * 60 + 1, deviceId: 'back-door', kind: 'door_close' },
      ];
    case 'quiet-morning':
      return [];
    case 'inactive-afternoon':
      return plan.filter((p) => p.minute < 11 * 60 + 10);
    case 'night-door':
      return [
        ...plan,
        { minute: 2 * 60 + 39, deviceId: 'bedroom-motion', kind: 'motion' },
        { minute: 2 * 60 + 40, deviceId: 'back-door', kind: 'door_open' },
        { minute: 2 * 60 + 52, deviceId: 'back-door', kind: 'door_close' },
      ];
    default:
      return plan;
  }
}

/** The stranger's visits in the 'repeat-visitor' scenario, as days before today. */
const STRANGER_DAYS = [0, 1, 2, 4, 6];

/**
 * Events for `days` past days plus today up to `now`. Most scenarios only
 * change today, with a normal routine to learn from; 'gradual-decline' and
 * 'repeat-visitor' reshape the past weeks too.
 */
export function generateDemoEvents(opts: {
  now: number;
  timezone: string;
  days: number;
  scenario?: DemoScenario;
  /** When the scenario was applied; 'late-start' wakes 10 minutes after it. */
  anchor?: number;
}): RingEvent[] {
  const scenario = opts.scenario ?? 'normal';
  const today = localParts(opts.now, opts.timezone).dateKey;
  const events: RingEvent[] = [];
  for (let offset = opts.days; offset >= 0; offset--) {
    const dateKey = addDays(today, -offset);
    // The decline starts six weeks ago and deepens steadily up to today.
    const decline = scenario === 'gradual-decline' ? Math.max(0, Math.min(1, (42 - offset) / 42)) : 0;
    let plan = planDay(dateKey, decline);
    if (scenario === 'repeat-visitor' && STRANGER_DAYS.includes(offset)) plan.push(...strangerVisit(dateKey));
    if (offset === 0) {
      const wake = localParts((opts.anchor ?? opts.now) + 10 * 60_000, opts.timezone);
      // If the anchor was on an earlier day, they're simply up at the normal time.
      const wakeMinute = wake.dateKey === dateKey ? wake.minuteOfDay : 7 * 60;
      plan = applyScenario(plan, scenario, wakeMinute);
    }
    plan.sort((a, b) => a.minute - b.minute);
    plan.forEach((p, i) => {
      const occurredAt = zonedToUtc(dateKey, p.minute, opts.timezone) + (Math.abs(seedFor(`${dateKey}${i}`)) % 60) * 1000;
      if (occurredAt > opts.now) return;
      events.push({
        id: `demo-${dateKey}-${i}`,
        deviceId: p.deviceId,
        kind: p.kind,
        occurredAt,
        payload: { source: 'demo' },
      });
    });
  }
  return events;
}

/**
 * Who in the demo family checked on her: Sarah calls most evenings she can,
 * David texts and visits on some weekends. Deterministic per day.
 */
export function generateDemoFamilyLog(opts: { now: number; timezone: string; days: number }): FamilyLogEntry[] {
  const today = localParts(opts.now, opts.timezone).dateKey;
  const out: FamilyLogEntry[] = [];
  const add = (dateKey: string, minute: number, who: string, kind: FamilyLogKind, note: string | null) => {
    const at = zonedToUtc(dateKey, minute, opts.timezone);
    if (at <= opts.now) out.push({ id: `demo-log-${dateKey}-${who}-${kind}`, at, who, kind, note });
  };
  for (let offset = opts.days; offset >= 0; offset--) {
    const dateKey = addDays(today, -offset);
    const r = rng(seedFor(`${dateKey}family`));
    const wd = weekdayOf(dateKey);
    if ((wd === 0 || wd === 2 || wd === 4) && r() < 0.85) add(dateKey, 18 * 60 + 30 + Math.floor(r() * 60), 'Sarah', 'call', null);
    if ((wd === 1 || wd === 3 || wd === 5) && r() < 0.6) add(dateKey, 12 * 60 + Math.floor(r() * 120), 'David', 'message', null);
    if (wd === 6 && r() < 0.5) add(dateKey, 15 * 60, 'David', 'visit', 'Brought groceries');
  }
  return out;
}
