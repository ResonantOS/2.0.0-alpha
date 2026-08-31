# Add-on SDK Code Review Feedback — Public / Third-Party Evolution

## Status

- Document type: Engineering review feedback
- Date: 2026-08-24
- Scope: ResonantOS Alpha fork add-on SDK and third-party extension direction
- Related architecture: ADR-006, ADR-018, ADR-023, ADR-026
- Related implementation: `src/sdk/addons/`

## Purpose

This document records code-review feedback on the existing ResonantOS Alpha
add-on SDK work and recommendations for evolving it into a public,
third-party-capable SDK without creating a competing plugin architecture.

The existing implementation is a strong foundation. The recommendation is to
extend the current Add-on Runtime / SDK architecture rather than replace it.

## Overall Assessment

The current SDK-related implementation is moving in the correct direction. In
particular, recent work closes meaningful trust-boundary gaps rather than merely
adding documentation or API surface.

The architecture already provides most of the conceptual foundation needed for a
future third-party ecosystem:

- add-on manifests;
- explicit capability requests and grants;
- provenance/trust state;
- runtime categories;
- host-mediated privileged operations;
- system-slot ownership;
- manifest validation;
- registry concepts;
- lifecycle concepts;
- deterministic tests/smoke tests.

The next priority should be to make the permission and trust semantics more
centralized and fail-closed before significantly expanding the public SDK
surface.

## Finding 1 — System-Slot Capability Gating Is a Strong Improvement

Recent SDK work correctly ties replaceable system slots to explicit
capabilities.

Current relationships include:

```text
primary-agent          -> agent-delegation
memory-system          -> memory-provider
chat-interface         -> chat-interface
communication-channel  -> notifications
```

The important architectural property is that declaring or installing an add-on
does not make it the active provider for a privileged system slot. The
appropriate capability must also be granted.

This closes a class of failure where an add-on could claim a privileged role
without passing through the capability system.

### Recommendation

Keep this rule as a permanent invariant:

> System-slot eligibility must be derived from explicit capability grants, not
> from manifest declarations, provenance, installation state, or approval
> status alone.

## Finding 2 — Slot-to-Capability Mapping Should Have One Source of Truth

The runtime and manifest validator currently maintain equivalent
slot-to-capability knowledge in separate locations.

Even if the mappings are identical today, duplication creates a future
security-maintenance risk:

```text
validator mapping
       X
runtime mapping
```

A developer could add or modify a slot in one location and forget to update the
other.

### Recommendation

Move the relationship into a neutral shared SDK/core contract.

Illustrative form:

```ts
export const SYSTEM_SLOT_CAPABILITY = {
  "primary-agent": "agent-delegation",
  "chat-interface": "chat-interface",
  "memory-system": "memory-provider",
  "communication-channel": "notifications",
} as const;
```

Both validation and runtime enforcement should consume this single mapping.

Tests should assert that every supported system slot has exactly one defined
authorization policy.

## Finding 3 — `communication-channel -> notifications` Should Be Revisited

Using `notifications` as the current backing capability provides a gate, which
is preferable to having no gate.

However, the semantics may be too broad for a mature third-party SDK.

A communication-channel add-on could potentially:

- send messages;
- receive messages;
- connect to an external account;
- expose remote commands;
- transport delegated work;
- mutate remote state.

Those responsibilities are materially broader than displaying a notification.

### Recommendation

Consider introducing dedicated communication capabilities during a future
capability-model revision.

Examples:

```text
communication-channel
channel.send
channel.receive
channel.account-read
channel.account-write
```

Do not break the Alpha merely to rename this immediately. Treat it as a
capability-model refinement to address before promising long-term public SDK
stability.

## Finding 4 — Missing Provenance Now Fails Safer

The registry behavior that treats a bundled manifest with no provenance as
unverified/unreviewed is a strong security improvement.

The desired principle is:

> Trust must never be created by omission.

A manifest lacking provenance should not silently become equivalent to a
curated, signed, reviewed release.

This aligns well with the proposed future distinction between:

- personal/local;
- sideloaded/unverified;
- verified publisher;
- Resonant Approved.

## Finding 5 — Partial Provenance Should Also Fail Closed

The same principle should be applied to individual provenance fields.

A provenance object existing should not by itself be enough to create trusted
defaults.

Desired behavior:

