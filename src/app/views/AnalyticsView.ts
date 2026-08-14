import { useState } from 'preact/hooks';
import { html } from '../html';
import { useAsyncResource } from '../useAsyncResource';
import { listJobs } from '../../lib/db/jobsRepo';
import {
  platformBreakdown,
  remoteOnsiteByWeek,
  salarySummaryByJobTypeAndExperience,
  skillDemandOverTime,
  skillsByClearance,
  taxonomyTopN,
} from '../../lib/analytics/analytics';
import {
  TAXONOMY_FIELDS,
  TAXONOMY_GROUP_COPY,
  type TaxonomyField,
} from '../../lib/taxonomyFields';
import { BarChart } from '../charts/BarChart';
import { LineChart } from '../charts/LineChart';

function formatCents(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

export function AnalyticsView() {
  const [taxonomyField, setTaxonomyField] = useState<TaxonomyField>('skills');
  const resource = useAsyncResource(
    () => listJobs({ includeInactive: false }),
    [],
    'Could not load analytics.',
  );
  if (resource.error)
    return html`<p role="alert">
      ${resource.error}
      <button type="button" onClick=${() => void resource.reload()}>
        Retry
      </button>
    </p>`;
  if (!resource.data) return html`<p>Loading…</p>`;
  const jobs = resource.data;

  const demand = skillDemandOverTime(jobs);
  const salary = salarySummaryByJobTypeAndExperience(jobs);
  const platforms = platformBreakdown(jobs);
  const remoteWeekly = remoteOnsiteByWeek(jobs);
  const clearance = skillsByClearance(jobs);
  const taxonomy = taxonomyTopN(jobs, taxonomyField);

  return html`
    <div class="analytics-view">
      <section>
        <h2>Skill demand over time (top 15, 12 months)</h2>
        <${LineChart}
          title="Skill demand over time"
          series=${demand.series.map((s) => ({
            name: s.skill,
            points: demand.periods.map((w, i) => ({
              label: w,
              value: s.counts[i] ?? 0,
            })),
          }))}
        />
      </section>

      <section>
        <h2>Platform breakdown</h2>
        <${BarChart}
          title="Jobs by platform"
          data=${platforms.map((p) => ({ label: p.platform, value: p.count }))}
        />
      </section>

      <section>
        <h2>Remote vs onsite, by week</h2>
        <${LineChart}
          title="Remote versus onsite jobs by week"
          series=${[
            {
              name: 'Remote',
              points: remoteWeekly.map((w) => ({
                label: w.weekStart,
                value: w.remote,
              })),
            },
            {
              name: 'Onsite',
              points: remoteWeekly.map((w) => ({
                label: w.weekStart,
                value: w.onsite,
              })),
            },
          ]}
        />
      </section>

      <section>
        <h2>Salary summary by job type &amp; experience level</h2>
        ${
          salary.length === 0
            ? html`<p class="tag-empty">No salary data yet.</p>`
            : html`
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Job type</th>
                      <th>Experience</th>
                      <th>Count</th>
                      <th>Min</th>
                      <th>Median</th>
                      <th>Max</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${salary.map(
                      (row) => html`
                        <tr>
                          <td>${row.job_type}</td>
                          <td>${row.experience_level}</td>
                          <td>${row.count}</td>
                          <td>${formatCents(row.minCents)}</td>
                          <td>${formatCents(row.medianCents)}</td>
                          <td>${formatCents(row.maxCents)}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              `
        }
      </section>

      <section>
        <h2>Top skills by clearance requirement</h2>
        <div class="dashboard-grid-2">
          <div>
            <h3>Requires clearance</h3>
            <${BarChart}
              title="Top skills requiring clearance"
              data=${clearance.withClearance.map((s) => ({
                label: s.name,
                value: s.count,
              }))}
            />
          </div>
          <div>
            <h3>No clearance required</h3>
            <${BarChart}
              title="Top skills without clearance"
              data=${clearance.withoutClearance.map((s) => ({
                label: s.name,
                value: s.count,
              }))}
            />
          </div>
        </div>
      </section>

      <section>
        <h2>Taxonomy</h2>
        <label>
          Category
          <select
            onChange=${(event: Event) => {
              setTaxonomyField(
                (event.target as HTMLSelectElement).value as TaxonomyField,
              );
            }}
          >
            ${TAXONOMY_FIELDS.map(
              (field) => html`
                <option value=${field} selected=${field === taxonomyField}>
                  ${TAXONOMY_GROUP_COPY[field].label}
                </option>
              `,
            )}
          </select>
        </label>
        <${BarChart}
          title="Top taxonomy values"
          data=${taxonomy.map((t) => ({ label: t.name, value: t.count }))}
        />
      </section>
    </div>
  `;
}
