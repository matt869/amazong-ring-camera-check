import type { DayReport } from './checkin';
import { getDemoState } from './ring/events';
import { DEMO_SCENARIOS, generateDemoEvents, type DemoScenario } from './ring/mock';
import type { RingDevice } from './ring/types';
import { activityFilter, computeBaseline } from './routine/baseline';
import { detectAnomalies } from './routine/detect';
import type { CheckinSettings, RuleId } from './routine/rules';
import { addDays, localParts, zonedToUtc } from './routine/time';

/**
 * Demo scenarios play out on the real clock: a missed morning can only show
 * once the morning has passed, a night-time door at 2:40am. Applied at the
 * "wrong" hour, a scenario looks like it did nothing. This works out when its
 * alert will actually appear, so the dashboard can say so.
 */

/** The alert each scenario exists to show. The visitor and drift ones look back weeks, so they show at once. */
export const SCENARIO_RULE: Partial<Record<DemoScenario, RuleId>> = {
  'late-start': 'no_morning_activity',
  'quiet-morning': 'no_morning_activity',
  'inactive-afternoon': 'prolonged_inactivity',
  'long-outing': 'long_absence',
  'night-door': 'night_door',
};

const STEP_MS = 5 * 60_000;

/**
 * When the scenario's alert first fires later today, by running the same
 * rules over the rest of the simulated day. Null if it won't fire today
 * (e.g. 'late-start' applied in the small hours, before any morning exists).
 */
export function predictScenarioAlert(opts: {
  now: number;
  settings: CheckinSettings;
  devices: RingDevice[];
  scenario: DemoScenario;
  anchor: number;
}): number | null {
  const rule = SCENARIO_RULE[opts.scenario];
  if (!rule) return null;
  const { now, settings, devices } = opts;
  const tz = settings.timezone;
  const endOfDay = zonedToUtc(addDays(localParts(now, tz).dateKey, 1), 0, tz);
  const events = generateDemoEvents({
    now: endOfDay - 1,
    timezone: tz,
    days: settings.baselineDays + 2,
    scenario: opts.scenario,
    anchor: opts.anchor,
  });
  // The routine is learned from past days only, so one baseline serves the whole day.
  const baseline = computeBaseline(events, { now, timezone: tz, days: settings.baselineDays, isActivity: activityFilter(devices) });
  // Unpaused, with every rule on: this is about when the scenario shows, not today's switches.
  const sim: CheckinSettings = { ...settings, pausedUntil: null, enabledRules: { ...settings.enabledRules, [rule]: true } };

  for (let t = now; t < endOfDay; t += STEP_MS) {
    const recent = events.filter((e) => e.occurredAt <= t && e.occurredAt > t - 36 * 60 * 60_000);
    const fires = detectAnomalies({ now: t, settings: sim, baseline, recentEvents: recent, devices, dataFlowing: true }).some(
      (c) => c.rule === rule,
    );
    if (fires) return t;
  }
  return null;
}

export interface PendingScenario {
  label: string;
  rule: RuleId;
  /** When its alert will fire today, or null if it won't today. */
  at: number | null;
}

/** The applied scenario, if its alert hasn't appeared yet today. */
export function pendingScenarioAlert(report: Pick<DayReport, 'settings' | 'devices' | 'dayAlerts'>, now: number): PendingScenario | null {
  const { scenario, anchor } = getDemoState();
  const rule = SCENARIO_RULE[scenario];
  if (!rule || report.dayAlerts.some((a) => a.rule === rule)) return null;
  const at = predictScenarioAlert({ now, settings: report.settings, devices: report.devices, scenario, anchor });
  return { label: DEMO_SCENARIOS[scenario], rule, at };
}
