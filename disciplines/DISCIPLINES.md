# ResonantOS Discipline Catalog

Status: active-pattern
Owner: ResonantOS maintainers

This catalog formalizes recurring ResonantOS operating practices that should be
checked locally before they are generalized into Arcanum framework guidance.

## Catalog

| ID | Discipline | Status | Steward | Evidence | Next hardening move |
| --- | --- | --- | --- | --- | --- |
| `development-package-promotion-gate` | Development package promotion gate | active-pattern | ResonantOS maintainers / Arcanum issue loop users | [Development package promotion gate](cards/development-package-promotion-gate.md) | Keep `development/` packages out of product PRs by default; use staged scope audit plus local catalog validation before framework promotion. |

## Status Meanings

| Status | Meaning |
| --- | --- |
| `candidate` | Useful practice exists, but local authority and validation are still being proven. |
| `active-pattern` | Practice is already used by active ResonantOS workflows, but the rule may still need stronger automation. |
| `implemented` | Working repository support exists, but may still need discipline-level hardening. |
| `canonical` | Accepted local authority with deterministic validation or release governance support. |
| `deprecated` | Superseded or withdrawn. |

## Growth Rule

Promote a local discipline only when the next route names its owner, evidence,
validation surface, and mutation boundary. A local ResonantOS discipline can
recommend an Arcanum promotion, but it does not make framework guidance
canonical by itself.
