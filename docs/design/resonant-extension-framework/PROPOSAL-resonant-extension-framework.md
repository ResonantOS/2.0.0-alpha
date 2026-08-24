# Proposal: Resonant Extension Framework (draft for ADR-038)

## Decision Metadata

- Decision status: Proposed
- Alpha applicability: Applies incrementally
- Superseded by: None
- Owner: Add-on SDK / Core / Security
- Decision date: 2026-08-24
- Target: ResonantOS Alpha fork
- Staging: design-stage proposal at `docs/design/resonant-extension-framework/`;
  on acceptance this becomes `docs/architecture/ADR-038-resonant-extension-framework.md`

## Decision

ResonantOS will formalize its existing add-on architecture as the **Resonant Extension Framework (REF)**.

REF is the governed system by which third-party and first-party add-ons are defined, validated, tested, reviewed, signed, distributed, installed, granted capabilities, executed, updated, disabled, and removed.

The existing `src/sdk/addons/` contracts remain the starting point. The new framework does not replace the Alpha capability model or authenticated host bridge. It packages and hardens those boundaries into a stable developer-facing contract.

An add-on that wants to operate inside ResonantOS must:

1. declare itself using the Resonant Add-on SDK manifest contract;
2. request all capabilities explicitly;
3. pass SDK validation;
4. execute privileged operations only through host-mediated APIs;
5. pass the applicable automated certification suite;
6. be cryptographically signed for verified or approved distribution;
7. receive explicit user grants before using requested capabilities.

Official catalog distribution additionally requires ResonantOS review and approval for the specific add-on version.

## Architectural Principle

The framework separates four questions that must never be conflated:

1. **What is the add-on?** — declared by the manifest.
2. **What does the add-on request?** — declared capabilities.
3. **What may the add-on do on this machine?** — decided by the ResonantOS host and user grants.
4. **What does the ResonantOS project trust and distribute?** — decided by certification and signing policy.

The trust flow is therefore:

```text
Add-on Declaration
        |
        v
Capability Request
        |
        v
SDK Validation
        |
        v
Certification / Review
        |
        v
Signature / Distribution Trust
        |
        v
User Installation
        |
        v
User Capability Grant
        |
        v
Host-Mediated Execution
```

Approval is never a substitute for runtime authorization.

## Framework Components

```text
Resonant Extension Framework
|
+-- Resonant Add-on SDK
|   +-- manifest contracts
|   +-- capability constants
|   +-- lifecycle contracts
|   +-- service/tool contracts
|   +-- validation
|   +-- compatibility rules
|
+-- Add-on CLI
|   +-- create
|   +-- validate
|   +-- test
|   +-- audit
|   +-- package
|   +-- submit
|
+-- Add-on Runtime
|   +-- discovery
|   +-- installation
|   +-- lifecycle
|   +-- capability broker
|   +-- host IPC mediation
|   +-- enable/disable/remove
|
+-- Certification Pipeline
|   +-- manifest validation
|   +-- dependency checks
|   +-- capability analysis
|   +-- static checks
|   +-- sandbox/runtime checks
|   +-- smoke tests
|   +-- compatibility tests
|
+-- Trust and Signing
|   +-- publisher identity
|   +-- package digest
|   +-- release signature
|   +-- revocation
|   +-- provenance
|
+-- Add-on Registry
    +-- approved releases
    +-- publisher metadata
    +-- compatibility metadata
    +-- review state
    +-- revocation state
```

## Trust Tiers

REF defines three initial trust tiers.

### 1. Sideloaded / Developer

- May be installed manually in developer mode.
- May be unsigned.
- Must still pass manifest validation.
- Is visibly marked unverified.
- Does not receive sensitive capabilities merely because it is installed.
- May be subject to tighter runtime restrictions.
- Must not impersonate an approved publisher or package.

### 2. Verified

A verified add-on:

- has an identified publisher;
- is built against a supported SDK version;
- passes automated certification;
- is packaged reproducibly enough to bind review to a digest;
- is signed by an accepted publisher or Resonant verification key;
- has not been revoked.

