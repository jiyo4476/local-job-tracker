// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  buildStableSelector,
  inferTemplateRule,
  listDescendantTagNames,
  previewText,
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

  it('can capture an anchor URL separately from its visible text', () => {
    document.body.innerHTML =
      '<a id="apply" href="/jobs/123"><span>Apply now</span></a>';
    const text = document.querySelector('span');
    expect(
      text && inferTemplateRule('job_title', text, 'span', 'link_text'),
    ).toMatchObject({
      selector: '#apply',
      attribute: 'text',
    });
    expect(
      text && inferTemplateRule('job_link', text, 'span', 'link'),
    ).toMatchObject({
      selector: '#apply',
      attribute: 'href',
      transforms: ['absolute_url'],
    });
  });

  it('supports URL-bearing buttons without executing page handlers', () => {
    document.body.innerHTML =
      '<button id="apply" data-href="/jobs/123">Apply</button>';
    const button = document.querySelector('button');
    expect(
      button && inferTemplateRule('job_link', button, '#apply', 'link'),
    ).toMatchObject({
      attribute: 'data-href',
      transforms: ['absolute_url'],
    });
  });

  it('lists a container plus its descendants tag names, deduped and sorted', () => {
    document.body.innerHTML = `
      <div id="card"><span>A</span><p><span>B</span></p><h1>Title</h1></div>
    `;
    const card = document.querySelector('#card');
    expect(card && listDescendantTagNames(card)).toEqual([
      'div',
      'h1',
      'p',
      'span',
    ]);
  });

  it('previews text for plain elements and link modes, truncated to 160 chars', () => {
    document.body.innerHTML = `
      <div id="card">
        <span id="plain">  Senior   Engineer  </span>
        <a id="link" href="/jobs/123">Apply <em>now</em></a>
      </div>
    `;
    const plain = document.querySelector('#plain');
    expect(plain && previewText(plain, 'text')).toBe('Senior Engineer');

    const link = document.querySelector('#link');
    expect(link && previewText(link, 'link')).toBe('/jobs/123');
    expect(link && previewText(link, 'link_text')).toBe('Apply now');

    const longText = document.createElement('span');
    longText.textContent = 'x'.repeat(200);
    document.body.append(longText);
    expect(previewText(longText, 'text')).toHaveLength(160);
  });
});
