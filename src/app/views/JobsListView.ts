import { useEffect, useMemo, useState } from 'preact/hooks';
import { html } from '../html';
import { errorMessage, useAsyncResource } from '../useAsyncResource';
import {
  type JobListFilters,
  listJobs,
  restoreJob,
  softDeleteJob,
  updateJob,
} from '../../lib/db/jobsRepo';
import {
  interviewStageSchema,
  type InterviewStage,
  type StoredJob,
} from '../../lib/db/schema';
import { apiSourcePlatformSchema } from '../../lib/schemas';
import {
  presentJobs,
  pruneSelection,
  type JobSortKey,
  type SortDirection,
} from './jobsListModel';

const STAGES = interviewStageSchema.options;
const PLATFORMS = apiSourcePlatformSchema.options;

interface Props {
  initialQuery?: string;
}
type BulkAction = 'deactivate' | 'restore' | InterviewStage;

export function JobsListView({ initialQuery }: Props) {
  const [filters, setFilters] = useState<JobListFilters>(() =>
    initialQuery ? { query: initialQuery } : {},
  );
  const [salaryMin, setSalaryMin] = useState<number>();
  const [salaryMax, setSalaryMax] = useState<number>();
  const [sortKey, setSortKey] = useState<JobSortKey>('created_at');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);
  const resource = useAsyncResource(
    () => listJobs(filters),
    [filters],
    'Could not load jobs.',
  );
  const jobs = useMemo(
    () =>
      presentJobs(resource.data ?? [], {
        salaryMin,
        salaryMax,
        sortKey,
        sortDirection,
      }),
    [resource.data, salaryMin, salaryMax, sortKey, sortDirection],
  );
  useEffect(() => {
    setSelected((current) => pruneSelection(current, jobs));
  }, [jobs]);

  const updateFilter = <K extends keyof JobListFilters>(
    key: K,
    value: JobListFilters[K],
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };
  const toggleSelection = (id: number, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const mutateOne = async (job: StoredJob) => {
    if (job.id === undefined) return;
    setStatus('');
    setStatusIsError(false);
    try {
      if (job.is_active) await softDeleteJob(job.id);
      else await restoreJob(job.id);
      await resource.reload();
    } catch (caught) {
      setStatusIsError(true);
      setStatus(errorMessage(caught, 'Could not update this job.'));
    }
  };

  const runBulk = async (action: BulkAction) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const label =
      action === 'deactivate'
        ? 'deactivate'
        : action === 'restore'
          ? 'restore'
          : `move to ${action}`;
    if (!window.confirm(`${label} ${String(ids.length)} selected job(s)?`))
      return;
    const results = await Promise.allSettled(
      ids.map((id) =>
        action === 'deactivate'
          ? softDeleteJob(id)
          : action === 'restore'
            ? restoreJob(id)
            : updateJob(id, { interview_stage: action }),
      ),
    );
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;
    setStatusIsError(failed > 0);
    setStatus(
      failed === 0
        ? `Updated ${String(ids.length)} job(s).`
        : `Updated ${String(ids.length - failed)} job(s); ${String(failed)} failed.`,
    );
    setSelected(new Set());
    await resource.reload();
  };

  return html`<div class="jobs-list-view">
    <div class="filters-row">
      <label
        >Stage
        <select
          value=${filters.interview_stage ?? ''}
          onChange=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            updateFilter(
              'interview_stage',
              value ? (value as InterviewStage) : undefined,
            );
          }}
        >
          <option value="">All</option>
          ${STAGES.map((stage) => html`<option value=${stage}>${stage}</option>`)}
        </select></label
      >
      <label
        >Platform
        <select
          value=${filters.source_platform ?? ''}
          onChange=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            updateFilter(
              'source_platform',
              value ? (value as StoredJob['source_platform']) : undefined,
            );
          }}
        >
          <option value="">All</option>
          ${PLATFORMS.map((platform) => html`<option value=${platform}>${platform}</option>`)}
        </select></label
      >
      <label class="row"
        ><input
          type="checkbox"
          checked=${filters.is_remote === true}
          onChange=${(e: Event) => {
            updateFilter(
              'is_remote',
              (e.target as HTMLInputElement).checked ? true : undefined,
            );
          }}
        />Remote only</label
      >
      <label class="row"
        ><input
          type="checkbox"
          checked=${filters.includeInactive === true}
          onChange=${(e: Event) => {
            updateFilter(
              'includeInactive',
              (e.target as HTMLInputElement).checked,
            );
          }}
        />Include deactivated</label
      >
      <label
        >Skill
        <input
          value=${filters.skill ?? ''}
          onInput=${(e: Event) => {
            updateFilter(
              'skill',
              (e.target as HTMLInputElement).value || undefined,
            );
          }}
      /></label>
      <label
        >Search
        <input
          value=${filters.query ?? ''}
          onInput=${(e: Event) => {
            updateFilter(
              'query',
              (e.target as HTMLInputElement).value || undefined,
            );
          }}
      /></label>
      <label
        >Min annual salary ($)<input
          type="number"
          min="0"
          value=${salaryMin === undefined ? '' : salaryMin / 100}
          onInput=${(e: Event) => {
            const value = (e.target as HTMLInputElement).valueAsNumber;
            setSalaryMin(
              Number.isFinite(value) ? Math.round(value * 100) : undefined,
            );
          }}
      /></label>
      <label
        >Max annual salary ($)<input
          type="number"
          min="0"
          value=${salaryMax === undefined ? '' : salaryMax / 100}
          onInput=${(e: Event) => {
            const value = (e.target as HTMLInputElement).valueAsNumber;
            setSalaryMax(
              Number.isFinite(value) ? Math.round(value * 100) : undefined,
            );
          }}
      /></label>
      <label
        >Sort
        <select
          value=${sortKey}
          onChange=${(e: Event) => {
            setSortKey((e.target as HTMLSelectElement).value as JobSortKey);
          }}
        >
          <option value="created_at">Date added</option>
          <option value="job_title">Title</option>
          <option value="company_name">Company</option>
          <option value="salary">Salary</option>
        </select></label
      >
      <label
        >Direction
        <select
          value=${sortDirection}
          onChange=${(e: Event) => {
            setSortDirection(
              (e.target as HTMLSelectElement).value as SortDirection,
            );
          }}
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select></label
      >
    </div>
    <div class="bulk-actions" aria-label="Bulk job actions">
      <span>${String(selected.size)} selected</span>
      <select
        aria-label="Bulk stage"
        onChange=${(e: Event) => {
          const value = (e.target as HTMLSelectElement).value;
          if (value) {
            void runBulk(value as InterviewStage);
            (e.target as HTMLSelectElement).value = '';
          }
        }}
      >
        <option value="">Change stage…</option>
        ${STAGES.map((stage) => html`<option value=${stage}>${stage}</option>`)}
      </select>
      <button
        type="button"
        disabled=${selected.size === 0}
        onClick=${() => void runBulk('deactivate')}
      >
        Deactivate selected
      </button>
      <button
        type="button"
        disabled=${selected.size === 0}
        onClick=${() => void runBulk('restore')}
      >
        Restore selected
      </button>
    </div>
    ${status ? html`<p role=${statusIsError ? 'alert' : 'status'}>${status}</p>` : null}
    ${
      resource.error
        ? html`<p role="alert">
            ${resource.error}
            <button type="button" onClick=${() => void resource.reload()}>
              Retry
            </button>
          </p>`
        : resource.loading
          ? html`<p>Loading…</p>`
          : jobs.length === 0
            ? html`<p class="tag-empty">No jobs match these filters.</p>`
            : html` <table class="data-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select all visible jobs"
                        checked=${jobs.length > 0 && jobs.every((job) => job.id !== undefined && selected.has(job.id))}
                        onChange=${(e: Event) => {
                          const checked = (e.target as HTMLInputElement)
                            .checked;
                          setSelected(
                            checked
                              ? new Set(
                                  jobs.flatMap((job) =>
                                    job.id === undefined ? [] : [job.id],
                                  ),
                                )
                              : new Set(),
                          );
                        }}
                      />
                    </th>
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
                    (job) =>
                      html`<tr>
                        <td>
                          <input
                            type="checkbox"
                            aria-label="Select ${job.job_title}"
                            checked=${job.id !== undefined && selected.has(job.id)}
                            onChange=${(e: Event) => {
                              if (job.id !== undefined)
                                toggleSelection(
                                  job.id,
                                  (e.target as HTMLInputElement).checked,
                                );
                            }}
                          />
                        </td>
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
                          <a href="#/jobs/${String(job.id)}">View</a
                          ><a href="#/jobs/${String(job.id)}/edit">Edit</a
                          ><button
                            type="button"
                            onClick=${() => void mutateOne(job)}
                          >
                            ${job.is_active ? 'Deactivate' : 'Restore'}
                          </button>
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>`
    }
  </div>`;
}
