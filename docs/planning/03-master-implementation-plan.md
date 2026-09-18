# ResonantOS Master Implementation Plan

**Date:** 2026-09-16 (updated 2026-09-17 after Tom's PR #453 review)
**Status:** Proposed plan — for review and ratification by the development team.
**Horizon:** ~12 weeks (2026-09-14 → 2026-12-04) is the **team's proposal**, not a
ratified schedule. Revised down from the original 26-week estimate.

This is the reconciled execution plan derived from the two 2026-09-14 source
documents, re-based against the repository's actual development velocity.

---

## Current direction (from Tom, 2026-09-16)

Tom's 16 Sep sync report is the authoritative current direction. Key points that
sharpen or update this plan:

- **One Augmentor** — Manolo's **DeepSeek Harness Augmentor** is the product and
  keeps the name. It was imported with full history into `apps/augmentor` (#448).
  ResonantOS wraps it (governance, memory, integrations); the harness engine runs
  in OS-level confinement.
- **Guardian is decided** — ADR-038 (#452) defines the Guardian as a small,
  deterministic service that can only restart or roll back (no model), and defines
  the Core-only invariants. The **Engineer AI** advises but holds no recovery
  authority. New ADRs start at 039.
- **SDK location** — the add-on SDK moved from `src/sdk/addons` to
  `packages/addon-sdk` (#441).
- **Privilege split (Tom's §13.2, proposed — needs Manolo)** — only the parts that
  hold authority get privileges: the actuation executor with its field classifier,
  the commit broker, credential custody, and the update channel. Everything else
  stays first-party but runs as a public extension.
- **Decided product behaviors** — payment/checkout: the agent prepares and hands
  off; automating checkout needs a reviewed exception (never a setting).
  Personal-contact fields: named disclosure per destination (not built yet).
  Unrecognised controls: human-only (#451).
- **Two-person review on invariant paths (Tom's §13.10)** — a working assumption,
  not yet applied.
- **Demo is on hold** pending a shared demo scope + code location (the prototype
  SDK in `examples/sdk-prototype/`).
- **Scope decision (Tom, 2026-09-17, open)** — whether DAO, NFT, and marketplace
  work is **in or out** is undecided. Phases 6–11 and decisions R3–R10 are
  **undecided proposals, not scheduled work** until Tom settles this. Certification
  substrate (Phase 6) and marketplace (Phases 7/11) are part of that open scope.

---

## 1. Reconciliation

The two source documents agree on the security model but differ on one identity
question. The plan applies the following resolution:

| Question                                | Resolution                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the Augmentor fused to the kernel?   | **No.** The DOCX "Fused Augmentor" identity is superseded; the Guardian model is now decided by ADR-038 (#452).                                                                                             |
| Who is the persistent stewardship role? | The **Guardian** — a small deterministic restart/roll-back service (ADR-038); the Engineer AI advises but holds no recovery authority.                                                                      |
| What is the Augmentor's role?           | A governed first-party AI/orchestration component under the Authority Plane.                                                                                                                                |
| What is carried forward from the DOCX?  | Principles P1–P7, the Public/Privileged/Core-only capability split, caller attribution, the commit boundary, host-held credentials, provenance labels, Ground-0 recovery, and the browser field classifier. |
| What is added by the PDF v2?            | Certification, marketplace, developer NFTs, and Resonant DAO governance.                                                                                                                                    |

**Authority invariant (authoritative):**

```
The Guardian protects the baseline; the Authority Plane controls runtime
authority; Augmentor and add-ons operate within those boundaries; DAO governance
cannot silently bypass them.
```

---

## 2. Guiding principles

1. **Prepare is not commit.** Consequential actions always cross a governed commit
   boundary.
2. **Caller identity survives delegation.** No authority laundering through
   Augmentor or external runtimes.
3. **Information is not authority.** External content and model output are
   evidence only.
4. **Secrets stay host-held.** Raw credentials never transit ordinary add-on
   payloads.
5. **Capability classes are enforced.** Public / Privileged / Core-only are
   separate surfaces, not a single undifferentiated namespace.
6. **Enforcement happens at the edge.** Browser, filesystem, network, connector,
   blockchain, and OS boundaries revalidate authorization.
7. **Ground-0 survives everything above it.** Augmentor, add-ons, marketplace, DAO,
   chain, and providers may fail without destroying recovery.

---

## 3. Timeline re-baseline — why 26 weeks became ~12 weeks

The first draft scheduled **26 weeks** (to 2027-03-12) and treated the SDK as
largely greenfield. Reviewing the repository history showed that assumption was
wrong, so the team **proposes** ~12 weeks (to 2026-12-04). This ~12-week figure
is the team's proposal and is not yet ratified by Tom; the DAO/NFT/marketplace
portion of it is additionally gated on Tom's open scope decision.

### 3.1 Velocity evidence

| Month                    | Commits (all refs) |
| ------------------------ | ------------------ |
| 2026-05                  | 121                |
| 2026-06                  | 282                |
| 2026-07                  | 197                |
| 2026-08                  | 675                |
| 2026-09 (first ~11 days) | 319                |

- **1,594 total commits** across all refs, and the pace is accelerating
  (~30 commits/day in September).
- **`beta.1` shipped 2026-08-22** as a large, complete release (Augmentor
  features, recipes, ROSI design system, OpenCode parity, Agent Control security
  hardening, add-on governance).

### 3.2 Already built (the plan originally counted this as "to build")

- Add-on SDK V0 — `src/sdk/addons/` (legacy path; canonical at `packages/addon-sdk`
  per #441) (contracts, `validation.ts`, `registry.ts`, `surface-routing.ts`), per ADR-018.
- Add-on manifest catalog — `public/addons/*.json` (Augmentor Chat, Hermes,
  OpenClaw, OpenCode, Living Archive, …).
- Add-on lifecycle — install/uninstall/disable, capability cleanup, tombstone/
  `uninstalled` state (#180).
- Delegation confinement — `sandbox-exec` on macOS, audited runs (#326).
- Default-deny routes (#373).
- Host-held credentials — session-only provider creds, provider fabric routing.
- Caller-attributed tokens — already spiked (`pre-rebase/spike/caller-attributed-tokens`).
- Browser field safety — `content-field-safety.js` already in the extension; this
  ships the **unrecognised-controls-human-only** rule (#451), **not** the live-element
  field classifier (which is still open, pending §13.2 / Manolo's executor).
- Security/CI pipeline — workflow guards, drift checker, hygiene gate, secret
  scanning.
- **Prototype SDK demo** — `examples/sdk-prototype/` (preinstalled harness +
  Augmentor (Manolo's DeepSeek Harness) + agent-built Grok-Build plugin, 9/9 tests).

### 3.3 Genuinely remaining

| Work                                                                                   | Size                                                |
| -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Explicit Public/Privileged/Core-only taxonomy + commit broker (prepare/propose/commit) | ~2–3 weeks (the prototype already proved the model) |
| Certification substrate + marketplace MVP                                              | ~2–3 weeks                                          |
| DAO governance pilot (constitution + NFT testnet + integration)                        | ~4–6 weeks (gated on ratification)                  |
| Kernel governance + hardening                                                          | ~2 weeks                                            |

### 3.4 Revised timeline (revisions over time)

Revisions R2–R4 are **undecided proposals** pending Tom's scope decision
(DAO/NFT/marketplace in or out); only R1 is agreed in-scope work.

| Revision                       | Focus                                                                                                                            | Phases | Target window                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- |
| **R1 — SDK to production**     | Finish capability classes, caller attribution, commit broker, browser policy, Ground-0 recovery                                  | 0–5    | Weeks 1–4 (by ~2026-10-09)   |
| **R2 — Governed distribution** | Certification substrate + marketplace MVP **(undecided — scope pending)**                                                        | 6–7    | Weeks 4–6 (by ~2026-10-23)   |
| **R3 — DAO governance pilot**  | DAO constitution, NFT testnet prototype, governance–certification integration, marketplace pilot **(undecided — scope pending)** | 8–11   | Weeks 6–10 (by ~2026-11-20)  |
| **R4 — Hardening**             | Kernel governance + production hardening **(undecided — scope pending)**                                                         | 12–13  | Weeks 10–12 (by ~2026-12-04) |

---

## 4. Unified phase model

Phases are numbered `0–13`. Each row records the source mapping, the build state,
and the exit gate.

| #   | Phase                                | Source                 | Build state                                                                                 | Exit gate                                                                             |
| --- | ------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 0   | Consolidate & secure                 | DOCX P0 + fork-cleanup | In progress                                                                                 | Clean fork on `upstream/dev`; CI owns the release path                                |
| 1   | Lock Guardian architecture           | PDF A + DOCX P1        | In progress (ADR-038 merged; Ground-0 + Authority Plane ADRs pending)                       | Guardian decided (ADR-038); Ground-0 contract + Authority Plane ADRs accepted         |
| 2   | Reconstruct REF/SDK                  | PDF B + DOCX P3/P4/P5  | Refinement (SDK at packages/addon-sdk)                                                      | Capability classes, caller attribution, commit broker tested against consolidated dev |
| 3   | Harden browser edge                  | DOCX P2                | Open (unrecognised controls human-only, #451; classifier into Manolo's executor still open) | `BrowserActionPolicy` fails closed on unsafe live context                             |
| 4   | Credential & provenance              | DOCX P6                | Refinement (host-held creds exist)                                                          | No raw-secret path; content cannot become authority                                   |
| 5   | Ground-0 recovery proof              | PDF C + DOCX P8        | New                                                                                         | User retains a working relationship under subsystem failure                           |
| 6   | Certification substrate              | PDF D + DOCX P7        | Undecided proposal (scope pending)                                                          | Certification is bound to a specific release                                          |
| 7   | Marketplace registry                 | PDF E                  | Undecided proposal (scope pending)                                                          | Registry accepts only validated releases                                              |
| 8   | DAO constitution                     | PDF F                  | Undecided proposal (scope pending)                                                          | Governance roles and thresholds ratified                                              |
| 9   | Developer NFT prototype              | PDF G                  | Undecided proposal (scope pending)                                                          | NFT roles work on testnet without runtime authority                                   |
| 10  | Governance–certification integration | PDF H                  | Undecided proposal (scope pending)                                                          | Eligibility and attestation enforced end-to-end                                       |
| 11  | Marketplace pilot                    | PDF I                  | Undecided proposal (scope pending)                                                          | Certified add-ons operate within capability ceilings                                  |
| 12  | Kernel governance integration        | PDF J                  | New                                                                                         | Kernel-class changes require the protected path                                       |
| 13  | Production hardening                 | PDF K                  | New                                                                                         | Production-ready                                                                      |

In the `Source` column: `DOCX P#` refers to the DOCX roadmap **phase** number
(§9), distinct from the principles P1–P7 in §2; `PDF A–K` refers to the PDF v2
implementation phases.

### Carry-forward audit (DOCX → plan)

Every DOCX work item is mapped to a phase or an explicit disposition, so nothing
is lost in translation.

| DOCX work item                                                             | Plan phase | Carry-forward disposition                                                                |
| -------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| Principles P1–P7                                                           | §2         | Carried forward verbatim                                                                 |
| Public / Privileged / Core-only capability split                           | 2          | Carried into Phase 2 (capability classes)                                                |
| Caller attribution + delegation chain                                      | 2          | Carried into Phase 2 (delegation-chain audit)                                            |
| Grant revocation                                                           | 2          | Carried into Phase 2 (caller-bound grants + revocation)                                  |
| Commit boundary (prepare/propose/commit)                                   | 2          | Carried into Phase 2 (commit-broker capability families)                                 |
| Reviewed-exception format                                                  | 2          | Carried into Phase 2 (bound add-on/publisher/capability/scope/limits/expiry record)      |
| Human handoff packets                                                      | 2          | Carried into Phase 2 (commit broker)                                                     |
| Bridge audit                                                               | 2          | Carried into Phase 2 (bridge audit trail)                                                |
| Host credential broker + opaque handles                                    | 4          | Carried into Phase 4 (host credential broker)                                            |
| Provenance labels + untrusted-content policy                               | 4          | Carried into Phase 4 (provenance + untrusted-content policy)                             |
| Browser field classifier + `BrowserActionPolicy`                           | 3          | Carried into Phase 3 (browser enforcement)                                               |
| Ground-0 recovery proof                                                    | 5          | Carried into Phase 5 (release-quality recovery tests)                                    |
| Third-party certification                                                  | 6          | Carried into Phase 6 (certification substrate)                                           |
| Non-browser enforcement edges (filesystem/network/connector/blockchain/OS) | 3, 4, 12   | Carried into Phases 3, 4, 12 (edge revalidation)                                         |
| Fused Augmentor identity                                                   | —          | Superseded — first by the PDF v2 Guardian/Engineer model, then decided by ADR-038 (#452) |

---

## 5. Timetable

Kickoff is **Monday 2026-09-14** (Week 1). The re-based plan runs **~12 weeks**
to **Friday 2026-12-04**. Windows below are the planned start/end weeks; adjacent
revisions intentionally overlap.

| Revision                   | Weeks | Target window                                       |
| -------------------------- | ----- | --------------------------------------------------- |
| R1 — SDK to production     | 1–4   | 2026-09-14 → 2026-10-09                             |
| R2 — Governed distribution | 4–6   | 2026-10-05 → 2026-10-23 (undecided — scope pending) |
| R3 — DAO governance pilot  | 6–10  | 2026-10-19 → 2026-11-20 (undecided — scope pending) |
| R4 — Hardening             | 10–12 | 2026-11-16 → 2026-12-04 (undecided — scope pending) |

### Critical path

```
R1 (finish the mostly-built SDK) → R2 (certification + marketplace) →
R3 (DAO governance pilot) → R4 (hardening)
```

### Parallel tracks

- **Security track:** browser policy (P3) and credentials/provenance (P4) run
  alongside the P2 SDK finish; P5 (recovery proof) closes it.
- **Governance track:** DAO constitution (P8) and NFT prototype (P9) run alongside
  certification (P6/P7); P10 merges governance with certification.

---

## 6. Checkpoints

A checkpoint is a dated milestone with a concrete, verifiable exit condition.

| Checkpoint | Date       | Exit condition                                                                                                                                             |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP-0       | 2026-09-25 | Fork resubmission clean; consolidation/release bridge landed; npm maintainer redundancy confirmed; CI owns the release path; prototype SDK demo committed. |
| CP-1       | 2026-10-02 | Ground-0 contract + Authority Plane ADRs ratified (Guardian already decided: ADR-038).                                                                     |
| CP-2       | 2026-10-09 | **R1 done** — capability classes, caller attribution, commit broker, browser policy, and Ground-0 recovery green.                                          |
| CP-3       | 2026-10-16 | (Undecided — scope pending) Certification substrate enforces version/hash-bound trust.                                                                     |
| CP-4       | 2026-10-23 | (Undecided — scope pending) **R2 done** — marketplace MVP verifies signatures, hashes, and certification.                                                  |
| CP-5       | 2026-11-06 | (Undecided — scope pending) DAO constitution ratified (roles, thresholds, conflicts, emergency powers).                                                    |
| CP-6       | 2026-11-13 | (Undecided — scope pending) Developer NFT prototype on testnet; role credentials and transfer restrictions.                                                |
| CP-7       | 2026-11-20 | (Undecided — scope pending) **R3 done** — governance–certification integration and marketplace pilot green.                                                |
| CP-8       | 2026-11-27 | Kernel governance integration: protected Guardian/kernel release workflow.                                                                                 |
| CP-9       | 2026-12-04 | **R4 done** — production hardening complete; playbooks and attack simulations done.                                                                        |

---

## 7. Master checklist

Checkboxes reflect the plan at re-baseline. Update them daily through the
[daily summary protocol](daily/README.md).

### Phase 0 — Consolidate & secure

- [ ] Finish fork resubmission (#327–#331 as smaller, tip-clean PRs).
- [ ] Verify no resubmitted branch contains the malicious workflow file.
- [ ] Land the consolidation/release bridge without expanding behavioral scope.
- [ ] Confirm npm maintainer redundancy and legacy asset retention policy.

### Phase 1 — Lock Guardian architecture

- [x] Ratify the Guardian ADR — done: ADR-038 (deterministic restart/roll-back service).
- [ ] Ratify the Ground-0 contract ADR.
- [ ] Ratify the Authority Plane invariants ADR.
- [x] Record the Augmentor de-fusion boundary — done: Manolo's DeepSeek Harness Augmentor (`apps/augmentor`).

### Phase 2 — Reconstruct REF/SDK

- [ ] Define the manifest/package contract.
- [ ] Implement Public / Privileged / Core-only capability classes.
- [ ] Implement caller attribution and delegation-chain propagation.
- [ ] Implement the prepare/propose/commit capability families.
- [ ] Add sideload trust and negative security tests.
- [ ] Port the strongest earlier REF/SDK pieces onto consolidated dev (reconstruct,
      not resurrect).
- [x] Maintain the runnable prototype SDK demo (`examples/sdk-prototype/`) for the
      community-leader presentation. _(delivered 2026-09-16)_

### Phase 3 — Harden browser edge

- [ ] Upstream the live-element field classifier.
- [ ] Generalize it into a reusable `BrowserActionPolicy`.
- [ ] Add sensitive-field, origin, and mutation negative tests.
- [ ] Verify browser actions fail closed on unsafe live context.

### Phase 4 — Credential & provenance services

- [ ] Implement the host credential broker with opaque handles.
- [ ] Implement provenance labels for external content.
- [ ] Implement the untrusted-content policy.
- [ ] Prove no normal add-on path exposes raw secrets or promotes content to
      authority.

### Phase 5 — Guardian & Ground-0 recovery proof

- [ ] Add failure injection for Augmentor, add-on, marketplace, and DAO outage.
- [ ] Implement rollback and known-good state recovery.
- [ ] Prove the user retains a working ResonantOS relationship under subsystem
      failure.

### Phase 6 — Certification substrate

- [ ] Define risk classes and test-evidence requirements.
- [ ] Implement version/hash-bound signatures.
- [ ] Implement reviewer attestations and recertification rules.

### Phase 7 — Marketplace registry

- [ ] Implement publisher identity and listing.
- [ ] Implement signature/certificate verification on publish.
- [ ] Implement update and revocation flows.

### Phase 8 — DAO constitution

- [ ] Ratify developer roles and NFT lifecycle.
- [ ] Ratify conflicts, promotion, and suspension rules.
- [ ] Ratify proposal classes and emergency powers.

### Phase 9 — Developer NFT prototype

- [ ] Implement role credentials and transfer restrictions.
- [ ] Implement wallet recovery and identity linkage.
- [ ] Demonstrate roles on testnet without granting runtime authority.

### Phase 10 — Governance–certification integration

- [ ] Implement eligibility checks.
- [ ] Implement vote/attestation thresholds.
- [ ] Implement immutable decision records.

### Phase 11 — Marketplace pilot

- [ ] Publish low-risk add-ons through the governed path.
- [ ] Run the emergency revocation drill.
- [ ] Run the malicious-update test.

### Phase 12 — Kernel governance integration

- [ ] Protect the Guardian/kernel release workflow.
- [ ] Enforce highest-level maintainer and constitutional paths for kernel-class
      changes.

### Phase 13 — Production hardening

- [ ] Complete security review and key recovery.
- [ ] Run governance attack simulations.
- [ ] Publish operational playbooks.

---

## 8. Decisions register

Resolved (2026-09-16): **D1** — Manolo's DeepSeek Harness Augmentor, de-fused;
**R1** — ADR-038 (Guardian = deterministic service, restart/roll-back only;
Engineer AI advisory). **D2 (field classifier) is NOT done** — #451 shipped only
"unrecognised controls stay human-only"; moving the classifier into Manolo's
executor is still open. Open items now have owners and deadlines in the tables
below; R3–R10 (DAO/NFT/marketplace) are **undecided proposals**, not scheduled work.

### 8.1 Near-term decisions (from the DOCX)

| ID  | Decision                                                               | Target phase   | Owner                                                         | Deadline          |
| --- | ---------------------------------------------------------------------- | -------------- | ------------------------------------------------------------- | ----------------- |
| D1  | Approve the Augmentor role (governed, not fused, not root)             | Phase 1 (done) | Maintainers (Tom) — resolved 2026-09-16 (#448)                | Met 2026-09-16    |
| D2  | Accept the field classifier upstream as the browser enforcement policy | Phase 3        | Browser lead — open (#451 covered unrecognised controls only) | CP-2 (2026-10-09) |
| D3  | Promote capability separation (Public/Privileged/Core-only)            | Phase 2        | SDK lead                                                      | CP-2 (2026-10-09) |
| D4  | Make caller attribution mandatory                                      | Phase 2        | SDK lead                                                      | CP-2 (2026-10-09) |
| D5  | Adopt the commit boundary (prepare/propose/commit)                     | Phase 2        | SDK lead                                                      | CP-2 (2026-10-09) |
| D6  | Keep credentials host-held                                             | Phase 4        | Security lead                                                 | CP-2 (2026-10-09) |
| D7  | Reconstruct rather than resurrect the earlier REF/SDK stack            | Phase 2        | SDK lead                                                      | CP-2 (2026-10-09) |
| D8  | Define Ground-0 acceptance tests                                       | Phase 5        | Security lead                                                 | CP-2 (2026-10-09) |

### 8.2 Ratification decisions (from the PDF v2)

| #   | Decision                                                                                                                            | Target phase          | Owner                        | Deadline                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------- | ------------------------------------- |
| R1  | Guardian implementation boundary — **resolved 2026-09-16 (ADR-038)**: deterministic restart/roll-back service; Engineer AI advisory | Phase 1 (in progress) | Architecture lead            | Met 2026-09-16                        |
| R2  | Which Augmentor functions remain first-party privileged vs. public extension                                                        | Phase 1               | Architecture lead + Manolo   | CP-1 (2026-10-02); §13.2 needs Manolo |
| R3  | NFT level names, promotion criteria, term/expiry, transferability, Tom's L4 nature                                                  | Phase 8               | Governance lead (Tom)        | Undecided — scope pending             |
| R4  | Voting thresholds and quorum per decision class                                                                                     | Phase 8               | Governance lead              | Undecided — scope pending             |
| R5  | Conflict-of-interest and self-certification rules                                                                                   | Phase 8               | Governance lead              | Undecided — scope pending             |
| R6  | On-chain vs. signed off-chain records and the DAO network                                                                           | Phase 8               | Governance lead (Tom)        | Undecided — scope pending             |
| R7  | Marketplace signing-key custody, rotation, recovery, multisig                                                                       | Phase 7               | Release/Security lead        | Undecided — scope pending             |
| R8  | Developer identity mapping (wallet, repo, publisher, certification)                                                                 | Phase 9               | Governance lead              | Undecided — scope pending             |
| R9  | Appeal, suspension, revocation, and recertification procedures                                                                      | Phase 10              | Governance lead              | Undecided — scope pending             |
| R10 | Constitutional mechanism to change Core-only invariants                                                                             | Phase 12              | Maintainers (constitutional) | Undecided — scope pending             |

---

## 9. Risk register

| Risk                                         | Impact                             | Mitigation                                                                 | Owned by phase |
| -------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- | -------------- |
| Fork resubmission slips                      | Blocks all SDK review              | Tip-scoped resubmission; backup intact; resubmit one PR at a time          | 0              |
| Augmentor identity ambiguity                 | Confused authority model           | Resolved: ADR-038 ratified; de-fusion boundary recorded (`apps/augmentor`) | 1 (closed)     |
| Single undifferentiated capability namespace | Core-only reachable via public SDK | Enforce three capability classes + negative tests                          | 2              |
| Confused-deputy delegation                   | Authority laundering               | Mandatory caller attribution + delegation-chain audit                      | 2              |
| Raw credential exposure                      | Secret exfiltration                | Host credential broker; opaque handles                                     | 4              |
| Ground-0 unavailable after subsystem failure | User lockout                       | Recovery proof + known-good state                                          | 5              |
| DAO becomes single point of failure          | Governance outage                  | Cached policy; Ground-0 independent of DAO                                 | 8              |
| NFT treated as runtime root                  | Privilege escalation               | Role is eligibility, not power; no key material in NFT                     | 9              |
| Malicious update bypasses review             | Supply-chain compromise            | Version/hash-bound certification; re-review on capability change           | 6/7/11         |
| Timeline optimism (compressed schedule)      | Missed checkpoints                 | Re-plan trigger: >1 week slip on the critical path re-baselines            | all            |

---

## 10. Reporting cadence

- **Daily:** [daily summary](daily/README.md) for the development team.
- **Weekly:** checkpoint review against the timetable in §5.
- **Revision exit:** verify the checkpoints in §6 before opening the next revision.

---

## 11. Definition of done (program)

- Every checkpoint in §6 has a dated, verifiable exit condition met.
- Every decision in §8 is ratified or explicitly deferred with a recorded reason.
- Ground-0 recovery and capability ceilings are demonstrated, not asserted.
- The daily summary log shows continuous, dated progress across all four revisions.
