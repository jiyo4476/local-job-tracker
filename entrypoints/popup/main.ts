import { browser } from 'wxt/browser';
import '../styles.css';
import {
  type ExtensionResponse,
  type ExtractionCandidates,
  type SaveJobResult,
  extensionResponseSchema,
} from '../../src/lib/messages';
import {
  buildExportFilename,
  buildJobPostingJsonLd,
} from '../../src/lib/jsonld';
import {
  applyCandidateSelection,
  applyExtractionPreservingTaxonomy,
  CANDIDATE_SOURCE_LABELS,
  type DraftFormField,
  emptyFormValues,
  type FieldError,
  firstInvalidField,
  formatCandidateValue,
  formValuesToDraft,
  FORM_FIELD_ORDER,
  type PopupFormValues,
  validateFormValues,
} from '../../src/lib/popupForm';
import {
  addTag,
  joinTagList,
  parseTagList,
  removeTagAt,
  TAXONOMY_FIELDS,
  TAXONOMY_GROUP_COPY,
  type TaxonomyField,
} from '../../src/lib/taxonomyFields';
import type { JobDraft } from '../../src/lib/schemas';
import type { PopupDraftContext } from '../../src/lib/popupDraft';
import { popupDraftPersistenceErrorMessage } from '../../src/lib/popupDraftFeedback';

const FIELD_IDS: Record<DraftFormField, string> = {
  job_title: 'job-title',
  company_name: 'company-name',
  job_link: 'job-link',
  source_platform: 'source-platform',
  job_location: 'job-location',
  is_remote: 'is-remote',
  job_description: 'job-description',
  external_job_id: 'external-job-id',
  date_posted: 'date-posted',
  job_type: 'job-type',
  experience_level: 'experience-level',
  security_clearance_req: 'security-clearance-req',
  salary_type: 'salary-type',
  salary_min: 'salary-min',
  salary_max: 'salary-max',
  hourly_rate_min: 'hourly-rate-min',
  hourly_rate_max: 'hourly-rate-max',
  salary_text: 'salary-text',
  skills: 'skills',
  software: 'software',
  keywords: 'keywords',
  certifications: 'certifications',
};

const ERROR_FIELDS: DraftFormField[] = [
  'job_link',
  'date_posted',
  'salary_min',
  'salary_max',
  'hourly_rate_min',
  'hourly_rate_max',
  ...TAXONOMY_FIELDS,
];

const statusEl = document.querySelector<HTMLDivElement>('#status');
const form = document.querySelector<HTMLFormElement>('#job-form');
const extractButton =
  document.querySelector<HTMLButtonElement>('#extract-button');
const templateButton =
  document.querySelector<HTMLButtonElement>('#template-button');
const exportButton =
  document.querySelector<HTMLButtonElement>('#export-button');
const saveButton = document.querySelector<HTMLButtonElement>('#save-button');

let saveInFlight = false;
let formRevision = 0;
let popupDraftContext: PopupDraftContext | undefined;

// Committed values for the four taxonomy categories, keyed by category. The
// visible per-category input is only an "add" box; the source of truth for
// each category's values is this state, so a value entered under Skills can
// never drift into Software (and vice versa).
const tagState: Record<TaxonomyField, string[]> = {
  skills: [],
  software: [],
  certifications: [],
  keywords: [],
};

/**
 * Renders the four taxonomy groups (Skills, Software, Certifications,
 * Keywords) into #taxonomy-groups. Each group is an independent fieldset
 * with its own label, help text, empty state, chip list, add input, and
 * error region -- built once at startup from TAXONOMY_GROUP_COPY.
 */
