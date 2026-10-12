import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventKind, RingEvent, RingWebhookPayload } from './types';

export const SIGNATURE_HEADER = 'x-ring-signature';

export function signPayload(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/** Constant-time check of an HMAC-SHA256 signature ("sha256=<hex>" or bare hex). */
export function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/i, '').toLowerCase();
  const expected = signPayload(rawBody, secret).slice('sha256='.length);
  if (!/^[0-9a-f]+$/.test(given) || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

const KIND_ALIASES: Record<string, EventKind> = {
  motion: 'motion',
  motion_detected: 'motion',
  person_detected: 'motion',
  ding: 'ding',
  doorbell_press: 'ding',
  button_press: 'ding',
  door_open: 'door_open',
  contact_open: 'door_open',
  opened: 'door_open',
  door_close: 'door_close',
  contact_close: 'door_close',
  closed: 'door_close',
};

export function normalizeKind(raw: string | undefined): EventKind | null {
  if (!raw) return null;
  return KIND_ALIASES[raw.toLowerCase().replace(/[\s.-]+/g, '_')] ?? null;
}

function parseTime(raw: string | number | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'number' || /^\d+$/.test(raw)) {
    const n = Number(raw);
    // Accept epoch seconds or milliseconds.
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? fallback : t;
}

/**
 * Normalizes a webhook body into events. Accepts a single notification or
 * `{ "events": [...] }`. Notifications with unknown types are dropped.
 */
export function parseWebhook(body: unknown, now = Date.now()): RingEvent[] {
  const items: RingWebhookPayload[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events)
      ? (body as { events: RingWebhookPayload[] }).events
      : body && typeof body === 'object'
        ? [body as RingWebhookPayload]
        : [];

  const events: RingEvent[] = [];
  for (const item of items) {
    const kind = normalizeKind(item.event_type ?? item.type);
    const deviceId = item.device_id ?? (item.doorbot_id != null ? String(item.doorbot_id) : undefined);
    if (!kind || !deviceId) continue;
    const occurredAt = parseTime(item.created_at ?? item.timestamp, now);
    events.push({
      id: String(item.event_id ?? item.id ?? `wh-${deviceId}-${kind}-${occurredAt}`),
      deviceId: String(deviceId),
      kind,
      occurredAt,
      payload: { source: 'webhook' },
    });
  }
  return events;
}
