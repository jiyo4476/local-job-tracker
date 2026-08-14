import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { getJob, listJobs, updateJob, upsertJob } from './jobsRepo';
import { resetDbForTests } from './schema';
import { getSettings, saveSettings } from '../settings';
import {
  createBackup,
  parseBackupJson,
  restoreBackup,
  serializeBackup,
} from './backup';

let dbName = 0;

beforeEach(() => {
  dbName += 1;
  resetDbForTests(`backup-test-${String(dbName)}`);
});

async function seed() {
  const saved = await upsertJob({
    source_platform: 'indeed',
    external_job_id: 'backup-1',
    company_name: 'Backup Co',
    job_title: 'Backup Engineer',
    job_link: 'https://example.com/jobs/backup-1',
  });
  await updateJob(saved.id, {
    notes: 'Preserve this lifecycle data.',
    contacts: [
      {
        id: '123e4567-e89b-42d3-a456-426614174000',
        name: 'Ada Recruiter',
        email: 'ada@example.com',
        created_at: '2026-08-14T12:00:00.000Z',
      },
    ],
  });
  return saved;
}

describe('full dataset backup', () => {
  it('round-trips the versioned JSON envelope and preserves ids', async () => {
    const saved = await seed();
    await saveSettings({ autoDetect: false });
    const backup = parseBackupJson(serializeBackup(await createBackup()));
    resetDbForTests(`backup-restore-${String(dbName)}`);

    expect(await restoreBackup(backup, 'replace')).toEqual({
      imported: 1,
      skipped: 0,
    });
    expect((await getJob(saved.id))?.notes).toBe(
      'Preserve this lifecycle data.',
    );
    expect((await getJob(saved.id))?.contacts[0]?.name).toBe('Ada Recruiter');
    expect(await getSettings()).toEqual({ autoDetect: false });
  });

  it('rejects malformed records before replace can erase local data', async () => {
    await seed();
    const invalid = JSON.stringify({
      format: 'job-tracker-backup',
      version: 1,
      exported_at: new Date().toISOString(),
      jobs: [{ company_name: 'Incomplete' }],
    });

    expect(() => parseBackupJson(invalid)).toThrow('Invalid backup');
    expect(await listJobs()).toHaveLength(1);
  });

  it('rejects unknown future versions', () => {
    expect(() =>
      parseBackupJson(
        JSON.stringify({
          format: 'job-tracker-backup',
          version: 999,
          exported_at: new Date().toISOString(),
          jobs: [],
        }),
      ),
    ).toThrow('Invalid backup');
  });

  it('migrates a version 1 jobs-only backup with default settings', async () => {
    await seed();
    const current = await createBackup();
    const migrated = parseBackupJson(
      JSON.stringify({
        format: current.format,
        version: 1,
        exported_at: current.exported_at,
        jobs: current.jobs,
      }),
    );
    expect(migrated.version).toBe(2);
    expect(migrated.settings).toEqual({ autoDetect: true });
  });

  it('rejects unknown envelope fields', () => {
    expect(() =>
      parseBackupJson(
        JSON.stringify({
          format: 'job-tracker-backup',
          version: 1,
          exported_at: new Date().toISOString(),
          jobs: [],
          unexpected: true,
        }),
      ),
    ).toThrow('Invalid backup');
  });

  it('rejects unknown nested job, contact, and settings fields', async () => {
    await seed();
    const backup = await createBackup();
    const job = backup.jobs[0];
    expect(job).toBeDefined();
    if (!job) throw new Error('Expected seeded job.');

    for (const invalid of [
      { ...backup, jobs: [{ ...job, unknown_job_field: true }] },
      {
        ...backup,
        jobs: [
          {
            ...job,
            contacts: [{ ...job.contacts[0], unknown_contact_field: true }],
          },
        ],
      },
      { ...backup, settings: { ...backup.settings, unknown_setting: true } },
    ]) {
      expect(() => parseBackupJson(JSON.stringify(invalid))).toThrow(
        'Invalid backup',
      );
    }
  });

  it('rejects duplicate identities within an incoming backup', async () => {
    await seed();
    const backup = await createBackup();
    const first = backup.jobs[0];
    expect(first).toBeDefined();
    expect(() =>
      parseBackupJson(
        JSON.stringify({
          ...backup,
          jobs: [first, { ...first, id: 999 }],
        }),
      ),
    ).toThrow('Duplicate platform and external job id');
  });

  it('merges without overwriting an existing identity', async () => {
    await seed();
    const backup = await createBackup();
    expect(await restoreBackup(backup, 'merge')).toEqual({
      imported: 0,
      skipped: 1,
    });
  });
});
