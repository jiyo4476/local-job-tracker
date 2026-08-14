import { describe, expect, it } from 'vitest';
import { extensionMessageSchema, extensionResponseSchema } from './messages';

describe('extension message contracts', () => {
  it('accepts save requests with a job draft', () => {
    expect(
      extensionMessageSchema.parse({
        type: 'SAVE_JOB_LOCAL',
        draft: {
          source_platform: 'indeed',
          external_job_id: 'abc123',
          company_name: 'Acme',
          job_title: 'Software Engineer',
          job_link: 'https://example.com/jobs/abc123',
        },
      }),
    ).toMatchObject({ type: 'SAVE_JOB_LOCAL' });
  });

  it('accepts a local save result response', () => {
    expect(
      extensionResponseSchema.parse({
        type: 'SAVE_JOB_LOCAL_RESULT',
        ok: true,
        payload: {
          source_platform: 'indeed',
          external_job_id: 'abc123',
          company_name: 'Acme',
          job_title: 'Software Engineer',
          job_link: 'https://example.com/jobs/abc123',
        },
        result: { action: 'created', id: 1 },
      }),
    ).toMatchObject({
      type: 'SAVE_JOB_LOCAL_RESULT',
      result: { action: 'created', id: 1 },
    });
  });

  it('strips unknown fields from public settings updates', () => {
    expect(
      extensionMessageSchema.parse({
        type: 'SAVE_SETTINGS',
        settings: {
          autoDetect: false,
          unknownField: 'ignored',
        },
      }),
    ).toEqual({
      type: 'SAVE_SETTINGS',
      settings: {
        autoDetect: false,
      },
    });
  });

  it('returns only autoDetect through public settings responses', () => {
    expect(
      extensionResponseSchema.parse({
        type: 'GET_SETTINGS_RESULT',
        ok: true,
        settings: {
          autoDetect: false,
        },
      }),
    ).toEqual({
      type: 'GET_SETTINGS_RESULT',
      ok: true,
      settings: {
        autoDetect: false,
      },
    });
  });

  it('rejects unexpected message types at runtime boundaries', () => {
    expect(() =>
      extensionMessageSchema.parse({ type: 'DELETE_EVERYTHING' }),
    ).toThrow();
  });

  it('accepts structured extension errors', () => {
    expect(
      extensionResponseSchema.parse({
        type: 'ERROR',
        ok: false,
        error: {
          code: 'PAYLOAD_INVALID',
          message: 'Review the required fields before saving this job.',
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      extensionResponseSchema.parse({
        type: 'ERROR',
        ok: false,
        error: {
          code: 'POPUP_CONTEXT_STALE',
          message: 'The source page changed.',
        },
      }),
    ).toMatchObject({ error: { code: 'POPUP_CONTEXT_STALE' } });
  });

  it('validates popup draft storage requests and responses', () => {
    const context = { tabId: 42, url: 'https://example.com/jobs/42' };
    const values = {
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
    };

    expect(
      extensionMessageSchema.parse({
        type: 'SAVE_POPUP_DRAFT',
        context,
        values,
      }),
    ).toEqual({ type: 'SAVE_POPUP_DRAFT', context, values });
    expect(
      extensionResponseSchema.parse({
        type: 'GET_POPUP_DRAFT_RESULT',
        ok: true,
        values,
      }),
    ).toEqual({ type: 'GET_POPUP_DRAFT_RESULT', ok: true, values });
  });
});
