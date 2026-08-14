import { describe, expect, it } from 'vitest';
import type { StoredJob } from '../../lib/db/schema';
import { presentJobs, pruneSelection } from './jobsListModel';

const job = (id: number, title: string, salary_min?: number): StoredJob => ({
  id,
  source_platform: 'direct',
  external_job_id: String(id),
  company_name: id === 1 ? 'Zulu' : 'Alpha',
  job_title: title,
  job_link: 'https://example.com',
  interview_stage: 'not_applied',
  priority: 0,
  notes: '',
  contacts: [],
  is_active: true,
  created_at: `2026-08-0${String(id)}T00:00:00.000Z`,
  updated_at: `2026-08-0${String(id)}T00:00:00.000Z`,
  ...(salary_min === undefined ? {} : { salary_min }),
});

describe('presentJobs', () => {
  it('applies typed salary bounds and explicit sorting without mutating input', () => {
    const input = [job(1, 'Backend', 90_00), job(2, 'Frontend', 120_00)];
    expect(
      presentJobs(input, {
        salaryMin: 100_00,
        sortKey: 'company_name',
        sortDirection: 'asc',
      }).map((row) => row.id),
    ).toEqual([2]);
    expect(input.map((row) => row.id)).toEqual([1, 2]);
  });

  it('puts missing salaries last in either direction', () => {
    const input = [job(1, 'A'), job(2, 'B', 100_00)];
    expect(
      presentJobs(input, { sortKey: 'salary', sortDirection: 'desc' }).map(
        (row) => row.id,
      ),
    ).toEqual([2, 1]);
    expect(
      presentJobs(input, { sortKey: 'salary', sortDirection: 'asc' }).map(
        (row) => row.id,
      ),
    ).toEqual([2, 1]);
  });

  it('prunes selections that are no longer visible', () => {
    expect([...pruneSelection(new Set([1, 2]), [job(2, 'B')])]).toEqual([2]);
  });
});
