import Link from 'next/link';
import { listDevices } from '@/lib/db';
import { isMockMode } from '@/lib/ring/oauth';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  state_mismatch: 'The sign-in link expired or was opened in a different browser. Please try again.',
  missing_code: 'Ring did not return an authorization code. Please try again.',
  connect_failed: 'Connected to Ring, but loading your devices failed. Check the server log and try again.',
  access_denied: 'Ring access was declined.',
};

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const demo = isMockMode();
  const hasSensors = !demo && listDevices().length > 0;

  return (
    <div className="stack">
      {error && <p className="notice error">{ERRORS[error] ?? `Sign-in failed: ${error}`}</p>}
      <section className="hero">
        <h1>Know they&apos;re okay, without having to ask.</h1>
        <p className="tagline">
          Ring alerts you when something happens. Home Check-in alerts you when something that should happen
          doesn&apos;t.
        </p>
        <p>
          For the daughter in another city whose mother lives alone. It learns her everyday rhythm from Ring sensors (or
          a spare webcam), stays quiet on normal days, and when a day looks different it texts her first, then you, then a
          neighbor, until someone knows she&apos;s fine.
        </p>
        <div className="row">
          {hasSensors ? (
            <Link className="button" href="/dashboard">
              Open today&apos;s check-in
            </Link>
          ) : (
            <Link className="button" href="/setup">
              Set up a webcam
            </Link>
          )}
          {demo && (
            <Link className="button secondary" href="/dashboard">
              Look around with demo data
            </Link>
          )}
        </div>
        {demo && (
          <p className="subtle">
            Nothing is connected yet, so the dashboard shows a simulated home with nine weeks of routine. Setting up a
            webcam replaces it with real check-ins.
          </p>
        )}
      </section>
      <div className="features">
        <div className="card">
          <h3>Asks her first</h3>
          <p>A friendly &ldquo;are you OK?&rdquo; text with a one-tap reply. Family only hears if she doesn&apos;t answer, and a neighbor only if nobody can check.</p>
        </div>
        <div className="card">
          <h3>Notices slow changes</h3>
          <p>Getting up a little later each week, going out less: the gradual decline no single day shows, compared week by week.</p>
        </div>
        <div className="card">
          <h3>One digest for the family</h3>
          <p>A short weekly note for every sibling: how her week went, who called or visited, and anything worth a conversation.</p>
        </div>
        <div className="card">
          <h3>Watches the door, not her</h3>
          <p>Doorbell visits are sorted into expected, regular, deliveries and unexpected. Repeat unexpected callers raise a scam warning.</p>
        </div>
        <div className="card">
          <h3>Patterns, not video</h3>
          <p>Only the times of movement are used. She has her own page showing exactly what&apos;s shared, and can pause it.</p>
        </div>
        <div className="card">
          <h3>Learns the routine</h3>
          <p>Ring Event History becomes a baseline on day one: when she gets up, which hours are busy, how long a normal quiet spell lasts.</p>
        </div>
      </div>
    </div>
  );
}
