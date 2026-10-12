import { NextResponse, type NextRequest } from 'next/server';
import { alexaSkillId, handleAlexaRequest, verifyAlexaRequest, type AlexaRequestBody } from '@/lib/alexa';
import { runCheck } from '@/lib/checkin';

export const dynamic = 'force-dynamic';

/**
 * Alexa custom skill endpoint ("Alexa, ask home check-in how Mom is today").
 * Public route, authenticated by Amazon's request signature and the skill ID.
 */
export async function POST(req: NextRequest) {
  if (!alexaSkillId()) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const raw = await req.text();
  const check = await verifyAlexaRequest(raw, {
    certUrl: req.headers.get('signaturecertchainurl'),
    signature: req.headers.get('signature-256'),
  });
  if (!check.ok) {
    console.warn('[alexa] rejected request:', check.reason);
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }
  await runCheck();
  return NextResponse.json(await handleAlexaRequest(JSON.parse(raw) as AlexaRequestBody));
}
