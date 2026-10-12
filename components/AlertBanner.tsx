import type { AlertRecord } from '@/lib/db';
import type { Severity } from '@/lib/routine/rules';
import { formatTime } from '@/lib/routine/time';

const ICON: Record<Severity, string> = { critical: '!', warning: '▲', info: 'i' };
const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Urgent', warning: 'Unusual', info: 'Heads up' };

export default function AlertBanner({
  alerts,
  timezone,
  acknowledge,
  compact = false,
  residentName = 'them',
  caregiverAfterMinutes,
}: {
  alerts: AlertRecord[];
  timezone: string;
  residentName?: string;
  /** Escalation ladder: minutes the resident has to reply before family is told. */
  caregiverAfterMinutes?: number;
  /** Server action taking a form with an `id` field. Omit for a read-only list. */
  acknowledge?: (formData: FormData) => Promise<void>;
  /** Smaller rendering for device notices inside a card. */
  compact?: boolean;
}) {
  if (alerts.length === 0) return null;

  return (
    <section className={`alerts${compact ? ' alerts-compact' : ''}`} aria-label={compact ? 'Device notices' : 'Alerts'}>
      {alerts.map((a) => {
        const closed = a.resolvedAt != null || a.acknowledgedAt != null;
        const t = (ts: number) => formatTime(ts, timezone);
        const details = [
          `raised ${t(a.createdAt)}`,
          a.residentAt ? `texted ${residentName} ${t(a.residentAt)}` : null,
          a.reply === 'help' && a.repliedAt ? `${residentName} asked for a call ${t(a.repliedAt)}` : null,
          a.caregiverAt && a.notifiedVia !== 'dashboard' ? `family told ${t(a.caregiverAt)}` : null,
          a.neighborAt ? `neighbor asked ${t(a.neighborAt)}` : null,
          a.neighborHelpAt ? `neighbor couldn’t reach ${residentName} ${t(a.neighborHelpAt)}` : null,
          a.remindedAt ? `reminder sent ${t(a.remindedAt)}` : null,
          a.acknowledgedAt ? `checked${a.acknowledgedBy ? ` by ${a.acknowledgedBy}` : ''} ${t(a.acknowledgedAt)}` : null,
        ].filter(Boolean);
        // While the resident hasn't answered yet, say what happens next.
        const waiting =
          !closed && a.residentAt && !a.caregiverAt
            ? `${residentName} has been sent a check-in text.` +
              (caregiverAfterMinutes ? ` If there's no reply by ${t(a.residentAt + caregiverAfterMinutes * 60_000)}, family will be told.` : '')
            : null;

        return (
          <div
            key={a.id}
            className={`alert alert-${a.severity}${closed ? ' alert-closed' : ''}`}
            role={a.severity === 'critical' && !closed && !waiting ? 'alert' : undefined}
          >
            <div>
              <div className="alert-title">
                <span className="alert-icon" aria-hidden>
                  {closed ? '✓' : ICON[a.severity]}
                </span>
                <span>
                  <span className="subtle">{closed ? 'Cleared' : waiting ? 'Checking in' : SEVERITY_LABEL[a.severity]} · </span>
                  {a.title}
                </span>
              </div>
              <p>{a.resolvedAt ? `${a.resolutionNote ?? 'Resolved.'} (${formatTime(a.resolvedAt, timezone)})` : a.message}</p>
              {waiting && <p>{waiting}</p>}
              <p className="subtle">{details.join(' · ')}</p>
              {a.snapshot && !compact && (
                <a href={`/api/snapshots/${a.snapshot}`} target="_blank" rel="noopener" className="snapshot">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/snapshots/${a.snapshot}`} alt={`Front door when this alert was raised`} loading="lazy" />
                  <span className="subtle">Front door at {formatTime(a.createdAt, timezone)} (shared with {residentName}&apos;s permission)</span>
                </a>
              )}
            </div>
            {acknowledge && !closed && (
              <form action={acknowledge}>
                <input type="hidden" name="id" value={a.id} />
                <button className="button secondary small" type="submit">
                  {a.severity === 'info' ? 'Dismiss' : 'I checked on it'}
                </button>
              </form>
            )}
          </div>
        );
      })}
    </section>
  );
}
