/**
 * Check-in rules and their tunable thresholds. Everything a caregiver can
 * adjust on the settings page lives in `CheckinSettings`.
 */

export type RuleId =
  | 'no_morning_activity'
  | 'prolonged_inactivity'
  | 'long_absence'
  | 'night_door'
  | 'device_offline'
  | 'low_battery'
  | 'connection_lost'
  | 'unexpected_visitors';

export type Severity = 'info' | 'warning' | 'critical';

export interface CheckinSettings {
  /** Name of the person being checked in on, used in messages. */
  residentName: string;
  timezone: string;
  /** Alert if no activity this many minutes after their usual first activity. */
  wakeGraceMinutes: number;
  /** Used before a baseline exists: latest normal time for first activity (minutes after midnight). */
  fallbackWakeMinute: number;
  /** Alert after this many hours without activity during normally-active hours. */
  inactivityHours: number;
  /** Alert when they've been out of the house this long. */
  awayHours: number;
  /** Door openings between these times (minutes after midnight) raise an alert. */
  nightStartMinute: number;
  nightEndMinute: number;
  /** Battery percentage at or below which a device is flagged. */
  lowBatteryPercent: number;
  /** Days of history used to learn the routine. */
  baselineDays: number;
  /** Re-send an unacknowledged urgent alert after this many minutes (0 = never). */
  reminderMinutes: number;
  /** Alerts are paused until this time (epoch ms), e.g. while they're away visiting. */
  pausedUntil: number | null;
  /**
   * Who paused: the family ("staying with us this week"), or the resident from
   * their own page (a privacy pause, during which activity isn't recorded either).
   */
  pausedBy: 'family' | 'resident' | null;
  /** Per-rule on/off switches. */
  enabledRules: Record<RuleId, boolean>;

  // --- Escalation ladder: resident first, then family, then a neighbor ---------
  /** The resident's own mobile (E.164, e.g. +15551234567). Empty = skip straight to family. */
  residentPhone: string;
  /** Text the resident a gentle "are you OK?" before telling family. */
  checkInFirst: boolean;
  /** Tell family if the resident hasn't replied this many minutes after the check-in text. */
  caregiverAfterMinutes: number;
  /** Ask the neighbor this many minutes after the alert began, if nobody has responded. */
  neighborAfterMinutes: number;
  /** Someone nearby who can knock on the door. Empty phone = no neighbor step. */
  neighborName: string;
  neighborPhone: string;
  /**
   * What a neighbor calls them ("Ana"). `residentName` is the family's own
   * name for them ("Mom"), which reads wrong in a message to someone else.
   */
  residentGivenName: string;

  // --- Weekly family digest ----------------------------------------------------
  digestEnabled: boolean;
  /** 0 = Sunday ... 6 = Saturday, in the home's timezone. */
  digestWeekday: number;
  /** Minutes after midnight. */
  digestMinute: number;

  // --- Visitors ----------------------------------------------------------------
  /** Visits the family expects, one per line: "Home aide: Tue Thu 9:30-11:00". */
  expectedVisits: string;
  /**
   * The resident agreed to one doorbell picture being attached when an alert
   * goes out. Only changeable from the resident's own page.
   */
  snapshotsAllowed: boolean;
}

export interface RuleInfo {
  label: string;
  description: string;
  severity: Severity;
  /**
   * Clears by itself once the condition is over (they got up, moved again,
   * came home, device came back). Others stay until someone acknowledges them.
   */
  autoResolves: boolean;
  /** Still evaluated while alerts are paused (device health isn't about the resident). */
  runsWhilePaused: boolean;
  /** Escalation ladder: the resident gets a gentle check-in text before family is told. */
  asksResidentFirst: boolean;
  /** Escalation ladder: a neighbor is asked to knock if nobody has responded. */
  asksNeighbor: boolean;
}

