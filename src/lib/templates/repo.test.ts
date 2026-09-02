import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDbForTests } from '../db/schema';
import {
  deleteSiteTemplate,
  listSiteTemplates,
  saveSiteTemplate,
  setSiteTemplateEnabled,
} from './repo';
import { siteTemplateSchema } from './schema';

let dbIndex = 0;

beforeEach(() => {
  dbIndex += 1;
  resetDbForTests(`template-repo-${String(dbIndex)}`);
});

const input = {
  name: 'Acme careers',
  hostname: 'CAREERS.ACME.EXAMPLE',
  path_pattern: '/jobs/*',
  rules: [
    {
      field: 'job_title' as const,
      selector: '[data-testid="job-title"]',
      attribute: 'text' as const,
      transforms: ['trim' as const],
    },
  ],
};

describe('site template persistence', () => {
  it('normalizes, stores, updates, disables, and deletes a template', async () => {
    const created = await saveSiteTemplate(input);
    expect(created.hostname).toBe('careers.acme.example');
    expect(created.enabled).toBe(true);
    expect(await listSiteTemplates()).toEqual([created]);

    const updated = await saveSiteTemplate({
      ...created,
      name: 'Acme job detail',
    });
    expect(updated.id).toBe(created.id);
    expect(updated.created_at).toBe(created.created_at);

    await expect(
      setSiteTemplateEnabled(created.id, false),
    ).resolves.toMatchObject({ enabled: false });
    await deleteSiteTemplate(created.id);
    await expect(listSiteTemplates()).resolves.toEqual([]);
  });

  it('rejects unsafe matchers and non-taxonomy collection rules', () => {
    expect(() =>
      siteTemplateSchema.parse({
        ...input,
        hostname: 'https://careers.acme.example',
      }),
    ).toThrow();
    expect(() =>
      siteTemplateSchema.parse({
        ...input,
        path_pattern: '/jobs/**',
      }),
    ).toThrow();
    expect(() =>
      siteTemplateSchema.parse({
        ...input,
        rules: [{ ...input.rules[0], multiple: true }],
      }),
    ).toThrow('Only taxonomy fields');
    expect(() =>
      siteTemplateSchema.parse({
        ...input,
        rules: [{ ...input.rules[0], selector: 'body:has(input)' }],
      }),
    ).toThrow('unsupported syntax');
  });
});
