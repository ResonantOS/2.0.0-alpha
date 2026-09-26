# Source Document Conversions

This directory holds verbatim Markdown conversions of the source documents,
retained so the originals exist in a version-controllable, diff-friendly format.
The original PDFs/DOCX are **not committed**; only these Markdown conversions are
kept in the repository.

| Converted file                                                                                                                                       | Original                                                                    | Author | Status             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ | ------------------ |
| [ResonantOS_Post_Consolidation_Architecture_Roadmap_2026-09-14.md](ResonantOS_Post_Consolidation_Architecture_Roadmap_2026-09-14.md)                 | `ResonantOS_Post_Consolidation_Architecture_Roadmap_2026-09-14.docx`        | Andrew | superseded         |
| [ResonantOS_SDK_DAO_Governance_Roadmap_Guardian_Engineer_2026-09-14_v2.md](ResonantOS_SDK_DAO_Governance_Roadmap_Guardian_Engineer_2026-09-14_v2.md) | `ResonantOS_SDK_DAO_Governance_Roadmap_Guardian_Engineer_2026-09-14_v2.pdf` | Andrew | superseded in part |
| [Augmentor_Sync_Report_2026-09-16.md](Augmentor_Sync_Report_2026-09-16.md)                                                                           | `Augmentor-Sync-Report 9.16.2026.pdf`                                       | Tom    | **authoritative**  |
| [ResonantOS_Settings_for_Manolo_2026-09-15.md](ResonantOS_Settings_for_Manolo_2026-09-15.md)                                                         | `ResonantOS-Settings-for-Manolo.pdf`                                        | Tom    | **authoritative**  |
| [Augmentor_Status_2026-09-17.md](Augmentor_Status_2026-09-17.md)                                                                                     | `Augmentor-Status-2026-09-17.pdf`                                           | Tom    | **authoritative**  |

## Relationship to the working documents

The two 2026-09-14 conversions are **reference**, not authoritative direction.
The working documents in the parent directory add structure, reconciliation, and
scheduling:

- [`../01-post-consolidation-architecture-roadmap.md`](../01-post-consolidation-architecture-roadmap.md)
- [`../02-sdk-dao-governance-roadmap.md`](../02-sdk-dao-governance-roadmap.md)
- [`../03-master-implementation-plan.md`](../03-master-implementation-plan.md)

The PDF v2 supersedes the DOCX on the Augmentor identity (Guardian/Engineer model
replaces the "Fused Augmentor" framing); that reconciliation is documented in the
master implementation plan, not re-edited into these verbatim conversions.

The two Tom documents (16 Sep and 15 Sep) plus the 17 Sep status update are the
**current authoritative direction**. They record the One Augmentor /
ResonantOS-wraps-it decision, the ADR-038 Guardian definition, the SDK relocation
to `packages/addon-sdk`, the Node 24.21.0 move, the repository-access hardening
steps, and Tom's PR #453 review (approve with changes). The working documents
`00`, `03`, `04`, and `05` are aligned to them.
