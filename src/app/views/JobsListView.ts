import { useEffect, useState } from 'preact/hooks';
import { html } from '../html';
import {
  type JobListFilters,
  listJobs,
  restoreJob,
  softDeleteJob,
} from '../../lib/db/jobsRepo';
import { interviewStageSchema, type StoredJob } from '../../lib/db/schema';
import { apiSourcePlatformSchema } from '../../lib/schemas';

const STAGES = interviewStageSchema.options;
const PLATFORMS = apiSourcePlatformSchema.options;

interface Props {
  initialQuery?: string;
}

export function JobsListView({ initialQuery }: Props) {
  const [filters, setFilters] = useState<JobListFilters>(() =>
    initialQuery ? { query: initialQuery } : {},
  );
  const [jobs, setJobs] = useState<StoredJob[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    setJobs(await listJobs(filters));
    setLoading(false);
  };

  useEffect(() => {
    void reload();
  }, [filters]);

  const updateFilter = <K extends keyof JobListFilters>(
    key: K,
    value: JobListFilters[K],
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const toggleActive = async (job: StoredJob) => {
    if (job.id === undefined) return;
    if (job.is_active) await softDeleteJob(job.id);
    else await restoreJob(job.id);
    await reload();
  };

  return html`
    <div class="jobs-list-view">
      <div class="filters-row">
        <label>
          Stage
          <select
            onChange=${(event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              updateFilter(
                'interview_stage',
                value ? (value as StoredJob['interview_stage']) : undefined,
              );
            }}
          >
            <option value="">All</option>
            ${STAGES.map(
              (stage) => html`<option value=${stage}>${stage}</option>`,
            )}
          </select>
        </label>
        <label>
          Platform
          <select
            onChange=${(event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              updateFilter(
                'source_platform',
                value ? (value as StoredJob['source_platform']) : undefined,
              );
            }}
          >
            <option value="">All</option>
            ${PLATFORMS.map(
              (platform) =>
                html`<option value=${platform}>${platform}</option>`,
            )}
          </select>
        </label>
        <label class="row">
          <input
            type="checkbox"
            checked=${filters.is_remote === true}
            onChange=${(event: Event) => {
              const checked = (event.target as HTMLInputElement).checked;
              updateFilter('is_remote', checked ? true : undefined);
            }}
          />
          Remote only
        </label>
        <label class="row">
          <input
            type="checkbox"
            checked=${filters.includeInactive === true}
            onChange=${(event: Event) => {
              updateFilter(
                'includeInactive',
                (event.target as HTMLInputElement).checked,
              );
            }}
          />
          Include deactivated
        </label>
        <label>
          Skill
          <input
            value=${filters.skill ?? ''}
            onInput=${(event: Event) => {
              const value = (event.target as HTMLInputElement).value;
              updateFilter('skill', value || undefined);
            }}
          />
        </label>
        <label>
          Search
          <input
            value=${filters.query ?? ''}
            onInput=${(event: Event) => {
              const value = (event.target as HTMLInputElement).value;
              updateFilter('query', value || undefined);
            }}
          />
        </label>
      </div>

      ${
        loading
          ? html`<p>Loading…</p>`
          : jobs.length === 0
            ? html`<p class="tag-empty">No jobs match these filters.</p>`
            : html`
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Company</th>
                      <th>Platform</th>
                      <th>Stage</th>
                      <th>Remote</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${jobs.map(
                      (job) => html`
                        <tr>
                          <td>
                            <a href="#/jobs/${String(job.id)}"
                              >${job.job_title}</a
                            >
                          </td>
                          <td>${job.company_name}</td>
                          <td>${job.source_platform}</td>
                          <td>${job.interview_stage}</td>
                          <td>${job.is_remote ? 'Yes' : 'No'}</td>
                          <td class="actions-cell">
                            <a href="#/jobs/${String(job.id)}">View</a>
                            <a href="#/jobs/${String(job.id)}/edit">Edit</a>
                            <button
                              type="button"
                              onClick=${() => toggleActive(job)}
                            >
                              ${job.is_active ? 'Deactivate' : 'Restore'}
                            </button>
                          </td>
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
