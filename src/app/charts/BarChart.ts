import { html } from '../html';

export interface BarDatum {
  label: string;
  value: number;
}

interface Props {
  data: BarDatum[];
  width?: number;
  barHeight?: number;
  formatValue?: (value: number) => string;
}

const LABEL_WIDTH = 140;
const VALUE_GUTTER = 46;
const BAR_GAP = 6;

export function BarChart({
  data,
  width = 480,
  barHeight = 20,
  formatValue,
}: Props) {
  if (data.length === 0) {
    return html`<p class="tag-empty">No data yet.</p>`;
  }

  const max = Math.max(1, ...data.map((d) => d.value));
  const chartWidth = Math.max(20, width - LABEL_WIDTH - VALUE_GUTTER);
  const height = data.length * (barHeight + BAR_GAP);

  return html`
    <svg
      class="chart chart-bar"
      viewBox="0 0 ${width} ${height}"
      width="100%"
      height=${height}
      role="img"
      aria-label="Bar chart"
    >
      ${data.map((d, index) => {
        const barWidth = (d.value / max) * chartWidth;
        const y = index * (barHeight + BAR_GAP);
        return html`
          <g>
            <text x="0" y=${y + barHeight / 2 + 4} class="chart-label">
              ${d.label}
            </text>
            <rect
              x=${LABEL_WIDTH}
              y=${y}
              width=${barWidth}
              height=${barHeight}
              rx="3"
              class="chart-bar-fill"
            />
            <text
              x=${LABEL_WIDTH + barWidth + 6}
              y=${y + barHeight / 2 + 4}
              class="chart-value"
            >
              ${formatValue ? formatValue(d.value) : String(d.value)}
            </text>
          </g>
        `;
      })}
    </svg>
  `;
}
