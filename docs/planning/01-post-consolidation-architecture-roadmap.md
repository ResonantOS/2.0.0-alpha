# ResonantOS Post-Consolidation Architecture Roadmap

**Source:** `ResonantOS_Post_Consolidation_Architecture_Roadmap_2026-09-14.docx`
**Date:** 14 September 2026
**Status:** Proposal (superseded in part by the
[SDK + DAO Governance Roadmap](02-sdk-dao-governance-roadmap.md) — see the
reconciliation note at the end.)

> **Current (2026-09-16):** this is the structured transcription of the 14 Sep
> DOCX. It is **superseded in part** by the PDF v2 (Guardian / Engineer) and then
> by Tom's 16 Sep sync (ADR-038, one Augmentor in `apps/augmentor`, SDK at
> `packages/addon-sdk`). See the [master plan](03-master-implementation-plan.md)
> "Current direction" section. The "fused Augmentor" identity below is historical.

> **Core decision:** The Augmentor is the permanent executive intelligence of
> ResonantOS, but ResonantOS — not the Augmentor — is the root of authority.

---

## Executive summary

The Augmentor consolidation should be treated as the **physical integration
step**, not the completion of the ResonantOS extension architecture. Moving
Augmentor into the ResonantOS repository strengthens the case for a permanent
first-party orchestration plane, but it also makes the trust boundary between
Augmentor, ResonantOS policy, and third-party extensions more important.

Augmentor reasons, coordinates, preserves continuity, and proposes actions. The
ResonantOS **authority plane** authenticates callers, evaluates capabilities,
holds credentials, records provenance, enforces commit boundaries, and authorizes
execution.

### What the consolidation changes

- Augmentor becomes a first-party ResonantOS component rather than a parallel
  product.
- The browser extension must be treated as an enforcement edge because it can
  inspect the live DOM and action context.
- The add-on SDK becomes more important: external harnesses and plugins need one
  governed path into ResonantOS.
- Public, privileged, and core-only capabilities should be separated explicitly.
- The proposed human commit boundary should become a system primitive.

### What does not change

The earlier conclusions about Ground-0, caller attribution, host-held
credentials, capability-scoped add-ons, and a VS Code-like extension framework
remain valid.

---

## 1. Architectural principles to lock

| ID  | Principle                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Fused Augmentor.** ResonantOS always contains a first-party Augmentor orchestration plane; it is not replaceable by a normal add-on or external harness.                                      |
| P2  | **Authority remains in ResonantOS.** Augmentor is privileged but not root. Policy, grants, credentials, trust roots, and irreversible-action authorization remain host-controlled.              |
| P3  | **Caller identity survives delegation.** An add-on cannot launder its identity by delegating through Augmentor. The originating principal and capability ceiling follow the request end-to-end. |
| P4  | **Information is not authority.** Web pages, email, documents, memory, and model output are evidence, not executable instructions.                                                              |
| P5  | **Prepare is not Commit.** Research, navigation, comparison, form preparation, drafting, and action packets are distinct from irreversible execution.                                           |
| P6  | **Secrets stay host-held.** Add-ons receive mediated handles or routed operations, not raw credentials.                                                                                         |
| P7  | **Enforcement happens at the edge.** Browser, filesystem, network, connector, blockchain, and OS boundaries revalidate authorization using the context available at that edge.                  |

---

## 2. Target system architecture

Six cooperating layers, with intelligence, policy, extensibility, and enforcement
as separate responsibilities:

| Layer                        | Primary responsibility                                                                            | Trust position                |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| User / UX                    | Intent, review, approval, final human decisions                                                   | Human authority               |
| Fused Augmentor              | Reasoning, orchestration, continuity, Ground-0 interaction, proposals                             | Privileged first-party        |
| ResonantOS Authority Plane   | Identity, caller attribution, capabilities, policy, commit broker, audit, credentials, provenance | Root software authority       |
| Resonant Extension Framework | Manifest validation, SDK contracts, lifecycle, signatures, certification, routing                 | Governed extension boundary   |
| Add-ons / Agent Runtimes     | First-party plugins, certified third parties, sideloaded experimental workers                     | Bounded delegated authority   |
| Enforcement Edges            | Browser, network, filesystem, connectors, archive, blockchain, native bridge                      | Final contextual revalidation |

**Authority invariant:** `Authority(add-on) < Authority(Augmentor) <
Authority(ResonantOS policy)`. Augmentor may be the executive intelligence
without becoming the security kernel.

