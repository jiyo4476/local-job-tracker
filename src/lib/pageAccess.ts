import { browser } from 'wxt/browser';

export type PageAccessResult = { ok: true } | { ok: false; message: string };

type ResolvedAccess =
  { ok: true; tabId: number } | { ok: false; message: string };

async function canScript(tabId: number): Promise<boolean> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      func: () => true,
    });
    return true;
  } catch {
    return false;
  }
}

// Must be called from a user-gesture handler in an extension page. activeTab
// only covers the tab focused when the toolbar icon was clicked, so a side
// panel that stays open across tab switches has to ask for the focused page.
async function resolveFocusedPageAccess(): Promise<ResolvedAccess> {
  const [initial] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (initial?.id === undefined) {
    return { ok: false, message: 'No active web page is available.' };
  }
  const tabId = initial.id;
  if (await canScript(tabId)) return { ok: true, tabId };

  let tab: chrome.tabs.Tab | undefined = initial;
  if (!tab.url) {
    const grantedTabs = await browser.permissions.request({
      permissions: ['tabs'],
    });
    if (!grantedTabs) {
      return {
        ok: false,
        message:
          'Local Job Tracker needs permission to see which page is focused. Click again and allow it, or click the toolbar icon on the job page.',
      };
    }
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  }

  let origin: string;
  try {
    const url = new URL(tab?.url ?? '');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('scheme');
    origin = url.origin;
  } catch {
    return { ok: false, message: 'Open an HTTP(S) job page first.' };
  }

  let granted: boolean;
  try {
    granted = await browser.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    return {
      ok: false,
      message: `Permission for tab access was saved. Click again to allow access to ${origin}.`,
    };
  }
  if (!granted) {
    return {
      ok: false,
      message: `Access to ${origin} was not granted, so this page cannot be read.`,
    };
  }
  return { ok: true, tabId };
}

// The background re-queries the focused tab, so confirm the user did not
// switch tabs while a check or permission prompt was pending.
export async function ensureFocusedPageAccess(): Promise<PageAccessResult> {
  const access = await resolveFocusedPageAccess();
  if (!access.ok) return access;
  const [current] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (current?.id !== access.tabId) {
    return {
      ok: false,
      message:
        'The focused tab changed while access was being checked. Click again on the page you want to read.',
    };
  }
  return { ok: true };
}
