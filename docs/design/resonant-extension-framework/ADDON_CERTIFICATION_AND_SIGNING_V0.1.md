# Resonant Add-on Certification and Signing V0.1

## Purpose

This document defines how an add-on moves from local development to trusted ResonantOS distribution.

Certification exists to protect users without turning the ecosystem into a closed execution model.

## Core Rule

An add-on may be technically valid without being officially approved.

The states are distinct:

```text
VALID != VERIFIED != APPROVED != GRANTED
```

- **Valid**: conforms to SDK contracts.
- **Verified**: release identity/signature and required automated checks are valid.
- **Approved**: ResonantOS review accepted this exact release for official distribution.
- **Granted**: the current user or authorized policy allowed a requested capability on this machine.

## REF Vocabulary (C9)

The Resonant Extension Framework uses three named fields that must
not be confused. Per `OPEN_DESIGN_CONFLICTS_V0.1.md` C9 and
`RESOLUTIONS_V0.1.md` C9, the rename applies **in REF only** — the
existing runtime field `agents[].trustTier` stays untouched.

| REF name | Field meaning | Allowed values |
| --- | --- | --- |
| `releaseTrustTier` | Distribution trust level granted to a specific release by ResonantOS after certification | `developer`, `verified`, `approved` |
| `capabilityRiskClass` | Risk class assigned to a capability by the certification pipeline; drives streamlined vs manual review and gates approval | `low`, `moderate`, `high`, `critical` |
| `agents[].trustTier` *(legacy, unchanged)* | Existing trust label inside the agent subsystem, used by the alpha runtime | unchanged |

The two REF names are the canonical names in this document and in
the SDK Certification Report. Existing implementation fields
(`provenance.tier`, etc.) may carry the same value set for V0.1; the
formal field rename lands when the SDK is extracted to
`packages/addon-sdk/` (Phase 1 of the implementation roadmap).

The inline "risk class" and "trust tier" prose in this document refers
to `capabilityRiskClass` and `releaseTrustTier` respectively.

**See also:**

- [`REGISTRY_METADATA_SCHEMA_V0.1.md`](REGISTRY_METADATA_SCHEMA_V0.1.md) —
  the canonical approved-release index JSON schema and verifier behavior
  (C10).
- [`SIGNING_ARCHITECTURE_V0.1.md`](SIGNING_ARCHITECTURE_V0.1.md) — the
  canonical ed25519 signing envelope and verification behavior (C11).

## Submission Pipeline

```text
Developer
   |
   v
SDK Validation
   |
   v
Local Test Suite
   |
   v
Package
   |
   v
Submission
   |
   v
Automated Certification
   |
   +--> FAIL -> developer report
   |
   v
Risk Classification
   |
   +--> low risk -> streamlined review
   |
   +--> sensitive -> manual security/capability review
   |
   v
Functional Review
   |
   v
Approval Decision
   |
   +--> reject / changes requested
   |
   v
Bind Review to Digest
   |
   v
Resonant Signature
   |
   v
Official Registry
```

## Automated Certification Gates

Minimum V0.1 gates:

### Manifest

- schema valid;
- stable add-on id;
- valid semantic version;
- supported SDK range;
- supported runtime type;
- all tool capabilities appear in requested capabilities;
- no unknown privileged capability;
- no duplicate tool ids;
- no invalid system-slot claims.

### Package Integrity

- package structure valid;
- no path traversal;
- normalized digest reproducible;
- no secret-like files in prohibited locations;
- no unsigned mutation after submission.

### Dependencies

- dependency inventory produced;
- lockfile present when applicable;
- known critical vulnerabilities flagged;
- prohibited dependency classes flagged by policy;
- bundled executable/native assets identified.

### Capability Audit

Certification produces a machine-readable capability report:

```text
requested
granted-by-default: none
risk class
scope
reason
tools requiring capability
hooks requiring capability
connectors requiring capability
```

### Runtime Tests

- install in clean test profile;
- enable;
- health check;
- execute deterministic smoke test;
- disable;
- re-enable;
- remove;
- verify no unauthorized host calls.

### Compatibility

- supported ResonantOS range;
- supported SDK range;
- manifest schema version;
- runtime protocol support;
- deprecated API warnings.

## Human Review Triggers

Manual review is required when a release:

- requests a high-risk or critical capability;
- expands sensitive capabilities from the prior approved version;
- launches or installs a local service;
- bundles native executable code;
- controls a browser;
- accesses microphone/camera/device integrations;
- performs external account mutation;
- requests shell-mediated commands;
- participates in identity signing;
- handles credentials beyond approved host references;
- supplies self-updating code;
- changes publisher signing identity;
- requests a broad filesystem scope;
- modifies installation behavior.

## Review Outcomes

- `approved`
- `approved-with-constraints`
- `changes-requested`
- `rejected`
- `suspended`
- `revoked`

Constraints are machine-readable where possible.

## Review Record

Recommended fields:

```json
{
  "reviewId": "ROS-ADDON-2026-0042",
  "addonId": "addon.example.notes",
  "version": "1.0.0",
  "packageSha256": "<digest>",
  "publisherId": "example-developer",
  "automatedCertification": "pass",
  "capabilityRisk": "moderate",
  "decision": "approved",
  "reviewedAt": "2026-08-24T00:00:00Z",
  "approvedCapabilities": [
    "archive-read",
    "archive-intake-write"
  ]
}
```

## Signing Model

V0.1 should distinguish at least:

1. publisher signature;
2. Resonant verification/approval signature.

A package may have both.

The official registry must not distribute a release as Resonant Approved unless the package digest matches the approved review record and signature.

## Key Management

Production signing keys must not live in the source repository.

Recommended separation:

- offline or protected root trust key;
- rotating release-signing keys;
- publisher keys;
- revocation metadata.

A key rotation must not invalidate historical package records when the old key remains trusted for its valid time window.

## Revocation

Revocation may target:

- exact add-on release;
- publisher key;
- publisher identity;
- signing key;
- add-on id in exceptional cases.

Reasons may include:

- compromised publisher key;
- malicious update;
- severe undisclosed behavior;
- supply-chain compromise;
- critical vulnerability;
- policy violation.

The client should surface:

- severity;
- affected release;
- recommended action;
- whether execution is blocked.

## Transparency

The user-facing install screen should display:

- publisher;
- trust tier;
- version;
- capabilities requested;
- sensitive permission explanation;
- whether code launches local services;
- whether network access is required;
- current certification state;
- signature state.

Approval must not be presented as a guarantee of security.

## Re-Review Rules

A release must be re-certified every version.

Manual re-review is mandatory when:

- capability risk increases;
- publisher changes;
- runtime isolation weakens;
- native code is introduced;
- installer behavior changes materially;
- external account write scopes are added;
- critical security policy changes apply.

## Emergency Security Action

The ResonantOS team may revoke distribution immediately for critical threats.

The runtime still owns the final local enforcement behavior, but the registry may publish high-severity revocation metadata that causes compatible clients to quarantine the release.
