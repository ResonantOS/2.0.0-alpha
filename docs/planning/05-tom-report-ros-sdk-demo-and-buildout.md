# ROS-SDK Demo Status & Buildout Report

**To:** Tom
**From:** ResonantOS development team
**Date:** 2026-09-16
**Subject:** The SDK demo is built and ready to show, with a projected timeline to build the SDK out fully — delivered as revisions over time.

---

## 1. Summary

The ROS-SDK demo is **built, tested, and ready to show**. It demonstrates the
preinstalled add-on harness, the original **Augmentor** add-on, and a **DeepSeek**
plugin authored through the SDK by an agentic AI agent (oh-my-pi / OMP).

A projected timeline to build the SDK out to production is included below. It is
deliberately staged as **revisions over time**, so the SDK can ship and be shown
incrementally — with **DAO governance integration** arriving as a later revision
rather than blocking the first release.

## 2. What is ready to show

### The demo

| Piece                                        | What it is                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Preinstalled add-on harness**              | `examples/sdk-prototype/sdk.mjs` — loads, validates, and runs add-on plugins; mirrors the production SDK (`packages/addon-sdk`, ADR-018).                                            |
| **Augmentor (preinstalled add-on)**          | `plugins/augmentor-chat/` — the original first add-on (`addon.augmentor-chat`), preinstalled and pre-granted via `recommended-primary-chat`.                                         |
| **DeepSeek plugin (community-leader build)** | `plugins/deepseek-harness/` — mirrors the production `addon.deepseek-harness` contract; built through the SDK by the agent.                                                          |
| **Grok-Build plugin (second provider)**      | `plugins/grok-build/` — same prompt, different `<slug>`; proves the recipe is provider-agnostic. Full alpha results in [`06-sdk-demo-test-results.md`](06-sdk-demo-test-results.md). |

### What it demonstrates

- **Public / Privileged / Core-only** capability split (roadmap `D3`).
- **Deny-by-default** grants — nothing runs until the host grants a capability.
- **Prepare is not commit** — consequential work stops at `propose`, where a human
  approves the commit (roadmap `D5`).
- **Caller-attributed tool execution** — every tool declares its required
  capabilities and is gated on them.

> **Backend disclosure:** provider calls run against a **host-mediated simulated
> loopback service** (`http://127.0.0.1:3080`); no live DeepSeek or Grok API key
> is used. This is intentional — it proves host mediation without exposing a real
> credential in a demo. End-to-end Grok-Build results (prototype + production
> SDK + offline loopback, including the one-command `run-with-loopback.mjs`
> wrapper) are in [`06-sdk-demo-test-results.md`](06-sdk-demo-test-results.md).

### Run it

```bash
cd 2.0.0-alpha
node examples/sdk-prototype/run-demo.mjs examples/sdk-prototype/plugins/augmentor-chat   # preinstalled add-on
node examples/sdk-prototype/run-demo.mjs                                                  # DeepSeek (agent-built)
node --test examples/sdk-prototype/sdk.test.mjs
```

### Validation (all green)

- Prototype SDK tests: **11 / 11 pass**.
- Demo runs correctly across the three grant scenarios.
- Repository hygiene check passes (`npm run repo:hygiene`).

> Note (as of 2026-09-17): the prototype SDK demo still lives in the working
> tree (uncommitted) and is **not** part of the docs-only PR. It is ready to
> commit to a later feature branch off `upstream/dev` on your go-ahead.

## 3. Projected SDK buildout timeline (revisions over time)

The full buildout is **~12 weeks** from the 2026-09-14 kickoff, ending **~2026-12-04** —
re-based down from the original 26-week estimate after reviewing the repository's
actual velocity (1,594 commits; `beta.1` shipped 2026-08-22; ~30 commits/day in
September) and confirming the SDK is substantially already built. It is organized
into four **revisions** so each one is independently shippable and reviewable.

| Revision                               | Focus                                                                                                                 | Phases | Target window                | Key checkpoints |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | --------------- |
| **R1 — SDK to production**             | Finish the mostly-built SDK: capability classes, caller attribution, commit broker, browser policy, Ground-0 recovery | 0–5    | Weeks 1–4 (by ~2026-10-09)   | CP-0 … CP-2     |
| **R2 — Governed distribution**         | Certification substrate + marketplace MVP                                                                             | 6–7    | Weeks 4–6 (by ~2026-10-23)   | CP-3, CP-4      |
| **R3 — DAO governance pilot**          | DAO constitution, developer NFTs, governance–certification integration, marketplace pilot                             | 8–11   | Weeks 6–10 (by ~2026-11-20)  | CP-5 … CP-7     |
| **R4 — Kernel governance & hardening** | Protected kernel release workflow + production hardening                                                              | 12–13  | Weeks 10–12 (by ~2026-12-04) | CP-8, CP-9      |

### Phase detail

