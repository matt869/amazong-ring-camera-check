import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { at, history, motion, TZ } from './helpers';

// A real (in-memory) database, real-mode config so no demo data is generated,
// and no SNS topic so notifications go to the log (silenced).
process.env.DATABASE_FILE = ':memory:';
process.env.RING_CLIENT_ID = 'test-client';
process.env.HOME_TIMEZONE = TZ;
delete process.env.SNS_TOPIC_ARN;

type Db = typeof import('../lib/db');
type Checkin = typeof import('../lib/checkin');
let db: Db;
let checkin: Checkin;
const log = vi.spyOn(console, 'log').mockImplementation(() => {});

beforeAll(async () => {
  db = await import('../lib/db');
  checkin = await import('../lib/checkin');
  const { MOCK_DEVICES } = await import('../lib/ring/mock');
  db.upsertDevices(MOCK_DEVICES);
  db.saveSettings({ ...db.getSettings(), residentName: 'Ana', timezone: TZ });
  db.insertEvents(history(at('10:30')));
});

afterAll(() => log.mockRestore());

const open = () => db.listAlerts({ openOnly: true }).map((a) => a.rule).sort();

describe('alert lifecycle', () => {
  it('opens a missed-morning alert once and notifies', async () => {
    const first = await checkin.evaluateAlerts(at('10:30'));
    expect(first.created.map((a) => a.rule).sort()).toEqual(['low_battery', 'no_morning_activity']);
    expect(db.listAlerts().find((a) => a.rule === 'no_morning_activity')?.notifiedVia).toBe('log');
    expect(db.listAlerts().find((a) => a.rule === 'low_battery')?.notifiedVia).toBe('dashboard');

    const again = await checkin.evaluateAlerts(at('10:35'));
    expect(again.created).toEqual([]);
  });

  it('reminds once when an urgent alert sits unacknowledged', async () => {
    expect((await checkin.evaluateAlerts(at('10:55'))).reminded).toEqual([]);
    expect((await checkin.evaluateAlerts(at('11:01'))).reminded.map((a) => a.rule)).toEqual(['no_morning_activity']);
    expect((await checkin.evaluateAlerts(at('11:06'))).reminded).toEqual([]);
  });

  it('stays open past midnight-style silence, and clears with an all-clear once they move', async () => {
    // Still no movement: alert stays open even though nothing new is raised.
    await checkin.evaluateAlerts(at('11:10'));
    expect(open()).toContain('no_morning_activity');

    db.insertEvents([motion('up', at('11:12'))]);
    log.mockClear();
    const res = await checkin.evaluateAlerts(at('11:15'));
    const cleared = res.resolved.find((a) => a.rule === 'no_morning_activity');
    expect(cleared?.resolutionNote).toBe('Ana is up and moving around (kitchen, 11:12am).');
    expect(log.mock.calls.some(([msg]) => String(msg).includes('All clear'))).toBe(true);
    expect(open()).toEqual(['low_battery']);
  });

  it('clears device alerts when the device recovers', async () => {
    const { MOCK_DEVICES } = await import('../lib/ring/mock');
    db.upsertDevices(MOCK_DEVICES.map((d) => (d.id === 'bedroom-motion' ? { ...d, battery: 95 } : d)));
    const res = await checkin.evaluateAlerts(at('11:20'));
    expect(res.resolved.map((a) => a.rule)).toEqual(['low_battery']);
    expect(open()).toEqual([]);
  });

  it('records a night-door alert once, and acknowledging it is final', async () => {
    db.insertEvents([{ id: 'door-night', deviceId: 'back-door', kind: 'door_open', occurredAt: at('02:40', '2026-03-19') }]);
    const t = (hhmm: string) => at(hhmm, '2026-03-19');
    const first = await checkin.evaluateAlerts(t('03:00'));
    const door = first.created.find((a) => a.rule === 'night_door');
    expect(door).toBeDefined();
    db.acknowledgeAlert(door!.id, t('03:05'));
    const later = await checkin.evaluateAlerts(t('03:10'));
    expect(later.created.find((a) => a.rule === 'night_door')).toBeUndefined();
  });

  it('closes resident alerts quietly when alerts are paused', async () => {
    const day = '2026-03-21';
    const t = (hhmm: string) => at(hhmm, day);
    await checkin.evaluateAlerts(t('11:00'));
    expect(open()).toContain('no_morning_activity');
    db.saveSettings({ ...db.getSettings(), pausedUntil: t('11:00') + 86_400_000 });
    const res = await checkin.evaluateAlerts(t('11:05'));
    expect(res.resolved.find((a) => a.rule === 'no_morning_activity')?.resolutionNote).toBe(
      'Closed because alerts were paused.',
    );
    expect(open().filter((r) => r !== 'low_battery')).toEqual([]);
  });
});

