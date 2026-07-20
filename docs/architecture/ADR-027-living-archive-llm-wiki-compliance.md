# ADR-027: Living Archive LLM Wiki Compliance

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Applies
- Superseded by: None
- Owner: Living Archive
- Decision date: 2026-04-30
- Alpha note: Source preservation, review, verification, and governed promotion
  apply to Alpha memory and archive routes.

## Decision

Living Archive must preserve the original LLM Wiki pattern while adding ResonantOS safety boundaries.

The original pattern is:

- raw sources are preserved as the source of truth
- an LLM maintains a persistent markdown wiki
- the wiki compounds over time through ingest, query filing, linting, cross-references, and synthesis
- the human curates sources, asks questions, and steers meaning
- the LLM does the bookkeeping work

ResonantOS keeps that pattern, but trusted memory mutation must pass through a host-mediated approval path. The human must not become the routine approver. The normal path is:

1. Source enters managed Human Knowledge, External Knowledge, or intake.
2. The Resonant Ingest Agent creates a review artifact and proposed wiki page changes.
3. A Strategist-owned verifier challenges the artifact against source evidence and archive policy.
4. Eligible routine artifacts are approved and promoted automatically.
5. Human review is used only for high-risk, doctrine-sensitive, low-confidence, destructive, or ambiguous cases.

## Why

The original LLM Wiki works because the LLM absorbs the maintenance burden. If ResonantOS requires human review for every page update, it recreates the same bookkeeping burden that causes humans to abandon wikis.

Silent mutation is also unsafe. A weaker model or untrusted add-on can corrupt long-term memory if it writes directly to trusted wiki pages.

The correct implementation is therefore not manual review and not blind automation. It is AI-mediated background maintenance with explicit escalation.

## Binding LLM Wiki Requirements

Living Archive must support these functions as first-class behavior.

### Ingest

- Detect or receive new source material.
- Preserve the original source version.
- Produce a review artifact with summary, claims, entities, concepts, tensions, open questions, doctrine alignment, confidence, and proposed pages.
- Update existing wiki pages instead of creating duplicate pages when a concept/entity already exists.
- Preserve provenance links from wiki pages back to source versions and review artifacts.

### Query

- Search/read the AI-curated wiki before falling back to raw sources.
- Answer with citations to wiki pages and source provenance.
- Allow valuable answers, comparisons, analyses, and syntheses to be saved back as intake for later wiki promotion.

### Lint

- Periodically check for contradictions, stale claims, orphan pages, missing cross-references, duplicate concepts/entities, and important concepts that lack pages.
- Produce review artifacts or maintenance tasks rather than silently rewriting high-impact memory.

### Index And Log

- Maintain a machine-searchable index in SQLite or equivalent.
- Generate human/LLM-readable markdown navigation files equivalent to `index.md`.
- Maintain an append-only chronological log equivalent to `log.md` for ingests, promotions, lint passes, and major query-derived additions.

### Obsidian-Compatible Markdown

- Use markdown pages with YAML-style frontmatter where possible.
- Use wikilinks/tags/backlinks for navigation when supported.
- Obsidian is optional; plain filesystem folders must still work.

### Versioning

- Source files keep stable source IDs and version history.
- Changed files become new versions of the same source when identity can be preserved.
- AI Memory pages keep provenance and backups before replacement.

## Approval And Automation Rules

- Human review must not be the normal approval path.
- The default routine approval path is an AI verifier operating under Strategist-owned policy.
- The verifier must challenge the ingest output, not merely restate it.
- The verifier must approve only when the proposed pages are grounded, non-destructive, non-doctrine-sensitive, and sufficiently confident.
- Human review is mandatory for high-risk cases defined in ADR-012.
- Background workers may auto-promote only artifacts that have an approved decision from policy or verifier.
- Add-ons may never bypass the review/promote boundary.

## Current Implementation Baseline

Implemented:

