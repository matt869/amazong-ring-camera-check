import { describe, expect, it } from 'vitest';
import { templateDigest, type WeekFacts } from '../lib/digest';
import { generateDemoEvents, MOCK_DEVICES, type DemoScenario } from '../lib/ring/mock';
import { dailyMetrics, detectDrift } from '../lib/routine/drift';
import { addDays, zonedToUtc } from '../lib/routine/time';
import { detectVisitorPattern, detectVisits, parseExpectedVisits } from '../lib/routine/visitors';
import { at, ev, motion, TODAY, TZ } from './helpers';

const now = at('17:30');
const demo = (scenario: DemoScenario) => generateDemoEvents({ now, timezone: TZ, days: 63, scenario, anchor: now });
const metrics = (scenario: DemoScenario) =>
  dailyMetrics(demo(scenario), MOCK_DEVICES, { now, timezone: TZ, days: 63, nightStartMinute: 23 * 60, nightEndMinute: 5 * 60 });

describe('routine drift', () => {
  it('finds nothing in a steady routine', () => {
    expect(detectDrift(metrics('normal'), addDays(TODAY, -1), 'Ana')).toEqual([]);
  });

  it('flags a slow decline that no single day would', () => {
    const findings = detectDrift(metrics('gradual-decline'), addDays(TODAY, -1), 'Ana');
    expect(findings.map((f) => f.metric)).toEqual(expect.arrayContaining(['outings', 'activity']));
    expect(findings.find((f) => f.metric === 'outings')?.detail).toMatch(/a week lately, down from/);
  });

  it('needs enough history before saying anything', () => {
    const recentOnly = metrics('gradual-decline').filter((d) => d.dateKey >= addDays(TODAY, -20));
    expect(detectDrift(recentOnly, addDays(TODAY, -1), 'Ana')).toEqual([]);
  });

  it('counts small-hours movement toward the night before, and skips excluded days', () => {
    const day = addDays(TODAY, -2);
    const events = [
      motion('a', at('08:00', day)),
      motion('b', at('23:30', day)),
      motion('c', at('02:00', addDays(day, 1))),
      motion('d', at('09:00', addDays(day, 1))),
    ];
    const opts = { now, timezone: TZ, days: 7, nightStartMinute: 23 * 60, nightEndMinute: 5 * 60 };
    const days = dailyMetrics(events, MOCK_DEVICES, opts);
    expect(days.find((d) => d.dateKey === day)?.nightActivity).toBe(2);
    expect(dailyMetrics(events, MOCK_DEVICES, { ...opts, skip: (k) => k === day }).map((d) => d.dateKey)).toEqual([addDays(day, 1)]);
  });
});

describe('visitors', () => {
  it('parses expected visits the way families type them', () => {
    const { visits, errors } = parseExpectedVisits('Home aide: Tue Thu 9:30-11:00\nMeals on Wheels: weekdays 11:30am-12:30pm\nnonsense');
    expect(visits).toEqual([
      { label: 'Home aide', weekdays: [2, 4], start: 570, end: 660 },
      { label: 'Meals on Wheels', weekdays: [1, 2, 3, 4, 5], start: 690, end: 750 },
    ]);
    expect(errors).toEqual(['nonsense']);
    expect(parseExpectedVisits('Nurse: Mon-Wed 1-3pm').visits[0]).toMatchObject({ weekdays: [1, 2, 3], start: 13 * 60, end: 15 * 60 });
  });

  it('tells an expected visit, a drop-off, and an unexpected caller apart', () => {
    // TODAY is a Wednesday.
    const events = [
      ev('d1', 'ding', 'front-door', at('09:45')),
      ev('o1', 'door_open', 'front-door-contact', at('09:46')),
      motion('m1', at('09:50'), 'living-cam'),
      ev('d2', 'ding', 'front-door', at('12:00')),
      ev('d3', 'ding', 'front-door', at('16:30')),
      ev('o3', 'door_open', 'front-door-contact', at('16:32')),
      motion('m3', at('16:45'), 'living-cam'),
      ev('pass', 'motion', 'front-door', at('18:00')), // passer-by: not a visit
    ];
    const expected = parseExpectedVisits('Physio: Wed 9:30-10:30').visits;
    const visits = detectVisits(events, MOCK_DEVICES, { timezone: TZ, expected });
    expect(visits.map((v) => [v.kind, v.label, v.answered])).toEqual([
      ['expected', 'Physio', true],
      ['dropoff', null, false],
      ['unexpected', null, true],
    ]);
  });

  it("doesn't mistake the resident leaving the house for answering the door", () => {
    const events = [
      ev('d', 'ding', 'front-door', at('14:00')),
      ev('out', 'door_open', 'back-door', at('14:02')), // she goes out; the house stays quiet
      ev('back', 'door_open', 'back-door', at('15:30')),
      motion('m', at('15:35'), 'living-cam'),
    ];
    expect(detectVisits(events, MOCK_DEVICES, { timezone: TZ, expected: [] })[0]).toMatchObject({ answered: false, kind: 'dropoff' });
  });

  it('learns a weekly regular, and warns about repeated unexpected callers', () => {
    const normal = detectVisits(demo('normal'), MOCK_DEVICES, { timezone: TZ, expected: [] });
    expect(normal.some((v) => v.kind === 'regular')).toBe(true); // the Tue/Thu home aide
    expect(detectVisitorPattern(normal, { now, timezone: TZ, name: 'Ana' })).toBeNull();

    const repeat = detectVisits(demo('repeat-visitor'), MOCK_DEVICES, { timezone: TZ, expected: [] });
    const pattern = detectVisitorPattern(repeat, { now, timezone: TZ, name: 'Ana' });
    expect(pattern?.title).toMatch(/Ana opened the door to \d unexpected visitors this week/);
    expect(pattern?.message).toContain('scams');
    expect(pattern?.key).toBe('2026-03-16'); // Monday of this week: at most one alert a week
  });
});

