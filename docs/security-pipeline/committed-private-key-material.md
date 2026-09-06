# Committed Private Key Material

Issue #351 adds a blocking security-pipeline check for private key material
committed to the repository. The adapter is registered in
[checks.yml](../../.github/security-pipeline/checks.yml) as
`committed-private-key-material`.

## What It Detects

- `private-key-filename`: paths matching signer and private-key file names:
  `*.signer.json`, `*-signer.json`, `*-private*.json`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `*.keystore`, `*.jwk`, and extensionless `id_rsa`, `id_ed25519`, `id_ecdsa`,
  or `id_dsa`.
- `pem-private-key`: `-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----` headers followed
  by a body of at least 40 base64 characters; whitespace and literal JSON string
  `\n` / `\r` escapes are ignored for the count, and no `-----END` footer is
  required (a truncated block with a full body is still usable key material).
- `jwk-private-component`: JSON objects with `kty` of `OKP`, `EC`, or `RSA`
  (matched case-insensitively, so a lowercased `kty` does not hide a key) and a
  string `d` private component of length at least 16; malformed JSON and
  non-JSON text use a regex fallback when `kty` and `d` appear within 800
  characters of each other.

Only standard base64 PEM bodies are matched; base64url-encoded bodies are
non-standard and not detected.

## Scope

In a git checkout the check scans every tracked path (`git ls-files`), so it
covers exactly what a commit would publish; untracked local files are not
scanned. Outside a git checkout it walks the directory tree, skipping `.git`
and `node_modules`. Filenames are checked for every path; contents are checked
for text files up to 2 MiB (binary extensions such as images and archives are
skipped) up to 16 MiB, configurable per check with `maxContentBytes`. Larger
files and tracked paths that cannot be read are reported as `oversized` /
`unreadable` evidence so they stay visible without failing the check; a git
submodule appears as one `unreadable` entry and its contents are not scanned.
An allowlist entry covers every failing finding kind (filename, PEM, JWK) for
that one path.

## Evidence

Evidence reports path, line, kind, status, and a 12-hex-character SHA-256
fingerprint of the matched material. It never prints PEM bodies, JWK `d` values,
or other matched secret material, so logs can show where the problem is without
disclosing the private key again.

## Allowlisting

Prefer generating test keys at test time. If a deliberate fixture must be
committed, add its exact repo-relative path to the check's `allowlist` in
[checks.yml](../../.github/security-pipeline/checks.yml) with a non-empty
`reason`:

```json
{
  "path": "test/fixtures/example.pem",
  "reason": "documented redaction fixture"
}
```

An allowlist entry without a reason fails the check.

## Run Locally

```bash
node scripts/security-pipeline/run-check.mjs --check committed-private-key-material
```
