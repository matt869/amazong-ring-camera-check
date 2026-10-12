import { formatDateTime } from '@/lib/routine/time';

/**
 * "She's staying with us this week": pause resident alerts so an empty house
 * doesn't page everyone. Device health alerts keep running. A pause the
 * resident started from their own page is shown, but only they can end it.
 */
export default function PauseControl({
  pausedUntil,
  pausedBy,
  residentName,
  timezone,
  today,
  back,
  pause,
  resume,
}: {
  pausedUntil: number | null;
  pausedBy: 'family' | 'resident' | null;
  residentName: string;
  timezone: string;
  /** YYYY-MM-DD in the home's timezone, the earliest pickable date. */
  today: string;
  /** Path to return to after submitting. */
  back: string;
  pause: (formData: FormData) => Promise<void>;
  resume: (formData: FormData) => Promise<void>;
}) {
  if (pausedUntil != null && pausedUntil > Date.now()) {
    if (pausedBy === 'resident') {
      return (
        <div className="pause pause-active" role="status">
          <span>
            <strong>{residentName} paused sharing</strong> until {formatDateTime(pausedUntil, timezone)}. Nothing is
            recorded and no check-in alerts can fire until then. Device alerts still run.
          </span>
        </div>
      );
    }
    return (
      <form action={resume} className="pause pause-active">
        <input type="hidden" name="back" value={back} />
        <span>
          <strong>Alerts paused</strong> until {formatDateTime(pausedUntil, timezone)}. Device alerts still run.
        </span>
        <button className="button secondary small" type="submit">
          Resume now
        </button>
      </form>
    );
  }

  return (
    <details className="pause">
      <summary>Going away? Pause alerts</summary>
      <div className="pause-options">
        {[
          [1, '1 day'],
          [3, '3 days'],
          [7, '1 week'],
        ].map(([days, label]) => (
          <form key={days} action={pause}>
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="days" value={days} />
            <button className="button secondary small" type="submit">
              {label}
            </button>
          </form>
        ))}
        <form action={pause} className="row">
          <input type="hidden" name="back" value={back} />
          <label className="subtle" htmlFor="pause-until">
            or until
          </label>
          <input id="pause-until" name="until" type="date" min={today} required className="input-small" />
          <button className="button secondary small" type="submit">
            Pause
          </button>
        </form>
      </div>
    </details>
  );
}
