# Resonant Extension Framework V0.1 — Documentation Package

This package contains a proposed architecture and implementation specification for turning the current ResonantOS Alpha Add-on SDK into a governed external add-on ecosystem.

## Files

- [`PROPOSAL-resonant-extension-framework.md`](PROPOSAL-resonant-extension-framework.md) — framework proposal (draft for ADR-055)
- [`RESONANT_ADDON_SDK_SPEC_V0.1.md`](RESONANT_ADDON_SDK_SPEC_V0.1.md) — Add-on SDK specification
- [`ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`](ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md) — `.rpkg` package and manifest contract
- [`ADDON_CERTIFICATION_AND_SIGNING_V0.1.md`](ADDON_CERTIFICATION_AND_SIGNING_V0.1.md) — certification pipeline, trust tiers, signing
- [`ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md`](ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md) — developer workflow and CLI
- [`IMPLEMENTATION_ROADMAP_V0.1.md`](IMPLEMENTATION_ROADMAP_V0.1.md) — phased implementation plan
- [`OPEN_DESIGN_CONFLICTS_V0.1.md`](OPEN_DESIGN_CONFLICTS_V0.1.md) — 13 unresolved design conflicts, prepared for external review
- [`RESOLUTIONS_V0.1.md`](RESOLUTIONS_V0.1.md) — fork-author decisions on the conflicts, carried forward into ADR-055
- [`EXTERNAL_REVIEW_FEEDBACK_V0.1.md`](EXTERNAL_REVIEW_FEEDBACK_V0.1.md) — first external review of this package, with verification record and disposition
- [`ADDON_PERSONAL_PLUGIN_GOVERNANCE.md`](ADDON_PERSONAL_PLUGIN_GOVERNANCE.md) — fork policy proposal for personal/local add-ons (SDK required, Resonant review optional)
- [`SDK_REVIEWER_AGENT_V0.1.md`](SDK_REVIEWER_AGENT_V0.1.md) — Augmentor/Logician agent that reviews add-on submissions and drafts certification decisions
- [`REGISTRY_METADATA_SCHEMA_V0.1.md`](REGISTRY_METADATA_SCHEMA_V0.1.md) — C10 approved-release index schema (canonical JSON shape, verifier behavior, rotation)
- [`SIGNING_ARCHITECTURE_V0.1.md`](SIGNING_ARCHITECTURE_V0.1.md) — C11 ed25519 signing envelope, key ids, and verification behavior
- [`CAPABILITY_SEPARATION_V1.md`](CAPABILITY_SEPARATION_V1.md) — deferred V1 design for splitting Public vs Internal capabilities (no V0.1 contract change)
- [`REF_HARDENING_NOTES_V0.1.md`](REF_HARDENING_NOTES_V0.1.md) — Phase 3.5 caller-attributed bridge hardening (threat model and H1–H3 design; source for ADR-055 §8)
- [`MAINTAINER_ALIGNMENT_ROADMAP.md`](MAINTAINER_ALIGNMENT_ROADMAP.md) — status/sequencing roadmap tracking the maintainer-alignment work (done vs remaining)

The framework's V0.1 SDK contracts live today at
`packages/addon-sdk/src/` — the V0.1 public boundary (ADR-055 §12.1 C12), landed in `dev` via PR #441 (merged 2026-09-11). The `src/sdk/addons/*.ts` files are re-export shims pointing at this location; `src/sdk/addons/contracts.ts:62-75` resolves to the same `ADDON_CAPABILITIES` enum as `packages/addon-sdk/src/contracts.ts:62-75`.

## Staging

This package was staged at `docs/design/resonant-extension-framework/`
during the design phase. When ADR-055 was drafted, the proposal became
`docs/architecture/ADR-055-resonant-extension-framework.md` and the
specifications moved to this folder (`docs/addons/resonant-extension-framework/`)
as described in `IMPLEMENTATION_ROADMAP_V0.1.md`.

## Terminology

The unit of the ecosystem is an **add-on**, matching existing ResonantOS
vocabulary (`AddOnManifest`, `src/sdk/addons/`, ADR-018). Earlier drafts of
this package used the word "plugin"; the concepts are identical. Proposed
public API names (`defineAddon`, `validateAddOnManifest`,
`assertValidAddOnManifest`) intentionally align with the existing validators
in `src/sdk/addons/validation.ts`. "Resonant Extension Framework" names the
governance architecture, not a second artifact type.

## Intended Repository Target

The documents are written for a fork of the ResonantOS `2.0.0-alpha` repository and are designed to extend—not replace—the existing:

- Add-on SDK V0;
- capability-grant model;
- authenticated Node bridge;
- host-mediated service architecture;
- minimal-kernel / replaceable-add-on philosophy.

## Suggested First Commit

```text
docs: define Resonant Extension Framework V0.1
```

Keep this first commit documentation-only.

## Core Principle

```text
Manifest declares.
Certification evaluates.
Signature identifies.
User grants.
Host enforces.
```

An approved add-on never gains direct privileged authority merely because it is signed.
