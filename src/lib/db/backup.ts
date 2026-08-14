import { z } from 'zod';

import { extensionSettingsSchema, getSettings } from '../settings';
import { exportAllJobs, importLocalDataset } from './jobsRepo';
import { jobContactSchema, storedJobSchema } from './schema';

export const BACKUP_FORMAT = 'job-tracker-backup';
export const BACKUP_VERSION = 2;
export const MAX_BACKUP_JOBS = 100_000;

const backupJobSchema = storedJobSchema
  .extend({
    contacts: z.array(jobContactSchema.strict()).max(100),
  })
  .strict();
const backupSettingsSchema = extensionSettingsSchema.strict();
const jobsSchema = z.array(backupJobSchema).max(MAX_BACKUP_JOBS);

function rejectDuplicateJobs(
  jobs: z.infer<typeof jobsSchema>,
  context: z.RefinementCtx,
): void {
  const ids = new Set<number>();
  const identities = new Set<string>();
  jobs.forEach((job, index) => {
    if (job.id !== undefined && ids.has(job.id)) {
      context.addIssue({
        code: 'custom',
        path: ['jobs', index, 'id'],
        message: `Duplicate job id ${String(job.id)}.`,
      });
    }
    if (job.id !== undefined) ids.add(job.id);
    const identity = `${job.source_platform}\u0000${job.external_job_id}`;
    if (identities.has(identity)) {
      context.addIssue({
        code: 'custom',
        path: ['jobs', index, 'external_job_id'],
        message: 'Duplicate platform and external job id.',
      });
    }
    identities.add(identity);
  });
}

const backupSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(BACKUP_VERSION),
    exported_at: z.string().datetime(),
    jobs: jobsSchema,
    settings: backupSettingsSchema,
  })
  .strict()
  .superRefine(({ jobs }, context) => {
    rejectDuplicateJobs(jobs, context);
  });

const legacyBackupSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(1),
    exported_at: z.string().datetime(),
    jobs: jobsSchema,
  })
  .strict()
  .superRefine(({ jobs }, context) => {
    rejectDuplicateJobs(jobs, context);
  });

export type JobTrackerBackup = z.infer<typeof backupSchema>;
export type ImportMode = 'merge' | 'replace';

export async function createBackup(): Promise<JobTrackerBackup> {
  const [jobs, settings] = await Promise.all([exportAllJobs(), getSettings()]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    jobs,
    settings,
  };
}

export function serializeBackup(backup: JobTrackerBackup): string {
  return JSON.stringify(backupSchema.parse(backup), null, 2);
}

export function parseBackupJson(value: string): JobTrackerBackup {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  const parsed = backupSchema.safeParse(decoded);
  if (!parsed.success) {
    const legacy = legacyBackupSchema.safeParse(decoded);
    if (legacy.success) {
      return {
        ...legacy.data,
        version: BACKUP_VERSION,
        settings: extensionSettingsSchema.parse({}),
      };
    }
  }
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const location = first?.path.length ? ` at ${first.path.join('.')}` : '';
    throw new Error(
      `Invalid backup${location}: ${first?.message ?? 'schema validation failed'}`,
    );
  }
  return parsed.data;
}

export async function restoreBackup(
  backup: JobTrackerBackup,
  mode: ImportMode,
): Promise<{ imported: number; skipped: number }> {
  const validated = backupSchema.parse(backup);
  return importLocalDataset(validated.jobs, validated.settings, mode);
}
