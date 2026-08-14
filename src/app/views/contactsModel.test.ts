import { describe, expect, it } from 'vitest';
import type { JobContact } from '../../lib/db/schema';
import { MAX_CONTACTS, replaceContact, validateContact } from './contactsModel';

describe('contacts model', () => {
  it('rejects invalid contact fields and accepts a valid HTTP LinkedIn URL', () => {
    expect(validateContact({ name: '', email: 'bad' }).error).toBeTruthy();
    expect(
      validateContact({
        name: 'Ada',
        linkedin_url: 'https://linkedin.com/in/ada',
      }).contact?.name,
    ).toBe('Ada');
  });

  it('edits without changing stable identity and enforces the storage bound', () => {
    const original: JobContact = {
      id: crypto.randomUUID(),
      name: 'Ada',
      created_at: '2026-08-01T00:00:00.000Z',
    };
    const replacement: JobContact = {
      id: crypto.randomUUID(),
      name: 'Grace',
      created_at: '2026-08-02T00:00:00.000Z',
    };
    expect(replaceContact([original], replacement, original.id)[0]).toEqual({
      ...replacement,
      id: original.id,
      created_at: original.created_at,
    });
    expect(() =>
      replaceContact(
        Array.from({ length: MAX_CONTACTS }, () => original),
        replacement,
      ),
    ).toThrow(/at most/);
  });
});
