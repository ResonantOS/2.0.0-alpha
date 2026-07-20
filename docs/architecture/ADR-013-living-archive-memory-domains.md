# ADR-013: Living Archive Memory Domains

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Applies
- Superseded by: None
- Owner: Living Archive
- Decision date: 2026-04-24
- Alpha note: Memory domains, source intake, explicit move approval, and
  governed promotion apply through Alpha bridge services.

## Decision

Living Archive will be modeled as a managed memory environment with three first-class domains:

- `Human Knowledge`
- `External Knowledge`
- `AI Memory`

The user may also import a folder as a `Mixed Library` when the source contains uncertain or mixed material. Mixed Library is not a final memory domain. It is a staging state for AI-assisted classification before files are promoted into Human Knowledge or External Knowledge.

The user-facing flow is not "scan a technical source root." The user connects one or more libraries, chooses the correct memory domain, chooses an import mode, and lets ResonantOS create a managed canonical memory location.

The default import mode is **copy-on-import**. A user may also choose **move-on-import** after explicit confirmation.

After import, the managed Living Archive copy becomes the canonical knowledge base for ResonantOS. The original external location is no longer treated as the active source unless the user explicitly keeps it linked as an external sync source.

Living Archive must keep version history for imported sources. The target direction is a local Git-style versioning layer, or an equivalent append-only version ledger if Git is not available or not appropriate for a file class.

## Why

- Users think in terms of "my data," "company/project/reference data," and "AI memory," not `raw_sources`, `derived_sources`, or `wiki_pages`.
- The original human-provided data must not be lost or rewritten by today's AI interpretation.
- Future stronger AI models should be able to reprocess the original source material, not only inherit the current AI-curated wiki.
- Keeping all managed memory in one clear location makes backup, migration, and user trust easier.
- Many humans have messy folders. ResonantOS should help organize them, but destructive changes must remain supervised.
- Obsidian is useful but optional. The same memory model must work for normal folders and Obsidian vaults.

## Memory Domains

### Human Knowledge

Human Knowledge contains data created by, authored by, or identity-bearing for the user.

Examples:

- personal notes
- journals
- TOL audio/transcripts/analysis when they express the user's thinking
- personal Obsidian vault notes
- personal philosophies
- decisions
- taste, goals, identity, values, preferences

Rules:

- preserve original human-authored material
- never silently rewrite original source text
- allow user-approved organization improvements
- treat identity-bearing material as high sensitivity

### External Knowledge

External Knowledge contains useful material that is not authored or owned by the human.

Examples:

- research reports
- market research
- papers
- company documents
- project documents owned by an employer/client
- meeting transcripts where the content belongs to a company or group
- reference material

Rules:

- preserve provenance and ownership context
- keep separate from Human Knowledge so the user's identity is not blended with external material
- allow scoped ingestion into AI Memory when useful

### AI Memory

AI Memory is the AI-curated interpretation layer.

Examples:

- summaries
- entities
- concepts
- syntheses
- claims
- tensions
- links
- provenance records
- review artifacts

Rules:

- AI Memory is maintained by the Strategist-owned ingest service
- trusted writes follow ADR-012 approval policy
- AI Memory can improve over time as better models and better merge logic become available
- AI Memory must preserve links back to Human Knowledge or External Knowledge source versions

## Managed Structure

The managed Living Archive location should be structured around the memory domains.

Target structure:

```text
ResonantOS_User/
  Memory/
    HUMAN_KNOWLEDGE/
      sources/
      versions/
      metadata/

    EXTERNAL_KNOWLEDGE/
      sources/
      versions/
      metadata/

    AI_MEMORY/
      system/
      wiki/
      syntheses/
      entities/
      concepts/
      summaries/
      provenance/

    INTAKE/
      addons/
      chat/
      imports/
        mixed/
      review-queue/

    INDEX/
      archive.db
      search/
      source-watch-index.json

    CONFIG/
      memory-config.json
      library-manifest.json
      permissions.json

    LOGS/
      activity.jsonl
      ingest.jsonl
      audit.jsonl
```

Current implementations may resolve this through the configured archive managed root during migration, but the product-level target is `ResonantOS_User/Memory` as defined by `ADR-022`. Exact folder names may evolve, but the domain separation and single portable user-state root are binding.

`AI_MEMORY/system` is reserved for host-owned ResonantOS architecture memory as defined in `ADR-014`. It is available before user knowledge intake and is not user-authored memory.

## Mixed Libraries And Classification

Most real user folders are not cleanly organized. A single folder or vault may contain personal notes, research, meeting transcripts, work documents, generated summaries, and project artifacts.

Rules:

- users may import uncertain folders as Mixed Library
- Mixed Library data lands in `Memory/INTAKE/imports/mixed`
- ResonantOS preserves the original folder structure during import
- the host service writes classification proposals into a review artifact; the UI displays those proposals but is not the authority
- the AI, or an interim deterministic classifier, proposes classification through that artifact, but the human approves structural changes
- classification labels must include Human Knowledge, External Knowledge, and unclear/needs human decision
- reorganization should be paired with metadata tagging and wikilinking, not only folder moves
- the first classification review may approve intent only; actual file moves require a separate host-mediated command with audit log and rollback plan
- `move` import mode uses a dedicated execution flow: preflight, exact human confirmation phrase, host-managed move, JSONL ledger, canonical managed destination registration, and rollback from the ledger; copy-on-import remains the default safe path
- v1 reorganisation plans are preview-only artifacts and are not eligible for execution until all imported files have been reviewed or explicitly paged through by the human

The UI must explain why this matters:

