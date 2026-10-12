import type { Location, PushNotificationDingV2, RingApi, RingCamera, RingDevice as RingAlarmDevice } from 'ring-client-api';
import { deleteKv, getKv, insertEvents, listDevices, setKv, upsertDevices } from '../db';
import { usesRingAccount } from './oauth';
import { defaultCountsAsActivity, type DeviceKind, type EventKind, type RingDevice, type RingEvent } from './types';

/**
 * Live connection to a Ring account through the community `ring-client-api`
 * package, signed in once with `npm run ring:login`.
 *
 * Read-only by design: this module never arms, disarms, sounds sirens, or
 * changes settings, even though the library can.
 *
 * Event sources:
 *   - doorbell presses and camera motion: Ring push notifications
 *   - Ring Alarm contact and motion sensors: the location's live websocket
 *   - camera history: backfilled on start and every 15 minutes (catches gaps)
 */

const TOKEN_KV = 'ring_refresh_token';
const HISTORY_EVERY_MS = 15 * 60_000;
const RETRY_MS = 5 * 60_000;

const isRingAccountMode = usesRingAccount;

/**
 * Ring rotates the token (it also carries the push registration), so the
 * newest one lives in the database. A fresh `ring:login` writes a new env
 * token and clears the stored one, so a newer login always wins.
 */
function currentRefreshToken(): string | undefined {
  return getKv<string>(TOKEN_KV) ?? process.env.RING_REFRESH_TOKEN;
}

export function forgetStoredRefreshToken(): void {
  deleteKv(TOKEN_KV);
}

export interface RingAccountStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  since: number | null;
  error: string | null;
  cameras: number;
  sensors: number;
  lastEventAt: number | null;
}

type OnEvents = (events: RingEvent[]) => Promise<void> | void;

const g = globalThis as unknown as {
  __ringAccount?: { api: RingApi; status: RingAccountStatus; timers: NodeJS.Timeout[]; cameras: RingCamera[] };
  __ringAccountStarting?: Promise<void>;
  /** Kept on globalThis: Next loads separate module copies for routes and instrumentation. */
  __ringAccountFailure?: RingAccountStatus | null;
};

export function getRingAccountStatus(): RingAccountStatus {
  if (g.__ringAccount) return g.__ringAccount.status;
  if (g.__ringAccountFailure) return g.__ringAccountFailure;
  const state = isRingAccountMode() ? 'connecting' : 'off';
  return { state, since: null, error: null, cameras: 0, sensors: 0, lastEventAt: null };
}

// --- mapping ------------------------------------------------------------------

function cameraDevice(camera: RingCamera, location: Location): RingDevice {
  const kind: DeviceKind = camera.isDoorbot ? 'doorbell' : 'camera';
  return {
    id: String(camera.id),
    name: camera.name,
    kind,
    location: camera.name || location.name,
    battery: camera.hasBattery ? camera.batteryLevel : null,
    online: !camera.isOffline,
    lastSeen: null,
    countsAsActivity: defaultCountsAsActivity(kind),
  };
}

const SENSOR_KINDS: Record<string, DeviceKind> = {
  'sensor.contact': 'contact_sensor',
  'sensor.motion': 'motion_sensor',
  'motion-sensor.beams': 'motion_sensor',
};

function sensorDevice(device: RingAlarmDevice): RingDevice | null {
  const kind = SENSOR_KINDS[device.deviceType];
  if (!kind) return null;
  const data = device.data;
  return {
    id: device.zid,
    name: data.name,
    kind,
    location: data.name,
    battery: typeof data.batteryLevel === 'number' ? data.batteryLevel : null,
    // Sensors don't expose a connection flag here; offline shows up as silence.
    online: true,
    lastSeen: null,
    countsAsActivity: defaultCountsAsActivity(kind),
  };
}

