import { NextResponse } from 'next/server';
import { listDevices } from '@/lib/db';
import { syncDevices } from '@/lib/ring/devices';
import { RingNotConnectedError } from '@/lib/ring/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ devices: listDevices() });
}

/** Re-sync the device list from Ring. */
export async function POST() {
  try {
    return NextResponse.json({ devices: await syncDevices() });
  } catch (err) {
    const status = err instanceof RingNotConnectedError ? 401 : 502;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
