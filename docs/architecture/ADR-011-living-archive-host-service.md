# ADR-011: Living Archive Host Service

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: ADR-013 (library/domain portion)
- Owner: Living Archive
- Decision date: 2026-04-23
- Alpha note: Host mediation applies through Node bridge services. Tauri
  command and desktop-host details do not apply to Alpha.

## Decision

ResonantOS vNext will implement the Living Archive as a **host-mediated core service boundary** backed by the existing Living Archive runtime model:

- `ARCHIVE_CONFIG.json`
- `VAULT_MAP.json`
- markdown wiki pages
- SQLite provenance/activity database

The first host-service surface is:

- archive runtime status
- archive search
- guarded document reads
- intake artifact writes
- ingest request queuing
- review queue reads
- Strategist-owned ingest-review processing into review artifacts
- approved review-artifact promotion into trusted wiki pages
- Strategist chat context retrieval through host-mediated archive search/read
- source folder scanning and version fingerprinting
- library import into managed memory domains
- imported-library registry reads from persisted manifests
- mixed-library classification review artifact generation
- source-version ledger writes for imported libraries
- optional Audio2TOL add-on bridge for session bundle detection and intake queuing

The host service does **not** expose generic trusted wiki writes. Trusted page writes are available only through the Strategist-owned ingest path after ADR-012 approval.

## Why

- The actual Living Archive is not a generic vector database or a chunk store. It is an LLM-maintained wiki with stable page types, provenance, and activity history.
- The vNext shell needs a real memory boundary now, not another synthetic probe-only surface.
- The existing Living Archive implementation already defines the runtime/config model and DB semantics clearly enough to mirror in the Tauri host.
- Direct raw filesystem access from add-ons would violate the archive trust model from ADR-007.

## Primary Source Material

The service design is grounded in the Living Archive prototype implementation and schema docs. The local prototype paths were intentionally removed from this alpha documentation because they are not portable product dependencies.

Reference categories:

- Living Archive runtime resolver
- Living Archive SQLite provenance/activity database
- Living Archive ingest/search/query tools
- Living Archive wiki schema
- Living Archive ingest rules
- Living Archive onboarding notes

Public GitHub trace for this subsystem is currently thin, so the architecture captured in this ADR and the current host implementation are the authoritative reference for v1.

## Rules

- Living Archive runtime must resolve from config, not from hard-coded repo-relative paths.
- Runtime status must surface:
  - config path
  - managed/wiki/data/log/config roots
  - mapped source roots
  - ingest-agent config presence
  - SQLite stats and recent activity when available
- Archive search must operate over the real wiki/source registry, not a fake shell dataset.
- Archive search may return matching imported/intake source excerpts as read-only evidence, but those hits must be clearly labeled as raw source material and must not be treated as trusted promoted wiki pages.
- Guarded document reads must stay inside resolved archive roots.
- Strategist chat may retrieve scoped archive context for a turn, but it must use host-mediated read/search calls and inject compact context into the model prompt rather than granting direct filesystem access.
- Intake writes must land in managed intake roots only.
- Source folders mapped through `VAULT_MAP.json` may be scanned for new or changed files, but scanning does not promote those files into trusted knowledge.
- Source folder scans must fingerprint files and preserve previous hash state so ResonantOS can distinguish new, changed, and unchanged source material.
- Obsidian is optional. An Obsidian vault may be registered as a watched source folder by an add-on, but the same source-folder mechanism must work for normal filesystem folders.
- Library import must write host-owned source metadata. The UI must not be the authority for classification, version history, or canonical source paths.
- Mixed Library imports must create a reviewable classification artifact before any structural reorganisation is allowed.
- Imported libraries must write a source-version ledger so future stronger models can reprocess the original source versions.
- Ingest requests must be queued as reviewable artifacts, not executed as silent background mutations.
- Trusted wiki-page creation/update remains reserved to the Strategist-owned ingest service.
- Promotion from review artifacts into trusted wiki pages must follow ADR-012 rather than forcing blanket human review.
- Promotion must refuse pending, rejected, escalated, or otherwise unapproved review artifacts.
- Promotion may write only supported wiki page types into their schema-defined subdirectories:
  - `summary` to `WIKI/summaries`
  - `entity` to `WIKI/entities`
  - `concept` to `WIKI/concepts`
  - `synthesis` to `WIKI/syntheses`
- Existing trusted wiki pages must be backed up before replacement.
- TOL is not a base Living Archive feature. TOL-specific detection, bundle building, and UI surfaces may appear only through the Audio2TOL add-on boundary.
- Audio2TOL intake, when that add-on is installed and enabled, must preserve source boundaries:
  - raw audio remains the source of truth
  - transcript remains a derived artifact
  - protocol analysis remains an interpretation artifact
  - human directives remain distinct from AI-proposed strategic actions

## Service Surface

### `archive_runtime_status`

Returns the resolved archive runtime plus stats and recent activity.

### `archive_system_memory`

Returns the host-owned System Architecture Memory status defined in `ADR-014`, including generated pages, indexed sources, stale sources, and missing required sources.

