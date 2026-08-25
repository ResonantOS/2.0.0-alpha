# ADR-038 — Resonant Extension Framework

> **Outline.** Every section below is `pending` prose — the decision shape
> is locked, the wording is not. This is the skeleton reviewers can shape
> section by section before the ADR is proposed for acceptance. Section
> numbers and titles are stable; the `pending` markers are the only thing
> expected to change.

## Decision Metadata

- Decision status: **pending** (outline stage)
- Supersedes: none (extends ADR-006, ADR-018; references ADR-023, ADR-024, ADR-026, ADR-034)
- Alpha applicability: applies incrementally via the phases in `IMPLEMENTATION_ROADMAP_V0.1.md`
- Owner: Add-on SDK / Core / Security
- Decision date: **pending**
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

**pending.** Trust tier table, derived from `RESOLUTIONS_V0.1.md` C1
(option a: Map only) and from `PROPOSAL-resonant-extension-framework.md`
"Trust Tiers". Expected shape: the four-state core rule
`VALID != VERIFIED != APPROVED != GRANTED` (from
`ADDON_CERTIFICATION_AND_SIGNING_V0.1.md`) followed by the REF tier table
that resolves to existing enums. The `personal-local` provenance tier
proposed by `ADDON_PERSONAL_PLUGIN_GOVERNANCE.md` is recorded as a
**deferred proposal pending a separate design decision** (see §12
Open Decisions).

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

## 12. Open Decisions Carried Forward

**pending.** A short list of decisions this ADR records as
**acknowledged, deferred to Phase N** rather than rediscovery work —
mirroring the "Deferred without further decision needed now" section
from `RESOLUTIONS_V0.1.md`:

- **C6 container format** — git-tarball with deterministic permissions.
- **C7 compatibility evaluation** — install + launch; fold into Phase 1.
- **C8 sideload enablement** — enable + harden; security-pipeline gate
  before Tier 1 exists.
- **C9 naming** — rename in REF only (`releaseTrustTier`,
  `capabilityRiskClass`); leave `agents[].trustTier` alone.
- **C10 registry deferral** — metadata format and signed approved-release
  index now, live service later per ADR-023/024.
- **C11 signing architecture** — native `crypto.sign` / `crypto.verify`
  ed25519; first-party bundles remain trust-by-bundling in V0.1; key
  custody deferred to security pipeline.
- **C12 package location** — `packages/addon-sdk/` from the start.
- **`personal-local` provenance tier** — proposed by
  `ADDON_PERSONAL_PLUGIN_GOVERNANCE.md`. Requires either a new
  `AddOnProvenanceTier` enum value (option b) or a display-label-only
  distinction over `sideloaded-unverified` (option a — current
  `RESOLUTIONS_V0.1.md` C1 stance). **Decision pending.** The ADR
  does not commit to either; this is a fork-policy question for the
  author.
- **Communication-channel capability refinement** — from
  `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 3. Deferred
  until the capability-mapping table (C5) is built.
- **Public SDK external boundary** — from Finding 9 of the code-review
  feedback. Not before an external fixture project proves SDK
  consumption outside this monorepo.
- **Post-V0.1 sandbox surface** — from C4 resolution. Re-opened when
  the deferred M0 Test A is revisited.

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
