# Sync visibility and shared workspace cloud sync Implementation Plan

> Execute and verify each task in the current checkout; preserve user data and existing conflict protections.

**Goal:** Make both workspaces' saved, pending, syncing, confirmed, failed and conflicting changes visible and synchronize project collections alongside Skills.

**Architecture:** Extend the existing version 1 manifest with an optional validated project map, retaining old manifests. Use the existing non-forced Git commit for both collections. Project state and its confirmed baseline commit in one localStorage write; skill records and their baseline retain the existing IndexedDB transaction. Never advance a collection's baseline before its local apply succeeds. Show comparisons against the last confirmed baseline, including pending deletions, rather than treating a saved record as synced.

**Tech Stack:** Native ES modules, IndexedDB, localStorage, GitHub REST/Git Data API, node:test and Playwright.

## Decisions and alternatives

- Use one existing cloud-sync connection for both spaces. A separate project sync button/connection would obscure partial success; lights alone would leave projects without any cloud backup.
- Keep the established warm paper design; small labeled status dots beside categories and in workspace navigation. Gray = local only, amber = pending, blue = syncing, green = confirmed against the last baseline, red = failed/conflict. Color always has a text equivalent.
- The checkout refresh button explicitly refreshes local files and reports its result. A separate cloud button opens settings when disconnected or runs actual cloud sync when connected.
- GitHub project collection edits affect the user's bookmarks, never the source repositories. New devices import cloud projects; deletions remain tombstones. Conflicts require explicit local/cloud choice and stale choices are rejected.
- Do not clear browser storage or use/read the user's token in tests. Do not publish source changes without a request.

## Task 1: Project synchronization

Files: `dist/github-projects.js`, `dist/project-sync.js`, `dist/github-client.js`, `dist/sync-engine.js`, `tests/sync.test.mjs`.

Add validated optional project entries, canonical fingerprints, three-way merge and deletion/conflict rules. Persist projects and baseline atomically; retain a local recovery snapshot. Guard concurrent local edits before and after upload. Preserve project maps when syncing Skills without a project store. Verify two devices, edits, deletes, fresh seeds, offline, concurrent changes, failure and repeated no-op sync.

## Task 2: Status and actionable controls

Files: `dist/sync-status.js`, `dist/sync-ui.js`, `dist/app.js`, `dist/github-workspace.js`, `dist/index.html`, `dist/sync.css`, `dist/github-workspace.css`.

Compute item statuses from content fingerprints and repo-scoped confirmed baselines, with unknown/local-only status before confirmation. Keep both workspaces' cloud controls visible, report pending deletions and last sync, give explicit progress and manual-operation results. Retry queued edits after active uploads; prevent a stale status computation from replacing a newer one. Verify rename changes the ZIP metadata and remote name, while favorites and project edits mark the appropriate items pending.

## Task 3: Verification and documentation

Files: `README.md`, test suite, isolated browser verification scripts outside the repository.

Run `npm.cmd test`, then browser checks with mocked GitHub responses for both workspaces, connection validation, manual sync/no-op, offline recovery, conflict resolution, persistent dirty status after reload and mobile layout. Inspect desktop/mobile screenshots. Document local checkout refresh versus actual cloud sync and the meaning of every light. Check the final diff for secrets and unrelated changes.

## Verification completed

- 71 node:test checks passed, including rename ZIP roundtrip, two-device project sync, concurrent edits, deletion conflicts, independent local-collection failure recovery and no-op synchronization.
- 24 isolated browser checks passed using a mock GitHub repository: real edit/add/remove controls, gray/amber/blue/green/red indicators, manual feedback, automated uploads, offline retry, reload persistence, explicit conflict resolution and 390px mobile layout.
- Desktop and mobile screenshots inspected; no browser JavaScript errors or horizontal mobile overflow. Local server responds HTTP 200. Existing browser records and real remote data were not altered by verification.
