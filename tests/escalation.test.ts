import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, history, motion, TZ } from './helpers';

// Real in-memory database, real-mode config, no SNS: messages go to the (captured) log.
process.env.DATABASE_FILE = ':memory:';
process.env.RING_CLIENT_ID = 'test-client';
process.env.HOME_TIMEZONE = TZ;
delete process.env.SNS_TOPIC_ARN;

type Db = typeof import('../lib/db');
type Checkin = typeof import('../lib/checkin');
type Escalation = typeof import('../lib/escalation');
let db: Db;
let checkin: Checkin;
let ladder: Escalation;
const log = vi.spyOn(console, 'log').mockImplementation(() => {});
/** Who got messages since the last call: "resident", "family", "neighbor ...". */
const sentTo = () => {
  const out = log.mock.calls.map(([m]) => /to (family|resident|neighbor)/.exec(String(m))?.[1]).filter(Boolean);
  log.mockClear();
  return out;
};
const lastMessage = () => String(log.mock.calls[log.mock.calls.length - 1]?.[0] ?? '');
const morning = (day: string) => db.listAlerts().find((a) => a.key === `no_morning_activity:${day}`)!;

beforeAll(async () => {
  db = await import('../lib/db');
  checkin = await import('../lib/checkin');
  ladder = await import('../lib/escalation');
  const { MOCK_DEVICES } = await import('../lib/ring/mock');
  db.upsertDevices(MOCK_DEVICES.map((d) => ({ ...d, battery: d.battery == null ? null : 90 })));
  db.insertEvents(history(at('10:30')));
});
beforeEach(() => {
  db.saveSettings({
    ...db.getSettings(),
    residentName: 'Ana',
    timezone: TZ,
    residentPhone: '+15550000001',
    neighborName: 'Ruth',
    neighborPhone: '+15550000002',
    checkInFirst: true,
    caregiverAfterMinutes: 15,
    neighborAfterMinutes: 30,
    digestEnabled: false,
    pausedUntil: null,
  });
  log.mockClear();
});
afterAll(() => log.mockRestore());

describe('escalation ladder', () => {
  it('texts the resident first, then family after 15 minutes, then the neighbor at 30', async () => {
    const day = '2026-03-18';
    const t = (hhmm: string) => at(hhmm, day);

    await checkin.evaluateAlerts(t('10:30'));
    expect(sentTo()).toEqual(['resident']);
    expect(morning(day).residentAt).toBe(t('10:30'));
    expect(morning(day).caregiverAt).toBeNull();

    await checkin.evaluateAlerts(t('10:40'));
    expect(sentTo()).toEqual([]); // still waiting for her

    await checkin.evaluateAlerts(t('10:45'));
    expect(sentTo()).toEqual(['family']);
    await checkin.evaluateAlerts(t('10:46'));
    expect(sentTo()).toEqual([]);

    await checkin.evaluateAlerts(t('11:00'));
    const sent = sentTo();
    expect(sent).toContain('neighbor');
    expect(morning(day).neighborAt).toBe(t('11:00'));
  });

  it('stands everyone down when the resident gets up', async () => {
    const day = '2026-03-18';
    db.insertEvents([motion('up-0318', at('11:05', day))]);
    await checkin.evaluateAlerts(at('11:06', day));
    const sent = sentTo();
    expect(sent).toEqual(expect.arrayContaining(['family', 'neighbor'])); // all-clear and "no need to check"
    expect(morning(day).resolutionNote).toContain('up and moving around');
  });

  it('stops at the first rung when the resident taps "I\'m OK", and the day stays settled', async () => {
    const day = '2026-03-19';
    const t = (hhmm: string) => at(hhmm, day);
    await checkin.evaluateAlerts(t('10:30'));
    expect(sentTo()).toEqual(['resident']);

    const alert = morning(day);
    await ladder.applyReply(alert.id, 'resident', 'ok', db.getSettings(), t('10:35'));
    expect(morning(day).resolutionNote).toBe('Ana replied “I’m OK” at 10:35am.');
    expect(sentTo()).toEqual([]); // family never needed to hear

    // Still no movement, but she has answered for today: no new alert, no family message.
    await checkin.evaluateAlerts(t('11:30'));
    expect(sentTo()).toEqual([]);
    expect(db.listAlerts().filter((a) => a.key === `no_morning_activity:${day}`)).toHaveLength(1);
  });

  it('tells family at once when the resident asks for a call', async () => {
    const day = '2026-03-20';
    const t = (hhmm: string) => at(hhmm, day);
    await checkin.evaluateAlerts(t('10:30'));
    sentTo();
    await ladder.applyReply(morning(day).id, 'resident', 'help', db.getSettings(), t('10:32'));
    expect(lastMessage()).toContain('Ana asked for a call');
    expect(sentTo()).toEqual(['family']);
    expect(morning(day).caregiverAt).toBe(t('10:32'));
    // The ladder doesn't message family a second time at the 15-minute mark.
    await checkin.evaluateAlerts(t('10:46'));
    expect(sentTo()).toEqual([]);
    db.acknowledgeAlert(morning(day).id, t('10:50'), 'David');
  });

  it('a family member checking on it stops the neighbor step and records who checked', async () => {
    const day = '2026-03-21';
    const t = (hhmm: string) => at(hhmm, day);
    await checkin.evaluateAlerts(t('10:30'));
    await checkin.evaluateAlerts(t('10:45'));
    expect(sentTo()).toEqual(['resident', 'family']);
    db.acknowledgeAlert(morning(day).id, t('10:50'), 'Sarah');
    await checkin.evaluateAlerts(t('11:05'));
    expect(sentTo()).toEqual([]);
    expect(morning(day).acknowledgedBy).toBe('Sarah');
  });

  it('goes straight to family without a resident phone', async () => {
    db.saveSettings({ ...db.getSettings(), residentPhone: '' });
    const day = '2026-03-22';
    await checkin.evaluateAlerts(at('10:30', day));
    expect(sentTo()).toEqual(['family']);
  });
});

