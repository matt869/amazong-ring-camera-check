import type { Metadata } from 'next';
import Link from 'next/link';
import AlertBanner from '@/components/AlertBanner';
import FamilyLog from '@/components/FamilyLog';
import VisitList from '@/components/VisitList';
import { isBedrockEnabled } from '@/lib/aws/bedrock';
import { isSnsConfigured } from '@/lib/aws/notify';
import { runCheck } from '@/lib/checkin';
import { getSettings, listDevices } from '@/lib/db';
import { getWeekDigest, getWeekReport } from '@/lib/digest';
import { addDays, formatMinuteOfDay, WEEKDAYS } from '@/lib/routine/time';
import { describeExpected, parseExpectedVisits } from '@/lib/routine/visitors';
import { familyMemberName } from '@/lib/session';
import { acknowledgeAlertAction, addFamilyLogAction, deleteFamilyLogAction, sendDigestNowAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'This week' };

const NOTICES: Record<string, { text: string; error?: boolean }> = {
  'digest-sent': { text: 'Digest sent to everyone on the alert topic.' },
  'digest-logged': { text: 'SNS isn’t configured, so the digest was written to the server log instead.' },
  'digest-failed': { text: 'Sending the digest failed. Check the server log.', error: true },
  'log-missing': { text: 'Add your name to log a check-in.', error: true },
};

export default async function WeekPage({ searchParams }: { searchParams: Promise<{ end?: string; notice?: string }> }) {
  const { end, notice } = await searchParams;
  await runCheck();
  const now = Date.now();
  const settings = getSettings();
  const report = getWeekReport(end, now, settings);
  const digest = await getWeekDigest(report, now);
  const f = report.facts;
  const tz = settings.timezone;
  const name = settings.residentName;
  const banner = notice ? NOTICES[notice] : undefined;
  const hasDoorbell = listDevices().some((d) => d.kind === 'doorbell');
  const expected = parseExpectedVisits(settings.expectedVisits).visits;

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1>{name}&apos;s week</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>{f.range}</p>
        </div>
        <nav className="row" aria-label="Week">
          <Link className="button secondary small" href={`/dashboard/week?end=${addDays(report.endDate, -7)}`}>
            ← Previous week
          </Link>
          {!report.isCurrent && (
            <Link className="button secondary small" href={`/dashboard/week?end=${addDays(report.endDate, 7)}`}>
              Next week →
            </Link>
          )}
        </nav>
      </div>
      {banner && (
        <p className={`notice${banner.error ? ' error' : ''}`} role="status">
          {banner.text}
        </p>
      )}

      <section className="card stack" aria-labelledby="digest-heading">
        <h2 id="digest-heading">Family digest</h2>
        <p className="summary" style={{ margin: 0 }}>
          {digest.text}
        </p>
        <p className="subtle" style={{ margin: 0 }}>
          {digest.source === 'bedrock' ? 'Written by Claude via Amazon Bedrock' : 'Generated from activity rules'} ·{' '}
          {settings.digestEnabled
            ? `sent to the family every ${WEEKDAYS[settings.digestWeekday]} at ${formatMinuteOfDay(settings.digestMinute)}`
            : 'weekly sending is off (Settings)'}
        </p>
        {report.isCurrent && (
          <form action={sendDigestNowAction}>
            <button className="button secondary small" type="submit">
              {isSnsConfigured() ? 'Send it to the family now' : 'Send now (to the server log)'}
            </button>
          </form>
        )}
      </section>

      <div className="stats">
        <Stat label="Up at, typically" value={f.usualWake ?? '—'} note={f.previousWeekWake ? `${f.previousWeekWake} the week before` : undefined} />
        <Stat label="Outings" value={f.outings == null ? '—' : String(f.outings)} note={f.previousWeekOutings != null ? `${f.previousWeekOutings} the week before` : undefined} />
        <Stat
          label="Movements a day"
          value={f.movementsPerDay == null ? '—' : String(f.movementsPerDay)}
          note={f.previousWeekMovementsPerDay != null ? `${f.previousWeekMovementsPerDay} the week before` : undefined}
        />
        <Stat label="Days with data" value={`${f.daysWithData} of 7`} />
      </div>

      {f.trends.length > 0 && (
        <section className="card stack trend-teaser">
          <div className="spread">
            <h2>Changing slowly</h2>
            <Link href="/dashboard/trends">See the trends →</Link>
          </div>
          <ul className="findings">
            {f.trends.map((t) => (
              <li key={t.title}>
                <strong>{t.title}.</strong> {t.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid-2">
        <FamilyLog
          entries={report.log}
          residentName={name}
          defaultName={await familyMemberName()}
          timezone={tz}
          back="/dashboard/week"
          add={addFamilyLogAction}
          remove={deleteFamilyLogAction}
        />
        <section className="card stack">
          <h2>Who checked in</h2>
          {f.familyCheckIns.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nobody logged a call or visit this week.</p>
          ) : (
            <ul className="devices">
              {f.familyCheckIns.map((p) => (
                <li key={p.who}>
                  <strong>{p.who}</strong>
                  <span className="subtle">
                    {[
                      p.calls && `${p.calls} call${p.calls > 1 ? 's' : ''}`,
                      p.visits && `${p.visits} visit${p.visits > 1 ? 's' : ''}`,
                      p.messages && `${p.messages} message${p.messages > 1 ? 's' : ''}`,
                      p.other && `${p.other} other`,
                      p.alertsChecked && `answered ${p.alertsChecked} alert${p.alertsChecked > 1 ? 's' : ''}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {f.daysWithoutContact.length > 0 && f.familyCheckIns.length > 0 && (
            <p className="subtle" style={{ margin: 0 }}>
              No check-in logged on {f.daysWithoutContact.join(', ')}.
            </p>
          )}
        </section>
      </div>

      <section className="card stack">
        <h2>Alerts this week</h2>
        {report.alerts.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>None.</p>
        ) : (
          <AlertBanner alerts={[...report.alerts].reverse()} timezone={tz} acknowledge={acknowledgeAlertAction} residentName={name} />
        )}
      </section>

      {hasDoorbell && (
        <section className="card stack" id="visitors">
          <div className="spread">
            <h2>At the door</h2>
            <span className="subtle">
              {f.visitors.expected + f.visitors.regular} expected or regular · {f.visitors.dropoff} likely deliveries ·{' '}
              {f.visitors.unexpected} unexpected
            </span>
          </div>
          <VisitList visits={report.visits} timezone={tz} showDate emptyText="Nobody rang the doorbell this week." />
          <p className="subtle" style={{ margin: 0 }}>
            &ldquo;Regular&rdquo; visits happen at about the same time on the same weekday most weeks. Expected visits come from
            Settings
            {expected.length ? `: ${expected.map((e) => `${e.label} (${describeExpected(e)})`).join('; ')}` : ' (none listed yet)'}.
            Only times are used, never faces: &ldquo;unexpected&rdquo; means outside any known pattern.
          </p>
        </section>
      )}

      <p className="subtle footer-note">
        {isBedrockEnabled() ? 'Claude only sees the numbers above, never raw sensor logs.' : 'Turn on Amazon Bedrock to have Claude write the digest.'}
      </p>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="subtle">{note}</div>}
    </div>
  );
}
