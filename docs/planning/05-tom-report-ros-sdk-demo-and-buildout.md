# ROS-SDK Demo Status & Buildout Report

**To:** Tom
**From:** ResonantOS development team
**Date:** 2026-09-16
**Subject:** The SDK demo exists and its capability model is validated, but the
demo's add-on arrangement must be reworked before a demo date is set.

---

## 1. Summary

An SDK demo exists and its **capability model is validated** (deny-by-default,
prepare-is-not-commit, Public / Privileged / Core-only). But it is **not ready to
show** yet: it currently presents the **old Augmentor Chat** as "the Augmentor"
with a DeepSeek add-on beside it — the arrangement the One Augmentor decision
replaced. It must be reworked so **Manolo's DeepSeek Harness** is the Augmentor
before a demo date is set.

## 2. What is ready to show

### The demo

> **Status (2026-09-17):** the current prototype still shows the **old Augmentor
> Chat** add-on as "the Augmentor" with DeepSeek beside it. This is the
> arrangement One Augmentor replaced. The demo is therefore **on hold** until it
> is reworked so Manolo's DeepSeek Harness **is** the Augmentor.

| Piece                                        | What it is                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Preinstalled add-on harness**              | `examples/sdk-prototype/sdk.mjs` — loads, validates, and runs add-on plugins; mirrors the production SDK (`packages/addon-sdk`, ADR-018).                                            |
| **Augmentor (needs rework)**                 | `plugins/augmentor-chat/` — the **old** first add-on; must be replaced by Manolo's DeepSeek Harness as the Augmentor.                                                                |
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
this is the **team's proposal**, not a ratified schedule, and the DAO/NFT/
marketplace portion is additionally gated on your open scope decision. It is
re-based down from the original 26-week estimate after reviewing the repository's
actual velocity (1,594 commits; `beta.1` shipped 2026-08-22; ~30 commits/day in
September) and confirming the SDK is substantially already built. It is organized
into four **revisions** so each one is independently shippable and reviewable.

| Revision                               | Focus                                                                                                                     | Phases | Target window                | Key checkpoints |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | --------------- |
| **R1 — SDK to production**             | Finish the mostly-built SDK: capability classes, caller attribution, commit broker, browser policy, Ground-0 recovery     | 0–5    | Weeks 1–4 (by ~2026-10-09)   | CP-0 … CP-2     |
| **R2 — Governed distribution**         | Certification substrate + marketplace MVP **(undecided — scope pending)**                                                 | 6–7    | Weeks 4–6 (by ~2026-10-23)   | CP-3, CP-4      |
| **R3 — DAO governance pilot**          | DAO constitution, developer NFTs, governance–certification integration, marketplace pilot **(undecided — scope pending)** | 8–11   | Weeks 6–10 (by ~2026-11-20)  | CP-5 … CP-7     |
| **R4 — Kernel governance & hardening** | Protected kernel release workflow + production hardening **(undecided — scope pending)**                                  | 12–13  | Weeks 10–12 (by ~2026-12-04) | CP-8, CP-9      |

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
   `packages/addon-sdk`. What remains open: D2 (field classifier), D3–D8, R2, and
   the §13.2 privilege split (yours and Manolo's call). Confirmations will be
   **recorded in the decisions register** with date and approver.
2. **Settle the DAO/NFT/marketplace scope** — whether that work is in or out — so
   R3–R10 can be answered rather than deferred.
3. **Demo date: not yet.** The demo must first be reworked so Manolo's harness is
   the Augmentor; we'll book a date once that's done.
4. **Approve committing the planning documents as a single docs-only PR** off
   `upstream/dev` into `dev` (tip-clean, per the Phase 0 resubmission
   discipline), staging by path — do not `git add -A`:
   - PR (docs): `docs/planning/` + `docs/README.md` +
     `prompts/sdk-demo-prompt.md`.
     Stage **by path**. Do not `git add -A`. The prototype SDK code
     (`examples/sdk-prototype/`), the internal OMP review prompt, and unrelated
     working-tree dirt stay local and are **not** part of this PR.
5. **Confirm the target repository** — this repo (`ResonantOS/2.0.0-alpha`).

## 6. Where we differed — and how we converged

After reviewing your 16 Sep sync report, here is where our documents had drifted
from your direction, and what we changed to converge to your work.

| Area                       | Before (our docs)                                       | After (converged to your direction)                                                                                                                                                                                                                                                                                                            | Status                           |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Guardian                   | "Guardian/Engineer" as one role; Phase 1 listed as open | ADR-038: Guardian = small deterministic restart/roll-back service; Engineer AI advisory only. Phase 1 is **not complete** (Ground-0 + Authority Plane ADRs still pending).                                                                                                                                                                     | Recorded from ADR-038 / #452     |
| Augmentor                  | Generic "AI harness layer"                              | One Augmentor = Manolo's DeepSeek Harness Augmentor, imported into `apps/augmentor` (#448).                                                                                                                                                                                                                                                    | Recorded from #448               |
| SDK location               | `src/sdk/addons`                                        | `packages/addon-sdk` (#441).                                                                                                                                                                                                                                                                                                                   | Recorded from #441               |
| Node                       | `>=22.13.0`                                             | `24.21.0` (#448).                                                                                                                                                                                                                                                                                                                              | Recorded from #448               |
| Capability/privilege split | Public / Privileged / Core-only taxonomy                | Recorded your §13.2 split as **proposed, pending Manolo's agreement**: authority-holding parts (actuation executor + field classifier, commit broker, credential custody, update channel) privileged; the rest a first-party public extension. Field classifier itself is **not done** — #451 shipped only "unrecognised controls human-only". | Proposed — pending Manolo        |
| Product decisions          | Not captured                                            | Added payment/checkout handoff (reviewed exception, never a setting), named per-destination contact disclosure, unrecognised controls human-only (#451).                                                                                                                                                                                       | Recorded from #451               |
| Invariant-path review      | Not captured                                            | Added two-person review on invariant paths (§13.10).                                                                                                                                                                                                                                                                                           | Working assumption (not applied) |
| Timeline                   | 26 weeks                                                | Re-based to ~12 weeks from the repo's actual velocity.                                                                                                                                                                                                                                                                                         | Team proposal (not ratified)     |
| DAO / NFT / marketplace    | Scheduled as revisions R2–R4                            | Marked **undecided proposals** pending your open scope decision (in or out).                                                                                                                                                                                                                                                                   | Undecided — scope pending        |
| Demo                       | Not shared                                              | Scope + code location shared (`examples/sdk-prototype/`); on hold pending your review.                                                                                                                                                                                                                                                         | On hold pending your review      |

---

**Related documents**

- [Project state review](00-project-state-review.md)
- [Master implementation plan](03-master-implementation-plan.md)
- [Roadmap review](04-roadmap-review.md)
- [SDK demo test results & alpha integration](06-sdk-demo-test-results.md)
- [SDK demo prompt](../../prompts/sdk-demo-prompt.md)
