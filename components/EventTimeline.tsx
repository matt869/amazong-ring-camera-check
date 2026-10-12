import type { EventKind, RingDevice, RingEvent } from '@/lib/ring/types';
import { formatMinuteOfDay, formatTime, localParts } from '@/lib/routine/time';

const DESCRIBE: Record<EventKind, { icon: string; label: string }> = {
  motion: { icon: '◦', label: 'Movement' },
  door_open: { icon: '↗', label: 'Door opened' },
  door_close: { icon: '↙', label: 'Door closed' },
  ding: { icon: '🔔', label: 'Doorbell pressed' },
};

export default function EventTimeline({
  events,
  devices,
  timezone,
  groupByHour = true,
  emptyText = 'No activity recorded.',
}: {
  /** Newest first. */
  events: RingEvent[];
  devices: RingDevice[];
  timezone: string;
  groupByHour?: boolean;
  emptyText?: string;
}) {
  if (events.length === 0) return <p className="muted">{emptyText}</p>;

  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const items: React.ReactNode[] = [];
  let lastHour = -1;

  for (const e of events) {
    const hour = localParts(e.occurredAt, timezone).hour;
    if (groupByHour && hour !== lastHour) {
      items.push(
        <li key={`h-${e.id}`} className="hour-head" style={{ display: 'block' }}>
          {formatMinuteOfDay(hour * 60)}
        </li>,
      );
      lastHour = hour;
    }
    const d = deviceById.get(e.deviceId);
    const { icon, label } = DESCRIBE[e.kind];
    // Motion on devices that don't count (doorbells by default) is usually someone outside.
    const outside = e.kind === 'motion' && d != null && !d.countsAsActivity;
    items.push(
      <li key={e.id} className={outside ? 'outside' : undefined}>
        <time dateTime={new Date(e.occurredAt).toISOString()}>{formatTime(e.occurredAt, timezone)}</time>
        <span className="icon" aria-hidden>
          {icon}
        </span>
        <span>
          <span className="what">{outside ? 'Motion outside' : label}</span>{' '}
          <span className="where">· {d?.location ?? e.deviceId}</span>
        </span>
      </li>,
    );
  }

  return <ul className="timeline">{items}</ul>;
}
