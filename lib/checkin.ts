import {
  getKv,
  getSettings,
  insertAlerts,
  insertEvents,
  isOpen,
  lastWebcamHeartbeat,
  refreshWebcamStatus,
  listAlerts,
  listDevices,
  listDueReminders,
  listEvents,
  markAlertNotified,
  markReminded,
  pruneOldData,
  resolveClearedAlerts,
  setKv,
  type AlertRecord,
} from './db';
import { isBedrockEnabled, summarizeDay, type DayFacts, type DaySummary } from './aws/bedrock';
import { pushes, sendReminder } from './aws/notify';
import { maybeSendDigest } from './digest';
import { advanceLadder, standDown } from './escalation';
import { getDayVisits, getVisits } from './insights';
import { attachSnapshot, pruneSnapshots } from './snapshot';
import { detectVisitorPattern, VISIT_KIND_LABEL, type Visit } from './routine/visitors';
import { syncDevices } from './ring/devices';
import { ensureDemoData, fetchRecentEvents } from './ring/events';
import { getRingAccountStatus, startRingAccount } from './ring/account';
import { isConnected, isMockMode, usesRingAccount } from './ring/oauth';
import type { RingDevice, RingEvent } from './ring/types';
import {
  activityFilter,
  computeBaseline,
  DAY_START_MINUTE,
  hourlyCounts,
  MIN_BASELINE_DAYS,
  type Baseline,
} from './routine/baseline';
import { computeStatus, detectAnomalies, ruleActive, wakeDeadline, type StatusSummary } from './routine/detect';
import { detectOutings, inferPresence, type Presence } from './routine/presence';
import { isPaused, RULES, type CheckinSettings } from './routine/rules';
import { addDays, formatDateTime, formatMinuteOfDay, formatTime, localParts, zonedToUtc } from './routine/time';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A Ring outage shorter than this is a blip, not worth a notification. */
const CONNECTION_GRACE_MS = 15 * MINUTE;

export function loadBaseline(now: number, settings: CheckinSettings, devices = listDevices()): Baseline {
  const tz = settings.timezone;
  const today = localParts(now, tz).dateKey;
  const from = zonedToUtc(addDays(today, -settings.baselineDays), 0, tz);
  return computeBaseline(listEvents(from, now + 1, 100_000), {
    now,
    timezone: tz,
    days: settings.baselineDays,
    isActivity: activityFilter(devices),
  });
}

/** Returns true (and records the run) if `key` hasn't run within `everyMs`. */
function due(key: string, everyMs: number, now: number): boolean {
  const last = getKv<number>(`upkeep:${key}`);
  if (last != null && now - last < everyMs && last <= now) return false;
  setKv(`upkeep:${key}`, now);
  return true;
}

let upkeepInFlight: Promise<void> | null = null;

/**
 * With a real Ring account: refresh device status/battery and pull recent
 * history as a backstop for missed webhooks. Throttled; never throws.
 */
async function ringUpkeep(now: number): Promise<void> {
  // The Ring-account connection keeps itself current; this is the partner-OAuth path.
  if (isMockMode() || usesRingAccount() || !process.env.RING_CLIENT_ID || !isConnected()) return;
  upkeepInFlight ??= (async () => {
    try {
      if (due('devices', 30 * MINUTE, now)) await syncDevices();
      if (due('history', 15 * MINUTE, now)) insertEvents(await fetchRecentEvents(20));
    } catch (err) {
      console.error('[ring] upkeep failed:', (err as Error).message);
    } finally {
      upkeepInFlight = null;
    }
  })();
  await upkeepInFlight;
}

/**
 * The heartbeat: refresh data, evaluate every rule, open/resolve alerts and
 * send notifications. Safe to call as often as you like.
 */
/** Starts live event sources (the Ring account connection). Idempotent. */
export function startLiveSources(): void {
  if (usesRingAccount()) void startRingAccount(() => evaluateAlerts().then(() => undefined));
}

export async function runCheck(now = Date.now()): Promise<CheckResult> {
  startLiveSources();
  const settings = getSettings();
  ensureDemoData(now, settings.timezone);
  await ringUpkeep(now);
  if (due('prune', 24 * HOUR, now)) {
    pruneOldData(now);
    pruneSnapshots(now);
  }
  const result = await evaluateAlerts(now);
  await maybeSendDigest(now);
  return result;
}

export interface CheckResult {
  created: AlertRecord[];
  resolved: AlertRecord[];
  reminded: AlertRecord[];
}

export type MonitoringState =
  | { state: 'demo' }
  | { state: 'ok' }
  /** Real mode, but no sensor that tracks the resident has been set up yet. */
  | { state: 'no-sensors' }
  /** Sensors set up, none has checked in yet. */
  | { state: 'waiting' }
  /** Was working; nothing is reporting now. */
  | { state: 'down'; since: number | null; cause: 'ring' | 'sensors'; detail: string };

