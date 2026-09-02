import { getDb } from '../db/schema';
import {
  MAX_SITE_TEMPLATES,
  siteTemplateSchema,
  type SiteTemplate,
  type SiteTemplateInput,
} from './schema';

export async function listSiteTemplates(): Promise<SiteTemplate[]> {
  return (await getDb().templates.toArray()).sort(
    (a, b) => b.priority - a.priority || a.name.localeCompare(b.name),
  );
}

export async function getSiteTemplate(
  id: string,
): Promise<SiteTemplate | undefined> {
  return getDb().templates.get(id);
}

export async function saveSiteTemplate(
  input: SiteTemplateInput,
): Promise<SiteTemplate> {
  const parsed = siteTemplateSchema.parse(input);
  const db = getDb();
  return db.transaction('rw', db.templates, async () => {
    const existing = await db.templates.get(parsed.id);
    if (!existing && (await db.templates.count()) >= MAX_SITE_TEMPLATES) {
      throw new Error(
        `Template limit reached (${String(MAX_SITE_TEMPLATES)}). Delete an unused template first.`,
      );
    }
    const saved = siteTemplateSchema.parse({
      ...parsed,
      created_at: existing?.created_at ?? parsed.created_at,
      updated_at: new Date().toISOString(),
    });
    await db.templates.put(saved);
    return saved;
  });
}

export async function deleteSiteTemplate(id: string): Promise<void> {
  await getDb().templates.delete(zeroTrustTemplateId(id));
}

export async function setSiteTemplateEnabled(
  id: string,
  enabled: boolean,
): Promise<SiteTemplate> {
  const db = getDb();
  return db.transaction('rw', db.templates, async () => {
    const existing = await db.templates.get(zeroTrustTemplateId(id));
    if (!existing) throw new Error('Template not found.');
    const updated = siteTemplateSchema.parse({
      ...existing,
      enabled,
      updated_at: new Date().toISOString(),
    });
    await db.templates.put(updated);
    return updated;
  });
}

function zeroTrustTemplateId(id: string): string {
  return siteTemplateSchema.shape.id.parse(id);
}
