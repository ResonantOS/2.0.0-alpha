# ADR-038 — Resonant Extension Framework

> **Outline.** Every section below is `pending` prose — the decision shape
> is locked, the wording is not. This is the skeleton reviewers can shape
> section by section before the ADR is proposed for acceptance. Section
> numbers and titles are stable; the `pending` markers are the only thing
> expected to change.

## Decision Metadata

- Decision status: **Deferred**
- Superseded by: None
- Alpha applicability: **Partial**
- Owner: Add-on SDK
- Decision date: **pending** (will be set when promoted to Accepted)

Outline stage — every section below carries `pending` prose. The trust-tier mapping (`§4`), capability model (`§5`), and runtime boundary (`§7`) are locked enough to be cross-referenced from `RESOLUTIONS_V0.1.md`. Everything else is a shape proposal pending proposer review.
- Source: forked from `PROPOSAL-resonant-extension-framework.md`, with the resolutions from `RESOLUTIONS_V0.1.md`, the conflict framing from `OPEN_DESIGN_CONFLICTS_V0.1.md`, the review-feedback notes (`EXTERNAL_REVIEW_FEEDBACK_V0.1.md`, `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md`, `ADDON_PERSONAL_PLUGIN_GOVERNANCE.md`), and the runtime hardening notes (`docs/security-pipeline/REF_HARDENING_NOTES_V0.1.md`).

## 1. Decision

**pending.** The single-sentence statement of the decision, derived from
`PROPOSAL-resonant-extension-framework.md` "Decision" section. Expected
shape: ResonantOS formalizes its existing add-on architecture as the
**Resonant Extension Framework (REF)** — extension of, not replacement for,
ADR-006 + ADR-018.

## 2. Architectural Principle

**pending.** The four-question separation from `PROPOSAL-resonant-extension-framework.md` "Architectural Principle" and the Core Principle from
`OPEN_DESIGN_CONFLICTS_V0.1.md` background. Expected shape:

> Manifest declares. Validation checks. Certification evaluates.
> Signature identifies. User grants. Host enforces.
>
> Approval is never a substitute for runtime authorization.

## 3. Lineage

**pending.** A short statement that ADR-038 is an *evolution* of existing
work, not a replacement. From `EXTERNAL_REVIEW_FEEDBACK_V0.1.md` and
`ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 8.

```text
ADR-006 Add-on Runtime & SDK
    ↓
ADR-018 Add-on SDK V0  (binding internal standard, src/sdk/addons)
    ↓
ADR-038 Resonant Extension Framework (public evolution; declarative-only V0.1)
    ↓
ADR-023 / ADR-024 (registry / commerce — deferred per C10)
```

## 4. Trust Model

The four-state core rule governs every add-on, regardless of trust tier:

```text
VALID != VERIFIED != APPROVED != GRANTED
```

`ADDON_CERTIFICATION_AND_SIGNING_V0.1.md` documents the rule in full. REF
inherits it unchanged.

REF's three trust tiers map onto the existing `AddOnProvenanceTier` enum
(`bundled-core | curated-signed | enterprise-signed | sideloaded-unverified`)
per `RESOLUTIONS_V0.1.md` C1 (option a — Map only). The mapping table:

| REF tier | Existing enums |
|---|---|
| Developer / Sideloaded | `sideloaded-unverified` + `unverified` + `unreviewed` |
| Verified | `curated-signed` + `verified` + `reviewed` |
| Resonant Approved | `curated-signed` + `verified` + `approved`, bound to per-`(addonId, version)` approval record |

`bundled-core` is first-party (trust-by-bundling, not signature). `enterprise-signed`
is a future value with no V0.1 work. Per-version approval is mandatory — the
package digest and manifest digest both bind to the approval record.

### User policy for personal / self-built add-ons

`ADDON_PERSONAL_PLUGIN_GOVERNANCE.md` records the user's policy: approved
add-ons appear in the official listing stamped by the ResonantOS team;
private or self-built add-ons are **not approved** and **may cause a
ResonantOS crash requiring automatic recovery**. The chip-UI warning text
is the user-facing surface for this consequence. The runtime contract
itself does not distinguish "personal" from "sideloaded" by enum value —
that distinction is a display concern in V0.1, recorded as the
`personal-local` deferred item in §12.

### The boundary the runtime enforces

Capability grants (manifest declared → user-granted → host-mediated →
audit-attributed via Phase 3.5) are authoritative regardless of trust
tier. Approval is never a substitute for runtime authorization.

## 5. Capability Model

**pending.** Three-vocabulary problem and the C5 mapping decision
(`RESOLUTIONS_V0.1.md`). Expected shape:

- Three vocabularies: 13 coarse manifest capabilities, 23 fine bridge
  route capabilities, the informal browser-first set.
- Mapping: SDK-owned data file shipped alongside the public SDK.
- Manifest declares; bridge enforces at route granularity.
- Open refinement: `communication-channel → notifications` semantics
  (from `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 3) —
  deferred to the capability-model revision phase.

