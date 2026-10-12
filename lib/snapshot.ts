import fs from 'node:fs';
import path from 'node:path';
import { setAlertSnapshot, type AlertRecord } from './db';
import { doorbellSnapshot } from './ring/account';
import { usesRingAccount } from './ring/oauth';
import type { CheckinSettings } from './routine/rules';

/**
 * Doorbell pictures attached to alerts, for context ("is her car there? is
 * someone at the door?"). Off unless the resident turned it on from their own
 * page; doorbell only, never an indoor camera. Kept on local disk for 30 days
 * and only served to signed-in family.
 */

const KEEP_MS = 30 * 24 * 60 * 60_000;

function dir(): string {
  return path.join(process.env.DATA_DIR || './data', 'snapshots');
}

/** Whether this setup can take snapshots at all (a Ring account with a doorbell). */
export function snapshotsSupported(): boolean {
  return usesRingAccount();
}

/** Takes and attaches a doorbell picture for a new alert. Never throws. */
export async function attachSnapshot(alert: AlertRecord, settings: CheckinSettings): Promise<string | null> {
  if (!settings.snapshotsAllowed || !snapshotsSupported()) return null;
  try {
    const shot = await doorbellSnapshot();
    if (!shot) return null;
    fs.mkdirSync(path.resolve(/*turbopackIgnore: true*/ dir()), { recursive: true });
    const file = `${alert.id}-${Date.now()}.jpg`;
    fs.writeFileSync(path.join(path.resolve(/*turbopackIgnore: true*/ dir()), file), shot.image);
    setAlertSnapshot(alert.id, file);
    return file;
  } catch (err) {
    console.warn(`[snapshot] couldn't take a picture for ${alert.key}:`, (err as Error).message);
    return null;
  }
}

/** Reads a stored picture by its file name, or null. Names are checked, so no path tricks. */
export function readSnapshot(file: string): Buffer | null {
  if (!/^\d+-\d+\.jpg$/.test(file)) return null;
  try {
    return fs.readFileSync(path.join(path.resolve(/*turbopackIgnore: true*/ dir()), file));
  } catch {
    return null;
  }
}

export function pruneSnapshots(now: number): void {
  const d = path.resolve(/*turbopackIgnore: true*/ dir());
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d)) {
    const taken = Number(/^\d+-(\d+)\.jpg$/.exec(f)?.[1]);
    if (taken && now - taken > KEEP_MS) fs.rmSync(path.join(d, f), { force: true });
  }
}