---

## 3. Fused Augmentor contract

Consolidation should formalize a special architectural role for Augmentor using
SDK-style interfaces where practical, but **not** as an ordinary marketplace
add-on.

Required properties:

- Permanent first-party component of the supported ResonantOS product.
- Available in Ground-0 without third-party add-ons, cloud services, or a
  marketplace.
- Owns orchestration and conversational continuity, not policy override.
- Cannot mint arbitrary third-party authority or erase caller identity.
- Uses host services for credentials, privileged browser actions, archive
  authority, and consequential commits.
- Supports degraded operation when optional add-ons, providers, or harnesses fail.

### Ground-0 minimum

Ground-0 consists of ResonantOS core, the Fused Augmentor, the basic user
interface, policy and identity services, a minimal model route, memory/identity
gatekeeping, and recovery tooling. Third-party runtimes, registries, cloud
providers, and optional plugins must not be required to restore a working user
relationship.

---

## 4. Browser and extension boundary

The proposed live-element field classifier should be accepted upstream and
generalized into a reusable **browser action policy**. A downstream agent that
only sees a selector cannot reliably determine whether the target is a password,
payment, hidden, cross-origin, or otherwise sensitive element.

Conceptual contract:

```
BrowserActionPolicy.inspect(target)
BrowserActionPolicy.classify(target)
BrowserActionPolicy.authorize(action, target, caller)
```

The browser extension acts as a reference monitor for browser actions,
re-checking live DOM semantics, origin, field class, navigation state, and other
browser-only facts immediately before execution.

---

## 5. SDK and capability contract

The Resonant Extension Framework remains the correct integration model, but
consolidation makes capability separation urgent.

| Capability class | Who may receive it                                               | Examples                                                                                              |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Public           | Certified/approved third-party add-ons                           | `browser.observe`; `archive.read`; `notifications.show`; `task.delegate`                              |
| Privileged       | Signed first-party components and narrowly reviewed integrations | `browser.commit`; `connector.credentialBroker`; `archive.admin`; `system.recovery.request`            |
| Core-only        | Not exposed through the add-on SDK                               | `policy.override`; `trustRoot.modify`; `credential.export`; `ground0.replace`; `signatureRoot.modify` |

### Caller attribution

Caller attribution is a mandatory invariant. When an add-on delegates through
Augmentor, the bridge sees the originating principal, the delegation chain, the
requested capability, and the scope. Augmentor must not become a confused deputy.

Example audit identity:
`principal=addon.weather-analysis; delegated-through=augmentor;
capability=browser.form.fill; scope=approved-origin`.

---

## 6. Commit boundary as an OS primitive

```
OBSERVE → REASON → PREPARE → PROPOSE → [ COMMIT BOUNDARY ] → EXECUTE
```

Capabilities must reflect this split. `commerce.observe` and `commerce.prepare`
must not imply `commerce.commit`; `messaging.compose` must not imply
`messaging.send`; `booking.prepare` must not imply `booking.commit`.

Reviewed exceptions may exist where autonomous commitment is lawful, technically
supported, and explicitly approved. Such exceptions bind the add-on identity,
publisher, capability, scope, limits, destination, expiry, authorization record,
and reviewed integration version. A generic user toggle is insufficient.

---

## 7. Credentials, provenance, and untrusted content

Host-held connector credentials become a standard authority-plane service.
External runtimes receive opaque provider/connector handles and mediated calls;
raw secrets must not transit normal add-on payloads.

The authority plane preserves provenance. Content from web pages, email,
documents, model responses, retrieved archives, and external plugins remains
labeled by origin. Content can inform a proposal but cannot silently acquire
instruction authority.

---

## 8. Third-party add-on model

Third-party harnesses are **workers**, not peers of the Fused Augmentor. Agent
Zero, DeepSeek-style harnesses, blockchain modules, CAD agents, and future
integrations enter through manifests, declared capabilities, scoped grants,
auditing, and certification.

No third-party manifest may declare itself the system boss, replace Ground-0,
bypass the authority plane, obtain unrestricted credentials, or acquire an
aggregate full-control capability.

---

## 9. Proposed roadmap

