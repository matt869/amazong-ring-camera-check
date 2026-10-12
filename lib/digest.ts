import { writeWithClaude } from './aws/bedrock';
import { sendWeeklyDigest, type NotifyChannel } from './aws/notify';
import { getKv, getSettings, listAlerts, listDevices, listEvents, listFamilyLog, setKv, type AlertRecord, type FamilyLogEntry } from './db';
import { getTrends, getVisits } from './insights';
import { dailyMetrics, weeklyMetrics } from './routine/drift';
import type { CheckinSettings } from './routine/rules';
import { addDays, formatDateKey, formatMinuteOfDay, localParts, weekdayOf, WEEKDAYS, zonedToUtc } from './routine/time';
import { countVisits, type Visit, type VisitCounts } from './routine/visitors';

/**
 * The weekly family digest: one short note for everyone who shares the caring,
 * answering "how was Mom's week, and who checked on her?". Built from
 * pre-computed facts (never raw events), written by Claude on Bedrock when
 * enabled, otherwise by a template. Sent to the SNS topic once a week.
 */

export interface WeekFacts {
  residentName: string;
  /** e.g. "Mon, Mar 9 – Sun, Mar 15" */
  range: string;
  daysWithData: number;
  usualWake: string | null;
  previousWeekWake: string | null;
  movementsPerDay: number | null;
  previousWeekMovementsPerDay: number | null;
  outings: number | null;
  previousWeekOutings: number | null;
  /** Who in the family checked in, and how. */
  familyCheckIns: { who: string; calls: number; visits: number; messages: number; other: number; alertsChecked: number }[];
  /** Days nobody logged any contact. */
  daysWithoutContact: string[];
  alerts: { day: string; title: string; outcome: string }[];
  visitors: VisitCounts & { unexpectedTimes: string[] };
  /** Slow changes over the past weeks (routine drift). */
  trends: { title: string; detail: string }[];
}

export interface WeekReport {
  endDate: string;
  startDate: string;
  isCurrent: boolean;
  facts: WeekFacts;
  log: FamilyLogEntry[];
  alerts: AlertRecord[];
  visits: Visit[];
}

const DAY_LABEL = (dateKey: string) => formatDateKey(dateKey);

function alertOutcome(a: AlertRecord): string {
  if (a.resolvedAt != null) return a.resolutionNote ?? 'cleared';
  if (a.acknowledgedAt != null) return a.acknowledgedBy ? `checked on by ${a.acknowledgedBy}` : 'marked as checked';
  return 'still open';
}

