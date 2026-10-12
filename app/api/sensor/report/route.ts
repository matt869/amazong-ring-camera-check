import { NextResponse, type NextRequest } from 'next/server';
import { evaluateAlerts } from '@/lib/checkin';
import { ingestSensorReport } from '@/lib/sensor/ingest';

export const dynamic = 'force-dynamic';

/**
 * Webcam sensor check-ins: motion timestamps plus an implicit heartbeat.
 * Authenticated by the sensor's own key (Authorization: Bearer <key>), not a login.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = ingestSensorReport(req.headers.get('authorization'), body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // New motion can clear alerts ("no activity this morning"), and a returning
  // camera clears "monitoring offline", so re-check on every report.
  await evaluateAlerts();
  return NextResponse.json({ ok: true, device: result.device.name, received: result.inserted.length, serverTime: Date.now() });
}