describe('nextRung', () => {
  const base = {
    id: 1, key: 'k', rule: 'no_morning_activity' as const, severity: 'critical' as const, title: '', message: '',
    occurredAt: 0, createdAt: 0, acknowledgedAt: null, notifiedVia: null, resolvedAt: null, resolutionNote: null,
    remindedAt: null, acknowledgedBy: null, residentAt: null, caregiverAt: null, neighborAt: null, repliedAt: null,
    reply: null, snapshot: null, neighborHelpAt: null,
  };
  const s = () => db.getSettings();

  it('sends night-time doors and device problems straight to family, never the resident', () => {
    expect(ladder.nextRung({ ...base, rule: 'night_door', severity: 'warning' }, s(), 0)).toBe('caregiver');
    expect(ladder.nextRung({ ...base, rule: 'connection_lost', severity: 'warning' }, s(), 0)).toBe('caregiver');
    expect(ladder.nextRung({ ...base, rule: 'low_battery', severity: 'info' }, s(), 0)).toBeNull();
  });

  it('never asks a neighbor to knock while the resident is out', () => {
    const out = { ...base, rule: 'long_absence' as const, severity: 'warning' as const, residentAt: 0, caregiverAt: 15 * 60_000 };
    expect(ladder.nextRung(out, s(), 60 * 60_000)).toBeNull();
  });
});

describe('reply links', () => {
  it('round-trips, and rejects tampered or expired tokens', () => {
    const now = at('10:00');
    const token = ladder.replyToken(42, 'resident', now);
    expect(ladder.readReplyToken(token, now)).toEqual({ alertId: 42, role: 'resident' });
    expect(ladder.readReplyToken(token.replace(/^42/, '43'), now)).toBeNull();
    expect(ladder.readReplyToken(token.replace('.r.', '.n.'), now)).toBeNull();
    expect(ladder.readReplyToken(token, now + 25 * 3_600_000)).toBeNull();
    expect(ladder.readReplyToken('garbage', now)).toBeNull();
    expect(token.length).toBeLessThan(40); // fits comfortably in an SMS
  });
});

describe('privacy pause', () => {
  it('drops events inside a resident pause, even when history arrives later', async () => {
    const resident = await import('../lib/resident');
    const from = at('13:00', '2026-03-24');
    await resident.startPrivacyPause(from + 2 * 3_600_000, from);
    expect(db.getSettings().pausedBy).toBe('resident');
    expect(sentTo()).toEqual(['family']); // family is told it's paused
    const inserted = db.insertEvents([
      motion('during', from + 30 * 60_000),
      motion('after', from + 3 * 3_600_000),
    ]);
    expect(inserted.map((e) => e.id)).toEqual(['after']);

    resident.endPrivacyPause(from + 60 * 60_000);
    expect(db.getSettings().pausedUntil).toBeNull();
    expect(db.insertEvents([motion('later', from + 90 * 60_000)]).map((e) => e.id)).toEqual(['later']);
  });
});