Verified means the release and publisher identity are known and the package passed the required checks. It does not mean the ResonantOS team endorses every behavior or external service.

### 3. Resonant Approved

A Resonant Approved add-on:

- satisfies all Verified requirements;
- has passed the required ResonantOS development/security review;
- has an approved capability profile;
- has an approved version-specific package digest;
- is signed for official distribution;
- may appear in the official ResonantOS add-on catalog.

Approval is version-specific.

## Version-Specific Approval

Approval binds to a release identity:

```text
add-on id
+ add-on version
+ manifest digest
+ package digest
+ publisher identity
+ review record
+ signature
```

A new version must be certified again.

A release that adds or materially broadens sensitive capabilities automatically returns to human review.

Example:

```diff
 requestedCapabilities:
   - archive-read
+  - shell
+  - network
```

The newer release cannot inherit the prior approval.

## Capability Governance

REF keeps the current ResonantOS rule that manifests request authority but do not possess authority.

A manifest may request:

```json
{
  "requestedCapabilities": [
    "archive-read",
    "network"
  ]
}
```

The host must independently verify:

- the add-on is installed and enabled;
- the requested capability exists in the current SDK;
- the add-on manifest requested it;
- certification policy permits the release to request it;
- the user or enterprise policy granted it;
- the current operation is within the granted scope;
- required approvals are satisfied.

## Capability Risk Classes

Certification should classify capabilities at least as:

### Low risk

Examples:

- UI surface registration
- non-sensitive notifications
- bounded metadata reads

### Moderate risk

Examples:

- network access
- archive read
- provider-backed inference
- external connectors with read-only scopes

### High risk

Examples:

- filesystem writes
- browser control
- microphone/camera access
- local service launch
- shell-mediated commands
- external account mutation

### Critical

Examples:

- cryptographic identity signing
- credential export
- administrative system mutation
- arbitrary native-code execution outside approved mediation

Critical capabilities should require explicit manual review and may be prohibited entirely in Alpha.

## Runtime Boundary

REF does not allow third-party code to call privileged local resources directly.

For Alpha:

```text
Add-on / Extension UI
        |
        v
Resonant SDK API
        |
        v
Authenticated Resonant Bridge
        |
        v
Capability Broker / Policy
        |
        v
Named Host Service
        |
        v
Local privileged resource
```

The bridge and named host services remain the authority boundary.

Provider secrets, raw credential values, protected user state, trusted archive promotion, unrestricted process launch, and other privileged resources remain host-side.

## Replaceability

REF preserves the minimal-kernel model.

Add-ons may provide replaceable system slots such as:

- `primary-agent`
- `chat-interface`
- `memory-system`
- `communication-channel`

Certification does not make an add-on mandatory core.

## Distribution Policy

The official catalog should contain only releases that are:

- certified;
- signed;
- compatible with the running ResonantOS/SDK range;
- not revoked;
- approved for official distribution.

Developer mode may expose additional sideloaded or experimental releases.

## Non-Goals for V0.1

REF V0.1 does not require:

- a commercial marketplace;
- add-on payments;
- ratings/reviews;
- revenue sharing;
- cross-device license management;
- arbitrary native binaries;
- remote code execution;
- automatic approval of sensitive permission changes.

## Consequences

- Third-party developers receive a stable target.
- The ResonantOS team gains a repeatable review and signing process.
- Users can distinguish installed, verified, and approved software.
- Add-ons remain modular and replaceable.
- Privileged authority remains with the host, not with signatures or manifests.
- The existing Add-on SDK can evolve toward a public package without rewriting the kernel architecture.

## Initial Implementation References

Existing source to evolve:

- `src/sdk/addons/`
- `src/core/contracts.ts`
- `src/core/runtime.ts`
- `public/addons/`
- `browser-first/host/bridge-server.mjs`
- `browser-first/host/*-host-service.mjs`
- `browser-first/test/`

Related decisions:

- ADR-018: Add-on SDK V0
- ADR-026: Minimal Kernel And Replaceable Default Add-ons
