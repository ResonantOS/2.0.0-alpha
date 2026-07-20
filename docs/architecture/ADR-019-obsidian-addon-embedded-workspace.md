# ADR-019: Obsidian Add-on Embedded Workspace

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Notes add-on
- Decision date: 2026-04-27
- Alpha note: The hosted Obsidian-compatible workspace is future work and is
  not required for Alpha.

## Decision

ResonantOS will evolve the Obsidian add-on from the current V1 vault bridge into a **ResonantOS-hosted Obsidian-compatible workspace**.

The default V2 implementation must not depend on forcibly embedding the native Obsidian desktop application window inside Tauri. Instead, ResonantOS will open the selected vault inside the central workspace using host-mediated filesystem access and Obsidian-compatible markdown semantics.

The workspace should support:

- vault explorer
- markdown note editor
- markdown preview
- frontmatter display/editing
- tags
- wikilinks
- backlinks or linked-reference discovery
- note search
- open-in-external-Obsidian handoff
- raw Living Archive intake queueing through existing add-on boundaries
- Augmentor actions over selected notes or selected text

The external Obsidian app remains useful and optional. ResonantOS may hand the user to the external app through validated Obsidian URI actions, but trusted Living Archive writes still remain outside the Obsidian add-on boundary.

## Why

The user goal is to stay inside ResonantOS while working with Obsidian-managed knowledge and using Augmentor to help with notes.

There are two possible interpretations:

- Literal native-app embedding: place the actual Obsidian Electron desktop app inside the ResonantOS central pane.
- Product-level embedding: let the user operate the same Obsidian vault inside ResonantOS with Obsidian-compatible behavior.

The second path is the stable V2 direction.

Reasons:

- Obsidian vaults are plain filesystem folders with markdown notes, frontmatter, tags, wikilinks, attachments, and `.obsidian` configuration.
- The current V1 bridge already validates vault roots, scans markdown notes, previews notes, opens notes externally, and queues raw intake safely.
- A ResonantOS-hosted editor can be capability-gated, audited, tested, and made cross-platform.
- Forcibly embedding the native Obsidian Electron window is platform-fragile and would likely require OS-specific window reparenting or unsupported hacks.
- An iframe/webview approach is not a real solution because Obsidian is not a normal web app target that can be safely embedded as a remote page.
- The official Obsidian URI model supports opening notes and vault actions through `obsidian://` URLs, including an absolute `path` parameter for opening a file, which is suitable for handoff rather than deep embedding.
- Tauri supports creating webviews and sidecars, but that does not automatically make third-party native desktop app embedding reliable or portable.

## Rules

- Obsidian remains an add-on, not a core dependency.
- V2 must keep V1 safety guarantees:
  - scoped filesystem access only
  - no direct trusted Living Archive knowledge writes
  - raw intake only when `archive-intake-write` is granted
  - user review before archive ingest promotion
- ResonantOS must treat the vault as user-owned source material.
- The default V2 workspace must work with normal markdown folders even when `.obsidian` is absent.
- Non-Obsidian folders should use the Obsidian-compatible metadata standard from ADR-013.
- Any note write/edit capability must be separate from read-only preview capability.
- Any note write/edit capability must require explicit user approval and must keep an audit trail.
- Add-on actions that mutate vault files must be host-mediated Rust commands, not direct UI filesystem writes.
- External Obsidian handoff must remain available for users who prefer the full native Obsidian experience.
- Literal native-app embedding may only be explored under an experimental tier after the stable hosted workspace exists.

## V2 Scope

V2 should implement the first usable central workspace:

- left vault tree or note list
- central markdown editor and preview toggle
- note metadata panel
- selected-note Augmentor actions
- save operation with explicit dirty state
- host-side safe write command for markdown notes
- file version/audit record before overwrite
- open note in external Obsidian button
- queue selected note or selected notes to raw Living Archive intake

V2 does not need to implement full Obsidian plugin compatibility.

V2 does not need to run Obsidian’s Electron app inside ResonantOS.

V2 does not need to support all Obsidian canvas, graph, or plugin behaviors.