### `archive_refresh_system_memory`

Regenerates deterministic ResonantOS architecture memory into `Memory/AI_MEMORY/system` and writes the source-hash manifest into `Memory/AI_MEMORY/provenance/system-memory-manifest.json`.

This command does not require a provider call. It is the minimum reliable architecture memory for Augmentor and the Resonant Engineer Agent before user knowledge intake.

### `archive_search`

Searches:

- wiki pages
- tracked sources

Prefers SQLite-backed search when the DB exists and falls back to wiki-file scanning otherwise.

### `archive_read_document`

Reads a wiki page or tracked source through a guarded path resolver and returns:

- path
- title
- page/source type
- parsed frontmatter
- content

### Strategist Archive Context

The Strategist chat controller may call `archive_search` and `archive_read_document` before a chat completion to retrieve compact memory evidence for the active user turn.

Rules:

- archive context is read-only
- retrieved context is injected into the system prompt for that turn
- retrieved context is not persisted as a user-authored message
- assistant replies must persist lightweight citation metadata for retrieved archive pages so the UI can show which Living Archive pages were used
- user-selected assistant replies may be saved as `chat-insights` intake artifacts and queued for review, but they must not write trusted wiki pages directly
- failed archive retrieval must not block normal chat
- the Strategist must treat retrieved pages as evidence, not as permission to mutate archive knowledge

### `archive_write_intake_artifact`

Writes raw/intake artifacts only into managed intake buckets.

### `archive_request_ingest`

Queues an ingest request into the review area with source path, source type, role, intent, and provenance metadata.

### `archive_scan_source_folders`

Scans configured `raw_sources` and `derived_sources` mappings from `VAULT_MAP.json`.

The scan:

- walks supported source file types in mapped source folders
- fingerprints file content
- records path, absolute path, root role, source type, size, modified time, first seen time, and last seen time
- compares against `DATA/source-watch-index.json`
- reports each file as `new`, `changed`, or `unchanged`
- upserts source rows into the SQLite `sources` table when the archive database exists
- marks changed/new source rows as unprocessed
- does not queue ingest automatically
- does not write trusted wiki pages

This is the deterministic foundation for future automatic folder watching. Background watching should build on this command rather than bypassing it.

### `archive_import_library`

Imports a user-selected folder or Obsidian vault into the managed memory domain structure from ADR-013.

The command:

- validates the requested memory domain and import mode
- preserves the source folder structure
- writes a canonical managed source copy unless the user explicitly chose reference-in-place
- writes first-version source records
- writes an append-only JSONL source-version ledger
- writes an import manifest containing canonicality, metadata standard, Obsidian detection, and source hashes
- returns host-owned classification proposals for Mixed Library imports

`move` import mode is intentionally separate from ordinary settings saves. In the browser-first host it is available only through the guarded `/memory/source/move-preflight`, `/memory/source/move-execute`, and `/memory/source/move-rollback` path. The host must preflight the source, reject broad/system/memory-root paths, preserve folder structure including Obsidian dotfolders and empty folders, require the exact human confirmation phrase, write an append-only JSONL move ledger, register the managed destination as the canonical source, and support rollback from the ledger. Move execution must re-check the source immediately before file mutation and may fall back to copy-and-delete for cross-volume moves such as external drives. Rollback must report file, directory, and source-root cleanup conflicts instead of silently deregistering the moved source. The UI is not allowed to execute a move by merely saving `importMode = move-on-import`.

For `mixed-library`, the command also writes a `library-classification-review` artifact under the library metadata root. This artifact is the authority for first-pass ownership proposals. It explicitly sets `structuralChangesAllowed = false`; any future file move/reorganisation command must require separate human approval, audit logging, and rollback planning.

### `archive_library_classification_review`

Reads a host-owned mixed-library classification review artifact.

The command:

- only opens `library-classification-review` artifacts linked from known imported-library manifests
- rejects paths outside imported-library metadata roots
- returns the preview proposals and summary counters
- does not approve, move, tag, or rewrite source files

### `archive_library_reorganisation_plan`

Writes a plan-only reorganisation artifact from a classification review.

The command:

- writes a proposed source-to-domain movement plan
- writes a rollback-plan artifact
- appends an audit-log event
- explicitly moves zero files
- marks the plan as `requiresApproval = true`
- marks current v1 plans as `preview-only` and `eligibleForExecution = false`

Because mixed-library classification currently previews only the first proposal page, this command must not be used as an execution basis. A future execution command must require full-library classification or explicit paged review completion first.

### `archive_imported_libraries`

Lists imported libraries by reading persisted import manifests from each memory-domain metadata root.

The command:

- returns library identity, domain, import mode, canonical root, original path, file counts, metadata standard, and related manifest paths
- derives the registry from disk so the shell can restart without losing imported-library state
- treats manifests as archive metadata, not trusted wiki pages
- does not rescan source content or queue ingest requests

### `archive_queue_imported_library_ingest`

Queues eligible text records from a known imported-library manifest into the normal Living Archive ingest review queue.

The command:

- accepts only imported-library manifests already registered under Living Archive memory-domain metadata roots
- resolves the manifest through the guarded archive document resolver
- requires both `archive-read` and `archive-intake-write`
- queues text-compatible source records from the managed canonical copy, not from the original external folder
- queues the whole eligible manifest by default; callers may pass a bounded `maxRecords` only for diagnostics or explicit batch tools
- skips unsupported file classes, missing canonical files, already queued sources, and already processed sources
- records provenance with `origin = imported-library`, library identity, manifest path, source id, version id, and original path
- writes review requests only; it does not create or update trusted wiki pages

This command closes the imported-library memory gap: importing a folder makes the sources searchable as raw evidence, while this queue action starts the controlled path that can later produce trusted AI Memory pages through `archive_process_ingest_request`, approval, and `archive_promote_review_artifact`.

### `archive_ai_memory_build_job`

Runs the product-level AI Memory build workflow for an imported library.

The command:

- queues eligible imported-library records through `archive_queue_imported_library_ingest`
- runs a bounded provider-routed maintenance batch
- promotes approved review artifacts that have not already been promoted
- writes a durable job JSON under the review `jobs` root
- returns user-facing progress: records seen, queued this run, processed this run, promoted this run, queue remaining, review counts, errors, and next action
- reports explicit status values such as `running`, `needs-review`, `needs-human-review`, `ready-to-promote`, `attention`, and `complete`

This is the default product path for building AI Memory from an imported library. Lower-level queue/process/approve/promote commands remain available for review desk operations, debugging, and add-on integration, but the user-facing flow should prefer this job command.

The Review Desk may continue an existing durable job by calling this command with the job summary's stored `manifestPath`. Manual continuation is always explicit. Automatic continuation is allowed only when Archive auto-sync is enabled and the job is not blocked by errors, escalated review, or human-review status.

### `archive_ai_memory_build_jobs`

Lists durable AI Memory build job summaries from the review `jobs` root.

The command:

- restores job visibility after app restart
- returns only stable product-facing fields, not the full maintenance payload
- sorts newest jobs first
- lets the Review Desk show build history, current queue pressure, review blockers, promotion counts, errors, and next action

This command does not continue execution by itself. It is the persistence and visibility layer used by the Review Desk `Continue Build` action and by the auto-sync guard that resumes safe `running` or `ready-to-promote` jobs while the app is open.

### Optional Audio2TOL Add-on Bridge

These commands are an interim host-mediated bridge for the future Audio2TOL add-on. They are not part of the base Living Archive user workflow and the shell must expose them only when `addon.audio2tol` is installed and enabled.

### `archive_tol_bundle_candidates`

Detects Audio2TOL sessions from the mapped TOL transcript and analysis folders.

The detector:

- reads session stems from `03_TOL/TOL Transcripts` and `03_TOL/TOL Analysis`
- supports normalized TOL stems such as `2026-04-21-1003`
- maps normalized stems back to recorder stems such as `260421_1003` when possible
- reports raw audio, transcript, analysis, analysis frontmatter, semantic sections, directive counts, and AI-proposed action counts
- does not create trusted knowledge pages

### `archive_build_tol_bundle`

Builds a structured `audio2tol.session` manifest from a detected session and writes it into the managed `tol-bundles` intake bucket.

The bundle includes:

- raw audio path and availability
- transcript path and availability
- analysis path, frontmatter, semantic sections, human directive count, and AI-proposed action count
- processing metadata describing the source detector and timestamp-linking method
- explicit trust-boundary metadata requiring Strategist-owned ingest review before trusted wiki promotion

After writing the manifest, the command queues an ingest request with `sourceType = tol_bundle` and `sourceRole = audio2tol-bundle`.

### `archive_review_queue`

Lists queued ingest requests from the review area so the shell can expose them as explicit review work, not hidden background jobs.

### `archive_process_ingest_request`

Runs a queued request through the Strategist-owned ingest provider route and writes a review artifact instead of mutating trusted wiki pages directly.

The result is:

- provider/model-governed
- reviewable
- logged into archive activity
- separated from trusted page creation/update

### `archive_promote_review_artifact`

Promotes an approved review artifact into trusted wiki pages.

The command:

- validates the artifact path through the guarded archive resolver
- requires `decision.status = approved`
- rejects unsupported page types
- writes only into schema-approved wiki subdirectories
- creates backups before overwriting existing pages
- preserves existing markdown bodies on update and appends a provenance-marked promoted update section
- records promotion metadata on the artifact
- upserts promoted pages into the SQLite `pages` index when the archive database is present
- registers or marks the source as processed and links promoted pages through `page_sources`
- logs `trusted_wiki_promote` activity when the archive database is present

## Consequences

- The Archive workspace should evolve from a policy-only view into a real memory operations surface.
- Archive routing and provider policy still govern ingest execution, but archive status/search/read do not require LLM calls.
- The host service is now aligned with the actual Living Archive model instead of a synthetic probe-only placeholder.
- Future work should add:
  - richer section-level semantic merge logic for trusted wiki-page updates
  - direct Audio2TOL add-on manifest emission so ResonantOS no longer has to infer bundle links from filenames
