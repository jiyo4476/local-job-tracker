import { z } from 'zod';

export const MAX_SITE_TEMPLATES = 500;
export const MAX_TEMPLATE_RULES = 40;
export const MAX_SELECTOR_LENGTH = 500;

export const templateFieldSchema = z.enum([
  'external_job_id',
  'company_name',
  'job_title',
  'job_link',
  'job_location',
  'is_remote',
  'job_description',
  'date_posted',
  'salary_text',
  'salary_type',
  'salary_min',
  'salary_max',
  'hourly_rate_min',
  'hourly_rate_max',
  'job_type',
  'experience_level',
  'security_clearance_req',
  'skills',
  'software',
  'keywords',
  'certifications',
]);

export const templateAttributeSchema = z.enum([
  'text',
  'href',
  'content',
  'datetime',
  'aria-label',
  'data-job-id',
]);

export const templateTransformSchema = z.enum([
  'trim',
  'collapse_whitespace',
  'absolute_url',
  'iso_date',
  'number',
  'boolean',
  'comma_list',
  'safe_markdown',
  'job_type',
  'experience_level',
  'salary_type',
]);

const collectionFields = new Set([
  'skills',
  'software',
  'keywords',
  'certifications',
]);

export const siteTemplateRuleSchema = z
  .object({
    field: templateFieldSchema,
    selector: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SELECTOR_LENGTH)
      .refine(isBoundedSelector, 'Selector contains unsupported syntax.'),
    attribute: templateAttributeSchema.default('text'),
    multiple: z.boolean().default(false),
    transforms: z.array(templateTransformSchema).max(8).default(['trim']),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.multiple && !collectionFields.has(rule.field)) {
      context.addIssue({
        code: 'custom',
        path: ['multiple'],
        message: 'Only taxonomy fields can collect multiple elements.',
      });
    }
    if (
      rule.attribute === 'href' &&
      rule.transforms.includes('safe_markdown')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['transforms'],
        message: 'Link rules cannot use the safe_markdown transform.',
      });
    }
  });

export type SiteTemplateRule = z.infer<typeof siteTemplateRuleSchema>;

const hostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value) => value.toLowerCase())
  .refine(
    (value) =>
      value !== 'localhost' &&
      !value.includes('/') &&
      !value.includes(':') &&
      /^[a-z0-9.-]+$/.test(value),
    'Enter a public hostname without a scheme, port, or path.',
  );

const pathPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => value.startsWith('/'), 'Path pattern must start with /.')
  .refine(
    (value) => !value.includes('**') && !/[?#]/.test(value),
    'Path pattern supports single * wildcards and cannot include query/hash.',
  );

export const siteTemplateSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .default(() => crypto.randomUUID()),
    name: z.string().trim().min(1).max(120),
    hostname: hostnameSchema,
    path_pattern: pathPatternSchema,
    enabled: z.boolean().default(true),
    priority: z.number().int().min(0).max(100).default(50),
    rules: z.array(siteTemplateRuleSchema).min(1).max(MAX_TEMPLATE_RULES),
    created_at: z
      .string()
      .datetime()
      .default(() => new Date().toISOString()),
    updated_at: z
      .string()
      .datetime()
      .default(() => new Date().toISOString()),
  })
  .strict();

export type SiteTemplate = z.infer<typeof siteTemplateSchema>;
export type SiteTemplateInput = Omit<
  z.input<typeof siteTemplateSchema>,
  'id' | 'created_at' | 'updated_at'
> &
  Partial<
    Pick<z.input<typeof siteTemplateSchema>, 'id' | 'created_at' | 'updated_at'>
  >;

function isBoundedSelector(selector: string): boolean {
  if (selector.includes(',') || /[\r\n]/.test(selector)) return false;
  const withoutNth = selector.replace(/:nth-of-type\([1-9]\d{0,3}\)/g, '');
  if (/[:()]/.test(withoutNth)) return false;
  return /^[a-zA-Z0-9_#.[\]="' >\\-]+$/.test(withoutNth);
}
