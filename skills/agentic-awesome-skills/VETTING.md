# Skill vetting record

- Source: sickn33/agentic-awesome-skills, commit `0f1aef1eb17611d3219c713ea615ecdc7080896c`, package version 20.1.0.
- Scope: archived reference data only. No host skill installation, dependency installation, upstream script execution, or account configuration.
- Integrity: all 8,979 blobs under upstream `skills/` were read and verified against their Git blob SHA; all 2,872 catalog paths resolve to an archived `SKILL.md`. Original bytes and per-file license notices are retained.
- Packaging: complete skills live in the nested tar.xz archive; every source file has Git and SHA-256 hashes in its `UPSTREAM_FILES.json`. Solid XZ compression keeps the complete snapshot within the 45 MiB sync limit. Outer ZIP imports as one collection within the existing application limits.
- Static review: each UTF-8 source was scanned for credential/session references, remote shell examples, dynamic execution, and elevated/destructive command examples. Matches occur in legitimate security, infrastructure and integration guides as well as executable examples. Counts and example paths are in `CABINET_SOURCE.json`; these checks do not establish that every skill is safe to run.
- Permissions: reading and exporting this collection needs no external service or credentials. Individual skills can require local file access, dependencies, API credentials, browser sessions, or system access. Inspect the selected skill and its full attachments before use.
- Aliases: upstream `skills/pdf` points to `pdf-official`, and `skills/xlsx` to `xlsx-official`. Both targets are absent from this upstream commit; these are broken upstream aliases, not additional skills. Original link text and symlink metadata are retained in the tar archive. Obtain those document skills from their official source if needed. On Windows, these aliases can be skipped when extracting.
- Licensing: preserve `LICENSE`, `LICENSE-CONTENT`, `docs/sources/` and each skill's own license. Repository MIT code licensing does not override third-party content licenses.
- Verdict: suitable for inert catalog storage and export. Individual skills are not certified or enabled by collecting this archive.
