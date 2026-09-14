import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: () => ({
    name: 'Local Job Tracker',
    description:
      'Review and save visible job postings into your Local Job Tracker — no login, no server.',
    version: '0.1.0',
    permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
    action: {
      default_title: 'Save job to Local Job Tracker',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
  }),
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // WXT automatically assigns popup.html to the action whenever a popup
      // entrypoint exists. The capture UI remains available through the
      // side-panel shell, so the action must be handled by background.ts.
      const manifestRecord = manifest as unknown as Record<string, unknown>;
      const action = manifestRecord.action;
      if (action && typeof action === 'object') {
        Reflect.deleteProperty(action, 'default_popup');
      }
    },
  },
});
