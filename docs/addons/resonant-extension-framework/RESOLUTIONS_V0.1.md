# Conflict Resolutions V0.1

Decisions recorded 2026-08-24 by the fork author on the six conflicts the
roadmap depends on. Each cites the chosen option, the reasoning, and the
specific files or symbols affected. Carried into the ADR-038 draft.

The same resolutions also appear as an appendix in
`OPEN_DESIGN_CONFLICTS_V0.1.md`. This document is the canonical record
referenced by `IMPLEMENTATION_ROADMAP_V0.1.md`, ADR-038 drafts, and any
later external review.

## C1 — Trust tiers

**Decision:** Option (a) Map only, layered with a per-(addonId, version)
approval record.

Map REF tiers onto the existing enums:

| REF tier | Existing enums |
|---|---|
| Developer | `sideloaded-unverified` + `unverified` + `unreviewed` |
| Verified | `curated-signed` + `verified` + `reviewed` |
| Resonant Approved | `curated-signed` + `verified` + `approved`, with a per-(addonId, version) approval record whose `packageDigest` equals the package digest |

`bundled-core` remains a separate trust root (trust-by-bundling, not
signature). `enterprise-signed` is a future value with no V0.1 work.

## C2 — Capability tokens

**Decision:** Option (a) — Per-caller grant store at the dispatcher.
Record option (b) as the target for any UI-embedded third-party code.

Concrete change:

- Extend `isAuthorizedCapabilityRequest`
  (`browser-first/host/bridge-server.mjs`) from a static route→token map
  to a grant store keyed `(callerId, capability, scope)`.
- Mint per-add-on tokens at grant time using the existing
  requested/granted/denied record shape.
- Remove the bootstrap-derived credential set from
  `lib/addon-iframe.js`; iframes receive only the per-caller,
  scope-bounded token.
- Audit-trail hook records `callerId` on every authorised request.

This is Phase 3.5 in `IMPLEMENTATION_ROADMAP_V0.1.md` and is the hard
gate before Phase 4 and before M0 Tests B and C.

## C3 — Manifest systems

**Decision:** Option (c) — Scope-exclude browser-first from REF V0.1,
with an explicit privilege boundary.

`browser-first/addons/*` is declared extension-internal. The boundary is
privilege, not directory: anything reachable from extension content
scripts without going through the Phase 3.5 bridge-caller-token
machinery is first-party and out of REF scope.

Boundary clause for ADR-038:

> Third-party add-on code cannot invoke any bridge route that is not
> gated by a caller-attributed token minted under Phase 3.5. The
> browser-first executable content scripts remain first-party because
> they are not in the add-on loader path.

## C4 — Executable surface

**Decision:** Option (a) — V0.1 is declarative-only.

M0 Test A (Hello Resonant with a UI surface) is removed from the M0
milestone and renamed to "post-V0.1 sandbox surface" in the roadmap.
V0.1 add-ons are manifest + host-mediated tools + local services. No
shipped third-party code runs in the shell.

V0.1 still delivers the ecosystem's enforcement half (trust tiers,
capability model, lifecycle, certification, signing, registry). It
defers the code-running half until after Phase 3.5 is mature and a
sandbox surface decision can be made with real evidence.

## C5 — Capability mapping

**Decision:** Option (a) — single mapping table owned by the SDK
package.

Ship the manifest-capability → bridge-route-capability mapping as a
versioned data file inside the public SDK package. Validation warns
when a requested manifest capability maps to nothing; the bridge
authorises at route granularity using the same data.

Migration order:

1. Phase 0 — inventory the 16 bundled manifests in `public/addons/`
   alongside existing deliverables.
2. Phase 1 — introduce the mapping alongside the SDK extraction;
   back-fill bundled manifests.
3. After M0 — open deprecation window for any manifest capability that
   becomes unrepresentable in the new vocabulary.

## C13 — Sequencing

**Decision:** Adopt the revised order from the conflicts document:

```text
Phase 0   inventory (+ explicit decision: C3 manifest reconciliation)
Phase 1   extract public SDK contracts (introduces C5 mapping)
Phase 2   package format
Phase 3   developer CLI
Phase 3.5 caller-attributed capability tokens + iframe credential
          containment (C2) — NEW, gates everything below
Phase 4   host install + lifecycle (surface scope depends on C4 decision)
Phase 5–8 certification, signing, review, registry (unchanged)
M0 order: Test B (Local Files) → Test C (Local AI) → Test A (deferred)
```

## Deferred without further decision needed now

These are recorded so ADR-038 carries "acknowledged, deferred to Phase
N" rather than rediscovery work.

- **C6** container format: git-tarball with deterministic permissions;
  security pipeline veto possible.
- **C7** compatibility evaluation: install + launch (option b); fold
  into Phase 1.
- **C8** sideload enablement: enable + harden (option a); security
  pipeline review is its own gate before Tier 1 exists.
- **C9** naming: rename in REF only (`releaseTrustTier`,
  `capabilityRiskClass`); leave `agents[].trustTier` alone.
- **C10** registry deferral: option (a); metadata format and signed
  approved-release index now, live service later per ADR-023/024.
- **C11** signing architecture: native `crypto.sign` / `crypto.verify`
  ed25519; first-party bundles remain trust-by-bundling in V0.1; key
  custody deferred to security pipeline.
- **C12** package location: `packages/addon-sdk/` from the start; pay
  the registration cost once.
