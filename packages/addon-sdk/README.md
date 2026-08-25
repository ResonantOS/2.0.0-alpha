# @resonantos/addon-sdk

Public Resonant Extension Framework (REF) add-on SDK for ResonantOS.

> **Fork-only soft cutover.** This package directory is the public SDK
> surface per ADR-038 §12.1 C12 (Public SDK External Boundary). It is
> **not yet published** to npm. The source files here are the canonical
> implementation; the corresponding files under `src/sdk/addons/` in this
> repository are re-export shims that keep existing internal imports
> working during the soft cutover. When the SDK is extracted to a real
> workspace (Phase 1 of the implementation roadmap), the shims go away
> and this package becomes a published npm package.

## Scope

This package provides the **add-on author-facing** portion of REF V0.1:

- Manifest contract (`AddOnSdkManifest`) — the data shape a third-party
  add-on must author.
- Capability model (`ADDON_CAPABILITIES`, `Capability`, scope/revocation
  types) — the public list of capabilities an add-on may request.
- Validator (`validateAddOnManifest`, `assertValidAddOnManifest`) —
  deterministic manifest validation callable in dev, CI, submission
  processing, and host installation.
- Registry helpers (`createAddOnRegistryEntry`,
  `createAddOnRegistrySnapshot`) — combine manifests and installations
  into a registry snapshot.
- Surface routing (`createAddOnSurfaceDockRoutes`) — compute the dock
  routes for an enabled-and-installed add-on set.

## Out of scope (V0.1)

The runtime kernel of REF — capability grant enforcement, the bridge,
the host, the capability-token system — is **not** in this package. It
lives in `browser-first/host/*`, `src/core/`, and the security-pipeline
docs. Per ADR-038 §7 Runtime Boundary and ADR-040 §3 Boundary Rules,
the host retains all privilege enforcement; this package is
declarative-only.

## Layout

```text
packages/addon-sdk/
  package.json         # manifest (intentionally not published yet)
  README.md            # this file
  src/
    contracts.ts       # AddOnSdkManifest, ADDON_CAPABILITIES, etc.
    validation.ts      # validateAddOnManifest / assertValidAddOnManifest
    registry.ts        # createAddOnRegistryEntry, createAddOnRegistrySnapshot
    surface-routing.ts # createAddOnSurfaceDockRoutes
    index.ts           # re-export everything
```

## Compatibility with the existing shim

The original `src/sdk/addons/*.ts` files in this repository are now
re-export shims that point at this package:

```text
src/sdk/addons/contracts.ts       -> packages/addon-sdk/src/contracts.ts
src/sdk/addons/validation.ts      -> packages/addon-sdk/src/validation.ts
src/sdk/addons/registry.ts        -> packages/addon-sdk/src/registry.ts
src/sdk/addons/surface-routing.ts -> packages/addon-sdk/src/surface-routing.ts
src/sdk/addons/index.ts           -> packages/addon-sdk/src/index.ts
```

Tests under `src/sdk/addons/*.test.ts` keep working unchanged: they
import from `./contracts`, `./validation`, etc., which are now shims
that re-export from this package.

## Capability additions

V0.1 adds two capabilities to the public list per ADR-038 §12.1 C5
communication-channel refinement:

- `channel.send` — outbound channel messages
- `channel.account-write` — outgoing account-state mutations

The `notifications` capability remains in the list for backward
compatibility with existing channel-addon installations (notably the
Telegram channel add-on).

## Naming

Per ADR-038 §12.1 C9 (REF Vocabulary), the canonical REF names are:

- `releaseTrustTier` (`developer` / `verified` / `approved`)
- `capabilityRiskClass` (`low` / `moderate` / `high` / `critical`)

The existing runtime fields `provenance.tier` and `agents[].trustTier`
carry the same value sets for V0.1 backward compat; the formal field
rename lands when the SDK is fully extracted.

## Reference implementations

Two concrete add-ons are anticipated to use this package under ADR-040:

1. **`addon.deepseek-harness`** — local-service add-on bridging
   ResonantOS to the DeepSeek Harness (https://deepseek.com/harness/)
   Cordis kernel runtime.
2. **`addon.agentzero`** — local-service add-on bridging ResonantOS to
   the Agent Zero (https://www.agent-zero.ai/) Docker container
   runtime.

Both manifests will be siblings of `examples/addons/recursive-mas.json`
and will exercise every ADR-040 §3 boundary rule.

## See also

- `docs/architecture/ADR-038-resonant-extension-framework.md` (REF)
- `docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md` (provider-fabric boundary)
- `docs/addons/resonant-extension-framework/RESONANT_ADDON_SDK_SPEC_V0.1.md` (SDK spec)
- `docs/addons/resonant-extension-framework/ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md` (`.rpkg` package format)
- `docs/addons/resonant-extension-framework/RESOLUTIONS_V0.1.md` C12 (this package's location)
