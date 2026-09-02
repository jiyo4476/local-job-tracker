import { describe, expect, it } from 'vitest';
import { buildJobMarkdown, jobMarkdownFilename } from './markdownExport';
import type { StoredJob } from './db/schema';

function makeJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: 1,
    source_platform: 'direct',
    external_job_id: 'abc123',
    company_name: 'Acme Corp',
    job_title: 'Staff Engineer',
    job_link: 'https://acme.example/jobs/abc123',
    interview_stage: 'not_applied',
    priority: 0,
    notes: '',
    contacts: [],
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildJobMarkdown', () => {
  it('renders frontmatter, heading, and link', () => {
    const md = buildJobMarkdown(makeJob());
    expect(md).toContain('---\n');
    expect(md).toContain('company: Acme Corp');
    expect(md).toContain('title: Staff Engineer');
    expect(md).toContain('# Staff Engineer at Acme Corp');
    expect(md).toContain(
      '[View original posting](https://acme.example/jobs/abc123)',
    );
  });

  it('lists taxonomy tags under their own sections', () => {
    const md = buildJobMarkdown(
      makeJob({ skills: ['Python', 'CI/CD'], software: ['Docker'] }),
    );
    expect(md).toContain('## Skills');
    expect(md).toContain('- Python');
    expect(md).toContain('- CI/CD');
    expect(md).toContain('## Software');
    expect(md).toContain('- Docker');
  });

  it('omits empty taxonomy sections', () => {
    const md = buildJobMarkdown(makeJob());
    expect(md).not.toContain('## Skills');
    expect(md).not.toContain('## Software');
  });

  it('includes description and notes when present', () => {
    const md = buildJobMarkdown(
      makeJob({ job_description: 'Build things.', notes: 'Great culture.' }),
    );
    expect(md).toContain('## Description');
    expect(md).toContain('Build things.');
    expect(md).toContain('## Notes');
    expect(md).toContain('Great culture.');
  });

  it('quotes yaml-unsafe scalars', () => {
    const md = buildJobMarkdown(
      makeJob({ job_title: 'Engineer: Backend & APIs' }),
    );
    expect(md).toContain('title: "Engineer: Backend & APIs"');
  });
});

describe('jobMarkdownFilename', () => {
  it('slugifies company and title', () => {
    expect(
      jobMarkdownFilename(
        makeJob({ company_name: 'Acme Corp!', job_title: 'Staff Engineer' }),
      ),
    ).toBe('acme-corp-staff-engineer.md');
  });

  it('falls back to a generic name when nothing slugifies', () => {
    expect(
      jobMarkdownFilename(makeJob({ company_name: '', job_title: '' })),
    ).toBe('job.md');
  });
});
