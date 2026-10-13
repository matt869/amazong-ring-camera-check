import { NextResponse } from 'next/server';
import { monitoringState } from '@/lib/checkin';
import { getKv, listDevices } from '@/lib/db';
import { getRingAccountStatus } from '@/lib/ring/account';
import { isMockMode, usesRingAccount } from '@/lib/ring/oauth';

export const dynamic = 'force-dynamic';

/** Where activity comes from. */
function dataSource(): 'demo' | 'ring-account' | 'ring-oauth' | 'webcam' {
  if (isMockMode()) return 'demo';
  if (usesRingAccount()) return 'ring-account';
  return process.env.RING_CLIENT_ID ? 'ring-oauth' : 'webcam';
}

/**
 * Liveness for uptime monitors. Deliberately reveals nothing about the
 * household: only whether the rule check has run recently and data is arriving.
 */
export async function GET() {
  const lastCheckAt = getKv<number>('last_check_at');
  const intervalMin = Number(process.env.CHECK_INTERVAL_MINUTES) || 5;
  const checking = lastCheckAt != null && Date.now() - lastCheckAt < intervalMin * 3 * 60_000;
  // A dropped Ring connection, or every webcam gone quiet, means no events: as bad as checks stopping.
  const ring = usesRingAccount() ? getRingAccountStatus().state : null;
  const flowing = monitoringState(listDevices()).state !== 'down';
  const healthy = checking && flowing && (ring == null || ring === 'connected');
  return NextResponse.json({ ok: healthy, mode: dataSource(), ring, lastCheckAt }, { status: healthy ? 200 : 503 });
}
