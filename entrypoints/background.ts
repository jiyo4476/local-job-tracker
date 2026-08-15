import { browser } from 'wxt/browser';
import { ZodError } from 'zod';
import {
  type ExtensionErrorCode,
  type ExtensionMessage,
  type ExtensionResponse,
  type ExtractionCandidate,
  extensionMessageSchema,
} from '../src/lib/messages';
import { upsertJob } from '../src/lib/db/jobsRepo';
import {
  detectPlatform,
  isAutoScrapeUrl,
} from '../src/lib/extraction/detectPlatform';
import type { extractJobDraft } from '../src/lib/extraction/jobDraftExtractor';
import { listSiteTemplates, saveSiteTemplate } from '../src/lib/templates/repo';
import { selectMatchingSiteTemplates } from '../src/lib/templates/engine';
import type { SiteTemplate } from '../src/lib/templates/schema';
import { JOB_DRAFT_EXTRACTOR_BRIDGE_KEY } from '../src/lib/extraction/jobDraftExtractorBridge';
import { TEMPLATE_PICKER_BRIDGE_KEY } from '../src/lib/templates/pickerBridge';
import { buildScrapePayload } from '../src/lib/payload';
import {
  clearPopupDraft,
  clearPopupDraftForTab,
  getPopupDraft,
  type PopupDraftContext,
  savePopupDraft,
} from '../src/lib/popupDraft';
import type { PopupFormValues } from '../src/lib/popupForm';
import { type JobDraft, jobDraftSchema } from '../src/lib/schemas';
import {
  getSettings,
  saveSettings,
  toPublicSettings,
} from '../src/lib/settings';

let saveJobQueue: Promise<void> = Promise.resolve();
let popupDraftMutationQueue: Promise<void> = Promise.resolve();
const popupDraftNavigationGenerations = new Map<number, number>();
const popupDraftContexts = new Map<
  number,
  { url: string; generation: number; mutationRevision: number }
>();
let nextPopupDraftGeneration = 1;

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const parsed = extensionMessageSchema.safeParse(message);
    if (!parsed.success) {
      return Promise.resolve(
        errorResponse('MESSAGE_INVALID', 'Unexpected extension message.'),
      );
    }

    return handleMessage(parsed.data);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // URL changes are available while activeTab access remains valid (for
    // example, same-origin SPA navigation). Loading status covers full-page
    // navigation without adding broad tab/host visibility.
    if (changeInfo.status === 'loading' || changeInfo.url !== undefined) {
      advancePopupDraftGeneration(tabId);
      void enqueuePopupDraftMutation(() => clearPopupDraftForTab(tabId));
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    advancePopupDraftGeneration(tabId);
    popupDraftContexts.delete(tabId);
    popupDraftNavigationGenerations.delete(tabId);
    void enqueuePopupDraftMutation(() => clearPopupDraftForTab(tabId));
  });
});

export async function handleMessage(
  message: ExtensionMessage,
): Promise<ExtensionResponse> {
  if (message.type === 'EXTRACT_ACTIVE_TAB') {
    return extractActiveTab();
  }

  if (message.type === 'SAVE_JOB_LOCAL') {
    return enqueueSaveJob(message.draft);
  }

  if (message.type === 'GET_SETTINGS') {
    const settings = await getSettings();
    return {
      type: 'GET_SETTINGS_RESULT',
      ok: true,
      settings: toPublicSettings(settings),
    };
  }

  if (message.type === 'SAVE_SETTINGS') {
    const settings = await saveSettings(message.settings);
    return {
      type: 'SAVE_SETTINGS_RESULT',
      ok: true,
      settings: toPublicSettings(settings),
    };
  }

  if (message.type === 'GET_POPUP_DRAFT') {
    return readPopupDraft(message.context);
  }

  if (message.type === 'SAVE_POPUP_DRAFT') {
    return persistPopupDraft(message.context, message.values);
  }

  if (message.type === 'CLEAR_POPUP_DRAFT') {
    return removePopupDraft(message.context);
  }

  if (message.type === 'START_TEMPLATE_PICKER') {
    return startTemplatePicker();
  }

  if (message.type === 'SAVE_SITE_TEMPLATE') {
    try {
      const template = await saveSiteTemplate(message.template);
      return { type: 'SAVE_SITE_TEMPLATE_RESULT', ok: true, template };
    } catch {
      return errorResponse(
        'STORAGE_FAILED',
        'The site template could not be saved locally. Keep the picker open and try again.',
      );
    }
  }

  return errorResponse(
    'MESSAGE_UNHANDLED',
    'No handler is available for this action.',
  );
}

