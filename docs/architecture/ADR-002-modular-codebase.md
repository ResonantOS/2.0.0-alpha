# ADR-002: Modular Codebase Structure

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Applies
- Superseded by: None
- Owner: Core architecture
- Decision date: 2026-04-23
- Alpha note: Domain ownership and thin composition rules apply to Alpha
  extension, bridge, and supporting source modules.

## Decision

The codebase is organized by domain modules, not by one growing shell file.

Current baseline:

- `src/core/`
  - cross-cutting contracts
  - runtime persistence
  - policy logic
  - shared state helpers
- `src/modules/chat/`
  - Strategist chat rail
  - chat-specific UI components
  - chat-specific helpers
  - dictation support
- future modules:
  - `src/modules/archive/`
  - `src/modules/addons/`
  - `src/modules/settings/`
  - `src/modules/strategist/`
  - `src/modules/providers/`

`App.tsx` is the shell composition root. It must assemble modules, not implement them inline.

## Rules

- New feature work must start in a domain module, not inside `App.tsx`, unless the change is purely shell composition.
- Each module should own:
  - its main UI component
  - its local types
  - its local utilities
  - its tests
- When a feature grows beyond one file, split it by concern:
  - `Workspace` for rendering
  - `controller` for mutations/orchestration
  - `selectors` for derived view state
  - `types` or `utils` for local helpers
- Module-to-module dependencies should go through `src/core/` contracts or narrowly defined props, not hidden cross-imports.
- Large files must be split before they become a coordination bottleneck.
- `src/App.tsx` may keep shell state, but it should not accumulate domain mutation logic, async service workflows, or large derived-view blocks when those can live in module controllers/selectors.
- Privileged desktop code must live behind Rust service modules, not inside UI modules or large mixed host files.

## Thresholds

- A UI file above roughly `300-400` lines should trigger refactor review.
- A module that mixes rendering, storage, IPC, and policy should be split.
- Privileged desktop code must not be embedded in UI modules.
- `src/App.tsx` above roughly `500-600` lines should trigger a shell-boundary review.
- A Rust host file above roughly `500-700` lines should trigger service-boundary review.

## Anti-Regression Notes

- Do not move a module controller back into `App.tsx` for convenience.
- Do not let read-only selector logic sprawl through the shell root; prefer a selector module when the derivation block becomes substantial.
- When a refactor extracts a controller or selector, update `MODULE_MAP.md` and the governing GitHub issue in the same change.
- If a file is still intentionally oversized after a cleanup pass, record the reason and next split target in the governing issue and Project 2.

## Why

- The product is expected to grow to many add-ons and many contributors.
- A modular codebase allows parallel work by multiple humans or agents without repeated merge collisions.
- Module boundaries reduce accidental coupling and make architecture auditable.