## 6. Manifest & Package Format

**pending.** From `RESONANT_ADDON_SDK_SPEC_V0.1.md`,
`ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`, and the C6 resolution (git
tarball with deterministic permissions, security-pipeline veto possible).

## 7. Runtime Boundary

**pending.** From `PROPOSAL-resonant-extension-framework.md` "Runtime
Boundary" and `RESOLUTIONS_V0.1.md` C3 (scope-exclude browser-first from
REF V0.1, privilege-not-directory boundary). Expected shape: the bridge
remains the authority boundary; add-on code reaches privileged resources
only through `Resonant SDK API → Authenticated Resonant Bridge →
Capability Broker / Policy → Named Host Service` chain.

## 8. Phase 3.5 — Caller-Attributed Capability Tokens

**pending.** The runtime kernel of REF in this fork. From
`RESOLUTIONS_V0.1.md` C2 (option a, per-caller grant store), the
implementation landed on the `spike/caller-attributed-tokens` branch and
is documented in `docs/security-pipeline/REF_HARDENING_NOTES_V0.1.md`.

The ADR records that the runtime hardening landed on a fork branch and
that the H1–H4 design choices (HMAC-signed tokens, denied-audit reason
codes, redaction pipeline, rotation, allowlist, fail-fast, boot log)
are part of REF's runtime contract — not optional hardening.

## 9. V0.1 is Declarative-Only

**pending.** From `RESOLUTIONS_V0.1.md` C4 (V0.1 is declarative-only,
M0 Test A deferred past V0.1). Consequence: the "no shipped third-party
code runs in the shell" rule is locked for V0.1. The post-V0.1 sandbox
surface is recorded as an open question (§12).

## 10. Certification, Signing, Review, Registry

**pending.** From `ADDON_CERTIFICATION_AND_SIGNING_V0.1.md`. Records:
the `VALID != VERIFIED != APPROVED != GRANTED` core rule, human-review
trigger conditions, version-specific approval, key management
recommendations, and the `SDK_REVIEWER_AGENT_V0.1.md` reviewer copilot
as a dogfooded add-on. Registry (ADR-023) and commerce (ADR-024) are
*referenced but not redefined* — defer per C10.

## 11. Developer Workflow

**pending.** From `ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md`. Records:
the safe-path-is-the-easy-path principle, the CLI commands
(`create`, `validate`, `test`, `audit`, `package`, `submit`), and the
mock-host contract from `addon-sdk-testing`.

## 12. Decisions Recorded by This ADR

The §12 walk committed V0.1 decisions for every item previously deferred
in `RESOLUTIONS_V0.1.md` (C6–C12), recorded two new rows surfaced by
the framework package and the user’s policy on personal/local add-ons,
and resolved the §4 trust-model commitment. The result is that every
conflict on the framework roadmap has either a V0.1 commitment recorded
below or an explicit deferral to a follow-on ADR.

The section is structured as: V0.1 commitments first (these become
implementation gates once the prose is filled in), then cross-references
to source documents, then the deferrals that survive V0.1.

### 12.1 V0.1 commitments

- **C6 container format** — **V0.1:** `.rpkg` is the official package
  format per `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`. The
  `scripts/check-repo-hygiene.mjs` archive-zip rule is amended to add
  `.rpkg` to the allowlist (one-line change). Test fixtures live under
  `tests/fixtures/`. The security pipeline validates `.rpkg` packages
  separately; the hygiene rule is not the security boundary.
- **C7 compatibility evaluation** — install + launch; fold into Phase 1.
- **C8 sideload enablement** — **V0.1:** enable + harden; security-pipeline
  review is its own gate before Tier 1 (Developer/Sideloaded) add-ons
  can be installed. The runtime has `hasCommandHost()` hardcoded
  `false` today; the enable step unblocks the path through the
  host-mediated capability broker (per `RESOLUTIONS_V0.1.md` C2 / Phase
  3.5 hardening, already landed). Per `ADDON_PERSONAL_PLUGIN_GOVERNANCE.md`,
  the personal/local tier follows the same enablement gate with the
  user-facing warning covering the auto-unplug safety policy (deferred to
  ADR-039).
