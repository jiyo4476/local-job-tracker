// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import builtInFixture from '../../../fixtures/html/builtin-colorado-basic.html?raw';
import builtInRemoteFixture from '../../../fixtures/html/builtin-colorado-remote.html?raw';
import diceFixture from '../../../fixtures/html/dice-basic.html?raw';
import greenhouseFixture from '../../../fixtures/html/greenhouse-ats-basic.html?raw';
import indeedSplitViewFixture from '../../../fixtures/html/indeed-split-view.html?raw';
import leverFixture from '../../../fixtures/html/lever-basic.html?raw';
import wellfoundFixture from '../../../fixtures/html/wellfound-basic.html?raw';
import workdayFixture from '../../../fixtures/html/workday-basic.html?raw';
import { extractJobDraft } from './jobDraftExtractor';
import { siteTemplateSchema } from '../templates/schema';

function setHead(html: string): void {
  document.head.innerHTML = html;
}

function setBody(html: string): void {
  document.body.innerHTML = html;
}

function setLocation(url: string): void {
  vi.stubGlobal('location', new URL(url));
}

function loadFixture(html: string, url: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  setLocation(url);
}

const OTHER = { platform: 'other' as const, confidence: 'low' as const };

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.title = '';
});

describe('extractJobDraft — reusable site templates', () => {
  function titleTemplate() {
    return siteTemplateSchema.parse({
      id: crypto.randomUUID(),
      name: 'Acme careers',
      hostname: 'careers.acme.example',
      path_pattern: '/jobs/*',
      rules: [
        {
          field: 'job_title',
          selector: '.template-title',
          transforms: ['trim'],
        },
      ],
    });
  }

  it('uses a matching template ahead of generic visible-text fallback', async () => {
    setLocation('https://careers.acme.example/jobs/123');
    setBody(
      '<h1>Generic heading</h1><p class="template-title">Template title</p>',
    );

    const result = await extractJobDraft(
      { platform: 'direct', confidence: 'low' },
      [titleTemplate()],
    );

    expect(result.draft.job_title).toBe('Template title');
    expect(result.appliedTemplate?.name).toBe('Acme careers');
  });

  it('keeps high-confidence structured data ahead of a template candidate', async () => {
    setLocation('https://careers.acme.example/jobs/123');
    setHead(`<script type="application/ld+json">
      { "@type": "JobPosting", "title": "Structured title" }
    </script>`);
    setBody('<p class="template-title">Template title</p>');

    const result = await extractJobDraft(
      { platform: 'direct', confidence: 'low' },
      [titleTemplate()],
    );

    expect(result.draft.job_title).toBe('Structured title');
    expect(result.candidates.job_title).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'template',
          value: 'Template title',
        }),
      ]),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('extractJobDraft — JSON-LD source', () => {
  it('extracts fields from a JobPosting JSON-LD block', async () => {
    setHead(`
      <title>Data Engineer - Data Co</title>
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "JobPosting",
          "title": "Data Engineer",
          "hiringOrganization": { "@type": "Organization", "name": "Data Co" },
          "datePosted": "2026-07-01",
          "description": "<p>Build <strong>data</strong> pipelines.</p>",
          "url": "https://example.com/jobs/data-engineer",
          "identifier": { "@type": "PropertyValue", "value": "job-42" },
          "employmentType": "FULL_TIME",
          "jobLocation": {
            "@type": "Place",
            "address": { "addressLocality": "Austin", "addressRegion": "TX" }
          }
        }
      </script>
    `);
    setBody('<main><h1>Data Engineer</h1></main>');

    const { draft, candidates } = await extractJobDraft(OTHER);

    expect(draft.job_title).toBe('Data Engineer');
    expect(draft.company_name).toBe('Data Co');
    expect(draft.date_posted).toBe('2026-07-01');
    expect(draft.job_description).toBe('Build **data** pipelines.');
    expect(draft.job_link).toBe('https://example.com/jobs/data-engineer');
    expect(draft.external_job_id).toBe('job-42');
    expect(draft.job_type).toBe('full_time');
    expect(draft.job_location).toBe('Austin, TX');
    expect(draft.extraction_confidence?.job_title).toBe('high');
    expect(draft.extraction_confidence?.company_name).toBe('high');

    // job_title only has a single jsonld candidate here (h1 text matches
    // exactly, so it collapses to one distinct value) -- no picker needed.
    expect(candidates.company_name).toBeUndefined();
  });

  it('drops an impossible JSON-LD date instead of normalizing it forward', async () => {
    setHead(`
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Date Tester",
          "datePosted": "2026-02-30",
          "url": "https://example.com/jobs/date-tester"
        }
      </script>
    `);

    const { draft, candidates } = await extractJobDraft(OTHER);

    expect(draft.date_posted).toBeUndefined();
    expect(candidates.date_posted).toBeUndefined();
  });

  it('joins multiple JSON-LD jobLocation entries and caps the joined count', async () => {
    setHead(`
      <title>Data Engineer - Data Co</title>
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "JobPosting",
          "title": "Data Engineer",
          "hiringOrganization": { "@type": "Organization", "name": "Data Co" },
          "url": "https://example.com/jobs/data-engineer",
          "jobLocation": [
            { "address": { "addressLocality": "Austin", "addressRegion": "TX" } },
            { "address": { "addressLocality": "Denver", "addressRegion": "CO" } },
            { "address": { "addressLocality": "Chicago", "addressRegion": "IL" } },
            { "address": { "addressLocality": "Boston", "addressRegion": "MA" } },
            { "address": { "addressLocality": "Miami", "addressRegion": "FL" } },
            { "address": { "addressLocality": "Seattle", "addressRegion": "WA" } }
          ]
        }
      </script>
    `);
    setBody('<main><h1>Data Engineer</h1></main>');

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_location).toBe(
      'Austin, TX | Denver, CO | Chicago, IL | Boston, MA | Miami, FL',
    );
  });

  it('sanitizes active content and unsafe links before converting HTML to Markdown', async () => {
    const jsonLd = document.createElement('script');
    jsonLd.type = 'application/ld+json';
    jsonLd.textContent = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Security Engineer',
      description:
        '<h2>Responsibilities</h2><p>Build <em>safe</em> tools.</p><ul><li>Review code<ul><li>Check dependencies</li></ul></li><li><a href="https://example.com/jobs/42">Ship fixes</a></li></ul><script>alert(1)</script><iframe src="https://evil.example"></iframe><p><a href="javascript:alert(1)">Unsafe link</a></p>',
    });
    document.head.append(jsonLd);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_description).toBe(
      '## Responsibilities\n\nBuild *safe* tools.\n\n- Review code\n  - Check dependencies\n- [Ship fixes](https://example.com/jobs/42)\n\nUnsafe link',
    );
    expect(draft.job_description).not.toContain('alert');
    expect(draft.job_description).not.toContain('evil.example');
  });

  it('does not apply LinkedIn upsell filtering to generic descriptions', async () => {
    const jsonLd = document.createElement('script');
    jsonLd.type = 'application/ld+json';
    jsonLd.textContent = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Growth Engineer',
      description:
        '<div><p>Compare professional plans.</p><p><a href="https://www.linkedin.com/premium/products/?upsellSlotId=JDP_AIQ_COMPANY_INSIGHTS_STATIC">View LinkedIn Premium</a></p></div>',
    });
    document.head.append(jsonLd);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_description).toContain('Compare professional plans.');
    expect(draft.job_description).toContain('View LinkedIn Premium');
  });

  it('preserves text inside benign wrappers and unsupported table structure', async () => {
    const jsonLd = document.createElement('script');
    jsonLd.type = 'application/ld+json';
    jsonLd.textContent = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Platform Engineer',
      description:
        '<p>Use <span>TypeScript</span> for <mark>important</mark> work.</p><table><tr><td>Salary</td><td>$100k</td></tr></table>',
    });
    document.head.append(jsonLd);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_description).toContain(
      'Use TypeScript for important work.',
    );
    expect(draft.job_description).toContain('Salary');
    expect(draft.job_description).toContain('$100k');
  });

  it('escapes raw HTML-like text from metadata before storing Markdown', async () => {
    setHead(
      '<meta name="description" content="Use &lt;script&gt;alert(1)&lt;/script&gt; and [review] notes." />',
    );

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_description).toBe(
      'Use \\<script\\>alert(1)\\</script\\> and \\[review\\] notes.',
    );
    expect(draft.job_description).not.toContain('<script>');
  });

  it('preserves image alt text as plain text without leaking the src', async () => {
    const jsonLd = document.createElement('script');
    jsonLd.type = 'application/ld+json';
    jsonLd.textContent = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Support Engineer',
      description:
        '<p><img src="https://evil.example/track.png" alt="Team org chart" onerror="alert(1)"></p>',
    });
    document.head.append(jsonLd);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_description).toBe('Team org chart');
    expect(draft.job_description).not.toContain('evil.example');
    expect(draft.job_description).not.toContain('alert');
  });

  it('preserves a <br> as a Markdown hard line break', async () => {
    const jsonLd = document.createElement('script');
    jsonLd.type = 'application/ld+json';
    jsonLd.textContent = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Support Engineer',
      description: '<p>Line one<br>Line two</p>',
    });
    document.head.append(jsonLd);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_description).toBe('Line one  \nLine two');
  });

  it('escapes page text that mimics Markdown block syntax', async () => {
    const jsonLd = document.createElement('script');
    jsonLd.type = 'application/ld+json';
    jsonLd.textContent = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Support Engineer',
      description:
        '<p># Not a heading</p><p>- Not a bullet</p><p>1. Not a list item</p>',
    });
    document.head.append(jsonLd);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_description).toBe(
      '\\# Not a heading\n\n\\- Not a bullet\n\n1\\. Not a list item',
    );
  });

  it('marks TELECOMMUTE jobLocationType as remote', async () => {
    setHead(`
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Remote Engineer",
          "jobLocationType": "TELECOMMUTE"
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);
    expect(draft.is_remote).toBe(true);
  });

  it('finds a JobPosting nested inside @graph', async () => {
    setHead(`
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebPage", "name": "Careers" },
            { "@type": "JobPosting", "title": "Graph Engineer" }
          ]
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);
    expect(draft.job_title).toBe('Graph Engineer');
  });

  it('rejects multiple unmatched JobPosting blocks as ambiguous', async () => {
    setHead(`
      <script type="application/ld+json">
        { "@type": "JobPosting", "title": "Thin Posting" }
      </script>
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Rich Posting",
          "hiringOrganization": { "@type": "Organization", "name": "Rich Co" },
          "description": "Full description here.",
          "datePosted": "2026-07-01"
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_title).toBeUndefined();
    expect(draft.company_name).toBeUndefined();
  });

  it('matches the active JSON-LD posting while ignoring tracking query parameters', async () => {
    setLocation(
      'https://example.com/jobs/platform-engineer?utm_source=search&ref=serp',
    );
    setHead(`
      <script type="application/ld+json">
        { "@type": "JobPosting", "title": "Platform Engineer", "url": "https://example.com/jobs/platform-engineer?utm_campaign=widget" }
      </script>
      <script type="application/ld+json">
        { "@type": "JobPosting", "title": "Recommended Job", "description": "Richer but unrelated", "url": "https://example.com/jobs/recommended" }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);
    expect(draft.job_title).toBe('Platform Engineer');
  });

  it('matches provider stable job IDs across different Indeed URL shapes', async () => {
    setLocation('https://www.indeed.com/jobs?q=engineer&vjk=stable-123');
    setHead(`
      <script type="application/ld+json">
        { "@type": "JobPosting", "title": "Selected Job", "url": "https://www.indeed.com/viewjob?jk=stable-123&utm_source=serp" }
      </script>
      <script type="application/ld+json">
        { "@type": "JobPosting", "title": "Recommendation", "description": "Richer", "url": "https://www.indeed.com/viewjob?jk=other-999" }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);
    expect(draft.job_title).toBe('Selected Job');
  });

  it('prefers the JobPosting whose own url matches the current page over a richer but unrelated block', async () => {
    setLocation('https://example.com/jobs/thin-posting');
    setHead(`
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Thin Posting",
          "url": "https://example.com/jobs/thin-posting"
        }
      </script>
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Unrelated Recommended Job",
          "hiringOrganization": { "@type": "Organization", "name": "Other Co" },
          "description": "A completely different job from a related-jobs widget.",
          "datePosted": "2026-07-01",
          "url": "https://example.com/jobs/unrelated"
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_title).toBe('Thin Posting');
  });

  it('matches the active JSON-LD posting across trailing-slash and fragment differences', async () => {
    setLocation('https://example.com/jobs/thin-posting/');
    setHead(`
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Thin Posting",
          "url": "https://example.com/jobs/thin-posting#apply"
        }
      </script>
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Unrelated Recommended Job",
          "hiringOrganization": { "@type": "Organization", "name": "Other Co" },
          "description": "A richer related job must not win.",
          "datePosted": "2026-07-01",
          "url": "https://example.com/jobs/unrelated"
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_title).toBe('Thin Posting');
  });

  it('resolves a relative JSON-LD url against the page location', async () => {
    setLocation('https://example.com/jobs/data-engineer');
    setHead(`
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Engineer",
          "url": "/jobs/data-engineer"
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);
    expect(draft.job_link).toBe('https://example.com/jobs/data-engineer');
  });
});

