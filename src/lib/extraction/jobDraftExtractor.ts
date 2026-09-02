import DOMPurify from 'dompurify';
import TurndownService from 'turndown';
import {
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_FIELD,
  type ApiSourcePlatform,
  type JobDraft,
} from '../schemas';
import { normalizePlainDate } from '../plainDate';
import { extractTaxonomy } from './taxonomyExtractor';
import { mergeTaxonomyTags } from '../taxonomyFields';
import {
  executeSiteTemplate,
  selectMatchingSiteTemplates,
} from '../templates/engine';
import type { SiteTemplate } from '../templates/schema';

// '#text' must be listed explicitly alongside KEEP_CONTENT: false below --
// without it, DOMPurify treats bare text nodes as unlisted too and strips
// all of them, not just the content of actually-disallowed elements like
// <script>.
const DESCRIPTION_TAGS = [
  '#text',
  'a',
  'article',
  'b',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'strong',
  'ul',
];

// Preserve the text inside unrecognized presentation wrappers (for example
// <span>, <mark>, or table cells) while removing both the element and content
// of active/embedded controls. This avoids silently deleting meaningful job
// description text without letting executable page content reach Turndown.
const DESCRIPTION_FORBIDDEN_TAGS = [
  'button',
  'embed',
  'form',
  'iframe',
  'input',
  'math',
  'noscript',
  'object',
  'option',
  'script',
  'select',
  'style',
  'svg',
  'textarea',
];

type LinkedinJobTypeMapping = readonly [
  RegExp,
  NonNullable<JobDraft['job_type']>,
];

type LinkedinExperienceLevelMapping = readonly [
  RegExp,
  NonNullable<JobDraft['experience_level']>,
];

const LINKEDIN_JOB_TYPE_MAPPINGS: readonly LinkedinJobTypeMapping[] = [
  [/^(full[- ]time|permanent)$/i, 'full_time'],
  [/^part[- ]time$/i, 'part_time'],
  [/^(contract|contractor|c2c|w2 contract)$/i, 'contract'],
  [/^(intern|internship)$/i, 'internship'],
  [/^(temporary|seasonal)$/i, 'temp'],
  [/^freelance$/i, 'freelance'],
];

const LINKEDIN_EXPERIENCE_LEVEL_MAPPINGS: readonly LinkedinExperienceLevelMapping[] =
  [
    [/^(executive|director)$/i, 'executive'],
    [/^(mid-senior level|senior)$/i, 'senior'],
    [/^(associate|mid level|mid-level)$/i, 'mid'],
    [/^(entry level|entry-level|internship)$/i, 'entry'],
  ];

const LINKEDIN_REQUIRED_EXPERIENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:at least|minimum(?: of)?)\s+(\d{1,2})\+?\s+years?(?:\s+of)?[^\n.!?]{0,60}\bexperience\b/i,
  /\b(?:requires?|needs?)\s+(?:at least\s+|a\s+minimum\s+of\s+)?(\d{1,2})\+?\s+years?(?:\s+of)?[^\n.!?]{0,60}\bexperience\b/i,
  /\b(\d{1,2})\+\s+years?(?:\s+of)?[^\n.!?]{0,60}\bexperience\b/i,
  /\b(\d{1,2})\s+years?(?:\s+of)?[^\n.!?]{0,60}\bexperience\b[^\n.!?]{0,40}\b(?:required|minimum)\b/i,
];

const LINKEDIN_DESCRIPTION_JOB_TYPE_PATTERNS: readonly RegExp[] = [
  /\b(?:this|the)\s+(?:position|role|job)\s+(?:is|will be)\s+(?:an?\s+)?(full[- ]time|part[- ]time|contract(?:or)?|intern(?:ship)?|temporary|seasonal|freelance)\b/i,
  /\b(full[- ]time|part[- ]time|contract(?:or)?|intern(?:ship)?|temporary|seasonal|freelance)\s+(?:position|role|job|employment)\b/i,
  /\b(?:employment|job)\s+type\s*:\s*(full[- ]time|part[- ]time|contract(?:or)?|intern(?:ship)?|temporary|seasonal|freelance)\b/i,
];

const USD_SALARY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const URL_IDENTITY_STABLE_QUERY_KEYS = [
  'jk',
  'vjk',
  'jobId',
  'job_id',
  'gh_jid',
] as const;
const URL_IDENTITY_IGNORED_QUERY_KEYS = new Set([
  'ref',
  'referrer',
  'source',
  'src',
  'campaign',
  'trk',
  'trackingId',
  'from',
]);
const INDEED_PANE_READINESS_TIMEOUT_MS = 800;

function formatUsdSalaryRange(min: number, max: number): string {
  return `${USD_SALARY_FORMATTER.format(min)} - ${USD_SALARY_FORMATTER.format(max)}`;
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => (line.endsWith('  ') ? line : line.replace(/[ \t]+$/, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Built once at module scope: this configuration is stateless across calls,
// and htmlToSafeMarkdown() can run several times per extraction (DOM/JSON-LD
// /meta/visible-text candidates), so re-instantiating it per call is wasted
// setup work.
const turndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  strongDelimiter: '**',
});

// Turndown pads list markers to 4 columns (e.g. "-   item") to line up
// continuation lines under a 4-space indent; override with a single space
// so plain lists don't come out with distractingly wide gaps.
turndown.addRule('listItem', {
  filter: 'li',
  replacement(content, node, options) {
    const parent = node.parentNode as Element | null;
    let prefix = `${options.bulletListMarker ?? '-'} `;
    if (parent?.nodeName === 'OL') {
      const start = parent.getAttribute('start');
      const index = Array.prototype.indexOf.call(parent.children, node);
      const number = start ? Number(start) + index : index + 1;
      prefix = `${String(number)}. `;
    }
    const isParagraph = content.endsWith('\n');
    const trimmed = content.replace(/^\n+/, '').replace(/\n+$/, '');
    const body = trimmed + (isParagraph ? '\n' : '');
    const indented = body.replace(/\n/gm, `\n${' '.repeat(prefix.length)}`);
    return prefix + indented + (node.nextSibling ? '\n' : '');
  },
});

// `src` is never in ALLOWED_ATTR below, so an <img> only ever carries alt
// text here -- surface that as plain text instead of Turndown's default
// `![alt](src)` rule, which drops the alt text entirely when there's no src.
turndown.addRule('image', {
  filter: 'img',
  replacement(_content, node) {
    const alt = (node as Element).getAttribute('alt')?.trim();
    return alt ? turndown.escape(alt) : '';
  },
});

// Turndown's default escaping only guards Markdown syntax characters, not
// `<`/`>` -- without escaping those too, sanitized-away tag text left over
// as plain text (e.g. "Use <script>...") would still read as raw,
// renderer-interpretable HTML once this Markdown is displayed downstream.
const defaultEscape = turndown.escape.bind(turndown);
turndown.escape = (text: string) =>
  defaultEscape(text).replace(/</g, '\\<').replace(/>/g, '\\>');

function htmlToSafeMarkdown(html: string | Node): string {
  // RETURN_DOM_FRAGMENT hands back DOMPurify's own sanitized DOM tree
  // directly, so the sanitized markup is never re-serialized to a string and
  // reassigned via `innerHTML` -- there's no second HTML-parsing pass for a
  // scanner (or a browser mXSS quirk) to find a gadget in.
  const sanitizedFragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: DESCRIPTION_TAGS,
    ALLOWED_ATTR: ['href', 'alt'],
    FORBID_TAGS: DESCRIPTION_FORBIDDEN_TAGS,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_DOM_FRAGMENT: true,
  });

  for (const link of sanitizedFragment.querySelectorAll<HTMLAnchorElement>(
    'a[href]',
  )) {
    const rawHref = link.getAttribute('href');
    try {
      const url = new URL(rawHref ?? '', document.baseURI);
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
        link.removeAttribute('href');
      } else {
        link.href = url.href;
      }
    } catch {
      link.removeAttribute('href');
    }
  }

  return normalizeMarkdown(turndown.turndown(sanitizedFragment));
}

function plainTextToSafeMarkdown(text: string): string {
  const container = document.createElement('div');
  container.textContent = text;
  return htmlToSafeMarkdown(container.innerHTML);
}

function elementToSafeMarkdown(root: Element): string {
  return htmlToSafeMarkdown(root.innerHTML);
}

/**
 * Extracts a best-guess {@link JobDraft} from the active page using JSON-LD
 * `JobPosting` markup, OpenGraph/meta tags, platform-specific DOM selectors,
 * the page URL, and finally visible text as a last-resort fallback.
 *
 * Runs from the locally bundled runtime content script in the MV3 isolated
 * world so the DOMPurify and Turndown browser dependencies remain available.
 */
