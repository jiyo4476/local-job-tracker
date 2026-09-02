// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { executeSiteTemplate, selectMatchingSiteTemplates } from './engine';
import { siteTemplateSchema } from './schema';

function template(overrides: Record<string, unknown> = {}) {
  return siteTemplateSchema.parse({
    id: crypto.randomUUID(),
    name: 'Acme jobs',
    hostname: 'careers.acme.example',
    path_pattern: '/jobs/*',
    priority: 50,
    rules: [{ field: 'job_title', selector: 'h1' }],
    ...overrides,
  });
}

describe('site template engine', () => {
  it('matches exact hosts and bounded single-segment path globs', () => {
    const broad = template();
    const specific = template({
      name: 'Engineering',
      path_pattern: '/jobs/eng-*',
      priority: 60,
    });
    expect(
      selectMatchingSiteTemplates(
        [broad, specific],
        'https://careers.acme.example/jobs/eng-123?source=search',
      ).map(({ name }) => name),
    ).toEqual(['Engineering', 'Acme jobs']);
    expect(
      selectMatchingSiteTemplates([broad], 'https://evil.example/jobs/eng-123'),
    ).toEqual([]);
    expect(
      selectMatchingSiteTemplates(
        [broad],
        'https://careers.acme.example/jobs/team/eng-123',
      ),
    ).toEqual([]);
  });

  it('prefers a newly retaught template when priority and path specificity tie', () => {
    const older = template({
      name: 'Older',
      updated_at: '2026-08-14T10:00:00.000Z',
    });
    const newer = template({
      name: 'Newer',
      updated_at: '2026-08-14T11:00:00.000Z',
    });
    expect(
      selectMatchingSiteTemplates(
        [older, newer],
        'https://careers.acme.example/jobs/123',
      )[0]?.name,
    ).toBe('Newer');
  });

  it('extracts bounded typed values and ignores invalid fields per rule', () => {
    document.body.innerHTML = `
      <h1> Senior Engineer </h1>
      <a class="apply" href="/jobs/123">Apply</a>
      <span class="salary">$120,000</span>
      <ul><li class="skill">TypeScript</li><li class="skill">Security</li></ul>
    `;
    const result = executeSiteTemplate(
      template({
        rules: [
          { field: 'job_title', selector: 'h1' },
          {
            field: 'job_link',
            selector: '.apply',
            attribute: 'href',
            transforms: ['absolute_url'],
          },
          { field: 'salary_min', selector: '.salary', transforms: ['number'] },
          { field: 'skills', selector: '.skill', multiple: true },
          {
            field: 'date_posted',
            selector: '.missing',
            transforms: ['iso_date'],
          },
        ],
      }),
      document,
      'https://careers.acme.example/jobs/123',
      (element) => element.textContent?.trim() ?? '',
    );
    expect(result.values).toEqual({
      job_title: 'Senior Engineer',
      job_link: 'https://careers.acme.example/jobs/123',
      salary_min: 12000000,
      skills: ['TypeScript', 'Security'],
    });
  });

  it('normalizes enum-like fields through an explicit transform allowlist', () => {
    document.body.innerHTML = `
      <span class="type">Full time</span>
      <span class="level">Mid-Senior Level</span>
      <span class="pay">per year</span>
    `;
    const result = executeSiteTemplate(
      template({
        rules: [
          { field: 'job_type', selector: '.type', transforms: ['job_type'] },
          {
            field: 'experience_level',
            selector: '.level',
            transforms: ['experience_level'],
          },
          {
            field: 'salary_type',
            selector: '.pay',
            transforms: ['salary_type'],
          },
        ],
      }),
      document,
      'https://careers.acme.example/jobs/123',
      () => '',
    );
    expect(result.values).toMatchObject({
      job_type: 'full_time',
      experience_level: 'senior',
      salary_type: 'annual',
    });
  });

  it('extracts all fields relative to the active repeated item', () => {
    document.body.innerHTML = `
      <ul>
        <li class="job-card"><h2>First Engineer</h2><a href="/jobs/1">First</a></li>
        <li class="job-card active"><h2>Selected Engineer</h2><a href="/jobs/2">Selected</a></li>
      </ul>
    `;
    const result = executeSiteTemplate(
      template({
        selection: { item_selector: '.job-card', active_class: 'active' },
        rules: [
          { field: 'job_title', selector: 'h2' },
          {
            field: 'job_link',
            selector: 'a',
            attribute: 'href',
            transforms: ['absolute_url'],
          },
        ],
      }),
      document,
      'https://careers.acme.example/jobs/2',
      () => '',
    );
    expect(result.values).toEqual({
      job_title: 'Selected Engineer',
      job_link: 'https://careers.acme.example/jobs/2',
    });
  });

  it('matches an active class on a descendant using an exact class token', () => {
    document.body.innerHTML = `
      <article class="job-card"><h2>Not selected</h2><span class="active-ish"></span></article>
      <article class="job-card"><h2>Selected</h2><span class="active"></span></article>
    `;
    const result = executeSiteTemplate(
      template({
        selection: {
          item_selector: 'article.job-card',
          active_class: 'active',
        },
        rules: [{ field: 'job_title', selector: 'h2' }],
      }),
      document,
      'https://careers.acme.example/jobs/2',
      () => '',
    );
    expect(result.values).toEqual({ job_title: 'Selected' });
  });

  it('selects an item from each configured list when its first child is active', () => {
    document.body.innerHTML = `
      <ul class="jobs">
        <li class="job-card"><span class="active-ish">Wrong</span><h2>Wrong A</h2></li>
        <li class="job-card"><span class="active">Selected A</span><h2>Selected A</h2></li>
      </ul>
      <ul class="jobs">
        <li class="job-card"><span class="active">Selected B</span><h2>Selected B</h2></li>
      </ul>
    `;
    const result = executeSiteTemplate(
      template({
        selection: {
          list_selector: 'ul.jobs',
          item_selector: 'li.job-card',
          active_class: 'active',
        },
        rules: [{ field: 'job_title', selector: 'h2' }],
      }),
      document,
      'https://careers.acme.example/jobs/2',
      () => '',
    );
    expect(result.values).toEqual({ job_title: 'Selected A' });
  });

  it('does not select an item from outside configured lists', () => {
    document.body.innerHTML = `
      <div class="outside"><li class="job-card"><h2>Outside</h2><span class="active"></span></li></div>
      <ul class="jobs"><li class="job-card"><h2>Inside</h2></li></ul>
    `;
    const result = executeSiteTemplate(
      template({
        selection: {
          list_selector: 'ul.jobs',
          item_selector: 'li.job-card',
          active_class: 'active',
        },
        rules: [{ field: 'job_title', selector: 'h2' }],
      }),
      document,
      'https://careers.acme.example/jobs/2',
      () => '',
    );
    expect(result.values).toEqual({});
  });

  it('returns no values when a configured list has no active item', () => {
    document.body.innerHTML = `
      <article class="job-card"><h2>First</h2></article>
      <article class="job-card"><h2>Second</h2></article>
    `;
    const result = executeSiteTemplate(
      template({
        selection: { item_selector: '.job-card', active_class: 'active' },
        rules: [{ field: 'job_title', selector: 'h2' }],
      }),
      document,
      'https://careers.acme.example/jobs/2',
      () => '',
    );
    expect(result.values).toEqual({});
  });

  it('preserves extraction for legacy templates without selection', () => {
    document.body.innerHTML = '<h1>Legacy Engineer</h1>';
    const result = executeSiteTemplate(
      template(),
      document,
      'https://careers.acme.example/jobs/2',
      () => '',
    );
    expect(result.values).toEqual({ job_title: 'Legacy Engineer' });
  });
});