async function startTemplatePicker(): Promise<ExtensionResponse> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    return errorResponse('TAB_NOT_FOUND', 'No active web page is available.');
  }
  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return errorResponse(
      'DOMAIN_NOT_SUPPORTED',
      'Open an HTTP(S) job page first.',
    );
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return errorResponse(
      'DOMAIN_NOT_SUPPORTED',
      'Open an HTTP(S) job page first.',
    );
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['/content-scripts/template-picker.js'],
    });
    const invokePicker = (bridgeKey: string) => {
      const start = (window as unknown as Record<string, unknown>)[
        bridgeKey
      ] as (() => void) | undefined;
      if (!start) throw new Error('Template picker bridge was not loaded.');
      start();
    };
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: invokePicker,
      args: [TEMPLATE_PICKER_BRIDGE_KEY],
    });
    return { type: 'START_TEMPLATE_PICKER_RESULT', ok: true };
  } catch {
    return errorResponse(
      'EXTRACT_FAILED',
      'Could not start the element picker on this page. Reload it and try again.',
    );
  }
}

async function readPopupDraft(
  context: PopupDraftContext,
): Promise<ExtensionResponse> {
  try {
    popupDraftContexts.set(context.tabId, {
      url: context.url,
      generation: getOrCreatePopupDraftGeneration(context.tabId),
      mutationRevision: 0,
    });
    await popupDraftMutationQueue.catch(() => undefined);
    return {
      type: 'GET_POPUP_DRAFT_RESULT',
      ok: true,
      values: await getPopupDraft(context),
    };
  } catch {
    return errorResponse('STORAGE_FAILED', 'Could not read the popup draft.');
  }
}

async function persistPopupDraft(
  context: PopupDraftContext,
  values: PopupFormValues,
): Promise<ExtensionResponse> {
  try {
    const registeredContext = popupDraftContexts.get(context.tabId);
    if (registeredContext?.url !== context.url) {
      return stalePopupDraftResponse();
    }
    registeredContext.mutationRevision += 1;
    await enqueuePopupDraftMutation(async () => {
      await assertCurrentPopupDraftContext(
        context,
        registeredContext.generation,
      );
      await savePopupDraft(context, values);
    });
    return { type: 'SAVE_POPUP_DRAFT_RESULT', ok: true };
  } catch (error) {
    if (error instanceof PopupDraftContextError) {
      return stalePopupDraftResponse();
    }
    return errorResponse('STORAGE_FAILED', 'Could not store the popup draft.');
  }
}

class PopupDraftContextError extends Error {}

function stalePopupDraftResponse(): ExtensionResponse {
  return errorResponse(
    'POPUP_CONTEXT_STALE',
    'This page changed or closed, so its outdated draft was not stored.',
  );
}

function getOrCreatePopupDraftGeneration(tabId: number): number {
  const current = popupDraftNavigationGenerations.get(tabId);
  if (current !== undefined) return current;
  const generation = nextPopupDraftGeneration++;
  popupDraftNavigationGenerations.set(tabId, generation);
  return generation;
}

function advancePopupDraftGeneration(tabId: number): void {
  popupDraftNavigationGenerations.set(tabId, nextPopupDraftGeneration++);
}