function renderTaxonomyGroups(): void {
  const container = document.getElementById('taxonomy-groups');
  if (!container) return;

  for (const field of TAXONOMY_FIELDS) {
    const copy = TAXONOMY_GROUP_COPY[field];

    const group = document.createElement('fieldset');
    group.className = 'tag-group';

    const legend = document.createElement('legend');
    legend.textContent = copy.label;

    const help = document.createElement('p');
    help.className = 'tag-help';
    help.id = `help-${field}`;
    help.textContent = copy.helpText;

    const list = document.createElement('ul');
    list.className = 'tag-list';
    list.id = `tags-${field}`;
    list.setAttribute('aria-label', `${copy.label} values`);
    list.hidden = true;

    const empty = document.createElement('p');
    empty.className = 'tag-empty';
    empty.id = `empty-${field}`;
    empty.textContent = copy.emptyState;

    const addRow = document.createElement('div');
    addRow.className = 'tag-add-row';

    const input = document.createElement('input');
    input.id = FIELD_IDS[field];
    input.name = field;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', copy.addLabel);
    input.setAttribute('aria-describedby', `help-${field} error-${field}`);
    input.placeholder = copy.addLabel;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        commitPendingTagInput(field);
      }
    });

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.id = `add-${field}`;
    addButton.textContent = 'Add';
    addButton.setAttribute('aria-label', copy.addLabel);
    addButton.addEventListener('click', () => {
      commitPendingTagInput(field);
      input.focus();
    });

    addRow.append(input, addButton);

    const error = document.createElement('div');
    error.className = 'field-error';
    error.id = `error-${field}`;
    error.setAttribute('role', 'alert');
    error.hidden = true;

    const candidates = document.createElement('div');
    candidates.className = 'candidate-picker';
    candidates.id = `candidates-${field}`;
    candidates.setAttribute('role', 'radiogroup');
    candidates.setAttribute(
      'aria-label',
      `Alternative values for ${copy.label}`,
    );
    candidates.hidden = true;

    group.append(legend, help, list, empty, addRow, error, candidates);
    container.appendChild(group);
  }
}

