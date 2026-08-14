import { browser } from 'wxt/browser';
import '../styles.css';
import { extensionResponseSchema } from '../../src/lib/messages';

const form = document.querySelector<HTMLFormElement>('#settings-form');
const statusEl = document.querySelector<HTMLDivElement>('#status');

void loadSettings();

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  void persistSettings();
});

async function loadSettings(): Promise<void> {
  const rawResponse: unknown = await browser.runtime.sendMessage({
    type: 'GET_SETTINGS',
  });
  const response = extensionResponseSchema.parse(rawResponse);
  if (!response.ok || response.type !== 'GET_SETTINGS_RESULT') {
    setStatus(
      !response.ok ? response.error.message : 'Could not load settings.',
    );
    return;
  }

  setChecked('#auto-detect', response.settings.autoDetect);
}

async function persistSettings(): Promise<void> {
  const rawResponse: unknown = await browser.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: {
      autoDetect: getChecked('#auto-detect'),
    },
  });

  const response = extensionResponseSchema.parse(rawResponse);
  if (!response.ok || response.type !== 'SAVE_SETTINGS_RESULT') {
    setStatus(
      !response.ok ? response.error.message : 'Could not save settings.',
    );
    return;
  }

  setStatus('Settings saved.');
}

function getChecked(selector: string): boolean {
  return document.querySelector<HTMLInputElement>(selector)?.checked ?? false;
}

function setChecked(selector: string, checked: boolean): void {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (input) input.checked = checked;
}

function setStatus(message: string): void {
  if (statusEl) statusEl.textContent = message;
}
