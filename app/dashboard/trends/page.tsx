import type { Metadata } from 'next';
import TrendChart from '@/components/TrendChart';
import { runCheck } from '@/lib/checkin';
import { getSettings } from '@/lib/db';
import { getTrends } from '@/lib/insights';
import { DRIFT_RECENT_DAYS, DRIFT_REFERENCE_DAYS, type DriftMetric } from '@/lib/routine/drift';
import { formatDateKey, formatMinuteOfDay } from '@/lib/routine/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Trends' };

const oneDecimal = (v: number) => String(Math.round(v * 10) / 10);

/**
 * Routine drift: the same few measures, week by week, for the last two months.
 * A single late morning is an alert; a morning that gets ten minutes later
 * every week only shows up here.
 */
export default async function TrendsPage() {
  await runCheck();
  const settings = getSettings();
  const t = getTrends(Date.now(), settings);
  const name = settings.residentName;
  const flagged = new Set<DriftMetric>(t.findings.map((f) => f.metric));
  const weeks = t.weeks.map((w) => w.end);

  const charts: {
    metric: DriftMetric;
    title: string;
    values: (number | null)[];
    reference: number | null;
    format: (v: number) => string;
    zeroBased: boolean;
    minSpan: number;
  }[] = [
    // Two hours of range: a 15-minute wobble stays small, a 45-minute slide stands out.
    { metric: 'wake', title: 'Up at (typical)', values: t.weeks.map((w) => w.wake), reference: t.reference.wake, format: (v) => formatMinuteOfDay(v), zeroBased: false, minSpan: 120 },
    { metric: 'outings', title: 'Outings per week', values: t.weeks.map((w) => w.outings), reference: t.reference.outings, format: oneDecimal, zeroBased: true, minSpan: 4 },
    { metric: 'activity', title: 'Movements per day', values: t.weeks.map((w) => w.activity), reference: t.reference.activity, format: (v) => String(Math.round(v)), zeroBased: true, minSpan: 10 },
    { metric: 'night', title: 'Movements per night', values: t.weeks.map((w) => w.night), reference: t.reference.night, format: oneDecimal, zeroBased: true, minSpan: 2 },
  ];

  return (
    <div className="stack">
      <div>
        <h1>{name}&apos;s routine, week by week</h1>
        <p className="muted" style={{ margin: '6px 0 0', maxWidth: '68ch' }}>
          Daily alerts compare today with {name}&apos;s usual routine. But a routine that changes slowly becomes the new
          &ldquo;usual&rdquo;. This page compares the last {DRIFT_RECENT_DAYS / 7} weeks with the {DRIFT_REFERENCE_DAYS / 7} weeks
          before, so gradual changes don&apos;t slip by.
        </p>
      </div>

      <section className={`card stack${t.findings.length ? ' trend-teaser' : ''}`} aria-live="polite">
        {!t.enough ? (
          <p style={{ margin: 0 }}>
            Trends need about six weeks of history; there are {t.daysWithData} days so far. Daily alerts work in the
            meantime.
          </p>
        ) : t.findings.length === 0 ? (
          <p style={{ margin: 0 }}>
            <strong>No slow changes.</strong> {name}&apos;s last two weeks look like the month before.
          </p>
        ) : (
          <>
            <h2>What&apos;s changed</h2>
            <ul className="findings">
              {t.findings.map((f) => (
                <li key={f.metric}>
                  <strong>{f.title}.</strong> {f.detail}
                </li>
              ))}
            </ul>
            <p className="subtle" style={{ margin: 0 }}>
              These are patterns in movement, not a diagnosis. They can have ordinary reasons (the season, a new show, a
              visitor), and may be worth a gentle conversation.
            </p>
          </>
        )}
      </section>

      <div className="legend trend-legend" aria-hidden>
        <span className="key">
          <span className="swatch-line-solid" /> Each week
        </span>
        <span className="key">
          <span className="swatch-line-dashed" /> The month before (the comparison)
        </span>
      </div>
      <div className="trend-grid">
        {charts.map((c) => (
          <TrendChart
            key={c.metric}
            title={c.title}
            weeks={weeks}
            values={c.values}
            reference={t.enough ? c.reference : null}
            format={c.format}
            zeroBased={c.zeroBased}
            minSpan={c.minSpan}
            flagged={flagged.has(c.metric)}
          />
        ))}
      </div>

      <details className="card">
        <summary>Show as table</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th>Week ending</th>
              <th>Days with data</th>
              <th>Up at</th>
              <th>Outings / week</th>
              <th>Movements / day</th>
              <th>Movements / night</th>
            </tr>
          </thead>
          <tbody>
            {t.weeks.map((w) => (
              <tr key={w.end}>
                <td>{formatDateKey(w.end)}</td>
                <td>{w.days}</td>
                <td>{w.wake == null ? '—' : formatMinuteOfDay(w.wake)}</td>
                <td>{w.outings == null ? '—' : oneDecimal(w.outings)}</td>
                <td>{w.activity == null ? '—' : Math.round(w.activity)}</td>
                <td>{w.night == null ? '—' : oneDecimal(w.night)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="subtle footer-note">Days when alerts were paused are left out, so a week away doesn&apos;t look like a decline.</p>
    </div>
  );
}
