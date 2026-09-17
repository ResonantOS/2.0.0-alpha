# ResonantOS SDK + DAO Governance Roadmap

**Subtitle:** Guardian / Engineer Architecture
**Original file:** `ResonantOS_SDK_DAO_Governance_Roadmap_Guardian_Engineer_2026-09-14_v2.pdf`
**Date:** 14 September 2026

> This file is a verbatim Markdown conversion of the source PDF (page headers and
> footers removed). It is retained as reference material. The reconciled,
> execution-oriented view lives in the
> [master implementation plan](../03-master-implementation-plan.md).

---

## Core proposition

The Guardian/Engineer preserves the integrity, stability, and recoverability of
ResonantOS. The Augmentor is no longer fused to the kernel; it is an
AI/orchestration component operating inside the governed environment. The SDK
defines how others build onto ResonantOS, certification governs trusted
distribution, and the Resonant DAO governs the developer authority behind those
processes.

This revision supersedes the earlier white-paper language that described the
Augmentor as fused or as the permanent executive intelligence of ResonantOS.

---

## Executive Summary

The future ResonantOS architecture should separate kernel stewardship, AI
orchestration, extension development, software certification, marketplace
distribution, and human governance. The Guardian/Engineer is the persistent
system-stability role: it protects Ground-0, supervises recovery and
architectural integrity, and provides a stable engineering authority beneath
replaceable or evolvable AI components.

The Augmentor therefore moves out of the constitutional kernel role. It may remain
a first-party ResonantOS AI component and may be deeply integrated into the user
experience, but it operates under the same ResonantOS Authority Plane that
constrains other privileged components. It can reason, orchestrate, coordinate
tools, and work with add-ons without becoming the root of authority.

Around this base, the Resonant Extension Framework and SDK define the technical
contract for extensions. A certification pipeline evaluates add-ons before
trusted marketplace publication. Developer NFTs identify members of the Resonant
development organization and their governance/certification level. The Resonant
DAO manages those roles, proposals, approvals, and policy changes.

> The DAO governs people and process. The Guardian/Engineer and ResonantOS
> Authority Plane protect the machine. Neither an NFT nor a DAO vote becomes a
> runtime root credential.

---

## 1. Revised Constitutional Architecture

| Layer | Primary responsibility | Authority boundary |
| --- | --- | --- |
| User | Intent, installation, grants, consequential approval | Final local human authority |
| ResonantOS Kernel / Ground-0 | Minimal trusted operating baseline | Core-only trust base |
| Guardian / Engineer | Integrity, stability, recovery, system engineering supervision | Protected kernel stewardship role |
| ResonantOS Authority Plane | Identity, caller attribution, capabilities, policy, credentials, audit, provenance | Runtime software authority |
| Augmentor / AI Harness Layer | Reasoning, orchestration, planning, tool coordination | Governed; not kernel root |
| REF / SDK | Extension manifests, APIs, lifecycle, capabilities, packaging | Governed extension boundary |
| Add-ons / External Harnesses | Third-party and first-party extensions | Bounded delegated authority |
| Certification + Marketplace | Review, signatures, listing, updates, revocation | Distribution trust |
| Resonant DAO | Developer roles, NFT levels, governance, certification policy | Human/organizational governance |

**Architectural invariant:** Guardian/Engineer protects the baseline; the
Authority Plane controls runtime authority; Augmentor and add-ons operate within
those boundaries; DAO governance cannot silently bypass them.

---

## 2. Guardian / Engineer Contract

The Guardian/Engineer is the persistent engineering and recovery role within
ResonantOS. It should be small enough to remain understandable and dependable, yet
capable of recognizing degraded system state, preserving a known-good Ground-0,
supervising recovery, and preventing extensions or AI harnesses from
destabilizing the kernel.

Its proposed responsibilities are:

- Maintain and verify the Ground-0 baseline and core health state.
- Detect extension, harness, bridge, policy, or configuration failures that
  threaten system stability.
- Coordinate safe recovery or rollback without depending on the failing add-on or
  AI harness.
