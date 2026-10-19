import { describe, expect, it } from 'vitest';
import { activityFilter, computeBaseline, emptyBaseline, percentile } from '../lib/routine/baseline';
import { computeStatus, detectAnomalies, wakeDeadline } from '../lib/routine/detect';
import { inferPresence } from '../lib/routine/presence';
import { inWindow, type CheckinSettings } from '../lib/routine/rules';
import { addDays, formatDuration, formatWhen, localParts, zonedToUtc } from '../lib/routine/time';
import { generateDemoEvents } from '../lib/ring/mock';
import type { RingEvent } from '../lib/ring/types';
import { at, devices, ev, history, motion, settings, TODAY, TZ } from './helpers';

/** Run detection at `now` with 14 days of normal history plus `today` (or the normal routine). */
function run(now: number, today?: RingEvent[], overrides: Partial<CheckinSettings> = {}) {
  const events = today ? [...history(now), ...today] : generateDemoEvents({ now, timezone: TZ, days: 14 });
  const baseline = computeBaseline(events, { now, timezone: TZ, days: 14, isActivity: activityFilter(devices) });
  return detectAnomalies({ now, settings: { ...settings, ...overrides }, baseline, recentEvents: events, devices });
}
const rules = (alerts: { rule: string }[]) => alerts.map((a) => a.rule).filter((r) => r !== 'low_battery');

describe('time helpers', () => {
  it('round-trips wall-clock times across DST', () => {
    // US DST began 2026-03-08; 9:30am local is 13:30Z after it.
    expect(new Date(zonedToUtc('2026-03-18', 9 * 60 + 30, TZ)).toISOString()).toBe('2026-03-18T13:30:00.000Z');
    expect(new Date(zonedToUtc('2026-03-01', 9 * 60 + 30, TZ)).toISOString()).toBe('2026-03-01T14:30:00.000Z');
    expect(localParts(zonedToUtc('2026-03-18', 75, TZ), TZ).minuteOfDay).toBe(75);
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles night windows that wrap midnight', () => {
    expect(inWindow(23 * 60 + 30, 23 * 60, 5 * 60)).toBe(true);
    expect(inWindow(2 * 60, 23 * 60, 5 * 60)).toBe(true);
    expect(inWindow(12 * 60, 23 * 60, 5 * 60)).toBe(false);
  });

  it('formats long durations in days', () => {
    const min = 60_000;
    expect(formatDuration(45 * min)).toBe('45m');
    expect(formatDuration(26 * 60 * min + 5 * min)).toBe('26h 5m');
    expect(formatDuration(109 * 60 * min + 37 * min)).toBe('4d 13h');
    expect(formatDuration(72 * 60 * min)).toBe('3d');
  });

  it('dates a time that was not today, so it never reads as tonight', () => {
    expect(formatWhen(at('22:06'), TZ, at('23:00'))).toBe('10:06pm');
    expect(formatWhen(at('22:06', '2026-03-11'), TZ, at('21:47'))).toBe('Wed, Mar 11, 10:06pm');
  });
});

describe('the day monitoring starts', () => {
  it("doesn't call a morning missed that nothing was watching", () => {
    const now = at('12:30');
    const events = history(now);
    const baseline = computeBaseline(events, { now, timezone: TZ, days: 14, isActivity: activityFilter(devices) });
    const detect = (monitoringSince: number) =>
      rules(detectAnomalies({ now, settings, baseline, recentEvents: events, devices, monitoringSince }));
    // A webcam set up at noon today never saw the morning.
    expect(detect(at('12:00'))).not.toContain('no_morning_activity');
    // Watching since before today began: the missed morning is real.
    expect(detect(at('21:00', addDays(TODAY, -1)))).toContain('no_morning_activity');
  });
});

describe('computeBaseline', () => {
  it('learns a morning wake-up time and active daytime hours', () => {
    const now = at('12:00');
    const baseline = computeBaseline(history(now), { now, timezone: TZ, days: 14, isActivity: activityFilter(devices) });
    expect(baseline.daysObserved).toBe(14);
    expect(baseline.typicalFirstMinute).toBeGreaterThan(6 * 60);
    expect(baseline.typicalFirstMinute).toBeLessThan(8 * 60);
    expect(baseline.lateFirstMinute!).toBeGreaterThanOrEqual(baseline.typicalFirstMinute!);
    expect(baseline.activeHours[8]).toBe(true);
    expect(baseline.activeHours[3]).toBe(false);
  });

  it('excludes today, doorbell presses and devices that do not count', () => {
    const now = at('12:00');
    const yesterday = addDays(TODAY, -1);
    const events = [
      motion('t1', at('08:00')),
      ev('d1', 'ding', 'front-door', at('09:00', yesterday)),
      ev('d2', 'motion', 'front-door', at('09:01', yesterday)),
    ];
    expect(computeBaseline(events, { now, timezone: TZ, days: 14, isActivity: activityFilter(devices) }).daysObserved).toBe(0);
  });

  it('computes percentiles with interpolation', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(91);
    expect(percentile([], 0.9)).toBeNull();
  });
});

