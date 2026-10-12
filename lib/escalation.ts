import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  getAlert,
  getKv,
  isOpen,
  markAlertNotified,
  markNeighborHelp,
  markRung,
  recordReply,
  resolveAlert,
  setKv,
  type AlertRecord,
  type Rung,
} from './db';
import {
  appUrl,
  pushes,
  sendAlertNotification,
  sendHelpRequest,
  sendNeighborRequest,
  sendNeighborStandDown,
  sendResidentCheckIn,
  sendResolvedNotification,
  type NotifyChannel,
} from './aws/notify';
import { RULES, type CheckinSettings } from './routine/rules';
import { formatTime } from './routine/time';

/**
 * The gentle escalation ladder. When the routine breaks:
 *
 *   1. the resident gets a friendly "are you OK?" text with a one-tap reply link;
 *   2. family is told if there's no reply after `caregiverAfterMinutes` (15);
 *   3. a neighbor is asked to knock `neighborAfterMinutes` (30) after it began,
 *      if nobody in the family has marked it as checked.
 *
 * The ladder stops as soon as the resident replies "I'm OK", the situation
 * clears by itself (they got up, came home), or family acknowledges it.
 * Rules decide which rungs apply: a night-time door goes straight to family,
 * and nobody asks a neighbor to knock while the resident is out.
 */

const MINUTE = 60_000;

/** What the ladder should do next for an alert, or null if nothing is due yet. */
export function nextRung(alert: AlertRecord, settings: CheckinSettings, now: number): Rung | null {
  if (!isOpen(alert) || !pushes(alert.severity)) return null;
  const rule = RULES[alert.rule];

  if (alert.caregiverAt == null) {
    if (alert.residentAt == null) {
      return rule.asksResidentFirst && settings.checkInFirst && settings.residentPhone ? 'resident' : 'caregiver';
    }
    return now - alert.residentAt >= settings.caregiverAfterMinutes * MINUTE ? 'caregiver' : null;
  }

  if (alert.neighborAt == null && rule.asksNeighbor && settings.neighborPhone) {
    return now - alert.createdAt >= settings.neighborAfterMinutes * MINUTE ? 'neighbor' : null;
  }
  return null;
}

/** Contacts the next rung for one alert, if one is due. Never throws. */
export async function advanceLadder(alert: AlertRecord, settings: CheckinSettings, now: number): Promise<Rung | null> {
  const rung = nextRung(alert, settings, now);
  if (!rung) return null;
  // Record first, so overlapping checks can't double-send.
  markRung(alert.id, rung, now);
  const current = { ...alert, [`${rung}At`]: now };
  let channel: NotifyChannel | 'failed';
  try {
    channel =
      rung === 'resident'
        ? await sendResidentCheckIn(current, settings, replyUrl(alert.id, 'resident', now))
        : rung === 'caregiver'
          ? await sendAlertNotification(current, settings)
          : await sendNeighborRequest(current, settings, replyUrl(alert.id, 'neighbor', now));
  } catch (err) {
    console.error(`[ladder] ${rung} message for ${alert.key} failed:`, (err as Error).message);
    channel = 'failed';
  }
  // notified_via tracks whether family heard about it (for the all-clear).
  if (rung === 'caregiver' || alert.notifiedVia == null) markAlertNotified(alert.id, rung === 'caregiver' ? channel : 'resident');
  // A check-in text that never went out can't be answered: don't make family wait for it.
  if (rung === 'resident' && channel === 'failed') {
    return advanceLadder({ ...alert, residentAt: now - settings.caregiverAfterMinutes * MINUTE, notifiedVia: 'resident' }, settings, now);
  }
  return rung;
}

/**
 * Tells people already contacted that they can stop worrying: family gets the
 * all-clear, a neighbor asked to knock is told they needn't. Never throws.
 */
