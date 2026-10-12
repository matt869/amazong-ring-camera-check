'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomBytes } from 'node:crypto';
import { sendTestNotification } from '@/lib/aws/notify';
import { runCheck } from '@/lib/checkin';
import {
  acknowledgeAlert,
  addFamilyLog,
  deleteFamilyLog,
  endPauseWindows,
  getAlert,
  getSettings,
  listDevices,
  recordPauseWindow,
  resetDemoData,
  saveSettings,
  setDeviceCountsActivity,
  type FamilyLogKind,
} from '@/lib/db';
import { sendDigest } from '@/lib/digest';
import { standDown } from '@/lib/escalation';
import { createResidentKey } from '@/lib/resident';
import { parseExpectedVisits } from '@/lib/routine/visitors';
import { DEMO_SCENARIOS, type DemoScenario } from '@/lib/ring/mock';
import { ensureDemoData, setDemoScenario } from '@/lib/ring/events';
import { isMockMode } from '@/lib/ring/oauth';
import { isPhoneNumber, isPrivacyPaused, RULES, type RuleId } from '@/lib/routine/rules';
import { addDays, localParts, zonedToUtc } from '@/lib/routine/time';
// Server actions are public endpoints; each checks the session itself, not just the proxy.
import { familyMemberName, rememberFamilyMemberName, requireAuth } from '@/lib/session';


/** Where to return after a form posted from more than one page. */
function backPath(formData: FormData): string {
  const back = String(formData.get('back') || '/dashboard');
  return back.startsWith('/') && !back.startsWith('//') ? back : '/dashboard';
}

function refresh() {
  revalidatePath('/', 'layout');
}

export async function acknowledgeAlertAction(formData: FormData) {
  await requireAuth();
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id)) return;
  const by = await familyMemberName();
  const before = getAlert(id);
  acknowledgeAlert(id, Date.now(), by);
  // A neighbor already asked to knock can stand down: family has it.
  if (before?.neighborAt != null && before.resolvedAt == null) {
    const settings = getSettings();
    await standDown(before, settings, { family: false, neighbor: true });
  }
  refresh();
}

const LOG_KINDS: FamilyLogKind[] = ['call', 'visit', 'message', 'other'];

/** "I called Mom": the family's own check-ins, for the weekly digest. */
export async function addFamilyLogAction(formData: FormData) {
  await requireAuth();
  const who = String(formData.get('who') ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const kind = String(formData.get('kind')) as FamilyLogKind;
  const note = String(formData.get('note') ?? '').trim().slice(0, 200) || null;
  if (!who || !LOG_KINDS.includes(kind)) redirect(`${backPath(formData)}?notice=log-missing#family`);
  await rememberFamilyMemberName(who);
  addFamilyLog({ id: `log-${randomBytes(6).toString('hex')}`, at: Date.now(), who, kind, note });
  refresh();
  redirect(`${backPath(formData)}#family`);
}

export async function deleteFamilyLogAction(formData: FormData) {
  await requireAuth();
  deleteFamilyLog(String(formData.get('id') ?? ''));
  refresh();
}

export async function sendDigestNowAction() {
  await requireAuth();
  let notice = 'digest-sent';
  try {
    notice = (await sendDigest()) === 'sns' ? 'digest-sent' : 'digest-logged';
  } catch (err) {
    console.error('[digest] send failed:', err);
    notice = 'digest-failed';
  }
  redirect(`/dashboard/week?notice=${notice}`);
}

/** A fresh private link for the resident's own page. The previous one stops working. */
export async function createResidentLinkAction() {
  await requireAuth();
  createResidentKey();
  redirect('/dashboard/settings?notice=resident-link#resident');
}

const timeToMinutes = (v: FormDataEntryValue | null, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? ''));
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : fallback;
};

const clampNumber = (v: FormDataEntryValue | null, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.min(max, Math.max(min, n)) : fallback;
};

