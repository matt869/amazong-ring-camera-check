import { NextResponse } from 'next/server';
import { getKv } from '@/lib/db';
import { getRingAccountStatus } from '@/lib/ring/account';
import { isMockMode, usesRingAccount } from '@/lib/ring/oauth';

export const dynamic = 'force-dynamic';

/**
 * Liveness for uptime monitors. Deliberately reveals nothing about the
 * household: only whether the rule check has run recently.
 */
export async function GET() {
  const lastCheckAt = getKv<number>('last_check_at');
  const intervalMin = Number(process.env.CHECK_INTERVAL_MINUTES) || 5;
  const checking = lastCheckAt != null && Date.now() - lastCheckAt < intervalMin * 3 * 60_000;
  // A dropped Ring connection means no events: as bad as checks stopping.
  const ring = usesRingAccount() ? getRingAccountStatus().state : null;
  const healthy = checking && (ring == null || ring === 'connected');
  return NextResponse.json(
    { ok: healthy, mode: isMockMode() ? 'demo' : usesRingAccount() ? 'ring-account' : 'ring-oauth', ring, lastCheckAt },
    { status: healthy ? 200 : 503 },
  );
}
