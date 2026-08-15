import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { JOB_DRAFT_EXTRACTOR_BRIDGE_KEY } from './extraction/jobDraftExtractorBridge';
import type { ExtensionMessage, ExtensionResponse } from './messages';
import { emptyFormValues } from './popupForm';

const browserMock = vi.hoisted(() => ({
  runtime: {
    onMessage: {
      addListener: vi.fn(),
    },
  },
  tabs: {
    query: vi.fn(),
    get: vi.fn(),
    onUpdated: {
      addListener: vi.fn(),
    },
    onRemoved: {
      addListener: vi.fn(),
    },
  },
  scripting: {
    executeScript: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
  },
}));

vi.mock('wxt/browser', () => ({
  browser: browserMock,
}));

describe('background save flow', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.stubGlobal('defineBackground', (setup: () => void) => {
      setup();
    });
    browserMock.storage.local.get.mockResolvedValue({});
    browserMock.storage.local.set.mockResolvedValue(undefined);
    browserMock.storage.local.remove.mockResolvedValue(undefined);
    browserMock.tabs.get.mockImplementation((tabId: number) =>
      Promise.resolve({
        id: tabId,
        url: `https://example.com/jobs/${String(tabId)}`,
      }),
    );
  });

  it('saves a job locally without any network round trip', async () => {
    const { handleMessage } = await import('../../entrypoints/background');

    const response: unknown = await handleMessage({
      type: 'SAVE_JOB_LOCAL',
      draft: {
        source_platform: 'indeed',
        external_job_id: 'job-123',
        company_name: 'Acme',
        job_title: 'Software Engineer',
        job_link: 'https://example.com/jobs/job-123',
      },
    });

    expect(response).toMatchObject({
      type: 'SAVE_JOB_LOCAL_RESULT',
      ok: true,
      result: { action: 'created' },
    });
  });

  it('queues concurrent local saves instead of dropping either job', async () => {
    const { handleMessage } = await import('../../entrypoints/background');
    const draft = {
      source_platform: 'indeed' as const,
      company_name: 'Acme',
      job_title: 'Software Engineer',
      job_link: 'https://example.com/jobs/job',
    };

    const [first, second] = await Promise.all([
      handleMessage({
        type: 'SAVE_JOB_LOCAL',
        draft: { ...draft, external_job_id: 'concurrent-1' },
      }),
      handleMessage({
        type: 'SAVE_JOB_LOCAL',
        draft: {
          ...draft,
          external_job_id: 'concurrent-2',
          job_title: 'Product Engineer',
        },
      }),
    ]);

    expect(first).toMatchObject({ ok: true, type: 'SAVE_JOB_LOCAL_RESULT' });
    expect(second).toMatchObject({ ok: true, type: 'SAVE_JOB_LOCAL_RESULT' });
  });

  it('keeps validation failures distinct from local storage failures', async () => {
    const { handleMessage } = await import('../../entrypoints/background');
    const response = await handleMessage({
      type: 'SAVE_JOB_LOCAL',
      draft: { source_platform: 'indeed' },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'PAYLOAD_INVALID' },
    });
  });

  it('reports storage failures with retry-safe draft guidance', async () => {
    vi.doMock('./db/jobsRepo', () => ({
      upsertJob: vi.fn().mockRejectedValue(new Error('Quota exceeded')),
    }));
    const { handleMessage } = await import('../../entrypoints/background');
    const response: unknown = await handleMessage({
      type: 'SAVE_JOB_LOCAL',
      draft: {
        source_platform: 'indeed',
        external_job_id: 'quota-1',
        company_name: 'Acme',
        job_title: 'Engineer',
        job_link: 'https://example.com/jobs/quota-1',
      },
    });
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'STORAGE_FAILED',
      },
    });
    expect(JSON.stringify(response)).toContain('draft has been kept');
    vi.doUnmock('./db/jobsRepo');
  });

  it('returns only non-sensitive settings to extension pages', async () => {
    const { handleMessage } = await import('../../entrypoints/background');

    const response = await handleMessage({ type: 'GET_SETTINGS' });
    expect(response).toEqual({
      type: 'GET_SETTINGS_RESULT',
      ok: true,
      settings: { autoDetect: true },
    });
  });

  it('detects the platform from the active tab URL and passes it to extraction', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://www.indeed.com/viewjob?jk=abc123' },
    ]);
    browserMock.scripting.executeScript.mockResolvedValue([
      {
        result: {
          draft: {
            source_platform: 'indeed',
            external_job_id: 'abc123',
            company_name: 'Acme',
            job_title: 'Software Engineer',
            job_link: 'https://www.indeed.com/viewjob?jk=abc123',
          },
          candidates: {},
        },
      },
    ]);
    const { handleMessage } = await import('../../entrypoints/background');

    const response = await handleMessage({ type: 'EXTRACT_ACTIVE_TAB' });

    expect(response).toMatchObject({
      type: 'EXTRACT_ACTIVE_TAB_RESULT',
      ok: true,
    });
    expect(browserMock.scripting.executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 1 },
      files: ['/content-scripts/content.js'],
    });
    expect(browserMock.scripting.executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: [
          JOB_DRAFT_EXTRACTOR_BRIDGE_KEY,
          {
            platform: 'indeed',
            confidence: 'high',
            externalJobId: 'abc123',
          },
          [],
        ],
      }),
    );
  });

  it('applies a saved template on an otherwise unsupported company careers site', async () => {
    const { handleMessage } = await import('../../entrypoints/background');
    const timestamp = new Date().toISOString();
    const template = {
      id: crypto.randomUUID(),
      name: 'Acme careers',
      hostname: 'careers.acme.example',
      path_pattern: '/jobs/*',
      enabled: true,
      priority: 50,
      rules: [
        {
          field: 'job_title' as const,
          selector: 'h1',
          attribute: 'text' as const,
          multiple: false,
          transforms: ['trim' as const],
        },
      ],
      created_at: timestamp,
      updated_at: timestamp,
    };
    await handleMessage({ type: 'SAVE_SITE_TEMPLATE', template });
    browserMock.tabs.query.mockResolvedValue([
      { id: 7, url: 'https://careers.acme.example/jobs/123' },
    ]);
    browserMock.scripting.executeScript.mockResolvedValue([
      {
        result: {
          draft: { source_platform: 'direct', job_title: 'Engineer' },
          candidates: {},
          appliedTemplate: { id: template.id, name: template.name },
        },
      },
    ]);

    const response = await handleMessage({ type: 'EXTRACT_ACTIVE_TAB' });

    expect(response).toMatchObject({
      type: 'EXTRACT_ACTIVE_TAB_RESULT',
      ok: true,
      applied_template: { id: template.id, name: template.name },
    });
    expect(browserMock.scripting.executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: [
          JOB_DRAFT_EXTRACTOR_BRIDGE_KEY,
          { platform: 'direct', confidence: 'low' },
          [expect.objectContaining({ id: template.id })],
        ],
      }),
    );
  });

  it('injects the user-triggered picker only into an active HTTP(S) tab', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 8, url: 'https://careers.example.com/jobs/123' },
    ]);
    browserMock.scripting.executeScript.mockResolvedValue([]);
    const { handleMessage } = await import('../../entrypoints/background');

    await expect(
      handleMessage({ type: 'START_TEMPLATE_PICKER' }),
    ).resolves.toEqual({ type: 'START_TEMPLATE_PICKER_RESULT', ok: true });
    expect(browserMock.scripting.executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 8 },
      files: ['/content-scripts/template-picker.js'],
    });
  });

  it('returns TAB_NOT_FOUND when no active tab is available', async () => {
    browserMock.tabs.query.mockResolvedValue([]);
    const { handleMessage } = await import('../../entrypoints/background');

    const response = await handleMessage({ type: 'EXTRACT_ACTIVE_TAB' });

    expect(response).toMatchObject({
      type: 'ERROR',
      ok: false,
      error: { code: 'TAB_NOT_FOUND' },
    });
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('does not inject the scraper on unsupported domains', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://mail.example.com/inbox' },
    ]);
    const { handleMessage } = await import('../../entrypoints/background');

    const response = await handleMessage({ type: 'EXTRACT_ACTIVE_TAB' });

    expect(response).toMatchObject({
      type: 'ERROR',
      ok: false,
      error: { code: 'DOMAIN_NOT_SUPPORTED' },
    });
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('does not inject the scraper on non-job pages of supported domains', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://www.linkedin.com/feed/' },
    ]);
    const { handleMessage } = await import('../../entrypoints/background');

    const response = await handleMessage({ type: 'EXTRACT_ACTIVE_TAB' });

    expect(response).toMatchObject({
      type: 'ERROR',
      ok: false,
      error: { code: 'DOMAIN_NOT_SUPPORTED' },
    });
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('does not inject the scraper on a bare Indeed results page', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://www.indeed.com/jobs?q=engineer' },
    ]);
    const { handleMessage } = await import('../../entrypoints/background');

    const response = await handleMessage({ type: 'EXTRACT_ACTIVE_TAB' });

    expect(response).toMatchObject({
      type: 'ERROR',
      ok: false,
      error: { code: 'DOMAIN_NOT_SUPPORTED' },
    });
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('strips only the invalid field from a partially malformed draft instead of discarding it entirely', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://www.glassdoor.com/job-listing/foo.htm' },
    ]);
    browserMock.scripting.executeScript.mockResolvedValue([
      {
        result: {
          draft: {
            source_platform: 'glassdoor',
            external_job_id: 'foo',
            company_name: 'Acme',
            job_title: 'Software Engineer',
            job_link: 'not a valid url',
          },
          candidates: {},
        },
      },
    ]);
    const { handleMessage } = await import('../../entrypoints/background');

    const response = await handleMessage({ type: 'EXTRACT_ACTIVE_TAB' });

    expect(response).toMatchObject({
      type: 'EXTRACT_ACTIVE_TAB_RESULT',
      ok: true,
      draft: {
        source_platform: 'glassdoor',
        external_job_id: 'foo',
        company_name: 'Acme',
        job_title: 'Software Engineer',
      },
    });
    expect(response).not.toHaveProperty('draft.job_link');
  });

  it('drops an invalid candidate value from the picker instead of re-offering something already stripped from the draft', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://www.glassdoor.com/job-listing/foo.htm' },
    ]);
    browserMock.scripting.executeScript.mockResolvedValue([
      {
        result: {
          draft: {
            source_platform: 'glassdoor',
            external_job_id: 'foo',
            company_name: 'Acme',
            job_title: 'Software Engineer',
            job_link: 'not a valid url',
          },
          candidates: {
            job_link: [
              {
                value: 'not a valid url',
                source: 'meta',
                confidence: 'medium',
              },
              {
                value: 'https://example.com/jobs/foo',
                source: 'url',
                confidence: 'medium',
              },
            ],
          },
        },
      },
    ]);
    const { handleMessage } = await import('../../entrypoints/background');

    const response = await handleMessage({ type: 'EXTRACT_ACTIVE_TAB' });

    expect(response).toMatchObject({
      type: 'EXTRACT_ACTIVE_TAB_RESULT',
      ok: true,
      candidates: {
        job_link: [{ value: 'https://example.com/jobs/foo', source: 'url' }],
      },
    });
  });

  it('reports EXTRACT_FAILED instead of an empty draft when the injected script returns an array', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://www.glassdoor.com/job-listing/foo.htm' },
    ]);
    browserMock.scripting.executeScript.mockResolvedValue([
      { result: { draft: ['not', 'a', 'draft', 'object'], candidates: {} } },
    ]);
    const { handleMessage } = await import('../../entrypoints/background');

    const response = await handleMessage({ type: 'EXTRACT_ACTIVE_TAB' });

    expect(response).toMatchObject({
      type: 'ERROR',
      ok: false,
      error: { code: 'EXTRACT_FAILED' },
    });
  });

  it('serializes popup draft writes in the background worker', async () => {
    let finishFirstWrite: (() => void) | undefined;
    browserMock.storage.local.set
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstWrite = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const { handleMessage } = await import('../../entrypoints/background');
    const context = { tabId: 42, url: 'https://example.com/jobs/42' };
    await initializeDraftContext(handleMessage, context);
    const firstValues = { ...emptyFormValues(), job_title: 'First' };
    const secondValues = { ...emptyFormValues(), job_title: 'Second' };

    const first = handleMessage({
      type: 'SAVE_POPUP_DRAFT',
      context,
      values: firstValues,
    });
    const second = handleMessage({
      type: 'SAVE_POPUP_DRAFT',
      context,
      values: secondValues,
    });

    await vi.waitFor(() => {
      expect(browserMock.storage.local.set).toHaveBeenCalledTimes(1);
    });
    finishFirstWrite?.();
    await expect(first).resolves.toEqual({
      type: 'SAVE_POPUP_DRAFT_RESULT',
      ok: true,
    });
    await expect(second).resolves.toEqual({
      type: 'SAVE_POPUP_DRAFT_RESULT',
      ok: true,
    });
    const secondPayload: unknown =
      browserMock.storage.local.set.mock.calls[1]?.[0];
    expect(secondPayload).toMatchObject({
      'jobTracker.popupDraft': { values: secondValues },
    });
  });

  it('stores a save-time edit after the successful-save clear', async () => {
    const operations: string[] = [];
    const context = { tabId: 42, url: 'https://example.com/jobs/42' };
    const storedValues = emptyFormValues();
    const editedValues = { ...storedValues, job_title: 'Edited during save' };
    browserMock.storage.local.get.mockResolvedValue({
      'jobTracker.popupDraft': {
        ...context,
        values: storedValues,
        updatedAt: 1,
      },
    });
    browserMock.storage.local.remove.mockImplementation(() => {
      operations.push('clear');
      return Promise.resolve();
    });
    browserMock.storage.local.set.mockImplementation(() => {
      operations.push('save edit');
      return Promise.resolve();
    });
    const { handleMessage } = await import('../../entrypoints/background');
    await initializeDraftContext(handleMessage, context);

    const clear = handleMessage({ type: 'CLEAR_POPUP_DRAFT', context });
    const saveEdit = handleMessage({
      type: 'SAVE_POPUP_DRAFT',
      context,
      values: editedValues,
    });

    await expect(clear).resolves.toEqual({
      type: 'CLEAR_POPUP_DRAFT_RESULT',
      ok: true,
    });
    await expect(saveEdit).resolves.toEqual({
      type: 'SAVE_POPUP_DRAFT_RESULT',
      ok: true,
    });
    expect(operations).toEqual(['clear', 'save edit']);
  });

  it('rejects a queued draft write after same-origin SPA navigation', async () => {
    let finishFirstWrite: (() => void) | undefined;
    browserMock.storage.local.set.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstWrite = resolve;
        }),
    );
    const { handleMessage } = await import('../../entrypoints/background');
    const context = { tabId: 42, url: 'https://example.com/jobs/42' };
    await initializeDraftContext(handleMessage, context);
    const first = handleMessage({
      type: 'SAVE_POPUP_DRAFT',
      context,
      values: emptyFormValues(),
    });
    const stale = handleMessage({
      type: 'SAVE_POPUP_DRAFT',
      context,
      values: { ...emptyFormValues(), job_title: 'Stale' },
    });

    await vi.waitFor(() => {
      expect(browserMock.storage.local.set).toHaveBeenCalledTimes(1);
    });
    const { onUpdated } = getLifecycleListeners();
    onUpdated(context.tabId, { url: 'https://example.com/jobs/43' });
    browserMock.tabs.get.mockResolvedValue({
      id: context.tabId,
      url: 'https://example.com/jobs/43',
    });
    browserMock.storage.local.get.mockResolvedValue({
      'jobTracker.popupDraft': {
        ...context,
        values: emptyFormValues(),
        updatedAt: 1,
      },
    });
    finishFirstWrite?.();

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(stale).resolves.toMatchObject({
      ok: false,
      error: { code: 'POPUP_CONTEXT_STALE' },
    });
    await vi.waitFor(() => {
      expect(browserMock.storage.local.remove).toHaveBeenCalledTimes(1);
    });
    expect(browserMock.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it('rejects old-context writes after full navigation starts', async () => {
    const { handleMessage } = await import('../../entrypoints/background');
    const context = { tabId: 42, url: 'https://example.com/jobs/42' };
    await initializeDraftContext(handleMessage, context);
    getLifecycleListeners().onUpdated(context.tabId, { status: 'loading' });

    await expect(
      handleMessage({
        type: 'SAVE_POPUP_DRAFT',
        context,
        values: emptyFormValues(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'POPUP_CONTEXT_STALE' },
    });
    expect(browserMock.storage.local.set).not.toHaveBeenCalled();
  });

  it('rejects old-context writes after tab closure', async () => {
    const { handleMessage } = await import('../../entrypoints/background');
    const context = { tabId: 42, url: 'https://example.com/jobs/42' };
    await initializeDraftContext(handleMessage, context);
    getLifecycleListeners().onRemoved(context.tabId);

    await expect(
      handleMessage({
        type: 'SAVE_POPUP_DRAFT',
        context,
        values: emptyFormValues(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'POPUP_CONTEXT_STALE' },
    });
    expect(browserMock.storage.local.set).not.toHaveBeenCalled();

    // Chrome may eventually reuse a numeric tab ID. A fresh popup context
    // must get a new generation rather than retaining the removed tab's state.
    await initializeDraftContext(handleMessage, context);
    await expect(
      handleMessage({
        type: 'SAVE_POPUP_DRAFT',
        context,
        values: emptyFormValues(),
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('keeps genuine draft storage failures distinct from stale contexts', async () => {
    const { handleMessage } = await import('../../entrypoints/background');
    const context = { tabId: 42, url: 'https://example.com/jobs/42' };
    await initializeDraftContext(handleMessage, context);
    browserMock.storage.local.set.mockRejectedValue(
      new Error('quota exceeded'),
    );

    await expect(
      handleMessage({
        type: 'SAVE_POPUP_DRAFT',
        context,
        values: emptyFormValues(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'STORAGE_FAILED' },
    });
  });

  it('requires context reinitialization after a permanent draft clear', async () => {
    const { handleMessage } = await import('../../entrypoints/background');
    const context = { tabId: 42, url: 'https://example.com/jobs/42' };
    await initializeDraftContext(handleMessage, context);

    await expect(
      handleMessage({ type: 'CLEAR_POPUP_DRAFT', context }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      handleMessage({
        type: 'SAVE_POPUP_DRAFT',
        context,
        values: emptyFormValues(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'POPUP_CONTEXT_STALE' },
    });

    await initializeDraftContext(handleMessage, context);
    await expect(
      handleMessage({
        type: 'SAVE_POPUP_DRAFT',
        context,
        values: emptyFormValues(),
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('invalidates the matching tab draft on navigation and tab removal', async () => {
    const context = { tabId: 42, url: 'https://example.com/jobs/42' };
    browserMock.storage.local.get.mockResolvedValue({
      'jobTracker.popupDraft': {
        ...context,
        values: emptyFormValues(),
        updatedAt: 1,
      },
    });
    await import('../../entrypoints/background');
    const rawOnUpdated: unknown =
      browserMock.tabs.onUpdated.addListener.mock.calls.at(-1)?.[0];
    const rawOnRemoved: unknown =
      browserMock.tabs.onRemoved.addListener.mock.calls.at(-1)?.[0];
    if (
      typeof rawOnUpdated !== 'function' ||
      typeof rawOnRemoved !== 'function'
    ) {
      throw new Error('Expected background tab lifecycle listeners.');
    }
    const onUpdated = rawOnUpdated as (
      tabId: number,
      changeInfo: { status?: string; url?: string },
    ) => void;
    const onRemoved = rawOnRemoved as (tabId: number) => void;

    onUpdated?.(context.tabId, { status: 'complete' });
    expect(browserMock.storage.local.remove).not.toHaveBeenCalled();

    onUpdated(context.tabId, { url: 'https://example.com/jobs/43' });
    await vi.waitFor(() => {
      expect(browserMock.storage.local.remove).toHaveBeenCalledTimes(1);
    });

    onUpdated(context.tabId, { status: 'loading' });
    await vi.waitFor(() => {
      expect(browserMock.storage.local.remove).toHaveBeenCalledTimes(2);
    });

    onRemoved(context.tabId);
    await vi.waitFor(() => {
      expect(browserMock.storage.local.remove).toHaveBeenCalledTimes(3);
    });
  });
});

function getLifecycleListeners(): {
  onUpdated: (
    tabId: number,
    changeInfo: { status?: string; url?: string },
  ) => void;
  onRemoved: (tabId: number) => void;
} {
  const onUpdated: unknown =
    browserMock.tabs.onUpdated.addListener.mock.calls.at(-1)?.[0];
  const onRemoved: unknown =
    browserMock.tabs.onRemoved.addListener.mock.calls.at(-1)?.[0];
  if (typeof onUpdated !== 'function' || typeof onRemoved !== 'function') {
    throw new Error('Expected background tab lifecycle listeners.');
  }
  return {
    onUpdated: onUpdated as (
      tabId: number,
      changeInfo: { status?: string; url?: string },
    ) => void,
    onRemoved: onRemoved as (tabId: number) => void,
  };
}

async function initializeDraftContext(
  handleMessage: (message: ExtensionMessage) => Promise<ExtensionResponse>,
  context: { tabId: number; url: string },
): Promise<void> {
  await handleMessage({ type: 'GET_POPUP_DRAFT', context });
}
