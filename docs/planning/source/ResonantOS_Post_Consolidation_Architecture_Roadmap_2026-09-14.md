# ResonantOS Post-Consolidation Architecture Roadmap

**Subtitle:** Fused Augmentor, Extension Framework, Authority Plane, and Add-on Security
**Original file:** `ResonantOS_Post_Consolidation_Architecture_Roadmap_2026-09-14.docx`
**Date:** 14 September 2026

> This file is a verbatim Markdown conversion of the source DOCX. It is retained
> as reference material. The reconciled, execution-oriented view lives in the
> [master implementation plan](../03-master-implementation-plan.md).

---

## Proposal for the roadmap following Augmentor consolidation

**Core decision:** The Augmentor is the permanent executive intelligence of
ResonantOS, but ResonantOS — not the Augmentor — is the root of authority.

This proposal responds to the Augmentor Consolidation document and the current
repository direction. It preserves the Fused Augmentor concept while defining the
security, SDK, browser, delegation, credential, and third-party add-on boundaries
required to make consolidation a stable architecture.

---

## Executive Summary

The Augmentor consolidation should be treated as the physical integration step,
not as the completion of the ResonantOS extension architecture. Moving Augmentor
into the ResonantOS repository strengthens the case for a permanent first-party
orchestration plane, but it also makes the trust boundary between Augmentor,
ResonantOS policy, and third-party extensions more important.

Our proposal is to keep Augmentor fused and non-replaceable in its system role,
while preventing it from becoming the security kernel. Augmentor reasons,
coordinates, preserves continuity, and proposes actions. The ResonantOS authority
plane authenticates callers, evaluates capabilities, holds credentials, records
provenance, enforces commit boundaries, and authorizes execution.

### What the consolidation changes

- Augmentor becomes a first-party ResonantOS component rather than a parallel
  product.
- The browser extension must be treated as an enforcement edge because it can
  inspect the live DOM and action context.
- The add-on SDK becomes more important: external harnesses and plugins need one
  governed path into ResonantOS.
- Public, privileged, and core-only capabilities should now be separated
  explicitly rather than deferred.
- The proposed human commit boundary should become a system primitive rather than
  remain only Future List wording.

### What does not change

The earlier conclusions about Ground-0, caller attribution, host-held credentials,
capability-scoped add-ons, and a VS Code-like extension framework remain valid.
The consolidation provides the missing architectural anchor around which those
pieces should now be finalized.

---

## 1. Architectural Principles to Lock

- **P1 — Fused Augmentor.** ResonantOS always contains a first-party Augmentor
  orchestration plane. It is not replaceable by a normal add-on or external
  harness.
- **P2 — Authority remains in ResonantOS.** Augmentor is privileged but is not
  root. Policy, grants, credentials, trust roots, and irreversible-action
  authorization remain host-controlled.
- **P3 — Caller identity survives delegation.** A third-party add-on cannot launder
  its identity by delegating through Augmentor. The originating principal and
  capability ceiling follow the request end-to-end.
- **P4 — Information is not authority.** Web pages, email, documents, retrieved
  memory, model output, and other external content are evidence. They do not
  become executable instructions merely because Augmentor can read them.
- **P5 — Prepare is not Commit.** Research, navigation, comparison, form
  preparation, drafting, and action packets are distinct from irreversible
  execution.
- **P6 — Secrets stay host-held.** Add-ons and external agent runtimes receive
  mediated handles or routed operations, not raw provider, connector, wallet, or
  account credentials.
- **P7 — Enforcement happens at the edge.** Browser, filesystem, network,
  connector, blockchain, and OS boundaries revalidate authorization using the
  context available at that edge.

---

## 2. Target System Architecture

The post-consolidation architecture should be organized into six cooperating
layers. The important distinction is that intelligence, policy, extensibility,
and enforcement are separate responsibilities.

| Layer | Primary responsibility | Trust position |
| --- | --- | --- |
| User / UX | Intent, review, approval, final human decisions | Human authority |
| Fused Augmentor | Reasoning, orchestration, continuity, Ground-0 interaction, proposals | Privileged first-party |
| ResonantOS Authority Plane | Identity, caller attribution, capabilities, policy, commit broker, audit, credentials, provenance | Root software authority |
| Resonant Extension Framework | Manifest validation, SDK contracts, lifecycle, signatures, certification, routing | Governed extension boundary |
| Add-ons / Agent Runtimes | First-party plugins, certified third parties, sideloaded experimental workers | Bounded delegated authority |
| Enforcement Edges | Browser, network, filesystem, connectors, archive, blockchain, native bridge | Final contextual revalidation |

**Authority invariant:** `Authority(add-on) < Authority(Augmentor) <
Authority(ResonantOS policy)`. Augmentor may be the executive intelligence
without becoming the security kernel.

