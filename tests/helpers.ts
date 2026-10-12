import { generateDemoEvents, MOCK_DEVICES } from '../lib/ring/mock';
import type { EventKind, RingEvent } from '../lib/ring/types';
import { DEFAULT_SETTINGS, type CheckinSettings } from '../lib/routine/rules';
import { localParts, zonedToUtc } from '../lib/routine/time';

export const TZ = 'America/New_York';
export const TODAY = '2026-03-18';
export const settings: CheckinSettings = { ...DEFAULT_SETTINGS, timezone: TZ, residentName: 'Ana' };

/** Epoch ms for a local wall-clock time, "HH:MM", on TODAY (or `dateKey`). */
export const at = (hhmm: string, dateKey = TODAY) => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedToUtc(dateKey, h * 60 + m, TZ);
};

export const devices = MOCK_DEVICES.map((d) => ({ ...d, lastSeen: at('06:00') }));

export const ev = (id: string, kind: EventKind, deviceId: string, ts: number): RingEvent => ({
  id,
  deviceId,
  kind,
  occurredAt: ts,
});
export const motion = (id: string, ts: number, deviceId = 'kitchen-motion') => ev(id, 'motion', deviceId, ts);

/** 14 days of the demo routine before TODAY, nothing on TODAY itself. */
export function history(now: number): RingEvent[] {
  return generateDemoEvents({ now, timezone: TZ, days: 14 }).filter(
    (e) => localParts(e.occurredAt, TZ).dateKey !== TODAY,
  );
}
