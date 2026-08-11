import {
  DEFAULT_INTERVIEW_STAGE,
  getDb,
  interviewStageSchema,
  newJobInputSchema,
  storedJobSchema,
  type InterviewStage,
  type NewJobInput,
  type StoredJob,
} from './schema';

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
    const exact = await db.jobs
      .where('[source_platform+external_job_id]')
      .equals([parsed.source_platform, parsed.external_job_id])
      .first();

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

    const windowStart = new Date(
      Date.now() - FUZZY_DEDUP_WINDOW_MS,
    ).toISOString();
    const normalizedCompany = normalizeForMatch(parsed.company_name);
    const normalizedTitle = normalizeForMatch(parsed.job_title);

    const recentCandidates = await db.jobs
      .where('created_at')
      .aboveOrEqual(windowStart)
      .filter((job) => job.is_active)
      .toArray();

    const fuzzyMatch = recentCandidates.find(
      (job) =>
        normalizeForMatch(job.company_name) === normalizedCompany &&
        normalizeForMatch(job.job_title) === normalizedTitle,
    );

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
  patch: Partial<
    Pick<
      StoredJob,
      | 'interview_stage'
      | 'priority'
      | 'notes'
      | 'resume_version'
      | 'job_title'
      | 'company_name'
    >
  >,
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
  return db.transaction('rw', db.jobs, async () => {
    if (mode === 'replace') {
      await db.jobs.clear();
    }
    let imported = 0;
    let skipped = 0;
    for (const raw of jobs) {
      const parsed = storedJobSchema.omit({ id: true }).safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const exact = await db.jobs
        .where('[source_platform+external_job_id]')
        .equals([parsed.data.source_platform, parsed.data.external_job_id])
        .first();
      if (exact) {
        skipped += 1;
        continue;
      }
      await db.jobs.add(parsed.data);
      imported += 1;
    }
    return { imported, skipped };
  });
}