---

## 3. Fused Augmentor Contract

Consolidation should formalize a special architectural role for Augmentor. It
should use SDK-style interfaces where practical, but it should not be represented
as an ordinary marketplace add-on.

### Required properties

- Permanent first-party component of the supported ResonantOS product.
- Available in Ground-0 without requiring third-party add-ons, cloud services, or
  an extension marketplace.
- Owns orchestration and conversational continuity, not policy override.
- Cannot mint arbitrary third-party authority or erase the caller identity of
  delegated work.
- Uses host services for credentials, privileged browser actions, archive
  authority, and consequential commits.
- Supports degraded operation when optional add-ons, providers, or external
  harnesses fail.

### Ground-0 minimum

Ground-0 should consist of ResonantOS core, the Fused Augmentor, the basic user
interface, policy and identity services, a minimal model route, memory/identity
gatekeeping, and recovery tooling. Third-party runtimes, registries, cloud
providers, and optional plugins must not be required to restore a working user
relationship.

---

## 4. Browser and Extension Boundary

The proposed live-element field classifier should be accepted upstream and
generalized into a reusable browser action policy. A downstream agent that only
sees a selector cannot reliably determine whether the target is a password,
payment, hidden, cross-origin, or otherwise sensitive element.

### Recommended browser policy surface

Conceptual contract:

```
BrowserActionPolicy.inspect(target)
BrowserActionPolicy.classify(target)
BrowserActionPolicy.authorize(action, target, caller)
```

The browser extension therefore acts as a reference monitor for browser actions.
It should re-check live DOM semantics, origin, field class, navigation state, and
other browser-only facts immediately before execution.

---

## 5. SDK and Capability Contract

The Resonant Extension Framework remains the correct integration model for plugins
and external agent runtimes. However, consolidation makes capability separation
urgent. A single undifferentiated capability namespace risks making first-party
internal authority reachable through a public SDK.

| Capability class | Who may receive it | Examples |
| --- | --- | --- |
| Public | Certified or approved third-party add-ons | `browser.observe`; `archive.read`; `notifications.show`; `task.delegate` |
| Privileged | Signed ResonantOS first-party components and narrowly reviewed integrations | `browser.commit`; `connector.credentialBroker`; `archive.admin`; `system.recovery.request` |
| Core-only | Not exposed through the add-on SDK | `policy.override`; `trustRoot.modify`; `credential.export`; `ground0.replace`; `signatureRoot.modify` |

### Caller attribution

Caller attribution should be a mandatory invariant. When an add-on delegates
through Augmentor, the bridge should see the originating principal, the delegation
chain, the requested capability, and the scope. Augmentor must not become a
confused deputy that converts third-party requests into first-party authority.

Required audit identity example:
`principal=addon.weather-analysis; delegated-through=augmentor;
capability=browser.form.fill; scope=approved-origin`.

---

## 6. Commit Boundary as an OS Primitive

The Future List rewrites reveal a common architecture: ResonantOS may observe,
reason, prepare, and propose before crossing a separately governed commit
boundary. This should become an SDK and host contract.

```
OBSERVE -> REASON -> PREPARE -> PROPOSE -> [ COMMIT BOUNDARY ] -> EXECUTE
```

Capabilities should reflect this split. For example, `commerce.observe` and
`commerce.prepare` should not imply `commerce.commit`; `messaging.compose` should
not imply `messaging.send`; `booking.prepare` should not imply `booking.commit`.

Reviewed exceptions may exist for integrations where autonomous commitment is
lawful, technically supported, and explicitly approved. Such exceptions should
bind the add-on identity, publisher, capability, scope, limits, destination,
expiry, authorization record, and reviewed integration version. A generic user
toggle is insufficient.

---

## 7. Credentials, Provenance, and Untrusted Content

Host-held connector credentials should become a standard authority-plane service.
External runtimes receive opaque provider or connector handles and mediated calls.
Raw secrets should not transit normal add-on payloads.

The same authority plane should preserve provenance. Content from web pages,
email, documents, model responses, retrieved archives, and external plugins must
remain labeled by origin. Content can inform a proposal but cannot silently
acquire instruction authority.

---

## 8. Third-Party Add-on Model

Third-party harnesses remain first-class ecosystem participants, but they are
workers rather than peers of the Fused Augmentor. Agent Zero, DeepSeek-style
harnesses, blockchain modules, CAD agents, and future integrations should enter
through manifests, declared capabilities, scoped grants, auditing, and
certification.

No third-party manifest should be able to declare itself the system boss, replace
Ground-0, bypass the authority plane, obtain unrestricted credentials, or acquire
an aggregate full-control capability.

---

## 9. Proposed Roadmap