/** Push notification -> event. Only doorbell presses and motion matter here. */
export function eventFromNotification(cameraId: number, n: PushNotificationDingV2, now = Date.now()): RingEvent | null {
  const category = n.android_config?.category ?? '';
  const kind: EventKind | null = category.endsWith('.ding') ? 'ding' : category.endsWith('.motion') ? 'motion' : null;
  if (!kind) return null;
  const ding = n.data?.event?.ding;
  const parsed = ding?.created_at ? Date.parse(ding.created_at) : NaN;
  const occurredAt = Number.isFinite(parsed) ? parsed : (n.analytics?.triggered_at ?? now);
  return {
    id: ding?.id ? `ring-${ding.id}` : `ring-${cameraId}-${kind}-${occurredAt}`,
    deviceId: String(cameraId),
    kind,
    occurredAt,
    // `detection` is Ring's own classification; "loitering" feeds visitor awareness.
    payload: { source: 'ring-push', subtype: ding?.subtype ?? null, detection: ding?.detection_type ?? null },
  };
}

/**
 * Sensor state change -> event. Contact sensors are "faulted" while open;
 * motion sensors are "faulted" while they see motion.
 */
export function eventFromSensorChange(
  zid: string,
  kind: DeviceKind,
  wasFaulted: boolean | undefined,
  isFaulted: boolean | undefined,
  now = Date.now(),
): RingEvent | null {
  if (isFaulted == null || wasFaulted === isFaulted) return null;
  let eventKind: EventKind | null = null;
  if (kind === 'contact_sensor') eventKind = isFaulted ? 'door_open' : 'door_close';
  else if (kind === 'motion_sensor' && isFaulted) eventKind = 'motion';
  if (!eventKind) return null;
  return { id: `ring-${zid}-${eventKind}-${now}`, deviceId: zid, kind: eventKind, occurredAt: now, payload: { source: 'ring-alarm' } };
}

/**
 * Camera Event History. The periodic backstop reads one page per camera; on
 * first connect it pages back `sinceMs` so the routine can be learned from
 * Ring's history right away, instead of after three days of live events.
 */
async function backfillCameraHistory(cameras: RingCamera[], opts: { sinceMs?: number; maxPages?: number } = {}): Promise<RingEvent[]> {
  const events: RingEvent[] = [];
  for (const camera of cameras) {
    try {
      let paginationKey: string | undefined;
      for (let page = 0; page < (opts.maxPages ?? 1); page++) {
        const res = await camera.getEvents({ limit: 50, ...(paginationKey ? { pagination_key: paginationKey } : {}) });
        let oldest = Infinity;
        for (const e of res.events) {
          const occurredAt = Date.parse(e.created_at);
          if (!Number.isFinite(occurredAt)) continue;
          oldest = Math.min(oldest, occurredAt);
          if (e.kind !== 'motion' && e.kind !== 'ding') continue;
          events.push({
            id: `ring-${e.ding_id_str}`,
            deviceId: String(camera.id),
            kind: e.kind,
            occurredAt,
            payload: { source: 'ring-history', detection: e.cv_properties?.detection_type ?? null },
          });
        }
        paginationKey = res.meta?.pagination_key;
        if (!paginationKey || res.events.length === 0 || oldest < (opts.sinceMs ?? Infinity)) break;
      }
    } catch (err) {
      console.warn(`[ring] history unavailable for ${camera.name}:`, (err as Error).message);
    }
  }
  return events;
}

/** On first connect, how far back to read Event History (the routine baseline window). */
const INITIAL_HISTORY_MS = 14 * 24 * 60 * 60_000;

/**
 * One still picture from the doorbell, for context when an alert goes out.
 * Only called once the resident has agreed to it on their own page. Doorbells
 * only: they face outward, so this never shows the inside of the home.
 */
export async function doorbellSnapshot(): Promise<{ deviceId: string; image: Buffer } | null> {
  const doorbell = g.__ringAccount?.cameras.find((c) => c.isDoorbot);
  if (!doorbell) return null;
  return { deviceId: String(doorbell.id), image: await doorbell.getSnapshot() };
}

// --- lifecycle ------------------------------------------------------------------

/**
 * Connects and starts streaming events into the database; `onEvents` runs
 * after each batch (the app re-evaluates alerts there). Retries on failure.
 */
