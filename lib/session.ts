import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authMode, createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE_S, verifySessionToken } from './auth';

/** Server-side session checks for pages and server actions (which are public endpoints). */
export async function isSignedIn(): Promise<boolean> {
  return verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Allows the request in open (demo, no password) mode or with a valid session; else sends to login. */
export async function requireAuth(): Promise<void> {
  const mode = authMode();
  if (mode === 'open') return;
  if (mode === 'locked' || !(await isSignedIn())) redirect('/login');
}

const NAME_COOKIE = 'rc_name';

/**
 * Family members share one password, so "who checked on her?" comes from a
 * name each person types once; it's remembered in their browser.
 */
export async function familyMemberName(): Promise<string | null> {
  const v = (await cookies()).get(NAME_COOKIE)?.value;
  return v ? decodeURIComponent(v).slice(0, 40) : null;
}

export async function rememberFamilyMemberName(name: string): Promise<void> {
  (await cookies()).set(NAME_COOKIE, encodeURIComponent(name.slice(0, 40)), {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.APP_URL ?? '').startsWith('https://'),
    maxAge: 365 * 24 * 60 * 60,
    path: '/',
  });
}

export async function startSession(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.APP_URL ?? '').startsWith('https://'),
    maxAge: SESSION_MAX_AGE_S,
    path: '/',
  });
}
