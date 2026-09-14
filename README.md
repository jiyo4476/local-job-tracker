# Local Job Tracker

[![Quality](https://github.com/jiyo4476/local-job-tracker/actions/workflows/quality.yml/badge.svg)](https://github.com/jiyo4476/local-job-tracker/actions/workflows/quality.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: Active Development](https://img.shields.io/badge/status-active%20development-orange)

A local-only Chrome extension for tracking job applications: capture a posting from any job board with one click, follow it through the interview pipeline, and see the whole search on a built-in dashboard — no account, no server, no data ever leaving the browser.

## Why this exists

Job hunting generates a lot of scattered state: postings across a dozen sites, notes in random docs, application statuses only you remember. This extension collapses that into one local tool: capture the posting where you found it, and manage the rest — status, notes, contacts, resume version, analytics — in a full-tab app that lives entirely in your browser's IndexedDB.

## Features

- **One-click capture** from the active tab (popup or side panel) — pulls title, company, location, salary, and description straight from the page via a user-triggered content-script read, no background scraping.
- **Reusable site templates** — teach the extension a site's DOM layout once with an interactive element picker, and it reuses that template on future visits to the same host, including list-style postings with multiple "active" items.
- **Local dedup** — exact match on `(platform, external job id)`, plus a bounded fuzzy match on `(company, title)` within a 7-day window, so re-capturing the same posting updates it instead of duplicating it.
- **Full lifecycle tracking** — interview stage (`applied` → `phone screen` → `onsite` → `offer`/`rejected`), priority, notes, resume version, and per-job contacts.
- **Taxonomy extraction** — derives `skills`, `software`, `certifications`, and `keywords` as four independently-owned categories from the job description against a checked-in canonical catalog, instead of dumping everything into a generic "tags" field.
- **Dashboard & analytics** — hand-rolled inline-SVG charts (bar/line/donut, no charting library) over platform breakdown, remote-vs-onsite trend, and salary-by-type, computed with plain array/Map reduction over the in-memory job set.
- **Backup & restore** — full-dataset JSON export/import (merge or replace) covering jobs, contacts, settings, and site templates, versioned and Zod-validated on the way back in.
- **Companies view** — jobs rolled up by employer for a quick per-company view of your pipeline.

## Design decisions

This started as a thin capture tool that POSTed scraped postings to a companion Next.js API backed by Postgres, with OAuth2/OIDC for auth. It was rebuilt into a fully standalone extension — no login, no backend, no network calls of any kind.

**Why drop the backend:** a personal job tracker doesn't need multi-user auth, a hosted database, or an API surface to defend — those add real operational and security overhead (token handling, a server to keep patched, a Postgres instance to run) for a tool with exactly one user and no sync requirement across devices. Moving all state into IndexedDB removed that entire layer while keeping the same data model: the old backend's server-side dedup logic and `jobs`/`user_job_state` split became a single local table with the lifecycle fields folded in, since there's only ever one owner. The trade-off is explicit and accepted: data lives in one browser profile, so full-dataset export/import is the backup story rather than automatic cross-device sync.

**Why a hand-rolled analytics layer instead of reusing the old backend's SQL:** the aggregation logic (platform breakdown, remote/onsite trend, salary-by-type) is _modeled on_ the previous Postgres queries but re-implemented as plain array/Map reduction, since extension-scale data (hundreds to low thousands of rows) makes in-memory computation the right call — no SQL engine to bring along for that volume.

**Why [htm](https://github.com/developit/htm) instead of JSX/TSX for the UI:** it keeps the tracker UI (Preact + htm, hash-routed) covered by the project's plain `**/*.ts` ESLint/TypeScript config without a JSX toolchain.

## Tech stack

| Layer               | Choice                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| Extension framework | [WXT](https://wxt.dev/) (Manifest V3)                                   |
| UI                  | Preact + [htm](https://github.com/developit/htm), hash-routed, no JSX   |
| Storage             | Dexie (IndexedDB)                                                       |
| Validation          | Zod, at every storage and message boundary                              |
| Sanitization        | DOMPurify — scraped HTML is rendered as text, never injected raw        |
| Testing             | Vitest + fake-indexeddb + jsdom                                         |
| Tooling             | TypeScript (strict), ESLint, Prettier                                   |
| CI                  | GitHub Actions — format check, lint, typecheck, test, build on every PR |

## Architecture

```
Job board tab (LinkedIn, Indeed, Lever, ...)
        │  user clicks "Save" (popup or side panel)
        ▼
content script (chrome.scripting.executeScript, activeTab only)
        │  extracts fields via a site template or generic fallback
        ▼
background service worker
        │  runs taxonomy extraction if description present but skills are empty
        ▼
Dexie / IndexedDB  ──▶  jobs · settings · templates
        ▲
        │  read/write
        ▼
Full-tab app (entrypoints/app) — Dashboard · Jobs List · Job Detail · Companies · Analytics · Settings
```

Nothing in this diagram talks to the network. The only way data leaves the extension is an explicit, user-triggered JSON export.

## Getting started

> **Not yet published to the Chrome Web Store** — this is under active development and not yet polished for outside installs. To run it locally:

```bash
npm install
npm run dev       # WXT dev server with hot reload
```

To build and load as an unpacked extension:

```bash
npm run build
```

Then in Chrome: `chrome://extensions` → enable Developer Mode → **Load unpacked** → select `.output/chrome-mv3`.

### Quality checks

```bash
npm run quality   # format check, lint, typecheck, vitest, build — the same gate CI runs
```

Individual checks (`format:check`, `lint`, `compile`, `test`, `build`) are also available as their own npm scripts.

## Security & privacy boundaries

- Manifest permissions are limited to `activeTab`, `scripting`, `storage`, and `sidePanel` — no host permissions, no `identity` permission, no OAuth.
- Page content is only read when the user explicitly triggers capture; nothing runs automatically in the background against pages you haven't asked it to read.
- Scraped values are rendered as text, never as HTML.
- No remote code execution, no page-provided scripts are ever run.
- No data leaves the browser. Full-dataset export is the only path out, and only when the user triggers it.

## Roadmap

- [ ] Extension icons (currently using the Chrome placeholder)
- [ ] Chrome Web Store listing
- [ ] Broader site-template coverage / community-shareable templates
- [ ] Screenshots and a short demo GIF here

## License

MIT — see [LICENSE](LICENSE).