describe('extractJobDraft — salary handling', () => {
  it('converts an annual salary range to integer cents', async () => {
    setHead(`
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Engineer",
          "baseSalary": {
            "@type": "MonetaryAmount",
            "currency": "USD",
            "value": {
              "@type": "QuantitativeValue",
              "minValue": 100000,
              "maxValue": 150000,
              "unitText": "YEAR"
            }
          }
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);
    expect(draft.salary_type).toBe('annual');
    expect(draft.salary_min).toBe(10_000_000);
    expect(draft.salary_max).toBe(15_000_000);
  });

  it('passes hourly rates through without conversion', async () => {
    setHead(`
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Contractor",
          "baseSalary": {
            "@type": "MonetaryAmount",
            "currency": "USD",
            "value": {
              "@type": "QuantitativeValue",
              "minValue": 45.5,
              "maxValue": 60,
              "unitText": "HOUR"
            }
          }
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);
    expect(draft.salary_type).toBe('hourly');
    expect(draft.hourly_rate_min).toBe(45.5);
    expect(draft.hourly_rate_max).toBe(60);
  });
});

describe('extractJobDraft — employmentType mapping', () => {
  it.each([
    ['FULL_TIME', 'full_time'],
    ['PART_TIME', 'part_time'],
    ['CONTRACTOR', 'contract'],
    ['INTERN', 'internship'],
    ['TEMPORARY', 'temp'],
  ])('maps schema.org %s to %s', async (schemaValue, expected) => {
    setHead(`
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Engineer",
          "employmentType": "${schemaValue}"
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);
    expect(draft.job_type).toBe(expected);
  });

  it('omits unknown employmentType values', async () => {
    setHead(`
      <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Engineer",
          "employmentType": "PER_DIEM"
        }
      </script>
    `);

    const { draft } = await extractJobDraft(OTHER);
    expect(draft.job_type).toBeUndefined();
  });
});

describe('extractJobDraft — OpenGraph fallback', () => {
  it('extracts from meta tags when no JSON-LD is present', async () => {
    setHead(`
      <meta property="og:title" content="Platform Engineer" />
      <meta name="description" content="Own our deployment platform." />
      <meta property="og:url" content="https://example.com/jobs/platform-engineer" />
    `);

    const { draft, candidates } = await extractJobDraft(OTHER);

    expect(draft.job_title).toBe('Platform Engineer');
    expect(draft.job_description).toBe('Own our deployment platform.');
    expect(draft.extraction_confidence?.job_title).toBe('medium');
    expect(candidates.job_title).toBeUndefined();
  });

  it('prefers the live SPA URL when canonical metadata points to the previous job', async () => {
    setLocation('https://example.com/jobs/current-posting');
    setHead(`
      <link rel="canonical" href="https://example.com/jobs/previous-posting" />
    `);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_link).toBe('https://example.com/jobs/current-posting');
  });

  it('does not use og:site_name as company_name on a known job board', async () => {
    setHead(`
      <meta property="og:title" content="Software Engineer" />
      <meta property="og:site_name" content="Indeed" />
    `);

    // Use a job-board platform with no dom-extraction block (dice) so this
    // test isn't incidentally taxed by another platform's dynamic-wait
    // timeout -- the guard itself is platform-agnostic across the whole
    // JOB_BOARD_PLATFORMS set, which is exercised more broadly below.
    const { draft } = await extractJobDraft({
      platform: 'dice',
      confidence: 'high',
    });

    expect(draft.company_name).not.toBe('Indeed');
  });

  it.each([
    'linkedin',
    'indeed',
    'glassdoor',
    'dice',
    'angellist',
    'google',
  ] as const)(
    'does not use og:site_name as company_name for platform %s',
    async (platform) => {
      setHead('<meta property="og:site_name" content="Should Not Be Used" />');

      // Some platforms (indeed/glassdoor/google) run a dom-extraction block
      // that waits on a MutationObserver+timeout before giving up -- fake
      // the timers so this parametrized case doesn't pay real wall-clock
      // cost for platforms that have nothing to find. A no-op for
      // platforms with no wait block.
      vi.useFakeTimers();
      const pending = extractJobDraft({ platform, confidence: 'high' });
      await vi.advanceTimersByTimeAsync(1800);
      const { draft } = await pending;

      expect(draft.company_name).not.toBe('Should Not Be Used');
    },
  );

  it.each(['lever', 'greenhouse', 'workday'] as const)(
    "uses og:site_name as company_name for platform %s (white-labeled ATS embeds carry the employer's own brand there)",
    async (platform) => {
      setHead('<meta property="og:site_name" content="Acme Corp" />');

      const { draft } = await extractJobDraft({ platform, confidence: 'high' });

      expect(draft.company_name).toBe('Acme Corp');
    },
  );

  it('uses og:site_name as company_name on an unrecognized site', async () => {
    setHead(`
      <meta property="og:title" content="Software Engineer" />
      <meta property="og:site_name" content="Acme Careers" />
    `);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.company_name).toBe('Acme Careers');
  });
});

describe('extractJobDraft — visible-text fallback', () => {
  it('falls back to h1 and page body text when nothing else is present', async () => {
    setBody(`
      <main>
        <h1>Fallback Title</h1>
        <p>This role has no structured data at all, just plain text.</p>
      </main>
    `);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_title).toBe('Fallback Title');
    expect(draft.job_description).toContain(
      'This role has no structured data at all, just plain text.',
    );
    expect(draft.extraction_confidence?.job_title).toBe('low');
  });

  it('escapes HTML-like plain text in the visible-text fallback', async () => {
    setBody('<main>&lt;img src=x onerror=alert(1)&gt;</main>');

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_description).toBe('\\<img src=x onerror=alert(1)\\>');
    expect(draft.job_description).not.toMatch(/(^|\n)\s*<img/);
  });

  it('does not derive taxonomy from unbounded page-wide visible text', async () => {
    setBody(`
      <h1>Software Engineer</h1>
      <main>
        Navigation for Docker training and CISSP articles.
        This page mentions Python outside a bounded job description.
      </main>
    `);

    const { draft } = await extractJobDraft(OTHER);

    expect(draft.job_description).toContain('Docker training');
    expect(draft.skills).toBeUndefined();
    expect(draft.software).toBeUndefined();
    expect(draft.certifications).toBeUndefined();
    expect(draft.keywords).toBeUndefined();
  });
});

describe('extractJobDraft — candidate review mode', () => {
  it('produces two title candidates when JSON-LD and meta tags disagree', async () => {
    setHead(`
      <script type="application/ld+json">
        { "@type": "JobPosting", "title": "JSON-LD Title" }
      </script>
      <meta property="og:title" content="Meta Title" />
    `);

    const { draft, candidates } = await extractJobDraft(OTHER);

    expect(draft.job_title).toBe('JSON-LD Title');
    expect(candidates.job_title).toHaveLength(2);
    expect(candidates.job_title?.map((c) => c.source).sort()).toEqual([
      'jsonld',
      'meta',
    ]);
    expect(candidates.job_title).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'JSON-LD Title',
          source: 'jsonld',
          confidence: 'high',
        }),
        expect.objectContaining({
          value: 'Meta Title',
          source: 'meta',
          confidence: 'medium',
        }),
      ]),
    );
  });
});

describe('extractJobDraft — source_platform', () => {
  it('sets source_platform and its confidence directly from the detection argument', async () => {
    const { draft } = await extractJobDraft({
      platform: 'dice',
      confidence: 'low',
    });

    expect(draft.source_platform).toBe('dice');
    expect(draft.extraction_confidence?.source_platform).toBe('low');
  });
});

describe('extractJobDraft — merge priority', () => {
  it('prefers a dom-sourced value over an equal-confidence jsonld value (stale JSON-LD from a prior SPA view should not win)', async () => {
    setHead(`
      <script type="application/ld+json">
        { "@type": "JobPosting", "title": "Stale JSON-LD Title" }
      </script>
    `);
    setBody(`
      <h1 class="jobsearch-JobInfoHeader-title">Fresh DOM Title</h1>
      <div id="jobDescriptionText">Fresh description.</div>
    `);

    const { draft, candidates } = await extractJobDraft({
      platform: 'indeed',
      confidence: 'high',
    });

    expect(draft.job_title).toBe('Fresh DOM Title');
    // The h1 is also picked up by the generic visible-text fallback (same
    // value as the dom candidate), alongside the stale jsonld value.
    expect(candidates.job_title?.map((c) => c.source).sort()).toEqual([
      'dom',
      'jsonld',
      'visible-text',
    ]);
  });
});

describe('extractJobDraft — LinkedIn DOM extraction', () => {
  const LINKEDIN = {
    platform: 'linkedin' as const,
    confidence: 'high' as const,
  };

  // None of these set the company profile-link anchor, location column, or
  // "About the job" section, so the secondary waitForEach call always runs
  // out its full timeout -- use fake timers to avoid paying that 800ms in
  // real wall-clock time per test.

  it('extracts job_title and company_name from the pipe-delimited page title', async () => {
    document.title = 'Senior Software Engineer | Acme Corp | LinkedIn';

    vi.useFakeTimers();
    const pending = extractJobDraft(LINKEDIN);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    expect(draft.job_title).toBe('Senior Software Engineer');
    expect(draft.company_name).toBe('Acme Corp');
  });

  it('strips a leading unread-notification badge from the page title', async () => {
    document.title = '(3) Senior Software Engineer | Acme Corp | LinkedIn';

    vi.useFakeTimers();
    const pending = extractJobDraft(LINKEDIN);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    expect(draft.job_title).toBe('Senior Software Engineer');
    expect(draft.company_name).toBe('Acme Corp');
  });

  it('adds no page-title candidate when the title has fewer than 3 pipe-delimited segments', async () => {
    document.title = 'Software Engineer jobs in United States | LinkedIn';
    setBody('<h1>Software Engineer jobs in United States</h1>');

    vi.useFakeTimers();
    const pending = extractJobDraft(LINKEDIN);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    expect(draft.company_name).toBeUndefined();
  });

  it('adds no page-title candidate when the last segment is not "LinkedIn"', async () => {
    document.title = 'Senior Software Engineer | Acme Corp | Careers';

    vi.useFakeTimers();
    const pending = extractJobDraft(LINKEDIN);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    expect(draft.company_name).toBeUndefined();
    expect(draft.job_title).toBeUndefined();
  });

  it('extracts company_name from the employer profile link', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/life">Acme Corp</a>
        <p><span>Austin, TX</span></p>
        <div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.company_name).toBe('Acme Corp');
    expect(draft.job_location).toBe('Austin, TX');
  });

  it('extracts LinkedIn company_name from the selected last lazy column', async () => {
    document.title = 'Software Engineer jobs in United States | LinkedIn';
    setBody(`
      <h1>Software Engineer jobs in United States</h1>
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/wrong-company/">Wrong Company</a>
        <p><span>San Francisco Bay Area</span></p>
      </div>
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/life">Acme Corp</a>
        <p><span>Austin, TX</span></p>
        <div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.company_name).toBe('Acme Corp');
  });

  it('resolves the company link after it appears asynchronously', async () => {
    setBody('<h1>Senior Software Engineer</h1>');

    const pending = extractJobDraft(LINKEDIN);
    setTimeout(() => {
      // Also populate the location column and description section in the
      // same tick -- otherwise those still-pending groups would hold this
      // waitForEach call open for its full real 800ms timeout before
      // resolving.
      setBody(
        document.body.innerHTML +
          '<div data-testid="lazy-column"><a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a><p><span>Austin, TX</span></p><div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div></div>',
      );
    }, 0);

    const { draft } = await pending;
    expect(draft.company_name).toBe('Acme Corp');
    expect(draft.job_location).toBe('Austin, TX');
  });

  it('falls back to no dom company_name candidate when the link never appears', async () => {
    setBody('<h1>Senior Software Engineer</h1>');

    vi.useFakeTimers();
    const pending = extractJobDraft(LINKEDIN);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    expect(draft.company_name).toBeUndefined();
  });

  it('extracts job_location from the lazy-loaded detail column', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column">
        <p><span>Austin, TX</span></p>
        <div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_location).toBe('Austin, TX');
  });

  it('extracts LinkedIn job_location from the location paragraph instead of preceding metadata', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column">
        <p><span>Posted 2 weeks ago</span></p>
        <p><span>Austin, TX</span></p>
        <div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_location).toBe('Austin, TX');
  });

  it('extracts LinkedIn job_location from the last lazy column', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column">
        <p><span>San Francisco Bay Area</span></p>
      </div>
      <div data-testid="lazy-column">
        <p><span>Posted 2 weeks ago</span></p>
        <p><span>Austin, TX</span></p>
        <div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_location).toBe('Austin, TX');
  });

  it('prefers the specific LinkedIn location when the paragraph above also looks location-like', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column">
        <p><span>San Francisco Bay Area</span></p>
        <p><span>Austin, TX</span></p>
        <div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_location).toBe('Austin, TX');
  });

  it('extracts LinkedIn job_location for non-comma region formats', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column">
        <p><span>Over 100 applicants</span></p>
        <p><span>New York City Metropolitan Area</span></p>
        <div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_location).toBe('New York City Metropolitan Area');
  });

  it('extracts LinkedIn job_location from the first span in the metadata row instead of the remote chip', async () => {
    setBody(`
      <h1>Software Developer</h1>
      <a href="https://www.linkedin.com/company/intelex-technologies-ulc/life/">Intelex Technologies ULC</a>
      <div data-testid="lazy-column">
        <p>
          <a href="https://www.linkedin.com/jobs/view/4402229024/">Software Developer</a>
        </p>
        <p>
          <span>United States</span>
          <span> </span>·<span> </span>
          <span><strong>Reposted 13 hours ago</strong></span>
          <span> </span>·<span> </span>
          <span>Over 100 people clicked apply</span>
        </p>
        <a href="/jobs/search-results/?keywords=remote"><span>Remote</span></a>
        <a href="/jobs/search-results/?keywords=full-time"><span>Full-time</span></a>
        <div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_location).toBe('United States');
  });

  it('resolves job_location after the detail column appears asynchronously', async () => {
    setBody('<h1>Senior Software Engineer</h1>');

    const pending = extractJobDraft(LINKEDIN);
    setTimeout(() => {
      // Also populate the company anchor and description section in the
      // same tick -- otherwise those still-pending groups would hold this
      // waitForEach call open for its full real 800ms timeout before
      // resolving.
      setBody(
        document.body.innerHTML +
          '<a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>' +
          '<div data-testid="lazy-column"><p><span>Remote</span></p><div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div></div>',
      );
    }, 0);

    const { draft } = await pending;
    expect(draft.job_location).toBe('Remote');
  });

  it('falls back to no dom job_location candidate when the detail column never appears', async () => {
    setBody('<h1>Senior Software Engineer</h1>');

    vi.useFakeTimers();
    const pending = extractJobDraft(LINKEDIN);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    expect(draft.job_location).toBeUndefined();
  });

  it('prefers the LinkedIn expandable text box for job_description', async () => {
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Austin, TX</span></p>
        <h2>About the job</h2>
        <p>Stale heading-range description.</p>
        <div data-testid="expandable-text-box">
          <p>Build <strong>reliable</strong> products.</p>
          <ul><li>Review code</li><li>Mentor engineers</li></ul>
          <button>Show more</button>
          <script>alert('unsafe')</script>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toBe(
      'Build **reliable** products.\n\n- Review code\n- Mentor engineers',
    );
    expect(draft.job_description).not.toContain('Stale heading-range');
    expect(draft.job_description).not.toContain('Show more');
    expect(draft.job_description).not.toContain('unsafe');
  });

  it('renders only the first LinkedIn expandable text box as job_description', async () => {
    setBody(`
      <div data-testid="lazy-column">
        <div data-testid="expandable-text-box">
          <p>Build <strong>reliable</strong> product systems.</p>
          <ul><li>Review code</li><li>Mentor engineers</li></ul>
        </div>
      </div>
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span></p>
        <div data-testid="expandable-text-box">
          <p>1-month free trial. Easy to cancel. We&rsquo;ll remind you 7 days before your trial ends.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toBe(
      'Build **reliable** product systems.\n\n- Review code\n- Mentor engineers',
    );
    expect(draft.job_description).not.toContain('1-month free trial');
    expect(draft.job_description).not.toContain('trial ends');
  });

  it('excludes every LinkedIn expandable text box from metadata scanning', async () => {
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="expandable-text-box">
        <p>Build reliable product systems.</p>
      </div>
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <div data-testid="expandable-text-box">
          <span>Remote</span><span>Full-time</span><span>Executive</span>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_type).toBeUndefined();
    expect(draft.is_remote).toBeUndefined();
    expect(draft.experience_level).toBeUndefined();
  });

  it('does not treat expandable description prose as LinkedIn metadata', async () => {
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span></p>
        <button><span>On-site</span></button>
        <button><span>Part-time</span></button>
        <div data-testid="expandable-text-box">
          <p>This remote full-time opportunity supports a distributed product.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.is_remote).toBe(false);
    expect(draft.job_type).toBe('part_time');
  });

  it('extracts job_description from the "About the job" section, excluding the heading text', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column">
        <p><span>Austin, TX</span></p>
        <div class="jobs-description">
          <h2>About the job</h2>
          <p>Build great products for millions of members.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toBe(
      'Build great products for millions of members.',
    );
    expect(draft.job_description).not.toContain('About the job');
  });

  it('stops LinkedIn job_description before the next peer section heading', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column">
        <p><span>Austin, TX</span></p>
        <div class="jobs-details">
        <h2>About the job</h2>
        <p>Build reliable product systems.</p>
        <h3>Responsibilities</h3>
        <p>Own backend services.</p>
        <h2>About the company</h2>
        <p>Acme was founded in 2005.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toBe(
      'Build reliable product systems.\n\n### Responsibilities\n\nOwn backend services.',
    );
    expect(draft.job_description).not.toContain('About the company');
    expect(draft.job_description).not.toContain('Acme was founded');
  });

  it('extracts LinkedIn job_description when the heading is wrapped separately from the body', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column">
        <p><span>Austin, TX</span></p>
        <div class="jobs-details">
          <div class="heading-wrapper"><h2>About the job</h2></div>
          <div><p>Build reliable product systems.</p></div>
          <h2>About the company</h2>
          <p>Acme was founded in 2005.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toBe('Build reliable product systems.');
  });

  it('keeps sibling description content outside a nonempty heading wrapper', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <div data-testid="lazy-column">
        <p><span>Austin, TX</span></p>
        <section class="jobs-details">
          <div class="heading-wrapper">
            <h2>About the job</h2>
            <p>Build reliable product systems.</p>
          </div>
          <ul><li>Review code</li><li>Mentor engineers</li></ul>
          <h2>About the company</h2>
          <p>Company profile text.</p>
        </section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toBe(
      'Build reliable product systems.\n\n- Review code\n- Mentor engineers',
    );
    expect(draft.job_description).not.toContain('About the company');
    expect(draft.job_description).not.toContain('Company profile text');
  });

  it('excludes the LinkedIn "Premium" company-insights upsell card from job_description', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column">
        <p><span>Austin, TX</span></p>
        <div class="jobs-details">
          <h2>About the job</h2>
          <div class="description-wrapper">
            <p>Build reliable product systems.</p>
            <div class="premium-upsell-card">
              <p>Job search faster with Premium</p>
              <p>Access company insights like strategic priorities, headcount trends, and more</p>
              <ul><li></li><li></li><li></li></ul>
              <p>Marc and millions of other members use Premium</p>
              <a href="https://www.linkedin.com/premium/products/?upsellOrderOrigin=Tracking%3Av1%3Ajdp_aiq_company_insights_static&utype=job&upsellSlotId=JDP_AIQ_COMPANY_INSIGHTS_STATIC">Retry Premium for $0</a>
              <p>1-month free trial. Easy to cancel. We&rsquo;ll remind you 7 days before your trial ends.</p>
            </div>
          </div>
          <h2>About the company</h2>
          <p>Acme was founded in 2005.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toBe('Build reliable product systems.');
    expect(draft.job_description).not.toContain('Premium');
    expect(draft.job_description).not.toContain('Retry');
    expect(draft.job_description).not.toContain('About the company');
  });

  it('does not remove a general description wrapper containing a tracked Premium link', async () => {
    setBody(`
      <div data-testid="lazy-column">
        <div class="jobs-details">
          <h2>About the job</h2>
          <div class="description-wrapper">
            <p>Build reliable product systems.</p>
            <p><a href="https://www.linkedin.com/premium/products/?upsellSlotId=JDP_AIQ_COMPANY_INSIGHTS_STATIC">Optional member benefit</a></p>
            <ul><li>Design APIs</li><li>Review code</li><li>Mentor engineers</li></ul>
            <p>Keep legitimate job requirements.</p>
          </div>
          <h2>About the company</h2>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toContain('Build reliable product systems.');
    expect(draft.job_description).toContain('Optional member benefit');
    expect(draft.job_description).toContain(
      'Keep legitimate job requirements.',
    );
  });

  it('preserves LinkedIn description structure as Markdown', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <div data-testid="lazy-column">
        <p><span>Austin, TX</span></p>
        <div class="jobs-details">
          <h2>About the job</h2>
          <p>Build <strong>reliable</strong> systems.</p>
          <ul><li>Review code</li><li><a href="https://example.com/team">Mentor engineers</a></li></ul>
          <h2>About the company</h2>
          <p>Company profile text.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toBe(
      'Build **reliable** systems.\n\n- Review code\n- [Mentor engineers](https://example.com/team)',
    );
    expect(draft.job_description).not.toContain('About the company');
    expect(draft.job_description).not.toContain('Company profile text');
  });

  it('extracts LinkedIn job_description from a search split-view details pane only', async () => {
    document.title = 'Software Engineer jobs in United States | LinkedIn';
    setBody(`
      <main>
        <ul class="jobs-search-results-list">
          <li>
            <h3>Software Engineer</h3>
            <p>Search result card teaser that should not be scraped.</p>
          </li>
        </ul>
        <section class="jobs-search__job-details">
          <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
          <div data-testid="lazy-column">
            <p><span>San Francisco Bay Area</span></p>
            <article class="jobs-description">
              <h2>About the job</h2>
              <p>Earlier lazy-column description that should not be scraped.</p>
            </article>
          </div>
          <div data-testid="lazy-column">
            <p><span>Austin, TX</span></p>
            <article class="jobs-description">
              <div><h2>About the job</h2></div>
              <div>
                <p>Build reliable product systems.</p>
                <h3>What you will do</h3>
                <p>Improve the selected job workflow.</p>
              </div>
              <h2>About the company</h2>
              <p>Company profile text should not be scraped.</p>
            </article>
          </div>
        </section>
        <aside>
          <h2>Similar jobs</h2>
          <p>Another posting description that should not be scraped.</p>
        </aside>
      </main>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_description).toBe(
      'Build reliable product systems.\n\n### What you will do\n\nImprove the selected job workflow.',
    );
    expect(draft.job_location).toBe('Austin, TX');
    expect(draft.job_description).not.toContain('Search result card teaser');
    expect(draft.job_description).not.toContain('Earlier lazy-column');
    expect(draft.job_description).not.toContain('Company profile text');
    expect(draft.job_description).not.toContain('Another posting description');
  });

  it('resolves job_description after the section appears asynchronously', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column"><p><span>Austin, TX</span></p></div>
    `);

    const pending = extractJobDraft(LINKEDIN);
    setTimeout(() => {
      setBody(
        document.body.innerHTML.replace(
          '</div>',
          '<div class="jobs-description"><h2>About the job</h2><p>Build great things.</p></div></div>',
        ),
      );
    }, 0);

    const { draft } = await pending;
    expect(draft.job_description).toBe('Build great things.');
  });

  it('falls back to no dom job_description candidate when no "About the job" heading appears', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column"><p><span>Austin, TX</span></p></div>
    `);

    vi.useFakeTimers();
    const pending = extractJobDraft(LINKEDIN);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    // The generic low-confidence visible-text fallback still fills
    // job_description from the whole body -- what matters here is that no
    // high-confidence 'dom' candidate was fabricated to win over it.
    expect(draft.extraction_confidence?.job_description).not.toBe('high');
  });

  it('ignores an unrelated heading like "About the company"', async () => {
    setBody(`
      <h1>Senior Software Engineer</h1>
      <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
      <div data-testid="lazy-column"><p><span>Austin, TX</span></p></div>
      <div class="jobs-about-company"><h2>About the company</h2><p>Founded in 2005.</p></div>
    `);

    vi.useFakeTimers();
    const pending = extractJobDraft(LINKEDIN);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    // The generic low-confidence visible-text fallback picks up the whole
    // page body (including this unrelated section), which is expected --
    // what this test guards is that the DOM extractor itself didn't treat
    // "About the company" as a match for "About the job".
    expect(draft.extraction_confidence?.job_description).not.toBe('high');
  });

  it('autofills LinkedIn advanced fields from the selected detail pane', async () => {
    document.title = 'Platform Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted 1 day ago</span></p>
        <button><span>Remote</span></button>
        <button><span>Full-time</span></button>
        <li><span>Mid-Senior level</span></li>
        <span>$120,000/yr - $150,000/yr</span>
        <section><h2>About the job</h2><p>Active Secret clearance required.</p></section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft).toMatchObject({
      job_type: 'full_time',
      is_remote: true,
      experience_level: 'senior',
      security_clearance_req: true,
      salary_text: '$120,000 - $150,000',
      salary_type: 'annual',
      salary_min: 12_000_000,
      salary_max: 15_000_000,
    });
  });

  it('autofills LinkedIn advanced fields from explicit expandable description signals', async () => {
    document.title = 'Software Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <div data-testid="expandable-text-box">
          <p>This is a full-time role. This position is remote.</p>
          <p>Candidates need at least 5 years of experience.</p>
          <p>The salary range is $120,000 - $150,000 per year.</p>
          <p>Active Secret clearance required.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft).toMatchObject({
      job_type: 'full_time',
      is_remote: true,
      experience_level: 'senior',
      security_clearance_req: true,
      salary_text: '$120,000 - $150,000',
      salary_type: 'annual',
      salary_min: 12_000_000,
      salary_max: 15_000_000,
    });
    expect(draft.extraction_confidence).toMatchObject({
      job_type: 'medium',
      is_remote: 'medium',
      experience_level: 'low',
      security_clearance_req: 'medium',
      salary_text: 'medium',
      salary_type: 'medium',
      salary_min: 'medium',
      salary_max: 'medium',
    });
  });

  it('normalizes a labeled decimal annual pay range', async () => {
    document.title = 'Software Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <span>Base pay range $120,000.00/yr - $170,000.00/yr</span>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft).toMatchObject({
      salary_text: '$120,000 - $170,000',
      salary_type: 'annual',
      salary_min: 12_000_000,
      salary_max: 17_000_000,
    });
  });

  it('normalizes an annual up-to shorthand as a zero-to-maximum range', async () => {
    document.title = 'Software Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <span>up to $135k</span>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft).toMatchObject({
      salary_text: '$0 - $135,000',
      salary_type: 'annual',
      salary_min: 0,
      salary_max: 13_500_000,
    });
  });

  it('normalizes an up-to salary found in the expandable description', async () => {
    document.title = 'Software Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <div data-testid="expandable-text-box">
          <p>The base salary is up to $135k.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft).toMatchObject({
      salary_text: '$0 - $135,000',
      salary_type: 'annual',
      salary_min: 0,
      salary_max: 13_500_000,
    });
    expect(draft.extraction_confidence?.salary_text).toBe('medium');
  });

  it('separates description skills, software, certifications, and keywords for the backend recovery pass', async () => {
    document.title = 'Software Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <div data-testid="expandable-text-box">
          <p>Hybrid backend role: build TypeScript and React services deployed with k8s and PostgreSQL.</p>
          <p>Our team uses GitHub, Jira, and VS Code.</p>
          <p>AWS Certified Solutions Architect or CKA credentials are preferred.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.skills).toEqual(['TypeScript']);
    expect(draft.software).toEqual([
      'Jira',
      'VS Code',
      'GitHub',
      'React',
      'PostgreSQL',
      'Kubernetes',
    ]);
    expect(draft.certifications).toEqual([
      'AWS Certified Solutions Architect',
      'Certified Kubernetes Administrator (CKA)',
    ]);
    expect(draft.keywords).toEqual(['hybrid', 'backend']);
    expect(draft.extraction_confidence).toMatchObject({
      skills: 'low',
      software: 'low',
      certifications: 'low',
      keywords: 'low',
    });
  });

  it('prefers selected LinkedIn metadata over conflicting description signals', async () => {
    document.title = 'Software Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <span>On-site</span><span>Part-time</span><span>Entry level</span>
        <span>USD 60/hr - USD 80/hr</span>
        <div data-testid="expandable-text-box">
          <p>This is a full-time role. This position is remote.</p>
          <p>Candidates need at least 8 years of experience.</p>
          <p>The salary range is $150,000 - $200,000 per year.</p>
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft).toMatchObject({
      job_type: 'part_time',
      is_remote: false,
      experience_level: 'entry',
      salary_type: 'hourly',
      hourly_rate_min: 60,
      hourly_rate_max: 80,
    });
    expect(draft.extraction_confidence).toMatchObject({
      job_type: 'high',
      is_remote: 'high',
      experience_level: 'high',
      salary_type: 'high',
    });
  });

  it('ignores incidental job-type and remote words in the expandable description', async () => {
    document.title = 'Software Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <div data-testid="expandable-text-box">
          You will support remote offices and collaborate with full-time employees.
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_type).toBeUndefined();
    expect(draft.is_remote).toBeUndefined();
  });

  it('honors explicit negation in description employment signals', async () => {
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <div data-testid="expandable-text-box">
          A full-time role is not available. Remote work is not available for this position.
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_type).toBeUndefined();
    expect(draft.is_remote).toBe(false);
  });

  it('does not treat biographical years-of-experience prose as a requirement', async () => {
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <div data-testid="expandable-text-box">
          Our leadership team has 20 years of experience building reliable products.
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.experience_level).toBeUndefined();
  });

  it('does not treat a periodic benefit amount as salary', async () => {
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Denver, CO</span> · <span>Posted today</span></p>
        <div data-testid="expandable-text-box">
          Employees receive a $1,500 per year wellness stipend.
        </div>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.salary_text).toBeUndefined();
    expect(draft.salary_type).toBeUndefined();
    expect(draft.salary_min).toBeUndefined();
    expect(draft.salary_max).toBeUndefined();
  });

  it('maps hourly compensation and explicit on-site metadata', async () => {
    document.title = 'Staff Infrastructure Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Austin, TX</span> · <span>Posted today</span></p>
        <span>On-site</span>
        <span>Contract</span>
        <span>USD 60/hr - USD 80/hr</span>
        <section><h2>About the job</h2><p>No security clearance required.</p></section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft).toMatchObject({
      job_type: 'contract',
      is_remote: false,
      experience_level: 'lead',
      security_clearance_req: false,
      salary_type: 'hourly',
      hourly_rate_min: 60,
      hourly_rate_max: 80,
    });
  });

  it('scopes advanced-field signals to the selected last lazy column', async () => {
    document.title = 'Engineer | Correct Co | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <span>Remote</span><span>Full-time</span><span>Executive</span>
      </div>
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/correct-co/">Correct Co</a>
        <p><span>Austin, TX</span> · <span>Posted today</span></p>
        <span>Hybrid</span><span>Part-time</span><span>Entry level</span>
        <section><h2>About the job</h2><p>Build reliable tools.</p></section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft).toMatchObject({
      job_type: 'part_time',
      is_remote: false,
      experience_level: 'entry',
    });
  });

  it('does not infer a clearance requirement from equal-opportunity boilerplate', async () => {
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Austin, TX</span> · <span>Posted today</span></p>
        <section><h2>About the job</h2><p>We consider all qualified applicants, including protected veterans, without regard to status.</p></section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.security_clearance_req).toBeUndefined();
  });

  it.each([
    'Secret clearance is not required.',
    'No active Secret clearance is required.',
    'Secret clearance is preferred, but not required.',
    'This role does not require a Secret clearance.',
  ])('recognizes a negated named clearance in "%s"', async (description) => {
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Austin, TX</span> · <span>Posted today</span></p>
        <section><h2>About the job</h2><p>${description}</p></section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.security_clearance_req).toBe(false);
  });

  it.each([
    {
      currency: 'Canadian',
      salary: 'CA$120,000/yr - CA$150,000/yr',
    },
    {
      currency: 'Australian',
      salary: 'A$120,000/yr - A$150,000/yr',
    },
  ])('rejects a $currency dollar salary label', async ({ salary }) => {
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Toronto, ON</span> · <span>Posted today</span></p>
        <span>${salary}</span>
        <section><h2>About the job</h2><p>Build reliable tools.</p></section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.salary_text).toBeUndefined();
    expect(draft.salary_type).toBeUndefined();
    expect(draft.salary_min).toBeUndefined();
    expect(draft.salary_max).toBeUndefined();
  });

  it('rejects a lowercase non-USD currency prefix before the dollar sign', async () => {
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Mumbai, India</span> · <span>Posted today</span></p>
        <span>inr $120,000/yr - inr $150,000/yr</span>
        <section><h2>About the job</h2><p>Build reliable tools.</p></section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.salary_text).toBeUndefined();
    expect(draft.salary_type).toBeUndefined();
    expect(draft.salary_min).toBeUndefined();
    expect(draft.salary_max).toBeUndefined();
  });

  it.each([
    'CA$120,000 - CA$150,000 per year',
    'A$120,000 - A$150,000 per year',
  ])(
    'rejects a foreign dollar salary in the expandable description: %s',
    async (salary) => {
      document.title = 'Engineer | Acme Corp | LinkedIn';
      setBody(`
        <div data-testid="lazy-column">
          <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
          <p><span>Toronto, ON</span> · <span>Posted today</span></p>
          <div data-testid="expandable-text-box">
            The salary range is ${salary}.
          </div>
        </div>
      `);

      const { draft } = await extractJobDraft(LINKEDIN);

      expect(draft.salary_text).toBeUndefined();
      expect(draft.salary_type).toBeUndefined();
      expect(draft.salary_min).toBeUndefined();
      expect(draft.salary_max).toBeUndefined();
    },
  );

  it('does not treat description prose as high-confidence workplace metadata', async () => {
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Austin, TX</span> · <span>Posted today</span></p>
        <section>
          <h2>About the job</h2>
          <p>Remote</p>
          <p>You will support remote offices while working on-site.</p>
        </section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.is_remote).toBeUndefined();
  });

  it('prefers selected-pane job type over stale equal-confidence JSON-LD', async () => {
    setHead(`
      <script type="application/ld+json">
        { "@type": "JobPosting", "employmentType": "FULL_TIME" }
      </script>
    `);
    document.title = 'Engineer | Acme Corp | LinkedIn';
    setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Austin, TX</span> · <span>Posted today</span></p>
        <span>Contract</span>
        <section><h2>About the job</h2><p>Build reliable tools.</p></section>
      </div>
    `);

    const { draft } = await extractJobDraft(LINKEDIN);

    expect(draft.job_type).toBe('contract');
  });

  it.each([
    ['Internship', 'internship'],
    ['Temporary', 'temp'],
    ['Freelance', 'freelance'],
  ] as const)(
    'maps the LinkedIn %s chip to job_type %s',
    async (label, expected) => {
      document.title = 'Engineer | Acme Corp | LinkedIn';
      setBody(`
      <div data-testid="lazy-column">
        <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
        <p><span>Austin, TX</span> · <span>Posted today</span></p>
        <span>${label}</span>
        <section><h2>About the job</h2><p>Build reliable tools.</p></section>
      </div>
    `);

      const { draft } = await extractJobDraft(LINKEDIN);

      expect(draft.job_type).toBe(expected);
    },
  );

  it.each([
    ['Associate', 'mid'],
    ['Director', 'executive'],
  ] as const)(
    'maps the LinkedIn %s seniority label to experience_level %s',
    async (label, expected) => {
      document.title = 'Engineer | Acme Corp | LinkedIn';
      setBody(`
        <div data-testid="lazy-column">
          <a href="https://www.linkedin.com/company/acme-corp/">Acme Corp</a>
          <p><span>Austin, TX</span> · <span>Posted today</span></p>
          <span>${label}</span>
          <section><h2>About the job</h2><p>Build reliable tools.</p></section>
        </div>
      `);

      const { draft } = await extractJobDraft(LINKEDIN);

      expect(draft.experience_level).toBe(expected);
    },
  );
});

describe('extractJobDraft — Indeed DOM extraction', () => {
  const INDEED = { platform: 'indeed' as const, confidence: 'high' as const };

  it('extracts title, company, location, and description from Indeed selectors', async () => {
    setBody(`
      <h1 class="jobsearch-JobInfoHeader-title">Backend Engineer</h1>
      <div data-testid="inlineHeader-companyName">Acme Corp</div>
      <div data-testid="inlineHeader-companyLocation">Austin, TX</div>
      <div id="jobDescriptionText">Build backend services.</div>
    `);

    const { draft, candidates } = await extractJobDraft(INDEED);

    expect(draft.job_title).toBe('Backend Engineer');
    expect(draft.company_name).toBe('Acme Corp');
    expect(draft.job_location).toBe('Austin, TX');
    expect(draft.job_description).toBe('Build backend services.');
    expect(candidates.job_title).toBeUndefined();
  });

  it('prefers the dom-sourced title over a competing meta title', async () => {
    setHead('<meta property="og:title" content="Wrong Title" />');
    setBody(`
      <h1 class="jobsearch-JobInfoHeader-title">Correct Title</h1>
      <div id="jobDescriptionText">Description.</div>
    `);

    const { draft, candidates } = await extractJobDraft(INDEED);

    expect(draft.job_title).toBe('Correct Title');
    // The h1 is also picked up by the generic visible-text fallback (same
    // value as the dom candidate), alongside the competing meta value.
    expect(candidates.job_title?.map((c) => c.source).sort()).toEqual([
      'dom',
      'meta',
      'visible-text',
    ]);
  });

  it('preserves safe description structure as Markdown and drops page-controlled executable content', async () => {
    setBody(`
      <h1 class="jobsearch-JobInfoHeader-title">Backend Engineer</h1>
      <div id="jobDescriptionText">
        <h2>Requirements</h2>
        <ul><li><strong>TypeScript</strong></li><li>SQL</li></ul>
        <img src=x onerror="alert(1)" alt="tracking pixel">
        <script>alert(2)</script>
      </div>
    `);

    const { draft } = await extractJobDraft(INDEED);

    expect(draft.job_description).toBe(
      '## Requirements\n\n- **TypeScript**\n- SQL\n\ntracking pixel',
    );
    expect(draft.job_description).not.toContain('alert');
    expect(draft.job_description).not.toContain('onerror');
  });

  it('resolves the Indeed title after it appears asynchronously', async () => {
    setBody('<div id="jobDescriptionText">Description.</div>');

    const pending = extractJobDraft(INDEED);
    setTimeout(() => {
      setBody(
        document.body.innerHTML +
          '<h1 class="jobsearch-JobInfoHeader-title">Late Title</h1>',
      );
    }, 0);

    const { draft } = await pending;
    expect(draft.job_title).toBe('Late Title');
  });

  it('falls back to no dom title candidate when nothing appears before the timeout', async () => {
    setBody('<div id="jobDescriptionText">Description only.</div>');

    vi.useFakeTimers();
    const pending = extractJobDraft(INDEED);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    expect(draft.job_description).toBe('Description only.');
    expect(draft.job_title).toBeUndefined();
  });

  it('scrapes the job link and ID from the aria-pressed selected card', async () => {
    setLocation('https://www.indeed.com/jobs?q=engineer&vjk=stale-999');
    setBody(`
      <ul>
        <li>
          <h2><a data-jk="other-111" href="/rc/clk?jk=other-111">Other Job</a></h2>
        </li>
        <li>
          <h2><a data-jk="selected-123" aria-pressed="true" href="/rc/clk?jk=selected-123">Staff Engineer</a></h2>
          <span data-testid="company-name">Acme Corp</span>
          <div data-testid="text-location">Austin, TX</div>
          <div data-testid="attribute_snippet_testid">$150,000 - $180,000 a year</div>
          <div data-testid="attribute_snippet_testid">Full-time</div>
        </li>
      </ul>
      <h1 class="jobsearch-JobInfoHeader-title">Staff Engineer</h1>
      <div id="jobDescriptionText">Lead the platform team.</div>
    `);

    const { draft } = await extractJobDraft({
      ...INDEED,
      externalJobId: 'stale-999',
    });

    expect(draft.external_job_id).toBe('selected-123');
    expect(draft.job_link).toBe(
      'https://www.indeed.com/viewjob?jk=selected-123',
    );
    expect(draft.job_title).toBe('Staff Engineer');
    expect(draft.company_name).toBe('Acme Corp');
    expect(draft.job_location).toBe('Austin, TX');
    expect(draft.salary_text).toBe('$150,000 - $180,000 a year');
    expect(draft.job_type).toBe('full_time');
  });

  it('loads the split-view fixture and keeps primary-card fields synchronized with the right pane', async () => {
    loadFixture(
      indeedSplitViewFixture,
      'https://www.indeed.com/jobs?q=engineer&vjk=stale-999',
    );

    const { draft } = await extractJobDraft({
      ...INDEED,
      externalJobId: 'stale-999',
    });

    expect(draft).toMatchObject({
      external_job_id: 'selected-123',
      job_link: 'https://www.indeed.com/viewjob?jk=selected-123',
      job_title: 'Staff Engineer',
      company_name: 'Acme Corp',
      job_location: 'Hybrid work in Austin, TX',
      salary_text: '$150,000 - $180,000 a year',
      job_type: 'full_time',
      is_remote: false,
      job_description: 'Lead the platform team.',
    });
    expect(draft.external_job_id).not.toBe('shelf-999');
  });

  it('waits for the selected-card identity before atomically reading a replaced pane', async () => {
    loadFixture(
      indeedSplitViewFixture
        .replace('aria-pressed="true"', '')
        .replace(
          'data-jk="other-111"',
          'data-jk="other-111" aria-pressed="true"',
        ),
      'https://www.indeed.com/jobs?q=engineer&vjk=selected-123',
    );

    const pending = extractJobDraft(INDEED);
    setTimeout(() => {
      const pane = document.querySelector('.jobsearch-RightPane');
      if (!pane) throw new Error('expected Indeed pane');
      pane.innerHTML = `
        <h1 class="jobsearch-JobInfoHeader-title">Other Job - job post</h1>
        <div data-testid="inlineHeader-companyName">Elsewhere Inc</div>
        <div data-testid="inlineHeader-companyLocation">Dallas, TX</div>
        <div id="jobDescriptionText">The newly selected description.</div>
      `;
    }, 0);

    const { draft } = await pending;
    expect(draft).toMatchObject({
      external_job_id: 'other-111',
      job_title: 'Other Job',
      company_name: 'Elsewhere Inc',
      job_location: 'Dallas, TX',
      job_description: 'The newly selected description.',
    });
    expect(draft.job_description).not.toBe('Lead the platform team.');
  });

  it('keeps outermost semantics for a large nested primary-card list without pairwise containment scans', async () => {
    setLocation('https://www.indeed.com/jobs?q=engineer');
    const cards = Array.from(
      { length: 200 },
      (_, index) => `
      <div class="job_seen_beacon">
        <div class="job_seen_beacon">
          <a data-jk="job-${String(index)}" ${index === 199 ? 'aria-pressed="true"' : ''}>Job ${String(index)}</a>
        </div>
      </div>
    `,
    ).join('');
    setBody(`
      <div id="mosaic-jobResults">${cards}</div>
      <section class="jobsearch-RightPane">
        <h1 class="jobsearch-JobInfoHeader-title">Job 199</h1>
        <div id="jobDescriptionText">Selected description.</div>
      </section>
    `);
    const containsSpy = vi.spyOn(Element.prototype, 'contains');

    const { draft } = await extractJobDraft(INDEED);

    expect(draft.external_job_id).toBe('job-199');
    expect(draft.job_description).toBe('Selected description.');
    // Other extraction/sanitization helpers legitimately call contains(),
    // but card dedup must not add a call for every pair of the 400 markers.
    expect(containsSpy.mock.calls.length).toBeLessThan(50);
  });

  it('lets a uniquely title-correlated unmarked card override a stale vjk identity', async () => {
    loadFixture(
      indeedSplitViewFixture.replace(' aria-pressed="true"', ''),
      'https://www.indeed.com/jobs?q=engineer&vjk=stale-999',
    );

    const { draft } = await extractJobDraft({
      ...INDEED,
      externalJobId: 'stale-999',
    });

    expect(draft.external_job_id).toBe('selected-123');
    expect(draft.job_link).toBe(
      'https://www.indeed.com/viewjob?jk=selected-123',
    );
    expect(draft.job_description).toBe('Lead the platform team.');
  });

  it('rejects duplicate-title correlation when no card is marked selected', async () => {
    loadFixture(
      indeedSplitViewFixture
        .replace(' aria-pressed="true"', '')
        .replace('full details of Other Job', 'full details of Staff Engineer')
        .replace('>Other Job</a', '>Staff Engineer</a'),
      'https://www.indeed.com/jobs?q=engineer',
    );

    const { draft } = await extractJobDraft(INDEED);

    expect(draft.external_job_id).toBeUndefined();
  });

  it('does not select a pressed shelf card outside the primary results boundary', async () => {
    loadFixture(
      indeedSplitViewFixture.replace(
        'data-jk="selected-123"\n              aria-pressed="true"',
        'data-jk="selected-123"',
      ),
      'https://www.indeed.com/jobs?q=engineer',
    );

    const { draft } = await extractJobDraft(INDEED);

    expect(draft.external_job_id).toBe('selected-123');
    expect(draft.external_job_id).not.toBe('shelf-999');
  });

  it('finds primary cards under an alternate results container and marker class', async () => {
    loadFixture(
      indeedSplitViewFixture
        .replace('id="mosaic-jobResults"', 'id="mosaic-provider-jobcards"')
        .replaceAll('class="job_seen_beacon"', 'data-testid="slider_item"'),
      'https://www.indeed.com/jobs?q=engineer&vjk=stale-999',
    );

    const { draft } = await extractJobDraft({
      ...INDEED,
      externalJobId: 'stale-999',
    });

    expect(draft.external_job_id).toBe('selected-123');
    expect(draft.job_title).toBe('Staff Engineer');
    expect(draft.company_name).toBe('Acme Corp');
  });

  it('rejects visible stale pane text when a search result has no verified card match', async () => {
    loadFixture(
      indeedSplitViewFixture
        .replace(' aria-pressed="true"', '')
        .replace(
          '<meta name="description" content="Lead the platform team." />',
          '',
        )
        .replaceAll(
          'Staff Engineer - job post',
          'Unrelated Engineer - job post',
        ),
      'https://www.indeed.com/jobs?q=engineer&vjk=stale-999',
    );

    const { draft } = await extractJobDraft({
      ...INDEED,
      externalJobId: 'stale-999',
    });

    expect(draft.external_job_id).toBe('stale-999');
    expect(draft.job_description).not.toBe('Lead the platform team.');
  });

  it('rejects hidden stale pane text when vjk has no verified card match', async () => {
    loadFixture(
      indeedSplitViewFixture
        .replace(' aria-pressed="true"', '')
        .replace(
          '<meta name="description" content="Lead the platform team." />',
          '',
        )
        .replace(
          '<section class="jobsearch-RightPane">',
          '<section class="jobsearch-RightPane" style="display: none">',
        )
        .replaceAll(
          'Staff Engineer - job post',
          'Unrelated Engineer - job post',
        ),
      'https://www.indeed.com/jobs?q=engineer&vjk=stale-999',
    );

    const { draft } = await extractJobDraft({
      ...INDEED,
      externalJobId: 'stale-999',
    });

    expect(draft.external_job_id).toBe('stale-999');
    expect(draft.job_description).not.toBe('Lead the platform team.');
  });

  it('derives is_remote from the workplace-type prefix in the card location', async () => {
    setLocation('https://www.indeed.com/jobs?q=engineer&vjk=abc');
    setBody(`
      <li>
        <h2><a data-jk="abc" aria-pressed="true" href="/rc/clk?jk=abc">Backend Engineer</a></h2>
        <div data-testid="text-location">Hybrid work in Centennial, CO 80112</div>
      </li>
      <h1 class="jobsearch-JobInfoHeader-title">Backend Engineer</h1>
      <div id="jobDescriptionText">Build services.</div>
    `);

    const { draft } = await extractJobDraft(INDEED);

    expect(draft.job_location).toBe('Hybrid work in Centennial, CO 80112');
    expect(draft.is_remote).toBe(false);
  });

  it('prefers the selected card title over the serp header h1', async () => {
    setLocation('https://www.indeed.com/jobs?q=engineer&vjk=abc');
    setBody(`
      <h1>engineer jobs in Austin, TX</h1>
      <li>
        <h2><a data-jk="abc" aria-pressed="true" href="/rc/clk?jk=abc">Backend Engineer</a></h2>
      </li>
      <div id="jobDescriptionText">Build services.</div>
    `);

    const { draft } = await extractJobDraft(INDEED);

    expect(draft.job_title).toBe('Backend Engineer');
  });

  it('finds the selected card when aria-pressed is on a wrapper element', async () => {
    setLocation('https://www.indeed.com/jobs?q=engineer&vjk=wrap-42');
    setBody(`
      <li>
        <div aria-pressed="true">
          <h2><a data-jk="wrap-42" href="/rc/clk?jk=wrap-42">Platform Engineer</a></h2>
        </div>
      </li>
      <h1 class="jobsearch-JobInfoHeader-title">Platform Engineer</h1>
      <div id="jobDescriptionText">Description.</div>
    `);

    const { draft } = await extractJobDraft(INDEED);

    expect(draft.external_job_id).toBe('wrap-42');
    expect(draft.job_link).toBe('https://www.indeed.com/viewjob?jk=wrap-42');
  });

  it('falls back to the jk href param when the selected card has no data-jk', async () => {
    setLocation('https://www.indeed.com/jobs?q=engineer&vjk=href-77');
    setBody(`
      <li>
        <h2><a aria-pressed="true" href="/rc/clk?jk=href-77&from=serp">SRE</a></h2>
      </li>
      <h1 class="jobsearch-JobInfoHeader-title">SRE</h1>
      <div id="jobDescriptionText">Keep it running.</div>
    `);

    const { draft } = await extractJobDraft(INDEED);

    expect(draft.external_job_id).toBe('href-77');
    expect(draft.job_link).toBe('https://www.indeed.com/viewjob?jk=href-77');
  });

  it('ignores unselected cards when no card is aria-pressed', async () => {
    setLocation('https://www.indeed.com/jobs?q=engineer&vjk=url-55');
    setBody(`
      <li>
        <h2><a data-jk="other-111" href="/rc/clk?jk=other-111">Other Job</a></h2>
      </li>
      <h1 class="jobsearch-JobInfoHeader-title">Software Engineer</h1>
      <div id="jobDescriptionText">Build reliable systems.</div>
    `);

    const { draft } = await extractJobDraft({
      ...INDEED,
      externalJobId: 'url-55',
    });

    expect(draft.external_job_id).toBe('url-55');
    expect(draft.job_title).toBe('Software Engineer');
  });

  it('uses the selected split-view vjk value as the Indeed job ID', async () => {
    window.history.replaceState({}, '', '/jobs?q=engineer&vjk=selected-123');
    setBody(`
      <h1 data-testid="jobsearch-JobInfoHeader-title">Software Engineer</h1>
      <div data-testid="inlineHeader-companyName">Acme</div>
      <div id="jobDescriptionText">Build reliable systems.</div>
    `);

    const { draft } = await extractJobDraft({
      ...INDEED,
      externalJobId: 'selected-123',
    });

    expect(draft.external_job_id).toBe('selected-123');
  });
});

describe('extractJobDraft — Glassdoor DOM extraction', () => {
  const GLASSDOOR = {
    platform: 'glassdoor' as const,
    confidence: 'high' as const,
  };

  it('extracts title, company, location, and description from Glassdoor selectors', async () => {
    setBody(`
      <h1 data-test="job-title">Frontend Developer</h1>
      <div data-test="employer-name">Example Labs</div>
      <div data-test="location">Remote</div>
      <div data-test="jobDescriptionContent">Own our UI.</div>
    `);

    const { draft } = await extractJobDraft(GLASSDOOR);

    expect(draft.job_title).toBe('Frontend Developer');
    expect(draft.company_name).toBe('Example Labs');
    expect(draft.job_location).toBe('Remote');
    expect(draft.job_description).toBe('Own our UI.');
  });

  it('extracts a partial draft when only some Glassdoor selectors are present', async () => {
    setBody('<h1 data-test="job-title">Frontend Developer</h1>');

    vi.useFakeTimers();
    const pending = extractJobDraft(GLASSDOOR);
    await vi.advanceTimersByTimeAsync(800);
    const { draft } = await pending;

    expect(draft.job_title).toBe('Frontend Developer');
    expect(draft.company_name).toBeUndefined();
  });
});

describe('extractJobDraft — Dice DOM extraction', () => {
  const DICE = { platform: 'dice' as const, confidence: 'high' as const };

  it('extracts a Dice detail page within the matching job container', async () => {
    window.history.replaceState(
      {},
      '',
      '/job-detail/123e4567-e89b-12d3-a456-426614174000',
    );
    document.body.innerHTML = `
      <main>
        <a href="/job-detail/123e4567-e89b-12d3-a456-426614174000">
          <h1>Senior Software Engineer</h1>
        </a>
        <a href="/company-profile/acme">Acme Corp</a>
        <p data-testid="job-location">Denver, Colorado</p>
        <section data-testid="job-description">Build secure browser tooling.</section>
      </main>
    `;

    const { draft } = await extractJobDraft(DICE);

    expect(draft).toMatchObject({
      source_platform: 'dice',
      external_job_id: '123e4567-e89b-12d3-a456-426614174000',
      company_name: 'Acme Corp',
      job_title: 'Senior Software Engineer',
      job_location: 'Denver, Colorado',
      job_description: 'Build secure browser tooling.',
    });
  });
});

describe('extractJobDraft — Google Jobs DOM extraction', () => {
  const GOOGLE = { platform: 'google' as const, confidence: 'high' as const };

  it('extracts the selected job title, company, and description via ARIA structure', async () => {
    setBody(`
      <div>
        <div role="heading" aria-level="2">Product Engineer</div>
        <div>Northstar Apps</div>
        <section>Build delightful product experiences.</section>
      </div>
    `);

    const { draft } = await extractJobDraft(GOOGLE);

    expect(draft.job_title).toBe('Product Engineer');
    expect(draft.company_name).toBe('Northstar Apps');
    expect(draft.job_description).toBe('Build delightful product experiences.');
  });

  it('prefers the scoped dom description over a generic page-level meta description', async () => {
    setHead(
      '<meta name="description" content="Search results for Software Engineer jobs" />',
    );
    setBody(`
      <div>
        <div role="heading" aria-level="2">Product Engineer</div>
        <div>Northstar Apps</div>
        <section>Build delightful product experiences.</section>
      </div>
    `);

    const { draft } = await extractJobDraft(GOOGLE);

    expect(draft.job_description).toBe('Build delightful product experiences.');
  });

  it('prefers the aria-selected job card over the first card in a multi-result list', async () => {
    setBody(`
      <div>
        <div role="heading" aria-level="2">First Listed Job</div>
        <div>Wrong Co</div>
      </div>
      <div aria-selected="true">
        <div role="heading" aria-level="2">Actually Selected Job</div>
        <div>Correct Co</div>
        <section>The job the user opened.</section>
      </div>
    `);

    const { draft } = await extractJobDraft(GOOGLE);

    expect(draft.job_title).toBe('Actually Selected Job');
    expect(draft.company_name).toBe('Correct Co');
    expect(draft.job_description).toBe('The job the user opened.');
  });

  it('picks up selection state applied to an existing card via attribute mutation, not just element insertion', async () => {
    setBody(`
      <div>
        <div role="heading" aria-level="2">First Listed Job</div>
        <div>Wrong Co</div>
      </div>
      <div>
        <div role="heading" aria-level="2">Actually Selected Job</div>
        <div>Correct Co</div>
        <section>The job the user opened.</section>
      </div>
    `);
    const secondCard = document.body.children[1];
    if (!secondCard) throw new Error('expected a second card in the fixture');

    const pending = extractJobDraft(GOOGLE);
    // Some SPAs mark the active card by toggling an attribute on an
    // already-mounted node rather than inserting new elements -- the
    // observer must react to this, not just to childList changes.
    setTimeout(() => {
      secondCard.setAttribute('aria-selected', 'true');
    }, 0);

    const { draft } = await pending;

    expect(draft.job_title).toBe('Actually Selected Job');
    expect(draft.company_name).toBe('Correct Co');
    expect(draft.job_description).toBe('The job the user opened.');
  });

  it('does not fabricate a description candidate when no bounded container exists', async () => {
    setBody(`
      <span>
        <span role="heading" aria-level="2">Product Engineer</span>
        <span>Northstar Apps</span>
      </span>
      <section>Unrelated footer legal disclaimer text, not a job description.</section>
    `);

    const { draft } = await extractJobDraft(GOOGLE);

    expect(draft.job_title).toBe('Product Engineer');
    expect(draft.job_description).not.toBe(
      'Unrelated footer legal disclaimer text, not a job description.',
    );
  });

  it('does not extract a dom title when no ARIA heading appears before the timeout', async () => {
    setBody('<div>No structured job panel here.</div>');

    vi.useFakeTimers();
    const pending = extractJobDraft(GOOGLE);
    await vi.advanceTimersByTimeAsync(1800);
    const { draft } = await pending;

    expect(draft.job_title).toBeUndefined();
  });

  it('returns no candidate when multiple Google Jobs results remain ambiguous', async () => {
    setBody(`
      <div><div role="heading" aria-level="2">First Job</div></div>
      <div><div role="heading" aria-level="2">Second Job</div></div>
    `);

    vi.useFakeTimers();
    const pending = extractJobDraft(GOOGLE);
    await vi.advanceTimersByTimeAsync(1800);
    const { draft } = await pending;

    expect(draft.job_title).toBeUndefined();
  });
});

describe('extractJobDraft — Phase 2 provider fixtures', () => {
  it('extracts required fields and stable ID from Greenhouse', async () => {
    loadFixture(
      greenhouseFixture,
      'https://boards.greenhouse.io/hiringco/jobs/456789',
    );
    const { draft } = await extractJobDraft({
      platform: 'greenhouse',
      confidence: 'high',
      externalJobId: '456789',
    });

    expect(draft).toMatchObject({
      source_platform: 'greenhouse',
      external_job_id: '456789',
      company_name: 'Hiring Co',
      job_title: 'Platform Engineer',
      job_location: 'Denver, CO (Hybrid)',
      is_remote: false,
      job_description: 'Operate developer infrastructure.',
    });
  });

  it('extracts Lever categories and canonical posting identity', async () => {
    loadFixture(leverFixture, 'https://jobs.lever.co/acme-robotics/lever-123');
    const { draft } = await extractJobDraft({
      platform: 'lever',
      confidence: 'high',
      externalJobId: 'lever-123',
    });

    expect(draft).toMatchObject({
      source_platform: 'lever',
      external_job_id: 'lever-123',
      company_name: 'Acme Robotics',
      job_title: 'Backend Engineer',
      job_location: 'Santiago / Latin America',
      is_remote: true,
      job_type: 'full_time',
      keywords: ['Engineering'],
      job_description: 'Build reliable robotics APIs.',
      job_link: 'https://jobs.lever.co/acme-robotics/lever-123',
    });
  });

  it('treats an explicit hybrid workplace type as non-remote even when the location text also mentions remote', async () => {
    loadFixture(leverFixture, 'https://jobs.lever.co/acme-robotics/lever-123');
    document.querySelector('.workplaceTypes')?.replaceChildren('Hybrid');
    document
      .querySelector('.location')
      ?.replaceChildren('Remote-eligible, San Francisco');

    const { draft } = await extractJobDraft({
      platform: 'lever',
      confidence: 'high',
      externalJobId: 'lever-123',
    });

    expect(draft.is_remote).toBe(false);
  });

  it('prefers Lever employer metadata over a humanized tenant slug', async () => {
    loadFixture(leverFixture, 'https://jobs.lever.co/applydigital/lever-123');
    document.querySelector('.posting-company')?.remove();
    document
      .querySelector('meta[property="og:site_name"]')
      ?.setAttribute('content', 'APPLY');

    const { draft } = await extractJobDraft({
      platform: 'lever',
      confidence: 'high',
      externalJobId: 'lever-123',
    });

    expect(draft.company_name).toBe('APPLY');
  });

  it('waits for and extracts Workday requisition metadata', async () => {
    loadFixture(
      workdayFixture,
      'https://acme.myworkdayjobs.com/careers/job/Colorado/Security-Engineer/R-1234',
    );
    const { draft } = await extractJobDraft({
      platform: 'workday',
      confidence: 'high',
    });

    expect(draft).toMatchObject({
      source_platform: 'workday',
      external_job_id: 'R-1234',
      company_name: 'Acme Workday',
      job_title: 'Security Engineer',
      job_location: 'Remote - Colorado',
      is_remote: true,
      date_posted: '2026-07-10',
      job_type: 'full_time',
      job_description: 'Protect cloud services.',
    });
  });

  it('extracts Dice skills, compensation, and contract type', async () => {
    loadFixture(
      diceFixture,
      'https://www.dice.com/job-detail/123e4567-e89b-12d3-a456-426614174000',
    );
    const { draft } = await extractJobDraft({
      platform: 'dice',
      confidence: 'high',
    });

    expect(draft).toMatchObject({
      source_platform: 'dice',
      external_job_id: '123e4567-e89b-12d3-a456-426614174000',
      job_type: 'contract',
      is_remote: true,
      salary_text: '$70 - $85 an hour',
      skills: ['TypeScript', 'React'],
    });
  });

  it('bounds Dice heading-based skills before the next section heading', async () => {
    setLocation(
      'https://www.dice.com/job-detail/123e4567-e89b-12d3-a456-426614174000',
    );
    setBody(`
      <main>
        <a href="/job-detail/123e4567-e89b-12d3-a456-426614174000">
          <h1>Senior Software Engineer</h1>
        </a>
        <section data-testid="job-description">Build secure browser tooling with Python and Docker for a remote team. CISSP required.</section>
        <h2>Skills</h2>
        <h3>Required</h3>
        <ul><li>TypeScript</li><li>React</li></ul>
        <h2>Responsibilities</h2>
        <ul><li>Deploy production services</li><li>Mentor engineers</li></ul>
      </main>
    `);

    const { draft, candidates } = await extractJobDraft({
      platform: 'dice',
      confidence: 'high',
    });

    // Fixture rule: CISSP, Docker, Python, and remote stay in their owning
    // categories -- certifications, software, skills, and keywords.
    expect(draft.skills).toEqual(['TypeScript', 'React', 'Python']);
    expect(draft.software).toEqual(['Docker']);
    expect(draft.certifications).toEqual(['CISSP']);
    expect(draft.keywords).toEqual(['remote']);

    // The structured Dice skills section and the description-derived union
    // are both offered for review, each labeled with its source.
    expect(candidates.skills).toEqual([
      expect.objectContaining({
        source: 'dom',
        value: ['TypeScript', 'React'],
      }),
      expect.objectContaining({
        source: 'description',
        value: ['TypeScript', 'React', 'Python'],
      }),
    ]);
  });

  it('keeps Dice skills within the draft schema limits', async () => {
    setLocation(
      'https://www.dice.com/job-detail/123e4567-e89b-12d3-a456-426614174000',
    );
    const skillItems = [
      `<li>${'x'.repeat(201)}</li>`,
      ...Array.from(
        { length: 102 },
        (_, index) => `<li>Skill ${String(index)}</li>`,
      ),
    ].join('');
    setBody(`
      <main>
        <a href="/job-detail/123e4567-e89b-12d3-a456-426614174000">
          <h1>Senior Software Engineer</h1>
        </a>
        <section data-testid="job-description">Build secure browser tooling.</section>
        <section data-testid="skills"><ul>${skillItems}</ul></section>
      </main>
    `);

    const { draft } = await extractJobDraft({
      platform: 'dice',
      confidence: 'high',
    });

    expect(draft.skills).toHaveLength(100);
    expect(draft.skills?.at(0)).toBe('Skill 0');
    expect(draft.skills?.at(-1)).toBe('Skill 99');
  });

  it('preserves Wellfound salary and equity text without inventing bounds', async () => {
    loadFixture(
      wellfoundFixture,
      'https://wellfound.com/jobs/123456-founding-engineer',
    );
    const { draft } = await extractJobDraft({
      platform: 'angellist',
      confidence: 'high',
      externalJobId: '123456-founding-engineer',
    });

    expect(draft).toMatchObject({
      source_platform: 'angellist',
      external_job_id: '123456-founding-engineer',
      company_name: 'Launch Co',
      job_title: 'Founding Engineer',
      job_location: 'Remote - US',
      is_remote: true,
      salary_text: '$150k – $190k • 0.25% – 0.75% equity',
      job_type: 'full_time',
      job_description: 'Build the first product team.',
    });
    expect(draft.salary_min).toBeUndefined();
    expect(draft.salary_max).toBeUndefined();
  });

  it('extracts Built In JSON-LD graph fields and prefers scoped safe DOM Markdown', async () => {
    loadFixture(
      builtInFixture,
      'https://builtin.com/job/staff-platform-engineer/9764574',
    );
    const { draft } = await extractJobDraft({
      platform: 'direct',
      confidence: 'high',
      externalJobId: '9764574',
    });

    expect(draft).toMatchObject({
      source_platform: 'direct',
      external_job_id: '9764574',
      company_name: 'Peak Systems',
      job_title: 'Staff Platform Engineer',
      job_location: 'Denver, CO | Boulder, CO',
      job_type: 'full_time',
      date_posted: '2026-07-12',
      job_link: 'https://builtin.com/job/staff-platform-engineer/9764574',
    });
    expect(draft.job_description).toContain('Own the **developer platform**.');
    expect(draft.job_description).toContain('- Improve reliability');
    expect(draft.job_description).not.toContain('unsafe');
    expect(draft.job_description).not.toContain('Stale structured description');
  });

  it('extracts a Built In remote posting without inventing an onsite location', async () => {
    loadFixture(
      builtInRemoteFixture,
      'https://builtin.com/job/remote-product-engineer/9880001',
    );
    const { draft } = await extractJobDraft({
      platform: 'direct',
      confidence: 'high',
      externalJobId: '9880001',
    });

    expect(draft).toMatchObject({
      external_job_id: '9880001',
      job_location: 'Remote, United States',
      is_remote: true,
      job_description: 'Ship a distributed product.',
    });
  });
});
