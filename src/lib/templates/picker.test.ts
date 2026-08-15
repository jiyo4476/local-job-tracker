// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  buildStableSelector,
  inferTemplateRule,
  suggestPathPattern,
} from './picker';

describe('template element picker utilities', () => {
  it('prefers stable attributes and falls back to a unique structural selector', () => {
    document.body.innerHTML = `
      <main><h1 data-testid="job-title">Engineer</h1></main>
      <section><p>First</p><p id="chosen">Second</p></section>
    `;
    const title = document.querySelector('h1');
    const chosen = document.querySelector('#chosen');
    expect(title && buildStableSelector(title)).toBe(
      'h1[data-testid="job-title"]',
    );
    expect(chosen && buildStableSelector(chosen)).toBe('#chosen');
  });

  it('does not freeze dynamic job ids into a reusable selector', () => {
    document.body.innerHTML = `
      <main><section id="job-123456"><h1 data-testid="job-title:123456">Engineer</h1></section></main>
    `;
    const title = document.querySelector('h1');
    const selector = title && buildStableSelector(title);
    expect(selector).not.toContain('123456');
    expect(selector).not.toContain(':123456');
  });

  it('suggests a reusable sibling path and field-aware safe transforms', () => {
    document.body.innerHTML = '<a id="apply" href="/jobs/123">Apply</a>';
    const link = document.querySelector('#apply');
    expect(suggestPathPattern('https://careers.example.com/jobs/123?q=x')).toBe(
      '/jobs/*',
    );
    expect(link && inferTemplateRule('job_link', link, '#apply')).toMatchObject(
      {
        attribute: 'href',
        transforms: ['absolute_url'],
      },
    );
  });
});
