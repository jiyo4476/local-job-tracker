import { useState } from 'preact/hooks';

import { html } from '../html';
import {
  createBackup,
  parseBackupJson,
  restoreBackup,
  serializeBackup,
  type ImportMode,
} from '../../lib/db/backup';

const MAX_BACKUP_FILE_BYTES = 25 * 1024 * 1024;

interface Feedback {
  kind: 'success' | 'error';
  text: string;
}

export function SettingsView() {
  const [mode, setMode] = useState<ImportMode>('merge');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);

  const exportDataset = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const backup = await createBackup();
      const url = URL.createObjectURL(
        new Blob([serializeBackup(backup)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `job-tracker-backup-${backup.exported_at.slice(0, 10)}.json`;
      anchor.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1_000);
      setFeedback({
        kind: 'success',
        text: `Exported ${String(backup.jobs.length)} jobs.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Export failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  const importDataset = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setBusy(true);
    setFeedback(null);
    try {
      if (file.size > MAX_BACKUP_FILE_BYTES) {
        throw new Error('Backup is larger than the 25 MB import limit.');
      }
      const backup = parseBackupJson(await file.text());
      if (
        mode === 'replace' &&
        !window.confirm(
          `Replace all local data with this validated backup (${String(backup.jobs.length)} jobs)? This cannot be undone.`,
        )
      ) {
        setFeedback({ kind: 'success', text: 'Import cancelled.' });
        return;
      }
      const result = await restoreBackup(backup, mode);
      setFeedback({
        kind: 'success',
        text: `Import complete: ${String(result.imported)} imported, ${String(result.skipped)} skipped.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Import failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  return html`
    <div class="settings-view">
      <h2>Settings</h2>
      <section class="backup-panel">
        <h3>Backup and restore</h3>
        <p>
          Jobs live only in this browser profile. Export a JSON backup regularly
          and store it somewhere durable. Backups contain job descriptions,
          notes, contacts, and salary details in readable text; protect them as
          sensitive files.
        </p>
        <button type="button" disabled=${busy} onClick=${exportDataset}>
          Export full dataset
        </button>
        <fieldset disabled=${busy}>
          <legend>Import behavior</legend>
          <label>
            <input
              type="radio"
              name="mode"
              value="merge"
              checked=${mode === 'merge'}
              onChange=${() => {
                setMode('merge');
              }}
            />
            Merge: add jobs that are not already present
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              value="replace"
              checked=${mode === 'replace'}
              onChange=${() => {
                setMode('replace');
              }}
            />
            Replace: erase local jobs after the entire backup validates
          </label>
        </fieldset>
        <label class="file-button">
          Import JSON backup
          <input
            type="file"
            accept="application/json,.json"
            disabled=${busy}
            onChange=${importDataset}
          />
        </label>
        ${
          feedback
            ? html`<p
                class="status-message ${feedback.kind}"
                role=${feedback.kind === 'error' ? 'alert' : 'status'}
              >
                ${feedback.text}
              </p>`
            : null
        }
      </section>
    </div>
  `;
}
