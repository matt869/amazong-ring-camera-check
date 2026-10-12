import type { RingDevice, RingEvent } from '../ring/types';
import { activityFilter, DAY_START_MINUTE, MIN_BASELINE_DAYS, type Baseline } from './baseline';
import { inferPresence, type Presence } from './presence';
import { RULES, inWindow, isPaused, type CheckinSettings, type RuleId, type Severity } from './rules';
import { formatDuration, formatMinuteOfDay, formatTime, localParts } from './time';

export interface AlertCandidate {
  /** Stable dedupe key: the same situation always produces the same key. */
  key: string;
  rule: RuleId;
  severity: Severity;
  title: string;
  message: string;
  /** When the triggering condition happened (or was observed). */
  occurredAt: number;
}

export interface DetectInput {
  now: number;
  settings: CheckinSettings;
  baseline: Baseline;
  /** Events from at least the last 24 hours (36 is better, for overnight outings). */
  recentEvents: RingEvent[];
  devices: RingDevice[];
  /**
   * False when no data can be arriving (no devices yet, or the Ring
   * connection is down). Silence then means nothing about the resident, so
   * only device-health rules run.
   */
  dataFlowing?: boolean;
}

/** Hours assumed active before enough history exists to learn them. */
const FALLBACK_ACTIVE_HOURS = { start: 8, end: 21 };

/** An indoor motion device silent this long, while other rooms are active, is flagged. */
const STALE_DEVICE_MS = 48 * 60 * 60_000;

/** Latest minute-of-day by which they'd normally be up, given what's been learned. */
export function wakeDeadline(baseline: Baseline, settings: CheckinSettings): { usual: number; deadline: number } {
  const trusted = baseline.daysObserved >= MIN_BASELINE_DAYS && baseline.typicalFirstMinute != null;
  if (!trusted) {
    return { usual: settings.fallbackWakeMinute, deadline: settings.fallbackWakeMinute + settings.wakeGraceMinutes };
  }
  const usual = baseline.typicalFirstMinute!;
  // Someone whose mornings vary a lot gets more slack than the fixed grace period.
  const lateNormal = (baseline.lateFirstMinute ?? usual) + 15;
  return { usual, deadline: Math.max(usual + settings.wakeGraceMinutes, lateNormal) };
}

/** Rules about the resident, which say nothing useful while no data can arrive. */
const RESIDENT_RULES = new Set<RuleId>([
  'no_morning_activity',
  'prolonged_inactivity',
  'long_absence',
  'night_door',
  'unexpected_visitors',
]);

/** Whether a rule may raise an alert right now: switched on, not paused, and data is flowing if it needs it. */
export function ruleActive(rule: RuleId, settings: CheckinSettings, now: number, dataFlowing?: boolean): boolean {
  if (!settings.enabledRules[rule]) return false;
  if (isPaused(settings, now) && !RULES[rule].runsWhilePaused) return false;
  return !(dataFlowing === false && RESIDENT_RULES.has(rule));
}