describe('weekly digest template', () => {
  const facts: WeekFacts = {
    residentName: 'Ana',
    range: 'Thu, Mar 12 – Wed, Mar 18',
    daysWithData: 7,
    usualWake: '7:40am',
    previousWeekWake: '7:05am',
    movementsPerDay: 31,
    previousWeekMovementsPerDay: 44,
    outings: 1,
    previousWeekOutings: 4,
    familyCheckIns: [
      { who: 'David', calls: 0, visits: 1, messages: 2, other: 0, alertsChecked: 0 },
      { who: 'Sarah', calls: 3, visits: 0, messages: 0, other: 0, alertsChecked: 1 },
    ],
    daysWithoutContact: ['Monday'],
    alerts: [{ day: 'Tuesday', title: 'No activity from Ana yet this morning', outcome: 'Ana replied “I’m OK” at 9:12am.' }],
    visitors: { total: 3, expected: 0, regular: 2, dropoff: 1, unexpected: 0, unexpectedAnswered: 0, unexpectedTimes: [] },
    trends: [{ title: 'Going out less often', detail: 'About 1 outing a week lately, down from 4 a week the month before.' }],
  };

  it('answers "who checked on her?" and covers alerts and trends', () => {
    const text = templateDigest(facts);
    expect(text).toContain('Ana was usually up around 7:40am (7:05am the week before)');
    expect(text).toContain('David visited once, sent 2 messages; Sarah called 3 times, answered 1 alert.');
    expect(text).toContain('No check-in was logged on Monday.');
    expect(text).toContain('no activity from Ana yet this morning on Tuesday (Ana replied “I’m OK” at 9:12am)');
    expect(text).toContain('Going out less often');
  });

  it('says plainly when nobody logged contact', () => {
    expect(templateDigest({ ...facts, familyCheckIns: [], daysWithoutContact: ['Monday'] })).toContain('Nobody logged a call or visit this week.');
  });
});

describe('Alexa', () => {
  it('only accepts Amazon certificate URLs', async () => {
    const { isValidCertUrl } = await import('../lib/alexa');
    expect(isValidCertUrl('https://s3.amazonaws.com/echo.api/echo-api-cert.pem')).toBe(true);
    expect(isValidCertUrl('https://s3.amazonaws.com:443/echo.api/../echo.api/echo-api-cert.pem')).toBe(true);
    expect(isValidCertUrl('http://s3.amazonaws.com/echo.api/echo-api-cert.pem')).toBe(false);
    expect(isValidCertUrl('https://notamazon.com/echo.api/echo-api-cert.pem')).toBe(false);
    expect(isValidCertUrl('https://s3.amazonaws.com/EcHo.aPi/echo-api-cert.pem')).toBe(false);
    expect(isValidCertUrl('https://s3.amazonaws.com:563/echo.api/echo-api-cert.pem')).toBe(false);
    expect(isValidCertUrl('https://s3.amazonaws.com/invalid.path/echo-api-cert.pem')).toBe(false);
  });

  it('rejects requests for another skill or replayed later, before fetching anything', async () => {
    const { verifyAlexaRequest } = await import('../lib/alexa');
    process.env.ALEXA_SKILL_ID = 'amzn1.ask.skill.test';
    const fetchChain = () => Promise.reject(new Error('should not fetch'));
    const body = (appId: string, ts: number) =>
      JSON.stringify({ context: { System: { application: { applicationId: appId } } }, request: { type: 'LaunchRequest', timestamp: new Date(ts).toISOString() } });
    const headers = { certUrl: 'https://s3.amazonaws.com/echo.api/echo-api-cert.pem', signature: 'x' };
    const t = zonedToUtc(TODAY, 600, TZ);
    expect(await verifyAlexaRequest(body('amzn1.ask.skill.other', t), headers, t, { fetchChain })).toEqual({ ok: false, reason: 'wrong skill' });
    expect(await verifyAlexaRequest(body('amzn1.ask.skill.test', t - 10 * 60_000), headers, t, { fetchChain })).toEqual({ ok: false, reason: 'stale request' });
    delete process.env.ALEXA_SKILL_ID;
  });
});
