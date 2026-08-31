# Personal / Local Add-on Governance

## Status

- Decision status: Proposed fork policy
- Alpha applicability: Development / sideload path
- Owner: Add-on SDK
- Date: 2026-08-24
- Related: ADR-006, ADR-018, ADR-023, ADR-026

## Purpose

ResonantOS should support user sovereignty without weakening the SDK boundary. A user may create a plugin/add-on for their own ResonantOS installation and accept more responsibility for breakage, maintenance, and update incompatibility. That freedom does **not** permit bypassing the ResonantOS add-on SDK, manifest, capability, lifecycle, or host-mediation contracts.

> **The SDK is the technical admission protocol. ResonantOS approval is the trust, compatibility, distribution, and support protocol.**

## Core Rule

Every add-on that plugs into ResonantOS must use the supported SDK contract, including personal/local add-ons.

A personal/local add-on may run without ResonantOS development-team approval when all of the following are true:

- the manifest validates against a supported SDK version;
- requested capabilities are declared explicitly;
- privileged behavior remains behind ResonantOS host mediation;
- the human explicitly enables or sideloads the add-on;
- the human explicitly accepts the unreviewed status and requested capabilities;
- the add-on does not impersonate an approved publisher or ResonantOS-signed release.

ResonantOS approval is required for an add-on to claim official compatibility, verified update support, curated distribution, or ResonantOS development-team support.

## Two Independent Axes

Technical compliance and ecosystem trust are separate.

| Class | SDK required | ResonantOS review | Official compatibility/update guarantee | Official distribution |
| --- | --- | --- | --- | --- |
| Personal / local | Yes | No | No | No |
| Community unverified | Yes | No | No | No |
| Verified publisher | Yes | Automated and/or limited review | Limited, policy-defined | Optional curated channel |
| Resonant Approved | Yes | Yes | Yes, within declared compatibility policy | Yes |

Passing SDK validation means the package follows the technical contract. It does not mean ResonantOS reviewed or endorsed the package.

## Personal / Local Provenance

Recommended future provenance tier:

```text
personal-local
```

Until that tier is implemented, personal/local add-ons should remain fail-closed under the existing unverified/sideloaded trust behavior. `personal-local` communicates provenance only; it must not grant capabilities or bypass runtime checks.

## User Responsibility

When a user installs or creates a personal/local add-on, ResonantOS should make clear that the user accepts responsibility for application instability, broken workflows, incompatibility after ResonantOS updates, data loss or corruption within granted scopes, unsupported interaction with other add-ons, and maintaining the add-on as SDK contracts evolve.

This increased responsibility does not turn developer mode into unrestricted execution.

## Non-Bypassable Boundaries

Personal/local add-ons must still obey:

- SDK manifest validation;
- SDK compatibility rules;
- capability declaration;
- explicit human grants;
- capability revocation;
- system-slot capability gates;
- host-mediated provider access;
- host-mediated filesystem/process/device access;
- trusted-memory write boundaries;
- audit requirements for privileged actions;
- runtime disable/remove lifecycle.

Developer mode may relax **distribution trust requirements**. It must not disable **kernel/runtime authority checks**.

## Suggested User-Facing Warning

> This add-on uses the ResonantOS SDK but has not been reviewed or approved by the ResonantOS development team. It may cause instability, data loss, or incompatibility after updates. You are responsible for enabling and maintaining it. ResonantOS capability and host-security boundaries still apply.

## Official Approval Path

A developer who wants ResonantOS compatibility guarantees, curated distribution, or development-team support must submit the add-on through the approval process.

The approval path should include, at minimum:

1. SDK validation;
2. deterministic tests and smoke tests;
3. capability/risk analysis;
4. package integrity/provenance checks;
5. compatibility testing against supported ResonantOS versions;
6. development/security review when policy requires it;
7. release-specific approval and signing;
8. re-certification for updates, especially capability changes.

Approval applies to a specific release, not permanently to a plugin name.

## Update Compatibility

Personal/local add-ons receive no automatic compatibility promise across ResonantOS or SDK updates.

Resonant Approved add-ons may receive a compatibility promise only for the version ranges explicitly declared and tested by the approval process.

If an approved add-on update expands sensitive capabilities, changes its runtime boundary, changes publisher identity, or introduces new privileged behavior, the new release must return to the applicable review path.

## Support Posture

The ResonantOS development team may distinguish between bugs in the SDK/runtime boundary, which remain ResonantOS concerns, and breakage caused by an unreviewed personal/local add-on, which remains the add-on author's/user's responsibility unless the failure demonstrates an SDK or host-security defect.

## Architectural Summary

```text
                     Resonant Add-on SDK
                            |
               +------------+------------+
               |                         |
        Personal / Local            Submitted Add-on
               |                         |
        SDK validation             SDK validation
               |                         |
        User sideloads            Certification
               |                         |
        User accepts risk          Dev-team review
               |                         |
        Host enforces              Signing / approval
        capabilities                    |
               |                  Curated distribution
               |                         |
         Runs locally              Supported add-on
```

```text
SDK compliance is mandatory.
Official approval is optional for personal use.
Official trust, compatibility, updates, distribution, and support require approval.
Host capability enforcement is never optional.
```

## Cross-References

This document is the governance companion to the engineering review in
`ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md`. Specifically Finding 7
of that review asks for explicit support of personal/local add-ons; this
document proposes the policy shape.

The two-axis table (SDK required × Resonant review) extends the
provenance work in `RESOLUTIONS_V0.1.md` C1, which currently maps the
three REF trust tiers (Developer / Verified / Resonant Approved) onto
the existing `AddOnProvenanceTier` enum. The proposed `personal-local`
trust tier would require **adding a new enum value** to
`AddOnProvenanceTier`, which is a different kind of change from the
C1 mapping work — it is a new design decision, not a refactor.

Cross-cuts with the framework package:

- `RESONANT_ADDON_SDK_SPEC_V0.1.md` — the technical contract every
  add-on (including personal/local) must satisfy.
- `OPEN_DESIGN_CONFLICTS_V0.1.md` — C8 (sideload enablement) is the
  runtime gate; this document argues it must be fail-closed against
  bypassing capability checks, even when sideload is enabled.
- `RESOLUTIONS_V0.1.md` — C8 was deferred ("enable + harden" with the
  security pipeline as its gate). This document is the policy
  position to apply when C8 lands.
- `EXTERNAL_REVIEW_FEEDBACK_V0.1.md` — the prior review's verification
  record confirms the existing trust-tier enum, which is what this
  document proposes to extend with `personal-local`.

## Disposition

This is a proposed fork policy, not an accepted decision. Carry into:

1. The ADR-055 draft: the `personal-local` provenance tier (if
   accepted) becomes an additional enum value with the same fail-closed
   guarantees as the others.
2. `RESOLUTIONS_V0.1.md` — when C8 is reopened (sideload enablement), the
   non-bypassable-boundaries list in this document becomes the
   acceptance criteria, alongside the security-pipeline review.
3. `IMPLEMENTATION_ROADMAP_V0.1.md` Phase 3.5 — the user-facing warning
   wording proposed here is the chip-UI copy for the personal/local
   tier, once implemented.
