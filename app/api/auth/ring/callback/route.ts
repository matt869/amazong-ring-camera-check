import { NextResponse, type NextRequest } from 'next/server';
import { insertEvents } from '@/lib/db';
import { runCheck } from '@/lib/checkin';
import { syncDevices } from '@/lib/ring/devices';
import { fetchRecentEvents } from '@/lib/ring/events';
import { exchangeCode, isMockMode } from '@/lib/ring/oauth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get('code');
  const state = params.get('state');
  const expected = req.cookies.get('ring_oauth_state')?.value;
  const fail = (reason: string) => NextResponse.redirect(new URL(`/?error=${encodeURIComponent(reason)}`, req.url));

  const providerError = params.get('error');
  if (providerError) return fail(providerError);
  if (!code) return fail('missing_code');
  if (!state || state !== expected) return fail('state_mismatch');

  try {
    await exchangeCode(code);
    await syncDevices();
    if (!isMockMode()) insertEvents(await fetchRecentEvents());
    await runCheck();
  } catch (err) {
    console.error('[ring] connect failed:', err);
    return fail('connect_failed');
  }

  const res = NextResponse.redirect(new URL('/dashboard?connected=1', req.url));
  res.cookies.delete('ring_oauth_state');
  return res;
}
