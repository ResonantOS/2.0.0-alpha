# Approved-Release Registry Metadata Schema V0.1

## Purpose

Per `RESOLUTIONS_V0.1.md` C10 and `ADR-055` §12.1 (C10 row), REF V0.1
ships a **metadata format and signed approved-release index** as a
versioned JSON document. The live registry service is deferred to
ADR-023 / ADR-024.

This document defines the canonical JSON schema for that index. When
the SDK is extracted to `packages/addon-sdk/` (Phase 1 of the
implementation roadmap), this schema becomes the SDK package's
`registry-metadata.schema.json` plus a typed loader.

## File Layout

The approved-release index ships alongside the SDK package as:

```text
registry/
  index.schema.json          # this document, in JSON Schema form
  approved-releases.json     # signed list of approved releases
  approved-releases.sig      # ed25519 detached signature
```

The signature file uses the signing architecture defined in
`SIGNING_ARCHITECTURE_V0.1.md` (C11). The schema and the index carry a
top-level `schemaVersion: "0.1"` field; future versions may add
fields but must not remove or rename existing fields without a major
version bump.

## Top-Level Shape

```json
{
  "$schema": "https://resonantos.dev/schemas/registry-metadata/v0.1.json",
  "schemaVersion": "0.1",
  "generatedAt": "2026-08-24T00:00:00Z",
  "publisherKeyId": "resonant-approval-2026",
  "signerKeyId": "resonant-approval-2026",
  "releases": [
    /* ApprovedReleaseRecord entries, see below */
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `$schema` | string | The canonical schema URL. Tooling may pin to a specific minor. |
| `schemaVersion` | string | "0.1" for this version. |
| `generatedAt` | string | ISO-8601 timestamp; the moment the index was last signed. |
| `publisherKeyId` | string | The publisher key id that vouches for the entries. |
| `signerKeyId` | string | The signing key id (see C11). |
| `releases` | array | ApprovedReleaseRecord entries (see below). |

## ApprovedReleaseRecord

One entry per approved (`addonId`, `version`):

```json
{
  "addonId": "addon.example.notes",
  "version": "1.0.0",
  "packageDigest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "manifestDigest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "publisherKeyId": "developer-alice-2026",
  "reviewId": "ROS-ADDON-2026-0042",
  "signerKeyId": "resonant-approval-2026",
  "signedAt": "2026-08-24T00:00:00Z",
  "approvedCapabilities": ["archive-read", "archive-intake-write"],
  "releaseTrustTier": "approved",
  "riskClasses": ["low"]
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `addonId` | string | yes | Matches the manifest `id` pattern `^addon\.[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$`. |
| `version` | string | yes | Strict semver. |
| `packageDigest` | string | yes | `sha256:` + lowercase hex; the normalized `.rpkg` digest. |
| `manifestDigest` | string | yes | `sha256:` + lowercase hex; the canonical manifest JSON digest. |
| `publisherKeyId` | string | yes | Key id that signed the publisher signature on the package. |
| `reviewId` | string | yes | Pointer back to the certification review record. |
| `signerKeyId` | string | yes | Key id that signed this index entry. |
| `signedAt` | string | yes | ISO-8601 timestamp. |
| `approvedCapabilities` | array of string | yes | Capability ids approved for this release. |
| `releaseTrustTier` | enum | yes | `developer` / `verified` / `approved` (see C9). |
| `riskClasses` | array of enum | yes | `low` / `moderate` / `high` / `critical` per capability (see C9). |

## Verifier Behavior

A V0.1 verifier performs, in order:

1. Load `approved-releases.json` and `approved-releases.sig`.
2. Verify the signature using `signerKeyId`'s public key (C11).
3. For each candidate package, compute the normalized package digest
   in the same way as the index.
4. Look up `(addonId, version)` in the index `releases` array.
5. Compare package digest, manifest digest, and signer key id.
6. Reject if any mismatch, if the entry is absent, or if any required
   field is missing or malformed.

A release removed from the index is no longer installable; existing
installations follow the revocation flow in
`ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`.

## Rotation

Index rotation: when a new index is published, the previous index
remains verifiable for a grace window. After the grace window, only
the new index is honored by verifiers. The grace window length is set
by the ResonantOS release process; it is not part of the V0.1 schema.

## Compatibility Notes

- The schema is forward-compatible: future minor versions may add
  fields. Consumers must ignore unknown fields.
- `releaseTrustTier` and `riskClasses` are the REF Vocabulary names
  (C9). Runtime fields `provenance.tier` and `agents[].trustTier`
  carry equivalent values for V0.1 backward compat.
- This schema is the metadata format only; the live registry service
  (search, browse, ratings, commerce) is out of scope per ADR-023 /
  ADR-024.

## Source

- `RESOLUTIONS_V0.1.md` C10
- `OPEN_DESIGN_CONFLICTS_V0.1.md` C10
- `ADR-055-resonant-extension-framework.md` §12.1 (C10 row)
- `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`
- `ADDON_CERTIFICATION_AND_SIGNING_V0.1.md`