export async function standDown(
  alert: AlertRecord,
  settings: CheckinSettings,
  who: { family: boolean; neighbor: boolean },
): Promise<void> {
  try {
    if (who.family && alert.caregiverAt != null && alert.notifiedVia !== 'failed') await sendResolvedNotification(alert, settings);
    if (who.neighbor && alert.neighborAt != null && settings.neighborPhone) await sendNeighborStandDown(alert, settings);
  } catch (err) {
    console.error(`[ladder] stand-down for ${alert.key} failed:`, (err as Error).message);
  }
}

// --- one-tap reply links ---------------------------------------------------------

export type ReplyRole = 'resident' | 'neighbor';

/** Reply links stay valid this long: long enough to answer, short enough not to linger. */
const LINK_TTL_MS = 24 * 60 * MINUTE;

function secret(): Buffer {
  let s = getKv<string>('reply_link_secret');
  if (!s) {
    s = randomBytes(32).toString('hex');
    setKv('reply_link_secret', s);
  }
  return Buffer.from(s, 'hex');
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url').slice(0, 22);
}

/** A short token for an SMS link: alert id, role and expiry, signed. No login needed to use it. */
export function replyToken(alertId: number, role: ReplyRole, now = Date.now()): string {
  const payload = `${alertId}.${role[0]}.${Math.floor((now + LINK_TTL_MS) / 1000).toString(36)}`;
  return `${payload}.${sign(payload)}`;
}

export function readReplyToken(token: string, now = Date.now()): { alertId: number; role: ReplyRole } | null {
  const m = /^(\d+)\.([rn])\.([0-9a-z]+)\.([\w-]{22})$/.exec(token);
  if (!m) return null;
  const expected = Buffer.from(sign(`${m[1]}.${m[2]}.${m[3]}`));
  const given = Buffer.from(m[4]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (parseInt(m[3], 36) * 1000 < now) return null;
  return { alertId: Number(m[1]), role: m[2] === 'r' ? 'resident' : 'neighbor' };
}

export function replyUrl(alertId: number, role: ReplyRole, now = Date.now()): string {
  return `${appUrl()}/r/${replyToken(alertId, role, now)}`;
}

/**
 * Applies a reply from the one-tap page. "ok" closes the alert (and stops the
 * ladder). "help" tells family right away, even if the alert has since cleared,
 * and leaves the alert open for someone to mark as checked.
 */
export async function applyReply(
  alertId: number,
  role: ReplyRole,
  answer: 'ok' | 'help',
  settings: CheckinSettings,
  now = Date.now(),
): Promise<AlertRecord | null> {
  const alert = getAlert(alertId);
  if (!alert) return null;
  const name = settings.residentName;
  const at = formatTime(now, settings.timezone);

  if (answer === 'ok') {
    const reply = role === 'resident' ? 'ok' : 'neighbor-ok';
    recordReply(alertId, reply, now);
    resolveAlert(
      alertId,
      now,
      role === 'resident'
        ? `${name} replied “I’m OK” at ${at}.`
        : `${settings.neighborName || 'The neighbor'} checked on ${name} at ${at}: all is well.`,
    );
    const resolved = getAlert(alertId)!;
    // Whoever was already pulled in hears that it's settled (but not the person who just answered).
    // A tap after it already cleared, or a second tap, has nothing new to tell them.
    if (isOpen(alert)) {
      await standDown(resolved, settings, { family: resolved.caregiverAt != null, neighbor: role === 'resident' });
    }
    return resolved;
  }

  // From the resident: "Please call me". From the neighbor: "I couldn't reach them".
  // Family hears each once; a second tap or a revisit sends nothing new.
  if (role === 'resident') {
    if (alert.reply === 'help') return alert;
    recordReply(alertId, 'help', now);
  } else if (!markNeighborHelp(alertId, now)) {
    return alert;
  }
  markRung(alertId, 'caregiver', now);
  try {
    markAlertNotified(alertId, await sendHelpRequest(getAlert(alertId)!, settings, now, role));
  } catch (err) {
    console.error(`[ladder] help request for ${alert.key} failed:`, (err as Error).message);
    markAlertNotified(alertId, 'failed');
  }
  return getAlert(alertId);
}
