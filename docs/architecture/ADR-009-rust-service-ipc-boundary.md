# ADR-009: Rust Service & IPC Boundary

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Not applicable
- Superseded by: None
- Owner: Historical host boundary
- Decision date: 2026-04-23
- Alpha note: Rust/Tauri IPC is not an Alpha runtime path. Alpha privileged
  operations use the authenticated, capability-gated Node bridge defined in
  `ALPHA_RUNTIME_BOUNDARY.md`.

## Decision

Rust/Tauri owns privileged operations and service mediation. TypeScript owns shell composition and product surfaces. IPC contracts must be explicit, narrow, and service-oriented.

Experimental provider/auth integrations must be isolated behind service boundaries rather than leaking into general UI logic.

## Why

- ResonantOS needs cross-platform security, stable host mediation, and a smaller auditable privileged surface.
- TypeScript is the right place for UI and orchestration, but not for raw secret handling, signing, or privileged process control.
- Clear IPC boundaries reduce long-term fragility as providers, archive services, and add-on runtimes expand.

## Rules

- The Rust side owns:
  - secure storage
  - provider secrets
  - wallet/signing
  - local process orchestration
  - privileged filesystem and device access
  - host-side service mediation
- The TypeScript side owns:
  - shell composition
  - feature UI
  - non-privileged app logic
  - presentation of system state
- IPC must be explicit and minimal.
- UI modules should call named host services, not build ad hoc privileged logic.
- Experimental integrations must be isolated behind service-specific boundaries and health states.

## Service Categories

The host boundary should distinguish at least:

- provider service
- archive service
- wallet service
- add-on runtime service
- process/runtime node service
- secure storage service

## IPC Shape Conventions

IPC contracts should follow these rules:

- command names are domain-specific
- payloads are typed and narrow
- responses carry explicit success/failure structure
- degraded and experimental states are surfaced explicitly

The UI should not infer privileged behavior from side effects.

## Secret Handling Rules

- Secrets are stored and resolved on the Rust side.
- Browser/UI state may hold user-entered drafts temporarily, but not the trusted source of truth.
- Secret-bearing operations must not require the UI to manipulate raw secret values after submission.
- Portable encrypted vaults and user-state root resolution are Rust-side service responsibilities as defined in `ADR-022`.

## Process Orchestration Boundaries

- Local model/runtime deployment belongs to host-side process orchestration.
- Remote node communication policy belongs to host-side services.
- Panic/resurrect flows for local fallback are host responsibilities.

## Failure Reporting

Privileged services must report explicit states such as:

- `ready`
- `degraded`
- `experimental`
- `unavailable`

These states must be visible to the UI without the UI inventing its own interpretation layer.

## Consequences

- Future privileged work should start by designing a Rust service contract before adding UI.
- `src/core/` types should evolve toward service-level contracts that mirror Rust-side capabilities.
- The shell should gradually replace direct runtime helpers with explicit service-oriented adapters.
- Provider secrets, wallet vaults, and private memory paths must be mediated through the Portable User State Root and secure vault boundary before production wallet/provider hardening.
