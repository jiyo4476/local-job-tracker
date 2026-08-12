import { useEffect, useState } from 'preact/hooks';
import { html } from '../html';
import { listJobs } from '../../lib/db/jobsRepo';
import type { StoredJob } from '../../lib/db/schema';
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
  const [jobs, setJobs] = useState<StoredJob[] | null>(null);
  const [taxonomyField, setTaxonomyField] = useState<TaxonomyField>('skills');

  useEffect(() => {
    void (async () => {
      setJobs(await listJobs({ includeInactive: true }));
    })();
  }, []);

  if (!jobs) return html`<p>Loading…</p>`;

  const demand = skillDemandOverTime(jobs);
  const salary = salarySummaryByJobTypeAndExperience(jobs);
  const platforms = platformBreakdown(jobs);
  const remoteWeekly = remoteOnsiteByWeek(jobs);
  const clearance = skillsByClearance(jobs);
  const taxonomy = taxonomyTopN(jobs, taxonomyField);

  return html`
    <div class="analytics-view">
      <section>
        <h2>Skill demand over time (top 6, 12 weeks)</h2>
        <${LineChart}
          series=${demand.series.map((s) => ({
            name: s.skill,
            points: demand.weeks.map((w, i) => ({
              label: w,
              value: s.counts[i] ?? 0,
            })),
          }))}
        />
      </section>

      <section>
        <h2>Platform breakdown</h2>
        <${BarChart}
          data=${platforms.map((p) => ({ label: p.platform, value: p.count }))}
        />
      </section>

      <section>
        <h2>Remote vs onsite, by week</h2>
        <${LineChart}
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
              data=${clearance.withClearance.map((s) => ({
                label: s.name,
                value: s.count,
              }))}
            />
          </div>
          <div>
            <h3>No clearance required</h3>
            <${BarChart}
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
          data=${taxonomy.map((t) => ({ label: t.name, value: t.count }))}
        />
      </section>
    </div>
  `;
}