```text
missing provenance           -> unverified
missing provenance tier      -> unverified
missing verification state   -> unverified
missing signature evidence   -> cannot become verified
invalid signature            -> unverified/rejected
revoked signature/release    -> rejected/quarantined
```

### Recommendation

Before public third-party distribution is enabled, ensure that trusted states
can only be reached through positive evidence.

Avoid patterns equivalent to:

```text
missing trusted field -> assume trusted default
```

The public ecosystem should instead follow:

```text
missing trusted field -> remain untrusted
```

## Finding 6 — SDK Validation, Approval, and Runtime Authority Must Stay Separate

The future public SDK should preserve four independent questions:

1. Does the add-on conform to the SDK?
2. Who produced this package and has it been reviewed?
3. What capabilities did the add-on request?
4. What capabilities has this user actually granted on this machine?

These should never collapse into one `trusted` boolean.

Recommended invariant:

```text
Manifest declares.
Validation checks.
Certification evaluates.
Signature identifies.
User grants.
Host enforces.
```

A Resonant Approved package must still be denied an operation if the required
local capability has not been granted.

## Finding 7 — Personal / Local Add-ons Should Be Supported Explicitly

A user should be able to create an add-on for their own ResonantOS installation
without obtaining ResonantOS development-team approval.

However, the add-on must still use the SDK and obey runtime authority
boundaries.

This creates a useful distinction:

```text
SDK compliance     = mandatory technical admission
Resonant approval  = optional ecosystem trust/support path
```

Personal/local add-ons may accept greater risk of:

- breakage;
- incompatibility;
- unsupported behavior;
- maintenance burden.

They must not receive greater authority merely because the user created them.

A dedicated `personal-local` provenance tier should be considered so locally
created software is distinguishable from arbitrary third-party code downloaded
from elsewhere.

See the companion governance document:

```text
ADDON_PERSONAL_PLUGIN_GOVERNANCE.md
```

## Finding 8 — Do Not Create a Second Competing Plugin Architecture

The existing repository already contains the architectural lineage:

```text
ADR-006 Add-on Runtime & SDK
        |
        v
ADR-018 Add-on SDK V0
        |
        v
src/sdk/addons/
```

Future public/third-party work should evolve this lineage.

Recommended direction:

```text
Existing Add-on SDK V0
        |
        v
harden contracts and trust semantics
        |
        v
extract external/public package boundary
        |
        v
Public Add-on SDK V1
        |
        v
certification / signing / registry
```

Avoid introducing an unrelated extension framework that duplicates manifests,
capabilities, lifecycle, or runtime authority.

The broader framework may have a product/ecosystem name, but it should remain an
evolution of the existing Add-on SDK decisions.

## Finding 9 — Public SDK Must Not Depend on Private Core Imports

The current internal SDK can reasonably share private repository types.

A third-party SDK cannot.

An external developer should eventually be able to write:

```ts
import {
  defineAddOn,
  validateAddOnManifest,
  capabilities,
} from "@resonantos/plugin-sdk";
```

without importing:

```text
../../core/contracts
```

or understanding ResonantOS private source layout.

### Recommendation

Before calling the SDK public, establish an intentionally versioned public
contract boundary.

Internal implementation may adapt to those public contracts, but plugin authors
must not depend on private kernel/source modules.

## Finding 10 — External Plugin M0 Should Precede Marketplace Work

The first proof should remain deliberately small.

### Proposed M0

**External Add-on SDK Test**

A developer outside the ResonantOS source tree must be able to:

1. scaffold an add-on;
2. declare its manifest;
3. validate it;
4. run SDK tests;
5. package it;
6. sideload it;
7. inspect requested capabilities;
8. grant a bounded capability;
9. execute one host-mediated operation;
10. disable and remove it;

without importing private ResonantOS implementation modules.

If this cannot be demonstrated, registry/marketplace work is premature.

## Finding 11 — Packaging and Certification Should Be Layered on Top

Once the external SDK boundary is proven, the following additions remain useful:

- deterministic add-on package format (for example `.rpkg`);
- normalized package hashing;
- publisher identity/signing;
- version-specific certification;
- Resonant approval signing;
- machine-readable review records;
- revocation;
- compatibility declarations;
- developer CLI;
- automated certification harness;
- official registry.

These mechanisms establish distribution trust. They must not replace runtime
capability enforcement.

## Recommended Engineering Priority

### P0 — Security semantics

