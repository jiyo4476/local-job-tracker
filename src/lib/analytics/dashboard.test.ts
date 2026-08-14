import { describe, expect, it } from 'vitest';

import type { StoredJob } from '../db/schema';
import {
  buildWeeklyTrend,
  computeDashboardStats,
  startOfWeekIso,
} from './dashboard';

let nextId = 1;

function job(overrides: Partial<StoredJob> = {}): StoredJob {
  const timestamp = overrides.created_at ?? '2026-08-10T12:00:00.000Z';
  nextId += 1;
  return {
    id: nextId,
    source_platform: 'indeed',
    external_job_id: `job-${String(nextId)}`,
    company_name: 'Example Analytics',
    job_title: 'Software Engineer',
    job_link: 'https://example.com/jobs/1',
    interview_stage: 'not_applied',
    priority: 0,
    notes: '',
    contacts: [],
    is_active: true,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

describe('startOfWeekIso', () => {
  it('anchors to the Monday of the week (UTC)', () => {
    expect(startOfWeekIso(new Date('2026-08-12T15:00:00.000Z'))).toBe(
      '2026-08-10',
    );
    expect(startOfWeekIso(new Date('2026-08-10T00:00:00.000Z'))).toBe(
      '2026-08-10',
    );
    expect(startOfWeekIso(new Date('2026-08-16T23:59:59.000Z'))).toBe(
      '2026-08-10',
    );
  });
});

describe('buildWeeklyTrend', () => {
  it('returns one zero-filled bucket per week when there are no jobs', () => {
    const trend = buildWeeklyTrend([], new Date('2026-08-12T00:00:00.000Z'), 3);
    expect(trend).toHaveLength(3);
    expect(trend.every((b) => b.count === 0)).toBe(true);
    expect(trend[trend.length - 1]?.weekStart).toBe('2026-08-10');
  });

  it('counts jobs into the week their created_at falls in', () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const trend = buildWeeklyTrend(
      [
        job({ created_at: '2026-08-11T00:00:00.000Z' }),
        job({ created_at: '2026-08-11T06:00:00.000Z' }),
        job({ created_at: '2026-08-04T00:00:00.000Z' }),
        job({ created_at: '2025-01-01T00:00:00.000Z' }),
      ],
      now,
      3,
    );
    expect(trend.map((b) => b.count)).toEqual([0, 1, 2]);
  });
});

describe('computeDashboardStats', () => {
  const now = new Date('2026-08-12T00:00:00.000Z');

  it('counts active jobs by stage and ignores deactivated ones', () => {
    const stats = computeDashboardStats(
      [
        job({ interview_stage: 'applied' }),
        job({ interview_stage: 'applied' }),
        job({ interview_stage: 'not_applied', is_active: false }),
      ],
      now,
    );
    expect(stats.totalTracked).toBe(2);
    expect(stats.stageCounts.applied).toBe(2);
    expect(stats.stageCounts.not_applied).toBe(0);
  });

  it('counts applied, active-interview, and stale jobs correctly', () => {
    const stats = computeDashboardStats(
      [
        job({ interview_stage: 'not_applied' }),
        job({ interview_stage: 'applied' }),
        job({ interview_stage: 'phone_screen' }),
        job({ interview_stage: 'onsite' }),
        job({
          interview_stage: 'applied',
          updated_at: '2026-07-01T00:00:00.000Z',
        }),
        job({
          interview_stage: 'rejected',
          updated_at: '2026-07-01T00:00:00.000Z',
        }),
      ],
      now,
    );
    expect(stats.totalApplied).toBe(5);
    expect(stats.activeInterviews).toBe(2);
    // Only the non-terminal stale job counts; the rejected one is excluded.
    expect(stats.staleCount).toBe(1);
  });

  it('ranks top skills by frequency across active jobs only', () => {
    const stats = computeDashboardStats(
      [
        job({ skills: ['TypeScript', 'React'] }),
        job({ skills: ['TypeScript'] }),
        job({ skills: ['Python'], is_active: false }),
      ],
      now,
    );
    expect(stats.topSkills[0]).toEqual({ name: 'TypeScript', count: 2 });
    expect(stats.topSkills.some((s) => s.name === 'Python')).toBe(false);
  });

  it('splits remote vs onsite among active jobs', () => {
    const stats = computeDashboardStats(
      [
        job({ is_remote: true }),
        job({ is_remote: true }),
        job({ is_remote: false }),
        job({ is_remote: undefined }),
      ],
      now,
    );
    expect(stats.remoteSplit).toEqual({ remote: 2, onsite: 2 });
  });

  it('orders recent activity by most recently updated, including inactive jobs', () => {
    const stats = computeDashboardStats(
      [
        job({ job_title: 'Older', updated_at: '2026-08-01T00:00:00.000Z' }),
        job({
          job_title: 'Newest',
          updated_at: '2026-08-11T00:00:00.000Z',
          is_active: false,
        }),
        job({ job_title: 'Middle', updated_at: '2026-08-05T00:00:00.000Z' }),
      ],
      now,
    );
    expect(stats.recentActivity.map((j) => j.job_title)).toEqual([
      'Newest',
      'Middle',
      'Older',
    ]);
  });
});
