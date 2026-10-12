import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getKv, setKv } from './db';
import { isMockMode } from './ring/oauth';

/**
 * Single-household access control. The dashboard reveals when someone is home
 * alone or out, so it must not be open to whoever finds the URL.
 *
 *   password set (APP_PASSWORD, or chosen on the Setup page) -> login required
 *   no password, demo data                                    -> open
 *   no password, real data                                    -> locked until one is set
 */

export const SESSION_COOKIE = 'rc_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export type AuthMode = 'password' | 'open' | 'locked';

interface StoredPassword {
  salt: string;
  hash: string;
}

const PASSWORD_KV = 'app_password';

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): StoredPassword {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

export function verifyPasswordHash(password: string, stored: StoredPassword): boolean {
  const candidate = scryptSync(password, stored.salt, 32);
  const expected = Buffer.from(stored.hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Password chosen in the app (Setup page). APP_PASSWORD in the environment takes precedence. */
export function setAppPassword(password: string): void {
  setKv(PASSWORD_KV, hashPassword(password));
}

function storedPassword(): StoredPassword | null {
  return getKv<StoredPassword>(PASSWORD_KV);
}

export function hasPassword(): boolean {
  return Boolean(process.env.APP_PASSWORD) || storedPassword() != null;
}

/** Checks a login attempt against APP_PASSWORD, or the password chosen in the app. */
export function verifyLogin(input: string): boolean {
  if (process.env.APP_PASSWORD) return checkPassword(input);
  const stored = storedPassword();
  return stored != null && input.length > 0 && verifyPasswordHash(input, stored);
}

export function authMode(): AuthMode {
  if (hasPassword()) return 'password';
  return isMockMode() ? 'open' : 'locked';
}

/** Signing key. Derived from the password by default, so changing it signs everyone out. */
function signingKey(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.APP_PASSWORD) return `pw:${process.env.APP_PASSWORD}`;
  return `pwh:${storedPassword()?.hash ?? ''}`;
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function createSessionToken(now = Date.now(), key = signingKey()): string {
  const expires = String(now + SESSION_MAX_AGE_S * 1000);
  return `${expires}.${sign(expires, key)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now(), key = signingKey()): boolean {
  if (!token) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig || !/^\d+$/.test(expires)) return false;
  if (Number(expires) <= now) return false;
  return safeEqual(sig, sign(expires, key));
}

export function checkPassword(input: string, expected = process.env.APP_PASSWORD ?? ''): boolean {
  return expected.length > 0 && safeEqual(input, expected);
}

/** `Authorization: Bearer <CRON_SECRET>`, for an external scheduler hitting /api/summary. */
export function isCronRequest(authorization: string | null, secret = process.env.CRON_SECRET): boolean {
  if (!secret || !authorization?.startsWith('Bearer ')) return false;
  return safeEqual(authorization.slice('Bearer '.length), secret);
}

/** Only allow same-site relative redirects after login. */
export function safeNextPath(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/dashboard';
}