async function assertCurrentPopupDraftContext(
  context: PopupDraftContext,
  expectedGeneration: number,
): Promise<void> {
  if (
    popupDraftNavigationGenerations.get(context.tabId) !== expectedGeneration
  ) {
    throw new PopupDraftContextError(
      'The source tab navigated before the draft was stored.',
    );
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await browser.tabs.get(context.tabId);
  } catch {
    throw new PopupDraftContextError(
      'The source tab closed before the draft was stored.',
    );
  }
  if (
    tab.url !== context.url ||
    popupDraftNavigationGenerations.get(context.tabId) !== expectedGeneration
  ) {
    throw new PopupDraftContextError(
      'The source tab no longer matches the popup draft.',
    );
  }
}

async function removePopupDraft(
  context: PopupDraftContext,
): Promise<ExtensionResponse> {
  const registeredContext = popupDraftContexts.get(context.tabId);
  const mutationRevision = registeredContext?.mutationRevision;
  try {
    await enqueuePopupDraftMutation(() => clearPopupDraft(context));
    const contextUnchanged =
      !registeredContext ||
      (popupDraftContexts.get(context.tabId) === registeredContext &&
        registeredContext.mutationRevision === mutationRevision);
    if (contextUnchanged) {
      popupDraftContexts.delete(context.tabId);
      popupDraftNavigationGenerations.delete(context.tabId);
    }
    return { type: 'CLEAR_POPUP_DRAFT_RESULT', ok: true };
  } catch {
    return errorResponse('STORAGE_FAILED', 'Could not clear the popup draft.');
  }
}

function enqueuePopupDraftMutation(
  operation: () => Promise<void>,
): Promise<void> {
  const next = popupDraftMutationQueue.catch(() => undefined).then(operation);
  popupDraftMutationQueue = next.catch(() => undefined);
  return next;
}

async function extractActiveTab(): Promise<ExtensionResponse> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return errorResponse('TAB_NOT_FOUND', 'No active tab is available.');
  }

  const detection = detectPlatform(tab.url ?? '');
  let matchingTemplates: SiteTemplate[];
  try {
    matchingTemplates = selectMatchingSiteTemplates(
      await listSiteTemplates(),
      tab.url ?? '',
    );
  } catch {
    if (!isAutoScrapeUrl(tab.url ?? '') && detection.platform !== 'direct') {
      return errorResponse(
        'STORAGE_FAILED',
        'Saved site templates could not be read. Reload the extension and try again.',
      );
    }
    matchingTemplates = [];
  }

  if (!isAutoScrapeUrl(tab.url ?? '') && matchingTemplates.length === 0) {
    if (detection.platform !== 'direct') {
      return errorResponse(
        'DOMAIN_NOT_SUPPORTED',
        'No automatic extractor or saved site template matches this page. Create a site template or enter the job manually.',
      );
    }
  }

  // Two-step injection: load the real bundled content-script file first (so
  // its `dompurify`/`turndown` imports actually resolve), then run a
  // self-contained `func` in the same tab that reads the bridged function
  // back off `window` and calls it with this request's `detection`. See
  // `jobDraftExtractorBridge.ts` for why a single-step `func` won't work.
  // Each step gets its own try/catch so a failure here (e.g. the tab
  // navigated away before the bundle loaded) is distinguishable from a
  // failure in the second step below.
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['/content-scripts/content.js'],
    });
  } catch {
    return errorResponse(
      'EXTRACT_FAILED',
      'Could not load the extension scanner on this page. Try reloading the page and opening the popup again.',
    );
  }

  const callBridgedExtractor = (
    bridgeKey: string,
    detectionArg: typeof detection,
    templatesArg: typeof matchingTemplates,
  ) => {
    const extract = (window as unknown as Record<string, unknown>)[
      bridgeKey
    ] as typeof extractJobDraft | undefined;
    return extract?.(detectionArg, templatesArg);
  };

  try {
    const [result] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: callBridgedExtractor,
      args: [JOB_DRAFT_EXTRACTOR_BRIDGE_KEY, detection, matchingTemplates],
    });

    const extraction = result?.result;
    if (!extraction) {
      return errorResponse(
        'EXTRACT_EMPTY',
        'No job data was found on this page.',
      );
    }

    const parsedDraft = safeParseDraftWithFallback(extraction.draft);
    if (!parsedDraft.success) {
      return errorResponse(
        'EXTRACT_FAILED',
        'The page returned job data in an unexpected shape.',
      );
    }

    return {
      type: 'EXTRACT_ACTIVE_TAB_RESULT',
      ok: true,
      draft: parsedDraft.data,
      candidates: filterInvalidCandidates(extraction.candidates),
      ...(extraction.appliedTemplate
        ? { applied_template: extraction.appliedTemplate }
        : {}),
    };
  } catch {
    return errorResponse(
      'EXTRACT_FAILED',
      'Chrome could not read the active tab. Try reloading the page and opening the popup again.',
    );
  }
}

