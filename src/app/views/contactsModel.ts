import { jobContactSchema, type JobContact } from '../../lib/db/schema';

export const MAX_CONTACTS = 100;
export type ContactDraft = Pick<JobContact, 'name'> &
  Partial<Omit<JobContact, 'id' | 'name' | 'created_at'>>;

export function validateContact(draft: ContactDraft): {
  contact?: JobContact;
  error?: string;
} {
  const parsed = jobContactSchema.safeParse({
    ...draft,
    name: draft.name.trim(),
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? 'Invalid contact.' };
  return { contact: parsed.data };
}

export function replaceContact(
  contacts: readonly JobContact[],
  contact: JobContact,
  editingId?: string,
): JobContact[] {
  if (editingId === undefined) {
    if (contacts.length >= MAX_CONTACTS)
      throw new Error(
        `A job can have at most ${String(MAX_CONTACTS)} contacts.`,
      );
    return [...contacts, contact];
  }
  return contacts.map((existing) =>
    existing.id === editingId
      ? { ...contact, id: editingId, created_at: existing.created_at }
      : existing,
  );
}
