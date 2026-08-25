# Resonant Add-on Package and Manifest Specification V0.1

## Purpose

This specification defines the portable package submitted, reviewed, signed, and installed by the Resonant Extension Framework.

## Recommended Extension

Use `.rpkg` for the packaged artifact.

The format may initially be a deterministic ZIP container.

## Package Layout

```text
example-notes-1.0.0.rpkg
|
+-- resonant.addon.json
+-- package/
|   +-- compiled add-on assets
|   +-- UI assets
|   +-- service assets
|
+-- skills/
+-- docs/
+-- tests/
+-- provenance/
|   +-- checksums.json
|   +-- build.json
|
+-- signatures/
    +-- publisher.sig
    +-- resonant-approval.sig   # official releases only
```

Not every directory is mandatory.

## Required Package Properties

A package must be:

- deterministic enough to produce a stable package digest;
- self-describing;
- immutable after signing;
- version-specific;
- verifiable before install;
- unpackable without executing add-on code.

## Required Manifest Fields

```json
{
  "schemaVersion": "0.1",
  "id": "addon.example.notes",
  "name": "Example Notes",
  "version": "1.0.0",
  "author": "Example Developer",
  "description": "Example note integration.",
  "category": "knowledge",
  "runtimeType": "local-service",
  "sdkVersion": "^0.1.0",
  "surfaces": [],
  "requestedCapabilities": [],
  "providerRequirements": [],
  "archiveIntegration": {},
  "health": {},
  "installHooks": {},
  "compatibility": {
    "resonantOS": ">=2.0.0-alpha <3.0.0",
    "sdk": "^0.1.0"
  }
}
```

The example identifier `addon.example.notes` follows the Add-on SDK V0
identifier rule (`addon.` reverse-domain), so V0.1 manifests remain valid
against the current validator.

The implementation may retain existing Add-on SDK fields while normalizing names over time.

## Publisher Block

Recommended:

```json
{
  "publisher": {
    "id": "example-developer",
    "displayName": "Example Developer",
    "keyId": "publisher-key-2026-01"
  }
}
```

Publisher identity must not be inferred solely from a display name.

## Optional Manifest Sections

The current Add-on SDK concepts remain supported:

- `provenance`
- `runtimeIsolation`
- `grantPresets`
- `service`
- `tools`
- `delegation`
- `agents`
- `workflowBoundaries`
- `skills`
- `connectors`
- `scripts`
- `hooks`
- `engineerSetup`
- `augmentorSkills`
- `install`
- `audit`
- `embeddedWorkspace`
- `agentRuntime`
- `memoryAccess`
- `smokeTests`

## Package Digest

Certification binds to a cryptographic digest of the normalized package.

Recommended V0.1 algorithm:

```text
SHA-256
```

Example review identity:

```text
addonId: addon.example.notes
version: 1.0.0
packageSha256: <digest>
manifestSha256: <digest>
publisherKeyId: publisher-key-2026-01
reviewId: ROS-ADDON-2026-0042
```

## Signature Envelope

Illustrative:

```json
{
  "algorithm": "ed25519",
  "keyId": "resonant-release-2026-01",
  "addonId": "addon.example.notes",
  "version": "1.0.0",
  "packageSha256": "<digest>",
  "signedAt": "2026-08-24T00:00:00Z",
  "reviewId": "ROS-ADDON-2026-0042"
}
```

The exact cryptographic implementation should receive a dedicated security review before production use.

## Installation Verification Order

The installer must verify data before executing add-on code.

```text
read package
   |
   v
validate archive structure
   |
   v
read manifest
   |
   v
validate manifest schema
   |
   v
calculate digests
   |
   v
verify signatures
   |
   v
check revocation
   |
   v
check compatibility
   |
   v
display capabilities
   |
   v
obtain user grants
   |
   v
install
```

## Package Safety Rules

Packages must not:

- write files during inspection;
- launch processes during inspection;
- contact networks during inspection;
- execute install hooks before authorization;
- contain credentials;
- claim capabilities not present in the manifest;
- replace files belonging to another add-on;
- overwrite kernel-owned files.

## Updates

An update is a new package and a new release identity.

The updater must compare:

- requested capabilities;
- scopes;
- runtime type;
- service definitions;
- connector scopes;
- native/runtime requirements;
- publisher key;
- compatibility range.

Permission expansion must be surfaced to the user.

Sensitive permission expansion must return the release to manual review for official distribution.

## Removal

Removal must:

- disable the add-on first;
- stop host-managed services;
- revoke active capability grants;
- remove package-owned runtime files;
- preserve user data unless the user explicitly elects deletion;
- record an audit event.

## Revocation

The registry may mark a signed release revoked.

A revoked release must not be newly installed.

Existing installations should be disabled or quarantined according to severity and local policy, with a clear explanation to the user.
