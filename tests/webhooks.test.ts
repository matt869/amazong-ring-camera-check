import { describe, expect, it } from 'vitest';
import { normalizeKind, parseWebhook, signPayload, verifySignature } from '../lib/ring/webhooks';

const SECRET = 'test-secret';

describe('verifySignature', () => {
  const body = JSON.stringify({ event_type: 'motion', device_id: 'kitchen-motion' });

  it('accepts a valid signature with or without the sha256= prefix', () => {
    const sig = signPayload(body, SECRET);
    expect(verifySignature(body, sig, SECRET)).toBe(true);
    expect(verifySignature(body, sig.replace('sha256=', ''), SECRET)).toBe(true);
    expect(verifySignature(body, sig.toUpperCase().replace('SHA256=', 'sha256='), SECRET)).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets and malformed headers', () => {
    const sig = signPayload(body, SECRET);
    expect(verifySignature(body + ' ', sig, SECRET)).toBe(false);
    expect(verifySignature(body, sig, 'other-secret')).toBe(false);
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, 'sha256=xyz', SECRET)).toBe(false);
    expect(verifySignature(body, 'sha256=abcd', SECRET)).toBe(false);
  });
});

describe('normalizeKind', () => {
  it('maps Ring event names onto internal kinds', () => {
    expect(normalizeKind('motion')).toBe('motion');
    expect(normalizeKind('Motion Detected')).toBe('motion');
    expect(normalizeKind('ding')).toBe('ding');
    expect(normalizeKind('contact.open')).toBe('door_open');
    expect(normalizeKind('contact_close')).toBe('door_close');
    expect(normalizeKind('battery_low')).toBeNull();
    expect(normalizeKind(undefined)).toBeNull();
  });
});

describe('parseWebhook', () => {
  const now = Date.UTC(2026, 2, 18, 12);

  it('parses a single notification with an ISO timestamp', () => {
    const [e] = parseWebhook(
      { event_id: 'evt_1', event_type: 'ding', doorbot_id: 12345, created_at: '2026-03-18T13:05:00Z' },
      now,
    );
    expect(e).toEqual({
      id: 'evt_1',
      deviceId: '12345',
      kind: 'ding',
      occurredAt: Date.UTC(2026, 2, 18, 13, 5),
      payload: { source: 'webhook' },
    });
  });

  it('parses batches and epoch-second timestamps, dropping unknown events', () => {
    const events = parseWebhook(
      {
        events: [
          { id: 'a', type: 'motion', device_id: 'kitchen-motion', timestamp: 1773838800 },
          { id: 'b', type: 'battery_low', device_id: 'kitchen-motion' },
          { id: 'c', type: 'door_open' },
          { id: 'd', type: 'contact_open', device_id: 'back-door', timestamp: 1773838800123 },
        ],
      },
      now,
    );
    expect(events.map((e) => e.id)).toEqual(['a', 'd']);
    expect(events[0].occurredAt).toBe(1773838800000);
    expect(events[1].occurredAt).toBe(1773838800123);
    expect(events[1].kind).toBe('door_open');
  });

  it('falls back to receipt time and a derived id', () => {
    const [e] = parseWebhook({ type: 'motion', device_id: 'living-cam' }, now);
    expect(e.occurredAt).toBe(now);
    expect(e.id).toBe(`wh-living-cam-motion-${now}`);
  });

  it('returns nothing for non-object bodies', () => {
    expect(parseWebhook('nope', now)).toEqual([]);
    expect(parseWebhook(null, now)).toEqual([]);
  });
});
