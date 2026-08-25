# Resonant Extension Framework Implementation Roadmap V0.1

## Objective

Turn the current internal Add-on SDK V0 into an externally consumable, governed add-on system without destabilizing the Alpha runtime.

## Guiding Rule

Do not move privilege into the SDK.

The SDK defines contracts.

The Alpha bridge, capability broker, and named host services remain the privileged execution boundary.

## Phase 0 — Freeze Current Contract Surface

### Deliverables

- inventory all exports from `src/sdk/addons/`;
- inventory all Add-on manifest fields in use;
- inventory bundled manifests in `public/addons/`;
- inventory bridge capabilities and add-on delegation routes;
- record unsupported/deferred fields;
- identify imports from `src/core/contracts.ts` that block external packaging.

### Exit Gate

A machine-readable list exists for:

- current public candidates;
- internal-only contracts;
- capability names;
- service protocols;
- manifest fields;
- compatibility assumptions.

## Phase 1 — Extract Public SDK Package

### Target structure

```text
packages/
+-- addon-sdk/
|   +-- src/
|   +-- test/
|   +-- package.json
|
+-- addon-sdk-testing/
    +-- src/
    +-- test/
    +-- package.json
```

If the Alpha repo is not yet ready for workspaces, the package can first live under:

```text
src/sdk/addon-public/
```

but it must be testable as if imported externally.

### Deliverables

- public manifest types;
- public capability constants;
- validation;
- compatibility parser;
- stable error codes;
- no private relative imports from add-on projects.

### Exit Gate

An external fixture project compiles and validates while importing only the SDK package.

## Phase 2 — Add-on Package Format

### Deliverables

- `.rpkg` archive format;
- deterministic normalization rules;
- checksum generation;
- package reader that does not execute code;
- manifest extraction;
- package digest;
- path traversal protection.

### Exit Gate

A package can be built, inspected, hashed, and rejected safely before installation.

## Phase 3 — Developer CLI

### Deliverables

- `create`;
- `validate`;
- `test`;
- `audit`;
- `package`.

`submit` may remain local/export-only at first.

### Exit Gate


## Phase 3.5 — Caller-Attributed Capability Tokens

**Gate phase.** Hard-pinned before Phase 4 and before any M0 reference test that exercises enforcement (Tests B and C). Closes C2.

### Deliverables

- extend `isAuthorizedCapabilityRequest` (`browser-first/host/bridge-server.mjs`) from a static route→token map to a grant store keyed `(callerId, capability, scope)`;
- mint per-add-on tokens at grant time using the existing requested/granted/denied record shape;
- remove bootstrap-derived credential set from `lib/addon-iframe.js`; iframes receive only the per-caller, scope-bounded token;
- audit-trail hook that records callerId on every authorised request.

### Exit Gate


## Phase 4 — Host Install and Lifecycle (gated on 3.5)

### Deliverables

- install;
- enable;
- disable;
- health;
- update;
- remove;
- capability grant display;
- audit records.

### Exit Gate

The Hello Resonant reference add-on completes the full lifecycle.

## Phase 5 — Certification Harness


### Deliverables

- automated manifest checks;
- package-integrity checks;
- dependency inventory;
- capability-risk report;
- compatibility checks;
- clean-profile runtime test;
- smoke-test execution;
- machine-readable certification report.

### Exit Gate

The same release produces the same certification identity and digest when built through the supported path.

## Phase 6 — Signing and Trust

### Deliverables

- publisher signature format;
- Resonant approval signature format;
- trusted key store;
- verification;
- revocation metadata;
- trust-tier UI.

### Exit Gate

The host differentiates:

- unsigned sideload;
- verified publisher release;
- Resonant Approved release;
- revoked release.

## Phase 7 — Review Workflow

### Deliverables

- submission bundle;
- review record schema;
- automated risk classification;
- manual-review trigger rules;
- approval decision;
- digest-bound approval.

### Exit Gate

A release can move from developer package to officially approved artifact without changing bytes after approval.

## Phase 8 — Registry

### Deliverables

- registry metadata format;
- approved release index;
- compatibility filtering;
- revocation feed;
- update lookup.

### Non-Goal

Do not add marketplace commerce in this phase.

## M0 Reference Tests

**Order:** Test B → Test C → Test A.

Test A is deferred past V0.1 (see C4 resolution: V0.1 is declarative-only; no third-party code runs in the shell). Tests B and C are gated on Phase 3.5.

### Test A — Hello Resonant (deferred past V0.1)

Must prove, *when revisited after the post-V0.1 sandbox surface ships*:

- external scaffold;
- manifest validation;
- package;
- sideload;
- install;
- enable;
- UI surface;
- disable;
- remove.


### Test B — Local Files

Must prove:

- capability declaration;
- user grant;
- scope restriction;
- denied unauthorized action;
- audit record.

### Test C — Local AI

Must prove:

- add-on asks for inference capability;
- host chooses authorized provider/runtime;
- add-on never receives raw provider credentials;
- cancellation and failure are bounded;
- audit remains attributable to add-on id/version.

## Suggested Repository Additions

```text
docs/
+-- architecture/
|   +-- ADR-038-resonant-extension-framework.md
|
+-- add-ons/
    +-- RESONANT_ADDON_SDK_SPEC_V0.1.md
    +-- ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md
    +-- ADDON_CERTIFICATION_AND_SIGNING_V0.1.md
    +-- ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md
    +-- IMPLEMENTATION_ROADMAP_V0.1.md

packages/
+-- addon-sdk/
+-- addon-sdk-testing/

examples/
+-- add-ons/
    +-- hello-resonant/
    +-- local-files/
    +-- local-ai/
```

## Recommended First Engineering Commit

Documentation only:

```text
docs: define Resonant Extension Framework V0.1
```

Do not change runtime behavior in the same commit.

## Recommended Second Engineering Commit

Contract extraction only:

```text
sdk: extract public add-on contracts and validation
```

## Recommended Third Engineering Commit

External fixture:

```text
test: prove external add-on SDK consumption
```

This sequence makes regressions easy to identify and avoids mixing policy, API extraction, and runtime authority changes.