/**
 * Whether activity can actually be arriving. When it can't, silence says
 * nothing about the resident, so resident alerts are held back and caregivers
 * are told monitoring is down instead.
 */
export function monitoringState(devices: RingDevice[], now = Date.now()): MonitoringState {
  if (isMockMode()) return { state: 'demo' };
  const ring = usesRingAccount() ? getRingAccountStatus() : null;
  if (ring && ring.state !== 'connected') {
    return ring.state === 'error'
      ? { state: 'down', since: ring.since, cause: 'ring', detail: ring.error ?? 'unknown error' }
      : { state: 'waiting' };
  }
  const trackers = devices.filter((d) => d.countsAsActivity);
  if (trackers.length === 0) return { state: 'no-sensors' };
  if (trackers.some((d) => d.online)) return { state: 'ok' };
  const lastHeard = lastWebcamHeartbeat();
  const webcams = trackers.filter((d) => d.kind === 'webcam');
  if (webcams.length > 0 && lastHeard == null) return { state: 'waiting' };
  return {
    state: 'down',
    since: lastHeard,
    cause: 'sensors',
    detail: webcams.length ? webcams.map((d) => d.name).join(', ') : trackers.map((d) => d.name).join(', '),
  };
}

/** Rule evaluation and alert lifecycle, without any data fetching. */
export async function evaluateAlerts(now = Date.now()): Promise<CheckResult> {
  const settings = getSettings();
  refreshWebcamStatus(now);
  const devices = listDevices();
  const recent = listEvents(now - 36 * HOUR, now + 1);
  const presence = inferPresence(recent, devices, now);

  const monitoring = monitoringState(devices, now);
  const dataFlowing = monitoring.state === 'ok' || monitoring.state === 'demo';

  const candidates = detectAnomalies({
    now,
    settings,
    baseline: loadBaseline(now, settings, devices),
    recentEvents: recent,
    devices,
    dataFlowing,
  });
  // Monitoring itself being down is worth telling people about, after a grace period for blips.
  if (
    monitoring.state === 'down' &&
    monitoring.since != null &&
    now - monitoring.since >= CONNECTION_GRACE_MS &&
    settings.enabledRules.connection_lost
  ) {
    const since = formatTime(monitoring.since, settings.timezone);
    candidates.push(
      monitoring.cause === 'ring'
        ? {
            key: 'connection_lost:ring',
            rule: 'connection_lost',
            severity: RULES.connection_lost.severity,
            title: 'Check-in can’t reach Ring',
            message:
              `No activity has come in since ${since}, so check-in alerts can’t fire. ` +
              `It keeps retrying. If this lasts, sign in again with npm run ring:login. (${monitoring.detail})`,
            occurredAt: monitoring.since,
          }
        : {
            key: 'connection_lost:sensors',
            rule: 'connection_lost',
            severity: RULES.connection_lost.severity,
            title: 'No camera is checking in',
            message:
              `${monitoring.detail} last checked in at ${since}, so check-in alerts can’t fire. ` +
              `Make sure the device is on, plugged in, connected to Wi-Fi, and the sensor page is still open.`,
            occurredAt: monitoring.since,
          },
    );
  }

  // Visitor patterns look back weeks, so they're checked every 10 minutes, not on every sensor report.
  if (ruleActive('unexpected_visitors', settings, now, dataFlowing) && due('visitors', 10 * MINUTE, now)) {
    const pattern = detectVisitorPattern(getVisits(now - 35 * 24 * HOUR, now + 1, settings, devices), {
      now,
      timezone: settings.timezone,
      name: settings.residentName,
    });
    if (pattern) {
      candidates.push({
        ...pattern,
        key: `unexpected_visitors:${pattern.key}`,
        rule: 'unexpected_visitors',
        severity: RULES.unexpected_visitors.severity,
      });
    }
  }

  const created = insertAlerts(candidates, now);
  const resolved = resolveClearedAlerts(
    new Set(candidates.map((c) => c.key)),
    now,
    (alert) => resolutionFor(alert, { settings, devices, presence, now }),
  );

  // Escalation ladder: resident first, then family, then a neighbor. New
  // alerts take their first step now; open ones move up when their time comes.
  for (const alert of created) {
    if (!pushes(alert.severity)) markAlertNotified(alert.id, 'dashboard');
  }
  for (const alert of listAlerts({ openOnly: true })) await advanceLadder(alert, settings, now);
  for (const alert of created) {
    if (pushes(alert.severity)) await attachSnapshot(alert, settings);
  }

  // Only follow up with people who actually heard about it.
  const quiet = isPaused(settings, now);
  for (const alert of resolved) {
    if (!quiet) await standDown(alert, settings, { family: true, neighbor: true });
  }

  const reminded = quiet ? [] : listDueReminders(now, settings.reminderMinutes);
  for (const alert of reminded) {
    markReminded(alert.id, now); // first, so overlapping checks can't double-send
    try {
      await sendReminder(alert, settings);
    } catch (err) {
      console.error(`[notify] failed to send reminder for ${alert.key}:`, (err as Error).message);
    }
  }

  setKv('last_check_at', now);
  return { created, resolved, reminded };
}

