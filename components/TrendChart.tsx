import { formatDateKey } from '@/lib/routine/time';

/**
 * One measure over the past weeks (line with points) against its level the
 * month before (dashed). Small multiples share a legend on the page. Pure SVG,
 * rendered on the server; native <title> tooltips per week.
 */
export default function TrendChart({
  title,
  weeks,
  values,
  reference,
  format,
  zeroBased = true,
  flagged = false,
  minSpan = 0,
}: {
  title: string;
  /** Week end dates, oldest first. */
  weeks: string[];
  values: (number | null)[];
  /** The level over the month before the last two weeks, or null. */
  reference: number | null;
  format: (v: number) => string;
  /** Counts start at zero; times of day don't. */
  zeroBased?: boolean;
  /** A drift finding exists for this measure. */
  flagged?: boolean;
  /** Smallest y range shown, so ordinary week-to-week wobble doesn't look dramatic. */
  minSpan?: number;
}) {
  const W = 320;
  const H = 150;
  const M = { top: 12, right: 10, bottom: 22, left: 48 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const known = values.filter((v): v is number => v != null);
  const all = reference == null ? known : [...known, reference];
  if (all.length === 0) {
    return (
      <figure className={`trend card${flagged ? ' trend-flagged' : ''}`}>
        <figcaption>{title}</figcaption>
        <p className="muted">Not enough data yet.</p>
      </figure>
    );
  }
  let lo = zeroBased ? 0 : Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo || Math.max(1, hi) * 0.2) * 0.15;
  if (!zeroBased) lo -= pad;
  hi += pad;
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = zeroBased ? 0 : mid - minSpan / 2;
    hi = zeroBased ? Math.max(hi, minSpan) : mid + minSpan / 2;
  }
  // Round ticks: a time axis on the half hour, a count axis on a value whose half is round too.
  if (zeroBased) {
    const mag = 10 ** Math.floor(Math.log10(Math.max(hi, 1e-9)));
    hi = Math.ceil(hi / mag) * mag;
    if (Math.round(hi / mag) % 2 === 1) hi += mag;
  } else {
    lo = Math.floor(lo / 30) * 30;
    hi = Math.ceil(hi / 30) * 30;
    if (((hi - lo) / 30) % 2 === 1) hi += 30;
  }
  if (hi === lo) hi = lo + 1;

  const step = weeks.length > 1 ? plotW / (weeks.length - 1) : 0;
  const x = (i: number) => M.left + i * step;
  const y = (v: number) => M.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  // Break the line where a week has no data.
  let path = '';
  values.forEach((v, i) => {
    if (v == null) return;
    path += `${i === 0 || values[i - 1] == null ? 'M' : 'L'}${x(i)},${y(v)}`;
  });
  const last = [...values].reverse().find((v) => v != null);

  return (
    <figure className={`trend card${flagged ? ' trend-flagged' : ''}`}>
      <figcaption>
        <span>{title}</span>
        {last != null && <span className="trend-now">{format(last)}</span>}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} by week: ${values.map((v) => (v == null ? 'no data' : format(v))).join(', ')}`}>
        {[lo, (lo + hi) / 2, hi].map((t, i) => (
          <g key={i}>
            <line className="gridline" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text className="axis-label" x={M.left - 6} y={y(t) + 4} textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        {[0, weeks.length - 1].map((i) => (
          <text key={i} className="axis-label" x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : 'end'}>
            {i === weeks.length - 1 ? 'last week' : formatDateKey(weeks[i], { weekday: false })}
          </text>
        ))}
        {reference != null && <line className="trend-ref" x1={M.left} x2={W - M.right} y1={y(reference)} y2={y(reference)} />}
        <path className="trend-line" d={path} />
        {values.map((v, i) => (v == null ? null : <circle key={i} className="trend-dot" cx={x(i)} cy={y(v)} r={4} />))}
        {weeks.map((w, i) => (
          <rect key={w} className="hit" x={x(i) - step / 2} y={M.top} width={Math.max(step, 12)} height={plotH} rx={3}>
            <title>{`Week ending ${formatDateKey(w)}: ${values[i] == null ? 'no data' : format(values[i]!)}${reference != null ? ` · month before: ${format(reference)}` : ''}`}</title>
          </rect>
        ))}
      </svg>
    </figure>
  );
}
