import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { authorizeUrl, isMockMode } from '@/lib/ring/oauth';

export const dynamic = 'force-dynamic';

/** Starts the Ring OAuth flow (or skips straight to the callback in demo mode). */
export async function GET(req: NextRequest) {
  const state = randomBytes(16).toString('hex');
  const target = isMockMode()
    ? new URL(`/api/auth/ring/callback?code=demo&state=${state}`, req.url)
    : authorizeUrl(state);
  const res = NextResponse.redirect(target);
  res.cookies.set('ring_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    maxAge: 600,
    path: '/',
  });
  return res;
}
