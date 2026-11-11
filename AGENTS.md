# AGENTS.md

This file provides guidance when working in this repository.

---

## Status

This repo is a standalone WXT Manifest V3 TypeScript extension. It is the **entire job tracker**: capture, local storage, lifecycle tracking, a full-tab jobs UI, and dashboard/analytics — no login, no backend, no network calls of any kind. It replaces what used to be a thin capture tool that posted to the `job-tracker-nextjs` API; that API, its Postgres database, and Authentik OAuth are no longer used by this extension at all.

Current foundation:

- WXT project at the repo root. Entrypoints: `background`, `popup`, `sidepanel`, `options`, `app`, and two runtime-only content scripts, `content` and `template-picker.content`.
- **Capture surface**: clicking the toolbar action opens the **side panel**, not a popup. `wxt.config.ts` strips WXT's automatic `default_popup` in a `build:manifestGenerated` hook, and `entrypoints/sidepanel/` hosts `popup.html` in an iframe that reloads when the active tab changes or finishes loading. So "popup" code (`entrypoints/popup/main.ts`, `src/lib/popup*.ts`) is the capture UI running inside the side panel.
- **Storage**: Dexie/IndexedDB (`src/lib/db/schema.ts`, `src/lib/db/jobsRepo.ts`). Tables: `jobs`, holding the scrape-payload fields plus tracker-lifecycle fields (interview stage, priority, notes, resume version, contacts, soft delete); `settings`; and `templates`. Schema changes need a new `this.version(n)` (with an `.upgrade()` for data migrations); never edit an existing version. No separate backend, no `user_job_state` overlay; there is exactly one local owner.
- **Dedup** happens locally in `jobsRepo.upsertJob()`: exact match on `(source_platform, external_job_id)`, then a bounded fuzzy `(company_name, job_title)` match within a 7-day window — the same two-layer rule the old `POST /api/scrape` handler used to enforce server-side.
- **Messaging**: every message between the UI pages and the background is a Zod discriminated union in `src/lib/messages.ts`. Requests include `EXTRACT_ACTIVE_TAB`, `SAVE_JOB_LOCAL`, `GET_SETTINGS` and `SAVE_SETTINGS`, the popup-draft messages, `START_TEMPLATE_PICKER`, and `SAVE_SITE_TEMPLATE`. Each has a `*_RESULT` response, plus a shared `ERROR`. Add new messages there and validate on both sides.
- **Settings** live in the Dexie `settings` table (key `extension`) via `src/lib/settings.ts`: `autoDetect` and `autoDownloadTemplates`. No API base URL, no OAuth client settings or tokens. `chrome.storage.local` holds only the capture UI's unsaved drafts (`src/lib/popupDraft.ts`).
- The full-tab `entrypoints/app/` page (Preact + [htm](https://github.com/developit/htm), hash-routed in `src/app/router.ts`) is the actual tracker: Dashboard, Jobs List, Job Detail, Add/Edit, Companies, Analytics, Settings. htm (not JSX/TSX) was chosen specifically so this code stays covered by the project's `files: ['**/*.ts']` ESLint config. View logic that needs testing is split into plain `*Model.ts` modules next to the views.
- Dashboard/analytics aggregation (`src/lib/analytics/`) is plain array/Map reduction over the in-memory job set — modeled on (not ported from) the old Next.js app's `/api/stats` and `/api/analytics/*` SQL routes, since that logic doesn't carry over from Postgres and extension-scale data (hundreds to low thousands of rows) makes in-memory computation the right call.
- Hand-rolled inline-SVG chart components (`src/app/charts/`) — no charting library dependency.
- Starter HTML fixtures live under `fixtures/html/`.

Build output is generated under `.output/` and should not be treated as source.

Full-dataset JSON export/import (`src/lib/db/backup.ts`) is the backup path now that storage is local-only — IndexedDB does not sync across devices or survive a browser profile wipe. It covers jobs, contacts, settings, and site templates, versioned and Zod-validated on import (merge or replace).

---

## Page extraction (two-step injection)

`chrome.scripting.executeScript({ func })` stringifies `func` and runs it without the extension's module scope, so it can't use imports such as `dompurify` or `turndown`. The background (`entrypoints/background.ts`) therefore injects in two steps:

1. Inject the bundled content script by file (`/content-scripts/content.js` or `/content-scripts/template-picker.js`). It parks its entry function on the page's isolated-world `window` under a bridge key (`src/lib/extraction/jobDraftExtractorBridge.ts`, `src/lib/templates/pickerBridge.ts`).
2. Run a small, self-contained `func` in the same tab that reads the function back off `window` and calls it with per-request arguments.

Both content scripts use `registration: 'runtime'` with no `matches`, so they add no host permissions. Any `func` passed to `executeScript` must not reference imports or outer variables; pass data through `args`.

Extraction (`src/lib/extraction/jobDraftExtractor.ts`) combines platform detection (`detectPlatform.ts`), the user's **site templates**, and taxonomy matching.

**Site templates** (`src/lib/templates/`) are user-defined extraction rules matched by hostname and path pattern (`engine.ts`). They are created with the in-page element picker (`picker.ts`, injected via `START_TEMPLATE_PICKER`), stored in the Dexie `templates` table (`repo.ts`), and validated by `schema.ts`. A matching template marks a URL as trusted. Even so, saving the job and downloading its Markdown (`src/lib/markdownExport.ts`) happen automatically only when `autoDownloadTemplates` is on; otherwise the user reviews the fields and saves.

---

## Common Commands

```bash
npm run dev
npm run quality
npm run build
npm run zip
```

`npm run quality` runs Prettier check, ESLint, TypeScript compile, Vitest, and WXT build. CI (`.github/workflows/quality.yml`, Node 24) runs `npm ci` then `npm run quality` on every PR and push to `main`.

Individual steps: `npm run lint`, `npm run compile`, `npm run format` (writes), `npm test`.

Run one test file, or tests matching a name:

```bash
npx vitest run src/lib/db/jobsRepo.test.ts
npx vitest run -t "dedup"
```

Tests are colocated as `src/**/*.test.ts` and run in the Node environment (`vitest.config.ts`). IndexedDB tests import `fake-indexeddb/auto`; browser APIs are mocked (see `src/lib/background.test.ts`).

No environment variables are required to build or run this extension — it makes no network requests. (`.env.example`/`.env.local` are leftovers from the pre-standalone architecture and can be ignored; nothing in the extension reads them anymore.)

---

## Taxonomies (never "tags")

`skills`, `software`, `certifications`, and `keywords` are four independent, category-owned arrays — there is no generic tags field anywhere in the extension. The extension derives low-confidence matches from the selected sanitized `job_description` using the checked-in canonical catalog (`src/lib/extraction/taxonomyCatalog.ts`, generated from the backend's `nlp-extract.ts` via `npm run sync:catalog`; `CATALOG_HASH`/`CATALOG_VERSION` are verified by tests, no runtime API dependence — this is a build-time sync script, not a network call at runtime). The script's default source path is `../job-tracker-nextjs/src/lib/nlp-extract.ts`, which doesn't exist from this checkout, so pass the path explicitly: `npm run sync:catalog -- ../job_tracker/job-tracker-nextjs/src/lib/nlp-extract.ts`. Credentials stay in `certifications`, named tools/platforms in `software`, capabilities/methods in `skills`, and contextual labels (e.g. `remote`) in `keywords`, which may deliberately repeat a skill. Precedence per category: structured provider values first (e.g. Dice skills section, Lever department), then description-derived matches appended; case-insensitive dedup and the 100-entry cap apply within a category only, never across categories, and empty arrays are omitted from stored records. Re-extract merges per category instead of overwriting user edits.

**JSON-LD export mapping (reviewed):** `skills` → JobPosting `skills` (string array); `certifications` → `qualifications` as `EducationalOccupationalCredential` objects; `software` and `keywords` are explicitly omitted (JobPosting has no faithful property for them) and are never silently serialized as `skills`.

**Salary:** annual salaries are integer cents (`salary_min`/`salary_max`); hourly rates are decimal dollars (`hourly_rate_min`/`hourly_rate_max`), with `salary_type: 'annual' | 'hourly'`. When unsure how to parse, store `salary_text` and omit numeric fields. Analytics annualizes hourly rates as `rate × 2080 × 100` when summarizing salary by job type/experience level.

---

## Security Boundaries

- Use `activeTab` + user-triggered script execution for page reads. The manifest requests only `activeTab`, `scripting`, and `storage` — no host permissions, no `identity` permission (there is no OAuth flow to support).
- Render scraped values as text, never as HTML.
- Do not execute remote code or page-provided scripts.
- Keep extension settings and stored job records out of logs unless redacted.
- No data leaves the browser: there is no backend to send it to. Data leaves the extension only as files the user downloads: the full-dataset export (`src/lib/db/backup.ts`) and per-job Markdown (`src/lib/markdownExport.ts`). Both are triggered by the user, or for Markdown, by a matched template when the user has turned on `autoDownloadTemplates`.

---

## Workspace Context

This repo is related to the `job_tracker` workspace at `../job_tracker/`; see `../job_tracker/AGENTS.md` for the cross-project picture — note that this extension's shift to standalone (no backend, no OAuth) supersedes the _use_ of that workspace's Next.js/Postgres/Authentik architecture for job tracking, without those repos being edited. Cross-project design docs, ADRs, and per-project task boards live in the shared workspace vault at `../job_tracker/.obsidian/`.

This repo also has its **own local, repo-scoped Obsidian vault** at `./vault/` for day-to-day task tracking specific to this extension. It is intentionally **not committed to git** (`vault/` is gitignored) — it is local working memory, not a project deliverable. Cross-project decisions and anything meant to be durable/shared still belong in the workspace vault at `../job_tracker/.obsidian/`, not here.

`CLAUDE.md` carries the same guidance for Claude Code; keep the two in sync when changing either.
