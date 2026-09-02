import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

import { JobTrackerDatabase } from './schema';

describe('JobTrackerDatabase migrations', () => {
  it('upgrades version 1 jobs with contacts and creates settings and template storage', async () => {
    const name = 'migration-v1-to-v2';
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      jobs: '++id, &[source_platform+external_job_id], company_name, job_title, interview_stage, source_platform, is_active, created_at',
    });
    await legacy.table('jobs').add({
      source_platform: 'indeed',
      external_job_id: 'legacy-1',
      company_name: 'Legacy Co',
      job_title: 'Engineer',
      job_link: 'https://example.com/jobs/legacy-1',
      interview_stage: 'not_applied',
      priority: 0,
      notes: '',
      is_active: true,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    legacy.close();

    const upgraded = new JobTrackerDatabase(name);
    await upgraded.open();
    expect((await upgraded.jobs.toArray())[0]?.contacts).toEqual([]);
    await upgraded.settings.put({ key: 'extension', autoDetect: false });
    await expect(upgraded.settings.get('extension')).resolves.toMatchObject({
      autoDetect: false,
    });
    await upgraded.templates.put({
      id: '123e4567-e89b-42d3-a456-426614174000',
      name: 'Legacy migration template',
      hostname: 'jobs.example.com',
      path_pattern: '/jobs/*',
      enabled: true,
      priority: 50,
      rules: [
        {
          field: 'job_title',
          selector: 'h1',
          attribute: 'text',
          multiple: false,
          transforms: ['trim'],
        },
      ],
      created_at: '2026-08-14T00:00:00.000Z',
      updated_at: '2026-08-14T00:00:00.000Z',
    });
    await expect(upgraded.templates.count()).resolves.toBe(1);
    upgraded.close();
    await Dexie.delete(name);
  });
});
