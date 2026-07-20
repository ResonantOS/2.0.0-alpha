# ADR-020: Resonant Notes Clean-Room Workspace

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Notes add-on
- Decision date: 2026-04-27
- Alpha note: Resonant Notes is future work and is not required for Alpha.

## Decision

ResonantOS will build a **clean-room Obsidian-compatible notes workspace** as part of the Obsidian add-on path.

This workspace may reproduce public, user-visible knowledge-management behavior over Markdown vaults, but it must not copy, de-minify, translate, or derive implementation from Obsidian's proprietary application code.

The product name for the internal implementation is **Resonant Notes**. The Obsidian add-on remains the compatibility bridge for existing Obsidian vaults and external Obsidian handoff.

Resonant Notes is the production direction for working with Obsidian-compatible vaults inside ResonantOS. It should feel familiar to an Obsidian user, but it is not a visual skin over copied Obsidian code. The vault files are the source of truth; ResonantOS and Obsidian are readers/editors over the same local files.

## Why

The user wants the benefit of Obsidian-style local knowledge work inside ResonantOS, with Augmentor able to operate over notes, links, tags, and vault context.

The correct long-term strategy is to own the code and behavior inside ResonantOS while preserving interoperability with existing Markdown vaults. That gives ResonantOS:

- full AI control through audited host commands
- cross-platform behavior
- clean security boundaries
- compatibility with normal folders and Obsidian vaults
- no hard dependency on the native Obsidian app
- a familiar, minimal knowledge workspace where the human and Augmentor can collaborate over the same notes

Obsidian's core app is not an open-source dependency for ResonantOS. Inspecting packaged proprietary code and rewriting it in another language is not allowed for this project because it risks derivative-work contamination.

## Rules

- Do not inspect or copy Obsidian's proprietary application source, de-minified bundles, private internals, UI assets, trademarks, or undocumented implementation details.
- Implement only from public behavior, open file formats, public documentation, and independent design.
- Treat the vault filesystem as the source of truth. Resonant Notes must preserve compatibility with files edited by external Obsidian and must detect stale writes before saving.
- The UI should be Obsidian-familiar and minimal: left ribbon, folder/file explorer, central tabbed editor/reader, quiet status bar, and secondary panels only when selected.
- Avoid dashboard-style diagnostics in the active writing surface. Operational details belong in settings, status bars, or explicit inspection drawers.
- Use open standards and independently written parsers where possible:
  - Markdown/CommonMark-compatible syntax
  - YAML frontmatter
  - wikilinks such as `[[Note]]`
  - tags such as `#topic`
  - filesystem folder trees
- deterministic link graph generation from vault files
- JSON Canvas-compatible `.canvas` files, when canvas support is implemented
- The workspace must work for both real Obsidian vaults and ordinary Markdown folders.
- External Obsidian remains optional and is accessed only through validated URI handoff.
- ResonantOS-owned note writes, note moves, and note archives must remain host-mediated, audited, and stale-save protected.
- Permanent deletion is not a V2 default; note removal starts as recoverable archive into ResonantOS-managed vault trash.
- AI-suggested edits, tags, links, refactors, or reorganisations require explicit user approval before mutating vault files.
- Trusted Living Archive knowledge writes remain outside the Obsidian add-on. Notes may be queued only as raw intake unless promoted by the Strategist-owned archive ingest/review service.

## Interfaces Constrained

### Host Commands

The host owns vault indexing and file mutation.

Read/index commands:

- `obsidian_vault_status`
- `obsidian_list_notes`
- `obsidian_read_note`
- `obsidian_vault_index`

Write commands:

- `obsidian_write_note`
- future `obsidian_create_note`
- future `obsidian_rename_note`
- future `obsidian_apply_approved_patch`

### Vault Index

The first Resonant Notes index must expose:

- note title
- relative path
- modified marker
- size
- tags
- outgoing wikilinks
- backlinks
- deterministic search matches

The index is a working product feature and a future foundation for graph view, backlink panels, Augmentor actions, and Living Archive intake planning.

### UI Modules

The Obsidian-compatible workspace should grow as independent modules:

- `ObsidianWorkspace`
- `ObsidianVaultTree`
- `ObsidianEditor`
- `ObsidianPreview`
- `ObsidianMetadataPanel`
- future `ObsidianSearchPanel`
- future `ObsidianBacklinksPanel`
- future `ObsidianGraphPanel`
- future `ObsidianCanvas`

### Product Milestones

V1 foundation:

- host-mediated vault status, note listing, note read, note write, and vault index
- host-mediated note create, folder create, note rename/move, and recoverable archive operations
- folder/file explorer derived from relative vault paths
- single active note tab
- source edit and reading preview modes
- search and backlinks as selected sidebar views
- quiet status bar with backlinks, mode, word count, and character count

V2 workspace:

- CodeMirror 6 markdown editor as a dedicated module, not inline workspace logic
- multiple note tabs
- split panes
- command palette
- richer properties/frontmatter editing
- keyboard shortcuts aligned with common notes-app conventions
- lazy-load or route-split the editor bundle before release so the notes workspace does not inflate first app boot

V3 collaboration:

- Augmentor-visible editor selection and note context
- user-approved AI patch application
- note refactor proposals
- graph-assisted navigation
- JSON Canvas-compatible collaborative surface

## Consequences

- ResonantOS can become a serious knowledge workspace without embedding the native Obsidian app.
- The user keeps full ownership of local Markdown files.
- Obsidian remains useful but optional.
- The implementation is legally cleaner and architecturally stronger than native-app embedding.
- Full Obsidian plugin compatibility is not promised.
- ResonantOS can later expose its own add-on APIs for note operations and AI-assisted knowledge work.
