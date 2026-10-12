import { formatDateKey, formatTime } from '@/lib/routine/time';
import { VISIT_KIND_LABEL, type Visit } from '@/lib/routine/visitors';

/** Doorbell visits, newest first, each with its kind and whether the door was opened. */
export default function VisitList({
  visits,
  timezone,
  showDate = false,
  emptyText = 'Nobody rang the doorbell.',
}: {
  visits: Visit[];
  timezone: string;
  showDate?: boolean;
  emptyText?: string;
}) {
  if (visits.length === 0) return <p className="muted" style={{ margin: 0 }}>{emptyText}</p>;
  return (
    <ul className="visits">
      {[...visits].reverse().map((v) => (
        <li key={v.id} className={`visit visit-${v.kind}`}>
          <time dateTime={new Date(v.start).toISOString()}>
            {showDate ? `${formatDateKey(v.dateKey)}, ` : ''}
            {formatTime(v.start, timezone)}
          </time>
          <span>
            <span className={`visit-kind kind-${v.kind}`}>{v.label ? `${VISIT_KIND_LABEL[v.kind]}: ${v.label}` : VISIT_KIND_LABEL[v.kind]}</span>
            {v.answered === true && v.kind !== 'dropoff' && <span className="subtle"> · door opened</span>}
            {v.loitering && <span className="subtle"> · Ring saw someone lingering</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
