import { NextResponse, type NextRequest } from 'next/server';
import { insertEvents } from '@/lib/db';
import { runCheck } from '@/lib/checkin';
import { isMockMode } from '@/lib/ring/oauth';
import { parseWebhook, SIGNATURE_HEADER, verifySignature } from '@/lib/ring/webhooks';

export const dynamic = 'force-dynamic';

/** Receives Ring event notifications, stores them, and re-runs the check. */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const secret = process.env.RING_WEBHOOK_SECRET;

  if (secret) {
    if (!verifySignature(raw, req.headers.get(SIGNATURE_HEADER), secret)) {
      return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
    }
  } else if (!isMockMode()) {
    console.error('[webhook] RING_WEBHOOK_SECRET is not set; refusing unsigned webhook');
    return NextResponse.json({ error: 'webhook secret not configured' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const events = parseWebhook(body);
  const inserted = insertEvents(events);
  const { created } = await runCheck();
  return NextResponse.json({ received: events.length, inserted: inserted.length, alerts: created.length });
}