export async function startRingAccount(onEvents: OnEvents): Promise<void> {
  if (!isRingAccountMode() || g.__ringAccount) return;
  g.__ringAccountStarting ??= connect(onEvents).finally(() => {
    g.__ringAccountStarting = undefined;
  });
  return g.__ringAccountStarting;
}

async function connect(onEvents: OnEvents): Promise<void> {
  const refreshToken = currentRefreshToken();
  if (!refreshToken) return;
  const status: RingAccountStatus = { state: 'connecting', since: Date.now(), error: null, cameras: 0, sensors: 0, lastEventAt: null };

  const deliver = async (events: RingEvent[]) => {
    const fresh = insertEvents(events);
    if (fresh.length === 0) return;
    status.lastEventAt = Math.max(status.lastEventAt ?? 0, ...fresh.map((e) => e.occurredAt));
    try {
      await onEvents(fresh);
    } catch (err) {
      console.error('[ring] handling events failed:', (err as Error).message);
    }
  };

  let api: RingApi | undefined;
  try {
    // Imported lazily so demo mode and the build never load the Ring client.
    const { RingApi } = await import('ring-client-api');
    api = new RingApi({
      refreshToken,
      controlCenterDisplayName: 'Ring Check-in',
      // Re-reads camera battery/online state on this cadence.
      cameraStatusPollingSeconds: 300,
    });
    api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => setKv(TOKEN_KV, newRefreshToken));

    const locations = await api.getLocations();
    const timers: NodeJS.Timeout[] = [];
    const cameras: RingCamera[] = [];

    for (const location of locations) {
      for (const camera of location.cameras) {
        cameras.push(camera);
        upsertDevices([cameraDevice(camera, location)]);
        camera.onNewNotification.subscribe((n) => {
          const e = eventFromNotification(camera.id, n);
          if (e) void deliver([e]);
        });
        camera.onData.subscribe(() => upsertDevices([cameraDevice(camera, location)]));
      }

      if (location.hasHubs) {
        const devices = await location.getDevices();
        for (const device of devices) {
          const mapped = sensorDevice(device);
          if (!mapped) continue;
          status.sensors++;
          upsertDevices([mapped]);
          let faulted = device.data.faulted;
          device.onData.subscribe((data) => {
            const e = eventFromSensorChange(device.zid, mapped.kind, faulted, data.faulted);
            faulted = data.faulted;
            const refreshed = sensorDevice(device);
            if (refreshed) upsertDevices([refreshed]);
            if (e) void deliver([e]);
          });
        }
      }
    }

    status.cameras = cameras.length;
    await deliver(await backfillCameraHistory(cameras, { sinceMs: Date.now() - INITIAL_HISTORY_MS, maxPages: 20 }));
    timers.push(setInterval(() => void backfillCameraHistory(cameras).then(deliver), HISTORY_EVERY_MS));
    timers.forEach((t) => t.unref());

    status.state = 'connected';
    status.since = Date.now();
    g.__ringAccount = { api, status, timers, cameras };
    g.__ringAccountFailure = null;
    console.log(`[ring] connected: ${status.cameras} camera(s), ${status.sensors} alarm sensor(s), ${listDevices().length} device(s) total`);
  } catch (err) {
    api?.disconnect();
    const message = (err as Error).message;
    console.error(`[ring] connection failed, retrying in ${RETRY_MS / 60_000} min:`, message);
    g.__ringAccount = undefined;
    setTimeout(() => void startRingAccount(onEvents), RETRY_MS).unref();
    // Surface the failure on the dashboard until the retry succeeds.
    // `since` keeps the first failure time across retries, so outage length is known.
    const since = g.__ringAccountFailure?.since ?? Date.now();
    g.__ringAccountFailure = { state: 'error', since, error: message, cameras: 0, sensors: 0, lastEventAt: null };
  }
}

export function stopRingAccount(): void {
  const acct = g.__ringAccount;
  if (!acct) return;
  acct.timers.forEach(clearInterval);
  acct.api.disconnect();
  g.__ringAccount = undefined;
}