describe('Ring connection loss', () => {
  type G = { __ringAccount?: unknown; __ringAccountFailure?: unknown };
  const g = globalThis as G;

  it('alerts after 15 minutes without Ring, suppresses resident alerts, and clears on reconnect', async () => {
    const day = '2026-03-23';
    const t = (hhmm: string) => at(hhmm, day);
    process.env.RING_REFRESH_TOKEN = 'test-token';
    db.saveSettings({ ...db.getSettings(), pausedUntil: null });
    try {
      g.__ringAccountFailure = { state: 'error', since: t('10:00'), error: 'Refresh token is not valid', cameras: 0, sensors: 0, lastEventAt: null };
      const blip = await checkin.evaluateAlerts(t('10:10'));
      expect(blip.created.map((a) => a.rule)).not.toContain('connection_lost'); // under 15 min

      const down = await checkin.evaluateAlerts(t('11:00'));
      expect(down.created.map((a) => a.rule)).toEqual(['connection_lost']); // and no "no activity" alarm
      expect(open()).not.toContain('no_morning_activity');

      g.__ringAccountFailure = null;
      g.__ringAccount = { status: { state: 'connected', since: t('11:05'), error: null, cameras: 1, sensors: 0, lastEventAt: null } };
      const back = await checkin.evaluateAlerts(t('11:06'));
      expect(back.resolved.find((a) => a.rule === 'connection_lost')?.resolutionNote).toContain('restored');
    } finally {
      delete process.env.RING_REFRESH_TOKEN;
      g.__ringAccount = undefined;
      g.__ringAccountFailure = undefined;
    }
  });
});

describe('schema migration', () => {
  it('upgrades a v1 database in place, keeping alerts', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), 'v1.db');
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const old = new sqlite.DatabaseSync(file);
    old.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, location TEXT NOT NULL,
        battery INTEGER, online INTEGER NOT NULL DEFAULT 1, last_seen INTEGER);
      CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, rule TEXT NOT NULL,
        severity TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, acknowledged_at INTEGER, notified_via TEXT);
      INSERT INTO devices VALUES ('front-door', 'Front Door', 'doorbell', 'Front door', 80, 1, NULL);
      INSERT INTO alerts (key, rule, severity, title, message, occurred_at, created_at)
        VALUES ('night_door:x', 'night_door', 'warning', 'Old alert', 'msg', 1, 1);
    `);
    old.close();

    const g = globalThis as { __ringCheckinDb?: unknown };
    const saved = g.__ringCheckinDb;
    process.env.DATABASE_FILE = file;
    g.__ringCheckinDb = undefined;
    try {
      expect(db.listAlerts().map((a) => [a.title, a.resolvedAt])).toEqual([['Old alert', null]]);
      expect(db.listDevices()[0].countsAsActivity).toBe(false); // doorbell default
    } finally {
      (db.getDb() as { close(): void }).close();
      g.__ringCheckinDb = saved;
      process.env.DATABASE_FILE = ':memory:';
    }
  });
});