| Phase                                     | Objective                                                                 | Weeks |
| ----------------------------------------- | ------------------------------------------------------------------------- | ----- |
| 0 — Consolidate & secure                  | Finish fork cleanup/resubmission; land release bridge                     | 1–2   |
| 1 — Lock Guardian architecture            | Guardian decided (ADR-038); Ground-0 contract, Authority Plane invariants | 2–3   |
| 2 — Reconstruct REF/SDK                   | Capability classes, caller attribution, commit broker, manifest contract  | 2–4   |
| 3 — Harden browser edge                   | Field classifier + `BrowserActionPolicy`                                  | 3–4   |
| 4 — Credential & provenance               | Host credential broker, provenance labels                                 | 3–4   |
| 5 — Ground-0 recovery proof               | Failure injection and recovery                                            | 4     |
| 6 — Certification substrate               | Version/hash-bound certification, attestations                            | 4–5   |
| 7 — Marketplace registry                  | Publisher identity, verification, revocation                              | 5–6   |
| 8 — DAO constitution                      | Roles, thresholds, conflicts, emergency powers                            | 6–8   |
| 9 — Developer NFT prototype               | Role credentials, transfer restrictions (testnet)                         | 7–9   |
| 10 — Governance–certification integration | Eligibility + attestation thresholds                                      | 8–9   |
| 11 — Marketplace pilot                    | Low-risk add-ons, revocation drill, malicious-update test                 | 9–10  |
| 12 — Kernel governance integration        | Protected Guardian/kernel release path                                    | 10–11 |
| 13 — Production hardening                 | Security review, key recovery, attack simulations                         | 11–12 |

The full checklist, decisions register (D1–D8, R1–R10), and risk register are in
[`03-master-implementation-plan.md`](03-master-implementation-plan.md).

## 4. Incremental delivery approach

The SDK is built out in revisions rather than one big-bang release:

1. **R1 proves the SDK itself** — the demo becomes the production REF/SDK
   reconstruction (capability classes, caller attribution, commit boundary).
2. **R2 adds trusted distribution** — certification and the marketplace.
3. **R3 layers DAO governance on top** — developer roles, NFTs, and
   governance–certification integration, without re-architecting the SDK.
4. **R4 hardens the kernel path and production posture.**

This keeps the SDK shippable and demo-able at every revision, and it makes the
DAO governance integration a _later revision_ rather than a prerequisite for the
first working SDK.

## 5. What we need from you

1. **Confirm the convergence in §6** — the docs now reflect your 16 Sep decisions:
   the Guardian is decided (ADR-038: a deterministic restart/roll-back service; the
   Engineer AI advises but holds no recovery authority), there is one Augmentor
   (Manolo's DeepSeek Harness, `apps/augmentor`), and the SDK lives at
   `packages/addon-sdk`. What remains open: the unresolved items in the decisions
   register ([`03-master-implementation-plan.md`](03-master-implementation-plan.md)
   §8 — D3–D8 and R2–R10) and the §13.2 privilege split, which is yours and
   Manolo's call. Confirmations will be **recorded in the decisions register**
   with date and approver, so they do not evaporate into chat history.
2. **Confirm a demo date** — the demo is ready to show now.
3. **Approve committing the planning documents as a single docs-only PR** off
   `upstream/dev` into `dev` (tip-clean, per the Phase 0 resubmission
   discipline), staging by path — do not `git add -A`:
   - PR (docs): `docs/planning/` + `docs/README.md` +
     `prompts/sdk-demo-prompt.md`.
     Stage **by path**. Do not `git add -A`. The prototype SDK code
     (`examples/sdk-prototype/`), the internal OMP review prompt, and unrelated
     working-tree dirt stay local and are **not** part of this PR.
4. **Confirm the target repository by 2026-09-18** — the deadline set in the
   kickoff summary for where the planning docs land — so this does not sit
   uncommitted.

## 6. Where we differed — and how we converged

After reviewing your 16 Sep sync report, here is where our documents had drifted
from your direction, and what we changed to converge to your work.

| Area                       | Before (our docs)                                       | After (converged to your direction)                                                                                                                                                                                                            | Status                          |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Guardian                   | "Guardian/Engineer" as one role; Phase 1 listed as open | ADR-038: Guardian = small deterministic restart/roll-back service; Engineer AI advisory only. Phase 1 marked done.                                                                                                                             | Recorded from ADR-038 / #452    |
| Augmentor                  | Generic "AI harness layer"                              | One Augmentor = Manolo's DeepSeek Harness Augmentor, imported into `apps/augmentor` (#448).                                                                                                                                                    | Recorded from #448              |
| SDK location               | `src/sdk/addons`                                        | `packages/addon-sdk` (#441).                                                                                                                                                                                                                   | Recorded from #441              |
| Node                       | `>=22.13.0`                                             | `24.21.0` (#448).                                                                                                                                                                                                                              | Recorded from #448              |
| Capability/privilege split | Public / Privileged / Core-only taxonomy                | Recorded your §13.2 split as **proposed, pending Manolo's agreement**: authority-holding parts (actuation executor + field classifier, commit broker, credential custody, update channel) privileged; the rest a first-party public extension. | Proposed — pending Manolo       |
| Product decisions          | Not captured                                            | Added payment/checkout handoff (reviewed exception, never a setting), named per-destination contact disclosure, unrecognised controls human-only (#451).                                                                                       | Recorded from #451              |
| Invariant-path review      | Not captured                                            | Added two-person review on invariant paths (§13.10).                                                                                                                                                                                           | Working assumption              |
| Timeline                   | 26 weeks                                                | Re-based to ~12 weeks from the repo's actual velocity.                                                                                                                                                                                         | Recorded (velocity re-baseline) |
| Demo                       | Not shared                                              | Scope + code location shared (`examples/sdk-prototype/`); on hold pending your review.                                                                                                                                                         | On hold pending your review     |

---

**Related documents**

- [Project state review](00-project-state-review.md)
- [Master implementation plan](03-master-implementation-plan.md)
- [Roadmap review](04-roadmap-review.md)
- [SDK demo test results & alpha integration](06-sdk-demo-test-results.md)
- [SDK demo prompt](../../prompts/sdk-demo-prompt.md)
