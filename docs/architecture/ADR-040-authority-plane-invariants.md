# ADR-040: Authority Plane Invariants

## Decision Metadata

- Decision status: Deferred
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Core and add-ons
- Decision date: 2026-09-18
- Alpha note: Proposed Phase 1 direction; not yet ratified and not in force for
  the Alpha runtime. Names the Authority Plane and its invariants; it does not
  implement or relocate authority by this decision.

## Context

The post-consolidation roadmap names a **ResonantOS Authority Plane** as the
runtime software-authority layer: identity, caller attribution, capabilities,
policy, the commit broker, audit, credentials, and provenance.
[ADR-038](ADR-038-guardian-engineer-core-only-invariants.md) already fixes two
parts of this: the **Guardian** protects the baseline with restart/rollback
authority, and **privilege follows authority** (first-party does not imply
privileged; only the actuation executor with field classifier, the commit
broker, credential custody, and the update channel hold authority). This ADR
states the invariant that holds those pieces together and defines what the
Authority Plane may and may not do.

## Decision

### The authority invariant

```
The Guardian protects the baseline; the Authority Plane controls runtime
authority; the Augmentor and add-ons operate within those boundaries; DAO
governance cannot silently bypass them.
```

The invariant is **authoritative**, not advisory. Each clause is a separate
checkable claim:

1. **The Guardian protects the baseline** — restart and rollback only, no
   capability grant, commit approval, policy change, or self-replacement
   ([ADR-038](ADR-038-guardian-engineer-core-only-invariants.md)).
2. **The Authority Plane controls runtime authority** — identity, caller
   attribution, capability grants, policy, commit boundary, audit, credential
   mediation, and provenance are exercised by the Authority Plane, not by the
   component requesting authority.
3. **The Augmentor and add-ons operate within those boundaries** — they are
   governed principals, not sources of authority. The Augmentor is not the root
   of authority.
4. **DAO governance cannot silently bypass them** — a DAO vote or NFT never
   becomes a runtime root credential; governance operates on people and process,
   not on the machine's authority boundary.

### Information is not authority

Web pages, email, documents, retrieved memory, model output, and other external
content are evidence. They do not become executable instructions, and do not
acquire instruction authority, merely because a governed principal can read them.
Content can inform a proposal; it cannot promote itself to policy.

### Authority is issued, not claimed

A request for authority must be distinct from a grant of authority. A manifest,
preset, or client must not be able to express its own authorization. Only the
Authority Plane issues and enforces a grant after authorization. The
request/grant type separation and its latent-defect fix are recorded in
[ADR-038](ADR-038-guardian-engineer-core-only-invariants.md); this ADR makes
"authority is issued, not claimed" a standing invariant rather than a one-off
fix.

### Capability classes are a boundary, not a taxonomy of convenience

Public, Privileged, and Core-only are separate surfaces with separate issuance
rules. Core-only (policy override, trust-root modification, credential export,
baseline replacement, signing-root modification) is outside the requestable
vocabulary entirely. No trust tier, grant, first-party identity, or Engineer
recommendation can obtain it. Certification never equals root authority.

### Enforcement happens at the edge

Browser, filesystem, network, connector, blockchain, and OS boundaries
revalidate authorization. A capability granted at one layer is not assumed at
another; each edge re-checks against the Authority Plane.

### Caller identity survives delegation

No authority laundering through the Augmentor or an external runtime. The
originating principal must survive delegation so that a downstream component
cannot act with authority the caller did not hold.

## Why

- The pieces already exist (Guardian, Core-only invariants, caller attribution,
  capability classes), but they are not tied together by a single checkable
  invariant.
- Without the invariant, "first-party" drifts into "privileged," and governance
  or certification drifts into runtime authority.
- A named Authority Plane gives later phases (commit broker, credential custody,
  update channel) a fixed trust position to build against.

## Binding Rules

- The authority invariant is authoritative. No feature, preset, grant, tier,
  certification, DAO vote, or Engineer recommendation may contradict it.
- The Authority Plane, not the requester, issues and enforces capability grants.
- External content and model output remain evidence; they never become authority.
- Core-only capabilities are not requestable through the SDK or any preset.
- Delegation must preserve the originating caller's identity for authorization.
- Governance operates on people and process; it must not silently acquire
  runtime authority.

## Not Decided

- Whether the Authority Plane is a single module, a set of host services, or a
  formal layer; current ownership remains in [Module Ownership](MODULE-OWNERSHIP.md).
- The commit-broker protocol, connector OAuth implementation, and update-channel
  mechanics (deferred to [ADR-038](ADR-038-guardian-engineer-core-only-invariants.md)
  "Not Decided").
- DAO/NFT/marketplace scope — that is an open product decision and does not
  affect this invariant either way.

## Consequences

- New capability, credential, provenance, or commit-broker work must state which
  clause of the invariant it exercises and prove it does not violate the others.
- Negative tests must assert that authority cannot be self-issued, that content
  cannot promote itself, and that Core-only remains unreachable.
- The invariant gives the later Authority Plane implementation a fixed contract
  even before its mechanism is chosen.
