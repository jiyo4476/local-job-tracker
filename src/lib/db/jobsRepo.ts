import {
  DEFAULT_INTERVIEW_STAGE,
  getDb,
  interviewStageSchema,
  jobContactSchema,
  newJobInputSchema,
  storedJobSchema,
  type InterviewStage,
  type JobContact,
  type NewJobInput,
  type StoredJob,
} from './schema';
import { extensionSettingsSchema, type ExtensionSettings } from '../settings';
import { siteTemplateSchema, type SiteTemplate } from '../templates/schema';

const FUZZY_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type SaveJobAction = 'created' | 'updated' | 'duplicate_skipped';

export interface SaveJobResult {
  action: SaveJobAction;
  id: number;
}

export interface JobListFilters {
  interview_stage?: InterviewStage;
  source_platform?: StoredJob['source_platform'];
  is_remote?: boolean;
  includeInactive?: boolean;
  skill?: string;
  query?: string;
}

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

async function findDuplicate(
  candidate: Pick<
    StoredJob,
    'source_platform' | 'external_job_id' | 'company_name' | 'job_title'
  >,
  referenceTime = Date.now(),
): Promise<{ kind: 'exact' | 'fuzzy'; job: StoredJob } | undefined> {
  const jobs = getDb().jobs;
  const exact = await jobs
    .where('[source_platform+external_job_id]')
    .equals([candidate.source_platform, candidate.external_job_id])
    .first();
  if (exact) return { kind: 'exact', job: exact };

  const windowStart = new Date(
    referenceTime - FUZZY_DEDUP_WINDOW_MS,
  ).toISOString();
  const normalizedCompany = normalizeForMatch(candidate.company_name);
  const normalizedTitle = normalizeForMatch(candidate.job_title);
  const fuzzy = await jobs
    .where('created_at')
    .aboveOrEqual(windowStart)
    .filter(
      (job) =>
        job.is_active &&
        normalizeForMatch(job.company_name) === normalizedCompany &&
        normalizeForMatch(job.job_title) === normalizedTitle,
    )
    .first();
  return fuzzy ? { kind: 'fuzzy', job: fuzzy } : undefined;
}

/**
 * Saves a captured or manually entered job, applying the same two-layer
 * dedup rule the backend previously enforced in `POST /api/scrape`:
 * exact `(source_platform, external_job_id)` identity first, then a bounded
 * fuzzy `(company_name, job_title)` match within a 7-day window.
 */
export async function upsertJob(input: NewJobInput): Promise<SaveJobResult> {
  const parsed = newJobInputSchema.parse(input);
  const db = getDb();

  return db.transaction('rw', db.jobs, async () => {
    const duplicate = await findDuplicate(parsed);
    const exact = duplicate?.kind === 'exact' ? duplicate.job : undefined;

    if (exact?.id !== undefined) {
      const updated: StoredJob = storedJobSchema.parse({
        ...exact,
        ...parsed,
        id: exact.id,
        interview_stage: exact.interview_stage,
        priority: exact.priority,
        notes: exact.notes,
        resume_version: exact.resume_version,
        is_active: true,
        deleted_at: undefined,
        created_at: exact.created_at,
        updated_at: nowIso(),
      });
      await db.jobs.put(updated);
      return { action: 'updated', id: exact.id };
    }

    const fuzzyMatch = duplicate?.kind === 'fuzzy' ? duplicate.job : undefined;

    if (fuzzyMatch?.id !== undefined) {
      return { action: 'duplicate_skipped', id: fuzzyMatch.id };
    }

    const timestamp = nowIso();
    const record: StoredJob = storedJobSchema.parse({
      ...parsed,
      interview_stage: DEFAULT_INTERVIEW_STAGE,
      priority: 0,
      notes: '',
      is_active: true,
      created_at: timestamp,
      updated_at: timestamp,
    });
    // Dexie types the PK as `StoredJob['id']` (`number | undefined`) because
    // `id` is optional pre-insert; `add()` always resolves the real key.
    const id = await db.jobs.add(record);
    if (id === undefined) {
      throw new Error('Dexie did not return an id for the new job.');
    }
    return { action: 'created', id };
  });
}

export async function getJob(id: number): Promise<StoredJob | undefined> {
  return getDb().jobs.get(id);
}

