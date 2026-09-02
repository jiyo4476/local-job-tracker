import { TAXONOMY_FIELDS, TAXONOMY_GROUP_COPY } from './taxonomyFields';

const YAML_UNSAFE = /[:#[\]{}|>*&!%@`"'\n]/;

/**
 * The fields a job Markdown export can render. Both a `StoredJob` (has
 * lifecycle fields like `interview_stage`/`notes`) and a freshly saved
 * `ScrapePayload` (returned by `SAVE_JOB_LOCAL_RESULT`, no lifecycle fields
 * yet) satisfy this structurally, so the same export path covers a manual
 * download from the Job Detail view and an automatic download right after a
 * whitelisted-URL template save in the popup.
 */
export interface MarkdownJobFields {
  company_name: string;
  job_title: string;
  job_location?: string | undefined;
  is_remote?: boolean | undefined;
  source_platform?: string | undefined;
  job_link?: string | undefined;
  date_posted?: string | undefined;
  job_type?: string | undefined;
  experience_level?: string | undefined;
  salary_text?: string | undefined;
  interview_stage?: string | undefined;
  skills?: string[] | undefined;
  software?: string[] | undefined;
  keywords?: string[] | undefined;
  certifications?: string[] | undefined;
  job_description?: string | undefined;
  notes?: string | undefined;
}

function yamlScalar(value: string): string {
  return YAML_UNSAFE.test(value) || value.trim() !== value
    ? JSON.stringify(value)
    : value;
}

function frontmatterLines(job: MarkdownJobFields): string[] {
  const lines = ['---'];
  const push = (key: string, value: string | number | boolean | undefined) => {
    if (value === undefined || value === '') return;
    lines.push(
      `${key}: ${typeof value === 'string' ? yamlScalar(value) : String(value)}`,
    );
  };

  push('company', job.company_name);
  push('title', job.job_title);
  push('location', job.job_location);
  push('remote', job.is_remote);
  push('source', job.source_platform);
  push('link', job.job_link);
  push('date_posted', job.date_posted);
  push('job_type', job.job_type);
  push('experience_level', job.experience_level);
  push('salary', job.salary_text);
  push('interview_stage', job.interview_stage);

  for (const field of TAXONOMY_FIELDS) {
    const tags = job[field];
    if (!tags || tags.length === 0) continue;
    lines.push(`${field}:`);
    for (const tag of tags) lines.push(`  - ${yamlScalar(tag)}`);
  }

  lines.push('---');
  return lines;
}

/** Renders a job as a portable Markdown document with a YAML frontmatter block. */
export function buildJobMarkdown(job: MarkdownJobFields): string {
  const sections: string[] = [
    frontmatterLines(job).join('\n'),
    '',
    `# ${job.job_title} at ${job.company_name}`,
    '',
  ];

  if (job.job_link)
    sections.push(`[View original posting](${job.job_link})`, '');

  for (const field of TAXONOMY_FIELDS) {
    const tags = job[field];
    if (!tags || tags.length === 0) continue;
    sections.push(`## ${TAXONOMY_GROUP_COPY[field].label}`, '');
    sections.push(tags.map((tag) => `- ${tag}`).join('\n'), '');
  }

  if (job.job_description) {
    sections.push('## Description', '', job.job_description.trim(), '');
  }

  if (job.notes) {
    sections.push('## Notes', '', job.notes.trim(), '');
  }

  return (
    sections
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

/** Builds a filesystem-safe `.md` filename for a stored job. */
export function jobMarkdownFilename(job: MarkdownJobFields): string {
  const slugSource = `${job.company_name}-${job.job_title}`;
  const slug =
    slugSource
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'job';
  return `${slug}.md`;
}
