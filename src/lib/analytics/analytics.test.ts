import { describe, expect, it } from 'vitest';

import type { StoredJob } from '../db/schema';
import {
  platformBreakdown,
  remoteOnsiteByWeek,
  salarySummaryByJobTypeAndExperience,
  skillDemandOverTime,
  skillsByClearance,
  taxonomyTopN,
} from './analytics';

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

describe('platformBreakdown', () => {
  it('counts jobs per platform, most common first, omitting zero counts', () => {
    const result = platformBreakdown([
      job({ source_platform: 'linkedin' }),
      job({ source_platform: 'linkedin' }),
      job({ source_platform: 'indeed' }),
    ]);
    expect(result).toEqual([
      { platform: 'linkedin', count: 2 },
      { platform: 'indeed', count: 1 },
    ]);
  });
});

describe('remoteOnsiteByWeek', () => {
  it('buckets remote and onsite counts per week', () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const result = remoteOnsiteByWeek(
      [
        job({ is_remote: true, created_at: '2026-08-11T00:00:00.000Z' }),
        job({ is_remote: false, created_at: '2026-08-11T00:00:00.000Z' }),
        job({ is_remote: false, created_at: '2026-08-11T00:00:00.000Z' }),
      ],
      now,
      1,
    );
    expect(result).toEqual([{ weekStart: '2026-08-10', remote: 1, onsite: 2 }]);
  });
});

describe('salarySummaryByJobTypeAndExperience', () => {
  it('summarizes min/median/max annual salary per group', () => {
    const result = salarySummaryByJobTypeAndExperience([
      job({
        job_type: 'full_time',
        experience_level: 'senior',
        salary_min: 100_00,
        salary_max: 120_00,
      }),
      job({
        job_type: 'full_time',
        experience_level: 'senior',
        salary_min: 140_00,
        salary_max: 160_00,
      }),
      job({
        job_type: 'full_time',
        experience_level: 'senior',
        salary_min: 130_00,
        salary_max: 130_00,
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      job_type: 'full_time',
      experience_level: 'senior',
      count: 3,
      minCents: 110_00,
      medianCents: 130_00,
      maxCents: 150_00,
    });
  });

  it('converts hourly rates to an annual equivalent (rate x 2080 x 100)', () => {
    const result = salarySummaryByJobTypeAndExperience([
      job({
        job_type: 'contract',
        experience_level: 'mid',
        hourly_rate_min: 50,
        hourly_rate_max: 50,
      }),
    ]);
    expect(result[0]?.minCents).toBe(50 * 2080 * 100);
  });

  it('skips jobs with no salary data at all', () => {
    const result = salarySummaryByJobTypeAndExperience([job()]);
    expect(result).toHaveLength(0);
  });
});

describe('taxonomyTopN', () => {
  it('ranks values in a taxonomy field by frequency', () => {
    const result = taxonomyTopN(
      [
        job({ skills: ['TypeScript', 'React'] }),
        job({ skills: ['TypeScript'] }),
        job({ software: ['Docker'] }),
      ],
      'skills',
      1,
    );
    expect(result).toEqual([{ name: 'TypeScript', count: 2 }]);
  });
});

describe('skillsByClearance', () => {
  it('splits top skills by whether the job requires a security clearance', () => {
    const result = skillsByClearance(
      [
        job({ security_clearance_req: true, skills: ['Rust'] }),
        job({ security_clearance_req: false, skills: ['Python'] }),
      ],
      5,
    );
    expect(result.withClearance).toEqual([{ name: 'Rust', count: 1 }]);
    expect(result.withoutClearance).toEqual([{ name: 'Python', count: 1 }]);
  });
});

describe('skillDemandOverTime', () => {
  it('tracks monthly mentions using date_posted and created_at fallback', () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const result = skillDemandOverTime(
      [
        job({
          skills: ['TypeScript'],
          date_posted: '2026-08-01',
          created_at: '2026-07-11T00:00:00.000Z',
        }),
        job({ skills: ['TypeScript'], created_at: '2026-07-04T00:00:00.000Z' }),
      ],
      now,
      2,
      1,
    );
    expect(result.periods).toEqual(['2026-07', '2026-08']);
    expect(result.series).toEqual([{ skill: 'TypeScript', counts: [1, 1] }]);
  });
});
