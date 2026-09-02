import { browser } from 'wxt/browser';

import { extensionResponseSchema } from '../src/lib/messages';
import {
  buildStableSelector,
  inferTemplateRule,
  PICKER_CAPTURE_MODES,
  PICKER_FIELDS,
  type PickerCaptureMode,
  suggestPathPattern,
} from '../src/lib/templates/picker';
import { TEMPLATE_PICKER_BRIDGE_KEY } from '../src/lib/templates/pickerBridge';
import {
  siteTemplateSchema,
  type SiteTemplateRule,
} from '../src/lib/templates/schema';

const HOST_ID = 'job-tracker-template-picker';

export default defineContentScript({
  registration: 'runtime',
  main() {
    (window as unknown as Record<string, unknown>)[TEMPLATE_PICKER_BRIDGE_KEY] =
      startTemplatePicker;
  },
});

function startTemplatePicker(): void {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.shadowRoot?.querySelector<HTMLElement>('#picker-panel')?.focus();
    return;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      #picker-panel { position: fixed; z-index: 2147483647; top: 16px; right: 16px; width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; padding: 16px; border: 2px solid #2563eb; border-radius: 10px; background: #fff; color: #111827; box-shadow: 0 12px 40px rgba(0,0,0,.35); font: 14px/1.4 system-ui, sans-serif; }
      h2 { margin: 0 0 8px; font-size: 18px; }
      p { margin: 8px 0; }
      label { display: grid; gap: 4px; margin: 10px 0; font-weight: 600; }
      input, select, button { box-sizing: border-box; min-height: 34px; font: inherit; }
      input, select { width: 100%; padding: 6px; border: 1px solid #9ca3af; border-radius: 5px; }
      button { padding: 6px 10px; border: 1px solid #6b7280; border-radius: 5px; background: #f9fafb; color: #111827; cursor: pointer; }
      button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
      button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      #rules { padding-left: 20px; overflow-wrap: anywhere; }
      #status[role="alert"] { color: #b91c1c; font-weight: 600; }
      #highlight { position: fixed; z-index: 2147483646; pointer-events: none; border: 3px solid #f59e0b; background: rgba(245,158,11,.12); }
    </style>
    <div id="highlight" hidden></div>
    <section id="picker-panel" role="dialog" aria-modal="false" aria-labelledby="picker-title" tabindex="-1">
      <h2 id="picker-title">Teach Job Tracker this site</h2>
      <p>Select a field, then choose its visible element on the page. Press Escape to cancel selection or close the picker.</p>
      <label>Template name <input id="name" maxlength="120" /></label>
      <label>Matching path <input id="path" maxlength="500" /></label>
      <p>Optional list selection: limit extraction to the active item in a repeated job list.</p>
      <label>List item selector <input id="item-selector" maxlength="500" placeholder="li.job-card" /></label>
      <label>Active item class <input id="active-class" maxlength="100" placeholder="vjs-highlight" /></label>
      <label>Job field <select id="field"></select></label>
      <label>Capture <select id="capture"></select></label>
      <div class="actions">
        <button id="pick" type="button" class="primary">Select page element</button>
        <button id="save" type="button">Save template</button>
        <button id="cancel" type="button">Cancel</button>
      </div>
      <p id="status" role="status" aria-live="polite">No fields selected yet.</p>
      <ol id="rules"></ol>
    </section>
  `;
  document.documentElement.append(host);

  const field = requiredElement<HTMLSelectElement>(shadow, '#field');
  for (const optionValue of PICKER_FIELDS) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionValue.replaceAll('_', ' ');
    field.append(option);
  }
  const capture = requiredElement<HTMLSelectElement>(shadow, '#capture');
  for (const mode of PICKER_CAPTURE_MODES) {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent =
      mode === 'link'
        ? 'Link URL'
        : mode === 'link_text'
          ? 'Link text'
          : 'Element text';
    capture.append(option);
  }
  requiredElement<HTMLInputElement>(shadow, '#name').value =
    `${location.hostname} jobs`;
  requiredElement<HTMLInputElement>(shadow, '#path').value = suggestPathPattern(
    location.href,
  );

  const rules = new Map<string, SiteTemplateRule>();
  let selecting = false;

  const cleanup = () => {
    document.removeEventListener('pointerover', onPointerOver, true);
    document.removeEventListener('click', onPageClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    host.remove();
  };

  const setStatus = (message: string, alert = false) => {
    const status = requiredElement<HTMLElement>(shadow, '#status');
    status.textContent = message;
    status.setAttribute('role', alert ? 'alert' : 'status');
  };

  const renderRules = () => {
    const list = requiredElement<HTMLOListElement>(shadow, '#rules');
    list.replaceChildren();
    for (const rule of rules.values()) {
      const item = document.createElement('li');
      item.textContent = `${rule.field.replaceAll('_', ' ')}: ${rule.selector}`;
      list.append(item);
    }
  };

  const setHighlight = (element?: Element) => {
    const box = requiredElement<HTMLElement>(shadow, '#highlight');
    if (!element) {
      box.hidden = true;
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${String(rect.left)}px`,
      top: `${String(rect.top)}px`,
      width: `${String(rect.width)}px`,
      height: `${String(rect.height)}px`,
    });
    box.hidden = false;
  };

  function onPointerOver(event: Event) {
    if (!selecting) return;
    const target = event.target;
    if (target instanceof Element && !event.composedPath().includes(host)) {
      setHighlight(target);
    }
  }

  function onPageClick(event: MouseEvent) {
    if (!selecting || event.composedPath().includes(host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target;
    if (!(target instanceof Element)) return;
    const selectedField = field.value as (typeof PICKER_FIELDS)[number];
    const captureMode = capture.value as PickerCaptureMode;
    if (
      captureMode === 'link' &&
      !target.closest('a[href], button[formaction], [data-href], [data-url]')
    ) {
      setStatus(
        'That element does not expose a link URL. Select an anchor or a button/link with a URL attribute.',
        true,
      );
      return;
    }
    const selector = buildStableSelector(target);
    if (!selector) {
      setStatus('Could not create a stable selector for that element.', true);
      return;
    }
    rules.set(
      selectedField,
      inferTemplateRule(selectedField, target, selector, captureMode),
    );
    selecting = false;
    setHighlight(undefined);
    renderRules();
    const linkTarget = target.closest(
      'a[href], button[formaction], [data-href], [data-url]',
    );
    const previewSource =
      captureMode === 'link'
        ? (linkTarget?.getAttribute('href') ??
          linkTarget?.getAttribute('formaction') ??
          linkTarget?.getAttribute('data-href') ??
          linkTarget?.getAttribute('data-url') ??
          '')
        : (linkTarget?.textContent ?? target.textContent ?? '');
    const preview = previewSource.replace(/\s+/g, ' ').trim().slice(0, 160);
    setStatus(
      `Mapped ${selectedField.replaceAll('_', ' ')}${preview ? `: “${preview}”` : ''}. Choose another field or save.`,
    );
    requiredElement<HTMLButtonElement>(shadow, '#pick').focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (selecting) {
      selecting = false;
      setHighlight(undefined);
      setStatus('Element selection cancelled.');
      requiredElement<HTMLButtonElement>(shadow, '#pick').focus();
    } else {
      cleanup();
    }
  }

  requiredElement<HTMLButtonElement>(shadow, '#pick').addEventListener(
    'click',
    () => {
      selecting = true;
      setStatus(
        `Select the visible element for ${field.value.replaceAll('_', ' ')}.`,
      );
    },
  );
  requiredElement<HTMLButtonElement>(shadow, '#cancel').addEventListener(
    'click',
    cleanup,
  );
  requiredElement<HTMLButtonElement>(shadow, '#save').addEventListener(
    'click',
    () => {
      void (async () => {
        if (rules.size === 0) {
          setStatus('Select at least one page element before saving.', true);
          return;
        }
        try {
          const timestamp = new Date().toISOString();
          const itemSelector = requiredElement<HTMLInputElement>(
            shadow,
            '#item-selector',
          ).value.trim();
          const activeClass = requiredElement<HTMLInputElement>(
            shadow,
            '#active-class',
          ).value.trim();
          if (Boolean(itemSelector) !== Boolean(activeClass)) {
            throw new Error(
              'Enter both the list item selector and active item class, or leave both blank.',
            );
          }
          const template = siteTemplateSchema.parse({
            id: crypto.randomUUID(),
            name: requiredElement<HTMLInputElement>(shadow, '#name').value,
            hostname: location.hostname,
            path_pattern: requiredElement<HTMLInputElement>(shadow, '#path')
              .value,
            enabled: true,
            priority: 50,
            rules: [...rules.values()],
            ...(itemSelector && activeClass
              ? {
                  selection: {
                    item_selector: itemSelector,
                    active_class: activeClass,
                  },
                }
              : {}),
            created_at: timestamp,
            updated_at: timestamp,
          });
          const rawResponse: unknown = await browser.runtime.sendMessage({
            type: 'SAVE_SITE_TEMPLATE',
            template,
          });
          const response = extensionResponseSchema.parse(rawResponse);
          if (!response.ok) throw new Error(response.error.message);
          if (response.type !== 'SAVE_SITE_TEMPLATE_RESULT') {
            throw new Error('Unexpected response while saving the template.');
          }
          setStatus(
            `Saved “${template.name}”. Future matching pages will extract automatically.`,
          );
          window.setTimeout(cleanup, 1_200);
        } catch (error) {
          setStatus(
            error instanceof Error
              ? error.message
              : 'Could not save the template.',
            true,
          );
        }
      })();
    },
  );

  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('click', onPageClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  requiredElement<HTMLElement>(shadow, '#picker-panel').focus();
}

function requiredElement<T extends Element>(
  root: ParentNode,
  selector: string,
  guard?: (element: Element) => element is T,
): T {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Picker element not found: ${selector}`);
  if (guard && !guard(element)) {
    throw new Error(`Picker element has the wrong type: ${selector}`);
  }
  return element as T;
}
