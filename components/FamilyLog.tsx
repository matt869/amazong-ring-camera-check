import type { FamilyLogEntry, FamilyLogKind } from '@/lib/db';
import { formatDateTime } from '@/lib/routine/time';

const KIND_LABEL: Record<FamilyLogKind, string> = {
  call: 'called',
  visit: 'visited',
  message: 'messaged',
  other: 'checked in with',
};

/**
 * "Who checked on Mom?" Siblings log calls and visits in one tap; the weekly
 * digest credits each of them and notices days nobody was in touch.
 */
export default function FamilyLog({
  entries,
  residentName,
  defaultName,
  timezone,
  back,
  add,
  remove,
}: {
  /** Newest first. */
  entries: FamilyLogEntry[];
  residentName: string;
  defaultName: string | null;
  timezone: string;
  back: string;
  add: (formData: FormData) => Promise<void>;
  remove: (formData: FormData) => Promise<void>;
}) {
  return (
    <section className="card stack" id="family" aria-labelledby="family-heading">
      <div className="spread">
        <h2 id="family-heading">Family check-ins</h2>
        <span className="subtle">so everyone knows who&apos;s been in touch</span>
      </div>
      <form action={add} className="log-form">
        <input type="hidden" name="back" value={back} />
        <label className="sr-only" htmlFor="log-who">
          Your name
        </label>
        <input id="log-who" name="who" placeholder="Your name" defaultValue={defaultName ?? ''} required maxLength={40} className="input-small" />
        <label className="sr-only" htmlFor="log-kind">
          What you did
        </label>
        <select id="log-kind" name="kind" defaultValue="call" className="input-small">
          {(Object.keys(KIND_LABEL) as FamilyLogKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k].replace(/^./, (c) => c.toUpperCase())} {residentName}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="log-note">
          Note
        </label>
        <input id="log-note" name="note" placeholder="Note (optional)" maxLength={200} className="input-small log-note" />
        <button className="button small" type="submit">
          Log it
        </button>
      </form>
      {entries.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nobody has logged a call or visit this week.
        </p>
      ) : (
        <ul className="log-list">
          {entries.map((e) => (
            <li key={e.id}>
              <span>
                <strong>{e.who}</strong> {KIND_LABEL[e.kind]} {residentName}
                {e.note && <span className="muted"> · {e.note}</span>}
              </span>
              <span className="row" style={{ gap: 6 }}>
                <span className="subtle">{formatDateTime(e.at, timezone)}</span>
                <form action={remove}>
                  <input type="hidden" name="id" value={e.id} />
                  <button className="link-button" type="submit" aria-label={`Remove ${e.who}'s entry`}>
                    ×
                  </button>
                </form>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