/**
 * Whether a self-resolving alert can close, with the note shown to caregivers.
 * Requires evidence they're OK: silence ending at midnight is not an all-clear.
 */
export function resolutionFor(
  alert: AlertRecord,
  ctx: { settings: CheckinSettings; devices: RingDevice[]; presence: Presence; now: number },
): string | null {
  const { settings, devices, presence } = ctx;
  const name = settings.residentName;
  const tz = settings.timezone;

  if (!settings.enabledRules[alert.rule]) return 'Closed because this rule was turned off.';
  if (isPaused(settings, ctx.now) && !RULES[alert.rule].runsWhilePaused) return 'Closed because alerts were paused.';

  const last = presence.lastActivity;
  const lastWhere = last ? devices.find((d) => d.id === last.deviceId)?.location : undefined;
  const seen = last ? `${lastWhere ? `${lastWhere.toLowerCase()}, ` : ''}${formatTime(last.occurredAt, tz)}` : '';
  const subject = alert.key.slice(alert.rule.length + 1);

  switch (alert.rule) {
    case 'no_morning_activity': {
      const dayStart = zonedToUtc(subject, DAY_START_MINUTE, tz);
      if (last && last.occurredAt >= dayStart) return `${name} is up and moving around (${seen}).`;
      return null;
    }
    case 'prolonged_inactivity':
      if (presence.state === 'away') return `${name} went out (${formatTime(presence.since!, tz)}).`;
      if (last && last.id !== subject) return `${name} is moving around again (${seen}).`;
      return null;
    case 'long_absence':
      if (presence.state !== 'away' || presence.outing?.leftEventId !== subject) {
        return last ? `${name} is back home (${seen}).` : `${name} is back home.`;
      }
      return null;
    case 'device_offline': {
      const d = devices.find((x) => x.id === subject);
      if (!d) return 'Device removed.';
      if (d.kind === 'webcam' && d.heartbeatAt == null) return `Closed: ${d.name} hasn't been connected yet.`;
      return `${d.name} is reporting again.`;
    }
    case 'connection_lost':
      return subject === 'ring'
        ? 'Connection to Ring restored; activity is coming in again.'
        : 'A camera is checking in again; monitoring is back on.';
    case 'low_battery': {
      const d = devices.find((x) => x.id === subject);
      return d ? `${d.name} battery is at ${d.battery ?? '?'}% now.` : 'Device removed.';
    }
    default:
      return null;
  }
}

export interface DayReport {
  settings: CheckinSettings;
  devices: RingDevice[];
  dateKey: string;
  isToday: boolean;
  /** Newest first. */
  events: RingEvent[];
  hourly: number[];
  baseline: Baseline;
  baselineReady: boolean;
  status: StatusSummary;
  openAlerts: AlertRecord[];
  dayAlerts: AlertRecord[];
  facts: DayFacts;
  lastCheckAt: number | null;
  monitoring: MonitoringState;
  /** Doorbell visits that day, oldest first. */
  visits: Visit[];
}

export function getDayReport(dateKey: string | undefined, now = Date.now()): DayReport {
  const settings = getSettings();
  const tz = settings.timezone;
  const today = localParts(now, tz).dateKey;
  const day = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) && dateKey <= today ? dateKey : today;
  const isToday = day === today;

  const dayStart = zonedToUtc(day, 0, tz);
  const dayEnd = zonedToUtc(addDays(day, 1), 0, tz);
  const events = listEvents(dayStart, Math.min(dayEnd, now + 1));
  const devices = listDevices();
  const baseline = loadBaseline(isToday ? now : dayEnd, settings, devices);
  const openAlerts = listAlerts({ openOnly: true });
  const dayAlerts = listAlerts({ since: dayStart, until: dayEnd });
  const presence = inferPresence(listEvents(now - 36 * HOUR, now + 1), devices, now);
  const monitoring = monitoringState(devices, now);
  const visits = getDayVisits(day, settings, devices);

  // Without incoming data, "looks normal" would be a guess. Open alerts still show as-is.
  let status = computeStatus({ now, settings, presence, openAlerts });
  if (status.status !== 'alert' && status.status !== 'watch' && monitoring.state !== 'ok' && monitoring.state !== 'demo') {
    const headline = {
      'no-sensors': 'No sensors set up yet',
      waiting: 'Waiting for the first check-in',
      down: 'Not receiving any data',
    }[monitoring.state];
    status = { status: 'unknown', headline, presence };
  }

  return {
    settings,
    devices,
    dateKey: day,
    isToday,
    events,
    hourly: hourlyCounts(events, day, tz, activityFilter(devices)),
    baseline,
    baselineReady: baseline.daysObserved >= MIN_BASELINE_DAYS,
    status,
    openAlerts,
    dayAlerts,
    facts: buildFacts({ settings, devices, day, isToday, now, events, baseline, alerts: dayAlerts, visits }),
    lastCheckAt: getKv<number>('last_check_at'),
    monitoring,
    visits,
  };
}

