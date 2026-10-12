import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { defaultCountsAsActivity, type RingDevice, type RingEvent, type RingTokens } from './ring/types';
import { RULES, withDefaults, type CheckinSettings, type RuleId, type Severity } from './routine/rules';
import type { AlertCandidate } from './routine/detect';

/**
 * Persistence on Node's built-in SQLite (node:sqlite, Node >= 22.13).
 * Loaded through process.getBuiltinModule so bundlers never try to resolve it.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  location TEXT NOT NULL,
  battery INTEGER,
  online INTEGER NOT NULL DEFAULT 1,
  last_seen INTEGER,
  counts_activity INTEGER,
  sensor_key_hash TEXT,
  heartbeat_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS events_time ON events (occurred_at);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  notified_via TEXT,
  resolved_at INTEGER,
  resolution_note TEXT,
  reminded_at INTEGER,
  acknowledged_by TEXT,
  resident_at INTEGER,
  caregiver_at INTEGER,
  neighbor_at INTEGER,
  replied_at INTEGER,
  reply TEXT,
  snapshot TEXT,
  neighbor_help_at INTEGER
);
CREATE TABLE IF NOT EXISTS family_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  who TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS family_log_time ON family_log (at);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const globalForDb = globalThis as unknown as { __ringCheckinDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (globalForDb.__ringCheckinDb) return globalForDb.__ringCheckinDb;
  const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const file = process.env.DATABASE_FILE ?? path.join(process.env.DATA_DIR || './data', 'ring-checkin.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(/*turbopackIgnore: true*/ file)), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  migrate(db);
  db.exec('CREATE INDEX IF NOT EXISTS alerts_key ON alerts (key);');
  globalForDb.__ringCheckinDb = db;
  return db;
}

/** Brings databases created by earlier versions up to the current schema. */
function migrate(db: DatabaseSync): void {
  const columns = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));

  const deviceCols = columns('devices');
  if (!deviceCols.has('counts_activity')) db.exec('ALTER TABLE devices ADD COLUMN counts_activity INTEGER');
  if (!deviceCols.has('sensor_key_hash')) db.exec('ALTER TABLE devices ADD COLUMN sensor_key_hash TEXT');
  if (!deviceCols.has('heartbeat_at')) db.exec('ALTER TABLE devices ADD COLUMN heartbeat_at INTEGER');
  if (!columns('alerts').has('resolved_at')) {
    // v1 had UNIQUE(key); alerts can now recur after resolving, so rebuild the table.
    db.exec(`
      BEGIN;
      ALTER TABLE alerts RENAME TO alerts_v1;
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, rule TEXT NOT NULL, severity TEXT NOT NULL,
        title TEXT NOT NULL, message TEXT NOT NULL, occurred_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        acknowledged_at INTEGER, notified_via TEXT, resolved_at INTEGER, resolution_note TEXT, reminded_at INTEGER
      );
      INSERT INTO alerts (id, key, rule, severity, title, message, occurred_at, created_at, acknowledged_at, notified_via)
        SELECT id, key, rule, severity, title, message, occurred_at, created_at, acknowledged_at, notified_via FROM alerts_v1;
      DROP TABLE alerts_v1;
      COMMIT;
    `);
  }
  // v3: escalation ladder. Alerts sent before it existed count as having reached family.
  const alertCols = columns('alerts');
  for (const [col, type] of [
    ['acknowledged_by', 'TEXT'],
    ['resident_at', 'INTEGER'],
    ['caregiver_at', 'INTEGER'],
    ['neighbor_at', 'INTEGER'],
    ['replied_at', 'INTEGER'],
    ['reply', 'TEXT'],
    ['snapshot', 'TEXT'],
    ['neighbor_help_at', 'INTEGER'],
  ]) {
    if (!alertCols.has(col)) db.exec(`ALTER TABLE alerts ADD COLUMN ${col} ${type}`);
  }
  if (!alertCols.has('caregiver_at')) {
    db.exec("UPDATE alerts SET caregiver_at = created_at WHERE notified_via IN ('sns', 'log', 'failed')");
  }
}

