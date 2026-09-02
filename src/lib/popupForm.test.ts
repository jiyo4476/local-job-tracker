import { describe, expect, it } from 'vitest';
import {
  applyCandidateSelection,
  applyExtractionPreservingTaxonomy,
  CANDIDATE_SOURCE_LABELS,
  draftToFormValues,
  emptyFormValues,
  firstInvalidField,
  formatCandidateValue,
  formValuesToDraft,
  validateFormValues,
  type PopupFormValues,
} from './popupForm';
import type { JobDraft } from './schemas';

const fullDraft: JobDraft = {
  source_platform: 'indeed',
  external_job_id: 'abc123',
  company_name: 'Acme',
  job_title: 'Software Engineer',
  job_link: 'https://example.com/jobs/abc123',
  job_location: 'Austin, TX',
  is_remote: true,
  job_description: 'Build things.',
  date_posted: '2026-07-01',
  salary_text: '$100k-$150k',
  salary_type: 'annual',
  salary_min: 10_000_000,
  salary_max: 15_000_000,
  hourly_rate_min: 45.5,
  hourly_rate_max: 60,
  job_type: 'full_time',
  experience_level: 'senior',
  security_clearance_req: true,
  skills: ['TypeScript', 'React'],
  software: ['Figma'],
  keywords: ['remote-friendly'],
  certifications: ['AWS'],
};

describe('draftToFormValues / formValuesToDraft', () => {
  it('round-trips a full draft through the form representation', () => {
    const values = draftToFormValues(fullDraft);
    expect(values.job_title).toBe('Software Engineer');
    expect(values.skills).toBe('TypeScript, React');
    expect(values.salary_min).toBe('100000');
    expect(values.is_remote).toBe(true);

    expect(formValuesToDraft(values)).toEqual(fullDraft);
  });

  it('produces empty-string/false defaults for a blank draft', () => {
    const values = emptyFormValues();
    expect(values).toEqual<PopupFormValues>({
      job_title: '',
      company_name: '',
      job_link: '',
      source_platform: 'other',
      job_location: '',
      is_remote: false,
      job_description: '',
      external_job_id: '',
      date_posted: '',
      job_type: '',
      experience_level: '',
      security_clearance_req: false,
      salary_type: '',
      salary_min: '',
      salary_max: '',
      hourly_rate_min: '',
      hourly_rate_max: '',
      salary_text: '',
      skills: '',
      software: '',
      keywords: '',
      certifications: '',
    });
  });

  it('omits blank optional fields instead of sending empty strings', () => {
    const draft = formValuesToDraft({
      ...emptyFormValues(),
      job_title: '  Engineer  ',
      company_name: '',
    });

    expect(draft.job_title).toBe('Engineer');
    expect(draft).not.toHaveProperty('company_name');
  });

  it('splits, trims, and filters comma-separated list fields', () => {
    const draft = formValuesToDraft({
      ...emptyFormValues(),
      skills: ' TypeScript ,, React ,  ',
    });

    expect(draft.skills).toEqual(['TypeScript', 'React']);
  });

  it('parses numeric fields and drops invalid/blank ones', () => {
    const draft = formValuesToDraft({
      ...emptyFormValues(),
      salary_min: '5000',
      salary_max: '',
    });

    // salary_min/salary_max are entered as dollars and stored as cents.
    expect(draft.salary_min).toBe(500_000);
    expect(draft).not.toHaveProperty('salary_max');
  });

  it('converts dollar-denominated salary input to integer cents', () => {
    const draft = formValuesToDraft({
      ...emptyFormValues(),
      salary_min: '120000.5',
    });

    expect(draft.salary_min).toBe(12_000_050);
  });

  it('defaults source_platform to other when unset', () => {
    const draft = formValuesToDraft({
      ...emptyFormValues(),
      source_platform: '',
    });
    expect(draft.source_platform).toBe('other');
  });
});