- Protect kernel invariants and ensure Core-only surfaces cannot be acquired
  through ordinary SDK capabilities.
- Act as an engineering supervisor, not as a general-purpose user-facing boss AI.
- Remain operational when the Augmentor, marketplace, DAO interface, external
  models, or third-party services are unavailable.

The Guardian/Engineer should not become a marketplace add-on. Changes to it are
kernel-class changes subject to the strongest repository and governance review
path.

---

## 3. Augmentor After De-Fusion

The Augmentor remains valuable as a ResonantOS orchestration and intelligence
component, but its lifecycle is no longer identical to the kernel's. This creates
room for Augmentor evolution, alternate harnesses, specialized AI workers, and
future orchestration strategies without making system recovery depend on one AI
implementation.

- Augmentor may be a privileged first-party component, but privilege is explicit
  and capability-scoped.
- It may coordinate add-ons and external agent runtimes while preserving the
  originating caller identity.
- It may prepare and propose consequential actions but cannot erase the ResonantOS
  commit boundary.
- It may fail, restart, update, or eventually be replaced without destroying
  Ground-0.
- External content and model output remain information, not authority.

---

## 4. Maintaining the ResonantOS Kernel

Kernel stewardship covers what ResonantOS guarantees to every user: Ground-0,
Guardian/Engineer, Authority Plane, identity and provenance, capability
enforcement, credential mediation, recovery, and the minimal extension host.
Kernel changes therefore require a stronger process than marketplace add-ons.

- Canonical repository protection and mandatory CI/security verification.
- Highest-level maintainer review for Guardian/Engineer, Ground-0, trust-root, and
  Authority Plane changes.
- DAO credentials establish who is eligible to approve; repository controls and
  release signing enforce the decision.
- Emergency security action is narrow, logged, and followed by mandatory
  retrospective review.
- Ordinary DAO majorities and marketplace certification cannot grant Core-only
  runtime powers.

---

## 5. Future SDK Architecture

The SDK is the public construction contract for ResonantOS. It tells developers
how to create add-ons without exposing the internal authority needed to maintain
the kernel. The DAO governs changes to this contract and who may certify software
built against it; it does not replace the technical contract.

| Class | Who may request it | Examples |
| --- | --- | --- |
| Public | Certified/approved third-party add-ons | `browser.observe`; `archive.read`; `notifications.show`; scoped delegation |
| Privileged | First-party or explicitly reviewed integrations | `browser.commit`; credential-broker invocation; administrative archive functions |
| Core-only | Kernel / Guardian / Authority Plane only | `policy.override`; `trustRoot.modify`; `credential.export`; `ground0.replace`; signing-root modification |

Caller attribution remains mandatory: an add-on delegating through Augmentor
retains its own principal and capability ceiling. Augmentor cannot launder
third-party authority.

---

## 6. Building, Registering, and Certifying an Add-on

- **Create:** Build with the public SDK and declare identity, surfaces, runtime
  type, capabilities, scopes, and update policy.
- **Validate:** Run schema, compatibility, package-integrity, capability, and
  negative security tests.
- **Sideload:** Test under explicit unverified provenance without marketplace
  trust.
- **Register:** Submit publisher identity, package hash, source provenance,
  requested capabilities, risk class, and evidence.
- **Review:** Eligible Resonant developer reviewers inspect capability necessity,
  security, privacy, behavior, and update policy.
- **Certify:** Required reviewers attest to a specific add-on version/hash under a
  defined certification policy.
- **Publish:** Marketplace accepts only a package whose identity, hash, signature,
  certification, and SDK compatibility validate.
- **Install:** User chooses installation and grants only locally permitted
  capabilities.
- **Operate:** Authority Plane revalidates calls at runtime; certification never
  equals root authority.
- **Update / Revoke:** Material capability or behavior changes trigger re-review;
  security incidents can suspend certification/listing.

---

## 7. Marketplace Certification Object

Certification should be bound to a release, not merely to a developer reputation
or NFT.

