import { z } from 'zod';

import { extensionSettingsSchema, getSettings } from '../settings';
import { exportAllJobs, importLocalDataset } from './jobsRepo';
import { jobContactSchema, storedJobSchema } from './schema';
import { listSiteTemplates } from '../templates/repo';
import { MAX_SITE_TEMPLATES, siteTemplateSchema } from '../templates/schema';

export const BACKUP_FORMAT = 'job-tracker-backup';
export const BACKUP_VERSION = 3;
export const MAX_BACKUP_JOBS = 100_000;

const backupJobSchema = storedJobSchema
  .extend({
    contacts: z.array(jobContactSchema.strict()).max(100),
  })
  .strict();
const backupSettingsSchema = extensionSettingsSchema.strict();
const jobsSchema = z.array(backupJobSchema).max(MAX_BACKUP_JOBS);
const templatesSchema = z
  .array(siteTemplateSchema)
  .max(MAX_SITE_TEMPLATES)
  .superRefine((templates, context) => {
    const ids = new Set<string>();
    templates.forEach((template, index) => {
      if (ids.has(template.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Duplicate template id ${template.id}.`,
        });
      }
      ids.add(template.id);
    });
  });

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
    templates: templatesSchema,
  })
  .strict()
  .superRefine(({ jobs }, context) => {
    rejectDuplicateJobs(jobs, context);
  });

const versionTwoBackupSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(2),
    exported_at: z.string().datetime(),
    jobs: jobsSchema,
    settings: backupSettingsSchema,
  })
  .strict()
  .superRefine(({ jobs }, context) => {
    rejectDuplicateJobs(jobs, context);
  });

const versionOneBackupSchema = z
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
  const [jobs, settings, templates] = await Promise.all([
    exportAllJobs(),
    getSettings(),
    listSiteTemplates(),
  ]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    jobs,
    settings,
    templates,
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
    const versionTwo = versionTwoBackupSchema.safeParse(decoded);
    if (versionTwo.success) {
      return {
        ...versionTwo.data,
        version: BACKUP_VERSION,
        templates: [],
      };
    }
    const versionOne = versionOneBackupSchema.safeParse(decoded);
    if (versionOne.success) {
      return {
        ...versionOne.data,
        version: BACKUP_VERSION,
        settings: extensionSettingsSchema.parse({}),
        templates: [],
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
  return importLocalDataset(
    validated.jobs,
    validated.settings,
    mode,
    validated.templates,
  );
}
