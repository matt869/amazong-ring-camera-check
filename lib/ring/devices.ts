import { listDevices, upsertDevices } from '../db';
import { ringRequest } from './client';
import { MOCK_DEVICES } from './mock';
import { isMockMode } from './oauth';
import { defaultCountsAsActivity, type DeviceKind, type RingDevice } from './types';

/** Device as returned by Ring's devices endpoint (fields we use). */
interface RingApiDevice {
  id: number | string;
  description?: string;
  kind?: string;
  battery_life?: number | string | null;
  alerts?: { connection?: string };
  location_name?: string;
}

interface RingDevicesResponse {
  doorbots?: RingApiDevice[];
  authorized_doorbots?: RingApiDevice[];
  stickup_cams?: RingApiDevice[];
  other?: RingApiDevice[];
}

function kindFor(group: keyof RingDevicesResponse, raw: RingApiDevice): DeviceKind {
  if (group === 'doorbots' || group === 'authorized_doorbots') return 'doorbell';
  if (group === 'stickup_cams') return 'camera';
  const k = (raw.kind ?? '').toLowerCase();
  if (k.includes('contact') || k.includes('door') || k.includes('window')) return 'contact_sensor';
  return 'motion_sensor';
}

export function toRingDevice(group: keyof RingDevicesResponse, raw: RingApiDevice): RingDevice {
  const battery = raw.battery_life == null || raw.battery_life === '' ? null : Number(raw.battery_life);
  const kind = kindFor(group, raw);
  return {
    id: String(raw.id),
    name: raw.description || `Ring device ${raw.id}`,
    kind,
    countsAsActivity: defaultCountsAsActivity(kind),
    location: raw.location_name || raw.description || 'Home',
    battery: Number.isFinite(battery) ? battery : null,
    online: raw.alerts?.connection ? raw.alerts.connection === 'online' : true,
    lastSeen: null,
  };
}

export async function fetchDevices(): Promise<RingDevice[]> {
  if (isMockMode()) return MOCK_DEVICES.map((d) => ({ ...d }));
  const body = await ringRequest<RingDevicesResponse>('/clients_api/ring_devices');
  const groups: (keyof RingDevicesResponse)[] = ['doorbots', 'authorized_doorbots', 'stickup_cams', 'other'];
  return groups.flatMap((g) => (body[g] ?? []).map((raw) => toRingDevice(g, raw)));
}

/** Pulls the device list from Ring into the local database. */
export async function syncDevices(): Promise<RingDevice[]> {
  upsertDevices(await fetchDevices());
  return listDevices();
}
