# Signing Architecture V0.1

## Purpose

Per `RESOLUTIONS_V0.1.md` C11 and `ADR-055` §12.1 (C11 row), REF V0.1
uses native `crypto.sign` / `crypto.verify` ed25519 via Node's built-in
crypto module. First-party bundles remain trust-by-bundling in V0.1;
key custody (offline root, rotating release-signing key, publisher
keys, revocation metadata) is deferred to the security pipeline review.

This document defines the canonical signing envelope, key ids, and
verification behavior. When the SDK is extracted to `packages/addon-sdk/`
(Phase 1 of the implementation roadmap), this becomes the SDK package's
`sign.ts` helper plus typed verifier.

## Algorithm

- **Algorithm**: Ed25519 (edwards25519sha512no secret key wrapping).
- **Library**: Node.js built-in `node:crypto` — `crypto.sign(null, data, key)`
  and `crypto.verify(null, data, key, signature)`. The `null` digest
  selects Ed25519 internally (no separate digest is required).
- **Encoding**: raw 64-byte signature bytes, base64url-encoded in JSON
  envelope files (no `-----BEGIN` PEM headers in V0.1 envelopes).

## Key Identifiers

Each key carries a stable string identifier (`keyId`). The format is:

```text
<role>-<owner>-<year>
```

Examples:

- `resonant-approval-2026` — ResonantOS release-signing key (signs the
  approved-release index).
- `developer-alice-2026` — Alice's publisher key.
- `bundled-core` — sentinel keyId for first-party bundles that do not
  carry a publisher signature.

The `keyId` is recorded in the index entry and in the package signature
envelope. Verifiers fetch public keys by `keyId` from a trusted source
(out-of-band for V0.1; the security pipeline review will define the
distribution mechanism).

## Signature Envelope

A V0.1 package carries zero or more detached signatures in
`signatures/*.sig`. Each signature is a JSON envelope:

```json
{
  "schemaVersion": "0.1",
  "addonId": "addon.example.notes",
  "version": "1.0.0",
  "packageDigest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "manifestDigest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "keyId": "developer-alice-2026",
  "algorithm": "ed25519",
  "signedAt": "2026-08-24T00:00:00Z",
  "signature": "<base64url-encoded 64-byte Ed25519 signature>"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | string | yes | "0.1" for this version. |
| `addonId` | string | yes | Matches the manifest `id`. |
| `version` | string | yes | Strict semver. |
| `packageDigest` | string | yes | `sha256:` + lowercase hex; the normalized `.rpkg` digest. |
| `manifestDigest` | string | yes | `sha256:` + lowercase hex; the canonical manifest JSON digest. |
| `keyId` | string | yes | Stable key identifier (see above). |
| `algorithm` | string | yes | Currently only `ed25519` is allowed in V0.1. |
| `signedAt` | string | yes | ISO-8601 timestamp. |
| `signature` | string | yes | base64url-encoded signature bytes. |

The signature is over a canonical payload built from the envelope:

```text
payload = "${addonId}\n${version}\n${packageDigest}\n${manifestDigest}\n${keyId}\n${signedAt}"
```

The payload is then signed with the private key corresponding to
`keyId`. Verification reconstructs the same payload and calls
`crypto.verify`.

## Trust Tiers and Required Signatures

| `releaseTrustTier` | Required signatures |
| --- | --- |
| `developer` | publisher signature optional; no ResonantOS signature required |
| `verified` | publisher signature required; ResonantOS verification signature required |
| `approved` | publisher signature required; ResonantOS approval signature required |

The `bundled-core` keyId is the sentinel for first-party bundles that
do not carry a publisher signature (`developer` tier only). A bundled
add-on may not claim `verified` or `approved` without a real publisher
signature and a real ResonantOS signature.

## Verification Behavior

A V0.1 verifier performs, in order:

1. Load each `signatures/*.sig` envelope.
2. Look up the public key for `keyId`.
3. Reject if `algorithm` is not `ed25519`.
4. Reconstruct the canonical payload from the envelope fields.
5. Call `crypto.verify(null, payload, publicKey, signatureBytes)`.
6. Reject the signature on any failure; collect successful signatures
   by `keyId`.
7. Determine the effective `releaseTrustTier` from the highest tier
   whose signature verifies successfully.
8. Reject the package if the effective tier is below what the
   installation channel requires.

## Key Custody

Per `RESOLUTIONS_V0.1.md` C11, detailed key custody is deferred to the
security pipeline review. The V0.1 minimum:

- Production signing keys MUST NOT live in the source repository.
- The ResonantOS approval signing key MUST be offline or protected.
- Release-signing keys SHOULD rotate annually; the previous key
  remains valid for a grace window equal to the registry grace window
  (see `REGISTRY_METADATA_SCHEMA_V0.1.md`).
- Publisher keys are owned by the publisher; their revocation is the
  publisher's responsibility, with an out-of-band channel to the
  ResonantOS approval signer.

## Compatibility Notes

- The envelope is forward-compatible: future minor versions may add
  fields. Consumers must ignore unknown fields.
- A future V1 may add additional algorithms (e.g. `dilithium3` for
  post-quantum). V0.1 verifiers must reject anything that is not
  `ed25519`.

## Source

- `RESOLUTIONS_V0.1.md` C11
- `OPEN_DESIGN_CONFLICTS_V0.1.md` C11
- `ADR-055-resonant-extension-framework.md` §12.1 (C11 row)
- `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`
- `ADDON_CERTIFICATION_AND_SIGNING_V0.1.md`
- `REGISTRY_METADATA_SCHEMA_V0.1.md`