| Phase                                  | Objective                                         | Key deliverables                                                                                                        | Exit gate                                                                  |
| -------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0 — Consolidate                        | Land Augmentor safely                             | Complete subtree integration; release bridge; npm maintainer redundancy; legacy asset retention policy                  | Current clients can migrate and repository CI owns future release path     |
| 1 — Define authority                   | Lock post-consolidation architecture              | ADR for Fused Augmentor; authority-plane ADR; Ground-0 definition; information-vs-authority rule                        | Roles and non-bypassable trust boundaries accepted                         |
| 2 — Harden browser edge                | Move browser semantics to enforcement layer       | Upstream field classifier; reusable BrowserActionPolicy; sensitive-field/origin/mutation tests                          | Browser actions fail closed on unsafe live context                         |
| 3 — Rebuild REF on current dev         | Reintroduce SDK against consolidated topology     | Public/Privileged/Core capability split; manifest contract; package boundary; mock host; migration from closed PR stack | SDK compiles/tests against current post-consolidation dev                  |
| 4 — Caller attribution                 | Prevent confused-deputy delegation                | Caller-bound grants/tokens; delegation-chain propagation; revocation; bridge audit                                      | Originating principal survives Augmentor and external-runtime delegation   |
| 5 — Commit broker                      | Separate preparation from consequential execution | Prepare/propose/commit capability families; reviewed-exception format; human handoff packets                            | Irreversible actions cannot be inferred from preparatory authority         |
| 6 — Credential and provenance services | Centralize secrets and trust context              | Host credential broker; opaque handles; provenance labels; untrusted-content policy                                     | No normal add-on path exposes raw secrets or promotes content to authority |
| 7 — Third-party certification          | Open governed ecosystem                           | Signing, publisher identity, certification, lifecycle, sideload policy, negative security suite                         | Certified add-ons operate within enforceable capability ceilings           |
| 8 — Ground-0 recovery proof            | Prove system resilience                           | Disable providers/add-ons/registry; recover with core + Fused Augmentor; restore optional layers                        | User retains a working ResonantOS relationship under subsystem failure     |

---

## 10. Decisions requested now

| ID  | Decision                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------ |
| D1  | Approve the Fused Augmentor role — permanent first-party orchestration, not a normal add-on and not root.          |
| D2  | Accept the field classifier upstream; generalize it into the browser enforcement policy.                           |
| D3  | Promote capability separation into Public / Privileged / Core-only classes in the next REF reconstruction.         |
| D4  | Make caller attribution mandatory through Augmentor and all external runtimes.                                     |
| D5  | Adopt the commit boundary as a deeper prepare/propose/commit system contract.                                      |
| D6  | Keep credentials host-held; prohibit raw secret delivery to ordinary add-ons.                                      |
| D7  | Reconstruct rather than resurrect — port the strongest earlier REF/SDK pieces onto current dev.                    |
| D8  | Define Ground-0 acceptance tests; make recovery without optional providers/plugins/registries a testable property. |

---

## 11. Recommended immediate work order

1. Finish the consolidation/release bridge without expanding behavioral scope.
2. Land the Fused Augmentor + ResonantOS Authority Plane ADR.
3. Upstream the browser field classifier and add browser-policy negative tests.
4. Introduce the three-class capability taxonomy.
5. Rebuild caller attribution and delegation-chain enforcement against current dev.
6. Add the commit broker and prepare/propose/commit capability families.
7. Add host credential mediation and provenance enforcement.
8. Reintroduce external-agent-runtime examples and SDK conformance tests.
9. Prove Ground-0 recovery before broad third-party add-on enablement.

---

## 12. Non-goals

This roadmap does **not** require Augmentor to become a generic replaceable
harness; does not grant it unrestricted root access; does not require all add-ons
to be first-party; does not prohibit future autonomous transactions with a
reviewed exception; and does not require the entire previous REF branch stack to
be merged unchanged.

---

## 13. Reconciliation note

The [SDK + DAO Governance Roadmap](02-sdk-dao-governance-roadmap.md) (PDF v2,
same date) **supersedes** the "Fused Augmentor" identity in this document. Under
the revised model:

- The **Guardian/Engineer** is the persistent system-stability role.
- The **Augmentor** is a governed AI/orchestration component, no longer fused to
  the kernel.
- The SDK, certification pipeline, marketplace, developer NFTs, and Resonant DAO
  are added as the governance layers.

The principles P1–P7 and the engineering work items above remain valid and are
carried forward into the
[master implementation plan](03-master-implementation-plan.md), with the
Guardian/Engineer model applied instead of the Fused Augmentor identity.
