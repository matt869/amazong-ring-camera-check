import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { insertEvents, listDevices, listEvents } from '@/lib/db';
import { runCheck } from '@/lib/checkin';
import { isMockMode } from '@/lib/ring/oauth';
import { normalizeKind } from '@/lib/ring/webhooks';

export const dynamic = 'force-dynamic';

/** GET /api/events?hours=24  or  ?from=<ms>&to=<ms> */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const now = Date.now();
  const to = Number(p.get('to')) || now + 1;
  const from = Number(p.get('from')) || now - (Number(p.get('hours')) || 24) * 60 * 60_000;
  const limit = Math.min(Number(p.get('limit')) || 1000, 5000);
  return NextResponse.json({ from, to, events: listEvents(from, to, limit) });
}

/**
 * Manually record an event: { deviceId, kind, occurredAt? }.
 * Only enabled in demo mode, for simulating activity; real devices use the webhook.
 */
export async function POST(req: NextRequest) {
  if (!isMockMode()) {
    return NextResponse.json(
      { error: 'Manual events are only accepted in demo mode; use /api/webhooks/ring.' },
      { status: 403 },
    );
  }
  const body = (await req.json().catch(() => null)) as { deviceId?: string; kind?: string; occurredAt?: number } | null;
  const kind = normalizeKind(body?.kind);
  if (!body?.deviceId || !kind) {
    return NextResponse.json({ error: 'Expected { deviceId, kind: motion|ding|door_open|door_close }' }, { status: 400 });
  }
  if (!listDevices().some((d) => d.id === body.deviceId)) {
    return NextResponse.json({ error: `Unknown device ${body.deviceId}` }, { status: 404 });
  }
  const event = { id: `manual-${randomUUID()}`, deviceId: body.deviceId, kind, occurredAt: body.occurredAt ?? Date.now() };
  const inserted = insertEvents([event]);
  const { created } = await runCheck();
  return NextResponse.json({ inserted, alerts: created }, { status: 201 });
}