describe('wakeDeadline', () => {
  it('uses the fallback before a routine is learned', () => {
    expect(wakeDeadline(emptyBaseline(), settings)).toEqual({ usual: 600, deadline: 690 });
  });

  it('gives irregular sleepers more slack than the fixed grace period', () => {
    const base = { ...emptyBaseline(), daysObserved: 14, typicalFirstMinute: 420 };
    expect(wakeDeadline({ ...base, lateFirstMinute: 440 }, settings).deadline).toBe(510); // 7:00 + 90m
    expect(wakeDeadline({ ...base, lateFirstMinute: 600 }, settings).deadline).toBe(615); // late normal 10:00 + 15m
  });
});

describe('detectAnomalies', () => {
  it('raises nothing (besides the demo low battery) on a normal day', () => {
    for (const t of ['07:30', '10:30', '15:00', '20:00']) expect(rules(run(at(t)))).toEqual([]);
  });

  it('flags a missed morning once past the deadline', () => {
    const morning = run(at('10:30'), []).find((a) => a.rule === 'no_morning_activity');
    expect(morning?.severity).toBe('critical');
    expect(morning?.key).toBe(`no_morning_activity:${TODAY}`);
    expect(morning?.title).toContain('Ana');
  });

  it('does not flag the morning before the deadline', () => {
    expect(rules(run(at('07:45'), []))).toEqual([]);
  });

  it('ignores overnight motion when deciding if the day has started', () => {
    expect(rules(run(at('10:30'), [motion('night', at('02:15'), 'bedroom-motion')]))).toContain('no_morning_activity');
  });

  it('does not let doorbell motion (a delivery driver) count as them being up', () => {
    const today = [ev('pkg', 'motion', 'front-door', at('09:30')), ev('ding', 'ding', 'front-door', at('09:31'))];
    expect(rules(run(at('10:30'), today))).toContain('no_morning_activity');
  });

  it('flags a long quiet stretch at home during normally active hours', () => {
    const quiet = run(at('15:30'), [motion('a', at('07:05')), motion('b', at('09:40'))]);
    expect(rules(quiet)).toEqual(['prolonged_inactivity']);
    expect(quiet.find((a) => a.rule === 'prolonged_inactivity')?.key).toBe('prolonged_inactivity:b');
  });

  it('does not flag quiet once they have gone to bed', () => {
    const today = [motion('a', at('07:05')), motion('b', at('22:05'), 'bedroom-motion')];
    expect(rules(run(at('23:59'), today))).toEqual([]);
  });

  it('treats a long outing as an absence, not as inactivity at home', () => {
    const today = [motion('a', at('07:05')), ev('out', 'door_open', 'back-door', at('08:00')), ev('c', 'door_close', 'back-door', at('08:01'))];
    expect(rules(run(at('12:00'), today))).toEqual([]); // 4h out: fine
    const late = run(at('14:30'), today);
    expect(rules(late)).toEqual(['long_absence']);
    expect(late.find((a) => a.rule === 'long_absence')?.key).toBe('long_absence:out');
  });

  it('flags not being home when night starts, even after a short outing', () => {
    const today = [motion('a', at('07:05')), motion('b', at('20:55')), ev('out', 'door_open', 'back-door', at('21:00'))];
    const night = run(at('23:30'), today).find((a) => a.rule === 'long_absence');
    expect(night?.title).toBe("Ana isn't home yet");
  });

  it('flags a door opening at night', () => {
    const night = run(at('03:00'), [ev('door1', 'door_open', 'back-door', at('02:40'))]).find((a) => a.rule === 'night_door');
    expect(night?.key).toBe('night_door:door1');
    expect(night?.title).toContain('Back Door');
  });

  it('flags offline devices and low batteries, keyed per device', () => {
    const now = at('12:00');
    const alerts = detectAnomalies({
      now,
      settings,
      baseline: emptyBaseline(),
      recentEvents: [motion('m', at('09:00'))],
      devices: [
        { ...devices[0], online: false },
        { ...devices[1], battery: 10 },
        { ...devices[2], lastSeen: now - 50 * 3_600_000 },
        { ...devices[3], lastSeen: now - 20 * 3_600_000, battery: 80 },
        { ...devices[4], lastSeen: now - 72 * 3_600_000 }, // back door: unused doors aren't "offline"
      ],
    });
    expect(alerts.filter((a) => a.rule === 'device_offline').map((a) => a.key)).toEqual([
      `device_offline:${devices[0].id}`,
      `device_offline:${devices[2].id}`,
    ]);
    expect(alerts.find((a) => a.rule === 'low_battery')?.key).toBe(`low_battery:${devices[1].id}`);
  });

  it('respects disabled rules', () => {
    const off = run(at('10:30'), [], { enabledRules: { ...settings.enabledRules, no_morning_activity: false } });
    expect(rules(off)).toEqual([]);
  });

  it('keeps only device-health rules while paused', () => {
    const now = at('10:30');
    const paused = run(now, [], { pausedUntil: now + 86_400_000 });
    expect(paused.map((a) => a.rule)).toEqual(['low_battery']);
    const expired = run(now, [], { pausedUntil: now - 1 });
    expect(rules(expired)).toContain('no_morning_activity');
  });

  it('says nothing about the resident when no data can be arriving', () => {
    const now = at('10:30');
    const events = history(now);
    const baseline = computeBaseline(events, { now, timezone: TZ, days: 14, isActivity: activityFilter(devices) });
    const alerts = detectAnomalies({ now, settings, baseline, recentEvents: events, devices, dataFlowing: false });
    expect(alerts.map((a) => a.rule)).toEqual(['low_battery']); // device health still reported
  });

  it('uses the fallback wake time before a routine is learned', () => {
    const empty = emptyBaseline();
    const check = (now: number) => detectAnomalies({ now, settings, baseline: empty, recentEvents: [], devices: [] });
    expect(check(at('11:00'))).toEqual([]); // fallback 10:00 + 90 min = 11:30
    expect(check(at('11:31')).map((a) => a.rule)).toEqual(['no_morning_activity']);
  });
});

