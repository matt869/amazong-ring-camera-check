import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getDayReport, getDaySummary } from '@/lib/checkin';
import { listAlerts, listPauseWindows } from '@/lib/db';
import { residentKeyValid } from '@/lib/resident';
import { isPrivacyPaused, RULES } from '@/lib/routine/rules';
import { formatDateTime, formatTime } from '@/lib/routine/time';
import { snapshotsSupported } from '@/lib/snapshot';
import { pauseSharingAction, resumeSharingAction, snapshotsAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'What’s shared' };

const maskPhone = (p: string) => (p.length > 4 ? `a number ending ${p.slice(-4)}` : 'your phone');

/**
 * The resident's own page: plain language, large type. Everything the family
 * sees about them, who is told when, and a pause that really stops recording.
 */
export default async function ResidentPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!residentKeyValid(key)) notFound();

  const now = Date.now();
  const report = getDayReport(undefined, now);
  const summary = await getDaySummary(report, now);
  const s = report.settings;
  const tz = s.timezone;
  const name = s.residentName;
  const paused = isPrivacyPaused(s, now);
  const privacyUntil = listPauseWindows()
    .filter((w) => w.by === 'resident' && w.from <= now && w.until > now)
    .reduce((m, w) => Math.max(m, w.until), 0);

  const tracked = report.devices.filter((d) => d.countsAsActivity);
  const rooms = [...new Set(tracked.filter((d) => d.kind !== 'contact_sensor').map((d) => d.location))];
  const doors = [...new Set(tracked.filter((d) => d.kind === 'contact_sensor').map((d) => d.location))];
  const hasDoorbell = report.devices.some((d) => d.kind === 'doorbell');
  const sent = listAlerts({ since: now - 7 * 86_400_000 }).filter((a) => a.severity !== 'info');

  return (
    <div className="resident-page stack">
      <section className="card stack">
        <h1>Hi {name}</h1>
        <p className="resident-lead">
          This is the check-in your family set up. It notices the times you move around at home, so they don&apos;t have
          to keep calling to ask if you&apos;re OK. This page shows everything it shares, and lets you pause it.
        </p>
      </section>

      <section className={`card stack ${paused || privacyUntil ? 'resident-paused' : ''}`}>
        {paused || privacyUntil ? (
          <form action={resumeSharingAction} className="stack">
            <input type="hidden" name="key" value={key} />
            <h2>Sharing is paused until {formatTime(privacyUntil || s.pausedUntil!, tz)}</h2>
            <p>Nothing is recorded until then. Your family can see that it&apos;s paused, but not why.</p>
            <div>
              <button className="button big" type="submit">
                Start sharing again
              </button>
            </div>
          </form>
        ) : (
          <form action={pauseSharingAction} className="stack">
            <input type="hidden" name="key" value={key} />
            <h2>Sharing is on</h2>
            <p>
              Want some privacy? Pause it, and nothing is recorded until it starts again. Your family will see that
              it&apos;s paused.
            </p>
            <div className="row">
              <button className="button secondary big-ish" type="submit" name="for" value="1">
                Pause for 1 hour
              </button>
              <button className="button secondary big-ish" type="submit" name="for" value="3">
                3 hours
              </button>
              <button className="button secondary big-ish" type="submit" name="for" value="morning">
                Until tomorrow morning
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="card stack">
        <h2>What your family sees</h2>
        <ul className="shared-list">
          {rooms.length > 0 && (
            <li>
              <strong>The times there&apos;s movement</strong> in: {rooms.join(', ')}.
            </li>
          )}
          {doors.length > 0 && (
            <li>
              <strong>When a door opens:</strong> {doors.join(', ')}. That&apos;s how it knows you&apos;ve gone out.
            </li>
          )}
          {hasDoorbell && (
            <li>
              <strong>When someone rings the doorbell</strong>, and whether the door was opened.
            </li>
          )}
          <li>
            <strong>A short note about the day.</strong> Today&apos;s says: <em>&ldquo;{summary.text}&rdquo;</em>
          </li>
        </ul>
        <p className="never">
          <strong>Never shared:</strong> video, sound, or what you&apos;re doing. Cameras here only report that something
          moved, and when.
        </p>
      </section>

      {hasDoorbell && snapshotsSupported() && (
        <form action={snapshotsAction} className="card stack">
          <input type="hidden" name="key" value={key} />
          <h2>A picture from the front door with alerts</h2>
          <p>
            When an alert goes out, one picture from the doorbell camera can be attached, so your family can see if
            someone is at the door. It never shows inside your home. {s.snapshotsAllowed ? 'This is on.' : 'This is off.'}
          </p>
          <div>
            {s.snapshotsAllowed ? (
              <button className="button secondary big-ish" type="submit" name="allow" value="no">
                Turn it off
              </button>
            ) : (
              <button className="button secondary big-ish" type="submit" name="allow" value="yes">
                Allow it
              </button>
            )}
          </div>
        </form>
      )}

      <section className="card stack">
        <h2>If a day looks different</h2>
        <ol className="ladder">
          {s.residentPhone && s.checkInFirst ? (
            <li>
              <strong>You get a text first</strong> at {maskPhone(s.residentPhone)}, asking if you&apos;re OK. One tap
              answers it.
            </li>
          ) : null}
          <li>
            <strong>Your family is told</strong>
            {s.residentPhone && s.checkInFirst ? ` if you haven’t answered after ${s.caregiverAfterMinutes} minutes.` : '.'}
          </li>
          {s.neighborPhone && (
            <li>
              <strong>{s.neighborName || 'A neighbor'} is asked to knock</strong> if nobody has been able to check after{' '}
              {s.neighborAfterMinutes} minutes.
            </li>
          )}
        </ol>
      </section>

      <section className="card stack">
        <h2>Messages about you this week</h2>
        {sent.length === 0 ? (
          <p>None. Nothing unusual was sent to your family in the last 7 days.</p>
        ) : (
          <ul className="shared-list">
            {sent.map((a) => (
              <li key={a.id}>
                <strong>{formatDateTime(a.createdAt, tz)}:</strong> {RULES[a.rule].label.toLowerCase()}.{' '}
                {a.resolutionNote ?? (a.acknowledgedAt ? 'Your family checked on it.' : '')}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="subtle footer-note">Your family set this up. You can ask them to change or turn off anything here.</p>
    </div>
  );
}
