# External Review Feedback V0.1

First external review of this documentation package, captured as a design
resource. The reviewer examined both this package and the fork
(`vonstegen/2.0.0-alpha`), including the existing add-on architecture.

## Source and Status

- Source: independent AI review session (ChatGPT), 2026-08-24, requested by
  the package author as feedback on `OPEN_DESIGN_CONFLICTS_V0.1.md` and the
  overall framework direction.
- Status: feedback for design consideration. Not an accepted decision. Every
  factual claim the review made about this repository was verified against
  the fork on 2026-08-24; see "Verification Record" below.

## Core Recommendation

**Do not ship the Resonant Extension Framework as a second, competing add-on
architecture. Present it as the evolution of the architecture that already
exists.**

The review found that ADR-006 (Add-on Runtime & SDK) and ADR-018 (Add-on SDK
V0) already establish most of what this package proposes: a capability-gated,
host-mediated add-on runtime with provenance trust tiers, manifest contracts,
and lifecycle rules. The package's real contribution is the missing external
half. The review's proposed framing:

```text
ADR-006 Add-on Runtime & SDK
    ↓
ADR-018 Add-on SDK V0  (binding internal standard, src/sdk/addons)
    ↓
Public / Third-Party SDK  ("Add-on SDK V1")
    ↓
Certification + Packaging + Signing
    ↓
Official Extension Ecosystem
```

ADR-018 itself names the gap this package addresses:

> The SDK is not a public marketplace SDK yet.

Suggested naming from the review: "Resonant Add-on SDK V1 — Public /
Third-Party Extension Framework", rather than an unrelated framework name.
This independently matches the terminology decision already made for this
package (the unit is an **add-on**; "Resonant Extension Framework" names the
governance architecture, not a second artifact type).

## Alignment Map (Review Claims, Verified)

| This package | Existing repository asset |
|---|---|
| Developer / Sideloaded trust | ADR-006 `sideloaded-unverified` |
| Verified trust | ADR-006 `curated-signed` |
| Resonant Approved trust | ADR-006 `bundled-core`; future `enterprise-signed` |
| Capability / permission model | ADR-006 capability grants; `src/sdk/addons` |
| Host-mediated execution | ADR-006; authenticated Node bridge |
| Manifest standard | ADR-018 `AddOnManifest` contract |
| "Not a marketplace SDK yet" gap | ADR-018, stated verbatim |

The review also identified branch `sdk/p1b-p1e-slots-provenance` as relevant
prior art: it gates add-on `systemSlots` behind capabilities and stops
treating bundled add-ons without provenance as trusted (they default to
`sideloaded-unverified` / unreviewed).

## What the Review Says This Package Adds

The parts judged to add real value beyond the existing system — keep these:

- external package boundary and `.rpkg` artifact;
- deterministic package hashing;
- version-specific certification (approval never inherited across versions);
- publisher signing plus Resonant approval signing;
- formal review records;
- revocation;
- developer CLI;
- the External Add-on M0 Test (create, validate, package, sideload,
  permission, execute, disable, and remove one add-on from outside the
  ResonantOS source tree, using only the public SDK).

## Fork Strategy Guidance

- Build the framework **beside** the current SDK; do not rewrite the Alpha
  core first. Adapt `src/sdk/addons` contracts into the public package;
  change host/runtime code only when an M0 test proves a specific need.
- Mark the work clearly as fork-owned and experimental, with the upstream
  dependency stated (`ResonantOS 2.0.0-alpha`), so it is never confused with
  upstream ResonantOS.
- Keep an `UPSTREAM_DELTA.md` alongside the framework: record every change
  the fork makes to an upstream contract, so future rebases show exactly
  where the fork diverges.
- Suggested progression: document → extract public SDK → external add-on
  fixture → sideload lifecycle → capability enforcement → certification →
  signing → registry.

## Review Cautions

- **Do not promote the proposal to an ADR as written.** The original draft
  (ADR-031 numbering) risked duplicating decisions already made by ADR-006
  and ADR-018. The revision path is to reframe explicitly as
  "Add-on SDK V0 → Public Third-Party SDK V1", extending ADR-006/ADR-018
  rather than restating them. This package's staging at `docs/design/`
  (pending acceptance as ADR-055) already avoids premature promotion; the
  reframing still needs to happen before any ADR-055 draft.
- The main long-term engineering risk the review flags matches this
  package's own guiding rule: the public SDK contract must not couple back
  into private core implementation types. Keep "do not move privilege into
  the SDK" as a hard architectural rule.

## Verification Record

Claims checked against the fork on 2026-08-24:

- `docs/architecture/ADR-006-addon-runtime-sdk.md` exists; trust tiers at
  lines 60–63 are `bundled-core`, `curated-signed`, `sideloaded-unverified`,
  optional future `enterprise-signed`. Confirmed.
- `docs/architecture/ADR-018-addon-sdk-v0.md` exists; line 17 reads "The SDK
  is not a public marketplace SDK yet." Confirmed verbatim.
- Branch `sdk/p1b-p1e-slots-provenance` exists on the fork at `ca8ff57`
  ("sdk: Gate add-on systemSlots and mark missing provenance as
  unreviewed"). Confirmed.
- The review stated the fork's `dev` branch still pointed at a July commit.
  Stale at time of writing: `dev` was fast-forwarded to upstream `530b753`
  (2.0.0-beta.1 release prep) earlier on 2026-08-24.

## Disposition

Route this feedback into the resolution of `OPEN_DESIGN_CONFLICTS_V0.1.md`:

1. Reframe the package as the public evolution of ADR-006/ADR-018 before any
   ADR-055 draft.
2. Carry the "keep" list above into `IMPLEMENTATION_ROADMAP_V0.1.md` as the
   external-layer scope.
3. Add `UPSTREAM_DELTA.md` to the roadmap's fork-hygiene deliverables.
