# ResonantOS Planning & Architecture Governance

This directory is the working source of truth for the ResonantOS post-consolidation
architecture and SDK/DAO governance program. It converts the two 2026-09-14
roadmap source documents into a single, reviewable, execution-ready plan.

Everything here is **planning material**: proposals and schedules, not shipped
runtime facts. Runtime facts remain in [`docs/STATUS.md`](../STATUS.md) and the
[Architecture & ADR Index](../architecture/README.md). This directory does not
redefine the Alpha runtime boundary.

## Source documents

| Source                                                                      | Format | Relationship                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResonantOS_Post_Consolidation_Architecture_Roadmap_2026-09-14.docx`        | DOCX   | Original post-consolidation roadmap ("Fused Augmentor").                                                                                                                        |
| `ResonantOS_SDK_DAO_Governance_Roadmap_Guardian_Engineer_2026-09-14_v2.pdf` | PDF    | Revised proposal. Supersedes the "Fused Augmentor" framing with the Guardian/Engineer architecture and adds SDK, certification, marketplace, developer NFT, and DAO governance. |
| `Augmentor-Sync-Report 9.16.2026.pdf`                                       | PDF    | Tom's 16 Sep sync — current authoritative direction (One Augmentor, ADR-038, SDK → `packages/addon-sdk`, Node 24.21.0, privilege split proposed).                               |
| `ResonantOS-Settings-for-Manolo.pdf`                                        | PDF    | Tom's 15 Sep repository-access hardening steps for the org owner.                                                                                                               |

## Documents

1. [Project state review](00-project-state-review.md) — verified current state of
   the ROS-SDK repository, worktrees, fork-cleanup incident, open PRs, and how the
   two roadmap documents relate.
2. [Post-consolidation architecture roadmap](01-post-consolidation-architecture-roadmap.md) —
   the clean, structured transcription of the DOCX source.
3. [SDK + DAO governance roadmap](02-sdk-dao-governance-roadmap.md) — the clean,
   structured transcription of the PDF v2 source (the future plan/proposal).
4. [Master implementation plan](03-master-implementation-plan.md) — the reconciled
   plan: timetable, phases, checkpoints, and the master checklist.
5. [Roadmap review](04-roadmap-review.md) — a critical review of the plan: verdict,
   gaps, risks, and recommended changes.
6. [ROS-SDK demo status & buildout report](05-tom-report-ros-sdk-demo-and-buildout.md) —
   the report for Tom: demo ready to show + projected SDK buildout timeline as
   revisions over time.
7. [SDK demo test results & alpha integration](06-sdk-demo-test-results.md) —
   the Grok-Build test (prototype 11/11) + production-SDK validation (41/41) +
   the self-contained offline loopback demo (PASS).

## Source conversions

Verbatim Markdown conversions of the original source documents live in
[`source/`](source/README.md):

- [Post-consolidation architecture roadmap (DOCX → MD)](source/ResonantOS_Post_Consolidation_Architecture_Roadmap_2026-09-14.md)
- [SDK + DAO governance roadmap (PDF → MD)](source/ResonantOS_SDK_DAO_Governance_Roadmap_Guardian_Engineer_2026-09-14_v2.md)
- [Augmentor sync report, 16 Sep (PDF → MD, authoritative)](source/Augmentor_Sync_Report_2026-09-16.md)
- [Repository settings for Manolo, 15 Sep (PDF → MD, authoritative)](source/ResonantOS_Settings_for_Manolo_2026-09-15.md)
- [Augmentor status update, 17 Sep (PDF → MD, authoritative)](source/Augmentor_Status_2026-09-17.md)

## Prototype SDK

A runnable prototype SDK for the community-leader demo exists locally in
`examples/sdk-prototype/` (not yet published). It mirrors the production
manifest/capability model (Public / Privileged / Core-only, deny-by-default,
prepare/propose) and includes a reference example plugin. Its status and
projected buildout are summarized in
[`05-tom-report-ros-sdk-demo-and-buildout.md`](05-tom-report-ros-sdk-demo-and-buildout.md),
and its end-to-end validation (the Grok-Build test) is recorded in
[`06-sdk-demo-test-results.md`](06-sdk-demo-test-results.md).

## Prompts

- [SDK demo prompt](../../prompts/sdk-demo-prompt.md) — the harness-agnostic
  prompt for the SDK demo: verify it works (Tom), present it (Manolo), and build
  an add-on with the prototype SDK.
- The OMP document-review prompt (`prompts/omp-oh-my-pi-review-prompt.md`) is
  internal review tooling and is not part of this published document set.

## Daily summaries

Daily status summaries for the development team live in
[`daily/`](daily/README.md):

- [Daily summary protocol](daily/README.md) — what a summary must contain and how to
  present it.
- [Daily summary template](daily/TEMPLATE.md) — copy this to start a new day.
- [2026-09-16 kickoff summary](daily/2026-09-16-kickoff.md) — the first summary
  covering the planning kickoff (dated record; do not rewrite).
- [2026-09-17 summary](daily/2026-09-17.md) — ADR-038 resolution carried forward;
  Grok-Build alpha loopback demo PASS; docs-only PR prepared.

## Reading order

1. `00-project-state-review.md`
2. `01-post-consolidation-architecture-roadmap.md`
3. `02-sdk-dao-governance-roadmap.md`
4. `03-master-implementation-plan.md`
5. `daily/README.md`

## Status

- **Authoritative direction:** Tom's 16 Sep sync — the Guardian is decided
  (ADR-038: a small deterministic restart/roll-back service; the Engineer AI
  advises but holds no recovery authority), one Augmentor (Manolo's DeepSeek
  Harness, imported into `apps/augmentor`, #448), and the SDK at
  `packages/addon-sdk` (#441).
- **Carried forward from the DOCX:** principles P1–P7, the Public/Privileged/
  Core-only capability split, caller attribution, the commit boundary, host-held
  credentials, provenance labels, and Ground-0 recovery.
- **Superseded:** the DOCX's "Augmentor is fused / permanent executive
  intelligence" identity (by the PDF v2), and the PDF v2's undifferentiated
  "Guardian/Engineer" role (by ADR-038's Guardian + advisory Engineer AI).
