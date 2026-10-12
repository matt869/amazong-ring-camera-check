export type DeviceKind = 'doorbell' | 'camera' | 'motion_sensor' | 'contact_sensor' | 'webcam';

export type EventKind = 'motion' | 'ding' | 'door_open' | 'door_close';

export interface RingDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  /** Room or area, e.g. "Kitchen" or "Front door". */
  location: string;
  /** 0-100, or null for wired devices. */
  battery: number | null;
  online: boolean;
  lastSeen: number | null;
  /**
   * Whether motion on this device means the resident is up and about.
   * Off by default for doorbells, which mostly see visitors and passers-by.
   */
  countsAsActivity: boolean;
  /** Webcam sensors: last time the sensor page checked in (motion or not). */
  heartbeatAt?: number | null;
}

export function defaultCountsAsActivity(kind: DeviceKind): boolean {
  return kind !== 'doorbell';
}

export interface RingEvent {
  id: string;
  deviceId: string;
  kind: EventKind;
  /** Epoch milliseconds. */
  occurredAt: number;
  payload?: Record<string, unknown>;
}

export interface RingTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Shape of a webhook notification as delivered by Ring. */
export interface RingWebhookPayload {
  event_id?: string;
  id?: string;
  event_type?: string;
  type?: string;
  device_id?: string;
  doorbot_id?: string | number;
  created_at?: string | number;
  timestamp?: string | number;
  [key: string]: unknown;
}