- **C9 naming** — **V0.1:** rename in REF only — `releaseTrustTier`
  (releases) and `capabilityRiskClass` (capabilities) replace any
  parallel vocabulary in REF-produced artifacts. The existing
  `agents[].trustTier` field stays (it describes agent personas, not
  add-on release trust); renaming it is out of REF scope. The rename
  touches `RESONANT_ADDON_SDK_SPEC_V0.1.md` and
  `ADDON_CERTIFICATION_AND_SIGNING_V0.1.md` vocabulary.
- **C10 registry deferral** — **V0.1:** metadata format and signed
  approved-release index ship now as a versioned JSON document in the
  public SDK package; the live registry service is deferred per
  ADR-023/024. The approved-release index carries per-(`addonId`,
  `version`) records: `packageDigest`, `manifestDigest`,
  `publisherKeyId`, `reviewId`, `signerKeyId`, `signedAt`. Index
  rotation: a release removed from the index is no longer installable;
  existing installations follow the revocation flow in
  `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`.
- **C11 signing architecture** — **V0.1:** native
  `crypto.sign` / `crypto.verify` ed25519 via Node’s built-in
  `crypto` module. Publisher signature format:
  `{ algorithm: ed25519, keyId, addonId, version, packageSha256,
  signedAt, reviewId }` (mirrors the envelope in
  `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`, with `algorithm` set to
  ed25519). First-party bundles remain trust-by-bundling in V0.1
  (`bundled-core` provenance tier; per-version approval records not
  required for bundled). Key custody (offline root, rotating
  release-signing key, publisher keys, revocation metadata) is
  deferred to the security pipeline review.
- **C12 package location** — **V0.1:** `packages/addon-sdk/` (and
  `packages/addon-sdk-testing/`) from the start, per the §12 Public
  SDK External Boundary resolution. Single source of truth immediately;
  `src/sdk/addons/` becomes a re-export shim pointing at the new
  package. Pay the registration cost once (root `package.json`,
  CI install/audit blocks, release scope audit, docs links, module
  ownership) rather than migrating it incrementally.
- **`personal-local` provenance tier** — **V0.1:** option (a) — `personal-local`
  is a display label over `sideloaded-unverified`. The runtime contract
  (`AddOnProvenanceTier`) is unchanged. The chip UI shows a distinct
  badge for add-ons the user authored locally; the user-facing warning
  text covers the consequence that loading such an add-on may crash
  ResonantOS requiring automatic recovery. Runtime enforcement
  (capability grants, host mediation, Phase 3.5 caller attribution) is
  unchanged. **V1:** revisit if upstream ResonantOS requests a distinct
  enum value.

- **Add-on safety / auto-unplug mechanism** — **deferred.** A runtime
  safety algorithm (small LLM or heuristic) that detects a failing
  add-on, isolates it, and restores the system to a usable state is
  needed to make the `personal-local` runtime story safe. The recovery
  policy (auto-unplug all add-ons vs. auto-unplug only the offending
  add-on) is **yet to be determined**. Deferred to a follow-on ADR,
  candidate **ADR-039**.

- **Communication-channel capability refinement** — **V0.1:** add
  `channel.send` and `channel.account-write` as new manifest
  capabilities alongside the existing `notifications.send`. The chatgpt
  `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 3 subdivisions
  into `channel.receive` and `channel.account-read` are deferred to
  V1. `notifications.send` remains for V0.1 backward-compat. The SDK
  spec records the migration in
  `RESONANT_ADDON_SDK_SPEC_V0.1.md` Capability Model section. The C5
  mapping table picks up the new entries in the same file.

- **Post-V0.1 sandbox surface** — deferred. M0 Test A (Hello Resonant
  with a UI surface) was deferred past V0.1 by `RESOLUTIONS_V0.1.md` C4.
  The "what defines V0.1 done" exit criteria are: Phase 3.5 hardening
  landed; M0 Test B (Local Files) and M0 Test C (Local AI) green; the
  capability-mapping table operational; signing + registry metadata in
  place per Phase 6/8. Only then is Test A reopened.

### 12.2 Cross-references

Every V0.1 commitment above is grounded in source documents:

| Decision | Source |
|---|---|
| §4 Trust Model mapping table | `RESOLUTIONS_V0.1.md` C1 + `PROPOSAL-resonant-extension-framework.md` Trust Tiers |
| `personal-local` display-only stance | `ADDON_PERSONAL_PLUGIN_GOVERNANCE.md` + user policy |
| `channel.send` / `channel.account-write` V0.1 additions | `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 3 |
| `channel.receive` / `channel.account-read` V1 deferral | Same Finding 3 |
| Public SDK external boundary inventory | Phase 0 deliverable; `IMPLEMENTATION_ROADMAP_V0.1.md` Phase 0 |
| C6 `.rpkg` stays official | `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md` + `check-repo-hygiene.mjs` amend |
| C8 sideload enablement | `RESOLUTIONS_V0.1.md` C8 + Phase 3.5 hardening notes |
| C9 naming (`releaseTrustTier`, `capabilityRiskClass`) | `RESOLUTIONS_V0.1.md` C9 |
| C10 registry metadata format | `RESOLUTIONS_V0.1.md` C10 + ADR-023/024 |
| C11 ed25519 signing | `RESOLUTIONS_V0.1.md` C11 |
| C12 package location | `RESOLUTIONS_V0.1.md` C12 + §12 Public SDK boundary |

