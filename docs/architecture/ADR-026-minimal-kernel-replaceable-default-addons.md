# ADR-026: Minimal Kernel And Replaceable Default Add-ons

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Applies
- Superseded by: None
- Owner: Core and add-ons
- Decision date: 2026-04-30
- Alpha note: Replaceable chat, memory-system, and add-on boundaries apply to
  Alpha extension and bridge surfaces.

## Decision

ResonantOS must be a neutral local operating shell and add-on aggregator, not a product that locks the user into ResonantOS-authored chat, agent, or memory systems.

The non-replaceable ResonantOS layer is the **minimal kernel**.

The default Augmentor Chat interface and the default Living Archive memory system are **bundled recommended add-ons**, not mandatory core services. They must be disableable and replaceable by user-selected alternatives.

The Resonant Engineer Agent remains kernel-owned because it is the recovery, setup, repair, and safety floor for the system. It must remain available even if the user disables Augmentor Chat or replaces the memory system.

## Why

The product philosophy rejects lock-in. If ResonantOS claims to be a modular sovereignty-first operating layer, then the user must be able to replace the primary chat interface, primary agent implementation, and memory system.

This also creates a cleaner platform:

- community developers can build alternative chat systems
- community developers can build alternative memory systems
- ResonantOS can remain useful as a trusted orchestrator even when the user does not choose ResonantOS-authored defaults
- recovery and setup do not depend on optional chat or memory add-ons

## Kernel Responsibilities

The minimal kernel owns only what must be non-replaceable for safety and operation:

- desktop windowing and workspace shell
- add-on registry, installer, lifecycle, and launcher
- capability grant broker
- provider fabric and credential vault mediation
- secure local user-state root and audit/event log
- IPC boundary and privileged host-service mediation
- setup and recovery through the Resonant Engineer Agent
- emergency minimal Engineer console when normal chat interfaces are unavailable

The kernel must not require a specific chat add-on or memory add-on to boot.

## Replaceable System Slots

The shell must model replaceable system slots.

V1 slots:

- `primary-agent`
- `chat-interface`
- `memory-system`
- `communication-channel`

Bundled defaults:

- `addon.augmentor-chat` provides `primary-agent` and `chat-interface`
- `addon.living-archive` provides `memory-system`
- `addon.telegram-channel` may provide `communication-channel` when installed

Any compatible add-on may provide an alternative for these slots once it passes manifest validation and receives explicit user grants.

## Memory Provider Broker

The shell must not let product surfaces call Living Archive commands as if Living Archive were mandatory core.

Stable memory-facing UI and chat flows must route through a neutral memory-provider broker with these operations:

- status
- search
- read
- intake write
- ingest request
- review queue/artifact actions

`addon.living-archive` is the first broker adapter. If another memory add-on owns the `memory-system` slot but does not implement a broker adapter yet, memory operations must degrade clearly instead of falling back to Living Archive.

V1 supports an `http-json` memory-provider adapter for sideloaded/reference memory systems. The add-on manifest must declare:

- `systemSlots`: `memory-system`
- `requestedCapabilities`: `memory-provider`
- `service.protocol`: `http-json`
- `service.entrypoint` or installation config `memoryServiceUrl`

The HTTP JSON service contract uses `POST /memory/{operation}` with JSON request and response bodies. Required operation names are:

- `status`
- `search`
- `read`
- `intake-write`
- `ingest-request`
- `review-queue`
- `review-artifacts`
- `process-ingest-request`
- `maintenance-cycle`
- `background-cycle`
- `lint`
- `semantic-lint`
- `decide-review`
- `promote-review-artifact`

The reference implementation lives at `examples/reference-memory-service.mjs` with a sideloadable manifest at `examples/addons/reference-memory.json`. It exists to prove ResonantOS can run with a non-Living Archive memory provider.

`background-cycle` is the preferred V1 automation primitive. It must scan connected source roots, queue new/changed source files, run the provider-backed maintenance cycle, refresh navigation, and return a transparent summary of queued, skipped, processed, and promoted work.

