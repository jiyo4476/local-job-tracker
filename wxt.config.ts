import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: () => ({
    name: 'Job Tracker Capture',
    description:
      'Review and save visible job postings into your local Job Tracker — no login, no server.',
    version: '0.1.0',
    permissions: ['activeTab', 'scripting', 'storage'],
    action: {
      default_title: 'Save job to Job Tracker',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
  }),
});