/** The seven days ending `endDate` (inclusive; default today in the home's timezone). */
export function getWeekReport(endDate?: string, now = Date.now(), settings: CheckinSettings = getSettings()): WeekReport {
  const tz = settings.timezone;
  const today = localParts(now, tz).dateKey;
  const end = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate <= today ? endDate : today;
  const start = addDays(end, -6);
  const from = zonedToUtc(start, 0, tz);
  const to = Math.min(zonedToUtc(addDays(end, 1), 0, tz), now + 1);
  const devices = listDevices();
  const name = settings.residentName;

  // Two weeks of daily measures, so this week can be compared with the one before.
  const boundary = zonedToUtc(addDays(end, 1), 0, tz);
  const days = dailyMetrics(listEvents(from - 8 * 86_400_000, to, 200_000), devices, {
    now: boundary,
    timezone: tz,
    days: 14,
    nightStartMinute: settings.nightStartMinute,
    nightEndMinute: settings.nightEndMinute,
  });
  const [prev, cur] = weeklyMetrics(days, end, 2);

  const log = listFamilyLog(from, to);
  const alerts = listAlerts({ since: from, until: to, limit: 200 }).sort((a, b) => a.createdAt - b.createdAt);
  const visits = getVisits(from, to, settings, devices);

  const people = new Map<string, WeekFacts['familyCheckIns'][number]>();
  const person = (who: string) => {
    let p = people.get(who);
    if (!p) people.set(who, (p = { who, calls: 0, visits: 0, messages: 0, other: 0, alertsChecked: 0 }));
    return p;
  };
  const kindKey = { call: 'calls', visit: 'visits', message: 'messages', other: 'other' } as const;
  for (const e of log) person(e.who)[kindKey[e.kind]]++;
  for (const a of alerts) if (a.acknowledgedBy) person(a.acknowledgedBy).alertsChecked++;

  const contactDays = new Set([
    ...log.map((e) => localParts(e.at, tz).dateKey),
    ...alerts.filter((a) => a.acknowledgedAt != null).map((a) => localParts(a.acknowledgedAt!, tz).dateKey),
  ]);
  const daysWithoutContact: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (d === today) continue; // the day isn't over
    if (!contactDays.has(d)) daysWithoutContact.push(WEEKDAYS[weekdayOf(d)]);
  }

  const counts = countVisits(visits);
  const trends = getTrends(now, settings, devices).findings;
  const round = (n: number | null) => (n == null ? null : Math.round(n));

  return {
    endDate: end,
    startDate: start,
    isCurrent: end === today,
    log,
    alerts,
    visits,
    facts: {
      residentName: name,
      range: `${DAY_LABEL(start)} – ${DAY_LABEL(end)}`,
      daysWithData: cur.days,
      usualWake: cur.wake == null ? null : formatMinuteOfDay(cur.wake),
      previousWeekWake: prev.wake == null ? null : formatMinuteOfDay(prev.wake),
      movementsPerDay: round(cur.activity),
      previousWeekMovementsPerDay: round(prev.activity),
      outings: cur.outings == null ? null : days.filter((d) => d.dateKey >= start && d.dateKey <= end).reduce((a, d) => a + d.outings, 0),
      previousWeekOutings: prev.outings == null ? null : days.filter((d) => d.dateKey < start).reduce((a, d) => a + d.outings, 0),
      familyCheckIns: [...people.values()].sort((a, b) => a.who.localeCompare(b.who)),
      daysWithoutContact,
      alerts: alerts
        .filter((a) => a.severity !== 'info')
        .map((a) => ({ day: WEEKDAYS[weekdayOf(localParts(a.createdAt, tz).dateKey)], title: a.title, outcome: alertOutcome(a) })),
      visitors: {
        ...counts,
        unexpectedTimes: visits
          .filter((v) => v.kind === 'unexpected')
          .map((v) => `${WEEKDAYS[weekdayOf(v.dateKey)].slice(0, 3)} ${formatMinuteOfDay(v.minute)}${v.answered ? ' (door opened)' : ''}`),
      },
      trends: trends.map((t) => ({ title: t.title, detail: t.detail })),
    },
  };
}

