import Dexie, { type EntityTable } from 'dexie';
import { z } from 'zod';

import { httpUrlSchema, jobDraftSchema, scrapePayloadSchema } from '../schemas';

export const interviewStageSchema = z.enum([
  'not_applied',
  'applied',
  'phone_screen',
  'technical_screen',
  'onsite',
  'offer_received',
  'rejected',
  'withdrawn',
]);

export type InterviewStage = z.infer<typeof interviewStageSchema>;

export const DEFAULT_INTERVIEW_STAGE: InterviewStage = 'not_applied';

export const jobContactSchema = z.object({
  id: z
    .string()
    .uuid()
    .default(() => crypto.randomUUID()),
  name: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(50).optional(),
  linkedin_url: httpUrlSchema.optional(),
  role: z.string().max(200).optional(),
  contacted_at: z.string().date().optional(),
  notes: z.string().max(10_000).optional(),
  created_at: z
    .string()
    .datetime()
    .default(() => new Date().toISOString()),
});

export type JobContact = z.infer<typeof jobContactSchema>;

export interface StoredSettings {
  key: 'extension';
  autoDetect: boolean;
}

/**
 * A stored job record: the scrape payload fields plus the tracker-lifecycle
 * fields that used to live in the backend's `jobs`/`user_job_state` tables.
 * There is exactly one local owner, so no separate overlay table is needed.
 */
export const storedJobSchema = scrapePayloadSchema
  .omit({ external_job_id: true })
  .extend({
    id: z.number().int().positive().optional(),
    external_job_id: z.string().min(1),
    interview_stage: interviewStageSchema.default(DEFAULT_INTERVIEW_STAGE),
    priority: z.number().int().min(0).max(5).default(0),
    notes: z.string().max(10_000).default(''),
    resume_version: z.string().max(200).optional(),
    contacts: z.array(jobContactSchema).max(100).default([]),
    is_active: z.boolean().default(true),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    deleted_at: z.string().datetime().optional(),
  });

export type StoredJob = z.infer<typeof storedJobSchema>;

/** Fields accepted when saving a freshly captured or manually entered job. */
export const newJobInputSchema = jobDraftSchema.extend({
  external_job_id: z.string().min(1),
  company_name: z.string().min(1),
  job_title: z.string().min(1),
  job_link: z.string().url(),
});

export type NewJobInput = z.infer<typeof newJobInputSchema>;

export class JobTrackerDatabase extends Dexie {
  jobs!: EntityTable<StoredJob, 'id'>;
  settings!: EntityTable<StoredSettings, 'key'>;

  constructor(name = 'job-tracker') {
    super(name);
    this.version(1).stores({
      // `id` auto-increment primary key; compound index for exact-identity
      // dedup; single-field indexes for the filters the Jobs List view needs.
      jobs: '++id, &[source_platform+external_job_id], company_name, job_title, interview_stage, source_platform, is_active, created_at',
    });
    this.version(2)
      .stores({
        jobs: '++id, &[source_platform+external_job_id], company_name, job_title, interview_stage, source_platform, is_active, created_at',
        settings: '&key',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table<StoredJob, number>('jobs')
          .toCollection()
          .modify((job) => {
            job.contacts ??= [];
          });
      });
  }
}

let dbInstance: JobTrackerDatabase | undefined;

export function getDb(): JobTrackerDatabase {
  dbInstance ??= new JobTrackerDatabase();
  return dbInstance;
}

/** Test-only: swap in a fresh, isolated database instance. */
export function resetDbForTests(name?: string): JobTrackerDatabase {
  dbInstance?.close();
  dbInstance = new JobTrackerDatabase(name);
  return dbInstance;
}
