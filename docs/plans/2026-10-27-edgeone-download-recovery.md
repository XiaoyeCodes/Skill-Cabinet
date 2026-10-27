# EdgeOne download recovery implementation plan

**Goal:** Load all 26 skills and 7 projects on the existing free EdgeOne project without restarting successful downloads after a network interruption.

**Architecture:** Keep the existing atomic IndexedDB update and local-edit protection. Split public deployment archives into 2 MB parts, verify each part against build-generated SHA-256 values, and retain verified bytes in origin-scoped Cache Storage. Retry only transient failures, using an inactivity timeout that resets while data arrives. Continue validating the original complete ZIP and skill fingerprint before changing the library.

**Tech stack:** Native browser ES modules, Cache Storage, Fetch streams, IndexedDB, Node.js build and test runner, Playwright.

1. Reproduce failures in `tests/deployment.test.mjs` and `tests/repository.test.mjs`: interrupted parts, reload recovery, corrupt cache, body stalls, and unchanged local data after failed downloads.
2. Update `scripts/build-site.mjs`: split files above 2,000,000 bytes, emit part hashes and original archive sizes only in generated hosting metadata. Preserve tracked original archives and the EdgeOne build command/output.
3. Update `dist/hosting.js` and `dist/repository-library.js`: bounded streaming reads, transient retries, optional verified cache, legacy 20 MB part compatibility, byte progress, and atomic import.
4. Update `dist/app.js` download status and `docs/edgeone-deployment.md`. Test the real build and all archives; check a fresh browser, reload, interruption recovery, 26 skills, 7 projects, and complete export.
5. Commit and push to the existing GitHub `main`. Reuse `makers-jlmfevuhy66p`; confirm the automatically deployed commit and a newly generated authenticated preview. No paid services or new EdgeOne project.

Online verification requires the account owner's existing console session or current complete preview URL. Keep temporary preview credentials out of Git and logs.
