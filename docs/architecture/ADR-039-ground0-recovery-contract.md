# ADR-039: Ground-0 Recovery Contract

## Decision Metadata

- Decision status: Deferred
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Core and add-ons
- Decision date: 2026-09-18
- Alpha note: Proposed Phase 1 direction; not yet ratified and not in force for
  the Alpha runtime. Drafted from the post-consolidation roadmap. It does not
  ship a recovery implementation by this decision.

## Context

[ADR-038](ADR-038-guardian-engineer-core-only-invariants.md) defines the
Guardian as a small deterministic process that can only restart or roll back to
a known-good baseline, and states that recovery must work with every model
unavailable and without optional chat or memory add-ons. [ADR-026](ADR-026-minimal-kernel-replaceable-default-addons.md)
defines the minimal kernel and makes Augmentor Chat and Living Archive
replaceable, not mandatory. [ADR-010](ADR-010-recovery-ladder.md) describes a
staged recovery workflow but is deferred for Alpha.

This ADR names the **Ground-0 recovery contract**: what the system guarantees to
recover, what it must not depend on, and the release-quality tests that prove
the property. It carries the roadmap's D8 decision ("define Ground-0 acceptance
tests") and the P7 principle ("Ground-0 survives everything above it") into a
checkable statement. It is a contract definition, not an implementation plan.

## Decision

### Ground-0 definition

Ground-0 is the minimal recoverable baseline. It is the set of components the
system must be able to restore to a working state even when everything above it
has failed or been removed.

Ground-0 consists of:

- the minimal kernel responsibilities from [ADR-026](ADR-026-minimal-kernel-replaceable-default-addons.md):
  add-on registry/lifecycle, capability grant broker, provider-fabric and
  credential-vault mediation, secure local user-state root and audit log, and
  the IPC boundary; and
- the Guardian from [ADR-038](ADR-038-guardian-engineer-core-only-invariants.md),
  with its known-good baseline of installed-version hashes and configuration; and
- a minimal recovery path: restart and rollback, plus the ability to restore a
  working user relationship after a failure.

### What Ground-0 must not depend on

Ground-0 must remain recoverable without:

- the Augmentor (any AI/orchestration component, including Manolo's DeepSeek
  Harness);
- any model, provider route, or network;
- any optional add-on (chat, memory, browser, terminal, notes);
- any marketplace, registry, certification service, DAO, or chain.

The Augmentor may fail, restart, update, or be replaced without destroying
Ground-0. The Guardian's recovery authority is restart and rollback only, and is
independent of the Augmentor and of any model.

### The recovery invariant

```
Ground-0 survives everything above it. Augmentor, add-ons, marketplace, DAO,
chain, and providers may fail or be removed without destroying recovery.
```

### Failure matrix

Recovery must distinguish and handle each of these independently:

| Subsystem | Failure mode | Ground-0 response |
| --- | --- | --- |
| Augmentor | crash, hang, bad update | restart or roll back the harness; the baseline is unaffected |
| Add-on | misbehaves or corrupts state | disable the add-on; the kernel keeps running |
| Provider / model | unreachable, auth broken, model unavailable | degrade to a clear message; no model is required to recover |
| Marketplace / registry | unavailable | sideload/install flows degrade clearly; existing installs keep working |
| DAO / chain | unavailable | cached policy applies; Ground-0 is independent of the DAO |
| Bridge | crash | Guardian restarts it; rollback to last known-good configuration if needed |
| Guardian | — | the Guardian is the recovery floor; its own baseline is protected by the two-person invariant rule |

### Recovery is not repair

Recovery restores a working baseline; it is not general diagnosis or repair.
The Guardian may restart or roll back; it may not change policy, grant
capabilities, approve commits, or replace its own baseline ([ADR-038](ADR-038-guardian-engineer-core-only-invariants.md)).
An Engineer AI may advise when a model is available, but is never required for
recovery and never holds recovery authority.

## Why

- The roadmap's P7 invariant and D8 decision need a concrete, testable
  definition or they remain a slogan.
- Ground-0 independence is what makes the product a trusted local baseline
  rather than a stack that collapses when the AI or network fails.
- Separating recovery (restore baseline) from repair (diagnose and fix) prevents
  the recovery path from gaining authority it should not have.

## Binding Rules

- Recovery must work with every model unavailable and without optional add-ons.
- Ground-0 must not require the Augmentor, a provider, the network, a
  marketplace, a registry, a DAO, or a chain to restore a working relationship.
- The Guardian's recovery authority is limited to restart and rollback. Rollback
  must not undo a subsequent invariant tightening or restore revoked authority
  ([ADR-038](ADR-038-guardian-engineer-core-only-invariants.md)).
- A failed subsystem must degrade clearly; it must not be silently papered over
  by falling back to a different subsystem's authority.

## Acceptance tests (D8)

The contract is proven only when deterministic tests demonstrate, from a
known-good baseline:

1. Disable all providers and models, then recover a working shell with no model
   available.
2. Crash the bridge and let the Guardian restart it, then restore the
   last-known-good configuration.
3. Disable the Augmentor and confirm the kernel and recovery path still operate.
4. Disable every optional add-on and confirm the minimal shell still operates.
5. Take the marketplace/registry and DAO/chain unavailable and confirm existing
   installs and cached policy keep working.
6. Roll back a bad update and confirm a later invariant tightening is preserved
   and revoked authority is not restored.

These are release-quality tests. Acceptance of this ADR is not proof the tests
pass; implementation is tracked separately in the master plan (Phase 5).

## Not Decided

- Guardian implementation language, supervisor integration, health probes,
  restart limits, baseline storage/selection, and rollback packaging (deferred to
  [ADR-038](ADR-038-guardian-engineer-core-only-invariants.md) "Not Decided").
- The exact minimal shell UX and the recovery user flow.
- Whether recovery is a separate process, a supervisor, or a boot path; this ADR
  fixes the contract, not the mechanism.

## Consequences

- Recovery is constrained to known operations, which limits what a recovery
  path can do even if misused.
- Implementation must add recovery tests (failure injection, rollback,
  model-absent recovery) to the release gate.
- The Augmentor and optional add-ons remain first-class but are explicitly
  outside the recovery dependency set, reinforcing their replaceable status.
