import { browser } from 'wxt/browser';
import { z } from 'zod';

export const extensionSettingsSchema = z.object({
  autoDetect: z.boolean().default(true),
});

export const extensionSettingsUpdateSchema = extensionSettingsSchema.partial();

export const publicSettingsSchema = extensionSettingsSchema.pick({
  autoDetect: true,
});

export const publicSettingsUpdateSchema = publicSettingsSchema.partial();

export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;
export type ExtensionSettingsUpdate = z.infer<
  typeof extensionSettingsUpdateSchema
>;
export type PublicSettings = z.infer<typeof publicSettingsSchema>;
export type PublicSettingsUpdate = z.infer<typeof publicSettingsUpdateSchema>;

const STORAGE_KEY = 'jobTracker.settings';
let settingsMutationQueue: Promise<void> = Promise.resolve();

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return extensionSettingsSchema.parse(result[STORAGE_KEY] ?? {});
}

export async function saveSettings(
  settings: ExtensionSettingsUpdate,
): Promise<ExtensionSettings> {
  let result: ExtensionSettings | undefined;
  const operation = settingsMutationQueue
    .catch(() => undefined)
    .then(async () => {
      const current = await getSettings();
      result = extensionSettingsSchema.parse({ ...current, ...settings });
      await browser.storage.local.set({ [STORAGE_KEY]: result });
    });
  settingsMutationQueue = operation.catch(() => undefined);
  await operation;
  if (!result) throw new Error('Settings mutation did not produce a result.');
  return result;
}

export function toPublicSettings(settings: ExtensionSettings): PublicSettings {
  return publicSettingsSchema.parse(settings);
}
