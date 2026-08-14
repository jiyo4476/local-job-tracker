import type { StoredJob } from '../../lib/db/schema';

export type JobSortKey = 'created_at' | 'job_title' | 'company_name' | 'salary';
export type SortDirection = 'asc' | 'desc';

export interface ListPresentation {
  salaryMin?: number | undefined;
  salaryMax?: number | undefined;
  sortKey: JobSortKey;
  sortDirection: SortDirection;
}

export function annualSalaryCents(job: StoredJob): number | undefined {
  if (job.salary_min !== undefined) return job.salary_min;
  if (job.hourly_rate_min !== undefined)
    return Math.round(job.hourly_rate_min * 2080 * 100);
  return job.salary_max;
}

export function presentJobs(
  jobs: readonly StoredJob[],
  options: ListPresentation,
): StoredJob[] {
  const filtered = jobs.filter((job) => {
    const salary = annualSalaryCents(job);
    if (
      options.salaryMin !== undefined &&
      (salary === undefined || salary < options.salaryMin)
    )
      return false;
    if (
      options.salaryMax !== undefined &&
      (salary === undefined || salary > options.salaryMax)
    )
      return false;
    return true;
  });
  const factor = options.sortDirection === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => {
    if (options.sortKey === 'salary') {
      const left = annualSalaryCents(a);
      const right = annualSalaryCents(b);
      if (left === undefined) return right === undefined ? 0 : 1;
      if (right === undefined) return -1;
      return (left - right) * factor;
    }
    return a[options.sortKey].localeCompare(b[options.sortKey]) * factor;
  });
}

export function pruneSelection(
  selected: ReadonlySet<number>,
  visibleJobs: readonly StoredJob[],
): Set<number> {
  const visibleIds = new Set(
    visibleJobs.flatMap((job) => (job.id === undefined ? [] : [job.id])),
  );
  return new Set([...selected].filter((id) => visibleIds.has(id)));
}
