import { z } from 'zod';
import { getDb } from './db/schema';

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

let settingsMutationQueue: Promise<void> = Promise.resolve();

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await getDb().settings.get('extension');
  return extensionSettingsSchema.parse(stored ?? {});
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
      await getDb().settings.put({ key: 'extension', ...result });
    });
  settingsMutationQueue = operation.catch(() => undefined);
  await operation;
  if (!result) throw new Error('Settings mutation did not produce a result.');
  return result;
}

export function toPublicSettings(settings: ExtensionSettings): PublicSettings {
  return publicSettingsSchema.parse(settings);
}