// safeParseDraftWithFallback strips invalid fields out of the returned
// draft, but the raw candidates object it's paired with comes from the same
// unvalidated page-script output -- without this, the field-review picker
// could still offer a value that was just rejected from the draft as a
// selectable option. Drop any candidate whose value doesn't pass its
// field's own schema, so the picker never re-surfaces something already
// known to be invalid.
function filterInvalidCandidates(
  candidates: unknown,
): Record<string, ExtractionCandidate[]> {
  if (!candidates || typeof candidates !== 'object') return {};

  const shape = jobDraftSchema.shape as Record<
    string,
    { safeParse: (value: unknown) => { success: boolean } }
  >;
  const filtered: Record<string, ExtractionCandidate[]> = {};

  for (const [field, list] of Object.entries(
    candidates as Record<string, unknown>,
  ).slice(0, 30)) {
    const fieldSchema = shape[field];
    if (!fieldSchema || !Array.isArray(list)) continue;

    const validList = (list as ExtractionCandidate[])
      .slice(0, 20)
      .filter((candidate) => fieldSchema.safeParse(candidate.value).success);
    if (validList.length > 0) {
      filtered[field] = validList;
    }
  }

  return filtered;
}

function safeParseDraftWithFallback(raw: unknown) {
  const first = jobDraftSchema.safeParse(raw);
  if (
    first.success ||
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return first;
  }

  const cleaned: Record<string, unknown> = {
    ...(raw as Record<string, unknown>),
  };
  for (const issue of first.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && key in cleaned) {
      Reflect.deleteProperty(cleaned, key);
    }
  }
  return jobDraftSchema.safeParse(cleaned);
}

function enqueueSaveJob(draft: JobDraft): Promise<ExtensionResponse> {
  let response: ExtensionResponse | undefined;
  const operation = saveJobQueue
    .catch(() => undefined)
    .then(async () => {
      response = await saveJob(draft);
    });
  saveJobQueue = operation;
  return operation.then(() => {
    if (!response) throw new Error('Save queue did not produce a response.');
    return response;
  });
}

async function saveJob(draft: JobDraft): Promise<ExtensionResponse> {
  try {
    const payload = buildScrapePayload(draft);
    const result = await upsertJob(payload);
    return { type: 'SAVE_JOB_LOCAL_RESULT', ok: true, payload, result };
  } catch (error) {
    if (error instanceof ZodError) {
      return errorResponse(
        'PAYLOAD_INVALID',
        'Review the required fields before saving this job.',
        error.message,
      );
    }
    return errorResponse(
      'STORAGE_FAILED',
      'Could not store this job locally. Your draft has been kept so you can retry.',
      error instanceof Error ? error.message : undefined,
    );
  }
}

function errorResponse(
  code: ExtensionErrorCode,
  message: string,
  details?: string,
): ExtensionResponse {
  return { type: 'ERROR', ok: false, error: { code, message, details } };
}
