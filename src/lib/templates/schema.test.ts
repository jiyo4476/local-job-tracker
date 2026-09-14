import { describe, expect, it } from 'vitest';

import { siteTemplateSchema } from './schema';

const baseTemplate = {
  id: crypto.randomUUID(),
  name: 'Acme jobs',
  hostname: 'careers.acme.example',
  path_pattern: '/jobs/*',
  rules: [{ field: 'job_title', selector: 'h1' }],
};

describe('site template selection schema', () => {
  it('requires both selection fields when selection is configured', () => {
    expect(() =>
      siteTemplateSchema.parse({
        ...baseTemplate,
        selection: { item_selector: '.job-card' },
      }),
    ).toThrow();
    expect(() =>
      siteTemplateSchema.parse({
        ...baseTemplate,
        selection: { active_class: 'active' },
      }),
    ).toThrow();
  });

  it('accepts a site-specific bounded selector and exact class token', () => {
    const parsed = siteTemplateSchema.parse({
      ...baseTemplate,
      selection: {
        item_selector: 'article.job-card',
        active_class: 'is-current',
      },
    });
    expect(parsed.selection).toEqual({
      item_selector: 'article.job-card',
      active_class: 'is-current',
    });
  });

  it('accepts an optional list selector', () => {
    const parsed = siteTemplateSchema.parse({
      ...baseTemplate,
      selection: {
        list_selector: 'ul.job-results',
        item_selector: 'li.job-card',
        active_class: 'is-current',
      },
    });
    expect(parsed.selection?.list_selector).toBe('ul.job-results');
  });

  it('rejects whitespace, selector syntax, and overly broad active classes', () => {
    for (const active_class of ['active selected', '.active', '*']) {
      expect(() =>
        siteTemplateSchema.parse({
          ...baseTemplate,
          selection: { item_selector: '.job-card', active_class },
        }),
      ).toThrow();
    }
    expect(() =>
      siteTemplateSchema.parse({
        ...baseTemplate,
        selection: {
          item_selector: '.job-card, .other',
          active_class: 'active',
        },
      }),
    ).toThrow();
    expect(() =>
      siteTemplateSchema.parse({
        ...baseTemplate,
        selection: {
          list_selector: 'ul.job-results, ol.other',
          item_selector: 'li.job-card',
          active_class: 'active',
        },
      }),
    ).toThrow();
  });
});