/** Redraws one category's chips and toggles its empty state. */
function renderTagChips(field: TaxonomyField): void {
  const list = document.getElementById(`tags-${field}`);
  const empty = document.getElementById(`empty-${field}`);
  if (!list || !empty) return;

  const copy = TAXONOMY_GROUP_COPY[field];
  const tags = tagState[field];

  list.innerHTML = '';
  list.hidden = tags.length === 0;
  empty.hidden = tags.length > 0;

  tags.forEach((tag, index) => {
    const item = document.createElement('li');
    item.className = 'tag-chip';

    const text = document.createElement('span');
    text.textContent = tag;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${tag} from ${copy.label}`);
    remove.addEventListener('click', () => {
      removeTagChip(field, index);
    });

    item.append(text, remove);
    list.appendChild(item);
  });
}

function setTagFieldError(
  field: TaxonomyField,
  message: string | undefined,
): void {
  const el = document.getElementById(`error-${field}`);
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

/**
 * Commits the category's pending add-box text as one or more new tags: the
 * raw text is split on commas so a pasted list (e.g. "Python, Django") adds
 * each term separately instead of becoming one malformed entry. Returns true
 * when the input was empty or every term was added; false when validation
 * rejected a term (the category-specific error is shown inline and the
 * unprocessed remainder, including the rejected term, is left in the input).
 *
 * `persist` is false when called from {@link commitAllPendingTagInputs},
 * which persists once after every category has been committed instead of
 * once per category.
 */
function commitPendingTagInput(field: TaxonomyField, persist = true): boolean {
  const input = getFieldElement(field);
  if (!input) return true;

  const raw = input.value;
  if (!raw.trim()) {
    input.value = '';
    return true;
  }

  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  let tags = tagState[field];
  let index = 0;
  let ok = true;

  for (; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    const result = addTag(field, tags, part);
    if (!result.ok) {
      setTagFieldError(field, result.error);
      ok = false;
      break;
    }
    tags = result.tags;
  }

  const changed = tags !== tagState[field];
  tagState[field] = tags;
  input.value = ok ? '' : parts.slice(index).join(', ');
  if (ok) setTagFieldError(field, undefined);
  if (changed) {
    renderTagChips(field);
    formRevision += 1;
    if (persist) void persistCurrentDraft();
  }
  if (!ok) input.focus();
  return ok;
}

/**
 * Commits pending add-box text in every category (used before save/export so
 * typed-but-unadded values are not silently dropped), persisting once
 * afterward instead of once per category. Returns the first category whose
 * pending value failed validation, if any.
 */
function commitAllPendingTagInputs(): TaxonomyField | undefined {
  let failedField: TaxonomyField | undefined;
  for (const field of TAXONOMY_FIELDS) {
    if (!commitPendingTagInput(field, false)) {
      failedField = field;
      break;
    }
  }
  void persistCurrentDraft();
  return failedField;
}

function removeTagChip(field: TaxonomyField, index: number): void {
  tagState[field] = removeTagAt(tagState[field], index);
  setTagFieldError(field, undefined);
  renderTagChips(field);
  formRevision += 1;
  void persistCurrentDraft();

  // Keep focus inside the group: land on the next chip's remove button, or
  // fall back to the category's add input when the last chip was removed.
  const list = document.getElementById(`tags-${field}`);
  const buttons = list?.querySelectorAll('button');
  const nextButton = buttons?.[Math.min(index, (buttons.length || 1) - 1)];
  if (buttons && buttons.length > 0 && nextButton) {
    nextButton.focus();
  } else {
    getFieldElement(field)?.focus();
  }
}

form?.addEventListener('input', () => {
  formRevision += 1;
  void persistCurrentDraft();
});

extractButton?.addEventListener('click', () => {
  void extractActiveTab();
});

templateButton?.addEventListener('click', () => {
  void startTemplatePicker();
});

exportButton?.addEventListener('click', () => {
  exportJsonLd();
});

saveButton?.addEventListener('click', () => {
  void saveJob();
});

renderTaxonomyGroups();
void initializePopup();

async function initializePopup(): Promise<void> {
  popupDraftContext = await getActiveTabContext();
  await restoreDraftOrExtract();
}

async function autoExtractIfEnabled(): Promise<void> {
  const rawResponse: unknown = await browser.runtime.sendMessage({
    type: 'GET_SETTINGS',
  });
  const response = extensionResponseSchema.parse(rawResponse);
  if (
    response.ok &&
    response.type === 'GET_SETTINGS_RESULT' &&
    response.settings.autoDetect
  ) {
    await extractActiveTab();
    return;
  }
  setStatus(
    'Open a supported job page, then select Scan active tab.',
    'status',
  );
}

async function restoreDraftOrExtract(): Promise<void> {
  if (popupDraftContext) {
    try {
      const storedValues = await requestPopupDraft(popupDraftContext);
      if (storedValues) {
        applyFormValues(storedValues);
        setStatus('Restored your unsaved changes.', 'status');
        return;
      }
    } catch {
      // Storage failure should not prevent the existing extraction workflow.
    }
  }

  await autoExtractIfEnabled();
}

async function getActiveTabContext(): Promise<PopupDraftContext | undefined> {
  try {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id === undefined || !tab.url) return undefined;
    return { tabId: tab.id, url: tab.url };
  } catch {
    return undefined;
  }
}

async function extractActiveTab(): Promise<void> {
  clearFieldErrors();
  renderCandidates(undefined);
  setStatus('Scanning the active tab…', 'status');
  setBusy(true);

  try {
    const rawResponse: unknown = await browser.runtime.sendMessage({
      type: 'EXTRACT_ACTIVE_TAB',
    });
    const response = extensionResponseSchema.parse(rawResponse);
    renderResponse(response);
  } catch {
    setStatus(
      'Could not extract this page. Try again or enter the details manually.',
      'alert',
    );
  } finally {
    setBusy(false);
  }
}

async function startTemplatePicker(): Promise<void> {
  setStatus('Starting the element picker…', 'status');
  try {
    const rawResponse: unknown = await browser.runtime.sendMessage({
      type: 'START_TEMPLATE_PICKER',
    });
    const response = extensionResponseSchema.parse(rawResponse);
    if (!response.ok) {
      setStatus(response.error.message, 'alert');
      return;
    }
    setStatus(
      'Element picker opened on the page. The popup may now close.',
      'status',
    );
  } catch {
    setStatus('Could not start the element picker on this page.', 'alert');
  }
}

async function saveJob(): Promise<void> {
  if (saveInFlight) return;

  clearFieldErrors();
  const pendingTagField = commitAllPendingTagInputs();
  if (pendingTagField) {
    setStatus('Fix the highlighted fields before saving.', 'alert');
    return;
  }
  const values = readFormValues();
  const errors = validateFormValues(values);
  if (errors.length > 0) {
    renderFieldErrors(errors);
    setStatus('Fix the highlighted fields before saving.', 'alert');
    const invalidField = firstInvalidField(errors);
    if (invalidField) focusField(invalidField);
    return;
  }

  saveInFlight = true;
  const submittedRevision = formRevision;
  setStatus('Saving job…', 'status');
  setSaveDisabled(true);

  try {
    const draft = formValuesToDraft(values);
    const rawResponse: unknown = await browser.runtime.sendMessage({
      type: 'SAVE_JOB_LOCAL',
      draft,
    });
    const response = extensionResponseSchema.parse(rawResponse);
    if (
      response.ok &&
      response.type === 'SAVE_JOB_LOCAL_RESULT' &&
      popupDraftContext
    ) {
      if (formRevision === submittedRevision) {
        await clearCurrentDraft();
        if (formRevision !== submittedRevision) {
          await requestPopupDraft(popupDraftContext);
          await persistCurrentDraft();
        }
      } else {
        await persistCurrentDraft();
      }
    }
    renderResponse(response);
  } catch (error) {
    setStatus(
      error instanceof Error
        ? error.message
        : 'Review the fields before saving this job.',
      'alert',
    );
  } finally {
    saveInFlight = false;
    setSaveDisabled(false);
  }
}

function enterManualEntry(): void {
  clearFieldErrors();
  renderCandidates(undefined);
  applyFormValues(emptyFormValues());
  formRevision += 1;
  void persistCurrentDraft();
  setStatus('Manual entry. Fill in the fields and save.', 'status');
  focusField('job_title');
}

function exportJsonLd(): void {
  clearFieldErrors();
  const pendingTagField = commitAllPendingTagInputs();
  if (pendingTagField) {
    setStatus('Fix the highlighted fields before exporting.', 'alert');
    return;
  }
  const values = readFormValues();
  const errors = validateFormValues(values);
  if (errors.length > 0) {
    renderFieldErrors(errors);
    setStatus('Fix the highlighted fields before exporting.', 'alert');
    const invalidField = firstInvalidField(errors);
    if (invalidField) focusField(invalidField);
    return;
  }

  let draft: JobDraft;
  try {
    draft = formValuesToDraft(values);
  } catch {
    setStatus('Fix the highlighted fields before exporting.', 'alert');
    return;
  }

  const jsonLd = buildJobPostingJsonLd(draft);
  const filename = buildExportFilename(draft);
  const blob = new Blob([JSON.stringify(jsonLd, null, 2)], {
    type: 'application/ld+json',
  });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  setStatus(`Exported ${filename}.`, 'status');
}

function renderResponse(response: ExtensionResponse): void {
  if (!response.ok) {
    handleError(response.error.code, response.error.message);
    return;
  }

  if (response.type === 'EXTRACT_ACTIVE_TAB_RESULT') {
    // Re-extract merges per taxonomy category instead of overwriting: the
    // user's Skills/Software/Certifications/Keywords edits stay first and in
    // their categories, with newly extracted values appended (see
    // applyExtractionPreservingTaxonomy).
    applyFormValues(
      applyExtractionPreservingTaxonomy(readFormValues(), response.draft),
    );
    formRevision += 1;
    void persistCurrentDraft();
    renderCandidates(response.candidates);
    setStatus(
      response.applied_template
        ? `Applied site template “${response.applied_template.name}”. Review the extracted fields before saving.`
        : 'Review the extracted fields before saving.',
      'status',
    );
    return;
  }

  if (response.type === 'SAVE_JOB_LOCAL_RESULT') {
    setStatus(formatSaveResult(response.result), 'status');
  }
}

function handleError(code: string, message: string): void {
  if (code === 'EXTRACT_EMPTY') {
    enterManualEntry();
    setStatus(
      'No job data was found on this page. Enter the details manually.',
      'status',
    );
    return;
  }

  setStatus(message, 'alert');
}

function renderCandidates(candidates: ExtractionCandidates | undefined): void {
  FORM_FIELD_ORDER.forEach((field) => {
    const container = document.getElementById(`candidates-${field}`);
    if (!container) return;

    container.innerHTML = '';
    if (field === 'job_description') {
      container.hidden = true;
      return;
    }

    const list = candidates?.[field];
    if (!list || list.length < 2) {
      container.hidden = true;
      return;
    }

    container.hidden = false;
    list.forEach((candidate, index) => {
      const optionId = `candidate-${field}-${String(index)}`;

      const wrapper = document.createElement('label');
      wrapper.className = 'candidate-option';
      wrapper.htmlFor = optionId;

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `candidate-${field}`;
      radio.id = optionId;
      radio.addEventListener('change', () => {
        selectCandidate(field, candidate.value);
      });

      const text = document.createElement('span');
      text.textContent = `${CANDIDATE_SOURCE_LABELS[candidate.source]}: ${formatCandidateValue(candidate.value)}`;

      wrapper.append(radio, text);
      container.appendChild(wrapper);
    });
  });
}

function selectCandidate(field: DraftFormField, value: unknown): void {
  const next = applyCandidateSelection(readFormValues(), field, value);
  applyFormValues(next);
  formRevision += 1;
  void persistCurrentDraft();
}

async function requestPopupDraft(
  context: PopupDraftContext,
): Promise<PopupFormValues | undefined> {
  const rawResponse: unknown = await browser.runtime.sendMessage({
    type: 'GET_POPUP_DRAFT',
    context,
  });
  const response = extensionResponseSchema.parse(rawResponse);
  if (!response.ok || response.type !== 'GET_POPUP_DRAFT_RESULT') {
    throw new Error('Could not read the popup draft.');
  }
  return response.values;
}

async function persistCurrentDraft(): Promise<void> {
  if (!popupDraftContext) return;

  try {
    const rawResponse: unknown = await browser.runtime.sendMessage({
      type: 'SAVE_POPUP_DRAFT',
      context: popupDraftContext,
      values: readFormValues(),
    });
    const response = extensionResponseSchema.parse(rawResponse);
    if (!response.ok && response.error.code === 'POPUP_CONTEXT_STALE') {
      setStatus(
        popupDraftPersistenceErrorMessage(
          response.error.code,
          response.error.message,
        ),
        'alert',
      );
      return;
    }
    if (!response.ok || response.type !== 'SAVE_POPUP_DRAFT_RESULT') {
      throw new Error(
        !response.ok
          ? popupDraftPersistenceErrorMessage(
              response.error.code,
              response.error.message,
            )
          : 'Could not store the popup draft.',
      );
    }
  } catch (error) {
    // Draft persistence is best-effort and must not block popup editing.
    if (error instanceof Error) setStatus(error.message, 'alert');
  }
}

async function clearCurrentDraft(): Promise<void> {
  if (!popupDraftContext) return;

  try {
    const rawResponse: unknown = await browser.runtime.sendMessage({
      type: 'CLEAR_POPUP_DRAFT',
      context: popupDraftContext,
    });
    const response = extensionResponseSchema.parse(rawResponse);
    if (!response.ok || response.type !== 'CLEAR_POPUP_DRAFT_RESULT') {
      throw new Error('Could not clear the popup draft.');
    }
  } catch {
    // A storage failure should not turn a successful job save into an error.
  }
}

function formatSaveResult(result: SaveJobResult): string {
  const suffix = ` Job ID: ${String(result.id)}.`;

  if (result.action === 'created')
    return `Created job in Job Tracker.${suffix}`;
  if (result.action === 'updated')
    return `Updated existing job in Job Tracker.${suffix}`;
  return `Duplicate found; existing job was left unchanged.${suffix}`;
}

function readFormValues(): PopupFormValues {
  return {
    job_title: getValue('job_title'),
    company_name: getValue('company_name'),
    job_link: getValue('job_link'),
    source_platform: getValue('source_platform'),
    job_location: getValue('job_location'),
    is_remote: getChecked('is_remote'),
    job_description: getValue('job_description'),
    external_job_id: getValue('external_job_id'),
    date_posted: getValue('date_posted'),
    job_type: getValue('job_type'),
    experience_level: getValue('experience_level'),
    security_clearance_req: getChecked('security_clearance_req'),
    salary_type: getValue('salary_type'),
    salary_min: getValue('salary_min'),
    salary_max: getValue('salary_max'),
    hourly_rate_min: getValue('hourly_rate_min'),
    hourly_rate_max: getValue('hourly_rate_max'),
    salary_text: getValue('salary_text'),
    // The four taxonomy categories read from committed tag state plus any
    // not-yet-committed add-box text (see taxonomyFormValue) -- otherwise
    // text typed but not yet submitted via Enter/comma/Add would be silently
    // dropped from the draft persisted on every keystroke.
    skills: taxonomyFormValue('skills'),
    software: taxonomyFormValue('software'),
    keywords: taxonomyFormValue('keywords'),
    certifications: taxonomyFormValue('certifications'),
  };
}

/**
 * Serializes one taxonomy category to the comma-separated form-value string,
 * appending any uncommitted add-box text. This is what makes a popup-close
 * mid-typing recoverable: persistCurrentDraft (fired on every 'input' event)
 * captures the pending text here, and applyFormValues() folds it back in as
 * a committed tag on restore instead of losing it.
 */
function taxonomyFormValue(field: TaxonomyField): string {
  const committed = joinTagList(tagState[field]);
  const pending = getFieldElement(field)?.value.trim() ?? '';
  if (!pending) return committed;
  return committed ? `${committed}, ${pending}` : pending;
}

function applyFormValues(values: PopupFormValues): void {
  setValue('job_title', values.job_title);
  setValue('company_name', values.company_name);
  setValue('job_link', values.job_link);
  setValue('source_platform', values.source_platform);
  setValue('job_location', values.job_location);
  setChecked('is_remote', values.is_remote);
  setValue('job_description', values.job_description);
  setValue('external_job_id', values.external_job_id);
  setValue('date_posted', values.date_posted);
  setValue('job_type', values.job_type);
  setValue('experience_level', values.experience_level);
  setChecked('security_clearance_req', values.security_clearance_req);
  setValue('salary_type', values.salary_type);
  setValue('salary_min', values.salary_min);
  setValue('salary_max', values.salary_max);
  setValue('hourly_rate_min', values.hourly_rate_min);
  setValue('hourly_rate_max', values.hourly_rate_max);
  setValue('salary_text', values.salary_text);

  for (const field of TAXONOMY_FIELDS) {
    tagState[field] = parseTagList(values[field]);
    setValue(field, '');
    setTagFieldError(field, undefined);
    renderTagChips(field);
  }
}

function clearFieldErrors(): void {
  ERROR_FIELDS.forEach((field) => {
    const el = document.getElementById(`error-${field}`);
    if (el) {
      el.textContent = '';
      el.hidden = true;
    }
  });
}

function renderFieldErrors(errors: FieldError[]): void {
  errors.forEach((error) => {
    const el = document.getElementById(`error-${error.field}`);
    if (el) {
      el.textContent = error.message;
      el.hidden = false;
    }
  });
}

function focusField(field: DraftFormField): void {
  const el = document.getElementById(FIELD_IDS[field]);
  el?.focus();
}

function getFieldElement(
  field: DraftFormField,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  return document.getElementById(FIELD_IDS[field]) as
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
}

function getValue(field: DraftFormField): string {
  return getFieldElement(field)?.value ?? '';
}

function setValue(field: DraftFormField, value: string): void {
  const el = getFieldElement(field);
  if (el) el.value = value;
}

function getChecked(field: DraftFormField): boolean {
  const el = document.getElementById(
    FIELD_IDS[field],
  ) as HTMLInputElement | null;
  return el?.checked ?? false;
}

function setChecked(field: DraftFormField, checked: boolean): void {
  const el = document.getElementById(
    FIELD_IDS[field],
  ) as HTMLInputElement | null;
  if (el) el.checked = checked;
}

function setStatus(message: string, kind: 'status' | 'alert' = 'status'): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.setAttribute('role', kind);
}

function setBusy(disabled: boolean): void {
  form
    ?.querySelectorAll<
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | HTMLButtonElement
    >('input, select, textarea, button')
    .forEach((el) => {
      el.disabled = disabled;
    });
  setExtractDisabled(disabled);
  if (templateButton) templateButton.disabled = disabled;
  setExportDisabled(disabled);
  setSaveDisabled(disabled);
}

function setExtractDisabled(disabled: boolean): void {
  if (extractButton) extractButton.disabled = disabled;
}

function setExportDisabled(disabled: boolean): void {
  if (exportButton) exportButton.disabled = disabled;
}

function setSaveDisabled(disabled: boolean): void {
  if (saveButton) saveButton.disabled = disabled;
}
