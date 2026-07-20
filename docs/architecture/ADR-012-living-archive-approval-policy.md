# ADR-012: Living Archive Approval Policy

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Applies
- Superseded by: None
- Owner: Living Archive
- Decision date: 2026-04-23
- Alpha note: Tiered review, verification, and trusted promotion policy applies
  to Alpha archive routes.

## Decision

Living Archive promotion from review artifacts into trusted wiki pages will use a **tiered approval policy**, not blanket human review.

The approval tiers are:

- `auto-approve`
- `strategist-review`
- `human-review`

The default approver for trusted archive promotion is the **Strategist-owned archive approval path**, not the human. In implementation this path may be performed by an archive verifier model acting under Strategist policy. Human review is reserved for higher-risk or higher-ambiguity cases.

## Why

- Requiring a human to review every archive write would create too much operational overhead and break the goal of making ResonantOS usable at scale.
- Allowing every queued ingest result to mutate trusted wiki pages automatically would erode archive quality and trust.
- The right control point is not “manual or automatic.” It is “which trusted verifier approves at each risk level.”
- The archive should stay high-trust while still supporting routine, low-friction ingestion.

## Rules

- All trusted archive page writes must pass through an approval tier.
- Approval is necessary but not sufficient: promotion must still pass host-side path, page-type, and backup rules.
- Approval tier selection must be policy-driven, not ad hoc.
- The approval policy must consider:
  - source type
  - workload class
  - doctrine sensitivity
  - confidence level
  - operation type
- `strategist-review` is the default tier unless a narrower policy explicitly allows `auto-approve`.
- `strategist-review` may be completed by an AI verifier operating under the Strategist-owned archive policy.
- `human-review` is required for high-impact or low-confidence cases.
- `auto-approve` must be limited to narrow, proven-safe classes of ingest.
- Approval decisions must be logged with:
  - tier used
  - approving actor
  - source request
  - resulting action
- Approved artifacts become eligible for promotion; rejected, escalated, and pending artifacts remain non-promotable.

## Approval Tiers

### `auto-approve`

Use only for low-risk, repeatable, and high-confidence ingest.

Examples:

- mature recurring pipeline outputs
- constrained bundle types with stable structure
- routine derived metadata enrichment

Requirements:

- approved source/workload class
- high confidence
- no destructive merge behavior
- no doctrine-sensitive synthesis

### `strategist-review`

This is the default promotion tier.

The Strategist-owned approval path reviews the review artifact, archive policy, and provenance, then decides whether to:

- approve promotion
- reject
- defer for human review
- request regeneration or clarification

This keeps the human out of most routine archive maintenance while preserving a high-trust gate. The normal V1 implementation is an AI verifier pass that challenges the ingest draft before promotion. The verifier should be a different role from the ingest writer and may run on a cheaper/local model when the user's provider strategy allows it.

### `human-review`

Use for higher-risk cases.

Examples:

- constitution or philosophy-adjacent pages
- synthesis pages with broad interpretive impact
- destructive merge or replacement behavior
- low-confidence claims
- ambiguous or conflicting source interpretation

## Policy Inputs

Approval policy must be driven by structured inputs, not chat text heuristics.

Minimum inputs:

- `sourceType`
- `sourceRole`
- `workloadClass`
- `confidence`
- `operationType`
- `doctrineSensitivity`
- `requestedTargetTypes`

## Suggested Initial Mapping

### `auto-approve`

Conservative initial candidates:

- routine recurring source imports with stable schema
- non-doctrinal metadata or low-risk summary refreshes

### `strategist-review`

Default for:

- transcript-derived ingest
- standard entity/concept extraction
- most non-destructive knowledge promotion

### `human-review`

Default for:

- doctrine-sensitive material
- constitution or protocol interpretation
- synthesis/future-facing strategic pages
- destructive replacements
- low-confidence promotion attempts

## Interfaces Constrained By This ADR

### Approval Policy

Must express:

- approval tier
- matching conditions
- minimum confidence
- escalation rules
- allowed approver

### Review Artifact

Must include:

- candidate output
- confidence
- doctrine sensitivity
- recommended approval tier
- source provenance
- requested target page operations

### Promotion Decision

Must record:

- approved / rejected / escalated
- approving actor
- tier applied
- timestamp
- resulting write action or no-op

### Promotion Execution

Must record:

- promoting actor
- promotion timestamp
- pages written
- pages skipped
- backup paths for replaced pages
- source review artifact
- page index status
- source/page-source index linkage when the archive database is present
- merge mode used for each promoted page

Promotion execution belongs to the host-mediated archive service, not add-ons or direct UI filesystem writes.

## Consequences

- The next archive implementation step should be a **promotion policy engine**, not blanket manual approval.
- The Archive workspace should eventually show:
  - review artifacts
  - recommended approval tier
  - Strategist approval decisions
  - only exceptional cases escalated to the human
- The current host implementation has the first promotion execution path; future work should improve merge intelligence without widening write authority.
- Trusted wiki writes should remain rare, auditable, and policy-governed.
- The Strategist becomes the normal memory curator; the human becomes the exception approver, not the bottleneck.
