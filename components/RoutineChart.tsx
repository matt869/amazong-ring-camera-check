import { formatMinuteOfDay } from '@/lib/routine/time';

/** Rounded nice maximum for the y axis. */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const step = v <= 10 ? 2 : v <= 20 ? 5 : 10;
  return Math.ceil(v / step) * step;
}

/** Bar path with 4px rounded top corners and a square base on the axis. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const hourLabel = (h: number) => formatMinuteOfDay(h * 60).replace(':00', '');

interface PlotProps {
  hourly: number[];
  usual: number[] | null;
  nowHour: number | null;
  title: string;
}

/**
 * One rendering of the chart in its own coordinate space. Text is sized in
 * viewBox units, so the phone layout gets a narrower viewBox rather than a
 * shrunken copy of the desktop one.
 */
function Plot({ hourly, usual, nowHour, title, width, height, className }: PlotProps & { width: number; height: number; className: string }) {
  const M = { top: 10, right: 6, bottom: 24, left: 26 };
  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const slot = plotW / 24;
  const barW = Math.max(4, Math.min(18, slot - (slot > 12 ? 6 : 3)));

  const yMax = niceMax(Math.max(1, ...hourly, ...(usual ?? [0])));
  const y = (v: number) => M.top + plotH - (v / yMax) * plotH;
  const ticks = [0, yMax / 2, yMax];
  const usualPath = usual
    ? usual.map((v, h) => `${h === 0 ? 'M' : 'L'}${M.left + h * slot},${y(v)}H${M.left + (h + 1) * slot}`).join('')
    : null;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${title}: bar chart of movements per hour${usual ? ' compared with the usual routine' : ''}`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line className="gridline" x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />
          <text className="axis-label" x={M.left - 6} y={y(t) + 4} textAnchor="end">
            {Number.isInteger(t) ? t : t.toFixed(1)}
          </text>
        </g>
      ))}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} className="axis-label" x={M.left + h * slot + slot / 2} y={height - 6} textAnchor="middle">
          {hourLabel(h)}
        </text>
      ))}

      {hourly.map((v, h) => {
        if (v === 0 || (nowHour != null && h > nowHour)) return null;
        const x = M.left + h * slot + (slot - barW) / 2;
        return <path key={h} className="bar" d={barPath(x, y(v), barW, (v / yMax) * plotH)} />;
      })}

      {usualPath && <path className="usual" d={usualPath} />}

      {nowHour != null && nowHour < 23 && (
        <line
          className="now-line"
          x1={M.left + (nowHour + 1) * slot}
          x2={M.left + (nowHour + 1) * slot}
          y1={M.top}
          y2={M.top + plotH}
        />
      )}

      {/* Hover targets: the full hour column, wider than the mark. */}
      {hourly.map((v, h) => (
        <rect key={h} className="hit" x={M.left + h * slot} y={M.top} width={slot} height={plotH} rx={3}>
          <title>
            {`${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${nowHour != null && h > nowHour ? 'not yet' : `${v} movement${v === 1 ? '' : 's'}`}${usual ? ` · usually ${usual[h].toFixed(1)}` : ''}`}
          </title>
        </rect>
      ))}
    </svg>
  );
}

/**
 * Movements per hour for one day (bars) against the learned routine (step line).
 * Pure SVG so it renders on the server; native <title> tooltips per hour.
 */
export default function RoutineChart({
  hourly,
  usual,
  nowHour,
  title = 'Activity by hour',
}: {
  hourly: number[];
  /** Average per hour from the baseline, or null while still learning. */
  usual: number[] | null;
  /** Current hour for today's chart (later hours are blank); null for past days. */
  nowHour: number | null;
  title?: string;
}) {
  const props = { hourly, usual, nowHour, title };

  return (
    <section className="card chart" aria-labelledby="chart-title">
      <div className="spread">
        <h2 id="chart-title">{title}</h2>
        <span className="subtle">movement at home</span>
      </div>
      <div className="legend">
        <span className="key">
          <span className="swatch-bar" aria-hidden /> {nowHour != null ? 'Today' : 'This day'}
        </span>
        {usual ? (
          <span className="key">
            <span className="swatch-line" aria-hidden /> Usual (learned routine)
          </span>
        ) : (
          <span className="subtle">Usual routine appears after 3 days of history</span>
        )}
      </div>
      <Plot {...props} width={720} height={200} className="svg-wide" />
      <Plot {...props} width={340} height={190} className="svg-narrow" />
      <details>
        <summary>Show as table</summary>
        <table>
          <thead>
            <tr>
              <th>Hour</th>
              <th>Movements</th>
              {usual && <th>Usual</th>}
            </tr>
          </thead>
          <tbody>
            {hourly.map((v, h) => (
              <tr key={h}>
                <td>{hourLabel(h)}</td>
                <td>{nowHour != null && h > nowHour ? '—' : v}</td>
                {usual && <td>{usual[h].toFixed(1)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
