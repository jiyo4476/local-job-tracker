import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html';
import { navigate } from '../router';
import { TagField } from '../components/TagField';
import { getJob, updateJob, upsertJob } from '../../lib/db/jobsRepo';
import { buildScrapePayload } from '../../lib/payload';
import {
  draftToFormValues,
  emptyFormValues,
  formValuesToDraft,
  validateFormValues,
  type DraftFormField,
  type FieldError,
  type PopupFormValues,
} from '../../lib/popupForm';
import {
  apiSourcePlatformSchema,
  experienceLevelSchema,
  jobTypeSchema,
  salaryTypeSchema,
} from '../../lib/schemas';
import {
  joinTagList,
  parseTagList,
  TAXONOMY_FIELDS,
  type TaxonomyField,
} from '../../lib/taxonomyFields';
import { JobFormLoadGuard } from './jobFormLoad';

interface Props {
  mode: 'new' | 'edit';
  id?: number;
}

export function JobFormView({ mode, id }: Props) {
  const [values, setValues] = useState<PopupFormValues>(emptyFormValues());
  const [loading, setLoading] = useState(mode === 'edit');
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadedId, setLoadedId] = useState<number>();
  const [retryCount, setRetryCount] = useState(0);
  const loadGuard = useRef(new JobFormLoadGuard());
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode !== 'edit') {
      loadGuard.current.invalidate();
      setValues(emptyFormValues());
      setLoading(false);
      setNotFound(false);
      setLoadError('');
      setLoadedId(undefined);
      return;
    }
    if (id === undefined) {
      setLoading(false);
      setLoadError('This edit route is missing a job ID.');
      setLoadedId(undefined);
      return;
    }
    const request = loadGuard.current.begin();
    setLoading(true);
    setNotFound(false);
    setLoadError('');
    setLoadedId(undefined);
    void (async () => {
      try {
        const job = await getJob(id);
        if (!loadGuard.current.isCurrent(request)) return;
        if (job) {
          setValues(draftToFormValues(job));
          setLoadedId(id);
        } else {
          setNotFound(true);
        }
      } catch (error) {
        if (!loadGuard.current.isCurrent(request)) return;
        setLoadError(
          error instanceof Error ? error.message : 'Could not load this job.',
        );
      } finally {
        if (loadGuard.current.isCurrent(request)) setLoading(false);
      }
    })();
    return () => {
      loadGuard.current.invalidate();
    };
  }, [mode, id, retryCount]);

  const setField = <K extends keyof PopupFormValues>(
    key: K,
    value: PopupFormValues[K],
  ) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const errorFor = (field: DraftFormField): string | undefined =>
    errors.find((error) => error.field === field)?.message;

  const backHref =
    mode === 'edit' && id !== undefined ? `#/jobs/${String(id)}` : '#/jobs';

  // A mode transition reuses the component instance; never expose prior edit
  // values while the new-job reset effect is pending.
  if (mode === 'new' && loadedId !== undefined) return html`<p>Loading…</p>`;
  if (
    mode === 'edit' &&
    (loading || loadedId !== id) &&
    !notFound &&
    !loadError
  )
    return html`<p>Loading…</p>`;
  if (loadError) {
    return html`<p role="alert">
      ${loadError}
      <button
        type="button"
        onClick=${() => {
          setRetryCount((count) => count + 1);
        }}
      >
        Retry
      </button>
      <a href="#/jobs">Back to jobs</a>
    </p>`;
  }
  if (notFound) {
    return html`<p>Job not found. <a href="#/jobs">Back to jobs</a></p>`;
  }

  const submit = async (event: Event) => {
    event.preventDefault();
    if (mode === 'edit' && loadedId !== id) {
      setStatus('Wait for the current job to finish loading.');
      return;
    }
    const foundErrors = validateFormValues(values);
    setErrors(foundErrors);
    if (foundErrors.length > 0) {
      setStatus('Fix the highlighted fields before saving.');
      return;
    }

    setSaving(true);
    setStatus('');
    try {
      const draft = formValuesToDraft(values);
      const payload = buildScrapePayload(draft);
      if (mode === 'new') {
        const result = await upsertJob(payload);
        navigate(`#/jobs/${String(result.id)}`);
        return;
      }
      if (id !== undefined) {
        await updateJob(id, payload);
        navigate(`#/jobs/${String(id)}`);
        return;
      }
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'Could not save this job.',
      );
    } finally {
      setSaving(false);
    }
  };

  return html`
    <div class="job-form-view">
      <a href=${backHref}>← Back</a>
      <h2>${mode === 'new' ? 'Add job' : 'Edit job'}</h2>
      <form onSubmit=${submit}>
        <label>
          Title
          <input
            value=${values.job_title}
            onInput=${(event: Event) => {
              setField('job_title', (event.target as HTMLInputElement).value);
            }}
          />
        </label>
        <label>
          Company
          <input
            value=${values.company_name}
            onInput=${(event: Event) => {
              setField(
                'company_name',
                (event.target as HTMLInputElement).value,
              );
            }}
          />
        </label>
        <label>
          Link
          <input
            value=${values.job_link}
            onInput=${(event: Event) => {
              setField('job_link', (event.target as HTMLInputElement).value);
            }}
          />
        </label>
        ${
          errorFor('job_link')
            ? html`<div class="field-error">${errorFor('job_link')}</div>`
            : null
        }
        <label>
          Platform
          <select
            value=${values.source_platform}
            onChange=${(event: Event) => {
              setField(
                'source_platform',
                (event.target as HTMLSelectElement).value,
              );
            }}
          >
            ${apiSourcePlatformSchema.options.map(
              (platform) =>
                html`<option value=${platform}>${platform}</option>`,
            )}
          </select>
        </label>
        <label>
          Location
          <input
            value=${values.job_location}
            onInput=${(event: Event) => {
              setField(
                'job_location',
                (event.target as HTMLInputElement).value,
              );
            }}
          />
        </label>
        <label class="row">
          <input
            type="checkbox"
            checked=${values.is_remote}
            onChange=${(event: Event) => {
              setField('is_remote', (event.target as HTMLInputElement).checked);
            }}
          />
          Remote
        </label>
        <label>
          Description
          <textarea
            value=${values.job_description}
            onInput=${(event: Event) => {
              setField(
                'job_description',
                (event.target as HTMLTextAreaElement).value,
              );
            }}
          ></textarea>
        </label>
        <label>
          External ID
          <input
            value=${values.external_job_id}
            onInput=${(event: Event) => {
              setField(
                'external_job_id',
                (event.target as HTMLInputElement).value,
              );
            }}
          />
        </label>
        <label>
          Date posted
          <input
            type="date"
            value=${values.date_posted}
            onInput=${(event: Event) => {
              setField('date_posted', (event.target as HTMLInputElement).value);
            }}
          />
        </label>
        ${
          errorFor('date_posted')
            ? html`<div class="field-error">${errorFor('date_posted')}</div>`
            : null
        }
        <label>
          Job type
          <select
            value=${values.job_type}
            onChange=${(event: Event) => {
              setField('job_type', (event.target as HTMLSelectElement).value);
            }}
          >
            <option value="">Not specified</option>
            ${jobTypeSchema.options.map(
              (type) => html`<option value=${type}>${type}</option>`,
            )}
          </select>
        </label>
        <label>
          Experience level
          <select
            value=${values.experience_level}
            onChange=${(event: Event) => {
              setField(
                'experience_level',
                (event.target as HTMLSelectElement).value,
              );
            }}
          >
            <option value="">Not specified</option>
            ${experienceLevelSchema.options.map(
              (level) => html`<option value=${level}>${level}</option>`,
            )}
          </select>
        </label>
        <label class="row">
          <input
            type="checkbox"
            checked=${values.security_clearance_req}
            onChange=${(event: Event) => {
              setField(
                'security_clearance_req',
                (event.target as HTMLInputElement).checked,
              );
            }}
          />
          Security clearance required
        </label>
        <label>
          Salary type
          <select
            value=${values.salary_type}
            onChange=${(event: Event) => {
              setField(
                'salary_type',
                (event.target as HTMLSelectElement).value,
              );
            }}
          >
            <option value="">Not specified</option>
            ${salaryTypeSchema.options.map(
              (type) => html`<option value=${type}>${type}</option>`,
            )}
          </select>
        </label>
        <label>
          Minimum salary (cents)
          <input
            type="number"
            value=${values.salary_min}
            onInput=${(event: Event) => {
              setField('salary_min', (event.target as HTMLInputElement).value);
            }}
          />
        </label>
        ${
          errorFor('salary_min')
            ? html`<div class="field-error">${errorFor('salary_min')}</div>`
            : null
        }
        <label>
          Maximum salary (cents)
          <input
            type="number"
            value=${values.salary_max}
            onInput=${(event: Event) => {
              setField('salary_max', (event.target as HTMLInputElement).value);
            }}
          />
        </label>
        ${
          errorFor('salary_max')
            ? html`<div class="field-error">${errorFor('salary_max')}</div>`
            : null
        }
        <label>
          Minimum hourly rate
          <input
            type="number"
            value=${values.hourly_rate_min}
            onInput=${(event: Event) => {
              setField(
                'hourly_rate_min',
                (event.target as HTMLInputElement).value,
              );
            }}
          />
        </label>
        ${
          errorFor('hourly_rate_min')
            ? html`<div class="field-error">
                ${errorFor('hourly_rate_min')}
              </div>`
            : null
        }
        <label>
          Maximum hourly rate
          <input
            type="number"
            value=${values.hourly_rate_max}
            onInput=${(event: Event) => {
              setField(
                'hourly_rate_max',
                (event.target as HTMLInputElement).value,
              );
            }}
          />
        </label>
        ${
          errorFor('hourly_rate_max')
            ? html`<div class="field-error">
                ${errorFor('hourly_rate_max')}
              </div>`
            : null
        }
        <label>
          Salary notes
          <input
            value=${values.salary_text}
            onInput=${(event: Event) => {
              setField('salary_text', (event.target as HTMLInputElement).value);
            }}
          />
        </label>

        ${TAXONOMY_FIELDS.map(
          (field: TaxonomyField) => html`
            <${TagField}
              field=${field}
              tags=${parseTagList(values[field])}
              onChange=${(tags: string[]) => {
                setField(field, joinTagList(tags));
              }}
            />
          `,
        )}

        <div class="row">
          <button type="submit" disabled=${saving}>
            ${saving ? 'Saving…' : 'Save job'}
          </button>
        </div>
        ${status ? html`<p role="alert">${status}</p>` : null}
      </form>
    </div>
  `;
}
