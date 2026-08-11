import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDbForTests } from './schema';
import {
  exportAllJobs,
  getJob,
  importJobs,
  listJobs,
  softDeleteJob,
  updateJob,
  upsertJob,
} from './jobsRepo';
import type { NewJobInput } from './schema';

function baseInput(overrides: Partial<NewJobInput> = {}): NewJobInput {
  return {
    source_platform: 'indeed',
    external_job_id: 'abc123',
    company_name: 'Example Analytics',
    job_title: 'Senior Software Engineer',
    job_link: 'https://example.com/jobs/abc123',
    ...overrides,
  };
}

let dbName = 0;

beforeEach(() => {
  dbName += 1;
  resetDbForTests(`test-db-${String(dbName)}`);
});

describe('upsertJob', () => {
  it('creates a new job on first save', async () => {
    const result = await upsertJob(baseInput());
    expect(result.action).toBe('created');

    const stored = await getJob(result.id);
    expect(stored?.company_name).toBe('Example Analytics');
    expect(stored?.interview_stage).toBe('not_applied');
    expect(stored?.is_active).toBe(true);
  });

  it('updates on exact (source_platform, external_job_id) match', async () => {
    const first = await upsertJob(baseInput());
    const second = await upsertJob(
      baseInput({ job_title: 'Staff Software Engineer' }),
    );

    expect(second.action).toBe('updated');
    expect(second.id).toBe(first.id);

    const stored = await getJob(first.id);
    expect(stored?.job_title).toBe('Staff Software Engineer');
  });

  it('preserves tracker-lifecycle fields across an update', async () => {
    const first = await upsertJob(baseInput());
    await updateJob(first.id, {
      interview_stage: 'phone_screen',
      notes: 'Recruiter call scheduled.',
    });

    await upsertJob(baseInput({ job_title: 'Updated title' }));

    const stored = await getJob(first.id);
    expect(stored?.interview_stage).toBe('phone_screen');
    expect(stored?.notes).toBe('Recruiter call scheduled.');
  });

  it('skips as duplicate on fuzzy (company, title) match within 7 days', async () => {
    const first = await upsertJob(baseInput());
    const duplicate = await upsertJob(
      baseInput({ external_job_id: 'different-id-on-a-mirror' }),
    );

    expect(duplicate.action).toBe('duplicate_skipped');
    expect(duplicate.id).toBe(first.id);

    const all = await listJobs();
    expect(all).toHaveLength(1);
  });

  it('does not fuzzy-match a different title at the same company', async () => {
    await upsertJob(baseInput());
    const distinct = await upsertJob(
      baseInput({
        external_job_id: 'other-role',
        job_title: 'Product Manager',
      }),
    );

    expect(distinct.action).toBe('created');
    const all = await listJobs();
    expect(all).toHaveLength(2);
  });

  it('does not fuzzy-match a soft-deleted job', async () => {
    const first = await upsertJob(baseInput());
    await softDeleteJob(first.id);

    const result = await upsertJob(
      baseInput({ external_job_id: 'a-fresh-repost' }),
    );

    expect(result.action).toBe('created');
  });
});

describe('listJobs', () => {
  it('excludes inactive jobs by default and includes them on request', async () => {
    const { id } = await upsertJob(baseInput());
    await softDeleteJob(id);

    expect(await listJobs()).toHaveLength(0);
    expect(await listJobs({ includeInactive: true })).toHaveLength(1);
  });

  it('filters by interview_stage, platform, and skill', async () => {
    const a = await upsertJob(
      baseInput({
        external_job_id: 'a',
        source_platform: 'linkedin',
        skills: ['Python', 'SQL'],
      }),
    );
    await upsertJob(
      baseInput({
        external_job_id: 'b',
        source_platform: 'dice',
        company_name: 'A Different Company',
        job_title: 'A Different Title',
      }),
    );
    await updateJob(a.id, { interview_stage: 'onsite' });

    expect(await listJobs({ interview_stage: 'onsite' })).toHaveLength(1);
    expect(await listJobs({ source_platform: 'dice' })).toHaveLength(1);
    expect(await listJobs({ skill: 'python' })).toHaveLength(1);
    expect(await listJobs({ skill: 'rust' })).toHaveLength(0);
  });
});

describe('export/import', () => {
  it('round-trips a full dataset', async () => {
    await upsertJob(baseInput());
    await upsertJob(
      baseInput({
        external_job_id: 'second',
        company_name: 'A Different Company',
        job_title: 'A Different Title',
      }),
    );

    const exported = await exportAllJobs();
    expect(exported).toHaveLength(2);

    resetDbForTests(`test-db-import-${String(dbName)}`);
    const { imported, skipped } = await importJobs(exported);
    expect(imported).toBe(2);
    expect(skipped).toBe(0);
    expect(await listJobs()).toHaveLength(2);
  });

  it('skips re-importing an already-present job by exact identity', async () => {
    await upsertJob(baseInput());
    const exported = await exportAllJobs();

    const { imported, skipped } = await importJobs(exported);
    expect(imported).toBe(0);
    expect(skipped).toBe(1);
  });
});
