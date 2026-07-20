# ADR-001: Platform Stack

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Core architecture
- Decision date: 2026-04-23
- Alpha note: React, TypeScript, and capability boundaries apply. The Tauri and
  Rust host stack is not part of Alpha; see `ALPHA_RUNTIME_BOUNDARY.md`.

## Decision

ResonantOS vNext uses:

- `Rust` for the desktop host, security-sensitive services, local sidecars, secure storage bridges, and high-trust system integrations.
- `Tauri` as the cross-platform desktop shell.
- `React + TypeScript` for the user interface, application state, add-on surfaces, and non-sensitive product logic.
- `Manifest-driven add-ons` as language-neutral integrations behind explicit capability and IPC boundaries.

## Why

- `Tauri + Rust` fits the requirement for macOS, Windows, and Linux with a smaller attack surface than a fully Electron-style host.
- `Rust` is the right place for secure secret handling, wallet integration, filesystem capability enforcement, local process management, and future web3 operations.
- `React + TypeScript` gives fast UI iteration, strong editor tooling, and a broad hiring/contributor pool for the shell and add-on surfaces.
- A language-neutral add-on boundary allows future integrations in Rust, TypeScript, Python, or other runtimes without weakening the core shell boundary.

## Rules

- Core trust boundaries, provider secret handling, archive write enforcement, wallet operations, and privileged IPC must live on the Rust/Tauri side.
- UI-only logic and compositional state should stay on the TypeScript side.
- Add-ons must not receive unrestricted host access. They work through manifests, capability grants, and explicit IPC contracts.
- Provider auth flows may vary by provider, but all secrets must resolve through a ResonantOS-controlled secure storage layer.

## Consequences

- ResonantOS is optimized for long-term maintainability and security instead of fastest-possible prototype velocity.
- Frontend contributors can move quickly without changing privileged code.
- Security-sensitive work can be audited in a smaller Rust surface.
