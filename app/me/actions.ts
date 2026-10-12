'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSettings } from '@/lib/db';
import { endPrivacyPause, pauseUntilMorning, residentKeyValid, setSnapshotsAllowed, startPrivacyPause } from '@/lib/resident';

/** Actions from the resident's own page. Public: the private link's key is the authorization. */
function keyFrom(formData: FormData): string {
  const key = String(formData.get('key') ?? '');
  if (!residentKeyValid(key)) redirect('/');
  return key;
}

function done(key: string) {
  revalidatePath('/', 'layout');
  redirect(`/me/${key}`);
}

export async function pauseSharingAction(formData: FormData) {
  const key = keyFrom(formData);
  const now = Date.now();
  const tz = getSettings().timezone;
  const choice = String(formData.get('for'));
  const until =
    choice === 'morning' ? pauseUntilMorning(now, tz) : now + Math.min(12, Math.max(1, Number(choice) || 1)) * 60 * 60_000;
  await startPrivacyPause(until, now);
  done(key);
}

export async function resumeSharingAction(formData: FormData) {
  const key = keyFrom(formData);
  endPrivacyPause();
  done(key);
}

export async function snapshotsAction(formData: FormData) {
  const key = keyFrom(formData);
  setSnapshotsAllowed(formData.get('allow') === 'yes');
  done(key);
}
