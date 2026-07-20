# ADR-014: System Architecture Memory

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Living Archive
- Decision date: Not recorded
- Alpha note: System Architecture Memory remains long-term direction but is not
  an Alpha release requirement.

## Decision

ResonantOS must maintain a host-owned **System Architecture Memory** before any user knowledge intake runs.

This memory is part of AI Memory, not Human Knowledge and not External Knowledge. It gives Augmentor, the Resonant Engineer Agent, and archive services a current contract for what ResonantOS is, how it is structured, and which implementation boundaries are binding.

The v1 implementation is deterministic:

- ResonantOS scans canonical architecture docs and selected code-contract files.
- ResonantOS writes generated pages under `Memory/AI_MEMORY/system`.
- ResonantOS writes a source-hash manifest under `Memory/AI_MEMORY/provenance/system-memory-manifest.json`.
- ResonantOS exposes host commands to check status and refresh the system memory.
- Required architecture docs block refresh if missing.
- Code-contract files are indexed when available and reported when unavailable, but do not block startup.

## Rationale

The Strategist and Engineer cannot safely operate ResonantOS if their memory of the system drifts away from the running architecture. User memory intake is not enough because system knowledge must exist from first boot, before the user imports their folders, vaults, or project data.

This also protects recovery mode. The Resonant Engineer Agent needs a reliable local map of system contracts before it diagnoses provider failures, archive problems, add-on issues, or IPC boundaries.

## Rules

- System Architecture Memory is core host memory.
- It is generated and refreshed by ResonantOS, not by add-ons.
- It is available before user memory intake.
- It is read-priority context for Augmentor and the Resonant Engineer Agent when answering questions about ResonantOS itself.
- Generated system pages are not user-authored knowledge and should not be edited as Human Knowledge.
- A source-hash manifest is the authority for detecting staleness.
- If source hashes differ from the manifest, the status is `stale`.
- If required architecture sources are missing, the status is `blocked`.
- If no manifest exists, the status is `missing`.
- If all required sources exist and hashes match, the status is `ready`.

## Source Policy

Required bootstrap sources are architecture documents:

- `docs/README.md`
- `docs/ROADMAP.md`
- `docs/architecture/MODULE_MAP.md`
- core ADRs covering platform, modularity, standards, provider routing, add-ons, archive boundaries, IPC, recovery, host archive service, approval policy, and memory domains

Optional indexed sources include selected TypeScript and Rust contract files. These improve precision during development, but packaged builds may not always expose source files. Missing optional code sources must be visible in status so the Engineer knows the architecture memory is less precise.

## Interfaces

Host commands:

- `archive_system_memory`
- `archive_refresh_system_memory`

Core types:

- `ArchiveSystemMemoryStatus`
- `ArchiveSystemMemoryRefreshResult`
- `ArchiveSystemMemorySource`
- `ArchiveSystemMemoryPage`

Generated pages:

- `resonantos-system-index.md`
- `resonantos-architecture-contract.md`
- `resonantos-archive-recovery-contract.md`
- `resonantos-code-contract-inventory.md`

## Implementation Consequences

- The Living Archive host service owns system memory refresh and status.
- Architecture docs are bundled with the desktop app so first-run system memory can be generated without user import.
- Provider access is not required for v1 refresh.
- Later LLM synthesis may enrich the pages, but deterministic pages remain the minimum safe baseline.
- Chat, recovery, and ingest orchestration should load system memory before user archive context when the task concerns ResonantOS operation.
- The Strategist chat controller loads System Architecture Memory before normal Living Archive context.
- The Resonant Engineer Agent receives System Architecture Memory in recovery prompts so it can diagnose against current ResonantOS contracts.

## Exception Policy

Experimental or model-generated system-memory enrichment is allowed only if:

- the deterministic source-hash manifest remains intact
- generated claims cite the deterministic source pages
- stale deterministic sources prevent the enriched layer from being treated as authoritative