1. Centralize system-slot capability mappings.
2. Verify provenance is fail-closed at every trusted field.
3. Review `communication-channel -> notifications` semantics.
4. Add tests proving approval/provenance cannot bypass capability grants.

### P1 — Public boundary

5. Inventory public vs internal SDK contracts.
6. Remove private-core dependencies from the proposed external API.
7. Create an external fixture project.
8. Prove SDK validation outside the monorepo/source tree.

### P2 — Developer experience

9. Add scaffold/test/audit/package tooling.
10. Add a mock host that rejects undeclared and ungranted operations.
11. Create small reference add-ons.

### P3 — Distribution trust

12. Define deterministic package format.
13. Implement package digests.
14. Define publisher and Resonant signatures.
15. Implement certification/review records.
16. Implement revocation and registry metadata.

## Suggested Reference Add-ons

### Hello Resonant

Proves:

- external SDK import;
- manifest;
- install;
- UI/lifecycle;
- enable/disable/remove.

### Local Files

Proves:

- declared capability;
- explicit grant;
- scope restriction;
- denied unauthorized operation;
- audit trail.

### Local AI

Proves:

- inference request;
- host-selected provider/runtime;
- no raw provider-secret exposure;
- cancellation/failure handling;
- plugin-attributed audit records.

## Final Assessment

The current add-on work is not a dead-end internal prototype. It is already a
credible foundation for a third-party SDK.

The strongest path forward is therefore evolutionary:

```text
Do not replace the existing SDK.
Harden it.
Centralize its security semantics.
Prove it can be consumed externally.
Then add certification and distribution trust.
```

The architectural boundary to protect above everything else is:

> An add-on may declare what it wants, and ResonantOS may certify who produced
> it, but only the local capability/host authority system decides what it may
> actually do.

## Cross-References

Findings in this review thread through the rest of the framework package:

- **Finding 1 (system-slot gating):** aligns with `RESONANT_ADDON_SDK_SPEC_V0.1.md`'s capability-grant model and is operationalised by the `sdk/p1b-p1e-slots-provenance` work referenced in `EXTERNAL_REVIEW_FEEDBACK_V0.1.md`.
- **Finding 2 (one source of truth for slot→capability):** no shared `SYSTEM_SLOT_CAPABILITY` constant exists yet. Recorded here as a future deliverable for ADR-055.
- **Finding 3 (`communication-channel → notifications`):** a capability-model refinement that should not block ADR-055's framing pass; deferred until the capability-mapping table (C5 in `OPEN_DESIGN_CONFLICTS_V0.1.md`) is built.
- **Findings 4 & 5 (fail-closed provenance):** confirm `RESOLUTIONS_V0.1.md`'s C1 mapping decision (option a) — provenance is mapped onto existing enums rather than replaced.
- **Finding 6 (six-axis separation):** restates the package's own Core Principle ("Manifest declares. Certification evaluates. Signature identifies. User grants. Host enforces.").
- **Finding 7 (personal/local):** threads into `ADDON_PERSONAL_PLUGIN_GOVERNANCE.md`, which proposes a `personal-local` provenance tier. No current conflict; requires adding a new enum value, which is a non-C1 decision.
- **Findings 8 & 9 (no second architecture; no private-core imports):** directly motivate `RESOLUTIONS_V0.1.md`'s reframe direction: extend ADR-006/ADR-018, do not replace them. The public-SDK boundary is ADR-055 work.
- **Finding 10 (M0 first):** the package's own `IMPLEMENTATION_ROADMAP_V0.1.md` agrees; M0 Test A (Hello Resonant with UI surface) was deferred past V0.1 by the resolution of C4; M0 Test B (Local Files) is the smallest enforcement probe and runs first.
- **Finding 11 (certification layering):** restates the package's design intent; no decision required here.

## Disposition

This is a feedback document, not an accepted decision. Carry the findings
into:

1. The ADR-055 draft (forthcoming), with the cross-references above
   resolved into specific edits.
2. `RESOLUTIONS_V0.1.md` only where a new resolution is required
   (specifically: `personal-local` provenance tier from Finding 7, and
   the shared `SYSTEM_SLOT_CAPABILITY` constant from Finding 2). No
   current resolution is changed by this feedback.
3. `IMPLEMENTATION_ROADMAP_V0.1.md` if a new sub-phase is needed to
   land Finding 2's centralisation; otherwise it's a Phase 1 sub-deliverable.
