import { headers } from 'next/headers';
import { deleteKv, getKv } from '@/lib/db';

/** How long a new sensor link stays visible on the Setup page. */
export const PENDING_LINK_MS = 60 * 60_000;

export const pendingLinkKey = (deviceId: string) => `sensor_link:${deviceId}`;

export function pendingLink(deviceId: string): string | null {
  const v = getKv<{ key: string; expires: number }>(pendingLinkKey(deviceId));
  if (!v) return null;
  if (v.expires < Date.now()) {
    deleteKv(pendingLinkKey(deviceId));
    return null;
  }
  return v.key;
}

/** The address this app is being reached at (APP_URL wins), for building links to share. */
export async function appBaseUrl(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto')?.split(',')[0].trim() ?? 'http';
  return `${proto}://${host}`;
}

/** Browsers only allow camera access on https pages or on the computer itself. */
export function cameraWillWork(baseUrl: string): boolean {
  const { protocol, hostname } = new URL(baseUrl);
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