> Human Knowledge represents the user's own voice, identity, memories, decisions, and philosophy. External Knowledge is useful outside context. Keeping them separate protects provenance and prevents the AI from confusing external material with the user's own thinking.

## Obsidian-Compatible Metadata Standard

Obsidian is optional, not required.

If the imported source is already an Obsidian vault, ResonantOS preserves that structure and treats it as Obsidian-compatible.

If the imported source is a normal folder or has no clear knowledge-management standard, ResonantOS uses the Obsidian-compatible standard by default:

- Markdown frontmatter for metadata
- tags for ownership, source type, sensitivity, and review status
- wikilinks for people, projects, concepts, protocols, and ideas
- stable source IDs and version records outside the human-authored content

Recommended metadata fields:

```yaml
---
resonantos:
  ownership: human | external | ai-curated | unclear
  source_type: journal | research | meeting | protocol | project-doc | transcript | artifact
  sensitivity: private | doctrine-sensitive | work | public
  review_status: unreviewed | classified | approved | rejected
  source_id: stable-source-id
  version_id: v1
---
```

The UI should recommend the Obsidian add-on for non-Obsidian folders because it gives the user a mature way to manage Markdown files, tags, links, and backlinks. The add-on remains optional; the Living Archive must still work with plain filesystem folders.

## Import Modes

### Copy-On-Import

Copy-on-import is the default.

Behavior:

- original files remain in the original location
- ResonantOS copies the files into the managed Living Archive location
- the managed copy becomes the canonical source for ResonantOS
- future archive scans, ingest, and versioning operate on the managed copy
- the original path is preserved as provenance

User warning:

> ResonantOS will create a managed copy. After import, the managed copy becomes the active knowledge base. The original folder will not be used unless you explicitly keep it linked.

### Move-On-Import

Move-on-import is optional and higher risk.

Behavior:

- ResonantOS moves the selected files/folders into the managed Living Archive location
- the original location no longer contains those files
- the managed location becomes the canonical source

Requirements:

- explicit user confirmation
- clear warning before moving
- preflight permission and disk checks
- operation log
- rollback plan when possible

User warning:

> ResonantOS will move these files into the managed memory location. The original location will no longer contain them. Use this only when you want Living Archive to become the primary home for this data.

### Reference-In-Place

Reference-in-place is allowed only as an explicit advanced mode or temporary migration mode.

Behavior:

- files stay where they are
- ResonantOS stores path/hash/version metadata
- the external location remains fragile because user moves/deletes can break the archive link

Rules:

- not the default
- must be labeled as less backup-safe
- should be easy to later convert into copy-on-import

## Versioning

Every imported source must have a stable source identity and version history.

Minimum source version data:

- `sourceId`
- `versionId`
- `domain`
- `importMode`
- content hash
- original path
- canonical managed path
- source type
- size
- timestamp
- parent source id when derived from another source
- provenance metadata

Current v1 implementation writes a JSONL source-version ledger beside the library import manifest. A future Git-backed implementation may replace or augment that ledger, but it must preserve the same audit semantics.

Changed files become a **new version of the same source**, not a new unrelated source.

Example:

```text
sourceId: tol-2026-04-21-1003
versions:
  v1: original audio import
  v2: corrected transcript
  v3: updated analysis note
```

### Git-Style Versioning

The target implementation should evaluate a local Git repository for source version history.

Candidate model:

- initialize a local Git repo inside the managed memory root
- commit imports, moves, user-approved reorganizations, and AI-approved metadata edits
- preserve commit metadata with ResonantOS actor IDs
- never rely only on Git for semantic provenance; keep SQLite/JSON source metadata too

Git is useful for file history and rollback. SQLite/JSON metadata remains necessary for archive search, provenance, ingest state, and UI queries.

## AI Organization Rules

The AI may help organize Human Knowledge and External Knowledge, but not silently.

Allowed with human approval:

- propose folder moves
- propose renames
- add tags
- add wikilinks
- create indexes
- create Obsidian navigation pages
- detect duplicates
- propose source classification

Not allowed by default:

- delete original source files
- overwrite human-authored text
- move identity-critical material without approval
- destructively merge documents
- rewrite human source material as if it were original

AI Memory may be rewritten and improved through the approved ingest/review path. Source domains require stricter preservation.

## Obsidian

Obsidian is optional.

If the Obsidian add-on is installed, it may:

- register an Obsidian vault as a connected library
- expose a read-only vault bridge for selected markdown notes
- later expose managed Human Knowledge or External Knowledge folders in an embedded Obsidian pane
- help create tags, wikilinks, and navigation pages after user approval

Obsidian must not be required for Living Archive to work. Normal filesystem folders use the same library import model.

## Consequences

- The current mapped-folder scanner remains a low-level primitive, not the final user-facing model.
- The first implementation introduces a **Library Importer**:
  - connect folder/vault
  - classify as Human Knowledge or External Knowledge
  - choose copy/move/reference import mode
  - create managed canonical location
  - assign stable source IDs
  - create first version records and an import manifest
- The follow-up implementation must add:
  - native folder picker support
  - explicit confirmation for move-on-import
  - local Git-style source history or equivalent append-only version ledger
  - queueing selected imported sources for AI Memory ingest
- The Archive UI should be redesigned around connected libraries and memory domains, not raw vault-map roots.
- `VAULT_MAP.json` should become an internal generated/config artifact, not the primary user interaction model.
- Backup/export UX should target the managed Living Archive root because it becomes the canonical knowledge base.
- Living Archive managed memory must migrate into the Portable User State Root defined by `ADR-022`; source-local `_LivingArchive` storage is a transitional implementation detail, not the long-term destination.
