import Link from 'next/link';
import AlertBanner from '@/components/AlertBanner';
import AutoRefresh from '@/components/AutoRefresh';
import EventTimeline from '@/components/EventTimeline';
import FamilyLog from '@/components/FamilyLog';
import PauseControl from '@/components/PauseControl';
import RoutineChart from '@/components/RoutineChart';
import StatusCard from '@/components/StatusCard';
import VisitList from '@/components/VisitList';
import { getDayReport, getDaySummary, runCheck } from '@/lib/checkin';
import { listFamilyLog } from '@/lib/db';
import { pendingScenarioAlert } from '@/lib/demo';
import { getTrends } from '@/lib/insights';
import { RULES } from '@/lib/routine/rules';
import { formatAgo, formatTime, localParts } from '@/lib/routine/time';
import { familyMemberName } from '@/lib/session';
import { acknowledgeAlertAction, addFamilyLogAction, deleteFamilyLogAction, pauseAction, resumeAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ connected?: string }> }) {
  const { connected } = await searchParams;
  await runCheck();
  const now = Date.now();
  const report = getDayReport(undefined, now);
  const summary = await getDaySummary(report, now);
  const tz = report.settings.timezone;
  const urgent = report.openAlerts.filter((a) => a.severity !== 'info');
  const deviceNotices = report.openAlerts.filter((a) => a.severity === 'info');
  const monitoring = report.monitoring;
  const name = report.settings.residentName;
  const trends = getTrends(now, report.settings, report.devices);
  const pending = monitoring.state === 'demo' ? pendingScenarioAlert(report, now) : null;
  const log = listFamilyLog(now - 7 * 86_400_000, now + 1);
  const hasDoorbell = report.devices.some((d) => d.kind === 'doorbell');

  return (
    <div className="stack">
      <AutoRefresh seconds={60} />
      {connected && <p className="notice">Connected. Devices synced and the check-in is running.</p>}
      {/* Without incoming data, silence means nothing; say so loudly. */}
      {monitoring.state === 'demo' && (
        <p className="notice">
          You&apos;re looking at <strong>demo data</strong> from a simulated home. <Link href="/setup">Set up a webcam</Link>{' '}
          to start real check-ins.
        </p>
      )}
      {pending && (
        <p className="notice">
          Demo scenario: <strong>{pending.label}</strong>.{' '}
          {pending.at != null
            ? `Its “${RULES[pending.rule].label}” alert appears at about ${formatTime(pending.at, tz)} home time (it’s ${formatTime(now, tz)} there now). This page refreshes every minute.`
            : `It plays out during the day, so it won’t raise an alert today. It’s ${formatTime(now, tz)} at home now; try it again in the morning.`}
        </p>
      )}
      {monitoring.state === 'no-sensors' && (
        <p className="notice">
          No sensors yet. <Link href="/setup">Set up a webcam</Link> to start check-ins.
        </p>
      )}
      {monitoring.state === 'waiting' && (
        <p className="notice">
          Waiting for the first check-in. Open the sensor link from <Link href="/setup">Set up</Link> on the device at
          their home.
        </p>
      )}
      {monitoring.state === 'down' && (
        <p className="notice error" role="alert">
          {monitoring.cause === 'ring' ? (
            <>
              <strong>Can&apos;t reach Ring.</strong> No new activity is coming in, so alerts can&apos;t fire right now.
              Retrying every 5 minutes. ({monitoring.detail}) If this persists, run <code>npm run ring:login</code> again.
            </>
          ) : (
            <>
              <strong>No camera is checking in</strong>
              {monitoring.since ? ` (last at ${formatTime(monitoring.since, tz)})` : ''}, so alerts can&apos;t fire right now.
              Check that {monitoring.detail} is on, plugged in, on Wi-Fi, and the sensor page is open.
            </>
          )}
        </p>
      )}

      {/* Things that need a person go on top; device upkeep lives in the Devices card. */}
      <AlertBanner
        alerts={urgent}
        timezone={tz}
        acknowledge={acknowledgeAlertAction}
        residentName={name}
        caregiverAfterMinutes={report.settings.caregiverAfterMinutes}
      />

      <StatusCard
        status={report.status}
        summary={summary}
        facts={report.facts}
        devices={report.devices}
        timezone={tz}
        now={now}
      />

      <PauseControl
        pausedUntil={report.settings.pausedUntil}
        pausedBy={report.settings.pausedBy}
        residentName={name}
        timezone={tz}
        today={report.dateKey}
        back="/dashboard"
        pause={pauseAction}
        resume={resumeAction}
      />

      {/* Slow changes no single day shows: the decline families most often miss. */}
      {trends.findings.length > 0 && (
        <section className="card stack trend-teaser" aria-labelledby="trend-teaser">
          <div className="spread">
            <h2 id="trend-teaser">Changing slowly over the past weeks</h2>
            <Link href="/dashboard/trends">See the trends →</Link>
          </div>
          <ul className="findings">
            {trends.findings.map((f) => (
              <li key={f.metric}>
                <strong>{f.title}.</strong> {f.detail}
              </li>
            ))}
          </ul>
          <p className="subtle" style={{ margin: 0 }}>
            Each day looked normal on its own. Changes like these are easy to miss, and may be worth a conversation.
          </p>
        </section>
      )}

      <RoutineChart
        hourly={report.hourly}
        usual={report.baselineReady ? report.baseline.hourlyMean : null}
        nowHour={localParts(now, tz).hour}
        title="Today by hour"
      />

      <div className="grid-2">
        <section className="card stack">
          <div className="spread">
            <h2>Latest activity</h2>
            <Link href="/dashboard/timeline">Full timeline →</Link>
          </div>
          <EventTimeline
            events={report.events.slice(0, 8)}
            devices={report.devices}
            timezone={tz}
            groupByHour={false}
            emptyText="Nothing yet today."
          />
        </section>

        <section className="card stack">
          <div className="spread">
            <h2>Devices</h2>
            <Link href="/setup">Manage →</Link>
          </div>
          <AlertBanner alerts={deviceNotices} timezone={tz} acknowledge={acknowledgeAlertAction} compact />
          {report.devices.length === 0 ? (
            <p className="muted">
              No devices yet. <Link href="/setup">Set up a webcam</Link>.
            </p>
          ) : (
            <ul className="devices">
              {report.devices.map((d) => {
                const lowBattery = d.battery != null && d.battery <= report.settings.lowBatteryPercent;
                return (
                  <li key={d.id}>
                    <span>
                      <span className={`device-dot ${d.online ? 'on' : 'off'}`} aria-label={d.online ? 'online' : 'offline'} />
                      {d.name} <span className="subtle">· {d.location}</span>
                    </span>
                    <span className="subtle">
                      {d.battery != null && <span className={lowBattery ? 'battery-low' : undefined}>{d.battery}%</span>}
                      {d.battery != null && d.lastSeen && ' · '}
                      {d.lastSeen && `seen ${formatAgo(now - d.lastSeen)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="grid-2">
        <FamilyLog
          entries={log}
          residentName={name}
          defaultName={await familyMemberName()}
          timezone={tz}
          back="/dashboard"
          add={addFamilyLogAction}
          remove={deleteFamilyLogAction}
        />
        {hasDoorbell && (
          <section className="card stack" aria-labelledby="visits-heading">
            <div className="spread">
              <h2 id="visits-heading">At the door today</h2>
              <Link href="/dashboard/week#visitors">This week →</Link>
            </div>
            <VisitList visits={report.visits} timezone={tz} emptyText="Nobody has rung the doorbell today." />
          </section>
        )}
      </div>

      <p className="subtle footer-note">
        Checked {report.lastCheckAt ? formatTime(report.lastCheckAt, tz) : 'just now'} · refreshes every minute · times in{' '}
        {tz.replace(/_/g, ' ')}
      </p>
    </div>
  );
}
