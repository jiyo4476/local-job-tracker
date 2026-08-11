import { useEffect, useState } from 'preact/hooks';
import { html } from '../html';
import {
  getJob,
  restoreJob,
  softDeleteJob,
  updateJob,
} from '../../lib/db/jobsRepo';
import {
  interviewStageSchema,
  type InterviewStage,
  type StoredJob,
} from '../../lib/db/schema';

const STAGES = interviewStageSchema.options;

interface Props {
  id: number;
}

export function JobDetailView({ id }: Props) {
  const [job, setJob] = useState<StoredJob | null | undefined>(undefined);
  const [stage, setStage] = useState<InterviewStage>('not_applied');
  const [priority, setPriority] = useState(0);
  const [notes, setNotes] = useState('');
  const [resumeVersion, setResumeVersion] = useState('');
  const [status, setStatus] = useState('');

  const load = async () => {
    const found = await getJob(id);
    setJob(found ?? null);
    if (found) {
      setStage(found.interview_stage);
      setPriority(found.priority);
      setNotes(found.notes);
      setResumeVersion(found.resume_version ?? '');
    }
  };

  useEffect(() => {
    void load();
  }, [id]);

  if (job === undefined) return html`<p>Loading…</p>`;
  if (job === null) {
    return html`<p>Job not found. <a href="#/jobs">Back to jobs</a></p>`;
  }

  const save = async (event: Event) => {
    event.preventDefault();
    try {
      await updateJob(id, {
        interview_stage: stage,
        priority,
        notes,
        resume_version: resumeVersion || undefined,
      });
      setStatus('Saved.');
      await load();
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : 'Could not save changes.',
      );
    }
  };

  const toggleActive = async () => {
    if (job.is_active) await softDeleteJob(id);
    else await restoreJob(id);
    await load();
  };

  return html`
    <div class="job-detail">
      <a href="#/jobs">← Back to jobs</a>
      <h2>
        ${job.job_title}
        <span class="muted">at ${job.company_name}</span>
      </h2>
      ${
        !job.is_active
          ? html`<p class="inactive-banner">This job is deactivated.</p>`
          : null
      }

      <dl class="job-meta">
        <dt>Platform</dt>
        <dd>${job.source_platform}</dd>
        <dt>Location</dt>
        <dd>${job.job_location || '—'}</dd>
        <dt>Remote</dt>
        <dd>${job.is_remote ? 'Yes' : 'No'}</dd>
        <dt>Link</dt>
        <dd>
          <a href=${job.job_link} target="_blank" rel="noreferrer"
            >Open posting</a
          >
        </dd>
      </dl>

      ${
        job.job_description
          ? html`
              <details>
                <summary>Description</summary>
                <pre class="job-description">${job.job_description}</pre>
              </details>
            `
          : null
      }

      <form class="job-tracker-form" onSubmit=${save}>
        <label>
          Stage
          <select
            value=${stage}
            onChange=${(event: Event) => {
              setStage(
                (event.target as HTMLSelectElement).value as InterviewStage,
              );
            }}
          >
            ${STAGES.map((s) => html`<option value=${s}>${s}</option>`)}
          </select>
        </label>
        <label>
          Priority (0-5)
          <input
            type="number"
            min="0"
            max="5"
            value=${priority}
            onInput=${(event: Event) => {
              setPriority(Number((event.target as HTMLInputElement).value));
            }}
          />
        </label>
        <label>
          Resume version
          <input
            value=${resumeVersion}
            onInput=${(event: Event) => {
              setResumeVersion((event.target as HTMLInputElement).value);
            }}
          />
        </label>
        <label>
          Notes
          <textarea
            value=${notes}
            onInput=${(event: Event) => {
              setNotes((event.target as HTMLTextAreaElement).value);
            }}
          ></textarea>
        </label>
        <div class="row">
          <button type="submit">Save</button>
          <a class="button-link" href="#/jobs/${String(id)}/edit"
            >Edit full details</a
          >
          <button type="button" onClick=${toggleActive}>
            ${job.is_active ? 'Deactivate' : 'Restore'}
          </button>
        </div>
        ${status ? html`<p role="status">${status}</p>` : null}
      </form>
    </div>
  `;
}