- source/library import and source-version ledgers
- source scanning and fingerprinting
- intake writes
- ingest request queue
- provider-backed ingest processing into review artifacts
- verifier-backed approval for routine `strategist-review` artifacts
- approved artifact promotion into trusted wiki pages
- SQLite page/source/activity indexes
- page-source provenance links
- Obsidian-compatible note indexing for wikilinks/backlinks in the notes add-on path
- maintenance-cycle command that can process queued requests and promote approved artifacts
- background-cycle command that scans watched source roots, queues new/changed files, then runs maintenance
- generated markdown `index.md` and `log.md` navigation artifacts refreshed by the maintenance cycle
- deterministic archive lint reports for orphan pages, missing wikilinks, duplicate-like titles, stale pages, unprocessed sources, and contradiction-review candidates
- provider-backed semantic lint reports for contradiction candidates
- semantic lint repair sources queued back through the normal ingest/verifier/promote path
- deterministic section-aware markdown merge for promoted updates to existing pages
- chunk staging for large text sources, with chunk manifests recorded in review artifacts
- conservative attachment stubs for non-text sources that require a specialist add-on pipeline
- separate ingest-writer and verifier provider fields so the verifier can use a different configured model/route
- browser-first draft generation now uses a provider-backed archive ingest writer when an archive-quality route is configured, validates the required LLM Wiki sections, and falls back to deterministic draft generation rather than dead-ending the ingest loop
- source-specific durable queue filenames for imported-library AI Memory builds; request files must not be named only by timestamp/actor/intent because large same-second batches can overwrite work
- persisted job integrity checks that reclassify stale imported-source paths or missing queued request files as `attention`
- live AI Memory build results must apply the same queue-integrity checks before reporting status, so a current run cannot report `needs-human-review` or `complete` when queued sources have no durable request files
- escalated review artifacts must not block unrelated queued source processing; they block promotion for those artifacts only while the remaining queue continues under the configured automation policy
- escalated review artifacts require an explicit `human.user` approve/reject decision before promotion; Strategist or verifier actors may escalate but may not resolve human-review work
- review execution is path-scoped: ingest processing accepts only files under `Memory/REVIEW/requests`, and decision/promotion accepts only files under `Memory/REVIEW/artifacts`
- intake artifact writes must be collision-safe and never overwrite prior raw/source evidence with the same bucket and filename
- review artifacts must expose durable promotion state after trusted wiki writes, so the UI and maintenance jobs can distinguish approved-but-unpromoted work from already-promoted wiki memory
- malformed model `proposed_pages` output must not dead-end the LLM Wiki loop when the rest of the ingest result is structured; the host may synthesize a conservative summary page from source-grounded structured fields and keep weaker string-only page ideas as stubs
- maintenance cycles must attempt AI repair/reverification of repairable escalated artifacts before treating human review as the next step; only genuinely unsafe, doctrine-sensitive, low-confidence, or still-unverified artifacts should remain human exceptions

Completed baseline:

- The Living Archive now has the full LLM Wiki control loop: source scan, queue, ingest, verifier approval, promotion, index/log refresh, deterministic lint, semantic lint, and semantic repair queueing.
- Auto-sync remains explicitly opt-in because provider usage can cost money. The user's Archive automation policy must be persisted, and unattended AI Memory batches must be blocked unless the policy allows the active archive ingest route cost tier.
- Non-text attachments are safely represented as stubs unless the relevant add-on, such as Audio2TOL, Obsidian, PDF, or DOCX processing, emits a text/structured intake bundle.
- Imported-library AI Memory jobs must be restart-safe: old false-complete states and queue-loss states are treated as repairable attention states, not as successful completion.

Hardening backlog:

- Add richer domain-specific merge policies for specialized page types.
- Add richer attachment processors through add-ons.
- Add long-running native filesystem event watchers; V1 auto-sync uses an app-open scheduled background cycle.

## Implementation Consequences

- Future Living Archive work must be measured against this ADR, not only against generic RAG behavior.
- Any UI that implies “scan folder equals wiki complete” is wrong unless background ingest, verification, and promotion have run.
- Any future third-party memory-system add-on should be evaluated by whether it can satisfy the same LLM Wiki operations through the memory-provider broker.
- The next implementation step is hardening, not filling missing architecture gaps: better merge quality, more attachment add-ons, and native filesystem event watchers.