`semantic-lint` must not mutate trusted memory directly. If it finds repair-worthy contradictions or stale claims, it should emit or queue repair-source artifacts that flow back through `process-ingest-request`, verifier approval, and `promote-review-artifact`.

Living Archive-specific advanced tools, such as source-library import, source classification review, and Audio2TOL bundle construction, may remain in the Living Archive workspace because they are not the generic memory-provider API.

## First-Run Rule

First run must ask the user whether to enable recommended defaults.

Recommended defaults:

- Augmentor Chat
- Living Archive

The user may:

- enable both recommended defaults
- enable only one
- skip both and select alternatives later
- sideload or install an alternative provider for a slot

If the user enables Augmentor Chat without a memory provider, the shell must prompt them to select or enable a memory add-on before memory-backed chat is used.

If the user disables Living Archive, memory-backed features must degrade clearly and prompt for another active `memory-system` provider.

## Add-on Defaults

No non-kernel add-on is installed, enabled, or granted by default.

Bundled recommended add-ons may appear in the default catalog and may ship recommended grant presets, but the user must explicitly accept them.

All other add-ons should be hidden from the basic catalog unless the user enables developer catalog mode, sideloads them, or installs them from a registry.

## Engineer Availability

The Resonant Engineer Agent must remain available in two modes:

- normal setup/settings assistant
- emergency resurrection/recovery assistant

The Engineer UI must not depend on the Augmentor Chat add-on.

If no chat interface add-on is active, the kernel must provide a minimal Engineer console. In emergency mode, the kernel may open a dedicated recovery pane or floating recovery window.

The Engineer may help the user:

- enable Augmentor Chat
- install an alternative chat add-on
- enable Living Archive
- install an alternative memory add-on
- diagnose provider, runtime, add-on, or permission failures

## Floating Chat Requirement

The default Augmentor Chat add-on must support:

- right rail surface
- center workspace surface if needed
- detached floating chat window

The floating window is a shell-mediated surface, not a separate privileged process with unmanaged permissions.

## Implementation Consequences

- `strategist.core` must be migrated toward a replaceable `primary-agent` slot provider.
- `living-archive.core` must be migrated toward `addon.living-archive`.
- Existing archive Rust services can remain host-mediated implementation details, but they are activated through the memory-system slot and grants.
- Native Living Archive IPC commands must require `addon.living-archive` to be enabled with `memory-provider` plus the action-specific grant before executing.
- If a different memory add-on owns the `memory-system` slot, the bundled Living Archive workspace and host commands must stop rather than silently operating as core memory.
- Existing chat modules can remain first-party implementation details, but they are activated through `addon.augmentor-chat`.
- The default bundled catalog should contain only the clean basic recommended defaults until developer catalog mode exists.
- Browser, Notes, Terminal, OpenCode, Hermes, Audio2TOL, OpenClaw, Shield, Logician, R-Awareness, and Telegram remain add-ons, not basic-version defaults.

## Migration Steps

1. Add `addon.augmentor-chat` and `addon.living-archive` manifests.
2. Limit the default bundled catalog to the recommended basic add-ons.
3. Add system-slot metadata to add-on manifests.
4. Gate chat rail rendering on an active `chat-interface` provider, except during Engineer recovery/setup.
5. Gate archive workspace and archive context use on an active `memory-system` provider.
6. Add first-run setup that asks whether to enable recommended defaults.
7. Add floating chat window support for Augmentor Chat.
8. Move non-basic add-ons behind developer catalog or external registry discovery.
9. Add a generic scoped memory-provider broker for third-party memory add-ons; until then, native archive commands are Living Archive-specific and must not be used as a universal memory API.

## Supersedes

This ADR supersedes the earlier assumption that the product ships with exactly four always-on core parts where Strategist and Living Archive are mandatory core systems.

The new rule is:

- ResonantOS kernel is mandatory.
- Resonant Engineer is mandatory.
- Augmentor Chat is recommended and replaceable.
- Living Archive is recommended and replaceable.
