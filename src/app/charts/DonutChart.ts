import { html } from '../html';

export interface DonutSegment {
  label: string;
  value: number;
}

interface Props {
  segments: DonutSegment[];
  size?: number;
}

const SEGMENT_COLORS = [
  'chart-series-1',
  'chart-series-2',
  'chart-series-3',
  'chart-series-4',
] as const;
const STROKE_WIDTH = 22;

export function DonutChart({ segments, size = 160 }: Props) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) {
    return html`<p class="tag-empty">No data yet.</p>`;
  }

  const radius = (size - STROKE_WIDTH) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s, index) => {
      const fraction = s.value / total;
      const dashArray = `${String(fraction * circumference)} ${String(circumference)}`;
      const dashOffset = -offset * circumference;
      offset += fraction;
      return {
        ...s,
        dashArray,
        dashOffset,
        colorClass: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
      };
    });

  return html`
    <div class="donut-chart">
      <svg
        viewBox="0 0 ${size} ${size}"
        width=${size}
        height=${size}
        role="img"
        aria-label="Donut chart"
      >
        <g transform="rotate(-90 ${center} ${center})">
          ${arcs.map(
            (arc) => html`
              <circle
                cx=${center}
                cy=${center}
                r=${radius}
                fill="none"
                stroke-width=${STROKE_WIDTH}
                stroke-dasharray=${arc.dashArray}
                stroke-dashoffset=${arc.dashOffset}
                class="chart-line-stroke ${arc.colorClass}"
              />
            `,
          )}
        </g>
      </svg>
      <ul class="chart-legend">
        ${arcs.map(
          (arc) => html`
            <li>
              <span class="chart-legend-swatch ${arc.colorClass}"></span>
              ${arc.label}: ${arc.value}
            </li>
          `,
        )}
      </ul>
    </div>
  `;
}