const DIGEST_PROMPT = `You write the weekly digest for a family who share the caring for a relative who lives alone. It is based only on home sensor activity (motion, doors, doorbell), the family's own check-in log, and the week's alerts, so you know when and where there was movement, not what the person was doing or how they feel.

Write one short paragraph of 4-6 plain sentences that a sibling can read in thirty seconds: how the week went compared with the week before; who in the family checked in (credit people by name; if there are daysWithoutContact, mention them gently, without blame); any alerts and how each was resolved; unexpected doorbell visitors if any; and any slow changes in "trends", framed as worth a conversation rather than as a diagnosis. Do not guess at health, mood, or causes, and do not give medical advice. Use names, days and numbers exactly as given. No headings, lists, or emoji.`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** Deterministic digest used without Bedrock, and as the fallback. */
export function templateDigest(f: WeekFacts): string {
  const name = f.residentName;
  const parts: string[] = [];

  if (f.daysWithData === 0) {
    parts.push(`No activity was recorded for ${name} this week.`);
  } else {
    let routine = f.usualWake ? `${name} was usually up around ${f.usualWake}` : `${name}'s week`;
    if (f.usualWake && f.previousWeekWake) routine += ` (${f.previousWeekWake} the week before)`;
    const bits: string[] = [];
    if (f.outings != null) bits.push(f.outings ? `went out ${times(f.outings)}` : `didn't go out`);
    if (f.movementsPerDay != null) bits.push(`moved around about ${f.movementsPerDay} times a day`);
    parts.push(`${routine}${bits.length ? `, ${bits.join(' and ')}` : ''}.`);
  }

  if (f.familyCheckIns.length) {
    const who = f.familyCheckIns.map((p) => {
      const did = [
        p.calls && `called ${times(p.calls)}`,
        p.visits && `visited ${times(p.visits)}`,
        p.messages && `sent ${plural(p.messages, 'message')}`,
        p.other && `checked in ${plural(p.other, 'other time')}`,
        p.alertsChecked && `answered ${plural(p.alertsChecked, 'alert')}`,
      ].filter(Boolean);
      return `${p.who} ${did.join(', ')}`;
    });
    parts.push(`${who.join('; ')}.`);
  } else {
    parts.push('Nobody logged a call or visit this week.');
  }
  if (f.familyCheckIns.length && f.daysWithoutContact.length) {
    parts.push(`No check-in was logged on ${f.daysWithoutContact.join(', ')}.`);
  }

  if (f.alerts.length) {
    parts.push(
      `${plural(f.alerts.length, 'alert')}: ${f.alerts.map((a) => `${a.title.charAt(0).toLowerCase()}${a.title.slice(1)} on ${a.day} (${a.outcome.replace(/\.$/, '')})`).join('; ')}.`,
    );
  } else if (f.daysWithData > 0) {
    parts.push('No alerts.');
  }

  if (f.visitors.unexpected) {
    parts.push(`Unexpected visitors at the door: ${f.visitors.unexpectedTimes.join(', ')}.`);
  }
  for (const t of f.trends) parts.push(`${t.title}: ${t.detail}`);
  return parts.join(' ');
}

interface CachedDigest {
  text: string;
  source: 'bedrock' | 'template';
  at: number;
  signature: string;
}

export async function getWeekDigest(report: WeekReport, now = Date.now()): Promise<{ text: string; source: 'bedrock' | 'template' }> {
  const signature = JSON.stringify(report.facts);
  const key = `digest:${report.endDate}`;
  const cached = getKv<CachedDigest>(key);
  // The current week changes all the time; an hour-old digest is fine for it.
  if (cached && (cached.signature === signature || (report.isCurrent && now - cached.at < 60 * 60_000))) {
    return { text: cached.text, source: cached.source };
  }
  const written = await writeWithClaude(DIGEST_PROMPT, 'Facts for this week’s family digest', report.facts);
  const digest = written ? { text: written, source: 'bedrock' as const } : { text: templateDigest(report.facts), source: 'template' as const };
  if (digest.source === 'bedrock') setKv(key, { ...digest, at: now, signature } satisfies CachedDigest);
  return digest;
}

export async function sendDigest(now = Date.now(), settings: CheckinSettings = getSettings()): Promise<NotifyChannel> {
  const report = getWeekReport(undefined, now, settings);
  const { text } = await getWeekDigest(report, now);
  return sendWeeklyDigest(`${settings.residentName}'s week: ${report.facts.range}`, text);
}

/** Sends the digest once on the chosen weekday, at or after the chosen time. Never throws. */
export async function maybeSendDigest(now = Date.now()): Promise<boolean> {
  const settings = getSettings();
  if (!settings.digestEnabled) return false;
  const local = localParts(now, settings.timezone);
  if (weekdayOf(local.dateKey) !== settings.digestWeekday || local.minuteOfDay < settings.digestMinute) return false;
  const sentKey = `digest_sent:${local.dateKey}`;
  if (getKv(sentKey)) return false;
  setKv(sentKey, now); // first, so overlapping checks can't double-send
  try {
    await sendDigest(now, settings);
    return true;
  } catch (err) {
    console.error('[digest] sending failed:', (err as Error).message);
    return false;
  }
}