### 12.3 Deferred to future ADRs

Three items are recorded as deferred and not addressed in V0.1:

- **Add-on safety / auto-unplug mechanism** — **deferred.** A runtime
  safety algorithm (small LLM or heuristic) that detects a failing
  add-on, isolates it, and restores the system to a usable state is
  needed to make the `personal-local` runtime story safe. The recovery
  policy (auto-unplug all add-ons vs. auto-unplug only the offending
  add-on) is **yet to be determined**. Deferred to a follow-on ADR,
  candidate **ADR-039**.

- **Post-V0.1 sandbox surface** — deferred. M0 Test A (Hello Resonant
  with a UI surface) was deferred past V0.1 by `RESOLUTIONS_V0.1.md` C4.
  The "what defines V0.1 done" exit criteria are: Phase 3.5 hardening
  landed; M0 Test B (Local Files) and M0 Test C (Local AI) green; the
  capability-mapping table operational; signing + registry metadata in
  place per Phase 6/8. Only then is Test A reopened.

- **Resonant-OS vs Third-Party SDK capability separation** —
  **deferred to V1.** The 13 coarse manifest capabilities (plus the two
  `channel.*` additions from item 2) are currently all exposed as
  public SDK surface. Resonant-OS devs see internal capabilities (likely
  candidates: `shell`, `browser-control`, `device-integration`,
  `network`) that third-party authors should not be able to request.
  Capability classification: each capability gets a visibility tier
  (Resonant-OS-internal, curated-approved-only, public). The
  third-party SDK rejects capability names above its visibility tier at
  `validateAddOnManifest` time, per chatgpt
  `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 6
  ("SDK validation, approval, and runtime authority must stay
  separate"). V0.1 keeps the current all-public surface; V1 introduces
  the visibility-tier classification in the SDK spec and runtime.
  The classification table itself is a follow-on design call requiring
  review of each capability's blast radius.

### 12.4 Summary

- **9 V0.1 commitments** recorded (C6, C7, C8, C9, C10, C11, C12,
  `personal-local`, `communication-channel`).
- **1 §4 commitment** recorded (the trust-model mapping table).
- **1 V0.1 commitment** recorded via cross-reference (public SDK external
  boundary — depends on the Phase 0 inventory commit landing first; the
  inventory is recorded as part of the §12 walk and is complete).
- **3 deferrals** recorded (auto-unplug, Post-V0.1 sandbox, capability
  separation).
- **0 unresolved** items from the original §12 outline.

- **Public SDK external boundary** — **V0.1 fork-only, soft cutover
  (alias):** create `packages/addon-sdk/` (and `packages/addon-sdk-testing/`)
  as the public SDK contract boundary. `src/sdk/addons/` becomes a
  thin re-export shim pointing at the new package. Single source of
  truth immediately; consumers don't notice the change.
  **Inventory complete (Phase 0 deliverable):** 5 SDK source files
  move (`src/sdk/addons/{contracts,validation,registry,surface-routing,index}.ts`),
  4 SDK test files move with them. `src/core/contracts.ts` re-exports
  the SDK types so runtime code (chat, browser-tools, delegation,
  logician, memory-provider, policies, runtime) keeps importing from
  `src/core/contracts.ts` without churn. `src/modules/` consumers
  (chip UI, settings, etc.) also unchanged — they only need the
  add-on types, which continue to flow through `src/core/contracts.ts`.
  No runtime blast radius; the cutover is mechanical.
  **V1:** upstream rebase is its own problem; `UPSTREAM_DELTA.md`
  records the fork-only status. The cutover is prerequisite to M0
  (external fixture project compiles and validates while importing only
  the SDK package) and to Phase 4 (host install + lifecycle), per the
  chatgpt `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Findings 9
  and 10.

