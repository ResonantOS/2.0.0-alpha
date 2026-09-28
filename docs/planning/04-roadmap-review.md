# Roadmap Review — Master Implementation Plan

**Date:** 2026-09-16
**Reviewed artifacts:** the two 2026-09-14 source documents and the
[master implementation plan](03-master-implementation-plan.md).

This is a critical review of the plan, not a restatement of it. It flags what is
solid, what is under-specified, and what should change before execution begins.

> **Status (updated 2026-09-17):** this review was written against the original 26-week
> draft. Its core recommendation — compress the timeline — has since been adopted:
> the master plan is re-baselined to ~12 weeks, and it now includes a carry-forward
> audit, decision owners, decision deadlines (03 §8), and a replan trigger. Also
> since resolved: the Guardian ADR (ADR-038, merged) and the SDK relocation to
> `packages/addon-sdk`. The §1 verdict that the plan is "not yet an executable
> program" was against that original draft; day-level work is **on track** (see
> [`daily/2026-09-17.md`](daily/2026-09-17.md)) while these remaining program-level
> gaps stay open: a `Depends on` column, per-phase Definition of Done, and the
> Phase 9 feasibility spike (see §4).

---

## 1. Verdict

The plan is **directionally correct and well-structured**. Against the original
26-week draft it was a **schedule and checklist, not yet an executable program**.
That gap is closing: owners and deadlines now sit in 03 §8, the Guardian is
decided (ADR-038), and the SDK location is `packages/addon-sdk`. Remaining
program-level gaps are the `Depends on` column, per-phase Definition of Done,
and the Phase 9 feasibility spike — not the day-level "on track" status of the
planning work itself.

**Recommendation:** approve the architecture direction now; the timetable has since
been re-baselined to ~12 weeks. Keep the ratification decisions owned and sequenced
before opening later phases.

---

## 2. What is solid

1. **Correct reconciliation.** The plan correctly carried the PDF v2 architecture
   forward from the DOCX (then decided as ADR-038: Guardian = deterministic
   restart/roll-back; Engineer AI advisory) and kept the DOCX security
   invariants (P1–P7, capability classes, caller attribution, commit boundary,
   host-held credentials, provenance, Ground-0 recovery). This is the right call.
2. **Concrete anchoring.** Phases map onto real repository work: fork cleanup,
   PRs #327–#331, ADR-006/018/023/026, and the existing add-on SDK. The plan is
   not greenfield.
3. **Good invariant framing.** "Prepare is not commit," "caller identity survives
   delegation," and "information is not authority" give every phase a testable
   security property.
4. **Checkpoints are verifiable.** Each checkpoint has a concrete exit condition,
   which is rare and valuable.
5. **Correct ordering of the critical path.** Consolidate → lock architecture →
   rebuild SDK → certify → market → govern → harden is the right dependency order.

---

## 3. Gaps and risks

### 3.1 Gate-blocking decisions

Ratification items **R6** (on-chain vs off-chain + network) and **R7** (signing-key
custody/multisig) gate Phases 7–10. Owners and deadlines are now in the decisions
register (R6 → Governance lead / CP-4 2026-10-23; R7 → Release/Security lead /
CP-4 2026-10-23). They still need feasibility work and are not yet promoted into
Phases 6/7. **Promote them into Phase 6/7 with those deadlines as the spike gate.**

### 3.2 Phase 9 (Developer NFT) has unmodeled complexity

Developer NFTs carry legal/regulatory, key-custody, transfer-control, and identity
mapping complexity that the plan compresses into three weeks. Before committing
that window, add a **feasibility spike** with an explicit stop/replan decision
point.

### 3.3 Prerequisites are implied, not explicit

Several phases overlap (e.g., Phase 3 and Phase 4 run "alongside" Phase 2), but
the plan does not state what each depends on. For example:

- Phase 3 (browser edge) needs an upstream owner for the field classifier — an
  **upstream contribution**, not an internal-only change.
