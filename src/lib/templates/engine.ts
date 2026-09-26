import { normalizePlainDate } from '../plainDate';
import { jobDraftSchema, type JobDraft } from '../schemas';
import { applyReplacement } from './replace';
import { siteTemplateSchema, type SiteTemplate } from './schema';

const MAX_RULE_MATCHES = 100;
const MAX_SCALAR_LENGTH = 50_000;

export interface TemplateExtraction {
  templateId: string;
  templateName: string;
  values: Partial<JobDraft>;
}

export function matchesSiteTemplate(
  template: SiteTemplate,
  rawUrl: string,
): boolean {
  if (!template.enabled) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.hostname.toLowerCase() !== template.hostname) return false;
  return globPathMatches(
    normalizePath(template.path_pattern),
    normalizePath(url.pathname),
  );
}

export function selectMatchingSiteTemplates(
  templates: SiteTemplate[],
  rawUrl: string,
): SiteTemplate[] {
  return templates
    .filter((template) => matchesSiteTemplate(template, rawUrl))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        specificity(b.path_pattern) - specificity(a.path_pattern) ||
        b.updated_at.localeCompare(a.updated_at) ||
        a.name.localeCompare(b.name),
    );
}

export function executeSiteTemplate(
  rawTemplate: SiteTemplate,
  root: ParentNode,
  baseUrl: string,
  toSafeMarkdown: (element: Element) => string,
): TemplateExtraction {
  const template = siteTemplateSchema.parse(rawTemplate);
  const values: Record<string, unknown> = {};

  let extractionRoot: ParentNode = root;
  if (template.selection) {
    const activeItem = findActiveItem(
      root,
      template.selection.list_selector,
      template.selection.item_selector,
      template.selection.active_class,
    );
    if (!activeItem) {
      return {
        templateId: template.id,
        templateName: template.name,
        values: {},
      };
    }
    extractionRoot = activeItem;
  }

  for (const rule of template.rules) {
    let elements: Element[];
    try {
      elements = [...extractionRoot.querySelectorAll(rule.selector)].slice(
        0,
        MAX_RULE_MATCHES,
      );
    } catch {
      continue;
    }
    if (elements.length === 0) continue;

    if (rule.multiple) {
      const items = elements
        .map((element) => applyRule(element, rule, baseUrl, toSafeMarkdown))
        .flatMap((value): unknown[] =>
          Array.isArray(value) ? Array.from(value as unknown[]) : [value],
        )
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean);
      if (items.length > 0)
        values[rule.field] = [...new Set(items)].slice(0, 100);
      continue;
    }

    const firstElement = elements[0];
    if (!firstElement) continue;
    const value = applyRule(firstElement, rule, baseUrl, toSafeMarkdown);
    if (value !== undefined && value !== '') values[rule.field] = value;
  }

  const parsed: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    const schema =
      jobDraftSchema.shape[field as keyof typeof jobDraftSchema.shape];
    const result = schema?.safeParse(value);
    if (result?.success) parsed[field] = result.data;
  }

  return {
    templateId: template.id,
    templateName: template.name,
    values: parsed,
  };
}

function findActiveItem(
  root: ParentNode,
  listSelector: string | undefined,
  itemSelector: string,
  activeClass: string,
): Element | undefined {
  let containers: ParentNode[];
  try {
    containers = listSelector
      ? [...root.querySelectorAll(listSelector)]
      : [root];
  } catch {
    return undefined;
  }

  // Deduplicate before applying the match budget: nested list containers
  // (e.g. a configured list selector that also matches an inner wrapper)
  // otherwise return the same item once per enclosing container, burning
  // through MAX_RULE_MATCHES before a later list's active item is reached.
  const seen = new Set<Element>();
  for (const container of containers) {
    let items: Element[];
    try {
      items = [...container.querySelectorAll(itemSelector)];
    } catch {
      continue;
    }
    for (const item of items) seen.add(item);
  }

  let inspected = 0;
  for (const item of seen) {
    if (inspected >= MAX_RULE_MATCHES) return undefined;
    inspected += 1;
    if (hasActiveClass(item, activeClass)) return item;
  }
  return undefined;
}

function hasActiveClass(item: Element, activeClass: string): boolean {
  return (
    item.classList.contains(activeClass) ||
    [...item.querySelectorAll('[class]')].some((descendant) =>
      descendant.classList.contains(activeClass),
    )
  );
}

function applyRule(
  element: Element,
  rule: SiteTemplate['rules'][number],
  baseUrl: string,
  toSafeMarkdown: (element: Element) => string,
): unknown {
  let value: unknown =
    rule.attribute === 'text'
      ? (element.textContent ?? '')
      : (element.getAttribute(rule.attribute) ?? '');
  if (rule.replace && typeof value === 'string') {
    value = applyReplacement(value, rule.replace);
  }

  for (const transform of rule.transforms) {
    if (transform === 'safe_markdown') {
      value = toSafeMarkdown(element);
      continue;
    }
    if (transform === 'comma_list') {
      value = String(value)
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (transform === 'number') {
      const normalized = String(value).replace(/[^0-9.-]/g, '');
      const number = Number(normalized);
      value = Number.isFinite(number)
        ? ['salary_min', 'salary_max'].includes(rule.field)
          ? Math.round(number * 100)
          : number
        : undefined;
      continue;
    }
    if (transform === 'job_type') {
      const normalized = String(value)
        .trim()
        .toLowerCase()
        .replace(/[ -]+/g, '_');
      const aliases: Record<string, JobDraft['job_type']> = {
        fulltime: 'full_time',
        full_time: 'full_time',
        parttime: 'part_time',
        part_time: 'part_time',
        contract: 'contract',
        contractor: 'contract',
        internship: 'internship',
        intern: 'internship',
        temporary: 'temp',
        temp: 'temp',
        freelance: 'freelance',
      };
      value = aliases[normalized];
      continue;
    }
    if (transform === 'experience_level') {
      const normalized = String(value).trim().toLowerCase();
      const aliases: Record<string, JobDraft['experience_level']> = {
        entry: 'entry',
        'entry level': 'entry',
        associate: 'mid',
        mid: 'mid',
        'mid level': 'mid',
        senior: 'senior',
        'mid-senior level': 'senior',
        lead: 'lead',
        executive: 'executive',
        director: 'executive',
      };
      value = aliases[normalized];
      continue;
    }
    if (transform === 'salary_type') {
      const normalized = String(value).trim().toLowerCase();
      value = /hour|hr/.test(normalized)
        ? 'hourly'
        : /annual|year|yr/.test(normalized)
          ? 'annual'
          : undefined;
      continue;
    }
    if (transform === 'boolean') {
      const normalized = String(value).trim().toLowerCase();
      if (/^(true|yes|remote|required|1)$/.test(normalized)) value = true;
      else if (/^(false|no|onsite|on-site|0)$/.test(normalized)) value = false;
      else value = undefined;
      continue;
    }
    if (transform === 'iso_date') {
      value = normalizePlainDate(String(value));
      continue;
    }
    if (transform === 'absolute_url') {
      try {
        const url = new URL(String(value), baseUrl);
        value = ['http:', 'https:'].includes(url.protocol)
          ? url.toString()
          : undefined;
      } catch {
        value = undefined;
      }
      continue;
    }
    if (transform === 'collapse_whitespace') {
      value = String(value).replace(/\s+/g, ' ');
      continue;
    }
    if (transform === 'trim') value = String(value).trim();
  }

  return typeof value === 'string' ? value.slice(0, MAX_SCALAR_LENGTH) : value;
}

function globPathMatches(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(path);
}

function specificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length;
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}