export function detectAnomalies(input: DetectInput): AlertCandidate[] {
  const { now, settings, baseline, devices } = input;
  const tz = settings.timezone;
  const name = settings.residentName;
  const nowLocal = localParts(now, tz);
  const trusted = baseline.daysObserved >= MIN_BASELINE_DAYS;
  const counts = activityFilter(devices);

  const recent = input.recentEvents
    .filter((e) => e.occurredAt <= now && e.occurredAt > now - 36 * 60 * 60_000)
    .sort((a, b) => a.occurredAt - b.occurredAt);
  const last24h = recent.filter((e) => e.occurredAt > now - 24 * 60 * 60_000);
  const activity = last24h.filter(counts);
  const activityToday = activity.filter((e) => {
    const p = localParts(e.occurredAt, tz);
    return p.dateKey === nowLocal.dateKey && p.minuteOfDay >= DAY_START_MINUTE;
  });
  const presence: Presence = inferPresence(recent, devices, now);

  const out: AlertCandidate[] = [];
  const add = (rule: RuleId, key: string, title: string, message: string, occurredAt: number) => {
    if (!ruleActive(rule, settings, now, input.dataFlowing)) return;
    out.push({ key: `${rule}:${key}`, rule, severity: RULES[rule].severity, title, message, occurredAt });
  };

  // 1. Nothing yet this morning, past the late end of their normal wake-up time.
  //    If they're out of the house, the absence rule speaks instead.
  const { usual, deadline } = wakeDeadline(baseline, settings);
  if (activityToday.length === 0 && nowLocal.minuteOfDay >= deadline && presence.state !== 'away') {
    add(
      'no_morning_activity',
      nowLocal.dateKey,
      `No activity from ${name} yet this morning`,
      `${name} is usually up around ${formatMinuteOfDay(usual)}, but there has been no movement at home today ` +
        `(it's now ${formatMinuteOfDay(nowLocal.minuteOfDay)}).`,
      now,
    );
  }

  // 2. A long quiet stretch at home during hours that are normally active.
  //    Only once the day has started; before that, rule 1 owns the silence.
  const last = activity[activity.length - 1];
  if (last && activityToday.length > 0 && presence.state === 'home') {
    const gap = now - last.occurredAt;
    const threshold = Math.max(
      settings.inactivityHours * 60 * 60_000,
      // Don't flag gaps that are routinely this long on a normal day.
      trusted && baseline.typicalLongestGapMs ? baseline.typicalLongestGapMs * 1.25 : 0,
    );
    const hourActive = trusted
      ? baseline.activeHours[nowLocal.hour]
      : nowLocal.hour >= FALLBACK_ACTIVE_HOURS.start && nowLocal.hour < FALLBACK_ACTIVE_HOURS.end;
    if (gap >= threshold && hourActive) {
      const where = devices.find((d) => d.id === last.deviceId)?.location;
      add(
        'prolonged_inactivity',
        last.id,
        `${name} has been quiet for ${formatDuration(gap)}`,
        `No movement at home since ${formatTime(last.occurredAt, tz)}${where ? ` (${where})` : ''}. ` +
          `This is normally an active time of day.`,
        now,
      );
    }
  }

  // 3. Out of the house for a long time, or still out when night falls.
  if (presence.state === 'away' && presence.outing) {
    const awayMs = now - presence.outing.left;
    const leftAt = formatTime(presence.outing.left, tz);
    const atNight = inWindow(nowLocal.minuteOfDay, settings.nightStartMinute, settings.nightEndMinute);
    if (awayMs >= settings.awayHours * 60 * 60_000 || atNight) {
      add(
        'long_absence',
        presence.outing.leftEventId,
        atNight ? `${name} isn't home yet` : `${name} has been out for ${formatDuration(awayMs)}`,
        atNight
          ? `A door opened at ${leftAt} and there's been no movement inside since. It's now ${formatMinuteOfDay(nowLocal.minuteOfDay)}.`
          : `A door opened at ${leftAt} and there's been no movement inside since, longer than a usual outing.`,
        now,
      );
    }
  }

  // 4. Exterior door opened overnight.
  for (const e of last24h) {
    if (e.kind !== 'door_open') continue;
    const p = localParts(e.occurredAt, tz);
    if (inWindow(p.minuteOfDay, settings.nightStartMinute, settings.nightEndMinute)) {
      const device = devices.find((d) => d.id === e.deviceId);
      add(
        'night_door',
        e.id,
        `${device?.name ?? 'A door'} opened at ${formatTime(e.occurredAt, tz)}`,
        `${device?.name ?? 'An exterior door'} opened during overnight hours, when the house is normally quiet.`,
        e.occurredAt,
      );
    }
  }

  // 5 & 6. Device health: blind spots mean missed activity.
  for (const d of devices) {
    // A webcam that has never checked in is still being set up, not offline.
    if (d.kind === 'webcam' && d.heartbeatAt == null) continue;
    // `online` is Ring's own connection status. `lastSeen` is only the last *event*, so
    // silence alone means nothing for a door; for an indoor motion sensor it's suspicious
    // when the other rooms are busy.
    const silentWhileOthersActive =
      (d.kind === 'motion_sensor' || d.kind === 'camera') &&
      d.countsAsActivity &&
      d.lastSeen != null &&
      now - d.lastSeen > STALE_DEVICE_MS &&
      activity.some((e) => e.deviceId !== d.id);
    if (!d.online) {
      add(
        'device_offline',
        d.id,
        `${d.name} is offline`,
        d.kind === 'webcam'
          ? `${d.name} (${d.location}) stopped checking in. Make sure the device is on, plugged in, and the sensor page is open.`
          : `Ring reports ${d.name} (${d.location}) as disconnected. Activity in that area won't be seen.`,
        now,
      );
    } else if (silentWhileOthersActive) {
      add(
        'device_offline',
        d.id,
        `${d.name} has gone quiet`,
        `${d.name} (${d.location}) hasn't picked up anything for ${formatDuration(now - d.lastSeen!)} while other rooms have. ` +
          `It may be offline, blocked, or out of battery.`,
        now,
      );
    }
    if (d.battery != null && d.battery <= settings.lowBatteryPercent) {
      add(
        'low_battery',
        d.id,
        `${d.name} battery at ${d.battery}%`,
        `Replace or recharge the battery in ${d.name} (${d.location}) soon.`,
        now,
      );
    }
  }

  return out;
}

export type OverallStatus = 'ok' | 'watch' | 'alert' | 'paused' | 'unknown';

export interface StatusSummary {
  status: OverallStatus;
  headline: string;
  presence: Presence;
}

export function computeStatus(input: {
  now: number;
  settings: CheckinSettings;
  presence: Presence;
  openAlerts: { severity: Severity; residentAt?: number | null; caregiverAt?: number | null }[];
}): StatusSummary {
  const { settings, openAlerts, presence, now } = input;
  const name = settings.residentName;
  // The ladder is still giving them time to answer a check-in text: not yet an emergency.
  const awaitingReply = (a: (typeof openAlerts)[number]) => a.residentAt != null && a.caregiverAt == null;

  if (openAlerts.some((a) => a.severity === 'critical' && !awaitingReply(a))) {
    return { status: 'alert', headline: `Check on ${name}`, presence };
  }
  if (openAlerts.some((a) => a.severity === 'critical')) {
    return { status: 'watch', headline: `Checking in with ${name}`, presence };
  }
  if (openAlerts.some((a) => a.severity === 'warning')) {
    return { status: 'watch', headline: 'Something unusual today', presence };
  }
  if (isPaused(settings, now)) {
    const headline = settings.pausedBy === 'resident' ? `${name} has paused sharing` : 'Alerts are paused';
    return { status: 'paused', headline, presence };
  }
  if (presence.state === 'unknown') {
    return { status: 'unknown', headline: 'No activity recorded yet', presence };
  }
  return { status: 'ok', headline: `${name}'s day looks normal`, presence };
}