- Phase 4 (credentials/provenance) depends on the Phase 1 Authority Plane ADR.

Add a `Depends on` column to the phase table.

### 3.4 No cross-phase testing strategy

The plan says "negative tests" and "fail closed" but does not define a single
Definition of Done or a cross-phase test strategy. The DOCX and PDF both emphasize
negative security suites, but the master plan does not specify who writes them,
where they run, or what "green" means per phase.

### 3.5 Capacity is not modeled

The compressed timeline assumes enough engineers to run three parallel tracks
(security, governance, marketplace). No staffing assumption is stated, so a slip
in any track silently re-baselines the others.

### 3.6 No replan trigger

If CP-0 slips (and the fork resubmission is already at risk), there is no defined
"stop and re-baseline" rule. Add one: if any checkpoint on the critical path slips
by more than one week, re-baseline before opening new parallel work.

### 3.7 DOCX→PDF carry-forward is asserted, not audited

The plan says the DOCX invariants are "carried forward," but there is no
item-by-item audit proving nothing was dropped. The DOCX's browser field
classifier, commit-broker capability families, and reviewed-exception format are
the most likely items to be lost in translation. Add a short mapping table.

---

## 4. Recommended changes

1. **Add owners and dependencies** to the phase table (§3 of the master plan).
2. **Promote R6 and R7** into Phases 6/7 with owners and deadlines; treat them as
   prerequisites, not follow-ups.
3. **Insert a feasibility spike before Phase 9**, with a go/no-go decision.
4. **Add a per-phase Definition of Done** and a cross-phase negative-test strategy.
5. **Add a replan trigger** for critical-path slips.
6. **Add an explicit carry-forward audit** mapping every DOCX work item to a phase
   or a recorded "superseded/dropped" disposition.

---

## 5. Phase-by-phase observations

| Phase                          | Observation                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Consolidate & secure       | Correct to finish first. The fork resubmission is the real schedule risk; treat CP-0 as the program's first gate, not a formality. |
| 1 — Lock Guardian architecture | Must resolve R1 (Guardian/Engineer boundary) here, not later; it determines the SDK and recovery design.                           |
| 2 — Reconstruct REF/SDK        | Highest technical risk. Keep the "reconstruct, not resurrect" rule; port the strongest REF pieces in reviewable slices.            |
| 3 — Harden browser edge        | Needs an upstream owner and merge strategy for the field classifier before this phase can be estimated.                            |
| 4 — Credential & provenance    | Depends on Phase 1 ADR; do not start before the Authority Plane invariants are accepted.                                           |
| 5 — Recovery proof             | Well-scoped; make the outage matrix explicit (Augmentor, add-on, marketplace, DAO, chain, provider).                               |
| 6 — Certification substrate    | Solid; version/hash-bound certification is the right primitive.                                                                    |
| 7 — Marketplace registry       | Blocked by R7 (signing-key custody). Resolve first.                                                                                |
| 8 — DAO constitution           | Blocked by R4/R5/R6/R3. Resolve thresholds and conflicts before drafting.                                                          |
| 9 — NFT prototype              | Add feasibility spike + go/no-go; treat "role is not root" as the acceptance test.                                                 |
| 10 — Governance integration    | Depends on Phases 6–9; fine as a merge point.                                                                                      |
| 11 — Marketplace pilot         | Good; the revocation drill and malicious-update test are the right acceptance proofs.                                              |
| 12 — Kernel governance         | Correct to separate from marketplace; keep the protected path for kernel-class changes.                                            |
| 13 — Production hardening      | Add the governance attack simulations early enough to feed back into Phases 8–10, not only at the end.                             |

---

## 6. Bottom line

Adopt the architecture direction now. Convert the schedule into an executable
program by adding owners, dependencies, a test strategy, a replan trigger, and by
promoting the gate-blocking ratification decisions into their owning phases. With
those changes, the plan is ready to run; without them, it will drift.
