import Link from 'next/link';
import AlertBanner from '@/components/AlertBanner';
import EventTimeline from '@/components/EventTimeline';
import LiveUpdates from '@/components/LiveUpdates';
import RoutineChart from '@/components/RoutineChart';
import VisitList from '@/components/VisitList';
import { getDayReport, getDaySummary, runCheck } from '@/lib/checkin';
import { latestEventId } from '@/lib/db';
import { addDays, localParts } from '@/lib/routine/time';

export const dynamic = 'force-dynamic';

/** Events this recent are highlighted as just arrived. */
const FRESH_MS = 15_000;

export default async function Timeline({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await searchParams;
  await runCheck();
  const now = Date.now();
  const report = getDayReport(date, now);
  const summary = await getDaySummary(report, now);
  const tz = report.settings.timezone;

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1>{report.facts.dateLabel}</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {report.facts.activityCount} movements · {report.facts.visitors} doorbell
          </p>
        </div>
        <nav className="row" aria-label="Day">
          <Link className="button secondary small" href={`/dashboard/timeline?date=${addDays(report.dateKey, -1)}`}>
            ← Previous day
          </Link>
          {!report.isToday && (
            <Link className="button secondary small" href={`/dashboard/timeline?date=${addDays(report.dateKey, 1)}`}>
              Next day →
            </Link>
          )}
        </nav>
      </div>

      <section className="card">
        <p className="summary" style={{ margin: 0 }}>
          {summary.text}
        </p>
      </section>

      <AlertBanner alerts={report.dayAlerts} timezone={tz} residentName={report.settings.residentName} />

      <RoutineChart
        hourly={report.hourly}
        usual={report.baselineReady ? report.baseline.hourlyMean : null}
        nowHour={report.isToday ? localParts(now, tz).hour : null}
      />

      {report.visits.length > 0 && (
        <section className="card stack">
          <h2>At the door</h2>
          <VisitList visits={report.visits} timezone={tz} />
        </section>
      )}

      <section className="card">
        <div className="row" style={{ gap: 10, marginBottom: 4 }}>
          <h2>All events</h2>
          {report.isToday && <LiveUpdates latestId={latestEventId(now)} />}
        </div>
        <EventTimeline events={report.events} devices={report.devices} timezone={tz} freshSince={now - FRESH_MS} />
      </section>
    </div>
  );
}