| Required record | Why it matters |
| --- | --- |
| Add-on ID + version + package hash | Prevents post-review substitution |
| Publisher identity | Accountable origin |
| Capability set + risk class | Defines reviewed authority surface |
| Test evidence | Proves technical gates |
| Reviewer attestations + NFT role at review time | Proves authorized human review |
| Certification policy version | Identifies the rules used |
| Expiry / recertification trigger | Prevents stale trust |
| Revocation state | Supports incident response |

---

## 8. Resonant Developer NFT System

Developer NFTs are proposed as role credentials for the Resonant development
organization. They should preferably be non-transferable or tightly
transfer-controlled. They attest that a developer is eligible to perform defined
review or governance functions; they do not contain private signing keys and do
not grant runtime kernel access.

The level model below is intentionally provisional and should be ratified by a
governance ADR.

| Level | Illustrative role | Authority |
| --- | --- | --- |
| L0 | Contributor | Build, test, submit, discuss |
| L1 | Reviewer | Review low-risk submissions and attest test completion |
| L2 | Certifier | Approve normal marketplace certifications under threshold rules |
| L3 | Senior Maintainer | Privileged integration, SDK policy, release participation |
| L4 | Lead / Constitutional Maintainer | Highest developer stewardship level; kernel/Guardian review and emergency governance; initially envisioned for Tom |

> NFT level is eligibility, not unilateral power. The actual action still passes
> through repository protections, certification thresholds, signing
> infrastructure, DAO contracts or multisignature controls, and an auditable
> record.

---

## 9. Resonant DAO Voting and Approval

Technical certification and constitutional governance should not use one
undifferentiated token vote. Add-on review is an expert function; kernel and
organizational changes are higher-order governance functions.

| Decision | Proposed path |
| --- | --- |
| Low-risk add-on | Automated gates + eligible reviewer/certifier threshold; no full DAO vote |
| Normal marketplace add-on | Multiple certifier attestations + policy checks |
| Privileged/high-risk add-on | Senior maintainer + security review + elevated threshold |
| Public SDK contract change | Maintainer proposal + technical review period + developer governance approval |
| Guardian/Engineer or Ground-0 change | Highest review class + protected repository path + L3/L4 participation + constitutional threshold |
| NFT promotion | Contribution evidence + sponsorship + eligible higher-level vote |
| Emergency marketplace removal | Authorized rapid suspension + audit + mandatory post-action review |

---

## 10. Separation of Powers

- **Author:** creates and submits software.
- **Reviewer/Certifier:** evaluates a specific release and records an attestation.
- **Marketplace:** distributes only releases whose certification artifacts validate.
- **DAO:** governs developer roles, policy, thresholds, promotions, and
  constitutional proposals.
- **Repository/release infrastructure:** enforces merge and signing controls.
- **User:** decides installation and local grants.
- **Authority Plane:** enforces runtime capability limits.
- **Guardian/Engineer:** protects kernel integrity and recovery when higher layers
  fail.

---

## 11. DAO Resilience and Security

The DAO must not become a single point of failure for ResonantOS. Chain outages,
stolen wallets, governance disputes, or marketplace compromise must not prevent
Ground-0 recovery or silently alter local runtime authority.

| Threat | Design response |
| --- | --- |
| Stolen developer wallet | Rapid role suspension; separate repository/release credentials; recovery process |
| NFT transfer/sale | Soulbound or tightly governed transfer; role revalidation |
| Reviewer collusion | Multi-review thresholds; conflicts policy; public attestations |
| Self-certification | Author cannot satisfy all approvals for own release |
| Malicious update | Version/hash-bound certification; capability expansion forces re-review |
| DAO outage | Cached policy and fail-safe operation; Ground-0 independent of DAO |
| Marketplace compromise | Host independently verifies signatures, hashes, and certification |
| AI/prompt manipulation | Governance decisions require explicit human cryptographic acts; content is not authority |

---

## 12. Revised Implementation Roadmap

