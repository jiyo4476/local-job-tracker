import type { StoredJob } from '../db/schema';
import { apiSourcePlatformSchema } from '../schemas';
import type { TaxonomyField } from '../taxonomyFields';
import { buildWeeklyTrend } from './dashboard';

const DEFAULT_WEEKS = 12;
const HOURS_PER_YEAR = 2080;

export interface PlatformCount {
  platform: string;
  count: number;
}

/** Counts jobs per source platform, most common first. Empty platforms are omitted. */
export function platformBreakdown(jobs: readonly StoredJob[]): PlatformCount[] {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    counts.set(job.source_platform, (counts.get(job.source_platform) ?? 0) + 1);
  }
  return apiSourcePlatformSchema.options
    .map((platform) => ({ platform, count: counts.get(platform) ?? 0 }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);
}

export interface RemoteOnsiteWeek {
  weekStart: string;
  remote: number;
  onsite: number;
}

export function remoteOnsiteByWeek(
  jobs: readonly StoredJob[],
  now: Date = new Date(),
  weeks: number = DEFAULT_WEEKS,
): RemoteOnsiteWeek[] {
  const remoteTrend = buildWeeklyTrend(
    jobs.filter((job) => job.is_remote === true),
    now,
    weeks,
  );
  const onsiteTrend = buildWeeklyTrend(
    jobs.filter((job) => job.is_remote !== true),
    now,
    weeks,
  );
  return remoteTrend.map((bucket, index) => ({
    weekStart: bucket.weekStart,
    remote: bucket.count,
    onsite: onsiteTrend[index]?.count ?? 0,
  }));
}

/** Annualized salary in cents, preferring the annual range and falling back to hourly × 2080. */
function annualEquivalentCents(job: StoredJob): number | undefined {
  if (job.salary_min !== undefined && job.salary_max !== undefined) {
    return Math.round((job.salary_min + job.salary_max) / 2);
  }
  if (job.salary_min !== undefined) return job.salary_min;
  if (job.salary_max !== undefined) return job.salary_max;
  if (job.hourly_rate_min !== undefined && job.hourly_rate_max !== undefined) {
    return Math.round(
      ((job.hourly_rate_min + job.hourly_rate_max) / 2) * HOURS_PER_YEAR * 100,
    );
  }
  if (job.hourly_rate_min !== undefined) {
    return Math.round(job.hourly_rate_min * HOURS_PER_YEAR * 100);
  }
  if (job.hourly_rate_max !== undefined) {
    return Math.round(job.hourly_rate_max * HOURS_PER_YEAR * 100);
  }
  return undefined;
}

export interface SalaryGroupSummary {
  job_type: string;
  experience_level: string;
  count: number;
  minCents: number;
  medianCents: number;
  maxCents: number;
}

/** Min/median/max annualized salary per (job_type, experience_level) group, most-populated first. */
export function salarySummaryByJobTypeAndExperience(
  jobs: readonly StoredJob[],
): SalaryGroupSummary[] {
  const groups = new Map<string, number[]>();
  for (const job of jobs) {
    const cents = annualEquivalentCents(job);
    if (cents === undefined) continue;
    const key = `${job.job_type ?? 'unspecified'}::${job.experience_level ?? 'unspecified'}`;
    const values = groups.get(key) ?? [];
    values.push(cents);
    groups.set(key, values);
  }

  const results: SalaryGroupSummary[] = [];
  for (const [key, values] of groups) {
    const [jobType, experienceLevel] = key.split('::') as [string, string];
    const sorted = [...values].sort((a, b) => a - b);
    results.push({
      job_type: jobType,
      experience_level: experienceLevel,
      count: sorted.length,
      minCents: sorted[0] ?? 0,
      medianCents:
        sorted.length % 2 === 0
          ? Math.round(
              ((sorted[sorted.length / 2 - 1] ?? 0) +
                (sorted[sorted.length / 2] ?? 0)) /
                2,
            )
          : (sorted[Math.floor(sorted.length / 2)] ?? 0),
      maxCents: sorted[sorted.length - 1] ?? 0,
    });
  }
  return results.sort((a, b) => b.count - a.count);
}

export interface NamedCount {
  name: string;
  count: number;
}

/** Top-N most frequent values in one taxonomy category, most common first. */
export function taxonomyTopN(
  jobs: readonly StoredJob[],
  field: TaxonomyField,
  limit = 15,
): NamedCount[] {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    for (const value of job[field] ?? []) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

export interface SkillsByClearance {
  withClearance: NamedCount[];
  withoutClearance: NamedCount[];
}

export function skillsByClearance(
  jobs: readonly StoredJob[],
  limit = 10,
): SkillsByClearance {
  return {
    withClearance: taxonomyTopN(
      jobs.filter((job) => job.security_clearance_req === true),
      'skills',
      limit,
    ),
    withoutClearance: taxonomyTopN(
      jobs.filter((job) => job.security_clearance_req !== true),
      'skills',
      limit,
    ),
  };
}

export interface SkillDemandSeries {
  periods: string[];
  series: { skill: string; counts: number[] }[];
}

/** Monthly mentions for the top skills. `created_at` is the local-capture fallback when date_posted is absent. */
export function skillDemandOverTime(
  jobs: readonly StoredJob[],
  now: Date = new Date(),
  months = 12,
  topN = 15,
): SkillDemandSeries {
  const topSkills = taxonomyTopN(jobs, 'skills', topN).map((s) => s.name);
  const periods: string[] = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1),
    );
    periods.push(date.toISOString().slice(0, 7));
  }
  const series = topSkills.map((skill) => {
    const counts = periods.map(
      (period) =>
        jobs.filter(
          (job) =>
            (job.skills ?? []).includes(skill) &&
            (job.date_posted ?? job.created_at).slice(0, 7) === period,
        ).length,
    );
    return { skill, counts };
  });
  return { periods, series };
}
