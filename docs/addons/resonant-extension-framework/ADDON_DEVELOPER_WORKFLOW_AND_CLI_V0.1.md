# Resonant Add-on Developer Workflow and CLI V0.1

## Objective

Make the safe path the easiest path.

A developer should not need to learn ResonantOS kernel internals to produce a compliant add-on.

## Developer Journey

```text
npm create resonant-addon
        |
        v
choose add-on template
        |
        v
edit resonant.addon.json
        |
        v
implement SDK-facing code
        |
        v
resonant addon validate
        |
        v
resonant addon test
        |
        v
resonant addon audit
        |
        v
resonant addon package
        |
        +--> sideload in developer mode
        |
        v
resonant addon submit
        |
        v
certification / review
```

## Scaffolded Project

```text
my-addon/
|
+-- resonant.addon.json
+-- package.json
+-- src/
|   +-- index.ts
|
+-- skills/
+-- tests/
|   +-- manifest.test.ts
|   +-- smoke.test.ts
|
+-- README.md
+-- LICENSE
```

## CLI Commands

### Create

```bash
resonant addon create
```

Responsibilities:

- select runtime template;
- generate manifest;
- generate tests;
- pin compatible SDK;
- create example capability declaration.

### Validate

```bash
resonant addon validate
```

Checks:

- manifest schema;
- capability references;
- tool/connector/hook references;
- compatibility;
- package identity;
- required fields.

### Test

```bash
resonant addon test
```

Runs:

- SDK contract tests;
- deterministic add-on tests;
- smoke tests against a mock host;
- lifecycle tests.

### Audit

```bash
resonant addon audit
```

Produces a human-readable and machine-readable report.

Example:

```text
Resonant Add-on Audit

Add-on: Example Notes
Version: 1.0.0
SDK: ^0.1.0

Manifest: PASS
Compatibility: PASS
Smoke tests: 12/12 PASS

Capabilities
------------
archive-read          MODERATE
archive-intake-write  MODERATE

Network access: none
Shell access: none
Native executables: none

Certification readiness: PASS
```

### Package

```bash
resonant addon package
```

Responsibilities:

- build add-on assets;
- normalize package;
- generate checksums;
- generate provenance metadata;
- produce `.rpkg`;
- optionally create publisher signature.

### Submit

```bash
resonant addon submit
```

V0.1 may initially output a submission bundle rather than talking to a live registry.

The submission bundle should include:

- `.rpkg`;
- audit report;
- test report;
- provenance;
- publisher metadata;
- requested certification tier.

## Mock Host

`@resonantos/addon-sdk-testing` should expose a mock host.

Example:

```ts
const host = createMockResonantHost({
  grants: ["archive-read"]
});
```

The mock host must reject undeclared and ungranted operations.

This is essential: tests should prove that add-ons handle denied capabilities correctly.

## Reference Add-ons

M0 should ship three deliberately small reference add-ons.

### Hello Resonant

Tests:

- manifest;
- UI surface;
- lifecycle;
- enable/disable.

### Local Files

Tests:

- bounded filesystem read;
- denied filesystem write;
- scope enforcement;
- audit output.

### Local AI

Tests:

- provider/inference request;
- local vs host-selected provider abstraction;
- cancellation;
- no raw provider credential exposure.

## Error Model

SDK-facing errors should be stable and machine-readable.

Candidate codes:

```text
REF_MANIFEST_INVALID
REF_CAPABILITY_NOT_DECLARED
REF_CAPABILITY_NOT_GRANTED
REF_SCOPE_DENIED
REF_ADDON_DISABLED
REF_ADDON_REVOKED
REF_SDK_INCOMPATIBLE
REF_HOST_UNAVAILABLE
REF_HUMAN_APPROVAL_REQUIRED
REF_SERVICE_UNHEALTHY
```

## Documentation Requirements

Every public SDK API must document:

- purpose;
- authority boundary;
- capability requirement;
- input/output contract;
- error behavior;
- version stability;
- minimal example.

## Developer Mode

Developer mode may allow unsigned sideloading.

It must clearly indicate:

- unverified publisher;
- unsigned or locally signed package;
- capabilities requested;
- elevated risk if applicable.

Developer mode must not disable capability enforcement.
