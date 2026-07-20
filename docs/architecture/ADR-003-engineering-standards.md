# ADR-003: Engineering Standards

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Development only
- Superseded by: None
- Owner: Engineering workflow
- Decision date: 2026-04-23
- Alpha note: Governs repository implementation and review, not a shipped
  runtime component.

## Intent

ResonantOS is being built for durability, multi-contributor development, and eventual large-scale use. Code must be legible, testable, and tied back to explicit product intent.

## Standards

### 1. Intent Citations

Code files that implement non-trivial product behavior should include a short citation comment near the top that points to the relevant ADR, spec, or contract.

Examples:

- `// Intent citation: docs/architecture/ADR-002-modular-codebase.md`
- `// UX citation: docs/architecture/ADR-004-chat-rail.md`

Purpose:

- explain why the module exists
- let future contributors find the governing decision quickly
- reduce accidental product drift

### 2. Test Discipline

- UI changes must be covered by deterministic tests where practical.
- Shell and policy changes must pass local build/test before being called done.
- New capability or trust-boundary code must include negative-path testing where possible.
- Refactors are not complete until the deterministic suite is rerun after the final patch, not only after intermediate steps.

### 2a. React Hook Discipline

- Hooks must be declared in a stable order on every render.
- Never move a hook below a conditional early return for `loading`, `error`, or similar phases.
- When refactoring boot or hydration flows, re-check hook order by running the UI tests before calling the change complete.

### 2b. Completion Checklist

Before calling work done on product code, the contributor should verify:

- the code matches the current ADR/module ownership rules
- deterministic checks were rerun after the final edit
- docs were updated if ownership or architecture changed
- no temporary compatibility hack or known debt was left undocumented

### 3. Security Posture

- Secrets never live in browser-only state as the source of truth.
- Wallets, provider credentials, privileged file access, and add-on grants are treated as high-risk surfaces.
- Capability boundaries are explicit and deny by default.
- Recovery or repair agents must not get arbitrary script execution just because they are host-mediated.

### 4. Cross-Platform Discipline

- Do not rely on macOS-only behavior in core flows.
- Feature detection is required for runtime-specific capabilities.
- Unsupported capabilities must degrade cleanly, not throw opaque runtime errors.
- Hard-coded user paths, machine-specific roots, or username-specific defaults are not allowed in product host services.

### 5. Contributor Coordination

- Modules should be small enough for parallel work.
- Shared contracts live in `src/core/`.
- Each major feature area should have its own module directory and tests.
- Architecture notes should be updated in the same change when service or module ownership moves.

## Recent Failure Modes To Avoid

- letting `App.tsx` regain domain logic after an extraction
- letting `src-tauri/src/lib.rs` become a mixed host monolith again
- introducing hook-order regressions during loading/ready refactors
- broadening recovery tooling beyond the documented allowlist
- fixing architecture drift in code without updating the docs that are supposed to prevent it

## Immediate Follow-through

- Continue extracting shell sections out of `App.tsx`.
- Add module-local tests as new modules appear.
- Create ADRs before large structural shifts, not after them.
