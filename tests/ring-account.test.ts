import { describe, expect, it } from 'vitest';
import type { PushNotificationDingV2 } from 'ring-client-api';
import { eventFromNotification, eventFromSensorChange } from '../lib/ring/account';

const push = (category: string, ding?: { id: string; created_at: string; subtype: string; detection_type?: string }) =>
  ({
    version: '2.0.0',
    android_config: { category, body: '' },
    analytics: { triggered_at: 1_773_838_800_000 },
    data: { event: { ding } },
  }) as unknown as PushNotificationDingV2;

describe('eventFromNotification', () => {
  it('maps doorbell presses and motion, using the ding id and time', () => {
    const ding = push('com.ring.pn.live-event.ding', { id: '7311', created_at: '2026-03-18T13:05:00Z', subtype: 'ding' });
    expect(eventFromNotification(42, ding)).toEqual({
      id: 'ring-7311',
      deviceId: '42',
      kind: 'ding',
      occurredAt: Date.UTC(2026, 2, 18, 13, 5),
      payload: { source: 'ring-push', subtype: 'ding', detection: null },
    });
    const motion = push('com.ring.pn.live-event.motion', { id: '7312', created_at: '2026-03-18T13:06:00Z', subtype: 'human' });
    expect(eventFromNotification(42, motion)?.kind).toBe('motion');
  });

  it("keeps Ring's own detection type, which flags someone loitering at the door", () => {
    const n = push('com.ring.pn.live-event.motion', { id: '7313', created_at: '2026-03-18T13:07:00Z', subtype: 'human', detection_type: 'loitering' });
    expect(eventFromNotification(42, n)?.payload?.detection).toBe('loitering');
  });

  it('falls back to the trigger time and ignores other notification types', () => {
    expect(eventFromNotification(42, push('com.ring.pn.live-event.motion'))?.occurredAt).toBe(1_773_838_800_000);
    expect(eventFromNotification(42, push('com.ring.push.HANDLE_NEW_USER_SOUND_SIREN'))).toBeNull();
    expect(eventFromNotification(42, push('com.ring.pn.live-event.intercom'))).toBeNull();
  });
});

describe('eventFromSensorChange', () => {
  it('turns contact sensor faults into door open/close', () => {
    expect(eventFromSensorChange('z1', 'contact_sensor', false, true, 1000)?.kind).toBe('door_open');
    expect(eventFromSensorChange('z1', 'contact_sensor', true, false, 2000)?.kind).toBe('door_close');
  });

  it('turns motion sensor faults into motion, once per trigger', () => {
    expect(eventFromSensorChange('z2', 'motion_sensor', false, true, 1000)?.kind).toBe('motion');
    expect(eventFromSensorChange('z2', 'motion_sensor', true, false, 2000)).toBeNull();
  });

  it('ignores updates that do not change the state (battery reports etc.)', () => {
    expect(eventFromSensorChange('z1', 'contact_sensor', true, true)).toBeNull();
    expect(eventFromSensorChange('z1', 'contact_sensor', false, undefined)).toBeNull();
  });
});
