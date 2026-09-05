# ADR-006: Add-on Runtime & SDK

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Applies
- Superseded by: None
- Owner: Add-on SDK
- Decision date: 2026-04-23
- Alpha note: Manifest validation, provenance, explicit capabilities, and host
  mediation apply to Alpha add-on surfaces.

Implementation note: ADR-018 defines the concrete Add-on SDK V0 package and validation rules under `src/sdk/addons`.

## Decision

ResonantOS uses a signed, capability-gated add-on system with provenance tiers and explicit runtime categories.

Curated add-ons are signed and distributed through a curated registry. They are semi-trusted: they may ship with recommended capability bundles, but the user can inspect and revoke those grants.

Sideloaded add-ons are never implicitly trusted.

## Why

- ResonantOS must be modular and extensible, but trust cannot be inferred from install success alone.
- The add-on system needs to support first-party, curated community, and local/sideloaded growth without collapsing the security model.
- Provenance and runtime permissions are separate concerns and both must be visible.

## Rules

- Every add-on must have a manifest.
- Every add-on declares:
  - runtime type
  - surfaces
  - requested capabilities
  - provider requirements
  - archive integration requirements
  - health strategy
  - compatibility constraints
- Add-ons are separated into runtime categories:
  - `ui-module`
  - `embedded-module`
  - `local-service`
  - `agent-addon`
  - `channel-addon`
- Add-ons do not get provider, archive, filesystem, device, or wallet access without an explicit capability grant.
- Curated add-ons may ship with preset recommended grants.
- Recommended grants are defaults, not permanent entitlements.
- Sideloaded add-ons start from minimal trust and must not inherit curated defaults.
- Add-ons that need setup or repair may ship an Engineer setup runbook, but the runbook is not an entitlement and must execute only through reviewed host-mediated commands.
- Engineer setup runbooks may reference provider profile ids and approved roots, but must not instruct the Engineer to expose raw provider secrets to the add-on by default.
- Add-ons that require a specific Strategist operating method may ship Augmentor skills, but those skills are guidance constrained by declared tools, capabilities, and approval gates.

Add-ons may also use the `orchestration` category when they supervise work across multiple agents, tools, or organizational workflows while still remaining under ResonantOS capability authority.

## Provenance Tiers

The runtime must distinguish at least:

- `bundled-core`
- `curated-signed`
- `sideloaded-unverified`
- optional future `enterprise-signed`

Provenance affects:

- default grant recommendations
- installation warnings
- upgrade trust
- support posture

Provenance does not override the capability system.

## Capability Grant Lifecycle

Capability grants must support:

- request
- approve
- revoke
- degrade
- re-request after update

Each grant must carry:

- capability
- scope
- revocation behavior
- source of grant recommendation

## Runtime Isolation

- UI add-ons run in shell-owned UI surfaces with no privileged access by default.
- Local service and agent add-ons run behind explicit host mediation.
- Channel add-ons must not redefine core agent identity or memory authority.
- Provider access, archive access, device integration, and wallet actions all flow through host-controlled gates.

## Installation States

Add-ons must have explicit lifecycle states:

- `available`
- `installed`
- `enabled`
- `disabled`
- `degraded`
- `update-available`
- `incompatible`

## Interfaces Constrained By This ADR

### Signed Manifest Model

Must represent:

- add-on metadata
- provenance tier
- signature or verification state
- runtime category
- capability requests
- provider/archive requirements
- compatibility rules

### Preset Grant Bundle

Curated add-ons may ship a preset bundle that lists:

- recommended grants
- intended scopes
- rationale

### Runtime Isolation Contract

Must define:

- what host APIs the add-on may call
- what IPC surface is exposed
- what happens on grant revocation
- what degraded mode looks like

### Engineer Setup Runbook

May define:

- setup objective
- setup document path
- required capabilities
- reviewed host commands
- expected inputs and outputs
- human approval requirement
- audit logging requirement

The Resonant Engineer may use the runbook to install, configure, verify, or repair an add-on. The host must still enforce capability grants, approved roots, command allowlists, and audit logging.

### Augmentor Skill

May define:

- skill objective
- skill document path
- required capabilities
- required add-on tools
- workflow phases
- approval gates
- expected inputs and outputs
- whether the skill produces Delegation Packets
- audit logging requirement

Augmentor may use the skill to guide high-level human collaboration with the add-on. The host must still enforce declared tools, capability grants, provider/cost policy, and human approval gates before execution.

## Consequences

- The SDK must document both manifest shape and grant semantics.
- A signing and registry model becomes part of the product, not just build tooling.
- Contracts in `src/core/` should evolve to express provenance tier and verification state directly.

## Amendment 2026-09 — credential-protected OpenCode server (#320, #339)

The OpenCode add-on runtime's local server (`opencode serve`) is spawned by the
bridge on a **bridge-picked ephemeral loopback port** (never 4096/4231) under a
**bridge-minted Basic-auth credential** (`OPENCODE_SERVER_PASSWORD`). Readiness is
fail-closed: the server must answer 200 with the credential and 401 without it
before it is adopted. Consumers forward the credential; the side panel receives
it as `eventAuthorization` in session start/list responses (only when the server
is credential-protected) and sends it on its `/event` stream. `/opencode/web/url`
returns `requiresCredential: true` and the panel disables the direct cockpit
handoff until a governed proxy exists (#321). The same seam is used by both bridge
layouts (session handlers and the cockpit-URL handler) via one per-process
singleton. Residuals tracked: credential visible in the child environment (#326),
orphan on SIGKILL until the next bridge start reaps it (#343).
