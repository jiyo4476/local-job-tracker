import { z } from 'zod';
import { type JobDraft, jobDraftSchema } from './schemas';
import { isPlainDate, PLAIN_DATE_MESSAGE } from './plainDate';
import {
  joinTagList,
  mergeTaxonomyTags,
  parseTagList,
  TAXONOMY_FIELDS,
  validateTagList,
} from './taxonomyFields';

/**
 * Every {@link JobDraft} field the popup form can edit. `extraction_confidence`
 * is derived data, not something the user edits directly, so it is excluded.
 */
export type DraftFormField = Exclude<keyof JobDraft, 'extraction_confidence'>;

const BOOLEAN_FIELDS = new Set<DraftFormField>([
  'is_remote',
  'security_clearance_req',
]);

// The four taxonomy categories are independent list fields -- see
// taxonomyFields.ts for the category copy and per-category tag operations.
const LIST_FIELDS = new Set<DraftFormField>(TAXONOMY_FIELDS);

const NUMBER_FIELDS = new Set<DraftFormField>([
  'salary_min',
  'salary_max',
  'hourly_rate_min',
  'hourly_rate_max',
]);

/**
 * All form values are plain strings (matching how DOM inputs/selects report
 * their value) except the two checkbox-backed booleans. Enum-like fields
 * (`source_platform`, `job_type`, `experience_level`, `salary_type`) are
 * stored as strings too -- an empty string means "unset" -- and are
 * validated/coerced by {@link jobDraftSchema} in {@link formValuesToDraft}.
 */
export const popupFormValuesSchema = z.object({
  job_title: z.string(),
  company_name: z.string(),
  job_link: z.string(),
  source_platform: z.string(),
  job_location: z.string(),
  is_remote: z.boolean(),
  job_description: z.string(),
  external_job_id: z.string(),
  date_posted: z.string(),
  job_type: z.string(),
  experience_level: z.string(),
  security_clearance_req: z.boolean(),
  salary_type: z.string(),
  salary_min: z.string(),
  salary_max: z.string(),
  hourly_rate_min: z.string(),
  hourly_rate_max: z.string(),
  salary_text: z.string(),
  skills: z.string(),
  software: z.string(),
  keywords: z.string(),
  certifications: z.string(),
});

export type PopupFormValues = z.infer<typeof popupFormValuesSchema>;

/** Canonical field order, matching the popup's DOM layout (common fields
 * first, then advanced fields), used to pick a single "first invalid field"
 * for focus management. */
export const FORM_FIELD_ORDER: DraftFormField[] = [
  'job_title',
  'company_name',
  'job_link',
  'source_platform',
  'job_location',
  'is_remote',
  'job_description',
  'external_job_id',
  'date_posted',
  'job_type',
  'experience_level',
  'security_clearance_req',
  'salary_type',
  'salary_min',
  'salary_max',
  'hourly_rate_min',
  'hourly_rate_max',
  'salary_text',
  'skills',
  'software',
  'certifications',
  'keywords',
];

export function emptyFormValues(): PopupFormValues {
  return draftToFormValues({ source_platform: 'other' });
}

export function draftToFormValues(draft: Partial<JobDraft>): PopupFormValues {
  return {
    job_title: draft.job_title ?? '',
    company_name: draft.company_name ?? '',
    job_link: draft.job_link ?? '',
    source_platform: draft.source_platform ?? 'other',
    job_location: draft.job_location ?? '',
    is_remote: draft.is_remote ?? false,
    job_description: draft.job_description ?? '',
    external_job_id: draft.external_job_id ?? '',
    date_posted: draft.date_posted ?? '',
    job_type: draft.job_type ?? '',
    experience_level: draft.experience_level ?? '',
    security_clearance_req: draft.security_clearance_req ?? false,
    salary_type: draft.salary_type ?? '',
    salary_min: numberToFormString(draft.salary_min),
    salary_max: numberToFormString(draft.salary_max),
    hourly_rate_min: numberToFormString(draft.hourly_rate_min),
    hourly_rate_max: numberToFormString(draft.hourly_rate_max),
    salary_text: draft.salary_text ?? '',
    skills: joinTagList(draft.skills ?? []),
    software: joinTagList(draft.software ?? []),
    keywords: joinTagList(draft.keywords ?? []),
    certifications: joinTagList(draft.certifications ?? []),
  };
}

/**
 * Applies a fresh extraction to existing form values without discarding the
 * user's taxonomy edits: scalar fields take the extracted draft's values
 * (today's re-extract behavior), while each of the four taxonomy categories
 * merges per category -- current values first, newly extracted values
 * appended, case-insensitive dedup within the category only. A value present
 * under one category is never moved to, or deduplicated against, another, so
 * the same name may deliberately live in two categories.
 */
export function applyExtractionPreservingTaxonomy(
  current: PopupFormValues,
  draft: Partial<JobDraft>,
): PopupFormValues {
  const next = draftToFormValues(draft);

  for (const field of TAXONOMY_FIELDS) {
    next[field] = joinTagList(
      mergeTaxonomyTags(parseTagList(current[field]), draft[field] ?? []),
    );
  }

  return next;
}

/**
 * Converts the popup form state into a validated {@link JobDraft}. Callers
 * should run {@link validateFormValues} first and address any errors --
 * this still throws (via `jobDraftSchema.parse`) as a defense-in-depth
 * safety net if a caller skips that step.
 */
