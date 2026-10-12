import { NextResponse, type NextRequest } from 'next/server';
import { readSnapshot } from '@/lib/snapshot';

export const dynamic = 'force-dynamic';

/** A doorbell picture attached to an alert. Behind the dashboard login (see proxy.ts). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const image = readSnapshot((await params).file);
  if (!image) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return new NextResponse(new Uint8Array(image), {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
  });
}
