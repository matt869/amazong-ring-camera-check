import type { Metadata } from 'next';
import Link from 'next/link';
import QRCode from 'qrcode';
import { hasPassword } from '@/lib/auth';
import { getSettings, listDevices } from '@/lib/db';
import { isMockMode } from '@/lib/ring/oauth';
import { formatAgo } from '@/lib/routine/time';
import { requireAuth } from '@/lib/session';
import { addWebcamAction, newLinkAction, removeWebcamAction, setPasswordAction } from './actions';
import { appBaseUrl, cameraWillWork, pendingLink } from './links';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Set up' };

const ERRORS: Record<string, string> = {
  short: 'Use at least 8 characters.',
  mismatch: 'Those passwords didn’t match.',
  'password-first': 'Choose a dashboard password before adding a webcam.',
};

const ROOMS = ['Kitchen', 'Living room', 'Bedroom', 'Hallway', 'Dining room'];

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ error?: string; added?: string }> }) {
  await requireAuth();
  const { error, added } = await searchParams;
  const passwordSet = hasPassword();
  const webcams = listDevices().filter((d) => d.kind === 'webcam');
  const base = await appBaseUrl();
  const secure = cameraWillWork(base);
  const name = getSettings().residentName;
  const now = Date.now();

  const links = await Promise.all(
    webcams.map(async (d) => {
      const key = pendingLink(d.id);
      if (!key) return null;
      const url = `${base}/sensor#k=${key}`;
      const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return { id: d.id, url, qr };
    }),
  );
  const linkFor = (id: string) => links.find((l) => l?.id === id) ?? null;

  return (
    <div className="stack">
      <div>
        <h1>Set up check-ins</h1>
        <p className="muted" style={{ margin: '6px 0 0', maxWidth: '64ch' }}>
          A webcam on a spare laptop or phone at {name}&apos;s home watches for movement. It never sends video or
          pictures: the device itself notices movement and only reports the time it happened.
        </p>
      </div>
      {error && ERRORS[error] && (
        <p className="notice error" role="alert">
          {ERRORS[error]}
        </p>
      )}
      {isMockMode() && passwordSet && webcams.length === 0 && (
        <p className="notice">Adding your first webcam replaces the demo data with real check-ins.</p>
      )}

      {/* Step 1: password */}
      <section className="card stack">
        <div className="step-head">
          <span className={`step-num${passwordSet ? ' done' : ''}`}>{passwordSet ? '✓' : '1'}</span>
          <h2>Dashboard password</h2>
        </div>
        {passwordSet ? (
          <p className="muted" style={{ margin: 0 }}>
            Set. The dashboard asks for it on each new device. This page shows when {name} is home alone, so don&apos;t
            share it widely.
          </p>
        ) : (
          <form action={setPasswordAction} className="form">
            <p className="muted" style={{ margin: 0 }}>
              The dashboard will show when {name} is home alone, so it needs a password before real cameras connect.
            </p>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="password">Choose a password</label>
                <input id="password" name="password" type="password" minLength={8} required autoComplete="new-password" />
                <span className="hint">At least 8 characters.</span>
              </div>
              <div className="field">
                <label htmlFor="again">Type it again</label>
                <input id="again" name="again" type="password" minLength={8} required autoComplete="new-password" />
              </div>
            </div>
            <div>
              <button className="button" type="submit">
                Save password
              </button>
            </div>
          </form>
        )}
      </section>

      {/* Step 2: webcams */}
      <section className={`card stack${passwordSet ? '' : ' disabled-step'}`} aria-disabled={!passwordSet}>
        <div className="step-head">
          <span className={`step-num${webcams.some((w) => w.online) ? ' done' : ''}`}>
            {webcams.some((w) => w.online) ? '✓' : '2'}
          </span>
          <h2>Webcams</h2>
        </div>

        {webcams.map((d) => {
          const link = linkFor(d.id);
          return (
            <div key={d.id} id={d.id} className={`webcam${added === d.id ? ' webcam-new' : ''}`}>
              <div className="spread">
                <div>
                  <strong>{d.name}</strong> <span className="subtle">· {d.location}</span>
                  <div className="subtle">
                    <span className={`device-dot ${d.online ? 'on' : 'off'}`} aria-hidden />
                    {d.online
                      ? `Connected · checked in ${formatAgo(now - (d.heartbeatAt ?? now))}`
                      : link
                        ? 'Waiting for the device to open the link below'
                        : 'Not connected'}
                  </div>
                </div>
                <div className="row">
                  <form action={newLinkAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <button className="button secondary small" type="submit">
                      {link ? 'New link' : 'Get setup link'}
                    </button>
                  </form>
                  <form action={removeWebcamAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <button className="button secondary small" type="submit">
                      Remove
                    </button>
                  </form>
                </div>
              </div>

              {link && (
                <div className="link-box">
                  <div className="qr" dangerouslySetInnerHTML={{ __html: link.qr }} aria-label="QR code for the sensor link" role="img" />
                  <div className="stack" style={{ gap: 8 }}>
                    <strong>Open this on the device that will sit in the {d.location.toLowerCase()}</strong>
                    <ol className="steps">
                      <li>Scan the QR code with that device&apos;s camera, or type the link into its browser (Chrome works best).</li>
                      <li>Tap <em>Start watching</em> and allow camera access.</li>
                      <li>Leave it plugged in, facing the room, with the page open. The screen can be dimmed.</li>
                    </ol>
                    <div>
                      <a className="button small" href={link.url} target="_blank" rel="noopener">
                        Use this computer&apos;s camera
                      </a>
                    </div>
                    <input className="link-input" readOnly value={link.url} aria-label="Sensor link" />
                    <span className="hint">
                      Anyone with this link can send movement for this camera, so share it only with that device. Getting a
                      new link turns this one off. It stays visible here for an hour.
                    </span>
                    {!secure && (
                      <p className="notice error" style={{ margin: 0 }}>
                        Cameras only work on secure (https) pages or on this computer itself. From another device this link
                        won&apos;t get camera access. Open it on this computer (the one running the app), or set up a secure
                        link (see the README, &ldquo;Using a webcam on another device&rdquo;).
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {passwordSet ? (
          <form action={addWebcamAction} className="form add-webcam">
            <h3>{webcams.length ? 'Add another webcam' : 'Add a webcam'}</h3>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="room">Which room will it watch?</label>
                <input id="room" name="room" list="rooms" defaultValue={webcams.length ? '' : 'Kitchen'} required maxLength={40} />
                <datalist id="rooms">
                  {ROOMS.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
                <span className="hint">Pick the room {name} passes through most in the morning, usually the kitchen.</span>
              </div>
              <div className="field">
                <label htmlFor="name">Name (optional)</label>
                <input id="name" name="name" placeholder="e.g. Old laptop" maxLength={60} />
              </div>
            </div>
            <div>
              <button className="button" type="submit">
                Add webcam
              </button>
            </div>
          </form>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Save a password first.</p>
        )}
      </section>

      <section className="card stack">
        <h2>Tips</h2>
        <ul className="tips">
          <li>
            <strong>Placement:</strong> point it at the part of the room {name} walks through, not at a window, TV or
            ceiling fan (moving light counts as movement). Pets will also count.
          </li>
          <li>
            <strong>Light:</strong> a regular webcam can&apos;t see in the dark, so night-time movement is missed. Mornings
            work once lights are on or daylight comes in.
          </li>
          <li>
            <strong>Two rooms are better than one.</strong> With one camera, time spent in other rooms looks quiet. A second
            device in the bedroom or hallway helps.
          </li>
          <li>
            <strong>Keep it running:</strong> plugged in, on Wi-Fi, page open. If every camera stops checking in, you get a
            &ldquo;monitoring offline&rdquo; alert instead of a false alarm about {name}.
          </li>
        </ul>
        <p className="muted" style={{ margin: 0 }}>
          When a camera is connected, <Link href="/dashboard">the dashboard</Link> starts learning {name}&apos;s routine.
          Alerts based on their usual times become accurate after about 3 days.
        </p>
      </section>
    </div>
  );
}
