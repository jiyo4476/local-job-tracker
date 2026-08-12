import { html } from '../html';

export interface LinePoint {
  label: string;
  value: number;
}

export interface LineSeries {
  name: string;
  points: LinePoint[];
}

interface Props {
  series: LineSeries[];
  width?: number;
  height?: number;
}

const PADDING_LEFT = 34;
const PADDING_BOTTOM = 20;
const PADDING_TOP = 8;
const SERIES_COLORS = [
  'chart-series-1',
  'chart-series-2',
  'chart-series-3',
  'chart-series-4',
] as const;

export function LineChart({ series, width = 480, height = 180 }: Props) {
  const points = series[0]?.points ?? [];
  if (points.length === 0) {
    return html`<p class="tag-empty">No data yet.</p>`;
  }

  const max = Math.max(
    1,
    ...series.flatMap((s) => s.points.map((p) => p.value)),
  );
  const plotWidth = width - PADDING_LEFT - 8;
  const plotHeight = height - PADDING_TOP - PADDING_BOTTOM;
  const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;

  const toX = (index: number) => PADDING_LEFT + index * stepX;
  const toY = (value: number) =>
    PADDING_TOP + plotHeight - (value / max) * plotHeight;

  const everyNthLabel = Math.max(1, Math.ceil(points.length / 6));

  return html`
    <svg
      class="chart chart-line"
      viewBox="0 0 ${width} ${height}"
      width="100%"
      height=${height}
      role="img"
      aria-label="Line chart"
    >
      <line
        x1=${PADDING_LEFT}
        y1=${PADDING_TOP + plotHeight}
        x2=${width - 8}
        y2=${PADDING_TOP + plotHeight}
        class="chart-axis"
      />
      ${points.map((p, index) =>
        index % everyNthLabel === 0
          ? html`<text
              x=${toX(index)}
              y=${height - 4}
              class="chart-label chart-label-center"
            >
              ${p.label.slice(5)}
            </text>`
          : null,
      )}
      ${series.map(
        (s, seriesIndex) => html`
          <polyline
            points=${s.points
              .map(
                (p, index) => `${String(toX(index))},${String(toY(p.value))}`,
              )
              .join(' ')}
            class="chart-line-stroke ${
              SERIES_COLORS[seriesIndex % SERIES_COLORS.length]
            }"
            fill="none"
          />
        `,
      )}
    </svg>
    ${
      series.length > 1
        ? html`
            <ul class="chart-legend">
              ${series.map(
                (s, index) => html`
                  <li>
                    <span
                      class="chart-legend-swatch ${
                        SERIES_COLORS[index % SERIES_COLORS.length]
                      }"
                    ></span>
                    ${s.name}
                  </li>
                `,
              )}
            </ul>
          `
        : null
    }
  `;
}
