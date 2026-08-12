import type { InterviewStage, StoredJob } from '../db/schema';
import { interviewStageSchema } from '../db/schema';

const ACTIVE_INTERVIEW_STAGES: readonly InterviewStage[] = [
  'phone_screen',
  'technical_screen',
  'onsite',
];
const TERMINAL_STAGES: readonly InterviewStage[] = [
  'rejected',
  'withdrawn',
  'offer_received',
];

const STALE_DAYS = 14;
const DEFAULT_TREND_WEEKS = 12;
const TOP_SKILLS_LIMIT = 15;
const RECENT_ACTIVITY_LIMIT = 10;

export interface WeeklyBucket {
  weekStart: string;
  count: number;
}

export interface DashboardStats {
  totalTracked: number;
  totalApplied: number;
  activeInterviews: number;
  staleCount: number;
  stageCounts: Record<InterviewStage, number>;
  topSkills: { name: string; count: number }[];
  weeklyTrend: WeeklyBucket[];
  remoteSplit: { remote: number; onsite: number };
  recentActivity: StoredJob[];
}

/** Monday-anchored UTC week start, as an ISO date (`YYYY-MM-DD`). */
export function startOfWeekIso(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const isoDayOfWeek = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - isoDayOfWeek);
  return d.toISOString().slice(0, 10);
}

/** Buckets `jobs` by the ISO week their `created_at` falls in, over the trailing `weeks` weeks ending at `now`. */
export function buildWeeklyTrend(
  jobs: readonly StoredJob[],
  now: Date,
  weeks: number = DEFAULT_TREND_WEEKS,
): WeeklyBucket[] {
  const currentWeekStart = startOfWeekIso(now);
  const weekStarts: string[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const anchor = new Date(`${currentWeekStart}T00:00:00.000Z`);
    anchor.setUTCDate(anchor.getUTCDate() - i * 7);
    weekStarts.push(startOfWeekIso(anchor));
  }

  const buckets = new Map<string, number>(weekStarts.map((w) => [w, 0]));
  for (const job of jobs) {
    const week = startOfWeekIso(new Date(job.created_at));
    if (buckets.has(week)) {
      buckets.set(week, (buckets.get(week) ?? 0) + 1);
    }
  }

  return weekStarts.map((weekStart) => ({
    weekStart,
    count: buckets.get(weekStart) ?? 0,
  }));
}

export function computeDashboardStats(
  jobs: readonly StoredJob[],
  now: Date = new Date(),
): DashboardStats {
  const active = jobs.filter((job) => job.is_active);

  const stageCounts = Object.fromEntries(
    interviewStageSchema.options.map((stage) => [stage, 0]),
  ) as Record<InterviewStage, number>;
  for (const job of active) {
    stageCounts[job.interview_stage] += 1;
  }

  const totalTracked = active.length;
  const totalApplied = active.filter(
    (job) => job.interview_stage !== 'not_applied',
  ).length;
  const activeInterviews = active.filter((job) =>
    ACTIVE_INTERVIEW_STAGES.includes(job.interview_stage),
  ).length;

  const staleCutoff = new Date(
    now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const staleCount = active.filter(
    (job) =>
      !TERMINAL_STAGES.includes(job.interview_stage) &&
      job.updated_at < staleCutoff,
  ).length;

  const skillCounts = new Map<string, number>();
  for (const job of active) {
    for (const skill of job.skills ?? []) {
      skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
    }
  }
  const topSkills = [...skillCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SKILLS_LIMIT)
    .map(([name, count]) => ({ name, count }));

  const weeklyTrend = buildWeeklyTrend(active, now);

  const remoteSplit = {
    remote: active.filter((job) => job.is_remote === true).length,
    onsite: active.filter((job) => job.is_remote !== true).length,
  };

  const recentActivity = [...jobs]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, RECENT_ACTIVITY_LIMIT);

  return {
    totalTracked,
    totalApplied,
    activeInterviews,
    staleCount,
    stageCounts,
    topSkills,
    weeklyTrend,
    remoteSplit,
    recentActivity,
  };
}
