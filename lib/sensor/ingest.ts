import { createHash, randomBytes } from 'node:crypto';
import { findDeviceBySensorKeyHash, getKv, insertEvents, MONITORING_SINCE_KV, recordHeartbeat, setKv } from '../db';
import type { RingDevice, RingEvent } from '../ring/types';

/**
 * Webcam sensors authenticate with a per-device key that is shown once as a
 * setup link. Only its SHA-256 hash is stored; a new link revokes the old one.
 */
export function newSensorKey(): string {
  return randomBytes(24).toString('base64url');
}

export function hashSensorKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface SensorReport {
  /** Motion timestamps (epoch ms), possibly queued while offline. */
  motion?: number[];
}

export type IngestResult =
  | { ok: true; device: RingDevice; inserted: RingEvent[] }
  | { ok: false; status: 400 | 401; error: string };

const MAX_EVENTS_PER_REPORT = 500;
/** Queued events older than this are dropped; they can't change today's picture. */
const MAX_AGE_MS = 24 * 60 * 60_000;
/** Allow for a sensor device whose clock runs a little fast. */
const MAX_FUTURE_MS = 2 * 60_000;

export function ingestSensorReport(authorization: string | null, body: unknown, now = Date.now()): IngestResult {
  const key = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (!key) return { ok: false, status: 401, error: 'missing sensor key' };
  const device = findDeviceBySensorKeyHash(hashSensorKey(key));
  if (!device) return { ok: false, status: 401, error: 'unknown or replaced sensor key' };

  const report = (body && typeof body === 'object' ? body : {}) as SensorReport;
  if (report.motion != null && !Array.isArray(report.motion)) {
    return { ok: false, status: 400, error: 'motion must be an array of timestamps' };
  }

  // Any authenticated report doubles as a heartbeat.
  recordHeartbeat(device.id, now);
  if (getKv<number>(MONITORING_SINCE_KV) == null) setKv(MONITORING_SINCE_KV, now);

  const events: RingEvent[] = [];
  for (const raw of (report.motion ?? []).slice(0, MAX_EVENTS_PER_REPORT)) {
    const t = Math.round(Number(raw));
    if (!Number.isFinite(t) || t < now - MAX_AGE_MS || t > now + MAX_FUTURE_MS) continue;
    const occurredAt = Math.min(t, now);
    events.push({
      // One event per device per second: retries of the same report don't duplicate.
      id: `cam-${device.id}-${Math.floor(occurredAt / 1000)}`,
      deviceId: device.id,
      kind: 'motion',
      occurredAt,
      payload: { source: 'webcam' },
    });
  }
  return { ok: true, device, inserted: insertEvents(events) };
}
