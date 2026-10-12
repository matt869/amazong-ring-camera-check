import type { DayFacts, DaySummary } from '@/lib/aws/bedrock';
import type { RingDevice } from '@/lib/ring/types';
import type { StatusSummary } from '@/lib/routine/detect';
import { addDays, formatAgo, formatDateTime, formatDuration, formatTime, localParts } from '@/lib/routine/time';

const LABELS: Record<StatusSummary['status'], string> = {
  ok: 'All normal',
  watch: 'Keep an eye out',
  alert: 'Needs attention',
  paused: 'Alerts paused',
  unknown: 'Waiting for data',
};

export default function StatusCard({
  status,
  summary,
  facts,
  devices,
  timezone,
  now,
}: {
  status: StatusSummary;
  summary: DaySummary;
  facts: DayFacts;
  devices: RingDevice[];
  timezone: string;
  now: number;
}) {
  const { presence } = status;
  const lastWhere = presence.lastActivity ? devices.find((d) => d.id === presence.lastActivity!.deviceId)?.location : null;

  // "10:16pm" alone reads as today; say when it wasn't.
  const today = localParts(now, timezone).dateKey;
  const lastTs = presence.lastActivity?.occurredAt;
  const lastDay = lastTs != null ? localParts(lastTs, timezone).dateKey : null;
  const lastWhen =
    lastTs == null ? null : lastDay === today ? null : lastDay === addDays(today, -1) ? 'yesterday' : formatDateTime(lastTs, timezone);

  let presenceText: string;
  if (presence.state === 'away' && presence.since) {
    presenceText = `Out since ${formatTime(presence.since, timezone)} (${formatDuration(now - presence.since)})`;
  } else if (presence.state === 'home' && presence.since) {
    presenceText = `Home · last movement ${lastWhere ? `in the ${lastWhere.toLowerCase()} ` : ''}${formatAgo(now - presence.since)}`;
  } else {
    presenceText = 'No recent activity';
  }

  return (
    <section className="card status" aria-labelledby="status-heading">
      <div className="row">
        <span className={`status-pill status-${status.status}`}>
          <span className="dot" aria-hidden />
          {LABELS[status.status]}
        </span>
        <span className={`presence presence-${presence.state}`}>{presenceText}</span>
      </div>
      <h1 id="status-heading">{status.headline}</h1>
      <p className="summary">{summary.text}</p>
      <p className="subtle">
        {summary.source === 'bedrock' ? 'Written by Claude via Amazon Bedrock' : 'Generated from activity rules'}
        {' · '}
        {facts.dateLabel}
      </p>
      <div className="stats">
        <Stat
          label="Last movement"
          value={presence.lastActivity ? formatTime(presence.lastActivity.occurredAt, timezone) : '—'}
          note={[lastWhere, lastWhen].filter(Boolean).join(' · ') || undefined}
        />
        <Stat label="Up at" value={facts.firstActivity ?? '—'} note={facts.usualFirstActivity ? `usually ${facts.usualFirstActivity}` : undefined} />
        <Stat
          label="Movements today"
          value={String(facts.activityCount)}
          note={facts.usualActivityByNow != null ? `usually ~${facts.usualActivityByNow} by now` : undefined}
        />
        <Stat label="Doorbell" value={String(facts.visitors)} note={facts.visitors === 1 ? 'press today' : 'presses today'} />
      </div>
    </section>
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
