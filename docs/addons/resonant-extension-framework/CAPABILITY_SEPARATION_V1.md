# Capability Separation V1 (deferred)

## Status

**Deferred to a future ADR.** This document captures the design intent
so the V1 separation work can be picked up without rediscovery. It does
**not** modify any V0.1 contract.

Per `ADR-055-resonant-extension-framework.md` §12.3 (Resonant-OS vs
Third-Party SDK capability separation row) and `RESOLUTIONS_V0.1.md`
C10 deferred work, the V1 separation is out of scope for V0.1 but
must be planned.

## Why this is deferred from V0.1

V0.1 ships 13 manifest capabilities plus the two V0.1 additions
(`channel.send`, `channel.account-write`). The validation, certification,
and signing pipeline treat all of them uniformly. The runtime and the
SDK package expose internal types alongside the public surface.

Two reasons V1 needs a real split:

1. **Privilege-not-directory boundary.** The C3 resolution says the
   boundary is what the host *enforces*, not which directory the code
   lives in. Today, internal ResonantOS subsystems reach privileged
   state via the same `Capability` enum that third-party add-ons
   request. A V1 split gives the host a way to express "this
   capability is for first-party subsystem use only" without inventing
   a new enum value for every internal.
2. **Public SDK surface.** `packages/addon-sdk/` (Phase 1) ships a
   public type for `Capability`. Whatever values the SDK package
   exports become part of the public API. Internal-only capabilities
   (e.g. those that exist purely to wire the bridge to native services)
   must not leak into the public type.

## Proposed V1 shape

The V1 proposal, recorded here so a future ADR can pick it up without
rediscovery:

```text
Capability =
  | PublicCapability       // 13 + V0.1 channel additions, declared in packages/addon-sdk
  | InternalCapability     // first-party subsystem use; not exported from packages/addon-sdk
```

Two parallel enums:

- `PublicCapability` — declared in `packages/addon-sdk/src/capabilities.ts`.
  Used by add-on manifests and grant records.
- `InternalCapability` — declared in `src/core/contracts.ts` (current
  location). Used by the host runtime and first-party subsystems.

The host runtime maps `PublicCapability` to `InternalCapability` (or to
no capability at all, if the request cannot be satisfied) at the bridge
boundary. The mapping is the SDK-owned data file from C5.

### V1 manifest shape

The `requestedCapabilities[].capability` field uses
`PublicCapability` exclusively. A manifest that references an
`InternalCapability` is rejected at validation with
`unknown-capability`.

### V1 grant shape

Grants issued by the host carry an `InternalCapability` for runtime
enforcement; the `PublicCapability` is the visible label to the user.

### V1 certifier shape

The capability audit report (per
`ADDON_CERTIFICATION_AND_SIGNING_V0.1.md` Capability Audit) describes
the *requested* capabilities in `PublicCapability` form and reports
the host-side mapping outcome (`allowed` / `denied-by-mapping` /
`requires-internal-grant`).

## Out of scope for this deferred record

- Concrete enum values for `InternalCapability`. These are
  implementation-dependent and depend on the first-party subsystem
  inventory at the time the V1 ADR is written.
- Migration of existing V0.1 manifests. V0.1 manifests continue to
  work; the V1 cutover is opt-in via a `sdkVersion` bump.
- Removal of any V0.1 capability. The V1 split is additive; the V0.1
  set is a strict subset of the `PublicCapability` enum.

## ADR pointer

When this work is picked up, it lands as ADR-057 (or whichever number
is next in the architecture sequence). The ADR should:

1. Confirm the public SDK surface and what stays internal.
2. Lock the mapping table ownership (per C5: SDK-owned data).
3. Record the V1 manifest validation rules.
4. Record the runtime grant migration plan.
5. Update ADR-055 §12.3 to remove this deferral row.

## Source

- `ADR-055-resonant-extension-framework.md` §12.3 (Resonant-OS vs
  Third-Party SDK capability separation row)
- `RESOLUTIONS_V0.1.md` C5 (mapping table ownership)
- `RESOLUTIONS_V0.1.md` C3 (privilege-not-directory boundary)
- `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 3 (channel
  capability refinement)
