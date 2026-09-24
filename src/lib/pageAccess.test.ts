import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserMock = vi.hoisted(() => ({
  tabs: { query: vi.fn() },
  scripting: { executeScript: vi.fn() },
  permissions: { request: vi.fn() },
}));

vi.mock('wxt/browser', () => ({ browser: browserMock }));

import { ensureFocusedPageAccess } from './pageAccess';

describe('ensureFocusedPageAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not prompt when the focused page is already scriptable', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://jobs.example.com/a' },
    ]);
    browserMock.scripting.executeScript.mockResolvedValue([]);

    await expect(ensureFocusedPageAccess()).resolves.toEqual({ ok: true });
    expect(browserMock.permissions.request).not.toHaveBeenCalled();
  });

  it('requests only the focused page origin when scripting is blocked', async () => {
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://jobs.example.com/a?x=1' },
    ]);
    browserMock.scripting.executeScript.mockRejectedValue(new Error('denied'));
    browserMock.permissions.request.mockResolvedValue(true);

    await expect(ensureFocusedPageAccess()).resolves.toEqual({ ok: true });
    expect(browserMock.permissions.request).toHaveBeenCalledWith({
      origins: ['https://jobs.example.com/*'],
    });
  });

  it('asks for tab visibility first when the focused tab url is hidden', async () => {
    browserMock.tabs.query
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 1, url: 'https://jobs.example.com/a' }]);
    browserMock.scripting.executeScript.mockRejectedValue(new Error('denied'));
    browserMock.permissions.request.mockResolvedValue(true);

    await expect(ensureFocusedPageAccess()).resolves.toEqual({ ok: true });
    expect(browserMock.permissions.request).toHaveBeenNthCalledWith(1, {
      permissions: ['tabs'],
    });
    expect(browserMock.permissions.request).toHaveBeenNthCalledWith(2, {
      origins: ['https://jobs.example.com/*'],
    });
  });

  it('fails when the focused tab changes while access is being checked', async () => {
    browserMock.tabs.query
      .mockResolvedValueOnce([{ id: 1, url: 'https://jobs.example.com/a' }])
      .mockResolvedValueOnce([{ id: 2, url: 'https://other.example.com/b' }]);
    browserMock.scripting.executeScript.mockResolvedValue([]);

    const result = await ensureFocusedPageAccess();
    expect(result.ok).toBe(false);
  });

  it('reports a denial and rejects non-http pages', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('denied'));
    browserMock.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://jobs.example.com/a' },
    ]);
    browserMock.permissions.request.mockResolvedValue(false);
    const denied = await ensureFocusedPageAccess();
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.message).toContain('https://jobs.example.com');

    browserMock.tabs.query.mockResolvedValue([
      { id: 2, url: 'chrome://extensions' },
    ]);
    await expect(ensureFocusedPageAccess()).resolves.toMatchObject({
      ok: false,
      message: 'Open an HTTP(S) job page first.',
    });
  });
});