## V3+ Scope

Later versions may add:

- backlinks and graph-like navigation
- attachment preview
- markdown command palette
- bulk note refactor proposals
- AI-assisted tag/wikilink proposals with approval
- Obsidian plugin companion that can send active note/context to ResonantOS
- deeper import/export between Living Archive memory domains and vault folders
- optional experimental native-app window integration if a cross-platform, maintainable approach is proven

## Interfaces Constrained By This ADR

### Manifest

When the embedded workspace exists, `addon.obsidian` may expose a second surface:

- `id`: `obsidian-workspace`
- `type`: `embedded-pane`
- `label`: `Obsidian Workspace`
- required capability: `ui-embedding`

The existing V1 surface remains:

- `id`: `obsidian-vault-bridge`
- `type`: `panel`

### Capabilities

V2 read-only workspace requires:

- `filesystem`
- optional `archive-read`

V2 note editing requires a stricter future capability or scoped filesystem write grant. Until that exists, edits must be guarded by the existing filesystem grant plus a host-side confirmation/audit flow.

V2 archive intake requires:

- `archive-intake-write`

V2 Augmentor note actions may use provider access indirectly through the Strategist route. The Obsidian add-on itself should not choose provider/model routing.

### Host Commands

Existing commands remain valid:

- `obsidian_vault_status`
- `obsidian_list_notes`
- `obsidian_read_note`
- `obsidian_open_note`

V2 should add host commands before enabling editing:

- `obsidian_write_note`
- `obsidian_create_note`
- `obsidian_rename_note`
- `obsidian_note_versions`
- `obsidian_search_notes`
- `obsidian_resolve_wikilinks`
- `obsidian_backlinks`

All write commands must:

- validate the vault root
- reject path traversal
- operate only on allowed file types
- create an audit/version record before mutation
- return structured success/failure states

`obsidian_write_note` is the first required command. It must remain conservative:

- existing markdown note writes only
- optional stale-write protection through an expected modified marker
- backup snapshot before overwrite
- audit record before returning success
- no writes to `.obsidian`, `.resonantos`, `.git`, or other generated/internal folders

### UI Modules

V2 should not expand `ObsidianAddonPanel` into a monolith.

Ownership should be split:

- `ObsidianAddonPanel`: setup, grants, V1 bridge controls
- `ObsidianWorkspace`: central embedded workspace shell
- `ObsidianVaultTree`: note tree/list
- `ObsidianEditor`: markdown editor and save state
- `ObsidianPreview`: rendered markdown preview
- `ObsidianMetadataPanel`: frontmatter/tags/links
- `obsidian-addon-model`: shared sync/intake/model helpers
- future `obsidian-workspace-model`: editor, search, and graph helpers

## Consequences

- ResonantOS can provide an “inside ResonantOS” Obsidian experience without depending on unsupported native window embedding.
- The implementation remains cross-platform across macOS, Windows, and Linux.
- The user still keeps their Obsidian vault as plain files and can use the external Obsidian app at any time.
- The add-on remains aligned with Living Archive boundaries.
- Full Obsidian plugin compatibility is explicitly out of scope for V2.
- If users require the actual Obsidian app UI embedded, that becomes a separate experimental research track, not the production default.

## Implementation References

- V1 host boundary: `src-tauri/src/obsidian_service.rs`
- V1 UI modules: `src/modules/addons/ObsidianAddonPanel.tsx`
- V1 sections: `src/modules/addons/ObsidianAddonSections.tsx`
- V1 model helpers: `src/modules/addons/obsidian-addon-model.ts`
- Manifest: `public/addons/obsidian.json`
- Memory domain standard: `docs/architecture/ADR-013-living-archive-memory-domains.md`
- Add-on SDK: `docs/architecture/ADR-018-addon-sdk-v0.md`
- Official Obsidian URI reference: `https://help.obsidian.md/uri`
- Tauri webview API reference: `https://v2.tauri.app/reference/javascript/api/namespacewebview/`
- Tauri sidecar reference: `https://tauri.app/develop/sidecar/`