function buildFacts(input: {
  settings: CheckinSettings;
  devices: RingDevice[];
  day: string;
  isToday: boolean;
  now: number;
  events: RingEvent[];
  baseline: Baseline;
  alerts: AlertRecord[];
  visits: Visit[];
}): DayFacts {
  const { settings, devices, day, isToday, now, baseline } = input;
  const tz = settings.timezone;
  const counts = activityFilter(devices);
  const chrono = [...input.events].sort((a, b) => a.occurredAt - b.occurredAt);
  const activity = chrono.filter(counts);
  const daytime = activity.filter((e) => localParts(e.occurredAt, tz).minuteOfDay >= DAY_START_MINUTE);
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const trusted = baseline.daysObserved >= MIN_BASELINE_DAYS;

  const roomCounts = new Map<string, number>();
  for (const e of activity) {
    if (e.kind !== 'motion') continue;
    const loc = deviceById.get(e.deviceId)?.location ?? 'Unknown';
    roomCounts.set(loc, (roomCounts.get(loc) ?? 0) + 1);
  }

  let usualActivityByNow: number | null = null;
  if (trusted) {
    const nowLocal = localParts(now, tz);
    usualActivityByNow = Math.round(
      isToday
        ? baseline.hourlyMean.reduce(
            (sum, v, h) => sum + (h < nowLocal.hour ? v : h === nowLocal.hour ? (v * nowLocal.minute) / 60 : 0),
            0,
          )
        : baseline.hourlyMean.reduce((a, b) => a + b, 0),
    );
  }

  return {
    residentName: settings.residentName,
    dateLabel: new Date(zonedToUtc(day, 12 * 60, tz)).toLocaleDateString('en-US', {
      timeZone: tz,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }),
    nowLabel: formatTime(now, tz),
    isToday,
    firstActivity: daytime[0] ? formatTime(daytime[0].occurredAt, tz) : null,
    usualFirstActivity: trusted ? formatMinuteOfDay(wakeDeadline(baseline, settings).usual) : null,
    lastActivity: activity.length ? formatTime(activity[activity.length - 1].occurredAt, tz) : null,
    activityCount: activity.length,
    usualActivityByNow,
    rooms: [...roomCounts.entries()]
      .map(([location, count]) => ({ location, count }))
      .sort((a, b) => b.count - a.count),
    outings: detectOutings(chrono, devices, isToday ? now : zonedToUtc(addDays(day, 1), 0, tz)).map((o) => ({
      left: formatTime(o.left, tz),
      returned: o.returned ? formatTime(o.returned, tz) : null,
    })),
    visitors: chrono.filter((e) => e.kind === 'ding').length,
    visits: input.visits.map((v) => ({
      time: formatTime(v.start, tz),
      kind: v.label ? `${VISIT_KIND_LABEL[v.kind]}: ${v.label}` : VISIT_KIND_LABEL[v.kind],
      doorOpened: v.answered,
    })),
    alerts: input.alerts.map((a) => ({
      rule: a.rule,
      title: a.title,
      severity: a.severity,
      open: isOpen(a),
      resolution: a.resolutionNote,
    })),
    pausedUntil: isPaused(settings, now) ? formatDateTime(settings.pausedUntil!, tz) : null,
    pausedByResident: isPaused(settings, now) && settings.pausedBy === 'resident',
  };
}

interface CachedSummary extends DaySummary {
  at: number;
  signature: string;
}

/** Narrative summary for a day. Bedrock results are cached so page loads don't each call the model. */
export async function getDaySummary(report: DayReport, now = Date.now()): Promise<DaySummary> {
  if (!isBedrockEnabled()) return summarizeDay(report.facts);

  const signature = JSON.stringify([report.facts.alerts, report.facts.pausedUntil, report.isToday ? null : report.facts.activityCount]);
  const key = `summary:${report.dateKey}`;
  const cached = getKv<CachedSummary>(key);
  const fresh = cached && cached.signature === signature && (!report.isToday || now - cached.at < 30 * MINUTE);
  if (fresh) return { text: cached.text, source: cached.source };

  const summary = await summarizeDay(report.facts);
  if (summary.source === 'bedrock') setKv(key, { ...summary, at: now, signature });
  return summary;
}