export async function listJobs(
  filters: JobListFilters = {},
): Promise<StoredJob[]> {
  const db = getDb();
  let jobs = await db.jobs.toArray();

  if (!filters.includeInactive) {
    jobs = jobs.filter((job) => job.is_active);
  }
  if (filters.interview_stage) {
    jobs = jobs.filter(
      (job) => job.interview_stage === filters.interview_stage,
    );
  }
  if (filters.source_platform) {
    jobs = jobs.filter(
      (job) => job.source_platform === filters.source_platform,
    );
  }
  if (filters.is_remote !== undefined) {
    jobs = jobs.filter((job) => job.is_remote === filters.is_remote);
  }
  if (filters.skill) {
    const wanted = normalizeForMatch(filters.skill);
    jobs = jobs.filter((job) =>
      (job.skills ?? []).some((skill) => normalizeForMatch(skill) === wanted),
    );
  }
  if (filters.query) {
    const wanted = normalizeForMatch(filters.query);
    jobs = jobs.filter(
      (job) =>
        normalizeForMatch(job.job_title).includes(wanted) ||
        normalizeForMatch(job.company_name).includes(wanted),
    );
  }

  return jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function updateJob(
  id: number,
  patch: Partial<Omit<StoredJob, 'id' | 'created_at' | 'updated_at'>>,
): Promise<StoredJob> {
  const db = getDb();
  return db.transaction('rw', db.jobs, async () => {
    const existing = await db.jobs.get(id);
    if (!existing) throw new Error(`No job with id ${String(id)}.`);
    if (patch.interview_stage !== undefined) {
      interviewStageSchema.parse(patch.interview_stage);
    }
    const updated = storedJobSchema.parse({
      ...existing,
      ...patch,
      id,
      updated_at: nowIso(),
    });
    await db.jobs.put(updated);
    return updated;
  });
}

export async function addJobContact(
  jobId: number,
  input: Omit<JobContact, 'id' | 'created_at'> &
    Partial<Pick<JobContact, 'id' | 'created_at'>>,
): Promise<JobContact> {
  const contact = jobContactSchema.parse(input);
  return mutateJobContacts(jobId, (contacts) => ({
    contacts: [...contacts, contact],
    result: contact,
  }));
}

export async function updateJobContact(
  jobId: number,
  contactId: string,
  patch: Partial<Omit<JobContact, 'id' | 'created_at'>>,
): Promise<JobContact> {
  return mutateJobContacts(jobId, (contacts) => {
    const index = contacts.findIndex((contact) => contact.id === contactId);
    if (index < 0) throw new Error(`No contact with id ${contactId}.`);
    const contact = jobContactSchema.parse({ ...contacts[index], ...patch });
    const updatedContacts = [...contacts];
    updatedContacts[index] = contact;
    return { contacts: updatedContacts, result: contact };
  });
}

export async function removeJobContact(
  jobId: number,
  contactId: string,
): Promise<void> {
  await mutateJobContacts(jobId, (contacts) => {
    const remaining = contacts.filter((contact) => contact.id !== contactId);
    if (remaining.length === contacts.length) {
      throw new Error(`No contact with id ${contactId}.`);
    }
    return { contacts: remaining, result: undefined };
  });
}

async function mutateJobContacts<Result>(
  jobId: number,
  mutation: (contacts: JobContact[]) => {
    contacts: JobContact[];
    result: Result;
  },
): Promise<Result> {
  const db = getDb();
  return db.transaction('rw', db.jobs, async () => {
    const job = await db.jobs.get(jobId);
    if (!job) throw new Error(`No job with id ${String(jobId)}.`);
    const { contacts, result } = mutation(job.contacts);
    const updated = storedJobSchema.parse({
      ...job,
      contacts,
      updated_at: nowIso(),
    });
    await db.jobs.put(updated);
    return result;
  });
}

export async function softDeleteJob(id: number): Promise<void> {
  const db = getDb();
  const existing = await db.jobs.get(id);
  if (!existing) return;
  await db.jobs.put(
    storedJobSchema.parse({
      ...existing,
      id,
      is_active: false,
      deleted_at: nowIso(),
      updated_at: nowIso(),
    }),
  );
}

export async function restoreJob(id: number): Promise<void> {
  const db = getDb();
  const existing = await db.jobs.get(id);
  if (!existing) return;
  await db.jobs.put(
    storedJobSchema.parse({
      ...existing,
      id,
      is_active: true,
      deleted_at: undefined,
      updated_at: nowIso(),
    }),
  );
}

export async function exportAllJobs(): Promise<StoredJob[]> {
  return getDb().jobs.toArray();
}

export async function importJobs(
  jobs: StoredJob[],
  mode: 'replace' | 'merge' = 'merge',
): Promise<{ imported: number; skipped: number }> {
  const db = getDb();
  const parsedJobs = jobs.map((job) => storedJobSchema.parse(job));
  return db.transaction('rw', db.jobs, () =>
    importParsedJobs(parsedJobs, mode),
  );
}

export async function importLocalDataset(
  jobs: StoredJob[],
  settings: ExtensionSettings,
  mode: 'replace' | 'merge' = 'merge',
  templates: SiteTemplate[] = [],
): Promise<{ imported: number; skipped: number }> {
  const parsedJobs = jobs.map((job) => storedJobSchema.parse(job));
  const parsedSettings = extensionSettingsSchema.parse(settings);
  const parsedTemplates = templates.map((template) =>
    siteTemplateSchema.parse(template),
  );
  const db = getDb();
  return db.transaction('rw', db.jobs, db.settings, db.templates, async () => {
    const result = await importParsedJobs(parsedJobs, mode);
    if (mode === 'replace') {
      await db.settings.put({ key: 'extension', ...parsedSettings });
      await db.templates.clear();
      await db.templates.bulkAdd(parsedTemplates);
    } else {
      for (const template of parsedTemplates) {
        if (!(await db.templates.get(template.id))) {
          await db.templates.add(template);
        }
      }
    }
    return result;
  });
}

async function importParsedJobs(
  parsedJobs: StoredJob[],
  mode: 'replace' | 'merge',
): Promise<{ imported: number; skipped: number }> {
  const jobs = getDb().jobs;
  if (mode === 'replace') {
    await jobs.clear();
    await jobs.bulkAdd(parsedJobs);
    return { imported: parsedJobs.length, skipped: 0 };
  }

  let imported = 0;
  let skipped = 0;
  for (const parsed of parsedJobs) {
    if (await findDuplicate(parsed)) {
      skipped += 1;
      continue;
    }
    // Imported primary keys are meaningful only for a full replacement.
    const withoutId = { ...parsed };
    delete withoutId.id;
    await jobs.add(withoutId);
    imported += 1;
  }
  return { imported, skipped };
}
