import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb, resetDbForTests } from './schema';
import {
  addJobContact,
  exportAllJobs,
  getJob,
  importJobs,
  importLocalDataset,
  listJobs,
  removeJobContact,
  softDeleteJob,
  updateJob,
  updateJobContact,
  upsertJob,
} from './jobsRepo';
import type { NewJobInput } from './schema';
import { getSettings, saveSettings } from '../settings';

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

  it('preserves local contacts across an exact capture update', async () => {
    const first = await upsertJob(baseInput());
    await updateJob(first.id, {
      contacts: [
        {
          id: '123e4567-e89b-42d3-a456-426614174000',
          name: 'Ada Recruiter',
          email: 'ada@example.com',
          created_at: '2026-08-14T12:00:00.000Z',
        },
      ],
    });

    await upsertJob(baseInput({ job_title: 'Updated title' }));

    expect((await getJob(first.id))?.contacts).toEqual([
      expect.objectContaining({ name: 'Ada Recruiter' }),
    ]);
  });

  it('provides stable contact create, update, and remove helpers', async () => {
    const job = await upsertJob(baseInput());
    const contact = await addJobContact(job.id, {
      name: 'Ada Recruiter',
      linkedin_url: 'https://www.linkedin.com/in/ada',
    });
    expect(contact.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(contact.created_at).toBeTruthy();

    const updated = await updateJobContact(job.id, contact.id, {
      title: 'Senior Recruiter',
    });
    expect(updated.title).toBe('Senior Recruiter');

    await removeJobContact(job.id, contact.id);
    expect((await getJob(job.id))?.contacts).toEqual([]);
  });

  it('preserves both contacts added concurrently', async () => {
    const job = await upsertJob(baseInput());

    await Promise.all([
      addJobContact(job.id, { name: 'Ada Recruiter' }),
      addJobContact(job.id, { name: 'Grace Hiring Manager' }),
    ]);

    expect(
      (await getJob(job.id))?.contacts.map(({ name }) => name).sort(),
    ).toEqual(['Ada Recruiter', 'Grace Hiring Manager']);
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

  it('applies normalized cross-platform fuzzy dedup during merge', async () => {
    await upsertJob(baseInput());
    const [existing] = await exportAllJobs();
    expect(existing).toBeDefined();
    if (!existing) throw new Error('Expected seeded job.');
    const candidate = {
      ...existing,
      id: 99,
      source_platform: 'linkedin' as const,
      external_job_id: 'linkedin-copy',
      company_name: ' example analytics ',
      job_title: 'SENIOR SOFTWARE ENGINEER',
    };

    expect(await importJobs([candidate])).toEqual({ imported: 0, skipped: 1 });
    expect(await listJobs()).toHaveLength(1);
  });

  it('losslessly replaces distinct backup identities that share company and title', async () => {
    await upsertJob(baseInput());
    const [first] = await exportAllJobs();
    expect(first).toBeDefined();
    if (!first) throw new Error('Expected seeded job.');
    const second = {
      ...first,
      id: 2,
      source_platform: 'linkedin' as const,
      external_job_id: 'mirror',
    };

    expect(await importJobs([first, second], 'replace')).toEqual({
      imported: 2,
      skipped: 0,
    });
    expect(first.id).toBeDefined();
    if (first.id === undefined) throw new Error('Expected persisted job id.');
    expect(await getJob(first.id)).toEqual(first);
    expect(await getJob(second.id)).toEqual(second);
  });

  it('treats the exact seven-day fuzzy boundary as a duplicate', async () => {
    const now = new Date('2026-08-14T12:00:00.000Z');
    const boundary = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const first = await upsertJob(baseInput());
    await getDb().jobs.update(first.id, { created_at: boundary.toISOString() });
    const [stored] = await exportAllJobs();
    expect(stored).toBeDefined();
    if (!stored) throw new Error('Expected seeded job.');
    await getJob(first.id);

    const candidate = {
      ...stored,
      id: 2,
      source_platform: 'linkedin' as const,
      external_job_id: 'boundary-copy',
    };
    const originalNow = Date.now;
    Date.now = () => now.getTime();
    try {
      expect(await importJobs([candidate])).toEqual({
        imported: 0,
        skipped: 1,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  it('atomically replaces jobs and settings while merge retains settings', async () => {
    await upsertJob(baseInput());
    const exported = await exportAllJobs();
    await saveSettings({ autoDetect: false });

    await importLocalDataset(
      exported,
      { autoDetect: true, autoDownloadTemplates: false },
      'merge',
    );
    expect(await getSettings()).toEqual({
      autoDetect: false,
      autoDownloadTemplates: false,
    });

    await importLocalDataset(
      exported,
      { autoDetect: true, autoDownloadTemplates: false },
      'replace',
    );
    expect(await getSettings()).toEqual({
      autoDetect: true,
      autoDownloadTemplates: false,
    });
    expect(await listJobs()).toHaveLength(1);
  });
});
