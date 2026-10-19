/**
 * Ring event simulator: plays a morning at the resident's home into the
 * running app, one event every few seconds, as Ring-style signed webhooks.
 * Run it next to the dashboard to watch each event arrive.
 *
 *   npm run simulate                      # http://localhost:3000, every 4 s
 *   npm run simulate -- --every 2 --loop
 *   npm run simulate -- --url http://localhost:3001
 *
 * Uses the demo household's devices, so run the app in demo mode. Events are
 * signed with RING_WEBHOOK_SECRET (from the environment or .env.local) when
 * it's set, exactly as Ring signs them.
 */
import fs from 'node:fs';
import { signPayload, SIGNATURE_HEADER } from '../lib/ring/webhooks';

if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = (arg('url') ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const everyMs = Math.max(0.5, Number(arg('every') ?? 4)) * 1000;
const loop = process.argv.includes('--loop');
const secret = process.env.RING_WEBHOOK_SECRET;

/** A morning, as Ring would report it: [device, Ring event type, what it means]. */
const STORY: [string, string, string][] = [
  ['bedroom-motion', 'motion', 'Up and about: movement in the bedroom'],
  ['kitchen-motion', 'motion', 'Kitchen: making breakfast'],
  ['kitchen-motion', 'motion', 'Kitchen'],
  ['living-cam', 'motion', 'Living room'],
  ['front-door', 'ding', 'Doorbell pressed: a delivery'],
  ['front-door-contact', 'door_open', 'Front door opens: she answers'],
  ['front-door-contact', 'door_close', 'Front door closes'],
  ['living-cam', 'motion', 'Living room'],
  ['back-door', 'door_open', 'Back door opens: heading out for a walk'],
  ['back-door', 'door_close', 'Back door closes'],
];

const tty = process.stdout.isTTY;
const paint = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint(2, s);
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const bold = (s: string) => paint(1, s);

async function send(deviceId: string, type: string, n: number): Promise<string> {
  const body = JSON.stringify({
    event_id: `sim-${Date.now()}-${n}`,
    event_type: type,
    device_id: deviceId,
    created_at: new Date().toISOString(),
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers[SIGNATURE_HEADER] = signPayload(body, secret);
  const res = await fetch(`${url}/api/webhooks/ring`, { method: 'POST', headers, body });
  const out = (await res.json().catch(() => ({}))) as { inserted?: number; alerts?: number; error?: string };
  if (res.status === 401) throw new Error('signature rejected: RING_WEBHOOK_SECRET here must match the server’s');
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  if (!out.inserted) return dim('ignored (inside a privacy pause, or a duplicate)');
  return green('received') + (out.alerts ? bold(` · ${out.alerts} new alert(s)`) : '');
}

async function main() {
  console.log(bold('Ring event simulator') + dim(` → ${url}/api/webhooks/ring · every ${everyMs / 1000}s${secret ? ' · signed' : ''}${loop ? ' · looping' : ''}`));
  console.log(dim('Ctrl+C to stop.\n'));
  let n = 0;
  do {
    for (const [deviceId, type, label] of STORY) {
      const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      try {
        const result = await send(deviceId, type, n++);
        console.log(`${dim(time)}  ${label.padEnd(40)} ${dim(`${deviceId} · ${type}`.padEnd(32))} ${result}`);
      } catch (err) {
        const msg = (err as Error & { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED'
          ? `can't reach the app at ${url}. Start it first (npm run dev), or pass --url.`
          : (err as Error).message;
        console.error(red(`✗ ${msg}`));
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  } while (loop);
  console.log(dim('\nDone. Add --loop to keep going.'));
}

void main();
