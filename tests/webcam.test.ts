import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { at, history, TZ } from './helpers';

// Fresh in-memory database, no Ring credentials: the webcam is the only source.
process.env.DATABASE_FILE = ':memory:';
process.env.HOME_TIMEZONE = TZ;
delete process.env.RING_CLIENT_ID;
delete process.env.RING_REFRESH_TOKEN;
delete process.env.RING_MOCK;
delete process.env.SNS_TOPIC_ARN;
delete process.env.APP_PASSWORD;

let db: typeof import('../lib/db');
let checkin: typeof import('../lib/checkin');
let ingest: typeof import('../lib/sensor/ingest');
let oauth: typeof import('../lib/ring/oauth');
let auth: typeof import('../lib/auth');
const log = vi.spyOn(console, 'log').mockImplementation(() => {});

const KEY = 'test-sensor-key';
const DAY = '2026-03-18';
const t = (hhmm: string) => at(hhmm, DAY);
const bearer = `Bearer ${KEY}`;
const open = () => db.listAlerts({ openOnly: true }).map((a) => a.key);

beforeAll(async () => {
  db = await import('../lib/db');
  checkin = await import('../lib/checkin');
  ingest = await import('../lib/sensor/ingest');
  oauth = await import('../lib/ring/oauth');
  auth = await import('../lib/auth');
  db.saveSettings({ ...db.getSettings(), residentName: 'Ana', timezone: TZ });
});
afterAll(() => log.mockRestore());

describe('going live with a webcam', () => {
  it('starts in demo mode, open; leaving demo requires real sensors and locks without a password', async () => {
    expect(oauth.isMockMode()).toBe(true);
    expect(auth.authMode()).toBe('open');

    const { MOCK_DEVICES } = await import('../lib/ring/mock');
    db.upsertDevices(MOCK_DEVICES);
    db.insertEvents([{ id: 'demo-x-1', deviceId: 'kitchen-motion', kind: 'motion', occurredAt: t('08:00') }]);
    db.leaveDemoMode(MOCK_DEVICES.map((d) => d.id));

    expect(oauth.isMockMode()).toBe(false);
    expect(db.listDevices()).toEqual([]);
    expect(db.countEvents()).toBe(0);
    expect(auth.authMode()).toBe('locked'); // real data, no password yet

    auth.setAppPassword('correct horse');
    expect(auth.authMode()).toBe('password');
    expect(auth.verifyLogin('correct horse')).toBe(true);
    expect(auth.verifyLogin('wrong')).toBe(false);
  });

  it('reports "no sensors" before a webcam exists, and holds back resident alerts', async () => {
    expect(checkin.monitoringState(db.listDevices(), t('10:30')).state).toBe('no-sensors');
    const res = await checkin.evaluateAlerts(t('10:30'));
    expect(res.created).toEqual([]);
  });

  it('waits for the first check-in after a webcam is added, without calling it offline', async () => {
    db.createWebcamDevice('webcam-1', 'Kitchen webcam', 'Kitchen', ingest.hashSensorKey(KEY));
    expect(checkin.monitoringState(db.listDevices(), t('10:31')).state).toBe('waiting');
    const res = await checkin.evaluateAlerts(t('10:31'));
    expect(res.created).toEqual([]);
  });

  it('never uses leftover demo Ring tokens once live', () => {
    db.saveTokens({ accessToken: 'mock-demo', refreshToken: 'mock-refresh', expiresAt: Date.now() + 1e9 });
    expect(oauth.isConnected()).toBe(false); // no RING_CLIENT_ID: tokens are ignored
  });
});

describe('sensor reports', () => {
  it('rejects missing and unknown keys', () => {
    expect(ingest.ingestSensorReport(null, {}, t('10:32'))).toMatchObject({ ok: false, status: 401 });
    expect(ingest.ingestSensorReport('Bearer nope', {}, t('10:32'))).toMatchObject({ ok: false, status: 401 });
    expect(ingest.ingestSensorReport(bearer, { motion: 'x' }, t('10:32'))).toMatchObject({ ok: false, status: 400 });
  });

  it('records heartbeats and motion, dropping stale or far-future timestamps and duplicates', () => {
    const now = t('10:33');
    const r = ingest.ingestSensorReport(bearer, { motion: [now - 5000, now - 5000, now - 30 * 3_600_000, now + 3_600_000, 'bad'] }, now);
    expect(r.ok && r.inserted.length).toBe(1);
    expect(db.listDevices()[0]).toMatchObject({ online: true, heartbeatAt: now });
    // A retried report doesn't duplicate.
    const again = ingest.ingestSensorReport(bearer, { motion: [now - 5000] }, now + 1000);
    expect(again.ok && again.inserted.length).toBe(0);
    expect(checkin.monitoringState(db.listDevices(), now).state).toBe('ok');
  });
});

describe('monitoring offline', () => {
  it('marks the webcam offline after 10 minutes of silence, alerts after 15, and never blames the resident', async () => {
    db.insertEvents(history(t('10:33')).map((e) => ({ ...e, deviceId: 'webcam-1' })));

    await checkin.evaluateAlerts(t('10:40')); // 7 min since heartbeat: fine
    expect(db.listDevices()[0].online).toBe(true);

    const res = await checkin.evaluateAlerts(t('10:50')); // 17 min
    expect(db.listDevices()[0].online).toBe(false);
    expect(res.created.map((a) => a.key)).toContain('connection_lost:sensors');
    expect(open().some((k) => k.startsWith('prolonged_inactivity') || k.startsWith('no_morning'))).toBe(false);
    expect(res.created.find((a) => a.key === 'connection_lost:sensors')?.title).toBe('No camera is checking in');
  });

  it('clears when the camera checks in again', async () => {
    ingest.ingestSensorReport(bearer, { motion: [] }, t('11:00'));
    const res = await checkin.evaluateAlerts(t('11:00'));
    const cleared = res.resolved.find((a) => a.key === 'connection_lost:sensors');
    expect(cleared?.resolutionNote).toBe('A camera is checking in again; monitoring is back on.');
    expect(open()).not.toContain('connection_lost:sensors');
  });

  it('a new link revokes the old key', () => {
    db.setSensorKeyHash('webcam-1', ingest.hashSensorKey('new-key'));
    expect(ingest.ingestSensorReport(bearer, {}, t('11:01'))).toMatchObject({ ok: false, status: 401 });
    expect(ingest.ingestSensorReport('Bearer new-key', {}, t('11:01')).ok).toBe(true);
  });
});

describe('password hashing', () => {
  it('salts and verifies', () => {
    const a = auth.hashPassword('pw-123456');
    const b = auth.hashPassword('pw-123456');
    expect(a.hash).not.toBe(b.hash);
    expect(auth.verifyPasswordHash('pw-123456', a)).toBe(true);
    expect(auth.verifyPasswordHash('pw-1234567', a)).toBe(false);
  });
});