export function formValuesToDraft(values: PopupFormValues): JobDraft {
  const draft: Record<string, unknown> = {
    source_platform: values.source_platform || 'other',
    is_remote: values.is_remote,
    security_clearance_req: values.security_clearance_req,
  };

  setStringField(draft, 'job_title', values.job_title);
  setStringField(draft, 'company_name', values.company_name);
  setStringField(draft, 'job_link', values.job_link);
  setStringField(draft, 'job_location', values.job_location);
  setStringField(draft, 'job_description', values.job_description);
  setStringField(draft, 'external_job_id', values.external_job_id);
  setStringField(draft, 'date_posted', values.date_posted);
  setStringField(draft, 'job_type', values.job_type);
  setStringField(draft, 'experience_level', values.experience_level);
  setStringField(draft, 'salary_type', values.salary_type);
  setStringField(draft, 'salary_text', values.salary_text);

  setNumberField(draft, 'salary_min', values.salary_min);
  setNumberField(draft, 'salary_max', values.salary_max);
  setNumberField(draft, 'hourly_rate_min', values.hourly_rate_min);
  setNumberField(draft, 'hourly_rate_max', values.hourly_rate_max);

  setListField(draft, 'skills', values.skills);
  setListField(draft, 'software', values.software);
  setListField(draft, 'keywords', values.keywords);
  setListField(draft, 'certifications', values.certifications);

  return jobDraftSchema.parse(draft);
}

function setStringField(
  draft: Record<string, unknown>,
  key: string,
  raw: string,
): void {
  const trimmed = raw.trim();
  if (trimmed) draft[key] = trimmed;
}

function setNumberField(
  draft: Record<string, unknown>,
  key: string,
  raw: string,
): void {
  const parsed = parseFormNumber(raw);
  if (parsed !== undefined) draft[key] = parsed;
}

function setListField(
  draft: Record<string, unknown>,
  key: string,
  raw: string,
): void {
  const list = parseTagList(raw);
  if (list.length) draft[key] = list;
}

function parseFormNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberToFormString(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

// --- validation ------------------------------------------------------------

export interface FieldError {
  field: DraftFormField;
  message: string;
}

export function validateFormValues(values: PopupFormValues): FieldError[] {
  const errors: FieldError[] = [];

  const link = values.job_link.trim();
  if (link && !isValidUrl(link)) {
    errors.push({
      field: 'job_link',
      message: 'Enter a valid URL, including https://.',
    });
  }

  const datePosted = values.date_posted.trim();
  if (datePosted && !isPlainDate(datePosted)) {
    errors.push({
      field: 'date_posted',
      message: PLAIN_DATE_MESSAGE,
    });
  }

  const numberLabels: Partial<Record<DraftFormField, string>> = {
    salary_min: 'Minimum salary',
    salary_max: 'Maximum salary',
    hourly_rate_min: 'Minimum hourly rate',
    hourly_rate_max: 'Maximum hourly rate',
  };

  for (const field of NUMBER_FIELDS) {
    const raw = values[field];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push({
        field,
        message: `${numberLabels[field] ?? 'This field'} must be a non-negative number.`,
      });
    }
  }

  // Each taxonomy category validates independently: an over-long skill never
  // flags the software group, and a duplicate is only a duplicate within its
  // own category.
  for (const field of TAXONOMY_FIELDS) {
    const message = validateTagList(field, parseTagList(values[field]));
    if (message) errors.push({ field, message });
  }

  return errors;
}

export function firstInvalidField(
  errors: FieldError[],
): DraftFormField | undefined {
  if (errors.length === 0) return undefined;
  const invalidFields = new Set(errors.map((error) => error.field));
  return FORM_FIELD_ORDER.find((field) => invalidFields.has(field));
}

function isValidUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// --- candidate review mode ---------------------------------------------------

export type ExtractionCandidateSource =
  | 'jsonld'
  | 'dom'
  | 'meta'
  | 'visible-text'
  | 'url'
  | 'description'
  | 'template';

export const CANDIDATE_SOURCE_LABELS: Record<
  ExtractionCandidateSource,
  string
> = {
  jsonld: 'From page data',
  dom: 'From page layout',
  meta: 'From meta tags',
  'visible-text': 'From page text',
  url: 'From URL',
  description: 'From description scan',
  template: 'From site template',
};

export function formatCandidateValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.join(', ');
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function setField<K extends keyof PopupFormValues>(
  values: PopupFormValues,
  key: K,
  value: PopupFormValues[K],
): void {
  values[key] = value;
}

/**
 * Applies a chosen extraction candidate to the form state, returning a new
 * {@link PopupFormValues} object. Boolean-backed fields coerce the candidate
 * value to a boolean; every other field is formatted to its string
 * representation.
 */
export function applyCandidateSelection(
  values: PopupFormValues,
  field: DraftFormField,
  value: unknown,
): PopupFormValues {
  const next: PopupFormValues = { ...values };

  if (field === 'is_remote' || field === 'security_clearance_req') {
    setField(next, field, Boolean(value));
    return next;
  }

  setField(next, field, formatCandidateValue(value));
  return next;
}

export function isListField(field: DraftFormField): boolean {
  return LIST_FIELDS.has(field);
}

export function isBooleanField(field: DraftFormField): boolean {
  return BOOLEAN_FIELDS.has(field);
}
