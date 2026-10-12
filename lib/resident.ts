import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sendPrivacyPauseNotice } from './aws/notify';
import { endPauseWindows, getKv, getSettings, recordPauseWindow, saveSettings, setKv } from './db';
import { isPrivacyPaused } from './routine/rules';
import { addDays, localParts, zonedToUtc } from './routine/time';

/**
 * The resident's own page: what's shared about them, who gets told when, and a
 * way to pause it. It opens from a private link (no password to remember);
 * only the link's hash is stored, and a new link turns the old one off.
 */

const HASH_KV = 'resident_key_hash';
const PENDING_KV = 'resident_link_pending';
/** The new link stays visible to family on the Settings page this long. */
const PENDING_MS = 60 * 60_000;
/** A privacy pause can't run longer than this; they can always start another. */
export const MAX_PRIVACY_PAUSE_MS = 24 * 60 * 60_000;

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

export function createResidentKey(now = Date.now()): string {
  const key = randomBytes(18).toString('base64url');
  setKv(HASH_KV, hash(key));
  setKv(PENDING_KV, { key, expires: now + PENDING_MS });
  return key;
}

export function residentKeyValid(key: string | null | undefined): boolean {
  const stored = getKv<string>(HASH_KV);
  if (!key || !stored || !/^[\w-]{20,40}$/.test(key)) return false;
  const a = Buffer.from(hash(key), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hasResidentLink(): boolean {
  return getKv<string>(HASH_KV) != null;
}

/** The link just created, while it's still shown on the Settings page. */
export function pendingResidentKey(now = Date.now()): string | null {
  const p = getKv<{ key: string; expires: number }>(PENDING_KV);
  return p && p.expires > now ? p.key : null;
}

/**
 * The resident pauses sharing: nothing is recorded and no check-in alerts fire
 * until `until`. Family is told it's paused (not why). Replaces any family pause
 * that would end sooner.
 */
export async function startPrivacyPause(until: number, now = Date.now()): Promise<number> {
  const settings = getSettings();
  const end = Math.min(until, now + MAX_PRIVACY_PAUSE_MS);
  if (end <= now) return now;
  const familyPauseOutlasts = settings.pausedBy === 'family' && (settings.pausedUntil ?? 0) >= end;
  if (!familyPauseOutlasts) {
    endPauseWindows(now);
    saveSettings({ ...settings, pausedUntil: end, pausedBy: 'resident' });
  }
  // Either way, nothing is recorded during this window.
  recordPauseWindow({ from: now, until: end, by: 'resident' });
  try {
    await sendPrivacyPauseNotice(settings, end);
  } catch (err) {
    console.error('[notify] privacy pause notice failed:', (err as Error).message);
  }
  return end;
}

/**
 * "Until tomorrow morning": 8am the next day, or 8am today when it's already
 * the small hours (at 1am, "tomorrow morning" means in a few hours).
 */
export function pauseUntilMorning(now: number, tz: string): number {
  const local = localParts(now, tz);
  const day = local.minuteOfDay < 5 * 60 ? local.dateKey : addDays(local.dateKey, 1);
  return zonedToUtc(day, 8 * 60, tz);
}

export function endPrivacyPause(now = Date.now()): void {
  const settings = getSettings();
  endPauseWindows(now, 'resident');
  if (isPrivacyPaused(settings, now)) saveSettings({ ...settings, pausedUntil: null, pausedBy: null });
}

export function setSnapshotsAllowed(allowed: boolean): void {
  saveSettings({ ...getSettings(), snapshotsAllowed: allowed });
}