describe('computeStatus', () => {
  const now = at('12:00');
  const presence = inferPresence([motion('x', at('08:00'))], devices, now);
  const base = { now, settings, presence };

  it('is alert for critical, watch for warnings, ok otherwise', () => {
    expect(computeStatus({ ...base, openAlerts: [{ severity: 'critical' }] }).status).toBe('alert');
    expect(computeStatus({ ...base, openAlerts: [{ severity: 'warning' }] }).status).toBe('watch');
    expect(computeStatus({ ...base, openAlerts: [{ severity: 'info' }] }).status).toBe('ok');
  });

  it('stays calm while the resident has a check-in text to answer', () => {
    const waiting = computeStatus({ ...base, openAlerts: [{ severity: 'critical', residentAt: now, caregiverAt: null }] });
    expect(waiting).toMatchObject({ status: 'watch', headline: 'Checking in with Ana' });
    const escalated = computeStatus({ ...base, openAlerts: [{ severity: 'critical', residentAt: now, caregiverAt: now + 1 }] });
    expect(escalated.status).toBe('alert');
  });

  it('shows paused when nothing is open and alerts are paused', () => {
    const s = computeStatus({ ...base, settings: { ...settings, pausedUntil: now + 1000 }, openAlerts: [] });
    expect(s.status).toBe('paused');
  });

  it('is unknown with no data at all', () => {
    const empty = inferPresence([], devices, now);
    expect(computeStatus({ ...base, presence: empty, openAlerts: [] }).status).toBe('unknown');
  });
});

describe('templateSummary', () => {
  it('reads naturally for a late start that has cleared', async () => {
    const { templateSummary } = await import('../lib/aws/bedrock');
    const text = templateSummary({
      residentName: 'Ana',
      dateLabel: 'Wednesday, March 18',
      nowLabel: '12:30pm',
      isToday: true,
      firstActivity: '12:21pm',
      usualFirstActivity: '7:07am',
      lastActivity: '12:21pm',
      activityCount: 1,
      usualActivityByNow: 18,
      rooms: [{ location: 'Bedroom', count: 1 }],
      outings: [],
      visitors: 0,
      visits: [],
      pausedByResident: false,
      alerts: [
        {
          rule: 'no_morning_activity',
          title: 'No activity from Ana yet this morning',
          severity: 'critical',
          open: false,
          resolution: 'Ana is up and moving around (bedroom, 12:21pm).',
        },
      ],
      pausedUntil: null,
    });
    expect(text).toContain('1 movement recorded so far');
    expect(text).toContain('has cleared: Ana is up');
    expect(text).not.toContain('Nothing unusual');
  });

  it('does not repeat a missed morning that is still open', async () => {
    const { templateSummary } = await import('../lib/aws/bedrock');
    const text = templateSummary({
      residentName: 'Ana', dateLabel: '', nowLabel: '', isToday: true, firstActivity: null,
      usualFirstActivity: '7:07am', lastActivity: null, activityCount: 0, usualActivityByNow: 10,
      rooms: [], outings: [], visitors: 0, visits: [], pausedUntil: null, pausedByResident: false,
      alerts: [{ rule: 'no_morning_activity', title: 'No activity from Ana yet this morning', severity: 'critical', open: true, resolution: null }],
    });
    expect(text).toBe('No movement at home yet today; Ana is usually up around 7:07am.');
  });
});
