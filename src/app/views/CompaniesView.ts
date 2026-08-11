import { useEffect, useState } from 'preact/hooks';
import { html } from '../html';
import { listJobs } from '../../lib/db/jobsRepo';
import type { StoredJob } from '../../lib/db/schema';

interface CompanyRow {
  name: string;
  jobCount: number;
  activeCount: number;
}

export function CompaniesView() {
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const jobs = await listJobs({ includeInactive: true });
      setRows(groupByCompany(jobs));
      setLoading(false);
    })();
  }, []);

  return html`
    <div class="companies-view">
      <h2>Companies</h2>
      ${
        loading
          ? html`<p>Loading…</p>`
          : rows.length === 0
            ? html`<p class="tag-empty">No companies yet.</p>`
            : html`
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Jobs</th>
                      <th>Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rows.map(
                      (row) => html`
                        <tr>
                          <td>
                            <a href="#/jobs?q=${encodeURIComponent(row.name)}"
                              >${row.name}</a
                            >
                          </td>
                          <td>${row.jobCount}</td>
                          <td>${row.activeCount}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              `
      }
    </div>
  `;
}

function groupByCompany(jobs: StoredJob[]): CompanyRow[] {
  const map = new Map<string, CompanyRow>();
  for (const job of jobs) {
    const existing = map.get(job.company_name);
    if (existing) {
      existing.jobCount += 1;
      if (job.is_active) existing.activeCount += 1;
    } else {
      map.set(job.company_name, {
        name: job.company_name,
        jobCount: 1,
        activeCount: job.is_active ? 1 : 0,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.jobCount - a.jobCount);
}
