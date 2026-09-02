import { useEffect, useState } from 'preact/hooks';
import { html } from '../html';
import {
  addJobContact,
  getJob,
  removeJobContact,
  restoreJob,
  softDeleteJob,
  updateJob,
  updateJobContact,
} from '../../lib/db/jobsRepo';
import {
  interviewStageSchema,
  type JobContact,
  type InterviewStage,
} from '../../lib/db/schema';
import { errorMessage, useAsyncResource } from '../useAsyncResource';
import { MAX_CONTACTS, validateContact } from './contactsModel';
import {
  buildJobMarkdown,
  jobMarkdownFilename,
} from '../../lib/markdownExport';

const STAGES = interviewStageSchema.options;

interface Props {
  id: number;
}

export function JobDetailView({ id }: Props) {
  const [stage, setStage] = useState<InterviewStage>('not_applied');
  const [priority, setPriority] = useState(0);
  const [notes, setNotes] = useState('');
  const [resumeVersion, setResumeVersion] = useState('');
  const [status, setStatus] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);
  const [contactDraft, setContactDraft] = useState({
    name: '',
    title: '',
    email: '',
    phone: '',
    linkedin_url: '',
    role: '',
    notes: '',
  });
  const [editingContactId, setEditingContactId] = useState<string>();

  const resource = useAsyncResource(
    async () => (await getJob(id)) ?? null,
    [id],
    'Could not load this job.',
  );
  const job = resource.data;
  useEffect(() => {
    const found = resource.data;
    if (found) {
      setStage(found.interview_stage);
      setPriority(found.priority);
      setNotes(found.notes);
      setResumeVersion(found.resume_version ?? '');
    }
  }, [resource.data]);

  if (resource.error)
    return html`<p role="alert">
      ${resource.error}
      <button
        type="button"
        onClick=${() => {
          void resource.reload();
        }}
      >
        Retry
      </button>
    </p>`;
  if (resource.loading) return html`<p>Loading…</p>`;
  if (!job) {
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
      setStatusIsError(false);
      await resource.reload();
    } catch (error) {
      setStatusIsError(true);
      setStatus(
        error instanceof Error ? error.message : 'Could not save changes.',
      );
    }
  };

  const downloadMarkdown = () => {
    const blob = new Blob([buildJobMarkdown(job)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = jobMarkdownFilename(job);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  };

  const toggleActive = async () => {
    try {
      if (job.is_active) await softDeleteJob(id);
      else await restoreJob(id);
      setStatusIsError(false);
      await resource.reload();
    } catch (caught) {
      setStatusIsError(true);
      setStatus(errorMessage(caught, 'Could not update this job.'));
    }
  };

  const setContactField = (field: keyof typeof contactDraft, value: string) => {
    setContactDraft((current) => ({ ...current, [field]: value }));
  };
  const resetContact = () => {
    setContactDraft({
      name: '',
      title: '',
      email: '',
      phone: '',
      linkedin_url: '',
      role: '',
      notes: '',
    });
    setEditingContactId(undefined);
  };
  const saveContact = async (event: Event) => {
    event.preventDefault();
    const compact = Object.fromEntries(
      Object.entries(contactDraft).map(([key, value]) => [
        key,
        value.trim() || undefined,
      ]),
    );
    const validated = validateContact({
      ...compact,
      name: contactDraft.name,
    });
    if (!validated.contact) {
      setStatusIsError(true);
      setStatus(validated.error ?? 'Invalid contact.');
      return;
    }
    try {
      if (editingContactId) {
        const {
          id: _id,
          created_at: _createdAt,
          ...contactPatch
        } = validated.contact;
        void _id;
        void _createdAt;
        await updateJobContact(id, editingContactId, contactPatch);
      } else {
        await addJobContact(id, validated.contact);
      }
      resetContact();
      setStatus('Contact saved.');
      setStatusIsError(false);
      await resource.reload();
    } catch (caught) {
      setStatusIsError(true);
      setStatus(errorMessage(caught, 'Could not save contact.'));
    }
  };
  const editContact = (contact: JobContact) => {
    setEditingContactId(contact.id);
    setContactDraft({
      name: contact.name,
      title: contact.title ?? '',
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      linkedin_url: contact.linkedin_url ?? '',
      role: contact.role ?? '',
      notes: contact.notes ?? '',
    });
  };
  const removeContact = async (contact: JobContact) => {
    if (!window.confirm(`Remove ${contact.name}?`)) return;
    try {
      await removeJobContact(id, contact.id);
      setStatus('Contact removed.');
      setStatusIsError(false);
      await resource.reload();
    } catch (caught) {
      setStatusIsError(true);
      setStatus(errorMessage(caught, 'Could not remove contact.'));
    }
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
          <button type="button" onClick=${downloadMarkdown}>
            Download as Markdown
          </button>
        </div>
        ${
          status
            ? html`<p role=${statusIsError ? 'alert' : 'status'}>${status}</p>`
            : null
        }
      </form>

      <section aria-labelledby="contacts-heading">
        <h3 id="contacts-heading">
          Contacts (${job.contacts.length}/${MAX_CONTACTS})
        </h3>
        ${
          job.contacts.length === 0
            ? html`<p>No contacts yet.</p>`
            : html`<ul class="contact-list">
                ${job.contacts.map(
                  (contact) =>
                    html`<li>
                      <strong>${contact.name}</strong
                      >${contact.title ? ` — ${contact.title}` : ''}${contact.email ? html` <a href="mailto:${contact.email}">${contact.email}</a>` : null}
                      <div class="actions-cell">
                        <button
                          type="button"
                          aria-label="Edit ${contact.name}"
                          onClick=${() => {
                            editContact(contact);
                          }}
                        >
                          Edit</button
                        ><button
                          type="button"
                          aria-label="Remove ${contact.name}"
                          onClick=${() => void removeContact(contact)}
                        >
                          Remove
                        </button>
                      </div>
                    </li>`,
                )}
              </ul>`
        }
        <form class="job-tracker-form" onSubmit=${saveContact}>
          <h4>${editingContactId ? 'Edit contact' : 'Add contact'}</h4>
          <label
            >Name
            <input
              required
              maxlength="200"
              value=${contactDraft.name}
              onInput=${(e: Event) => {
                setContactField('name', (e.target as HTMLInputElement).value);
              }}
          /></label>
          <label
            >Title
            <input
              maxlength="200"
              value=${contactDraft.title}
              onInput=${(e: Event) => {
                setContactField('title', (e.target as HTMLInputElement).value);
              }}
          /></label>
          <label
            >Email
            <input
              type="email"
              maxlength="320"
              value=${contactDraft.email}
              onInput=${(e: Event) => {
                setContactField('email', (e.target as HTMLInputElement).value);
              }}
          /></label>
          <label
            >Phone
            <input
              type="tel"
              maxlength="50"
              value=${contactDraft.phone}
              onInput=${(e: Event) => {
                setContactField('phone', (e.target as HTMLInputElement).value);
              }}
          /></label>
          <label
            >LinkedIn URL
            <input
              type="url"
              value=${contactDraft.linkedin_url}
              onInput=${(e: Event) => {
                setContactField(
                  'linkedin_url',
                  (e.target as HTMLInputElement).value,
                );
              }}
          /></label>
          <label
            >Relationship / role
            <input
              maxlength="200"
              value=${contactDraft.role}
              onInput=${(e: Event) => {
                setContactField('role', (e.target as HTMLInputElement).value);
              }}
          /></label>
          <label
            >Notes
            <textarea
              maxlength="10000"
              value=${contactDraft.notes}
              onInput=${(e: Event) => {
                setContactField(
                  'notes',
                  (e.target as HTMLTextAreaElement).value,
                );
              }}
            ></textarea>
          </label>
          <div class="row">
            <button
              type="submit"
              disabled=${!editingContactId && job.contacts.length >= MAX_CONTACTS}
            >
              ${editingContactId ? 'Save contact' : 'Add contact'}</button
            >${editingContactId ? html`<button type="button" onClick=${resetContact}>Cancel</button>` : null}
          </div>
        </form>
      </section>
    </div>
  `;
}
