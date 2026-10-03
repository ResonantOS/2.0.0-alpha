# ADR-039: Ground-0 Recovery Contract

## Decision Metadata

- Decision status: Proposed
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Core and add-ons
- Decision date: 2026-09-18
- Alpha note: Proposed Phase 1 direction; not yet ratified and not in force for
  the Alpha runtime. Defines the Ground-0 recovery contract from ADR-038 and
  ADR-026. It does not ship a recovery implementation by this decision.

## Context

[ADR-038](ADR-038-guardian-engineer-core-only-invariants.md) defines the
Guardian as a small, separate, deterministic process with no model that can only
restart or roll back to a known-good baseline, and states that recovery must
work with every model unavailable and without optional chat or memory add-ons.
[ADR-026](ADR-026-minimal-kernel-replaceable-default-addons.md) defines the
minimal kernel and makes Augmentor Chat and Living Archive replaceable, not
mandatory. [ADR-010](ADR-010-recovery-ladder.md) describes a staged recovery
workflow but is deferred for Alpha.

This ADR names the **Ground-0 recovery contract**: what the system guarantees to
recover, what it must not depend on, and the release-quality tests that prove
the property. It is a contract definition, not an implementation plan.

ADR-026 made the Engineer Agent responsible for two recovery duties — "setup and
recovery through the Resonant Engineer Agent" and the "emergency minimal
Engineer console" (ADR-026:44–45). Consistent with ADR-038, this ADR supersedes
those two Engineer-based recovery duties: recovery authority now rests with the
deterministic Guardian, and the Engineer remains an optional adviser that is
never required for recovery and never holds recovery authority.

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
- any marketplace, registry, certification service, DAO, or chain. None of
  these is currently in scope; Ground-0 does not depend on them whether or not
  that scope is later adopted.

The Augmentor may fail, restart, update, or be replaced without destroying
Ground-0. The Guardian's recovery authority is restart and rollback only, and is
independent of the Augmentor and of any model.

### The recovery invariant

```
Ground-0 survives everything above it. Augmentor, add-ons, and providers may
fail or be removed without destroying recovery; the same holds for any
marketplace, DAO, or chain if and when that scope is adopted.
```

### Failure matrix

Recovery must distinguish and handle each of these independently:

| Subsystem              | Failure mode                                         | Ground-0 response                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Augmentor              | crash, hang, bad update                              | restart or roll back the harness; the baseline is unaffected                                                                                                                       |
| Add-on                 | misbehaves or corrupts state                         | disable the add-on; the kernel keeps running                                                                                                                                       |
| Provider / model       | unreachable, auth broken, model unavailable          | degrade to a clear message; no model is required to recover                                                                                                                        |
| Guardian               | self-crash, restart loop, baseline-integrity failure | the Guardian is the recovery floor; on a restart loop or corrupt baseline it refuses to leave the last known-good, hash-pinned baseline and surfaces a recovery prompt to the user |
| Bridge                 | crash                                                | Guardian restarts it; rollback to last known-good configuration if needed                                                                                                          |
| Marketplace / registry | unavailable                                          | (conditional — not currently in scope) sideload/install flows degrade clearly; existing installs keep working                                                                      |
| DAO / chain            | unavailable                                          | (conditional — not currently in scope) Ground-0 is independent of them; no cached policy is assumed                                                                                |

The marketplace, registry, DAO, and chain rows are conditional: that scope is an
open product decision, and this contract does not assume those systems exist or
ship a policy cache for them.

### Recovery is not repair

Recovery restores a working baseline; it is not general diagnosis or repair.
The Guardian may restart or roll back; it may not change policy, grant
capabilities, approve commits, or replace its own baseline ([ADR-038](ADR-038-guardian-engineer-core-only-invariants.md)).
An Engineer AI may advise when a model is available, but is never required for
recovery and never holds recovery authority.

### Two-person protection of the baseline

The Guardian's own baseline is intended to be protected by the two-person
invariant rule recorded in ADR-038. That rule is a working assumption, **not yet
applied** — there is no CODEOWNERS enforcement on `dev`. This ADR records it as
the intended protection with enforcement outstanding; it does not claim the
protection is present today.