| Phase | Objective | Key deliverables | Exit gate |
| --- | --- | --- | --- |
| 0 - Consolidate | Land Augmentor safely | Complete subtree integration; release bridge; npm maintainer redundancy; legacy asset retention policy | Current clients can migrate and repository CI owns future release path |
| 1 - Define authority | Lock post-consolidation architecture | ADR for Fused Augmentor; authority-plane ADR; Ground-0 definition; information-vs-authority rule | Roles and non-bypassable trust boundaries accepted |
| 2 - Harden browser edge | Move browser semantics to enforcement layer | Upstream field classifier; reusable BrowserActionPolicy; sensitive-field/origin/mutation tests | Browser actions fail closed on unsafe live context |
| 3 - Rebuild REF on current dev | Reintroduce SDK against consolidated topology | Public/Privileged/Core capability split; manifest contract; package boundary; mock host; migration from closed PR stack | SDK compiles/tests against current post-consolidation dev |
| 4 - Caller attribution | Prevent confused-deputy delegation | Caller-bound grants/tokens; delegation-chain propagation; revocation; bridge audit | Originating principal survives Augmentor and external-runtime delegation |
| 5 - Commit broker | Separate preparation from consequential execution | Prepare/propose/commit capability families; reviewed-exception format; human handoff packets | Irreversible actions cannot be inferred from preparatory authority |
| 6 - Credential and provenance services | Centralize secrets and trust context | Host credential broker; opaque handles; provenance labels; untrusted-content policy | No normal add-on path exposes raw secrets or promotes content to authority |
| 7 - Third-party certification | Open governed ecosystem | Signing, publisher identity, certification, lifecycle, sideload policy, negative security suite | Certified add-ons operate within enforceable capability ceilings |
| 8 - Ground-0 recovery proof | Prove system resilience | Disable providers/add-ons/registry; recover with core + Fused Augmentor; restore optional layers | User retains a working ResonantOS relationship under subsystem failure |

---

## 10. Decisions Requested Now

- **D1** — Approve the Fused Augmentor role. Treat Augmentor as permanent
  first-party orchestration, not a normal add-on and not the root security
  authority.
- **D2** — Accept the field classifier upstream. Generalize it into the browser
  enforcement policy used by Augmentor and SDK-driven browser tools.
- **D3** — Promote capability separation. Implement Public, Privileged, and
  Core-only classes in the next REF reconstruction rather than deferring the
  distinction.
- **D4** — Make caller attribution mandatory. Preserve originating principal and
  delegation chain through Augmentor and all external runtimes.
- **D5** — Adopt the commit boundary. Approve the Future List rewrites as the
  product expression of a deeper prepare/propose/commit system contract.
- **D6** — Keep credentials host-held. Treat credential mediation as an
  authority-plane service; prohibit raw secret delivery to ordinary add-ons.
- **D7** — Reconstruct rather than resurrect. Port the strongest pieces of the
  earlier REF/SDK PR stack onto the current post-consolidation dev branch instead
  of merging the old stack wholesale.
- **D8** — Define Ground-0 acceptance tests. Make recovery without optional
  providers, plugins, or registries a release-quality testable property.

---

## 11. Recommended Immediate Work Order

The next engineering work should avoid mixing the mechanical Augmentor move with a
large SDK rewrite. First finish the consolidation and migration mechanics. Then
land small architectural ADRs that lock roles and invariants. After those
decisions are accepted, reconstruct the REF/SDK implementation in narrow,
reviewable slices against the new repository topology.

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

## 12. Non-Goals for This Roadmap

This proposal does not require Augmentor to become a generic replaceable harness;
it does not grant the Fused Augmentor unrestricted root access; it does not
require all add-ons to be first-party; it does not prohibit future autonomous
transactions where an integration has a reviewed exception; and it does not
require the entire previous REF branch stack to be merged unchanged.

---

## Closing Position

The consolidation gives ResonantOS the right physical center. The roadmap above
gives it the trust architecture needed to remain extensible without turning the
Fused Augmentor or third-party add-ons into uncontrolled authority.

The desired end state is a system in which the user always has a stable
first-party Augmentor, developers can add powerful external capabilities through a
governed SDK, and every consequential action remains attributable, scoped,
auditable, revocable, and enforced at the boundary that actually understands the
action.

---

## Appendix A — Relationship to Existing Work

This proposal intentionally carries forward the strongest concepts from the
earlier Resonant Extension Framework and external-agent-runtime work: declarative
manifests, scoped capabilities, signing/certification, caller-attributed grants,
mock-host negative tests, host-mediated external runtimes, and default-deny bridge
behavior. Those concepts should now be reconciled with the consolidated Augmentor
topology and current development branch rather than treated as an independent
parallel architecture.

It also adopts the consolidation document's direction on live browser field
classification, host-held connector credentials, archive provenance, reviewed
commit boundaries, and plugin-based expansion.
