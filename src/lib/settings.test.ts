import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDbForTests } from './db/schema';
import { getSettings, saveSettings } from './settings';

let dbId = 0;

beforeEach(() => {
  dbId += 1;
  resetDbForTests(`settings-test-${String(dbId)}`);
});

describe('local settings repository', () => {
  it('returns defaults before a settings record exists', async () => {
    await expect(getSettings()).resolves.toEqual({ autoDetect: true });
  });

  it('persists settings in the Dexie settings table', async () => {
    await expect(saveSettings({ autoDetect: false })).resolves.toEqual({
      autoDetect: false,
    });
    await expect(getSettings()).resolves.toEqual({ autoDetect: false });
  });

  it('serializes concurrent partial updates without losing state', async () => {
    await Promise.all([saveSettings({ autoDetect: false }), saveSettings({})]);
    await expect(getSettings()).resolves.toEqual({ autoDetect: false });
  });
});