describe('messages to the neighbor', () => {
  it('use the name the neighbor knows, not the family\'s "Mom"', async () => {
    const { sendNeighborRequest } = await import('../lib/aws/notify');
    const settings = { ...db.getSettings(), residentName: 'Mom', residentGivenName: 'Ana', neighborName: 'Ruth' };
    const alert = db.listAlerts().find((a) => a.rule === 'no_morning_activity')!;
    log.mockClear();
    await sendNeighborRequest(alert, settings, 'https://example.test/r/x');
    expect(lastMessage()).toContain("Hi Ruth, this is Ana's family check-in. There's been no sign of Ana up and about this morning");
    expect(lastMessage()).not.toContain('Mom');
  });
});

describe('when the check-in text fails', () => {
  it('tells family at once instead of waiting for a reply that cannot come', async () => {
    const notify = await import('../lib/aws/notify');
    const spy = vi.spyOn(notify, 'sendResidentCheckIn').mockRejectedValueOnce(new Error('invalid number'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const day = '2026-03-25';
    // Earlier tests' activity makes a late morning normal-ish, so check well after it.
    await checkin.evaluateAlerts(at('08:00', day));
    sentTo();
    await checkin.evaluateAlerts(at('13:00', day));
    expect(sentTo()).toEqual(['family']);
    expect(morning(day).caregiverAt).toBe(at('13:00', day));
    spy.mockRestore();
    err.mockRestore();
  });
});

describe('a late "I\'m OK"', () => {
  it('after the alert already cleared does not send family a second all-clear', async () => {
    const day = '2026-03-27';
    const t = (hhmm: string) => at(hhmm, day);
    for (const a of db.listAlerts({ openOnly: true })) db.acknowledgeAlert(a.id, t('12:00'));
    await checkin.evaluateAlerts(t('13:00'));
    await checkin.evaluateAlerts(t('13:15'));
    expect(sentTo()).toEqual(['resident', 'family']);

    db.insertEvents([motion('up-0327', t('13:20'))]);
    await checkin.evaluateAlerts(t('13:21'));
    expect(sentTo()).toEqual(['family']); // the all-clear

    // She opens the text afterwards and taps "I'm OK", then taps again.
    await ladder.applyReply(morning(day).id, 'resident', 'ok', db.getSettings(), t('13:25'));
    await ladder.applyReply(morning(day).id, 'resident', 'ok', db.getSettings(), t('13:26'));
    expect(sentTo()).toEqual([]);
    expect(morning(day).reply).toBe('ok');
    expect(morning(day).resolutionNote).toContain('up and moving around');
  });
});

describe('asking for help', () => {
  it('tells family once, however many times the button is pressed', async () => {
    const day = '2026-03-28';
    const t = (hhmm: string) => at(hhmm, day);
    for (const a of db.listAlerts({ openOnly: true })) db.acknowledgeAlert(a.id, t('12:00'));
    await checkin.evaluateAlerts(t('16:00'));
    sentTo();
    const id = morning(day).id;

    await ladder.applyReply(id, 'resident', 'help', db.getSettings(), t('16:02'));
    await ladder.applyReply(id, 'resident', 'help', db.getSettings(), t('16:03'));
    expect(sentTo()).toEqual(['family']);

    // The neighbor's "couldn't reach her" is new information, but only once, and keeps her answer.
    await ladder.applyReply(id, 'neighbor', 'help', db.getSettings(), t('16:40'));
    await ladder.applyReply(id, 'neighbor', 'help', db.getSettings(), t('16:41'));
    expect(sentTo()).toEqual(['family']);
    expect(morning(day).reply).toBe('help');
  });

  it('records the neighbor\'s answer when she never replied', async () => {
    const day = '2026-03-29';
    const t = (hhmm: string) => at(hhmm, day);
    for (const a of db.listAlerts({ openOnly: true })) db.acknowledgeAlert(a.id, t('12:00'));
    await checkin.evaluateAlerts(t('16:00'));
    sentTo();
    const id = morning(day).id;
    await ladder.applyReply(id, 'neighbor', 'help', db.getSettings(), t('16:40'));
    await ladder.applyReply(id, 'neighbor', 'help', db.getSettings(), t('16:41'));
    expect(sentTo()).toEqual(['family']);
    expect(morning(day).neighborHelpAt).toBe(t('16:40'));
    expect(morning(day).reply).toBeNull();
  });
});

describe('pausing "until tomorrow morning"', () => {
  it('means this morning when it is already past midnight', async () => {
    const { pauseUntilMorning } = await import('../lib/resident');
    expect(pauseUntilMorning(at('01:30'), TZ)).toBe(at('08:00'));
    expect(pauseUntilMorning(at('21:00'), TZ)).toBe(at('08:00', '2026-03-19'));
  });
});