export async function saveSettingsAction(formData: FormData) {
  await requireAuth();
  const current = getSettings();
  const timezone = String(formData.get('timezone') || current.timezone).trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    redirect(`/dashboard/settings?notice=bad-timezone`);
  }

  const phone = (name: string) => String(formData.get(name) ?? '').replace(/[\s().-]/g, '');
  const residentPhone = phone('residentPhone');
  const neighborPhone = phone('neighborPhone');
  if ((residentPhone && !isPhoneNumber(residentPhone)) || (neighborPhone && !isPhoneNumber(neighborPhone))) {
    redirect('/dashboard/settings?notice=bad-phone#ladder');
  }
  const expectedVisits = String(formData.get('expectedVisits') ?? '').slice(0, 2000);
  if (parseExpectedVisits(expectedVisits).errors.length) redirect('/dashboard/settings?notice=bad-visits#visitors');
  const caregiverAfterMinutes = clampNumber(formData.get('caregiverAfterMinutes'), 5, 120, current.caregiverAfterMinutes);

  const enabledRules = Object.fromEntries(
    (Object.keys(RULES) as RuleId[]).map((id) => [id, formData.get(`rule_${id}`) === 'on']),
  ) as Record<RuleId, boolean>;

  saveSettings({
    ...current,
    residentName: String(formData.get('residentName') || current.residentName).trim().slice(0, 60),
    timezone,
    wakeGraceMinutes: clampNumber(formData.get('wakeGraceMinutes'), 15, 360, current.wakeGraceMinutes),
    fallbackWakeMinute: timeToMinutes(formData.get('fallbackWake'), current.fallbackWakeMinute),
    inactivityHours: clampNumber(formData.get('inactivityHours'), 1, 12, current.inactivityHours),
    awayHours: clampNumber(formData.get('awayHours'), 1, 24, current.awayHours),
    nightStartMinute: timeToMinutes(formData.get('nightStart'), current.nightStartMinute),
    nightEndMinute: timeToMinutes(formData.get('nightEnd'), current.nightEndMinute),
    lowBatteryPercent: clampNumber(formData.get('lowBatteryPercent'), 5, 50, current.lowBatteryPercent),
    baselineDays: clampNumber(formData.get('baselineDays'), 3, 60, current.baselineDays),
    reminderMinutes: clampNumber(formData.get('reminderMinutes'), 0, 240, current.reminderMinutes),
    enabledRules,
    residentPhone,
    checkInFirst: formData.get('checkInFirst') === 'on',
    caregiverAfterMinutes,
    // The neighbor is never asked before family has had a chance.
    neighborAfterMinutes: Math.max(
      caregiverAfterMinutes + 5,
      clampNumber(formData.get('neighborAfterMinutes'), 10, 240, current.neighborAfterMinutes),
    ),
    neighborName: String(formData.get('neighborName') ?? '').trim().slice(0, 40),
    residentGivenName: String(formData.get('residentGivenName') ?? '').trim().slice(0, 40),
    neighborPhone,
    digestEnabled: formData.get('digestEnabled') === 'on',
    digestWeekday: clampNumber(formData.get('digestWeekday'), 0, 6, current.digestWeekday),
    digestMinute: timeToMinutes(formData.get('digestTime'), current.digestMinute),
    expectedVisits,
  });

  // Per-device "counts as their activity" switches.
  for (const d of listDevices()) setDeviceCountsActivity(d.id, formData.get(`device_${d.id}`) === 'on');

  await runCheck();
  refresh();
  redirect('/dashboard/settings?notice=saved');
}

/** Pause for N days (until 9pm on the last day, home time), or until a picked date. */
export async function pauseAction(formData: FormData) {
  await requireAuth();
  const settings = getSettings();
  const tz = settings.timezone;
  const now = Date.now();
  const today = localParts(now, tz).dateKey;
  const until = String(formData.get('until') ?? '');
  const days = Number(formData.get('days'));

  let pausedUntil: number | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(until) && until >= today) pausedUntil = zonedToUtc(until, 21 * 60, tz);
  else if (days > 0 && days <= 60) pausedUntil = zonedToUtc(addDays(today, days), 9 * 60, tz);
  if (pausedUntil == null || pausedUntil <= now) redirect('/dashboard/settings?notice=bad-pause');
  // A pause the resident started is theirs to end.
  if (isPrivacyPaused(settings, now)) redirect('/dashboard/settings?notice=resident-paused');

  endPauseWindows(now);
  recordPauseWindow({ from: now, until: pausedUntil, by: 'family' });
  saveSettings({ ...settings, pausedUntil, pausedBy: 'family' });
  await runCheck();
  refresh();
  redirect(backPath(formData));
}

export async function resumeAction(formData: FormData) {
  await requireAuth();
  const settings = getSettings();
  if (isPrivacyPaused(settings, Date.now())) redirect('/dashboard/settings?notice=resident-paused');
  endPauseWindows(Date.now());
  saveSettings({ ...settings, pausedUntil: null, pausedBy: null });
  await runCheck();
  refresh();
  redirect(backPath(formData));
}

export async function sendTestAlertAction() {
  await requireAuth();
  let notice: string;
  try {
    const channel = await sendTestNotification(getSettings());
    notice = channel === 'sns' ? 'test-sns' : 'test-log';
  } catch (err) {
    console.error('[notify] test failed:', err);
    notice = 'test-failed';
  }
  redirect(`/dashboard/settings?notice=${notice}`);
}

export async function setDemoScenarioAction(formData: FormData) {
  await requireAuth();
  if (!isMockMode()) return;
  const scenario = String(formData.get('scenario')) as DemoScenario;
  if (!(scenario in DEMO_SCENARIOS)) return;
  resetDemoData(true);
  setDemoScenario(scenario);
  ensureDemoData(Date.now(), getSettings().timezone);
  await runCheck();
  refresh();
  redirect('/dashboard');
}