export const RULES: Record<RuleId, RuleInfo> = {
  no_morning_activity: {
    label: 'No morning activity',
    description: 'No movement detected well past the usual time they get up.',
    severity: 'critical',
    autoResolves: true,
    runsWhilePaused: false,
    asksResidentFirst: true,
    asksNeighbor: true,
  },
  prolonged_inactivity: {
    label: 'Long quiet period at home',
    description: 'No movement for several hours during a normally active part of the day.',
    severity: 'warning',
    autoResolves: true,
    runsWhilePaused: false,
    asksResidentFirst: true,
    asksNeighbor: true,
  },
  long_absence: {
    label: 'Out longer than expected',
    description: 'Out of the house for a long time, or not back by nighttime.',
    severity: 'warning',
    autoResolves: true,
    runsWhilePaused: false,
    asksResidentFirst: true,
    asksNeighbor: false,
  },
  night_door: {
    label: 'Door opened at night',
    description: 'An exterior door opened during overnight hours.',
    severity: 'warning',
    autoResolves: false,
    runsWhilePaused: false,
    asksResidentFirst: false,
    asksNeighbor: false,
  },
  device_offline: {
    label: 'Device offline',
    description: 'A Ring device stopped reporting, so activity may be missed.',
    severity: 'info',
    autoResolves: true,
    runsWhilePaused: true,
    asksResidentFirst: false,
    asksNeighbor: false,
  },
  low_battery: {
    label: 'Low battery',
    description: 'A Ring device battery is running low.',
    severity: 'info',
    autoResolves: true,
    runsWhilePaused: true,
    asksResidentFirst: false,
    asksNeighbor: false,
  },
  connection_lost: {
    label: 'Monitoring offline',
    description: 'No sensor is reporting (camera unplugged, Wi-Fi down, or Ring unreachable), so other alerts can’t fire.',
    severity: 'warning',
    autoResolves: true,
    runsWhilePaused: true,
    asksResidentFirst: false,
    asksNeighbor: false,
  },
  unexpected_visitors: {
    label: 'Unexpected visitors',
    description:
      'Several unexpected callers at the door in a week, more than usual. Repeat visits are a common pattern in scams that target older adults.',
    severity: 'warning',
    autoResolves: false,
    runsWhilePaused: false,
    asksResidentFirst: false,
    asksNeighbor: false,
  },
};

export const DEFAULT_SETTINGS: CheckinSettings = {
  residentName: 'Mom',
  // The computer running this is usually in (or near) the home; Settings can change it.
  timezone: process.env.HOME_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  wakeGraceMinutes: 90,
  fallbackWakeMinute: 10 * 60,
  inactivityHours: 4,
  awayHours: 6,
  nightStartMinute: 23 * 60,
  nightEndMinute: 5 * 60,
  lowBatteryPercent: 20,
  baselineDays: 14,
  reminderMinutes: 30,
  pausedUntil: null,
  pausedBy: null,
  residentPhone: '',
  checkInFirst: true,
  caregiverAfterMinutes: 15,
  neighborAfterMinutes: 30,
  neighborName: '',
  neighborPhone: '',
  residentGivenName: '',
  digestEnabled: true,
  digestWeekday: 0,
  digestMinute: 18 * 60,
  expectedVisits: '',
  snapshotsAllowed: false,
  enabledRules: {
    no_morning_activity: true,
    prolonged_inactivity: true,
    long_absence: true,
    night_door: true,
    device_offline: true,
    low_battery: true,
    connection_lost: true,
    unexpected_visitors: true,
  },
};

export function withDefaults(partial: Partial<CheckinSettings> | null | undefined): CheckinSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    enabledRules: { ...DEFAULT_SETTINGS.enabledRules, ...partial?.enabledRules },
  };
}

export function isPaused(settings: CheckinSettings, now: number): boolean {
  return settings.pausedUntil != null && settings.pausedUntil > now;
}

/** The resident has paused sharing from their own page (activity isn't recorded meanwhile). */
export function isPrivacyPaused(settings: CheckinSettings, now: number): boolean {
  return isPaused(settings, now) && settings.pausedBy === 'resident';
}

/** Their name as people outside the family use it: "Ana" rather than "Mom". */
export function nameForOthers(settings: CheckinSettings): string {
  return settings.residentGivenName.trim() || settings.residentName;
}

/** A phone number SNS can text directly: E.164, e.g. +15551234567. */
export function isPhoneNumber(v: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(v);
}

/** True if `minuteOfDay` falls in [start, end), handling windows that wrap midnight. */
export function inWindow(minuteOfDay: number, start: number, end: number): boolean {
  return start <= end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}