// --- devices -----------------------------------------------------------------

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  location: string;
  battery: number | null;
  online: number;
  last_seen: number | null;
  counts_activity: number | null;
  heartbeat_at?: number | null;
}

const toDevice = (r: DeviceRow): RingDevice => {
  const kind = r.kind as RingDevice['kind'];
  return {
    id: r.id,
    name: r.name,
    kind,
    location: r.location,
    battery: r.battery,
    online: r.online === 1,
    lastSeen: r.last_seen,
    countsAsActivity: r.counts_activity == null ? defaultCountsAsActivity(kind) : r.counts_activity === 1,
    heartbeatAt: r.heartbeat_at ?? null,
  };
};

/** Updates device metadata from Ring. Leaves the caregiver's per-device preferences alone. */
export function upsertDevices(devices: RingDevice[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO devices (id, name, kind, location, battery, online, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, kind = excluded.kind, location = excluded.location,
      battery = excluded.battery, online = excluded.online,
      last_seen = MAX(COALESCE(devices.last_seen, 0), COALESCE(excluded.last_seen, 0))
  `);
  for (const d of devices) {
    stmt.run(d.id, d.name, d.kind, d.location, d.battery, d.online ? 1 : 0, d.lastSeen);
  }
}

export function setDeviceCountsActivity(id: string, counts: boolean): void {
  getDb().prepare('UPDATE devices SET counts_activity = ? WHERE id = ?').run(counts ? 1 : 0, id);
}

// --- webcam sensors ------------------------------------------------------------

/** Webcams that stop sending heartbeats for this long count as offline. */
export const WEBCAM_OFFLINE_MS = 10 * 60_000;

export function createWebcamDevice(id: string, name: string, location: string, keyHash: string): void {
  getDb()
    .prepare(
      `INSERT INTO devices (id, name, kind, location, battery, online, last_seen, counts_activity, sensor_key_hash, heartbeat_at)
       VALUES (?, ?, 'webcam', ?, NULL, 0, NULL, 1, ?, NULL)`,
    )
    .run(id, name, location, keyHash);
}

export function setSensorKeyHash(id: string, keyHash: string): void {
  getDb().prepare('UPDATE devices SET sensor_key_hash = ?, online = 0, heartbeat_at = NULL WHERE id = ?').run(keyHash, id);
}

export function findDeviceBySensorKeyHash(keyHash: string): RingDevice | null {
  const row = getDb().prepare('SELECT * FROM devices WHERE sensor_key_hash = ?').get(keyHash) as DeviceRow | undefined;
  return row ? toDevice(row) : null;
}

export function recordHeartbeat(id: string, now: number): void {
  getDb().prepare('UPDATE devices SET heartbeat_at = ?, online = 1 WHERE id = ?').run(now, id);
}

/** Marks each webcam online if it has sent a heartbeat recently, offline otherwise. */
export function refreshWebcamStatus(now: number): void {
  getDb()
    .prepare(`UPDATE devices SET online = CASE WHEN heartbeat_at >= ? THEN 1 ELSE 0 END WHERE kind = 'webcam'`)
    .run(now - WEBCAM_OFFLINE_MS);
}

/** Latest heartbeat across webcams that count as activity, or null if none ever reported. */
export function lastWebcamHeartbeat(): number | null {
  const row = getDb()
    .prepare(`SELECT MAX(heartbeat_at) AS t FROM devices WHERE kind = 'webcam' AND COALESCE(counts_activity, 1) = 1`)
    .get() as { t: number | null };
  return row.t;
}

export function deleteDevice(id: string): void {
  getDb().prepare('DELETE FROM devices WHERE id = ?').run(id);
}

/**
 * Switches from simulated data to real sensors: removes demo events and
 * devices, alerts and cached notes, and records that the app is live.
 */
export function leaveDemoMode(demoDeviceIds: string[]): void {
  const db = getDb();
  db.exec(
    "DELETE FROM events WHERE id LIKE 'demo-%' OR id LIKE 'manual-%'; DELETE FROM alerts; " +
      "DELETE FROM family_log WHERE id LIKE 'demo-%'; " +
      "DELETE FROM kv WHERE key LIKE 'summary:%' OR key LIKE 'digest%' OR key = 'ring_tokens' OR key LIKE 'upkeep:%';",
  );
  const del = db.prepare('DELETE FROM devices WHERE id = ?');
  for (const id of demoDeviceIds) del.run(id);
  setKv('live_mode', true);
}

export function isLiveMode(): boolean {
  return getKv<boolean>('live_mode') === true;
}

export function listDevices(): RingDevice[] {
  return (getDb().prepare('SELECT * FROM devices ORDER BY name').all() as unknown as DeviceRow[]).map(toDevice);
}

// --- events ------------------------------------------------------------------

interface EventRow {
  id: string;
  device_id: string;
  kind: string;
  occurred_at: number;
  payload: string | null;
}

const toEvent = (r: EventRow): RingEvent => ({
  id: r.id,
  deviceId: r.device_id,
  kind: r.kind as RingEvent['kind'],
  occurredAt: r.occurred_at,
  payload: r.payload ? JSON.parse(r.payload) : undefined,
});

/**
 * Inserts events, ignoring ones already stored. Returns those that were new.
 * Events inside a resident's privacy pause are dropped, including ones a
 * history backfill delivers after the pause has ended.
 */
export function insertEvents(events: RingEvent[]): RingEvent[] {
  const db = getDb();
  const privacy = listPauseWindows().filter((w) => w.by === 'resident');
  if (privacy.length) {
    events = events.filter((e) => !privacy.some((w) => e.occurredAt >= w.from && e.occurredAt < w.until));
  }
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO events (id, device_id, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?)',
  );
  const touch = db.prepare('UPDATE devices SET last_seen = MAX(COALESCE(last_seen, 0), ?), online = 1 WHERE id = ?');
  const inserted: RingEvent[] = [];
  db.exec('BEGIN');
  try {
    for (const e of events) {
      const res = stmt.run(e.id, e.deviceId, e.kind, e.occurredAt, e.payload ? JSON.stringify(e.payload) : null);
      if (res.changes > 0) {
        inserted.push(e);
        touch.run(e.occurredAt, e.deviceId);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return inserted;
}

/** Events in [from, to), newest first. */
export function listEvents(from: number, to: number, limit = 5000): RingEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM events WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC LIMIT ?')
    .all(from, to, limit) as unknown as EventRow[];
  return rows.map(toEvent);
}

/**
 * Clears alerts and cached summaries plus simulated events, for re-seeding a
 * demo scenario. `allEvents` also drops manual/webhook events (demo mode only).
 */
export function resetDemoData(allEvents = false): void {
  const db = getDb();
  db.exec(allEvents ? 'DELETE FROM events;' : "DELETE FROM events WHERE id LIKE 'demo-%';");
  db.exec(
    "DELETE FROM alerts; DELETE FROM family_log WHERE id LIKE 'demo-%'; " +
      "DELETE FROM kv WHERE key LIKE 'summary:%' OR key LIKE 'digest%' OR key IN ('pause_windows', 'demo_fill', 'upkeep:visitors');",
  );
}

export function countEvents(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
}

/** Drops events and closed alerts older than the retention windows. */
export function pruneOldData(now: number, eventDays = 120, alertDays = 365): { events: number; alerts: number } {
  const db = getDb();
  const events = db.prepare('DELETE FROM events WHERE occurred_at < ?').run(now - eventDays * 86_400_000).changes;
  const alerts = db
    .prepare('DELETE FROM alerts WHERE created_at < ? AND (resolved_at IS NOT NULL OR acknowledged_at IS NOT NULL)')
    .run(now - alertDays * 86_400_000).changes;
  db.prepare('DELETE FROM family_log WHERE at < ?').run(now - alertDays * 86_400_000);
  setKv('pause_windows', listPauseWindows().filter((w) => w.until >= now - eventDays * 86_400_000));
  return { events: Number(events), alerts: Number(alerts) };
}

// --- alerts ------------------------------------------------------------------

export interface AlertRecord {
  id: number;
  key: string;
  rule: RuleId;
  severity: Severity;
  title: string;
  message: string;
  occurredAt: number;
  createdAt: number;
  acknowledgedAt: number | null;
  notifiedVia: string | null;
  resolvedAt: number | null;
  resolutionNote: string | null;
  remindedAt: number | null;
  /** Name of the family member who pressed "I checked on it", if known. */
  acknowledgedBy: string | null;
  /** Escalation ladder: when the resident, family and neighbor were each contacted. */
  residentAt: number | null;
  caregiverAt: number | null;
  neighborAt: number | null;
  /** When the resident (or neighbor) answered the check-in link, and what they said. */
  repliedAt: number | null;
  reply: Reply | null;
  /** File name of the doorbell picture attached to this alert (resident consented). */
  snapshot: string | null;
  /** When the neighbor reported they couldn't reach the resident. */
  neighborHelpAt: number | null;
}

/** "ok": the resident is fine. "help": they asked for a call. "neighbor-ok": the neighbor checked on them. */
export type Reply = 'ok' | 'help' | 'neighbor-ok';

interface AlertRow {
  id: number;
  key: string;
  rule: string;
  severity: string;
  title: string;
  message: string;
  occurred_at: number;
  created_at: number;
  acknowledged_at: number | null;
  notified_via: string | null;
  resolved_at: number | null;
  resolution_note: string | null;
  reminded_at: number | null;
  acknowledged_by: string | null;
  resident_at: number | null;
  caregiver_at: number | null;
  neighbor_at: number | null;
  replied_at: number | null;
  reply: string | null;
  snapshot: string | null;
  neighbor_help_at: number | null;
}

const toAlert = (r: AlertRow): AlertRecord => ({
  id: r.id,
  key: r.key,
  rule: r.rule as RuleId,
  severity: r.severity as Severity,
  title: r.title,
  message: r.message,
  occurredAt: r.occurred_at,
  createdAt: r.created_at,
  acknowledgedAt: r.acknowledged_at,
  notifiedVia: r.notified_via,
  resolvedAt: r.resolved_at,
  resolutionNote: r.resolution_note,
  remindedAt: r.reminded_at,
  acknowledgedBy: r.acknowledged_by ?? null,
  residentAt: r.resident_at ?? null,
  caregiverAt: r.caregiver_at ?? null,
  neighborAt: r.neighbor_at ?? null,
  repliedAt: r.replied_at ?? null,
  reply: (r.reply as Reply | null) ?? null,
  snapshot: r.snapshot ?? null,
  neighborHelpAt: r.neighbor_help_at ?? null,
});

export const isOpen = (a: AlertRecord) => a.acknowledgedAt == null && a.resolvedAt == null;

/**
 * Stores alerts for situations not already on record; returns only the new
 * ones. Self-resolving rules may recur once their previous alert resolved,
 * unless someone answered the check-in for it: "I'm OK" settles that
 * situation. The others are recorded once per key, ever.
 */
export function insertAlerts(candidates: AlertCandidate[], now = Date.now()): AlertRecord[] {
  const db = getDb();
  const unresolved = db.prepare(
    'SELECT 1 FROM alerts WHERE key = ? AND (resolved_at IS NULL OR replied_at IS NOT NULL) LIMIT 1',
  );
  const any = db.prepare('SELECT 1 FROM alerts WHERE key = ? LIMIT 1');
  const insert = db.prepare(`
    INSERT INTO alerts (key, rule, severity, title, message, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const created: AlertRecord[] = [];
  for (const c of candidates) {
    const exists = (RULES[c.rule].autoResolves ? unresolved : any).get(c.key);
    if (exists) continue;
    const res = insert.run(c.key, c.rule, c.severity, c.title, c.message, c.occurredAt, now);
    created.push({
      id: Number(res.lastInsertRowid),
      ...c,
      createdAt: now,
      acknowledgedAt: null,
      notifiedVia: null,
      resolvedAt: null,
      resolutionNote: null,
      remindedAt: null,
      acknowledgedBy: null,
      residentAt: null,
      caregiverAt: null,
      neighborAt: null,
      repliedAt: null,
      reply: null,
      snapshot: null,
      neighborHelpAt: null,
    });
  }
  return created;
}

export function getAlert(id: number): AlertRecord | null {
  const row = getDb().prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
  return row ? toAlert(row) : null;
}

/** Closes one alert now, e.g. after the resident replied "I'm OK". No-op if it's already closed. */
export function resolveAlert(id: number, now: number, note: string): void {
  getDb()
    .prepare('UPDATE alerts SET resolved_at = ?, resolution_note = ? WHERE id = ? AND resolved_at IS NULL')
    .run(now, note, id);
}

export function recordReply(id: number, reply: Reply, now: number): void {
  getDb().prepare('UPDATE alerts SET replied_at = ?, reply = ? WHERE id = ?').run(now, reply, id);
}

export type Rung = 'resident' | 'caregiver' | 'neighbor';

/** Records that a rung of the escalation ladder was contacted (keeps the first time). */
export function markRung(id: number, rung: Rung, now: number): void {
  getDb().prepare(`UPDATE alerts SET ${rung}_at = COALESCE(${rung}_at, ?) WHERE id = ?`).run(now, id);
}

/** Records the neighbor's "couldn't reach them"; false if it was already recorded. */
export function markNeighborHelp(id: number, now: number): boolean {
  return getDb().prepare('UPDATE alerts SET neighbor_help_at = ? WHERE id = ? AND neighbor_help_at IS NULL').run(now, id).changes > 0;
}

export function setAlertSnapshot(id: number, file: string): void {
  getDb().prepare('UPDATE alerts SET snapshot = ? WHERE id = ?').run(file, id);
}

/**
 * Resolves self-resolving alerts whose condition no longer holds. An alert
 * whose key is still active is kept; otherwise `decide` returns the
 * resolution note, or null to keep it open (e.g. no evidence yet that they're OK).
 */
export function resolveClearedAlerts(
  activeKeys: Set<string>,
  now: number,
  decide: (a: AlertRecord) => string | null,
): AlertRecord[] {
  const db = getDb();
  const autoRules = (Object.keys(RULES) as RuleId[]).filter((r) => RULES[r].autoResolves);
  const rows = db
    .prepare(`SELECT * FROM alerts WHERE resolved_at IS NULL AND rule IN (${autoRules.map(() => '?').join(',')})`)
    .all(...autoRules) as unknown as AlertRow[];
  const update = db.prepare('UPDATE alerts SET resolved_at = ?, resolution_note = ? WHERE id = ?');
  const resolved: AlertRecord[] = [];
  for (const alert of rows.map(toAlert)) {
    if (activeKeys.has(alert.key)) continue;
    const note = decide(alert);
    if (note == null) continue;
    update.run(now, note, alert.id);
    resolved.push({ ...alert, resolvedAt: now, resolutionNote: note });
  }
  return resolved;
}

/** Open urgent alerts family hasn't acknowledged within `minutes` of being told, not yet reminded about. */
export function listDueReminders(now: number, minutes: number): AlertRecord[] {
  if (minutes <= 0) return [];
  const rows = getDb()
    .prepare(`
      SELECT * FROM alerts
      WHERE severity = 'critical' AND acknowledged_at IS NULL AND resolved_at IS NULL
        AND reminded_at IS NULL AND caregiver_at IS NOT NULL AND caregiver_at <= ?
    `)
    .all(now - minutes * 60_000) as unknown as AlertRow[];
  return rows.map(toAlert);
}

export function markReminded(id: number, now: number): void {
  getDb().prepare('UPDATE alerts SET reminded_at = ? WHERE id = ?').run(now, id);
}

export function listAlerts(opts: { since?: number; until?: number; openOnly?: boolean; limit?: number } = {}): AlertRecord[] {
  const where: string[] = [];
  const args: number[] = [];
  if (opts.since != null) {
    where.push('created_at >= ?');
    args.push(opts.since);
  }
  if (opts.until != null) {
    where.push('created_at < ?');
    args.push(opts.until);
  }
  if (opts.openOnly) where.push('acknowledged_at IS NULL AND resolved_at IS NULL');
  const sql = `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT ?`;
  return (getDb().prepare(sql).all(...args, opts.limit ?? 100) as unknown as AlertRow[]).map(toAlert);
}

export function acknowledgeAlert(id: number, now = Date.now(), by: string | null = null): void {
  getDb()
    .prepare('UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND acknowledged_at IS NULL')
    .run(now, by, id);
}

export function markAlertNotified(id: number, via: string): void {
  getDb().prepare('UPDATE alerts SET notified_via = ? WHERE id = ?').run(via, id);
}

// --- family log: who checked on them --------------------------------------------

export type FamilyLogKind = 'call' | 'visit' | 'message' | 'other';

export interface FamilyLogEntry {
  id: string;
  at: number;
  who: string;
  kind: FamilyLogKind;
  note: string | null;
}

export function addFamilyLog(entry: FamilyLogEntry): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO family_log (id, at, who, kind, note) VALUES (?, ?, ?, ?, ?)')
    .run(entry.id, entry.at, entry.who, entry.kind, entry.note);
}

/** Entries in [from, to), newest first. */
export function listFamilyLog(from: number, to: number): FamilyLogEntry[] {
  return getDb()
    .prepare('SELECT * FROM family_log WHERE at >= ? AND at < ? ORDER BY at DESC')
    .all(from, to) as unknown as FamilyLogEntry[];
}

export function deleteFamilyLog(id: string): void {
  getDb().prepare('DELETE FROM family_log WHERE id = ?').run(id);
}

// --- pause history ----------------------------------------------------------------

/** A stretch when alerts were paused. Resident (privacy) pauses also stop recording activity. */
export interface PauseWindow {
  from: number;
  until: number;
  by: 'family' | 'resident';
}

export function listPauseWindows(): PauseWindow[] {
  return getKv<PauseWindow[]>('pause_windows') ?? [];
}

export function recordPauseWindow(w: PauseWindow): void {
  setKv('pause_windows', [...listPauseWindows(), w]);
}

/** Cuts short any pause still running at `now` (resumed early), optionally only one kind. */
export function endPauseWindows(now: number, by?: PauseWindow['by']): void {
  setKv(
    'pause_windows',
    listPauseWindows().map((w) => (w.from <= now && w.until > now && (!by || w.by === by) ? { ...w, until: now } : w)),
  );
}

// --- key/value: settings, tokens, cached summaries, bookkeeping -----------------

export function getKv<T>(key: string): T | null {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setKv(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function deleteKv(key: string): void {
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(key);
}

export function getSettings(): CheckinSettings {
  return withDefaults(getKv<Partial<CheckinSettings>>('settings'));
}

export function saveSettings(settings: CheckinSettings): void {
  setKv('settings', settings);
}

export function getTokens(): RingTokens | null {
  return getKv<RingTokens>('ring_tokens');
}

export function saveTokens(tokens: RingTokens): void {
  setKv('ring_tokens', tokens);
}