## 13. Fork Strategy and Hygiene

**pending.** From `EXTERNAL_REVIEW_FEEDBACK_V0.1.md` "Fork Strategy
Guidance" and the package's own "Intended Repository Target" section.
Expected shape: the work is fork-owned experimental; ADR-038 carries an
`UPSTREAM_DELTA.md` requirement to record every change the fork makes
to an upstream contract.

## 14. Consequence Summary

**pending.** One-paragraph summary of what ADR-038 enables and what it
forbids, mirroring `PROPOSAL-resonant-extension-framework.md` "Decision"
section's enumerations.

---

## Appendix A — Input Source Map

Every claim in this outline is traceable to one of these sources.

| Source | Path | Role in ADR |
|---|---|---|
| Original proposal | `docs/design/resonant-extension-framework/PROPOSAL-resonant-extension-framework.md` | Decision, principle, framework components, trust tiers, runtime boundary, replaceability |
| Add-on SDK spec | `docs/design/resonant-extension-framework/RESONANT_ADDON_SDK_SPEC_V0.1.md` | §6 manifest, §11 SDK modules, lifecycle, tools, connectors, agents |
| Package & manifest spec | `docs/design/resonant-extension-framework/ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md` | §6 `.rpkg`, manifest fields, publisher block, digests, signature envelope |
| Certification & signing | `docs/design/resonant-extension-framework/ADDON_CERTIFICATION_AND_SIGNING_V0.1.md` | §10 pipeline, gates, review triggers, signing model, revocation |
| Developer workflow | `docs/design/resonant-extension-framework/ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md` | §11 CLI commands, mock host, reference add-ons, error codes |
| Implementation roadmap | `docs/design/resonant-extension-framework/IMPLEMENTATION_ROADMAP_V0.1.md` | §8 Phase 3.5, §9 M0 test ordering, §13 suggested repo additions |
| Open design conflicts | `docs/design/resonant-extension-framework/OPEN_DESIGN_CONFLICTS_V0.1.md` | §3 lineage grounding, §4-§7 conflict-driven decisions, §12 deferred |
| Resolutions | `docs/design/resonant-extension-framework/RESOLUTIONS_V0.1.md` | §4 C1, §5 C5, §7 C3, §8 C2, §9 C4, §10 sequencing, §12 deferred C6-C12 |
| External review | `docs/design/resonant-extension-framework/EXTERNAL_REVIEW_FEEDBACK_V0.1.md` | §13 fork strategy, alignment map |
| SDK code-review feedback | `docs/design/resonant-extension-framework/ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` | §12 communication-channel refinement; §12 external SDK boundary; §13 M0-first priority |
| Personal/local governance | `docs/design/resonant-extension-framework/ADDON_PERSONAL_PLUGIN_GOVERNANCE.md` | §12 `personal-local` tier proposal (deferred) |
| SDK Reviewer Agent | `docs/design/resonant-extension-framework/SDK_REVIEWER_AGENT_V0.1.md` | §10 dogfooded reviewer add-on |
| Runtime hardening notes | `docs/security-pipeline/REF_HARDENING_NOTES_V0.1.md` | §8 H1–H4 hardening is part of the runtime contract |
| Upstream ADRs | `docs/architecture/ADR-006-*.md`, `ADR-018-*.md`, `ADR-023-*.md`, `ADR-024-*.md`, `ADR-026-*.md`, `ADR-034-*.md` | §3 lineage; §10 references |
| Hardening implementation | branch `spike/caller-attributed-tokens`, commits `60c0129` `9e28f3f` `6617a63` `0d5f7ae` `779f16d` `92659c1` `a6ee86c` | §8 evidence; reviewable as a single squashed or cherry-picked commit when this fork merges back |
| Framework package intake | commits `410e508` `9d244e4` `2b6d6d6` on `feat/tab-referencing` | Records the framework package's source; reviewed in §3 |

---

## Appendix B — Reviewer Checklist

For each `pending` section above, a reviewer can shape the prose by
asking:

1. Does this section *commit* to something, or only *record* something
   that was decided elsewhere? If the latter, the section is one
   paragraph summarising the source's decision with a pointer.
2. Is there a source in Appendix A this section doesn't yet cite?
3. Does the section introduce any *new* commitment not in any source?
   If yes, that's a design change and should be flagged before
   acceptance.
4. Does the section preserve the four-question separation from §2?
   (Manifest declares / what it requests / what host grants / what
   Resonant certifies.)
