import { html } from '../html';
import { useAsyncResource } from '../useAsyncResource';
import { listJobs } from '../../lib/db/jobsRepo';
import { computeDashboardStats } from '../../lib/analytics/dashboard';
import { BarChart } from '../charts/BarChart';
import { DonutChart } from '../charts/DonutChart';
import { LineChart } from '../charts/LineChart';

export function DashboardView() {
  const resource = useAsyncResource(
    async () =>
      computeDashboardStats(await listJobs({ includeInactive: true })),
    [],
    'Could not load the dashboard.',
  );
  if (resource.error)
    return html`<p role="alert">
      ${resource.error}
      <button type="button" onClick=${() => void resource.reload()}>
        Retry
      </button>
    </p>`;
  if (!resource.data) return html`<p>Loading…</p>`;
  const stats = resource.data;

  return html`
    <div class="dashboard-view">
      <div class="kpi-row">
        <div class="kpi-card">
          <span class="kpi-value">${stats.totalTracked}</span>
          <span class="kpi-label">Tracked</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-value">${stats.totalApplied}</span>
          <span class="kpi-label">Applied</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-value">${stats.activeInterviews}</span>
          <span class="kpi-label">Active interviews</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-value">${stats.staleCount}</span>
          <span class="kpi-label">Stale (14d+)</span>
        </div>
      </div>

      <section>
        <h2>Funnel</h2>
        <${BarChart}
          title="Application stage funnel"
          data=${Object.entries(stats.stageCounts).map(([label, value]) => ({
            label,
            value,
          }))}
        />
      </section>

      <section>
        <h2>Top skills</h2>
        <${BarChart}
          title="Top skills"
          data=${stats.topSkills.map((s) => ({ label: s.name, value: s.count }))}
        />
      </section>

      <div class="dashboard-grid-2">
        <section>
          <h2>Weekly activity (12 weeks)</h2>
          <${LineChart}
            title="Weekly job activity"
            series=${[
              {
                name: 'Jobs added',
                points: stats.weeklyTrend.map((w) => ({
                  label: w.weekStart,
                  value: w.count,
                })),
              },
            ]}
          />
        </section>
        <section>
          <h2>Remote vs onsite</h2>
          <${DonutChart}
            title="Remote versus onsite jobs"
            segments=${[
              { label: 'Remote', value: stats.remoteSplit.remote },
              { label: 'Onsite', value: stats.remoteSplit.onsite },
            ]}
          />
        </section>
      </div>

      <section>
        <h2>Recent activity</h2>
        ${
          stats.recentActivity.length === 0
            ? html`<p class="tag-empty">Nothing yet.</p>`
            : html`
                <ul class="activity-list">
                  ${stats.recentActivity.map(
                    (job) => html`
                      <li>
                        <a href="#/jobs/${String(job.id)}">${job.job_title}</a>
                        <span class="muted">
                          at ${job.company_name} — ${job.interview_stage} —
                          ${job.updated_at.slice(0, 10)}
                        </span>
                      </li>
                    `,
                  )}
                </ul>
              `
        }
      </section>
    </div>
  `;
}
