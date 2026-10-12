'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { hasPassword, setAppPassword } from '@/lib/auth';
import { createWebcamDevice, deleteDevice, deleteKv, leaveDemoMode, setKv, setSensorKeyHash } from '@/lib/db';
import { MOCK_DEVICES } from '@/lib/ring/mock';
import { isMockMode } from '@/lib/ring/oauth';
import { hashSensorKey, newSensorKey } from '@/lib/sensor/ingest';
import { requireAuth, startSession } from '@/lib/session';
import { PENDING_LINK_MS, pendingLinkKey } from './links';

const clean = (v: FormDataEntryValue | null, max: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** First-time password, chosen in the app. Changing it later is done with APP_PASSWORD. */
export async function setPasswordAction(formData: FormData) {
  if (hasPassword()) {
    await requireAuth();
    redirect('/setup');
  }
  const password = String(formData.get('password') ?? '');
  const again = String(formData.get('again') ?? '');
  if (password.length < 8) redirect('/setup?error=short');
  if (password !== again) redirect('/setup?error=mismatch');
  setAppPassword(password);
  await startSession(); // keep the person who just set it signed in
  revalidatePath('/', 'layout');
  redirect('/setup');
}

/** Shows the setup link for a sensor for a while; only the key's hash is kept for good. */
function rememberLink(deviceId: string, key: string) {
  setKv(pendingLinkKey(deviceId), { key, expires: Date.now() + PENDING_LINK_MS });
}

export async function addWebcamAction(formData: FormData) {
  await requireAuth();
  // Webcams mean real data about a real person: require a password first.
  if (!hasPassword()) redirect('/setup?error=password-first');

  const room = clean(formData.get('room'), 40) || 'Living room';
  const name = clean(formData.get('name'), 60) || `${room} webcam`;
  if (isMockMode()) leaveDemoMode(MOCK_DEVICES.map((d) => d.id));

  const id = `webcam-${randomBytes(4).toString('hex')}`;
  const key = newSensorKey();
  createWebcamDevice(id, name, room, hashSensorKey(key));
  rememberLink(id, key);
  revalidatePath('/', 'layout');
  redirect(`/setup?added=${id}#${id}`);
}

/** Issues a fresh link; the old one stops working immediately. */
export async function newLinkAction(formData: FormData) {
  await requireAuth();
  const id = String(formData.get('id') ?? '');
  // Only webcams report with a key; a Ring device must never become one.
  if (!id.startsWith('webcam-')) redirect('/setup');
  const key = newSensorKey();
  setSensorKeyHash(id, hashSensorKey(key));
  rememberLink(id, key);
  revalidatePath('/', 'layout');
  redirect(`/setup#${id}`);
}

export async function removeWebcamAction(formData: FormData) {
  await requireAuth();
  const id = String(formData.get('id') ?? '');
  if (!id.startsWith('webcam-')) redirect('/setup');
  deleteDevice(id);
  deleteKv(pendingLinkKey(id));
  revalidatePath('/', 'layout');
  redirect('/setup');
}
