import { NextResponse, type NextRequest } from 'next/server';
import { authMode, isCronRequest, SESSION_COOKIE, verifySessionToken } from './lib/auth';

/**
 * Paths reachable without signing in. Each authenticates its own way: webhooks
 * with an HMAC signature, webcam sensors with a per-device key, check-in
 * replies with a signed link, the resident's page with its private key, and
 * Alexa with Amazon's request signature.
 */
const PUBLIC_PREFIXES = ['/login', '/api/webhooks/', '/api/health', '/sensor', '/api/sensor/', '/r/', '/me/', '/api/alexa'];

export function proxy(req: NextRequest) {
  const mode = authMode();
  if (mode === 'open') return NextResponse.next();

  const path = req.nextUrl.pathname;
  if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p))) return NextResponse.next();
  if (path === '/api/summary' && isCronRequest(req.headers.get('authorization'))) return NextResponse.next();
  if (mode === 'password' && verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (path.startsWith('/api/')) {
    return NextResponse.json({ error: mode === 'locked' ? 'APP_PASSWORD is not configured' : 'sign in required' }, { status: 401 });
  }
  const login = new URL('/login', req.url);
  if (path !== '/') login.searchParams.set('next', path + req.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