### What the Augmentor must expose

The failure matrix asks the Guardian to restart or roll back the Augmentor. For
that to hold, Manolo's DeepSeek Harness must be externally supervisable: it must
expose a versioned, hash-pinned identity matching the Guardian's baseline
hashes (so rollback can select a known-good version), and it must be restartable
by the Guardian rather than self-recovering authority it does not hold. These
are consequences for the harness, not a claim that the harness currently
exposes them.

## Why

- ADR-038 fixes the recovery authority (the Guardian); this ADR fixes the
  concrete, testable contract that authority must satisfy, so "Ground-0
  survives everything above it" is checkable rather than a slogan.
- Ground-0 independence is what makes the product a trusted local baseline
  rather than a stack that collapses when the AI or network fails.
- Separating recovery (restore baseline) from repair (diagnose and fix) prevents
  the recovery path from gaining authority it should not have.

## Proposed Rules

These are proposals and are not in force until this ADR is ratified:

- Recovery must work with every model unavailable and without optional add-ons.
- Ground-0 must not require the Augmentor, a provider, or the network to restore
  a working relationship.
- The Guardian's recovery authority is limited to restart and rollback. Rollback
  must not undo a subsequent invariant tightening or restore revoked authority
  ([ADR-038](ADR-038-guardian-engineer-core-only-invariants.md)).
- A failed subsystem must degrade clearly; it must not be silently papered over
  by falling back to a different subsystem's authority.

## Acceptance tests

The contract is proven only when deterministic tests demonstrate, from a
known-good baseline:

1. Disable all providers and models, then recover a usable shell with no model
   available.
2. Crash the bridge and let the Guardian restart it, then restore the
   last-known-good configuration.
3. Disable the Augmentor and confirm the kernel and recovery path still operate.
4. Disable every optional add-on and confirm the minimal shell still operates.
5. _(Conditional on the open DAO/NFT/marketplace scope decision.)_ Take the
   marketplace/registry and DAO/chain unavailable and confirm existing installs
   keep working.
6. _(Blocked on the baseline-storage decision below.)_ Roll back a bad update
   and confirm a later invariant tightening is preserved and revoked authority
   is not restored. The intended mechanism: the baseline carries an invariant
   version and rollback refuses to go below it.

The success criteria in tests 1–4 ("usable shell", "still operate", "still
operates") are pending the minimal-shell definition, which is itself deferred.
They will be restated as measurable criteria — the shell boots to the recovery
surface and the recovery action is available — once the minimal shell UX is
chosen. Acceptance of this ADR is not proof the tests pass; implementation is
tracked separately.

## Not Decided

- Guardian implementation language, supervisor integration, health probes,
  restart limits, baseline storage/selection, and rollback packaging (deferred to
  [ADR-038](ADR-038-guardian-engineer-core-only-invariants.md) "Not Decided").
  ADR-038 has already decided that the Guardian is a separate deterministic
  process; what remains open is supervisor integration and boot sequencing, not
  whether recovery is a separate process.
- The exact minimal shell UX and the recovery user flow.
- The DAO/NFT/marketplace scope; the conditional matrix rows and acceptance
  test 5 depend on that open product decision.

## Protected Paths (extends ADR-038)

This ADR adds its own file to ADR-038's protected-path list, and requires the
Guardian baseline and recovery-policy paths to be added there before
implementation (per ADR-038 "Invariant Changes: Working Assumption"):

```text
/docs/architecture/ADR-039-ground0-recovery-contract.md
```

## Consequences

- Recovery is constrained to known operations, which limits what a recovery
  path can do even if misused.
- Implementation must add recovery tests (failure injection, rollback,
  model-absent recovery) to the release gate.
- The Augmentor and optional add-ons remain first-class but are explicitly
  outside the recovery dependency set, reinforcing their replaceable status.
- Manolo's DeepSeek Harness must become externally supervisable (versioned,
  hash-pinned, restarted by the Guardian) before the failure matrix can apply
  to it.
