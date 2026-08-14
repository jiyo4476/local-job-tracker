import { describe, expect, it } from 'vitest';
import { parseHash } from './router';

describe('parseHash', () => {
  it('parses all job routes and decodes company search', () => {
    expect(parseHash('#/jobs/new')).toEqual({ name: 'job-new' });
    expect(parseHash('#/jobs/42/edit')).toEqual({ name: 'job-edit', id: 42 });
    expect(parseHash('#/jobs?q=ACME%20Inc')).toEqual({
      name: 'jobs',
      query: 'ACME Inc',
    });
  });

  it('does not accept non-finite or partial numeric ids', () => {
    expect(parseHash('#/jobs/12oops')).toEqual({ name: 'jobs' });
  });
});
