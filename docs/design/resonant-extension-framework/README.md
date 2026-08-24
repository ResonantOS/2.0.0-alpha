# Resonant Extension Framework V0.1 — Documentation Package

This package contains a proposed architecture and implementation specification for turning the current ResonantOS Alpha Add-on SDK into a governed external add-on ecosystem.

## Files

- `PROPOSAL-resonant-extension-framework.md` — framework proposal (draft for ADR-038)
- `RESONANT_ADDON_SDK_SPEC_V0.1.md` — Add-on SDK specification
- `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md` — `.rpkg` package and manifest contract
- `ADDON_CERTIFICATION_AND_SIGNING_V0.1.md` — certification pipeline, trust tiers, signing
- `ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md` — developer workflow and CLI
- `IMPLEMENTATION_ROADMAP_V0.1.md` — phased implementation plan
- `OPEN_DESIGN_CONFLICTS_V0.1.md` — 13 unresolved design conflicts, prepared for external review
- `SDK_REVIEWER_AGENT_V0.1.md` — Augmentor/Logician agent that reviews add-on submissions and drafts certification decisions

## Staging

This package is staged at `docs/design/resonant-extension-framework/` as a
design-stage proposal. On acceptance, the proposal becomes
`docs/architecture/ADR-038-resonant-extension-framework.md` and the
specifications move to `docs/addons/`, as described in
`IMPLEMENTATION_ROADMAP_V0.1.md`.

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