export async function extractJobDraft(
  detection: {
    platform: ApiSourcePlatform;
    confidence: 'high' | 'low';
    externalJobId?: string;
  },
  templates: SiteTemplate[] = [],
): Promise<{
  draft: JobDraft;
  appliedTemplate?: { id: string; name: string };
  candidates: Partial<
    Record<
      keyof JobDraft,
      {
        value: unknown;
        source:
          | 'jsonld'
          | 'dom'
          | 'meta'
          | 'visible-text'
          | 'url'
          | 'description'
          | 'template';
        confidence: 'high' | 'medium' | 'low';
      }[]
    >
  >;
}> {
  // 'description' marks values derived by scanning the selected, sanitized
  // job description against the canonical taxonomy catalog -- it never wins
  // field selection (taxonomy merge happens after ranking) but lets the
  // popup's field review identify where an array candidate came from.
  type Source =
    | 'jsonld'
    | 'dom'
    | 'meta'
    | 'visible-text'
    | 'url'
    | 'description'
    | 'template';
  type Confidence = 'high' | 'medium' | 'low';

  interface Candidate {
    value: unknown;
    source: Source;
    confidence: Confidence;
  }

  type FieldCandidates = Partial<Record<keyof JobDraft, Candidate[]>>;

  const fieldCandidates: FieldCandidates = {};

  function addCandidate(
    field: keyof JobDraft,
    value: unknown,
    source: Source,
    confidence: Confidence,
  ): void {
    if (value === undefined || value === null || value === '') return;
    const existing = fieldCandidates[field];
    const list = existing ?? [];
    list.push({ value, source, confidence });
    fieldCandidates[field] = list;
  }

  function numberOrUndefined(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return undefined;
  }

  function resolveUrl(raw: string): string | undefined {
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return undefined;
    }
  }

  function metadataUrlConfidence(url: string): Confidence {
    return pageIdentityMatches(url) ? 'medium' : 'low';
  }

  function pageIdentityMatches(url: string): boolean {
    try {
      const candidate = new URL(url, location.href);
      const active = new URL(location.href);
      const normalizePath = (path: string) => path.replace(/\/+$/, '') || '/';
      if (candidate.origin !== active.origin) return false;

      const candidateStableIds = new Set(
        URL_IDENTITY_STABLE_QUERY_KEYS.flatMap((key) => {
          const value = candidate.searchParams.get(key);
          return value ? [value] : [];
        }),
      );
      const activeStableIds = URL_IDENTITY_STABLE_QUERY_KEYS.flatMap((key) => {
        const value = active.searchParams.get(key);
        return value ? [value] : [];
      });
      if (activeStableIds.some((id) => candidateStableIds.has(id))) {
        return true;
      }

      const identitySearch = (value: URL): string => {
        const params = Array.from(value.searchParams.entries())
          .filter(
            ([key]) =>
              !/^utm_/i.test(key) && !URL_IDENTITY_IGNORED_QUERY_KEYS.has(key),
          )
          .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
            `${leftKey}=${leftValue}`.localeCompare(
              `${rightKey}=${rightValue}`,
            ),
          );
        return new URLSearchParams(params).toString();
      };
      return (
        normalizePath(candidate.pathname) === normalizePath(active.pathname) &&
        identitySearch(candidate) === identitySearch(active)
      );
    } catch {
      return false;
    }
  }

  function queryFirst(
    selectors: string[],
    root: ParentNode = document,
  ): Element | null {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function textOf(el: Element | null | undefined): string | undefined {
    const text = el?.textContent?.replace(/\s+/g, ' ').trim();
    return text || undefined;
  }

  function bySelector(
    selectors: string[],
    root: ParentNode = document,
  ): () => Element | undefined {
    return () => queryFirst(selectors, root) ?? undefined;
  }

  // Waits on several independent element finders at once via a single
  // shared MutationObserver, instead of one observer per finder -- avoids
  // doubling observer-callback overhead when a platform extractor needs to
  // wait on e.g. title and description together. Each finder can be a
  // CSS-selector lookup (see `bySelector`) or any other DOM query, e.g.
  // matching by text content, which no CSS selector alone can express.
  function waitForEach(
    finders: (() => Element | undefined)[],
    timeoutMs: number,
  ): Promise<(Element | undefined)[]> {
    return new Promise((resolve) => {
      const results: (Element | undefined)[] = finders.map(() => undefined);
      const pending = new Set(finders.map((_, i) => i));

      function checkPending(): boolean {
        for (const i of Array.from(pending)) {
          const el = finders[i]?.();
          if (el) {
            results[i] = el;
            pending.delete(i);
          }
        }
        return pending.size === 0;
      }

      if (checkPending()) {
        resolve(results);
        return;
      }

      const observer = new MutationObserver(() => {
        if (checkPending()) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(results);
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(results);
      }, timeoutMs);
    });
  }

  function mapEmploymentType(raw: unknown): JobDraft['job_type'] | undefined {
    const employmentTypeMap: Record<string, JobDraft['job_type']> = {
      FULL_TIME: 'full_time',
      PART_TIME: 'part_time',
      CONTRACTOR: 'contract',
      INTERN: 'internship',
      TEMPORARY: 'temp',
    };

    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value === 'string') {
        const mapped = employmentTypeMap[value.trim().toUpperCase()];
        if (mapped) return mapped;
      }
    }
    return undefined;
  }

  function mapVisibleEmploymentType(
    raw: string | undefined,
  ): JobDraft['job_type'] | undefined {
    if (!raw) return undefined;
    const value = raw.replace(/[_–—]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\b(full[ -]?time|permanent)\b/i.test(value)) return 'full_time';
    if (/\bpart[ -]?time\b/i.test(value)) return 'part_time';
    if (/\b(contract|contractor|c2c|w2)\b/i.test(value)) return 'contract';
    if (/\b(intern|internship)\b/i.test(value)) return 'internship';
    if (/\b(temporary|temp|seasonal)\b/i.test(value)) return 'temp';
    if (/\bfreelance\b/i.test(value)) return 'freelance';
    return undefined;
  }

  function remoteFromText(raw: string | undefined): boolean | undefined {
    if (!raw) return undefined;
    // Check hybrid/on-site first: callers often concatenate a workplace-type
    // field with a location string (e.g. "Hybrid" + "Remote-eligible, SF"),
    // and an explicit hybrid/on-site signal should win over an incidental
    // "remote" mention elsewhere in the combined text.
    if (/\b(on[ -]?site|in[ -]?office|hybrid)\b/i.test(raw)) return false;
    if (/\b(remote|work from home|telecommut(?:e|ing))\b/i.test(raw)) {
      return true;
    }
    return undefined;
  }

  function structuredItems(root: ParentNode | null): string[] | undefined {
    if (!root) return undefined;
    const itemElements = Array.from(
      root.querySelectorAll(
        '[data-testid="skill"], [data-cy="skill"], li, [role="listitem"]',
      ),
    );
    const rawItems =
      itemElements.length > 0
        ? itemElements.map((item) => textOf(item))
        : (root.textContent
            ?.replace(/\s+/g, ' ')
            .trim()
            ?.replace(/^skills?\s*:?\s*/i, '')
            .split(/[,;\n|]/) ?? []);
    const items = Array.from(
      new Set(
        rawItems
          .filter((item): item is string => Boolean(item))
          .map((item) => item.trim())
          .filter(
            (item) =>
              item.length > 0 &&
              item.length <= MAX_TAG_LENGTH &&
              !/^skills?$/i.test(item),
          ),
      ),
    ).slice(0, MAX_TAGS_PER_FIELD);
    return items.length > 0 ? items : undefined;
  }

  function sectionByHeading(
    label: RegExp,
    root: ParentNode = document,
  ): ParentNode | null {
    const headings = Array.from(
      root.querySelectorAll('h2, h3, h4, [role="heading"]'),
    );
    const heading = headings.find((candidate) =>
      label.test(textOf(candidate) ?? ''),
    );
    if (!heading) return null;

    const boundary = root instanceof Element ? root : document.body;
    const container = heading.closest(
      'section, article, [data-testid], [data-cy]',
    );
    // Only trust the closest() match if it's actually scoped inside the
    // caller's root -- otherwise it can climb past the intended subsection
    // to a page-level wrapper (e.g. one carrying its own data-testid) and
    // sweep in unrelated content when callers later query its list items.
    if (container && container !== boundary && boundary.contains(container)) {
      return container;
    }

    const range = document.createRange();
    range.selectNodeContents(root);
    range.setStartAfter(heading);
    const startLevel = headingLevel(heading) ?? 2;
    const stopHeading = headings
      .slice(headings.indexOf(heading) + 1)
      .find(
        (candidate) => (headingLevel(candidate) ?? startLevel) <= startLevel,
      );
    if (stopHeading) range.setEndBefore(stopHeading);

    const section = range.cloneContents();
    return section.textContent?.trim() ? section : null;
  }

  function extractLocationText(jobLocation: unknown): string | undefined {
    const nodes = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
    const locations = nodes.flatMap((node): string[] => {
      if (!node || typeof node !== 'object') return [];
      const address = (node as Record<string, unknown>).address;
      if (!address || typeof address !== 'object') return [];

      const addr = address as Record<string, unknown>;
      const locality =
        typeof addr.addressLocality === 'string'
          ? addr.addressLocality.trim()
          : undefined;
      const region =
        typeof addr.addressRegion === 'string'
          ? addr.addressRegion.trim()
          : undefined;
      const country =
        typeof addr.addressCountry === 'string'
          ? addr.addressCountry.trim()
          : undefined;
      const parts = [locality, region].filter((part): part is string =>
        Boolean(part),
      );
      const location = parts.length > 0 ? parts.join(', ') : country;
      return location ? [location] : [];
    });
    const unique = Array.from(new Set(locations));
    const MAX_JOINED_LOCATIONS = 5;
    return unique.length > 0
      ? unique.slice(0, MAX_JOINED_LOCATIONS).join(' | ')
      : undefined;
  }

  function detectRemoteFromJsonLd(
    jobPosting: Record<string, unknown>,
  ): boolean | undefined {
    const locationType = jobPosting.jobLocationType;
    if (
      typeof locationType === 'string' &&
      locationType.toUpperCase().includes('TELECOMMUTE')
    ) {
      return true;
    }

    const requirements = jobPosting.applicantLocationRequirements;
    if (
      requirements &&
      JSON.stringify(requirements).toUpperCase().includes('TELECOMMUTE')
    ) {
      return true;
    }

    if (!jobPosting.jobLocation) {
      const titleText =
        typeof jobPosting.title === 'string' ? jobPosting.title : '';
      const descriptionText =
        typeof jobPosting.description === 'string'
          ? jobPosting.description
          : '';
      const remoteText = `${titleText} ${descriptionText}`.toLowerCase();
      if (/\bremote\b/.test(remoteText)) return true;
    }

    return undefined;
  }

  function extractSalary(jobPosting: Record<string, unknown>): void {
    const baseSalary = jobPosting.baseSalary;
    if (!baseSalary || typeof baseSalary !== 'object') return;

    const baseSalaryObj = baseSalary as Record<string, unknown>;
    const valueNode =
      baseSalaryObj.value && typeof baseSalaryObj.value === 'object'
        ? (baseSalaryObj.value as Record<string, unknown>)
        : undefined;

    const unitText =
      typeof valueNode?.unitText === 'string'
        ? valueNode.unitText
        : typeof baseSalaryObj.unitText === 'string'
          ? baseSalaryObj.unitText
          : undefined;

    if (!unitText) return;

    const minValue =
      numberOrUndefined(valueNode?.minValue) ??
      numberOrUndefined(valueNode?.value);
    const maxValue =
      numberOrUndefined(valueNode?.maxValue) ??
      numberOrUndefined(valueNode?.value);

    const normalizedUnit = unitText.toUpperCase();
    if (normalizedUnit === 'YEAR') {
      addCandidate('salary_type', 'annual', 'jsonld', 'high');
      if (minValue !== undefined) {
        addCandidate(
          'salary_min',
          Math.round(minValue * 100),
          'jsonld',
          'high',
        );
      }
      if (maxValue !== undefined) {
        addCandidate(
          'salary_max',
          Math.round(maxValue * 100),
          'jsonld',
          'high',
        );
      }
    } else if (normalizedUnit === 'HOUR') {
      addCandidate('salary_type', 'hourly', 'jsonld', 'high');
      if (minValue !== undefined) {
        addCandidate('hourly_rate_min', minValue, 'jsonld', 'high');
      }
      if (maxValue !== undefined) {
        addCandidate('hourly_rate_max', maxValue, 'jsonld', 'high');
      }
    }
  }

  function collectFromNode(
    node: unknown,
    out: Record<string, unknown>[],
  ): void {
    if (Array.isArray(node)) {
      node.forEach((item) => {
        collectFromNode(item, out);
      });
      return;
    }
    if (!node || typeof node !== 'object') return;

    const obj = node as Record<string, unknown>;
    const type = obj['@type'];
    const typeStr = Array.isArray(type)
      ? (type as unknown[])
          .filter((entry): entry is string => typeof entry === 'string')
          .join(',')
      : typeof type === 'string'
        ? type
        : '';
    if (typeStr.includes('JobPosting')) {
      out.push(obj);
    }

    if (Array.isArray(obj['@graph'])) {
      collectFromNode(obj['@graph'], out);
    }
  }

  function collectJsonLdJobPostings(): Record<string, unknown>[] {
    const scripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    );
    const postings: Record<string, unknown>[] = [];
    for (const script of scripts) {
      const raw = script.textContent;
      if (!raw) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        collectFromNode(parsed, postings);
      } catch {
        continue;
      }
    }
    return postings;
  }

  function richnessScore(posting: Record<string, unknown>): number {
    return [
      'title',
      'hiringOrganization',
      'description',
      'datePosted',
      'jobLocation',
      'baseSalary',
    ].reduce((score, key) => score + (posting[key] ? 1 : 0), 0);
  }

  function pickRichestJobPosting(
    postings: Record<string, unknown>[],
  ): Record<string, unknown> | undefined {
    if (postings.length === 0) return undefined;

    // A posting whose own `url` points at this exact page is almost
    // certainly the one actually being viewed -- prefer it outright over a
    // richer but unrelated block (e.g. a "similar jobs" widget's JobPosting)
    // that just happens to have more fields populated.
    const currentUrlMatches = postings.filter((posting) => {
      const url = posting.url;
      return typeof url === 'string' && pageIdentityMatches(url);
    });
    if (currentUrlMatches.length > 0) {
      return currentUrlMatches.reduce((best, current) =>
        richnessScore(current) > richnessScore(best) ? current : best,
      );
    }

    // A single block is unambiguous even when it omits its own URL. With
    // multiple unmatched blocks, choosing the richest can bind the active
    // page to a recommendation widget, so reject the entire ambiguous set.
    return postings.length === 1 ? postings[0] : undefined;
  }

  function metaContent(name: string): string | undefined {
    const selector = `meta[name="${name}"], meta[property="${name}"]`;
    const value = document
      .querySelector<HTMLMetaElement>(selector)
      ?.content?.trim();
    return value || undefined;
  }

  function inferExternalId(url: string, title?: string): string {
    const parsed = new URL(url);

    const pathId = parsed.pathname.split('/').filter(Boolean).at(-1);
    if (pathId) return pathId.replace(/[^a-zA-Z0-9_-]/g, '-');

    return `${parsed.hostname}-${title || 'job'}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
  }

  // --- platform-specific DOM extraction -------------------------------------

  // On Indeed's split-view search pages (/jobs?...&vjk=...), the selected
  // card -- the one whose job the detail pane is currently showing -- is
  // marked with aria-pressed="true". That card is the live source of truth
  // for which posting is open: the URL's vjk param can lag behind the last
  // click, so the card's data-jk outranks the URL-derived job ID. The
  // pressed marker sits on the title link itself in current markup; the
  // wrapper-level and href-only selectors below cover markup variants.
  // Every Indeed title -- card aria-label, card text, and pane heading --
  // goes through this one cleaner so the string used to correlate a card with
  // the pane and the string stored on the draft can never drift apart.
  function cleanIndeedTitle(value: string | undefined): string | undefined {
    const cleaned = value
      ?.replace(/^full details of\s+/i, '')
      .replace(/\s+-\s+job post$/i, '')
      .trim();
    return cleaned || undefined;
  }

  function normalizeIndeedTitle(value: string | undefined): string | undefined {
    return cleanIndeedTitle(value)?.toLocaleLowerCase();
  }

  // Indeed renames its results wrapper and card marker class from time to
  // time, and recommendation shelves reuse the same card markup outside the
  // primary list. Keeping the container and marker candidates in these two
  // lists means a markup change is one edit here, while the primary/shelf
  // separation still comes from requiring cards to sit inside a primary
  // results container.
  const INDEED_PRIMARY_RESULT_CONTAINERS = [
    '#mosaic-jobResults',
    '#mosaic-provider-jobcards',
    '[data-testid="jobResults"]',
  ];
  const INDEED_PRIMARY_CARD_MARKERS = [
    'div.job_seen_beacon',
    'li.job_seen_beacon',
    '[data-testid="slider_item"]',
    'li[data-resultid]',
  ];

  function findIndeedPrimaryCards(): Element[] {
    const container = queryFirst(INDEED_PRIMARY_RESULT_CONTAINERS);
    if (!container) return [];
    const cards = INDEED_PRIMARY_CARD_MARKERS.flatMap((marker) =>
      Array.from(container.querySelectorAll(marker)),
    );
    // A card can match several markers, and one marker can sit inside
    // another. Identity dedup plus an ancestor walk keeps the outermost card
    // in O(cards * DOM depth), avoiding pairwise contains() scans.
    const uniqueCards = Array.from(new Set(cards));
    const cardSet = new Set(uniqueCards);
    return uniqueCards.filter((card) => {
      for (
        let ancestor = card.parentElement;
        ancestor && ancestor !== container;
        ancestor = ancestor.parentElement
      ) {
        if (cardSet.has(ancestor)) return false;
      }
      return true;
    });
  }

  interface IndeedSelection {
    anchor: Element;
    card: Element;
    jobId: string | undefined;
    title: string | undefined;
  }

  function findIndeedSelection(
    detailTitle: string | undefined,
  ): IndeedSelection | undefined {
    const primaryCards = findIndeedPrimaryCards();
    const searchRoots: Element[] = primaryCards.length
      ? primaryCards
      : [document.documentElement];
    const selectedSelectors = [
      'a[data-jk][aria-pressed="true"]',
      '[aria-pressed="true"] a[data-jk]',
      'a[aria-pressed="true"][href*="jk="]',
    ];
    let anchor = searchRoots
      .map((root) => queryFirst(selectedSelectors, root))
      .find((candidate) => candidate !== null);

    // Indeed sometimes leaves a populated pane without aria-pressed, while
    // vjk may still identify the previously selected job. Correlate the pane
    // title even when URL detection supplied an ID so a unique primary card
    // can override that stale identity.
    // Correlate it only when exactly one primary card has the same normalized
    // title; duplicate-title ambiguity must not invent an identity.
    if (!anchor && primaryCards.length) {
      const normalizedDetailTitle = normalizeIndeedTitle(detailTitle);
      if (normalizedDetailTitle) {
        const matches = primaryCards.flatMap((card) => {
          const candidate = queryFirst(
            [
              'a[data-jk][aria-label^="full details of" i]',
              'a[data-jk]',
              'a[href*="jk="]',
            ],
            card,
          );
          const candidateTitle = normalizeIndeedTitle(
            candidate?.getAttribute('aria-label') ?? textOf(candidate),
          );
          return candidate && candidateTitle === normalizedDetailTitle
            ? [candidate]
            : [];
        });
        if (matches.length === 1) anchor = matches[0];
      }
    }
    // A URL-derived vjk is not proof that an attached/hidden pane represents
    // the same job. Only a pressed or uniquely title-correlated card verifies
    // pane identity.
    if (!anchor) return undefined;

    const rawHref = anchor.getAttribute('href') ?? undefined;
    const jkFromHref = (): string | undefined => {
      if (!rawHref) return undefined;
      try {
        return (
          new URL(rawHref, location.href).searchParams.get('jk') ?? undefined
        );
      } catch {
        return undefined;
      }
    };
    const jk = anchor.getAttribute('data-jk') ?? jkFromHref();

    const card =
      anchor.closest([...INDEED_PRIMARY_CARD_MARKERS, 'li'].join(', ')) ??
      anchor;
    return {
      anchor,
      card,
      jobId: jk,
      title: cleanIndeedTitle(
        anchor.getAttribute('aria-label') ?? textOf(anchor),
      ),
    };
  }

  function extractIndeedSelectedCard(selection: IndeedSelection): boolean {
    const { anchor, card, jobId: jk, title: cardTitle } = selection;
    const rawHref = anchor.getAttribute('href') ?? undefined;

    addCandidate('external_job_id', jk, 'dom', 'high');

    // Prefer a canonical /viewjob link built from the card's job ID over the
    // card's own href, which is usually an /rc/clk tracking redirect.
    const cardLink = jk
      ? resolveUrl(`/viewjob?jk=${encodeURIComponent(jk)}`)
      : rawHref
        ? resolveUrl(rawHref)
        : undefined;
    addCandidate('job_link', cardLink, 'dom', 'high');

    // These run before the detail-pane candidates: on a tie the card wins,
    // which matters for job_title -- the pane block's bare-h1 fallback can
    // land on the serp's own search header (e.g. "engineer jobs in Austin"),
    // while the card title is the selected posting's title verbatim.
    addCandidate('job_title', cardTitle, 'dom', 'high');
    addCandidate(
      'company_name',
      textOf(card.querySelector('[data-testid="company-name"]')),
      'dom',
      'high',
    );
    // Real cards prefix the workplace type onto the location text (e.g.
    // "Hybrid work in Centennial, CO 80112"), so the same string also
    // answers is_remote.
    const cardLocation = textOf(
      card.querySelector('[data-testid="text-location"]'),
    );
    addCandidate('job_location', cardLocation, 'dom', 'high');
    addCandidate('is_remote', remoteFromText(cardLocation), 'dom', 'medium');

    // Snippet badges mix salary, job type, and shift text under the same
    // testid, so classify by content instead of position.
    const snippets = Array.from(
      card.querySelectorAll(
        '[data-testid="attribute_snippet_testid"], [class*="salary-snippet"]',
      ),
    ).flatMap((el) => {
      const text = textOf(el);
      return text ? [text] : [];
    });
    addCandidate(
      'salary_text',
      snippets.find((text) =>
        /(?:[$€£]\s*\d|\d[\d,.]*\s*(?:an?\s+(?:hour|year)|per\s+(?:hour|year)|\/\s*(?:hr|yr|hour|year)))/i.test(
          text,
        ),
      ),
      'dom',
      'medium',
    );
    addCandidate(
      'job_type',
      snippets
        .map((text) => mapVisibleEmploymentType(text))
        .find((value) => value !== undefined),
      'dom',
      'medium',
    );
    return Boolean(jk);
  }

  interface IndeedPaneSnapshot {
    titleEl: Element | undefined;
    descriptionEl: Element | undefined;
    selection: IndeedSelection | undefined;
  }

  function readIndeedPaneSnapshot(
    paneRoot: ParentNode,
    isSearchResultsPage: boolean,
  ): IndeedPaneSnapshot | undefined {
    const titleEl =
      queryFirst(
        [
          'h1.jobsearch-JobInfoHeader-title',
          '[data-testid="jobsearch-JobInfoHeader-title"]',
          'h1',
        ],
        paneRoot,
      ) ?? undefined;
    const detailTitle = cleanIndeedTitle(textOf(titleEl));
    const selection = findIndeedSelection(detailTitle);
    if (
      isSearchResultsPage &&
      (!selection ||
        !detailTitle ||
        normalizeIndeedTitle(selection.title) !==
          normalizeIndeedTitle(detailTitle))
    ) {
      return undefined;
    }
    return {
      titleEl,
      descriptionEl:
        queryFirst(
          ['#jobDescriptionText', '[data-testid="jobDescriptionText"]'],
          paneRoot,
        ) ?? undefined,
      selection,
    };
  }

  function waitForIndeedPaneSnapshot(
    paneRoot: ParentNode,
    isSearchResultsPage: boolean,
    timeoutMs: number,
  ): Promise<IndeedPaneSnapshot | undefined> {
    return new Promise((resolve) => {
      const read = () => readIndeedPaneSnapshot(paneRoot, isSearchResultsPage);
      const immediate = read();
      if (immediate?.titleEl && immediate.descriptionEl) {
        resolve(immediate);
        return;
      }
      const observer = new MutationObserver(() => {
        const snapshot = read();
        if (snapshot?.titleEl && snapshot.descriptionEl) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(snapshot);
        }
      });
      observer.observe(paneRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-pressed'],
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(read());
      }, timeoutMs);
    });
  }

  async function extractIndeedDom(): Promise<void> {
    // Wait on title and description together -- the header commonly paints
    // before #jobDescriptionText, which Indeed often populates via a
    // follow-up XHR. Waiting on title alone would return as soon as it
    // resolves and silently miss a still-loading description.
    const rightPane = document.querySelector('.jobsearch-RightPane');
    const paneRoot = rightPane ?? document.documentElement;
    const hiddenPane =
      rightPane !== null && getComputedStyle(rightPane).display === 'none';
    const isSearchResultsPage =
      queryFirst(INDEED_PRIMARY_RESULT_CONTAINERS) !== null ||
      location.pathname === '/jobs' ||
      /-jobs\.html$/i.test(location.pathname);
    const snapshot = await waitForIndeedPaneSnapshot(
      paneRoot,
      isSearchResultsPage,
      INDEED_PANE_READINESS_TIMEOUT_MS,
    );
    const titleEl = snapshot?.titleEl;
    const descriptionEl = snapshot?.descriptionEl;
    const detailTitle = textOf(titleEl);
    const selection = snapshot?.selection ?? findIndeedSelection(undefined);
    if (selection) extractIndeedSelectedCard(selection);
    const hasCorrelatedPane = Boolean(snapshot?.selection);
    const acceptPane =
      hasCorrelatedPane || (!isSearchResultsPage && !hiddenPane);
    addCandidate(
      'job_title',
      acceptPane ? cleanIndeedTitle(detailTitle) : undefined,
      'dom',
      'high',
    );
    addCandidate(
      'job_description',
      acceptPane && descriptionEl
        ? elementToSafeMarkdown(descriptionEl)
        : undefined,
      'dom',
      'high',
    );

    addCandidate(
      'company_name',
      acceptPane
        ? textOf(
            queryFirst(
              [
                '[data-testid="inlineHeader-companyName"]',
                '.jobsearch-InlineCompanyRating-companyHeader a',
                '.jobsearch-CompanyInfoContainer a',
              ],
              paneRoot,
            ),
          )
        : undefined,
      'dom',
      'high',
    );

    addCandidate(
      'job_location',
      acceptPane
        ? textOf(
            queryFirst(
              [
                '[data-testid="inlineHeader-companyLocation"]',
                '.jobsearch-JobInfoHeader-subtitle > div',
              ],
              paneRoot,
            ),
          )
        : undefined,
      'dom',
      'medium',
    );
  }

  async function extractGlassdoorDom(): Promise<void> {
    const [titleEl, descriptionEl] = await waitForEach(
      [
        bySelector(['[data-test="job-title"]', 'h1']),
        bySelector(['[data-test="jobDescriptionContent"]', 'article']),
      ],
      800,
    );
    addCandidate('job_title', textOf(titleEl), 'dom', 'high');
    addCandidate(
      'job_description',
      descriptionEl ? elementToSafeMarkdown(descriptionEl) : undefined,
      'dom',
      'high',
    );

    addCandidate(
      'company_name',
      textOf(queryFirst(['[data-test="employer-name"]'])),
      'dom',
      'high',
    );

    addCandidate(
      'job_location',
      textOf(queryFirst(['[data-test="location"]'])),
      'dom',
      'medium',
    );
  }

  async function extractGreenhouseDom(): Promise<void> {
    const [titleEl, descriptionEl] = await waitForEach(
      [
        bySelector([
          '[data-mapped="job-title"]',
          '#app_body h1',
          '#header h1',
          'main h1',
        ]),
        bySelector([
          '[data-mapped="job-description"]',
          '#content',
          '.job__description',
          '.job-post-description',
        ]),
      ],
      800,
    );
    addCandidate('job_title', textOf(titleEl), 'dom', 'high');
    addCandidate(
      'job_description',
      descriptionEl ? elementToSafeMarkdown(descriptionEl) : undefined,
      'dom',
      'high',
    );
    addCandidate(
      'company_name',
      textOf(
        queryFirst([
          '[data-mapped="company-name"]',
          '#header .company-name',
          '.company-name',
          '[class*="companyName"]',
        ]),
      ),
      'dom',
      'high',
    );
    const locationText = textOf(
      queryFirst([
        '[data-mapped="job-location"]',
        '#header .location',
        '.job__location',
        '.location',
      ]),
    );
    addCandidate('job_location', locationText, 'dom', 'high');
    addCandidate('is_remote', remoteFromText(locationText), 'dom', 'medium');
    addCandidate(
      'job_type',
      mapVisibleEmploymentType(
        textOf(
          queryFirst([
            '[data-mapped="employment-type"]',
            '.employment-type',
            '.job__employment-type',
          ]),
        ),
      ),
      'dom',
      'high',
    );

    const formAction = document
      .querySelector<HTMLFormElement>(
        'form[action*="/jobs/"], form[action*="/applications/"]',
      )
      ?.getAttribute('action');
    const formJobId = formAction?.match(/\/jobs\/(\d+)/i)?.[1];
    addCandidate('external_job_id', formJobId, 'dom', 'high');
  }

  async function extractLeverDom(): Promise<void> {
    const root =
      document.querySelector('.posting-page, [data-qa="posting-page"]') ??
      document.querySelector('main') ??
      document.body;
    const [titleEl, descriptionEl] = await waitForEach(
      [
        () =>
          root.querySelector(
            '.posting-headline h2, [data-qa="posting-name"], h1',
          ) ?? undefined,
        () =>
          root.querySelector(
            '.posting-description, [data-qa="job-description"], .content',
          ) ?? undefined,
      ],
      800,
    );
    addCandidate('job_title', textOf(titleEl), 'dom', 'high');
    addCandidate(
      'job_description',
      descriptionEl ? elementToSafeMarkdown(descriptionEl) : undefined,
      'dom',
      'high',
    );

    const tenant = location.pathname.split('/').find(Boolean);
    const tenantName = tenant
      ?.split(/[-_]/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    const companyName = textOf(
      root.querySelector(
        '[data-qa="company-name"], .posting-company, .company-name',
      ),
    );
    addCandidate('company_name', companyName, 'dom', 'high');
    if (!companyName) {
      // A Lever tenant slug is a useful fallback but can differ from the
      // employer's display name (for example "applydigital" vs "APPLY").
      // Keep it below an employer-branded og:site_name candidate.
      addCandidate('company_name', tenantName, 'dom', 'low');
    }

    const locationText = textOf(
      root.querySelector(
        '[data-qa="posting-location"], .posting-categories .location, .location',
      ),
    );
    const commitment = textOf(
      root.querySelector(
        '[data-qa="posting-commitment"], .posting-categories .commitment, .commitment',
      ),
    );
    const workplaceType = textOf(
      root.querySelector(
        '[data-qa="posting-workplace"], .posting-categories .workplaceTypes, .workplaceTypes',
      ),
    );
    addCandidate('job_location', locationText, 'dom', 'high');
    addCandidate(
      'is_remote',
      remoteFromText(`${workplaceType ?? ''} ${locationText ?? ''}`),
      'dom',
      'high',
    );
    addCandidate(
      'job_type',
      mapVisibleEmploymentType(commitment),
      'dom',
      'high',
    );

    const department = textOf(
      root.querySelector(
        '[data-qa="posting-department"], .posting-categories .department, .department',
      ),
    );
    addCandidate(
      'keywords',
      department ? [department] : undefined,
      'dom',
      'high',
    );
  }

  async function extractWorkdayDom(): Promise<void> {
    const [titleEl, descriptionEl] = await waitForEach(
      [
        bySelector([
          '[data-automation-id="jobPostingHeader"] h2',
          '[data-automation-id="jobPostingTitle"]',
          '[data-automation-id="jobPostingHeader"]',
          'main h1',
        ]),
        bySelector([
          '[data-automation-id="jobPostingDescription"]',
          '[data-automation-id="jobDescription"]',
        ]),
      ],
      1_200,
    );
    addCandidate('job_title', textOf(titleEl), 'dom', 'high');
    addCandidate(
      'job_description',
      descriptionEl ? elementToSafeMarkdown(descriptionEl) : undefined,
      'dom',
      'high',
    );

    const locationText = textOf(
      queryFirst([
        '[data-automation-id="locations"]',
        '[data-automation-id="location"]',
        '[data-automation-id="jobPostingLocation"]',
      ]),
    );
    addCandidate('job_location', locationText, 'dom', 'high');
    addCandidate(
      'is_remote',
      remoteFromText(`${locationText ?? ''} ${textOf(titleEl) ?? ''}`),
      'dom',
      'medium',
    );

    const requisitionText = textOf(
      queryFirst([
        '[data-automation-id="jobRequisitionId"]',
        '[data-automation-id="requisitionId"]',
      ]),
    );
    const requisitionId = requisitionText
      ?.replace(/^(job\s+)?requisition\s+id\s*:?\s*/i, '')
      .trim();
    addCandidate('external_job_id', requisitionId, 'dom', 'high');

    const dateEl = queryFirst([
      'time[data-automation-id="postedOn"]',
      '[data-automation-id="postedOn"] time',
      'time[datetime]',
    ]);
    const rawDate = dateEl?.getAttribute('datetime') ?? textOf(dateEl);
    addCandidate(
      'date_posted',
      rawDate ? normalizePlainDate(rawDate) : undefined,
      'dom',
      'high',
    );
    addCandidate(
      'company_name',
      textOf(
        queryFirst([
          '[data-automation-id="company"]',
          '[data-automation-id="companyName"]',
        ]),
      ),
      'dom',
      'high',
    );
    addCandidate(
      'job_type',
      mapVisibleEmploymentType(
        textOf(
          queryFirst([
            '[data-automation-id="timeType"]',
            '[data-automation-id="employmentType"]',
          ]),
        ),
      ),
      'dom',
      'high',
    );
  }

  async function extractDiceDom(): Promise<void> {
    const currentPath = location.pathname.replace(/\/$/, '');
    const detailLink = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/job-detail/"]'),
    ).find((link) => {
      try {
        return (
          new URL(link.href, location.href).pathname.replace(/\/$/, '') ===
          currentPath
        );
      } catch {
        return false;
      }
    });

    const detailRoot =
      detailLink?.closest('main, article, [role="main"], [role="article"]') ??
      document.querySelector('main') ??
      document.body;
    const [titleEl, descriptionEl] = await waitForEach(
      [
        () =>
          detailRoot.querySelector(
            'h1, [data-testid="job-detail-title"], [data-cy="job-title"]',
          ) ??
          detailLink ??
          undefined,
        () =>
          detailRoot.querySelector(
            '[data-testid="job-description"], [data-cy="job-description"], [class*="job-description"], [class*="jobDescription"]',
          ) ?? undefined,
      ],
      800,
    );

    addCandidate('job_title', textOf(titleEl), 'dom', 'high');
    addCandidate(
      'job_description',
      descriptionEl ? elementToSafeMarkdown(descriptionEl) : undefined,
      'dom',
      'high',
    );
    addCandidate(
      'company_name',
      textOf(
        detailRoot.querySelector(
          'a[href*="/company-profile/"], [data-testid="company-name"], [data-cy="company-name"]',
        ),
      ),
      'dom',
      'high',
    );
    addCandidate(
      'job_location',
      textOf(
        detailRoot.querySelector(
          '[data-testid="job-location"], [data-cy="location"], [class*="location"]',
        ),
      ),
      'dom',
      'medium',
    );

    const headerCard = detailRoot.querySelector(
      '[data-testid="job-detail-header-card"]',
    );
    const locationText = textOf(
      detailRoot.querySelector(
        '[data-testid="job-location"], [data-cy="location"], [data-testid="job-detail-header-card"] > span, [class*="location"]',
      ),
    );
    const workplaceText = textOf(
      detailRoot.querySelector('[data-testid="locationTypeBadge"]'),
    );
    addCandidate(
      'is_remote',
      remoteFromText(`${workplaceText ?? ''} ${locationText ?? ''}`),
      'dom',
      'high',
    );
    const headerEmploymentType = Array.from(
      headerCard?.querySelectorAll('[class*="InfoBadge"]') ?? [],
    )
      .map((badge) => textOf(badge))
      .find((value) => mapVisibleEmploymentType(value) !== undefined);
    addCandidate(
      'job_type',
      mapVisibleEmploymentType(
        textOf(
          detailRoot.querySelector(
            '[data-testid="employment-type"], [data-cy="employment-type"], [class*="employmentType"]',
          ),
        ) ?? headerEmploymentType,
      ),
      'dom',
      'high',
    );
    addCandidate(
      'salary_text',
      textOf(
        detailRoot.querySelector(
          '[data-testid="salary"], [data-cy="salary"], [class*="salary"]',
        ),
      ),
      'dom',
      'medium',
    );
    addCandidate(
      'skills',
      structuredItems(
        detailRoot.querySelector(
          '[data-testid="skills"], [data-cy="skills"], [class*="skills-section"]',
        ) ?? sectionByHeading(/^skills$/i, detailRoot),
      ),
      'dom',
      'high',
    );
  }

  async function extractWellfoundDom(): Promise<void> {
    const root = document.querySelector('main') ?? document.body;
    const [titleEl, descriptionEl] = await waitForEach(
      [
        () =>
          root.querySelector(
            '[data-test="JobListingTitle"], [data-testid="job-title"], h1',
          ) ?? undefined,
        () =>
          root.querySelector(
            '[data-test="JobDescription"], [data-testid="job-description"], [class*="job-description"]',
          ) ?? undefined,
      ],
      800,
    );
    addCandidate('job_title', textOf(titleEl), 'dom', 'high');
    addCandidate(
      'job_description',
      descriptionEl ? elementToSafeMarkdown(descriptionEl) : undefined,
      'dom',
      'high',
    );
    addCandidate(
      'company_name',
      textOf(
        root.querySelector(
          '[data-test="CompanyName"], [data-testid="company-name"], a[href*="/company/"]',
        ),
      ),
      'dom',
      'high',
    );
    const locationText = textOf(
      root.querySelector(
        '[data-test="JobLocation"], [data-testid="job-location"], [class*="job-location"]',
      ),
    );
    addCandidate('job_location', locationText, 'dom', 'high');
    addCandidate('is_remote', remoteFromText(locationText), 'dom', 'high');
    addCandidate(
      'salary_text',
      textOf(
        root.querySelector(
          '[data-test="Compensation"], [data-testid="compensation"], [class*="compensation"]',
        ),
      ),
      'dom',
      'high',
    );
    addCandidate(
      'job_type',
      mapVisibleEmploymentType(
        textOf(
          root.querySelector(
            '[data-test="JobType"], [data-testid="job-type"], [class*="job-type"]',
          ),
        ),
      ),
      'dom',
      'high',
    );
  }

  function extractBuiltInDom(): void {
    if (!/(^|\.)builtin(?:colorado)?\.com$/i.test(location.hostname)) return;
    const pathJobId = /\/job\/[^/]+\/(\d+)\/?$/i.exec(location.pathname)?.[1];
    const descriptionEl =
      (pathJobId
        ? document.querySelector(`#job-post-body-${pathJobId}`)
        : undefined) ?? document.querySelector('[id^="job-post-body-"]');
    addCandidate(
      'job_title',
      textOf(document.querySelector('main h1, h1')),
      'dom',
      'high',
    );
    addCandidate(
      'company_name',
      textOf(
        document.querySelector(
          'main a[href*="/company/"], [data-id="company-name"]',
        ),
      ),
      'dom',
      'high',
    );
    addCandidate(
      'job_description',
      descriptionEl ? elementToSafeMarkdown(descriptionEl) : undefined,
      'dom',
      'high',
    );
    addCandidate(
      'job_location',
      textOf(
        document.querySelector(
          '[data-id="job-location"], [data-testid="job-location"]',
        ),
      ),
      'dom',
      'medium',
    );
    addCandidate('external_job_id', pathJobId, 'dom', 'high');
  }

  // LinkedIn's own <title> tag already spells out
  // "{Title} | {Company} | LinkedIn" (optionally prefixed with an
  // unread-notification badge like "(3) "). Parsing it is available the
  // instant the page loads, unlike any DOM selector, which depends on
  // LinkedIn's client-side render and rotates classnames across deploys.
  function parseLinkedinPageTitle(rawTitle: string): {
    company?: string | undefined;
    title?: string | undefined;
  } {
    const withoutBadge = rawTitle.replace(/^\(\d+\)\s*/, '');
    const parts = withoutBadge.split('|').map((part) => part.trim());
    if (parts.length < 3 || parts.at(-1)?.toLowerCase() !== 'linkedin') {
      return {};
    }
    return {
      title: parts[0] || undefined,
      company: parts[1] || undefined,
    };
  }

  function findLastLinkedinLazyColumn(): Element | undefined {
    return Array.from(
      document.querySelectorAll('[data-testid="lazy-column"]'),
    ).at(-1);
  }

  function findAboutTheJobHeading(): Element | undefined {
    const root = findLastLinkedinLazyColumn() ?? document;
    const heading = Array.from(root.querySelectorAll('h2')).find((h) =>
      textOf(h)?.toLowerCase().includes('about the job'),
    );
    return heading ?? undefined;
  }

  function findLinkedinDescriptionSource(): Element | undefined {
    return (
      document.querySelector('[data-testid="expandable-text-box"]') ??
      findAboutTheJobHeading()
    );
  }

  function findLinkedinCompany(): Element | undefined {
    const root = findLastLinkedinLazyColumn() ?? document;
    return (
      root.querySelector('a[href^="https://www.linkedin.com/company/"]') ??
      undefined
    );
  }

  function isWithinLinkedinDescription(
    element: Element,
    heading: Element | undefined,
    stopHeading: Element | undefined,
  ): boolean {
    if (!heading) return false;
    const followsHeading = Boolean(
      heading.compareDocumentPosition(element) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const precedesStop =
      !stopHeading ||
      Boolean(
        element.compareDocumentPosition(stopHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    return element === heading || (followsHeading && precedesStop);
  }

  function findLinkedinDescriptionStopHeading(
    root: ParentNode,
    heading: Element,
  ): Element | undefined {
    const startLevel = headingLevel(heading) ?? 2;
    return Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).find(
      (candidate) =>
        candidate !== heading &&
        Boolean(
          heading.compareDocumentPosition(candidate) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ) &&
        (headingLevel(candidate) ?? 7) <= startLevel,
    );
  }

  function linkedinCompactTexts(
    root: ParentNode,
    descriptionSource: Element | undefined,
  ): string[] {
    const descriptionHeading =
      descriptionSource &&
      !descriptionSource.matches('[data-testid="expandable-text-box"]')
        ? descriptionSource
        : undefined;
    const descriptionStopHeading = descriptionHeading
      ? findLinkedinDescriptionStopHeading(root, descriptionHeading)
      : undefined;
    const values = Array.from(
      root.querySelectorAll<HTMLElement>('button, a, li, span, p'),
    ).flatMap((element) => {
      if (
        element.closest('[data-testid="expandable-text-box"]') ||
        isWithinLinkedinDescription(
          element,
          descriptionHeading,
          descriptionStopHeading,
        )
      ) {
        return [];
      }
      const text = textOf(element);
      const ariaLabel = element.getAttribute('aria-label')?.trim();
      return [text, ariaLabel];
    });

    return Array.from(
      new Set(
        values.filter(
          (value): value is string =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 200,
        ),
      ),
    );
  }

  function mapLinkedinJobType(
    texts: string[],
  ): JobDraft['job_type'] | undefined {
    for (const text of texts) {
      const mapping = LINKEDIN_JOB_TYPE_MAPPINGS.find(([pattern]) =>
        pattern.test(text),
      );
      if (mapping) return mapping[1];
    }
    return undefined;
  }

  function mapLinkedinJobTypeFromDescription(
    description: string | undefined,
  ): JobDraft['job_type'] | undefined {
    if (!description) return undefined;
    for (const pattern of LINKEDIN_DESCRIPTION_JOB_TYPE_PATTERNS) {
      for (const match of description.matchAll(
        new RegExp(pattern.source, 'gi'),
      )) {
        const value = match[1];
        const start = match.index;
        if (!value || start === undefined) continue;

        const before = description.slice(Math.max(0, start - 24), start);
        const after = description.slice(start + match[0].length, start + 64);
        if (
          /\b(?:no|not|never|without)(?:\s+an?)?\s*$/i.test(before) ||
          /^\s*(?:is|are|will be)\s+(?:not|never|unavailable)\b/i.test(after)
        ) {
          continue;
        }

        return mapLinkedinJobType([value]);
      }
    }
    return undefined;
  }

  function mapLinkedinExperienceLevel(
    texts: string[],
  ): JobDraft['experience_level'] | undefined {
    for (const text of texts) {
      const mapping = LINKEDIN_EXPERIENCE_LEVEL_MAPPINGS.find(([pattern]) =>
        pattern.test(text),
      );
      if (mapping) return mapping[1];
    }
    return undefined;
  }

  function inferExperienceFromTitle(
    title: string | undefined,
  ): JobDraft['experience_level'] | undefined {
    if (!title) return undefined;
    if (/\b(chief|director|vice president|vp|executive)\b/i.test(title)) {
      return 'executive';
    }
    if (/\b(staff|principal|lead)\b/i.test(title)) return 'lead';
    if (/\b(senior|sr\.?)\b/i.test(title)) return 'senior';
    if (/\b(mid[- ]level|intermediate)\b/i.test(title)) return 'mid';
    if (/\b(junior|jr\.?|entry[- ]level|new grad|intern)\b/i.test(title)) {
      return 'entry';
    }
    return undefined;
  }

  function inferExperienceFromDescription(
    description: string | undefined,
  ): JobDraft['experience_level'] | undefined {
    if (!description) return undefined;
    const explicit =
      /\b(entry[- ]level|junior|mid[- ]level|intermediate|senior(?:[- ]level)?|staff|principal|lead|executive|director[- ]level)\s+(?:position|role|job|candidate)\b/i.exec(
        description,
      )?.[1];
    if (explicit) return inferExperienceFromTitle(explicit);

    const yearsMatch = LINKEDIN_REQUIRED_EXPERIENCE_PATTERNS.map((pattern) =>
      pattern.exec(description),
    ).find((match) => match !== null);
    const years = Number(yearsMatch?.[1]);
    if (!Number.isFinite(years)) return undefined;
    if (years >= 8) return 'lead';
    if (years >= 5) return 'senior';
    if (years >= 3) return 'mid';
    return 'entry';
  }

  function detectLinkedinRemote(texts: string[]): boolean | undefined {
    if (texts.some((text) => /^remote$/i.test(text))) return true;
    if (texts.some((text) => /^(hybrid|on[- ]site|onsite)$/i.test(text))) {
      return false;
    }
    return undefined;
  }

  function detectLinkedinRemoteFromDescription(
    description: string | undefined,
  ): boolean | undefined {
    if (!description) return undefined;
    if (
      /\b(?:this|the)\s+(?:position|role|job)\s+(?:is|will be)\s+(?:not|never)\s+(?:fully\s+)?remote\b/i.test(
        description,
      ) ||
      /\bremote\s+(?:work|position|role|job)\s+(?:is|are|will be)\s+(?:not|never|unavailable)\b/i.test(
        description,
      ) ||
      /\b(?:no|without)\s+remote\s+(?:work|option|position|role|job)\b/i.test(
        description,
      )
    ) {
      return false;
    }
    if (
      /\b(?:this|the)\s+(?:position|role|job)\s+(?:is|will be)\s+(?:an?\s+)?(?:hybrid|on[- ]site|onsite|in[- ]office)\b/i.test(
        description,
      ) ||
      /\b(?:workplace|work arrangement|work location|location)\s*:\s*(?:hybrid|on[- ]site|onsite|in[- ]office)\b/i.test(
        description,
      )
    ) {
      return false;
    }
    if (
      /\b(?:this|the)\s+(?:position|role|job)\s+(?:is|will be)\s+(?:fully\s+)?remote\b/i.test(
        description,
      ) ||
      /\b(?:fully\s+)?remote\s+(?:position|role|job|work)\b/i.test(
        description,
      ) ||
      /\b(?:workplace|work arrangement|work location|location)\s*:\s*(?:fully\s+)?remote\b/i.test(
        description,
      )
    ) {
      return true;
    }
    return undefined;
  }

  function detectClearanceRequirement(
    description: string | undefined,
  ): boolean | undefined {
    if (!description) return undefined;
    if (
      /\bno (?:[\w/-]+ ){0,4}(?:security )?clearance (?:is )?required\b/i.test(
        description,
      ) ||
      /\b(?:does not|doesn't|do not|don't) require (?:an? )?(?:[\w/-]+ ){0,4}(?:security )?clearance\b/i.test(
        description,
      ) ||
      /\b(?:[\w/-]+ ){0,4}(?:security )?clearance\b[^\n.!?]{0,40}\bnot (?:currently )?required\b/i.test(
        description,
      )
    ) {
      return false;
    }
    if (
      /\b(?:active|current) (?:[\w/-]+ )?(?:security )?clearance\b/i.test(
        description,
      ) ||
      /\b(?:clearance|security clearance) (?:is )?required\b/i.test(
        description,
      ) ||
      /\b(?:must (?:have|hold|possess)|requires?|required to (?:have|hold|possess)|ability to obtain) (?:an? )?(?:active )?(?:[\w/-]+ )?(?:security )?clearance\b/i.test(
        description,
      ) ||
      /\b(?:TS\/SCI|top secret\/SCI|secret clearance)\b/i.test(description)
    ) {
      return true;
    }
    return undefined;
  }

  function parseLinkedinSalary(texts: string[]):
    | {
        text: string;
        type: NonNullable<JobDraft['salary_type']>;
        min: number;
        max: number;
      }
    | undefined {
    const hasUsdMarker = (text: string): boolean =>
      !/\b(?!US(?:D)?\b|TO\b|UP\b|IS\b|AT\b|OF\b|A\b)[A-Z]{1,3}\s*\$/i.test(
        text,
      ) && /(?:\bUSD\b|\bUS\$|(?<![A-Za-z])\$)/i.test(text);
    const isUnitlessAnnualUpperBound = (text: string): boolean =>
      /^\s*(?:(?:base\s+)?(?:salary|pay|compensation)\s*)?up\s+to\s+(?:USD\s*\$?|US\$|(?<![A-Za-z])\$)\s*[\d,.]+\s*k\s*$/i.test(
        text,
      );
    const salaryText = texts
      .filter(
        (text) =>
          !/\b(?:AUD|CAD|EUR|GBP|NZD)\b/i.test(text) &&
          hasUsdMarker(text) &&
          (/(?:\/\s*(?:yr|year|hr|hour)|per\s+(?:year|hour)|annually|hourly)/i.test(
            text,
          ) ||
            isUnitlessAnnualUpperBound(text)),
      )
      .sort((a, b) => a.length - b.length)[0];
    if (!salaryText) return undefined;

    const values = Array.from(
      salaryText.matchAll(
        /(?:\bUSD\s*\$?|\bUS\$|(?<![A-Za-z])\$)\s*([\d,.]+)\s*([kK])?/gi,
      ),
    )
      .map((match) => {
        const parsed = Number((match[1] ?? '').replace(/,/g, ''));
        return Number.isFinite(parsed)
          ? parsed * (match[2]?.toLowerCase() === 'k' ? 1000 : 1)
          : undefined;
      })
      .filter((value): value is number => value !== undefined);
    const firstValue = values[0];
    if (firstValue === undefined) return undefined;

    const type = /(?:\/\s*(?:hr|hour)|per\s+hour|hourly)/i.test(salaryText)
      ? 'hourly'
      : 'annual';
    const upperBoundOnly = /\bup\s+to\b/i.test(salaryText);
    const min = upperBoundOnly ? 0 : firstValue;
    const max = upperBoundOnly ? firstValue : (values[1] ?? firstValue);
    return {
      text: formatUsdSalaryRange(min, max),
      type,
      min,
      max,
    };
  }

  function extractLinkedinSalarySignals(
    description: string | undefined,
  ): string[] {
    if (!description) return [];
    const amount = String.raw`(?:USD\s*\$?|US\$|(?<![A-Za-z])\$)\s*[\d,.]+\s*[kK]?`;
    const range = new RegExp(
      String.raw`\b(?:base\s+)?(?:salary|pay|compensation|wage|rate)\b[^.!?]{0,80}?(${amount}(?:\s*(?:-|–|—|to)\s*${amount})?\s*(?:\/\s*(?:yr|year|hr|hour)|per\s+(?:year|hour)|annually|hourly))`,
      'gi',
    );
    const upperBound = new RegExp(
      String.raw`\b(?:base\s+)?(?:salary|pay|compensation|wage|rate)\b[^.!?]{0,40}?(up\s+to\s+${amount}(?:\s*(?:\/\s*(?:yr|year)|per\s+year|annually))?)`,
      'gi',
    );
    return [range, upperBound].flatMap((pattern) =>
      Array.from(description.matchAll(pattern), (match) =>
        (match[1] ?? '').trim(),
      ).filter(Boolean),
    );
  }

  function linkedinLocationScore(text: string): number {
    const normalized = text.toLowerCase();
    if (
      /\b(ago|applicant|reposted|promoted|viewed|connections?)\b/.test(
        normalized,
      )
    ) {
      return 0;
    }

    let score = 0;
    if (
      /^(united states|canada|north america|european union|united kingdom)$/i.test(
        text,
      )
    ) {
      score = 2;
    }
    if (/\b(remote|hybrid|on-site|onsite)\b/.test(normalized)) score = 3;
    if (/\b(area|region|district|metro|metropolitan)\b/.test(normalized)) {
      score = 4;
    }
    if (/^[A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+\b/.test(text)) {
      score = 5;
    }
    if (/^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b/.test(text)) score = 6;
    if (/[·|]/.test(text)) score -= 2;
    if (text.length > 120) score -= 2;
    return Math.max(score, 0);
  }

  function findLinkedinLocation(): Element | undefined {
    const lazyColumn = findLastLinkedinLazyColumn();
    if (!lazyColumn) return undefined;

    for (const paragraph of Array.from(lazyColumn.querySelectorAll('p'))) {
      const paragraphText = textOf(paragraph);
      if (!paragraphText || !/[·|]/.test(paragraphText)) continue;
      if (
        !/\b(ago|applicant|apply|clicked|reposted|promoted|viewed)\b/i.test(
          paragraphText,
        )
      ) {
        continue;
      }

      const firstSpan = Array.from(paragraph.querySelectorAll('span')).find(
        (span) => {
          const text = textOf(span);
          return text ? linkedinLocationScore(text) > 0 : false;
        },
      );
      if (firstSpan) return firstSpan;
    }

    const candidates = Array.from(lazyColumn.querySelectorAll('p, span'))
      .map((el, index) => {
        const text = textOf(el);
        return {
          el,
          index,
          score: text ? linkedinLocationScore(text) : 0,
        };
      })
      .filter((candidate) => candidate.score > 0);

    candidates.sort((a, b) => b.score - a.score || b.index - a.index);
    return candidates[0]?.el;
  }

  function headingLevel(el: Element): number | undefined {
    const match = /^H([1-6])$/.exec(el.tagName);
    if (match?.[1]) return Number(match[1]);

    const ariaLevel = Number(el.getAttribute('aria-level'));
    return Number.isInteger(ariaLevel) && ariaLevel >= 1 && ariaLevel <= 6
      ? ariaLevel
      : undefined;
  }

  function isLinkedinCompanyInsightsUpsellLink(href: string | null): boolean {
    if (!href) return false;
    try {
      const url = new URL(href, document.baseURI);
      const trackingValues = [
        url.searchParams.get('upsellOrderOrigin'),
        url.searchParams.get('upsellSlotId'),
      ];
      return (
        /(^|\.)linkedin\.com$/i.test(url.hostname) &&
        url.pathname.startsWith('/premium/') &&
        trackingValues.some((value) =>
          value?.toLowerCase().includes('jdp_aiq_company_insights'),
        )
      );
    } catch {
      return false;
    }
  }

  function hasLinkedinCompanyInsightsCardStructure(
    candidate: Element,
  ): boolean {
    if (!/^(ASIDE|ARTICLE|DIV|SECTION)$/.test(candidate.tagName)) return false;

    const directChildren = Array.from(candidate.children);
    const paragraphCount = directChildren.filter(
      (child) => child.tagName === 'P',
    ).length;
    const hasInsightSkeleton = directChildren
      .filter((child) => /^(OL|UL)$/.test(child.tagName))
      .some((list) => {
        const items = Array.from(list.children).filter(
          (child) => child.tagName === 'LI',
        );
        return (
          items.length >= 3 &&
          items.every((item) => !(item.textContent ?? '').trim())
        );
      });

    return paragraphCount >= 3 && hasInsightSkeleton;
  }

  // LinkedIn inserts this card inside the bounded About-the-job range without
  // a heading of its own. Keep this cleanup provider-local, and require both
  // its tracked CTA and observed direct-child structure before removing the
  // nearest card. A CTA inside a general description wrapper is left intact.
  function removeLinkedinCompanyInsightsUpsell(root: ParentNode): void {
    for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!isLinkedinCompanyInsightsUpsellLink(link.getAttribute('href'))) {
        continue;
      }

      let candidate = link.parentElement;
      while (candidate) {
        if (hasLinkedinCompanyInsightsCardStructure(candidate)) {
          candidate.remove();
          break;
        }
        if (candidate.parentNode === root) break;
        candidate = candidate.parentElement;
      }
    }
  }

  // LinkedIn can render the "About the job" heading inside a broad details
  // container that also includes adjacent sections. Read text after the
  // heading in document order, stopping at the next same-or-higher-level
  // heading, so neighboring sections do not leak into job_description.
  function descriptionMarkdownAfterHeading(
    heading: Element,
  ): string | undefined {
    const startLevel = headingLevel(heading) ?? 2;
    const scope =
      findLastLinkedinLazyColumn() ??
      heading.closest('article, section, main') ??
      heading.parentElement;
    let fallbackMarkdown: string | undefined;

    for (
      let boundary = heading.parentElement;
      boundary && boundary !== document.body.parentElement;
      boundary = boundary.parentElement
    ) {
      const stopHeading = Array.from(
        boundary.querySelectorAll('h1, h2, h3, h4, h5, h6'),
      ).find(
        (candidate) =>
          candidate !== heading &&
          Boolean(
            heading.compareDocumentPosition(candidate) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ) &&
          (headingLevel(candidate) ?? 7) <= startLevel,
      );

      const range = document.createRange();
      range.setStartAfter(heading);
      if (stopHeading) {
        range.setEndBefore(stopHeading);
      } else {
        range.setEnd(boundary, boundary.childNodes.length);
      }

      const descriptionFragment = range.cloneContents();
      removeLinkedinCompanyInsightsUpsell(descriptionFragment);
      const markdown = htmlToSafeMarkdown(descriptionFragment);
      if (markdown) fallbackMarkdown = markdown;
      if (stopHeading && markdown) return markdown;
      if (boundary === scope) break;
    }
    return fallbackMarkdown;
  }

  function linkedinDescriptionMarkdown(source: Element): string | undefined {
    if (!source.matches('[data-testid="expandable-text-box"]')) {
      return descriptionMarkdownAfterHeading(source);
    }

    const description = source.cloneNode(true) as Element;
    removeLinkedinCompanyInsightsUpsell(description);
    for (const control of description.querySelectorAll(
      'button, [role="button"]',
    )) {
      control.remove();
    }
    return elementToSafeMarkdown(description);
  }

  async function extractLinkedinDom(): Promise<void> {
    const { company, title } = parseLinkedinPageTitle(document.title);
    // Both fields come from an unambiguous pipe-delimited split, so both
    // are as trustworthy as any other platform's dom-sourced high-confidence
    // candidate.
    addCandidate('company_name', company, 'dom', 'high');
    addCandidate('job_title', title, 'dom', 'high');

    // Secondary signal for company_name: the employer's own profile link is
    // the only stable, hash-free DOM selector on LinkedIn's job pages, and
    // covers cases where <title> doesn't follow the pipe-delimited pattern
    // (e.g. a split-view search results page that hasn't navigated to a
    // dedicated job URL). Scope it to the selected lazy column so search
    // result cards do not leak into the active job. job_location and
    // job_description have no page-title source at all, so their DOM
    // selectors (rendered after the SPA hydrates) are the only signal
    // available -- wait on all three together in one observer.
    const [companyEl, locationEl, descriptionEl] = await waitForEach(
      [
        findLinkedinCompany,
        findLinkedinLocation,
        findLinkedinDescriptionSource,
      ],
      800,
    );
    addCandidate('company_name', textOf(companyEl), 'dom', 'high');
    addCandidate('job_location', textOf(locationEl), 'dom', 'medium');
    const description = descriptionEl
      ? linkedinDescriptionMarkdown(descriptionEl)
      : undefined;
    addCandidate('job_description', description, 'dom', 'high');

    const selectedPane = findLastLinkedinLazyColumn();
    if (!selectedPane) return;

    const compactTexts = linkedinCompactTexts(selectedPane, descriptionEl);
    const structuredJobType = mapLinkedinJobType(compactTexts);
    addCandidate('job_type', structuredJobType, 'dom', 'high');
    if (!structuredJobType) {
      addCandidate(
        'job_type',
        mapLinkedinJobTypeFromDescription(description),
        'dom',
        'medium',
      );
    }
    const structuredRemote = detectLinkedinRemote(compactTexts);
    addCandidate('is_remote', structuredRemote, 'dom', 'high');
    if (structuredRemote === undefined) {
      addCandidate(
        'is_remote',
        detectLinkedinRemoteFromDescription(description),
        'dom',
        'medium',
      );
    }

    const structuredExperience = mapLinkedinExperienceLevel(compactTexts);
    addCandidate('experience_level', structuredExperience, 'dom', 'high');
    if (!structuredExperience) {
      const titleExperience = inferExperienceFromTitle(
        title ?? textOf(selectedPane.querySelector('h1')),
      );
      addCandidate('experience_level', titleExperience, 'dom', 'medium');
      if (!titleExperience) {
        addCandidate(
          'experience_level',
          inferExperienceFromDescription(description),
          'dom',
          'low',
        );
      }
    }

    addCandidate(
      'security_clearance_req',
      detectClearanceRequirement(description),
      'dom',
      'medium',
    );

    const structuredSalary = parseLinkedinSalary(compactTexts);
    const salary =
      structuredSalary ??
      parseLinkedinSalary(extractLinkedinSalarySignals(description));
    if (salary) {
      const salaryConfidence = structuredSalary ? 'high' : 'medium';
      addCandidate('salary_text', salary.text, 'dom', salaryConfidence);
      addCandidate('salary_type', salary.type, 'dom', salaryConfidence);
      if (salary.type === 'annual') {
        addCandidate(
          'salary_min',
          Math.round(salary.min * 100),
          'dom',
          salaryConfidence,
        );
        addCandidate(
          'salary_max',
          Math.round(salary.max * 100),
          'dom',
          salaryConfidence,
        );
      } else {
        addCandidate('hourly_rate_min', salary.min, 'dom', salaryConfidence);
        addCandidate('hourly_rate_max', salary.max, 'dom', salaryConfidence);
      }
    }
  }

  const GOOGLE_JOB_HEADING_SELECTOR =
    '[role="heading"][aria-level="2"], [role="heading"][aria-level="3"]';
  const MAX_PLAUSIBLE_COMPANY_NAME_LENGTH = 80;

  function queryGoogleJobHeadings(): Element[] {
    return Array.from(document.querySelectorAll(GOOGLE_JOB_HEADING_SELECTOR));
  }

  function findExplicitlySelectedGoogleJobHeading(
    headings: Element[],
  ): Element | undefined {
    // On a search-results page, multiple job cards can each render a
    // heading matching this selector -- prefer the one inside a panel
    // explicitly marked as the currently selected/expanded job over just
    // taking the first card in the list.
    return headings.find((el) =>
      el.closest('[aria-selected="true"], [aria-expanded="true"]'),
    );
  }

  function pickSelectedGoogleJobHeading(): Element | undefined {
    const headings = queryGoogleJobHeadings();
    // With more than one heading present and none yet marked selected, the
    // choice is genuinely ambiguous -- return undefined so the caller keeps
    // waiting for a selection signal instead of eagerly guessing headings[0].
    // With exactly one heading there's nothing to disambiguate, so resolve
    // immediately rather than waiting out the full timeout on every
    // single-result page.
    return (
      findExplicitlySelectedGoogleJobHeading(headings) ??
      (headings.length === 1 ? headings[0] : undefined)
    );
  }

  function pickGoogleJobDescriptionContainer(
    titleEl: Element,
  ): Element | undefined {
    // Prefer the ancestor explicitly marked as the currently selected/
    // expanded job card -- this is the only scope guaranteed not to leak
    // content from an adjacent card on a multi-result page.
    const selectedCard = titleEl.closest(
      '[aria-selected="true"], [aria-expanded="true"]',
    );
    if (selectedCard) return selectedCard;

    // Single-result pages often carry no explicit selection state. Fall
    // back to a bounded ancestor container, searching from the heading's
    // *parent* rather than the heading itself -- closest() matches the
    // element itself first, and the heading is frequently a <div>, one of
    // this selector's own tags, which would otherwise make the "bounded"
    // check pass trivially and land one level too high.
    return (
      titleEl.parentElement?.closest(
        'div, section, article, [role="article"], [role="region"]',
      ) ?? undefined
    );
  }

  function waitForSelectedGoogleJobHeading(
    timeoutMs: number,
  ): Promise<Element | undefined> {
    return new Promise((resolve) => {
      const immediate = pickSelectedGoogleJobHeading();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const observer = new MutationObserver(() => {
        const el = pickSelectedGoogleJobHeading();
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        // Some SPAs toggle aria-selected/aria-expanded on already-mounted
        // card nodes instead of inserting new elements -- without watching
        // attributes, that toggle wouldn't retrigger evaluation and this
        // could resolve to the wrong (first) heading before selection state
        // ever lands.
        attributes: true,
        attributeFilter: ['aria-selected', 'aria-expanded'],
      });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(undefined);
      }, timeoutMs);
    });
  }

  async function extractGoogleJobsDom(): Promise<void> {
    const titleEl = await waitForSelectedGoogleJobHeading(1800);
    addCandidate('job_title', textOf(titleEl), 'dom', 'high');
    if (!titleEl) return;

    const titleText = textOf(titleEl);
    const companyText = textOf(titleEl.nextElementSibling);
    if (
      companyText &&
      companyText.length <= MAX_PLAUSIBLE_COMPANY_NAME_LENGTH &&
      companyText !== titleText
    ) {
      addCandidate('company_name', companyText, 'dom', 'low');
    }

    const container = pickGoogleJobDescriptionContainer(titleEl);
    if (container) {
      // 'medium', not 'low': once a bounded, explicitly-scoped container is
      // found (see pickGoogleJobDescriptionContainer's own scoping guard),
      // this is the selected job's actual description, not a fabricated
      // guess -- it should out-rank a generic page-level meta description
      // in the merge step, not lose to it.
      addCandidate(
        'job_description',
        (() => {
          const description = container.querySelector(
            'section, [role="article"]',
          );
          return description ? elementToSafeMarkdown(description) : undefined;
        })(),
        'dom',
        'medium',
      );
    }
  }

  // --- jsonld source ---------------------------------------------------
  const jobPosting = pickRichestJobPosting(collectJsonLdJobPostings());
  if (jobPosting) {
    const title = jobPosting.title;
    addCandidate(
      'job_title',
      typeof title === 'string' ? title.trim() : undefined,
      'jsonld',
      'high',
    );

    const org = jobPosting.hiringOrganization;
    const orgName =
      typeof org === 'string'
        ? org
        : org && typeof org === 'object'
          ? (org as Record<string, unknown>).name
          : undefined;
    addCandidate(
      'company_name',
      typeof orgName === 'string' ? orgName.trim() : undefined,
      'jsonld',
      'high',
    );

    const description = jobPosting.description;
    if (typeof description === 'string') {
      addCandidate(
        'job_description',
        htmlToSafeMarkdown(description),
        'jsonld',
        'high',
      );
    }

    const datePosted = jobPosting.datePosted;
    if (typeof datePosted === 'string') {
      addCandidate(
        'date_posted',
        normalizePlainDate(datePosted),
        'jsonld',
        'high',
      );
    }

    addCandidate(
      'job_type',
      mapEmploymentType(jobPosting.employmentType),
      'jsonld',
      'high',
    );

    addCandidate(
      'is_remote',
      detectRemoteFromJsonLd(jobPosting),
      'jsonld',
      'high',
    );

    addCandidate(
      'job_location',
      extractLocationText(jobPosting.jobLocation),
      'jsonld',
      'high',
    );

    extractSalary(jobPosting);

    const identifier = jobPosting.identifier;
    const identifierValue =
      typeof identifier === 'string'
        ? identifier
        : identifier && typeof identifier === 'object'
          ? (identifier as Record<string, unknown>).value
          : undefined;
    addCandidate(
      'external_job_id',
      typeof identifierValue === 'string'
        ? identifierValue
        : typeof identifierValue === 'number'
          ? String(identifierValue)
          : undefined,
      'jsonld',
      'high',
    );

    const url = jobPosting.url;
    addCandidate(
      'job_link',
      typeof url === 'string' ? resolveUrl(url) : undefined,
      'jsonld',
      'high',
    );
  }

  // --- meta source -------------------------------------------------------
  addCandidate('job_title', metaContent('og:title'), 'meta', 'medium');
  const metaDescription =
    document
      .querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.content?.trim() || metaContent('og:description');
  addCandidate(
    'job_description',
    metaDescription ? plainTextToSafeMarkdown(metaDescription) : undefined,
    'meta',
    'medium',
  );

  // og:site_name is the *hosting site's own* brand (e.g. "Indeed",
  // "Glassdoor") on aggregator job boards, not the employer -- only trust it
  // as a company name candidate off this set. Greenhouse/Lever/Workday are
  // deliberately excluded: those are white-labeled ATS embeds hosted under
  // the *employer's own* branding (e.g. boards.greenhouse.io/acmecorp), so
  // og:site_name there is plausibly the employer's own name, same as an
  // unrecognized careers page.
  const SITE_BRANDED_PLATFORMS = new Set<ApiSourcePlatform>([
    'linkedin',
    'indeed',
    'glassdoor',
    'dice',
    'angellist',
    'google',
  ]);
  if (!SITE_BRANDED_PLATFORMS.has(detection.platform)) {
    addCandidate('company_name', metaContent('og:site_name'), 'meta', 'medium');
  }

  const metaUrl = metaContent('og:url');
  const canonicalUrl = document
    .querySelector<HTMLLinkElement>('link[rel="canonical"]')
    ?.href?.trim();
  const resolvedCanonicalUrl = canonicalUrl
    ? resolveUrl(canonicalUrl)
    : undefined;
  const resolvedMetaUrl = metaUrl ? resolveUrl(metaUrl) : undefined;
  addCandidate(
    'job_link',
    resolvedCanonicalUrl,
    'meta',
    resolvedCanonicalUrl ? metadataUrlConfidence(resolvedCanonicalUrl) : 'low',
  );
  addCandidate(
    'job_link',
    resolvedMetaUrl,
    'meta',
    resolvedMetaUrl ? metadataUrlConfidence(resolvedMetaUrl) : 'low',
  );

  // --- url source ----------------------------------------------------------
  const href = location.href;
  addCandidate('job_link', href, 'url', 'medium');
  addCandidate(
    'source_platform',
    detection.platform,
    'url',
    detection.confidence,
  );

  const titleForId =
    document.title || document.querySelector('h1')?.textContent || undefined;
  const inferredExternalId = (() => {
    if (detection.externalJobId) return detection.externalJobId;
    const activeUrl = new URL(href);
    if (
      detection.platform === 'indeed' &&
      activeUrl.pathname !== '/viewjob' &&
      !activeUrl.searchParams.get('jk') &&
      !activeUrl.searchParams.get('vjk')
    ) {
      return undefined;
    }
    return inferExternalId(href, titleForId);
  })();
  addCandidate('external_job_id', inferredExternalId, 'url', 'medium');

  // --- platform-specific dom source -----------------------------------------
  // A single dispatch table instead of a hand-written if/else chain -- adding
  // a new platform's DOM extractor is then a one-line addition here, in one
  // place, instead of a new branch easy to forget.
  const platformDomExtractors: Partial<
    Record<ApiSourcePlatform, () => void | Promise<void>>
  > = {
    linkedin: extractLinkedinDom,
    indeed: extractIndeedDom,
    glassdoor: extractGlassdoorDom,
    greenhouse: extractGreenhouseDom,
    lever: extractLeverDom,
    workday: extractWorkdayDom,
    dice: extractDiceDom,
    angellist: extractWellfoundDom,
    google: extractGoogleJobsDom,
  };
  // 'direct' is the API's catch-all bucket for every unrecognized careers
  // page, not just BuiltIn -- so it can't be wired to a single extractor the
  // way the enum-specific platforms above are. Each entry here self-guards
  // on hostname (see extractBuiltInDom) and a future direct-bucket site gets
  // its own entry instead of another hostname branch bolted onto an
  // unrelated site's extractor.
  const directDomExtractors: (() => void | Promise<void>)[] = [
    extractBuiltInDom,
  ];
  if (detection.platform === 'direct') {
    for (const extractor of directDomExtractors) {
      await extractor();
    }
  } else {
    await platformDomExtractors[detection.platform]?.();
  }

  // User-authored templates are a medium-confidence bridge between targeted
  // provider rules and generic fallbacks. Only the deterministic best match
  // applies; provider high-confidence candidates therefore retain priority.
  const matchedTemplate = selectMatchingSiteTemplates(
    templates,
    location.href,
  )[0];
  const appliedTemplate = matchedTemplate
    ? executeSiteTemplate(
        matchedTemplate,
        document,
        location.href,
        elementToSafeMarkdown,
      )
    : undefined;
  if (appliedTemplate) {
    for (const [field, value] of Object.entries(appliedTemplate.values)) {
      addCandidate(field as keyof JobDraft, value, 'template', 'medium');
    }
  }

  // --- visible-text source -------------------------------------------------
  const h1Text = document
    .querySelector('h1')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim();
  addCandidate('job_title', h1Text, 'visible-text', 'low');

  const bodyNode =
    document.querySelector('main') ??
    document.querySelector('article') ??
    document.body;
  const bodyText = bodyNode?.textContent
    ?.replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);
  addCandidate(
    'job_description',
    bodyText ? plainTextToSafeMarkdown(bodyText) : undefined,
    'visible-text',
    'low',
  );

  // --- merge candidates into a single best-guess draft ---------------------
  // 'dom' ranks above 'jsonld' as a tiebreak: a platform DOM extractor only
  // runs for the platform actually detected on this page, scraping whatever
  // is on screen right now, whereas a JSON-LD block can be stale left-over
  // markup from a previous SPA-rendered view (e.g. a split-view results list
  // where clicking a different job updates the visible panel but not a
  // server-rendered <head> script tag) that just happens to still be present
  // in the DOM.
  const priority: Record<Source, number> = {
    dom: 0,
    jsonld: 1,
    meta: 2,
    template: 3,
    url: 4,
    'visible-text': 5,
    // Description-derived taxonomy values are appended after ranking (see the
    // taxonomy merge below); the rank only exists so the table is exhaustive.
    description: 6,
  };
  const confidenceRank: Record<Confidence, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  const draft: Record<string, unknown> = {};
  const confidenceMap: Partial<Record<keyof JobDraft, Confidence>> = {};
  const selectedSources: Partial<Record<keyof JobDraft, Source>> = {};
  const outCandidates: FieldCandidates = {};

  (Object.keys(fieldCandidates) as (keyof JobDraft)[]).forEach((field) => {
    const list = fieldCandidates[field];
    if (!list || list.length === 0) return;

    // Confidence is the primary ranking signal -- a targeted but uncertain
    // 'dom' heuristic (e.g. Google's proximity-based description guess)
    // should not out-rank a more reliable lower-priority source just
    // because 'dom' sits above it in the source priority order. Source
    // priority only breaks ties between candidates of equal confidence.
    const sorted = [...list].sort(
      (a, b) =>
        confidenceRank[a.confidence] - confidenceRank[b.confidence] ||
        priority[a.source] - priority[b.source],
    );
    const winner = sorted[0];
    if (winner) {
      draft[field] = winner.value;
      confidenceMap[field] = winner.confidence;
      selectedSources[field] = winner.source;
    }

    const distinctValues = new Set(list.map((c) => JSON.stringify(c.value)));
    if (distinctValues.size >= 2) {
      outCandidates[field] = list;
    }
  });

  // Taxonomy extraction deliberately runs after candidate resolution so it
  // scans only the selected, sanitized description instead of page-wide text
  // or an adjacent/stale provider candidate.
  //
  // Documented precedence per category (skills, software, certifications,
  // keywords): structured provider values (e.g. Dice's skills section,
  // Lever's department) come first, then description-derived canonical
  // matches are appended; duplicates are dropped case-insensitively *within*
  // the category only, and each category is capped at MAX_TAGS_PER_FIELD.
  // Values are never moved or deduplicated across categories -- ownership is
  // decided by the catalog, not by which category matched first.
  const selectedDescription = draft.job_description;
  if (
    typeof selectedDescription === 'string' &&
    selectedDescription.trim() &&
    selectedSources.job_description !== 'visible-text'
  ) {
    const extracted = extractTaxonomy(selectedDescription);
    const taxonomyFields = [
      'skills',
      'software',
      'certifications',
      'keywords',
    ] as const;

    for (const field of taxonomyFields) {
      const provided = Array.isArray(draft[field])
        ? (draft[field] as string[])
        : [];
      const merged = mergeTaxonomyTags(provided, extracted[field]);

      if (merged.length > 0) {
        draft[field] = merged;
        confidenceMap[field] ??= 'low';

        // When a structured provider value was merged with description
        // matches, expose both variants in the field review so the user can
        // see each candidate's source and fall back to the provider-only
        // list if the description scan added noise.
        const providerCandidates = fieldCandidates[field] ?? [];
        if (
          provided.length > 0 &&
          merged.length > provided.length &&
          providerCandidates.length > 0
        ) {
          outCandidates[field] = [
            ...providerCandidates,
            { value: merged, source: 'description', confidence: 'low' },
          ];
        }
      }
    }
  }

  if (Object.keys(confidenceMap).length > 0) {
    draft.extraction_confidence = confidenceMap;
  }

  return {
    draft: draft as unknown as JobDraft,
    candidates: outCandidates,
    ...(appliedTemplate
      ? {
          appliedTemplate: {
            id: appliedTemplate.templateId,
            name: appliedTemplate.templateName,
          },
        }
      : {}),
  };
}
