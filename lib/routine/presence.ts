import type { RingDevice, RingEvent } from '../ring/types';
import { activityFilter } from './baseline';

/** The house has to stay quiet this long after a door opens before we call it an outing. */
export const MIN_OUTING_MS = 20 * 60_000;

export interface Outing {
  left: number;
  leftEventId: string;
  /** When a door opened again with no indoor motion in between; null while still out. */
  returned: number | null;
}

export interface Presence {
  state: 'home' | 'away' | 'unknown';
  /** Away: when they left. Home: last movement. */
  since: number | null;
  /** Most recent event that counts as their activity. */
  lastActivity: RingEvent | null;
  /** The departure behind an 'away' state. */
  outing: Outing | null;
}

/**
 * Outings: a door opens, then the house goes quiet until a door opens again
 * (back home). Indoor motion in between means they never left.
 */
export function detectOutings(events: RingEvent[], devices: RingDevice[], now: number): Outing[] {
  const counts = activityFilter(devices);
  const contact = new Set(devices.filter((d) => d.kind === 'contact_sensor').map((d) => d.id));
  const isIndoorMotion = (e: RingEvent) => e.kind === 'motion' && counts(e) && !contact.has(e.deviceId);

  const chrono = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  const opens = chrono.filter((e) => e.kind === 'door_open' && e.occurredAt <= now);
  const outings: Outing[] = [];

  for (let i = 0; i < opens.length; i++) {
    const left = opens[i].occurredAt;
    const next = opens[i + 1]?.occurredAt ?? null;
    const end = next ?? now;
    if (end - left < MIN_OUTING_MS) continue;
    // Motion in the first couple of minutes is them on the way out.
    const indoor = chrono.some((e) => e.occurredAt > left + 2 * 60_000 && e.occurredAt < end && isIndoorMotion(e));
    if (indoor) continue;
    outings.push({ left, leftEventId: opens[i].id, returned: next });
    if (next != null) i++; // the door opening on return isn't a new departure
  }
  return outings;
}

export function inferPresence(events: RingEvent[], devices: RingDevice[], now: number): Presence {
  const counts = activityFilter(devices);
  const activity = events.filter((e) => counts(e) && e.occurredAt <= now).sort((a, b) => a.occurredAt - b.occurredAt);
  const lastActivity = activity[activity.length - 1] ?? null;

  const outings = detectOutings(events, devices, now);
  const latest = outings[outings.length - 1];
  if (latest && latest.returned == null) {
    return { state: 'away', since: latest.left, lastActivity, outing: latest };
  }
  if (lastActivity) return { state: 'home', since: lastActivity.occurredAt, lastActivity, outing: null };
  return { state: 'unknown', since: null, lastActivity: null, outing: null };
}
