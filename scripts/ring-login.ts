/**
 * One-time Ring sign-in. Run it yourself in a terminal:
 *
 *   npm run ring:login
 *
 * You type your Ring email, password and the 2FA code Ring sends you. Only
 * the long-lived refresh token Ring issues is saved (to .env.local); your
 * password is never stored. The app then connects as your account,
 * read-only. To revoke access later, remove "Ring Check-in" under
 * Control Center > Authorized Client Devices in the Ring app.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';

const ENV_FILE = path.resolve('.env.local');

// --- prompts --------------------------------------------------------------------

// One reader for the whole session, so pasted or piped answers aren't lost
// between questions. Output is muted while a secret is typed.
let muted = false;
const output = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  },
});
const rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
const lines: string[] = [];
const waiters: ((line: string | null) => void)[] = [];
rl.on('line', (line) => (waiters.length ? waiters.shift()!(line) : lines.push(line)));
rl.on('close', () => waiters.splice(0).forEach((w) => w(null)));

async function ask(question: string, { hidden = false } = {}): Promise<string> {
  process.stdout.write(question);
  muted = hidden;
  const line = lines.length ? lines.shift()! : await new Promise<string | null>((resolve) => waiters.push(resolve));
  muted = false;
  if (hidden || !process.stdin.isTTY) process.stdout.write('\n');
  if (line == null) throw new Error('Input ended before sign-in finished.');
  return line.trim();
}

// --- .env.local -----------------------------------------------------------------

function readEnvFile(): string {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
}

function envValue(contents: string, key: string): string | undefined {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(contents);
  return m?.[1]?.trim() || undefined;
}

function setEnvValue(key: string, value: string): void {
  let contents = readEnvFile();
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  contents = re.test(contents) ? contents.replace(re, line) : `${contents}${contents && !contents.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.writeFileSync(ENV_FILE, contents, { mode: 0o600 });
}

/** Load .env.local into process.env (without overriding real env vars), so DATA_DIR etc. apply. */
function loadEnvFile(): void {
  for (const raw of readEnvFile().split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(raw.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const mask = (token: string) => `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`;

// --- main -----------------------------------------------------------------------

async function main() {
  console.log('\nRing Check-in: sign in to Ring\n');
  console.log('Your password and 2FA code go straight to Ring. Only the access token Ring returns is saved,');
  console.log(`to ${ENV_FILE}. The app only reads activity; it never arms, disarms or changes anything.\n`);

  const { RingRestClient } = await import('ring-client-api/rest-client');
  const email = await ask('Ring email: ');
  const password = await ask('Ring password (hidden): ', { hidden: true });
  if (!email || !password) throw new Error('Email and password are required.');

  const client = new RingRestClient({ email, password, controlCenterDisplayName: 'Ring Check-in' });
  let auth;
  try {
    auth = await client.getCurrentAuth();
  } catch (err) {
    if (!client.promptFor2fa) throw err;
    console.log(`\n${client.promptFor2fa}`);
    for (let attempt = 1; ; attempt++) {
      const code = await ask('Verification code: ');
      try {
        auth = await client.getAuth(code);
        break;
      } catch {
        if (attempt >= 5) throw new Error('Too many incorrect codes. Run npm run ring:login to try again.');
        console.log('That code didn’t work. Check the latest text or email from Ring and try again.');
      }
    }
  }

  let refreshToken = auth.refresh_token;
  console.log('\nSigned in. Checking which devices this account can see…');

  // Read-only sanity check. Ring may rotate the token while we do this; keep the newest.
  const { RingApi } = await import('ring-client-api');
  const api = new RingApi({ refreshToken, controlCenterDisplayName: 'Ring Check-in' });
  api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    refreshToken = newRefreshToken;
  });
  try {
    const devices = await api.fetchRingDevices();
    const cams = devices.allCameras.map((c) => c.description);
    const hubs = devices.baseStations.length + devices.beamBridges.length;
    console.log(`  Cameras and doorbells: ${cams.length ? cams.join(', ') : 'none'}`);
    console.log(`  Ring Alarm / bridge hubs: ${hubs} ${hubs ? '(door and motion sensors will be used)' : '(no alarm sensors)'}`);
    if (cams.length === 0 && hubs === 0) {
      console.log('\n  This account has no devices. If her Ring is shared with you, make sure you accepted the invite in the Ring app.');
    }
  } catch (err) {
    console.warn(`  Couldn't list devices (${(err as Error).message}). The token is still saved; check the app after starting it.`);
  } finally {
    api.disconnect();
  }

  setEnvValue('RING_REFRESH_TOKEN', refreshToken);
  console.log(`\nSaved RING_REFRESH_TOKEN ${mask(refreshToken)} to .env.local`);

  // A previous connection's rotated token lives in the database; this login replaces it.
  loadEnvFile();
  const { deleteKv } = await import('../lib/db');
  deleteKv('ring_refresh_token');

  // Real data needs a dashboard password; the app stays locked without one.
  const contents = readEnvFile();
  if (!envValue(contents, 'APP_PASSWORD') && !process.env.APP_PASSWORD) {
    console.log('\nThe dashboard shows when she is home alone, so it needs a password.');
    for (;;) {
      const pw = await ask('Choose a dashboard password (hidden, 8+ characters): ', { hidden: true });
      const again = await ask('Type it again: ', { hidden: true });
      if (pw.length >= 8 && pw === again && !/\s/.test(pw)) {
        setEnvValue('APP_PASSWORD', pw);
        console.log('Saved APP_PASSWORD to .env.local');
        break;
      }
      console.log(pw !== again ? 'Those didn’t match. Try again.' : 'Use at least 8 characters, no spaces.');
    }
  }
  if (envValue(contents, 'RING_MOCK') === 'true') {
    console.log('\nNote: RING_MOCK=true is set in .env.local, which keeps the app in demo mode. Remove it to use real data.');
  }

  console.log('\nDone. Restart the app to connect:');
  console.log('  npm run build && npm start      (or npm run dev)\n');
  console.log('Run only one copy of the app with this token at a time; two copies will fight over it.');
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nSign-in failed: ${(err as Error).message}`);
  process.exit(1);
});