| Phase | Objective | Deliverables |
| --- | --- | --- |
| A | Lock Guardian architecture | Guardian/Engineer ADR; Ground-0 contract; Augmentor de-fusion boundary; Authority Plane invariants |
| B | Reconstruct REF/SDK | Manifest/package contract; capability classes; caller attribution; sideload trust; negative tests |
| C | Guardian recovery proof | Failure injection; Augmentor/add-on/marketplace/DAO outage recovery; rollback and known-good state |
| D | Certification substrate | Risk classes; test evidence; version/hash signatures; reviewer attestations; recertification rules |
| E | Marketplace registry | Publisher identity; listing; signature/cert verification; updates; revocation |
| F | DAO constitution | Developer roles; NFT lifecycle; conflicts; promotion; suspension; proposal classes; emergency powers |
| G | Developer NFT prototype | Role credentials; transfer restrictions; wallet recovery; identity linkage; testnet |
| H | Governance-certification integration | Eligibility checks; vote/attestation thresholds; immutable decision records |
| I | Marketplace pilot | Low-risk add-ons; audit; emergency revocation drill; malicious-update test |
| J | Kernel governance integration | Protected Guardian/kernel release workflow; highest-level maintainer and constitutional paths |
| K | Production hardening | Security review; key recovery; governance attack simulations; operational playbooks |

---

## 13. Decisions Still to Ratify

1. The exact Guardian/Engineer implementation boundary: kernel module, privileged
   service, or minimal internal harness.
2. Which Augmentor functions remain first-party privileged capabilities and which
   move fully into the public extension model.
3. Exact NFT level names, promotion criteria, term/expiry, transferability, and
   whether Tom's L4 role is permanent, appointed, elected, or transitional.
4. Voting thresholds and quorum for marketplace, SDK, Guardian, kernel, and
   emergency decisions.
5. Conflict-of-interest and self-certification rules.
6. On-chain versus signed off-chain governance records and the network used for
   the Resonant DAO.
7. Marketplace signing-key custody, rotation, recovery, and multisignature policy.
8. Developer identity mapping across DAO wallet, repository identity, package
   publisher, and certification identity.
9. Appeal, suspension, revocation, and recertification procedures.
10. The constitutional mechanism required to change Core-only invariants.

---

## 14. Proposed SDK + DAO Charter

- **Stable core, evolvable intelligence.** Guardian/Engineer and Ground-0 protect
  the system while Augmentor and future AI harnesses can evolve.
- **Open creation, governed distribution.** Anyone may build with the SDK;
  certification determines trusted marketplace status.
- **Role is not root.** Developer NFT level never becomes local runtime superuser
  authority.
- **Certification is release-specific.** Trust binds publisher, version, hash,
  capabilities, evidence, reviewers, and policy.
- **No authority laundering.** Delegation through Augmentor never erases the
  originating caller.
- **User sovereignty remains local.** Marketplace approval does not replace
  installation consent or capability grants.
- **Ground-0 survives everything above it.** Augmentor, add-ons, marketplace, DAO,
  chain, and external providers may fail without destroying recovery.
- **Core-only remains protected.** Ordinary add-ons and normal marketplace
  governance cannot reach Guardian/kernel trust-root powers.

---

## Conclusion

The revised architecture creates a cleaner separation of responsibilities. The
Guardian/Engineer is the persistent steward of ResonantOS integrity and recovery.
The Augmentor becomes an AI orchestration component rather than a fused kernel
identity. The SDK defines how the ecosystem extends ResonantOS. Certification
establishes software trust for a specific release. The marketplace distributes
that certified software. Developer NFTs establish who is eligible to review and
govern. The Resonant DAO governs those people, roles, policies, and higher-order
decisions. The ResonantOS Authority Plane and the user remain the final runtime
authority.

**Working architecture:**

```
USER -> KERNEL / GROUND-0 -> GUARDIAN / ENGINEER -> AUTHORITY PLANE ->
AUGMENTOR + AI HARNESS LAYER -> REF / SDK -> ADD-ONS ->
CERTIFICATION / MARKETPLACE
```

The Resonant DAO governs the developer and certification organization around this
stack, but does not replace its runtime security boundaries.
