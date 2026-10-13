import { browser } from 'wxt/browser';

import { extensionResponseSchema } from '../src/lib/messages';
import {
  buildGenericSelector,
  buildStableSelector,
  findByAttribute,
  inferTemplateRule,
  listDescendantTagNames,
  listScopeTagNames,
  PICKER_CAPTURE_MODES,
  PICKER_FIELDS,
  type PickerCaptureMode,
  previewText,
  queryAcross,
  suggestPathPattern,
} from '../src/lib/templates/picker';
import { TEMPLATE_PICKER_BRIDGE_KEY } from '../src/lib/templates/pickerBridge';
import { applyReplacement, URL_ATTRIBUTES } from '../src/lib/templates/replace';
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
      .field-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .field-row input { flex: 1; min-width: 0; }
      .field-row button { flex-shrink: 0; }
      button { padding: 6px 10px; border: 1px solid #6b7280; border-radius: 5px; background: #f9fafb; color: #111827; cursor: pointer; }
      button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
      button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      #rules { padding-left: 20px; overflow-wrap: anywhere; }
      #status[role="alert"] { color: #b91c1c; font-weight: 600; }
      #highlight { position: fixed; z-index: 2147483646; pointer-events: none; border: 3px solid #f59e0b; background: rgba(245,158,11,.12); }
      #refine-panel { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #9ca3af; }
    </style>
    <div id="highlight" hidden></div>
    <section id="picker-panel" role="dialog" aria-modal="false" aria-labelledby="picker-title" tabindex="-1">
      <h2 id="picker-title">Teach Job Tracker this site</h2>
      <p>Select a field, then choose its visible element on the page. Press Escape to cancel selection or close the picker.</p>
      <label>Template name <input id="name" maxlength="120" /></label>
      <label>Matching path <input id="path" maxlength="500" /></label>
      <p>Optional list selection: limit extraction to the active item in a repeated job list.</p>
      <label>List container selector
        <div class="field-row">
          <input id="list-selector" maxlength="500" placeholder="ul.job-list" />
          <button id="pick-list-selector" type="button">Select on page</button>
          <button id="cycle-list-container" type="button">Cycle elements</button>
        </div>
      </label>
      <div id="list-cycle-row" hidden>
        <label id="list-cycle-label">Tag type <select id="list-cycle-tag"></select></label>
        <div class="actions">
          <button id="list-cycle-prev" type="button">◀ Prev</button>
          <button id="list-cycle-next" type="button">Next ▶</button>
          <button id="list-cycle-use" type="button" class="primary">Use this element</button>
          <button id="list-cycle-cancel" type="button">Cancel</button>
        </div>
      </div>
      <label>List item selector
        <div class="field-row">
          <input id="item-selector" maxlength="500" placeholder="li.job-card" />
          <button id="pick-item-selector" type="button">Select on page</button>
          <button id="cycle-item-selector" type="button">Cycle elements</button>
        </div>
      </label>
      <label>Active item class <input id="active-class" maxlength="100" placeholder="vjs-highlight" /></label>
      <label>Capture <select id="capture"></select></label>
      <div id="link-fix" hidden>
        <p>Optional link fix: replace part of a scraped link URL, e.g. change /rc/clk to /viewjob.</p>
        <label>Link text to replace <input id="link-find" maxlength="200" placeholder="/rc/clk" /></label>
        <label>Replace with <input id="link-replace" maxlength="200" placeholder="/viewjob" /></label>
      </div>
      <label>Find by data-testid <input id="testid-value" maxlength="200" placeholder="company-name" /></label>
      <label>Job field <select id="field"></select></label>
      <div class="actions">
        <button id="pick" type="button" class="primary">Select page element</button>
        <button id="testid-find" type="button">Find by data-testid</button>
        <button id="save" type="button">Save template</button>
        <button id="cancel" type="button">Cancel</button>
      </div>
      <p id="status" role="status" aria-live="polite">No fields selected yet.</p>
      <div id="refine-panel" hidden>
        <p>Not quite the right element? Pick a tag type and step through its matches inside the highlighted container.</p>
        <label id="cycle-tag-row">Tag type <select id="cycle-tag"></select></label>
        <div class="actions">
          <button id="cycle-prev" type="button">◀ Prev</button>
          <button id="cycle-next" type="button">Next ▶</button>
        </div>
        <div class="actions">
          <button id="use-candidate" type="button" class="primary">Use this element</button>
          <button id="use-match" type="button">Use this match</button>
          <button id="refine-cancel" type="button">Cancel</button>
        </div>
      </div>
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
  const linkFixRow = requiredElement<HTMLElement>(shadow, '#link-fix');
  const updateLinkFixVisibility = () => {
    linkFixRow.hidden = field.value !== 'job_link';
  };
  field.addEventListener('change', updateLinkFixVisibility);
  updateLinkFixVisibility();
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
  let pickingSelectorFor: 'list-selector' | 'item-selector' | null = null;

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

  let candidate: Element | null = null;
  let cycleMatches: Element[] = [];
  let cycleIndex = 0;

  const refinePanel = requiredElement<HTMLElement>(shadow, '#refine-panel');
  const cycleTagSelect = requiredElement<HTMLSelectElement>(
    shadow,
    '#cycle-tag',
  );
  const cyclePrevButton = requiredElement<HTMLButtonElement>(
    shadow,
    '#cycle-prev',
  );
  const cycleNextButton = requiredElement<HTMLButtonElement>(
    shadow,
    '#cycle-next',
  );
  const useMatchButton = requiredElement<HTMLButtonElement>(
    shadow,
    '#use-match',
  );
  const useCandidateButton = requiredElement<HTMLButtonElement>(
    shadow,
    '#use-candidate',
  );
  const cycleTagRow = requiredElement<HTMLElement>(shadow, '#cycle-tag-row');

  let listCycleMatches: Element[] = [];
  let listCycleIndex = 0;
  let listCycleField: 'list-selector' | 'item-selector' = 'list-selector';
  let listCycleScopes: ParentNode[] = [document];
  const FIELD_SELECTOR_OPTION = '__field__';
  const listCycleRow = requiredElement<HTMLElement>(shadow, '#list-cycle-row');
  const listCycleTagSelect = requiredElement<HTMLSelectElement>(
    shadow,
    '#list-cycle-tag',
  );
  const listCyclePrevButton = requiredElement<HTMLButtonElement>(
    shadow,
    '#list-cycle-prev',
  );
  const listCycleNextButton = requiredElement<HTMLButtonElement>(
    shadow,
    '#list-cycle-next',
  );
  const listCycleUseButton = requiredElement<HTMLButtonElement>(
    shadow,
    '#list-cycle-use',
  );

  function onPointerOver(event: Event) {
    if (!selecting && !pickingSelectorFor) return;
    const target = event.target;
    if (target instanceof Element && !event.composedPath().includes(host)) {
      setHighlight(target);
    }
  }

  function startPickingSelector(inputId: 'list-selector' | 'item-selector') {
    selecting = false;
    if (!refinePanel.hidden) exitRefineMode();
    exitListCycleMode();
    pickingSelectorFor = inputId;
    setHighlight(undefined);
    setStatus(
      `Click the ${inputId === 'list-selector' ? 'list container' : 'a list item'} element on the page.`,
    );
  }

  const listCycleInput = (fieldId: 'list-selector' | 'item-selector') =>
    requiredElement<HTMLInputElement>(shadow, `#${fieldId}`);

  function renderListCycleStatus(prefix = '') {
    const kind = listCycleField === 'list-selector' ? 'container' : 'item';
    if (listCycleMatches.length === 0) {
      setStatus(`${prefix}No matches for that tag as a list ${kind}.`, true);
      return;
    }
    const element = listCycleMatches[listCycleIndex];
    const preview = element ? buildGenericSelector(element) : '';
    setStatus(
      `${prefix}List ${kind} ${String(listCycleIndex + 1)} of ${String(listCycleMatches.length)}${preview ? `: “${preview}”` : ''}.`,
    );
  }

  function refreshListCycleMatches(prefix = '') {
    const choice = listCycleTagSelect.value;
    const selector =
      choice === FIELD_SELECTOR_OPTION
        ? listCycleInput(listCycleField).value.trim()
        : choice;
    listCycleMatches = queryAcross(listCycleScopes, selector).filter(
      (element) => element !== host,
    );
    listCycleIndex = 0;
    setHighlight(listCycleMatches[0]);
    renderListCycleStatus(prefix);
  }

  function listCycleTo(index: number) {
    if (listCycleMatches.length === 0) return;
    listCycleIndex =
      ((index % listCycleMatches.length) + listCycleMatches.length) %
      listCycleMatches.length;
    setHighlight(listCycleMatches[listCycleIndex]);
    renderListCycleStatus();
  }

  function populateListCycleTags(
    useFieldValue: boolean,
    defaultTag: string,
  ): boolean {
    listCycleTagSelect.replaceChildren();
    const typed = useFieldValue
      ? listCycleInput(listCycleField).value.trim()
      : '';
    const typedMatches = typed
      ? queryAcross(listCycleScopes, typed).filter((el) => el !== host)
      : [];
    if (typedMatches.length > 0) {
      const option = document.createElement('option');
      option.value = FIELD_SELECTOR_OPTION;
      option.textContent = `Current selector: ${typed}`;
      listCycleTagSelect.append(option);
    }
    const tags = listScopeTagNames(listCycleScopes);
    for (const tag of tags) {
      const option = document.createElement('option');
      option.value = tag;
      option.textContent = tag;
      listCycleTagSelect.append(option);
    }
    if (typedMatches.length > 0) {
      listCycleTagSelect.value = FIELD_SELECTOR_OPTION;
    } else if (tags.includes(defaultTag)) {
      listCycleTagSelect.value = defaultTag;
    }
    return typedMatches.length > 0 || tags.length > 0;
  }

  function enterListCycleMode(fieldId: 'list-selector' | 'item-selector') {
    selecting = false;
    pickingSelectorFor = null;
    if (!refinePanel.hidden) exitRefineMode();
    listCycleField = fieldId;
    listCycleScopes = [document];
    if (fieldId === 'item-selector') {
      const containerSelector = listCycleInput('list-selector').value.trim();
      const containers = containerSelector
        ? queryAcross([document], containerSelector).filter(
            (element) => element !== host,
          )
        : [];
      if (containers.length > 0) listCycleScopes = containers;
    }
    if (
      !populateListCycleTags(true, fieldId === 'list-selector' ? 'ul' : 'li')
    ) {
      exitListCycleMode();
      setStatus('No elements found to cycle through.', true);
      return;
    }
    listCycleRow.hidden = false;
    refreshListCycleMatches();
  }

  function exitListCycleMode() {
    listCycleMatches = [];
    listCycleIndex = 0;
    listCycleField = 'list-selector';
    listCycleScopes = [document];
    listCycleRow.hidden = true;
    setHighlight(undefined);
  }

  function commitTarget(
    target: Element,
    selectedField: (typeof PICKER_FIELDS)[number],
    captureMode: PickerCaptureMode,
  ): boolean {
    if (
      captureMode === 'link' &&
      !target.closest('a[href], button[formaction], [data-href], [data-url]')
    ) {
      setStatus(
        'That element does not expose a link URL. Select an anchor or a button/link with a URL attribute.',
        true,
      );
      return false;
    }
    const scope = readItemScope(target);
    const selector = buildStableSelector(target, scope);
    if (!selector) {
      setStatus('Could not create a stable selector for that element.', true);
      return false;
    }
    let rule = inferTemplateRule(
      selectedField,
      target,
      selector,
      captureMode,
      scope,
    );
    const find = requiredElement<HTMLInputElement>(
      shadow,
      '#link-find',
    ).value.trim();
    const replacement = requiredElement<HTMLInputElement>(
      shadow,
      '#link-replace',
    ).value.trim();
    const isLinkRule = (URL_ATTRIBUTES as readonly string[]).includes(
      rule.attribute,
    );
    if (find && isLinkRule) rule = { ...rule, replace: { find, replacement } };
    rules.set(selectedField, rule);
    renderRules();

    let preview = previewText(target, captureMode);
    let note = '';
    const matched = scope.querySelector(rule.selector);
    if (matched && isLinkRule) {
      const raw = matched.getAttribute(rule.attribute) ?? '';
      const fixed = applyReplacement(raw, rule.replace);
      if (rule.replace && fixed === raw) {
        note = ` “${find}” was not found in this link, so it was left unchanged.`;
      }
      try {
        preview = new URL(fixed, location.href).toString().slice(0, 160);
      } catch {
        preview = fixed.slice(0, 160);
      }
    }
    setStatus(
      `Mapped ${selectedField.replaceAll('_', ' ')}${preview ? `: “${preview}”` : ''}.${note} Choose another field or save.`,
    );
    return true;
  }

  function readItemScope(target: Element): ParentNode {
    const itemSelector = requiredElement<HTMLInputElement>(
      shadow,
      '#item-selector',
    ).value.trim();
    const activeClass = requiredElement<HTMLInputElement>(
      shadow,
      '#active-class',
    ).value.trim();
    if (!itemSelector || !activeClass) return document;
    try {
      const item = target.closest(itemSelector);
      return item && item !== target ? item : document;
    } catch {
      return document;
    }
  }

  function renderCycleStatus() {
    if (cycleMatches.length === 0) {
      setStatus('No matches for that tag inside the selected element.', true);
      return;
    }
    const match = cycleMatches[cycleIndex];
    const captureMode = capture.value as PickerCaptureMode;
    const preview = match ? previewText(match, captureMode) : '';
    setStatus(
      `Match ${String(cycleIndex + 1)} of ${String(cycleMatches.length)}${preview ? `: “${preview}”` : ''}.`,
    );
  }

  function cycleTo(index: number) {
    if (cycleMatches.length === 0) return;
    cycleIndex =
      ((index % cycleMatches.length) + cycleMatches.length) %
      cycleMatches.length;
    setHighlight(cycleMatches[cycleIndex]);
    renderCycleStatus();
  }

  function onCycleTagChange() {
    if (!candidate) return;
    const tag = cycleTagSelect.value;
    const matches = [...candidate.querySelectorAll(tag)];
    cycleMatches =
      candidate.tagName.toLowerCase() === tag
        ? [candidate, ...matches]
        : matches;
    cycleIndex = 0;
    if (cycleMatches.length > 0) {
      setHighlight(cycleMatches[0]);
    }
    renderCycleStatus();
  }

  function enterRefineMode(target: Element) {
    candidate = target;
    selecting = false;
    pickingSelectorFor = null;
    if (!listCycleRow.hidden) exitListCycleMode();
    setHighlight(target);
    cycleTagRow.hidden = false;
    useCandidateButton.hidden = false;
    cycleTagSelect.replaceChildren();
    for (const tag of listDescendantTagNames(target)) {
      const option = document.createElement('option');
      option.value = tag;
      option.textContent = tag;
      cycleTagSelect.append(option);
    }
    onCycleTagChange();
    refinePanel.hidden = false;
    setStatus(
      `Selected <${target.tagName.toLowerCase()}>. Use this element, or pick a tag type to step through its matches inside it.`,
    );
  }

  function enterTestIdMode(matches: Element[], value: string) {
    candidate = null;
    selecting = false;
    pickingSelectorFor = null;
    if (!listCycleRow.hidden) exitListCycleMode();
    cycleMatches = matches;
    cycleIndex = 0;
    cycleTagRow.hidden = true;
    useCandidateButton.hidden = true;
    refinePanel.hidden = false;
    setHighlight(matches[0]);
    setStatus(
      `Found ${String(matches.length)} element${matches.length === 1 ? '' : 's'} with data-testid="${value}".${matches.length > 1 ? ' Step through with Prev/Next, then u' : ' U'}se this match.`,
    );
  }

  function exitRefineMode() {
    candidate = null;
    cycleMatches = [];
    cycleIndex = 0;
    cycleTagRow.hidden = false;
    useCandidateButton.hidden = false;
    refinePanel.hidden = true;
    setHighlight(undefined);
  }

  function onPageClick(event: MouseEvent) {
    if (event.composedPath().includes(host)) return;
    if (pickingSelectorFor) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = event.target;
      if (!(target instanceof Element)) return;
      const selector = buildGenericSelector(target);
      requiredElement<HTMLInputElement>(
        shadow,
        `#${pickingSelectorFor}`,
      ).value = selector;
      setStatus(
        `Set ${pickingSelectorFor === 'list-selector' ? 'list container selector' : 'list item selector'} to “${selector}”.`,
      );
      pickingSelectorFor = null;
      setHighlight(undefined);
      return;
    }
    if (!selecting) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target;
    if (!(target instanceof Element)) return;
    enterRefineMode(target);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!refinePanel.hidden && !isEditableTarget(event)) {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        cycleTo(cycleIndex + 1);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        cycleTo(cycleIndex - 1);
        return;
      }
    }
    if (!listCycleRow.hidden && !isEditableTarget(event)) {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        listCycleTo(listCycleIndex + 1);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        listCycleTo(listCycleIndex - 1);
        return;
      }
    }
    if (event.key !== 'Escape') return;
    if (pickingSelectorFor) {
      pickingSelectorFor = null;
      setHighlight(undefined);
      setStatus('Selector pick cancelled.');
    } else if (!listCycleRow.hidden) {
      exitListCycleMode();
      setStatus('Element cycling cancelled.');
    } else if (!refinePanel.hidden) {
      exitRefineMode();
      setStatus('Refinement cancelled.');
      requiredElement<HTMLButtonElement>(shadow, '#pick').focus();
    } else if (selecting) {
      selecting = false;
      setHighlight(undefined);
      setStatus('Element selection cancelled.');
      requiredElement<HTMLButtonElement>(shadow, '#pick').focus();
    } else {
      cleanup();
    }
  }

  cycleTagSelect.addEventListener('change', onCycleTagChange);
  cyclePrevButton.addEventListener('click', () => {
    cycleTo(cycleIndex - 1);
  });
  cycleNextButton.addEventListener('click', () => {
    cycleTo(cycleIndex + 1);
  });
  useCandidateButton.addEventListener('click', () => {
    if (!candidate) return;
    const selectedField = field.value as (typeof PICKER_FIELDS)[number];
    const captureMode = capture.value as PickerCaptureMode;
    if (commitTarget(candidate, selectedField, captureMode)) {
      exitRefineMode();
      requiredElement<HTMLButtonElement>(shadow, '#pick').focus();
    }
  });
  useMatchButton.addEventListener('click', () => {
    const match = cycleMatches[cycleIndex];
    if (!match) return;
    const selectedField = field.value as (typeof PICKER_FIELDS)[number];
    const captureMode = capture.value as PickerCaptureMode;
    if (commitTarget(match, selectedField, captureMode)) {
      exitRefineMode();
      requiredElement<HTMLButtonElement>(shadow, '#pick').focus();
    }
  });
  requiredElement<HTMLButtonElement>(shadow, '#refine-cancel').addEventListener(
    'click',
    () => {
      exitRefineMode();
      selecting = true;
      setStatus(
        `Select another visible element for ${field.value.replaceAll('_', ' ')}.`,
      );
    },
  );

  requiredElement<HTMLButtonElement>(shadow, '#pick').addEventListener(
    'click',
    () => {
      selecting = true;
      pickingSelectorFor = null;
      if (!listCycleRow.hidden) exitListCycleMode();
      setStatus(
        `Select the visible element for ${field.value.replaceAll('_', ' ')}.`,
      );
    },
  );
  requiredElement<HTMLButtonElement>(
    shadow,
    '#pick-list-selector',
  ).addEventListener('click', () => {
    startPickingSelector('list-selector');
  });
  requiredElement<HTMLButtonElement>(
    shadow,
    '#pick-item-selector',
  ).addEventListener('click', () => {
    startPickingSelector('item-selector');
  });
  requiredElement<HTMLButtonElement>(
    shadow,
    '#cycle-list-container',
  ).addEventListener('click', () => {
    enterListCycleMode('list-selector');
  });
  requiredElement<HTMLButtonElement>(
    shadow,
    '#cycle-item-selector',
  ).addEventListener('click', () => {
    enterListCycleMode('item-selector');
  });
  listCycleTagSelect.addEventListener('change', () => {
    refreshListCycleMatches();
  });
  listCyclePrevButton.addEventListener('click', () => {
    listCycleTo(listCycleIndex - 1);
  });
  listCycleNextButton.addEventListener('click', () => {
    listCycleTo(listCycleIndex + 1);
  });
  listCycleUseButton.addEventListener('click', () => {
    const element = listCycleMatches[listCycleIndex];
    if (!element) return;
    const selector = buildGenericSelector(element);
    listCycleInput(listCycleField).value = selector;
    if (listCycleField === 'list-selector') {
      const prefix = `Set list container selector to “${selector}”. Now cycle an element inside it for the list item selector. `;
      listCycleField = 'item-selector';
      listCycleScopes = [element];
      if (populateListCycleTags(false, 'li')) {
        refreshListCycleMatches(prefix);
        return;
      }
      exitListCycleMode();
      setStatus(`Set list container selector to “${selector}”.`);
      return;
    }
    exitListCycleMode();
    setStatus(`Set list item selector to “${selector}”.`);
  });
  requiredElement<HTMLButtonElement>(
    shadow,
    '#list-cycle-cancel',
  ).addEventListener('click', () => {
    exitListCycleMode();
    setStatus('Element cycling cancelled.');
  });
  requiredElement<HTMLButtonElement>(shadow, '#testid-find').addEventListener(
    'click',
    () => {
      const value = requiredElement<HTMLInputElement>(
        shadow,
        '#testid-value',
      ).value.trim();
      if (!value) {
        setStatus('Enter a data-testid value to search for.', true);
        return;
      }
      const matches = findByAttribute('data-testid', value);
      if (matches.length === 0) {
        setStatus(`No elements found with data-testid="${value}".`, true);
        return;
      }
      enterTestIdMode(matches, value);
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
          const listSelector = requiredElement<HTMLInputElement>(
            shadow,
            '#list-selector',
          ).value.trim();
          const itemSelector = requiredElement<HTMLInputElement>(
            shadow,
            '#item-selector',
          ).value.trim();
          const activeClass = requiredElement<HTMLInputElement>(
            shadow,
            '#active-class',
          ).value.trim();
          if (
            Boolean(itemSelector) !== Boolean(activeClass) ||
            (Boolean(listSelector) && !itemSelector)
          ) {
            throw new Error(
              'Enter the list item selector and active item class together; add a list container selector when the items are inside a UL or OL.',
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
                    ...(listSelector ? { list_selector: listSelector } : {}),
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

function isEditableTarget(event: Event): boolean {
  const origin = event.composedPath()[0];
  return (
    origin instanceof HTMLElement &&
    (origin.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(origin.tagName))
  );
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