describe('validateFormValues', () => {
  it('returns no errors for a fully valid form', () => {
    expect(validateFormValues(draftToFormValues(fullDraft))).toEqual([]);
  });

  it('flags an invalid job_link URL', () => {
    const errors = validateFormValues({
      ...emptyFormValues(),
      job_link: 'not-a-url',
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ field: 'job_link' }),
    );
  });

  it('flags a malformed date_posted', () => {
    const errors = validateFormValues({
      ...emptyFormValues(),
      date_posted: '07/01/2026',
    });
    expect(errors).toContainEqual(
      expect.objectContaining({ field: 'date_posted' }),
    );
  });

  it('flags impossible dates while accepting leap dates', () => {
    expect(
      validateFormValues({
        ...emptyFormValues(),
        date_posted: '2025-02-29',
      }),
    ).toContainEqual(expect.objectContaining({ field: 'date_posted' }));
    expect(
      validateFormValues({
        ...emptyFormValues(),
        date_posted: '2024-02-29',
      }),
    ).toEqual([]);
  });

  it('flags negative and non-numeric salary fields', () => {
    const errors = validateFormValues({
      ...emptyFormValues(),
      salary_min: '-5',
      hourly_rate_max: 'abc',
    });

    expect(errors.map((e) => e.field).sort()).toEqual([
      'hourly_rate_max',
      'salary_min',
    ]);
  });

  it('allows an empty job_link and empty numeric fields (nothing to validate)', () => {
    expect(validateFormValues(emptyFormValues())).toEqual([]);
  });

  it('flags a duplicate within one taxonomy category only', () => {
    const errors = validateFormValues({
      ...emptyFormValues(),
      skills: 'Python, python',
      keywords: 'python',
    });

    expect(errors.map((e) => e.field)).toEqual(['skills']);
  });

  it('accepts the same value in two different taxonomy categories', () => {
    const errors = validateFormValues({
      ...emptyFormValues(),
      skills: 'Microservices',
      keywords: 'microservices',
    });

    expect(errors).toEqual([]);
  });
});

describe('applyExtractionPreservingTaxonomy', () => {
  it('overwrites scalar fields but merges each taxonomy category', () => {
    const current: PopupFormValues = {
      ...emptyFormValues(),
      job_title: 'My Edited Title',
      skills: 'My Custom Skill, Python',
      software: 'Docker',
      certifications: 'CISSP',
      keywords: 'remote',
    };

    const next = applyExtractionPreservingTaxonomy(current, {
      source_platform: 'linkedin',
      job_title: 'Extracted Title',
      skills: ['python', 'CI/CD'],
      software: ['PostgreSQL'],
      keywords: ['startup'],
    });

    expect(next.job_title).toBe('Extracted Title');
    expect(next.skills).toBe('My Custom Skill, Python, CI/CD');
    expect(next.software).toBe('Docker, PostgreSQL');
    expect(next.certifications).toBe('CISSP');
    expect(next.keywords).toBe('remote, startup');
  });

  it('never moves a value between categories, even for identical names', () => {
    const current: PopupFormValues = {
      ...emptyFormValues(),
      skills: 'Microservices',
    };

    const next = applyExtractionPreservingTaxonomy(current, {
      source_platform: 'other',
      keywords: ['microservices'],
    });

    // The skill stays a skill; the keyword joins keywords. Same-name values
    // may exist in both categories at once.
    expect(next.skills).toBe('Microservices');
    expect(next.keywords).toBe('microservices');
  });
});

describe('firstInvalidField', () => {
  it('returns undefined when there are no errors', () => {
    expect(firstInvalidField([])).toBeUndefined();
  });

  it('returns the field earliest in the canonical form order, regardless of push order', () => {
    const result = firstInvalidField([
      { field: 'salary_min', message: 'bad' },
      { field: 'job_link', message: 'bad' },
    ]);
    expect(result).toBe('job_link');
  });

  it('orders certifications before keywords, matching the popup DOM layout', () => {
    const result = firstInvalidField([
      { field: 'keywords', message: 'bad' },
      { field: 'certifications', message: 'bad' },
    ]);
    expect(result).toBe('certifications');
  });
});

describe('candidate review mode', () => {
  it('labels every candidate source in human-readable text', () => {
    expect(CANDIDATE_SOURCE_LABELS.jsonld).toBe('From page data');
    expect(CANDIDATE_SOURCE_LABELS.meta).toBe('From meta tags');
    expect(CANDIDATE_SOURCE_LABELS['visible-text']).toBe('From page text');
    expect(CANDIDATE_SOURCE_LABELS.url).toBe('From URL');
    expect(CANDIDATE_SOURCE_LABELS.description).toBe('From description scan');
  });

  it('formats array, boolean, and scalar candidate values as strings', () => {
    expect(formatCandidateValue(['TypeScript', 'React'])).toBe(
      'TypeScript, React',
    );
    expect(formatCandidateValue(true)).toBe('true');
    expect(formatCandidateValue(false)).toBe('false');
    expect(formatCandidateValue(42)).toBe('42');
    expect(formatCandidateValue('Acme')).toBe('Acme');
  });

  it('applies a string candidate to a text field', () => {
    const next = applyCandidateSelection(
      emptyFormValues(),
      'job_title',
      'Chosen Title',
    );
    expect(next.job_title).toBe('Chosen Title');
  });

  it('coerces a candidate value into a boolean for checkbox-backed fields', () => {
    const next = applyCandidateSelection(emptyFormValues(), 'is_remote', true);
    expect(next.is_remote).toBe(true);
  });

  it('does not mutate the original form values object', () => {
    const original = emptyFormValues();
    const next = applyCandidateSelection(original, 'job_title', 'New Title');
    expect(original.job_title).toBe('');
    expect(next).not.toBe(original);
  });
});
