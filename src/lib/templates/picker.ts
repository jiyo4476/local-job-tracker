import { templateFieldSchema, type SiteTemplateRule } from './schema';

const STABLE_ATTRIBUTES = [
  'data-testid',
  'data-test-id',
  'data-automation-id',
  'itemprop',
] as const;

export const PICKER_FIELDS = templateFieldSchema.options;

export const PICKER_CAPTURE_MODES = ['text', 'link', 'link_text'] as const;
export type PickerCaptureMode = (typeof PICKER_CAPTURE_MODES)[number];

export function suggestPathPattern(rawUrl: string): string {
  const url = new URL(rawUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '/*';
  segments[segments.length - 1] = '*';
  return `/${segments.join('/')}`;
}

export function buildStableSelector(
  element: Element,
  root: ParentNode = document,
): string {
  const id = element.getAttribute('id');
  if (id && looksStableToken(id)) {
    const selector = `#${escapeIdentifier(id)}`;
    if (isUnique(selector, element, root)) return selector;
  }

  for (const attribute of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (!value || value.length > 200 || !looksStableToken(value, true))
      continue;
    const selector = `${element.tagName.toLowerCase()}[${attribute}="${escapeAttribute(value)}"]`;
    if (isUnique(selector, element, root)) return selector;
  }

  const ariaLabel = element.getAttribute('aria-label');
  if (
    ariaLabel &&
    ariaLabel.length <= 200 &&
    looksStableToken(ariaLabel, true)
  ) {
    const selector = `${element.tagName.toLowerCase()}[aria-label="${escapeAttribute(ariaLabel)}"]`;
    if (isUnique(selector, element, root)) return selector;
  }

  const parts: string[] = [];
  let current: Element | null = element;
  while (
    current &&
    current.tagName.toLowerCase() !== 'html' &&
    parts.length < 8
  ) {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = [...parent.children].filter(
      (sibling) => sibling.tagName === current?.tagName,
    );
    const part =
      siblings.length <= 1
        ? tag
        : `${tag}:nth-of-type(${String(siblings.indexOf(current) + 1)})`;
    parts.unshift(part);
    const selector = parts.join(' > ');
    if (isUnique(selector, element, root)) return selector;
    current = parent;
  }
  return parts.join(' > ');
}

export function inferTemplateRule(
  field: (typeof PICKER_FIELDS)[number],
  element: Element,
  selector: string,
  captureMode: PickerCaptureMode = 'text',
): SiteTemplateRule {
  if (field === 'external_job_id' && element.hasAttribute('data-job-id')) {
    return {
      field,
      selector,
      attribute: 'data-job-id',
      multiple: false,
      transforms: ['trim'],
    };
  }
  if (captureMode === 'link') {
    const link = findLinkTarget(element);
    if (!link) {
      return {
        field,
        selector,
        attribute: 'text',
        multiple: false,
        transforms: ['trim'],
      };
    }
    return {
      field,
      selector: link ? buildStableSelector(link) : selector,
      attribute: linkAttribute(link),
      multiple: false,
      transforms: ['absolute_url'],
    };
  }
  if (field === 'job_link') {
    const link = findLinkTarget(element);
    return {
      field,
      selector: link ? buildStableSelector(link) : selector,
      attribute: link ? linkAttribute(link) : 'href',
      multiple: false,
      transforms: ['absolute_url'],
    };
  }
  if (captureMode === 'link_text') {
    const link = findLinkTarget(element);
    return {
      field,
      selector: link ? buildStableSelector(link) : selector,
      attribute: 'text',
      multiple: false,
      transforms:
        field === 'job_description'
          ? ['safe_markdown']
          : ['trim', 'collapse_whitespace'],
    };
  }
  if (field === 'date_posted' && element.hasAttribute('datetime')) {
    return {
      field,
      selector,
      attribute: 'datetime',
      multiple: false,
      transforms: ['iso_date'],
    };
  }
  if (field === 'job_description') {
    return {
      field,
      selector,
      attribute: 'text',
      multiple: false,
      transforms: ['safe_markdown'],
    };
  }
  if (
    ['salary_min', 'salary_max', 'hourly_rate_min', 'hourly_rate_max'].includes(
      field,
    )
  ) {
    return {
      field,
      selector,
      attribute: 'text',
      multiple: false,
      transforms: ['number'],
    };
  }
  if (field === 'job_type') {
    return {
      field,
      selector,
      attribute: 'text',
      multiple: false,
      transforms: ['job_type'],
    };
  }
  if (field === 'experience_level') {
    return {
      field,
      selector,
      attribute: 'text',
      multiple: false,
      transforms: ['experience_level'],
    };
  }
  if (field === 'salary_type') {
    return {
      field,
      selector,
      attribute: 'text',
      multiple: false,
      transforms: ['salary_type'],
    };
  }
  if (['is_remote', 'security_clearance_req'].includes(field)) {
    return {
      field,
      selector,
      attribute: 'text',
      multiple: false,
      transforms: ['boolean'],
    };
  }
  if (['skills', 'software', 'keywords', 'certifications'].includes(field)) {
    return {
      field,
      selector,
      attribute: 'text',
      multiple: false,
      transforms: ['comma_list'],
    };
  }
  return {
    field,
    selector,
    attribute: 'text',
    multiple: false,
    transforms: ['trim', 'collapse_whitespace'],
  };
}

export function listDescendantTagNames(container: Element): string[] {
  const tags = new Set<string>([container.tagName.toLowerCase()]);
  for (const descendant of container.querySelectorAll('*')) {
    tags.add(descendant.tagName.toLowerCase());
  }
  return [...tags].sort();
}

export function previewText(
  element: Element,
  captureMode: PickerCaptureMode,
): string {
  const linkTarget = findLinkTarget(element);
  const source =
    captureMode === 'link'
      ? (linkTarget?.getAttribute('href') ??
        linkTarget?.getAttribute('formaction') ??
        linkTarget?.getAttribute('data-href') ??
        linkTarget?.getAttribute('data-url') ??
        '')
      : (linkTarget?.textContent ?? element.textContent ?? '');
  return source.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function findLinkTarget(element: Element): Element | null {
  return element.closest(
    'a[href], button[formaction], [data-href], [data-url]',
  );
}

function linkAttribute(element: Element): SiteTemplateRule['attribute'] {
  if (element.hasAttribute('href')) return 'href';
  if (element.hasAttribute('formaction')) return 'formaction';
  if (element.hasAttribute('data-href')) return 'data-href';
  return 'data-url';
}

function isUnique(
  selector: string,
  element: Element,
  root: ParentNode,
): boolean {
  try {
    const matches = root.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function escapeIdentifier(value: string): string {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(value)
    : value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (match) => `\\${match}`);
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function looksStableToken(value: string, allowSpaces = false): boolean {
  const safeCharacters = allowSpaces
    ? /^[a-zA-Z_][a-zA-Z0-9_. -]*$/
    : /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;
  return (
    value.length <= 100 &&
    safeCharacters.test(value) &&
    !/[0-9a-f]{8}-[0-9a-f-]{20,}/i.test(value) &&
    !/\d{5,}/.test(value)
  );
}
