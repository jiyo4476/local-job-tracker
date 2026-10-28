# AGENTS.md

This file provides guidance when working in this repository.

---

## Status

This repo is a standalone WXT Manifest V3 TypeScript extension. It is the **entire job tracker**: capture, local storage, lifecycle tracking, a full-tab jobs UI, and dashboard/analytics — no login, no backend, no network calls of any kind. It replaces what used to be a thin capture tool that posted to the `job-tracker-nextjs` API; that API, its Postgres database, and Authentik OAuth are no longer used by this extension at all.

Current foundation:

- WXT project at the repo root with `popup`, `options`, `background`, `content`, and `app` entrypoints.
- **Storage**: Dexie/IndexedDB (`src/lib/db/schema.ts`, `src/lib/db/jobsRepo.ts`) — one `jobs` table holding the scrape-payload fields plus tracker-lifecycle fields (interview stage, priority, notes, resume version, soft delete). No separate backend, no `user_job_state` overlay; there is exactly one local owner.
- **Dedup** happens locally in `jobsRepo.upsertJob()`: exact match on `(source_platform, external_job_id)`, then a bounded fuzzy `(company_name, job_title)` match within a 7-day window — the same two-layer rule the old `POST /api/scrape` handler used to enforce server-side.
- Runtime message validation with Zod (`src/lib/messages.ts`) — simplified to a local `SAVE_JOB` round trip; no OAuth or API-error message types.
- User-triggered active-tab extraction through `chrome.scripting.executeScript` — unchanged from the original capture tool.
- Settings persisted in `chrome.storage.local` — just an `autoDetect` boolean now; no API base URL, no OAuth client settings/tokens.
- The popup stays a lightweight capture-and-review surface; a new full-tab `entrypoints/app/` page (Preact + [htm](https://github.com/developit/htm), hash-routed) is the actual tracker: Dashboard, Jobs List, Job Detail, Add/Edit, Companies, Analytics. htm (not JSX/TSX) was chosen specifically so this code stays covered by the project's `files: ['**/*.ts']` ESLint config.
- Dashboard/analytics aggregation (`src/lib/analytics/`) is plain array/Map reduction over the in-memory job set — modeled on (not ported from) the old Next.js app's `/api/stats` and `/api/analytics/*` SQL routes, since that logic doesn't carry over from Postgres and extension-scale data (hundreds to low thousands of rows) makes in-memory computation the right call.
- Hand-rolled inline-SVG chart components (`src/app/charts/`) — no charting library dependency.
- Starter HTML fixtures live under `fixtures/html/`.
- Quality command: `npm run quality`.

Build output is generated under `.output/` and should not be treated as source.

Full-dataset JSON export/import (`src/lib/db/backup.ts`) is the backup path now that storage is local-only — IndexedDB does not sync across devices or survive a browser profile wipe. It covers jobs, contacts, settings, and site templates, versioned and Zod-validated on import (merge or replace).

---

## Common Commands

```bash
npm run dev
npm run quality
npm run build
npm run zip
```

`npm run quality` runs Prettier check, ESLint, TypeScript compile, Vitest, and WXT build.

No environment variables are required to build or run this extension — it makes no network requests. (`.env.example`/`.env.local` are leftovers from the pre-standalone architecture and can be ignored; nothing in the extension reads them anymore.)

---

## Taxonomies (never "tags")

`skills`, `software`, `certifications`, and `keywords` are four independent, category-owned arrays — there is no generic tags field anywhere in the extension. The extension derives low-confidence matches from the selected sanitized `job_description` using the checked-in canonical catalog (`src/lib/extraction/taxonomyCatalog.ts`, generated from the backend's `nlp-extract.ts` via `npm run sync:catalog`; `CATALOG_HASH`/`CATALOG_VERSION` are verified by tests, no runtime API dependence — this is a build-time sync script, not a network call at runtime). Credentials stay in `certifications`, named tools/platforms in `software`, capabilities/methods in `skills`, and contextual labels (e.g. `remote`) in `keywords`, which may deliberately repeat a skill. Precedence per category: structured provider values first (e.g. Dice skills section, Lever department), then description-derived matches appended; case-insensitive dedup and the 100-entry cap apply within a category only, never across categories, and empty arrays are omitted from stored records. Re-extract merges per category instead of overwriting user edits.

**JSON-LD export mapping (reviewed):** `skills` → JobPosting `skills` (string array); `certifications` → `qualifications` as `EducationalOccupationalCredential` objects; `software` and `keywords` are explicitly omitted (JobPosting has no faithful property for them) and are never silently serialized as `skills`.

**Salary:** annual salaries are integer cents (`salary_min`/`salary_max`); hourly rates are decimal dollars (`hourly_rate_min`/`hourly_rate_max`), with `salary_type: 'annual' | 'hourly'`. When unsure how to parse, store `salary_text` and omit numeric fields. Analytics annualizes hourly rates as `rate × 2080 × 100` when summarizing salary by job type/experience level.

---

## Security Boundaries

- Use `activeTab` + user-triggered script execution for page reads. The manifest requests only `activeTab`, `scripting`, `storage`, and `sidePanel` up front — no install-time host permissions, no `identity` permission (there is no OAuth flow to support). When the side panel outlives the tab that granted `activeTab`, `src/lib/pageAccess.ts` asks (from a user click) for the focused page only: optional `tabs` if its URL is hidden, then that single origin via `optional_host_permissions`. Never request broader origins.
- Render scraped values as text, never as HTML.
- Do not execute remote code or page-provided scripts.
- Keep extension settings and stored job records out of logs unless redacted.
- No data leaves the browser: there is no backend to send it to. Full-dataset export (`src/lib/db/backup.ts`) is the only way data leaves the extension, and only when the user explicitly triggers it.

---

## Workspace Context

This repo is one of three in the `job_tracker` workspace; see `../AGENTS.md` for the cross-project picture — note that this extension's shift to standalone (no backend, no OAuth) supersedes the _use_ of that workspace's Next.js/Postgres/Authentik architecture for job tracking, without those repos being edited. Cross-project design docs, ADRs, and per-project task boards live in the shared workspace vault at `../.obsidian/`.

This repo also has its **own local, repo-scoped Obsidian vault** at `./vault/` for day-to-day task tracking specific to this extension. It is intentionally **not committed to git** (`vault/` is gitignored) — it is local working memory, not a project deliverable. Cross-project decisions and anything meant to be durable/shared still belong in the workspace vault at `../.obsidian/`, not here.
