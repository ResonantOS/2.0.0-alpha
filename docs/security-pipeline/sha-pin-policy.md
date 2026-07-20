# Action SHA-Pinning Policy

- **Owner:** Tom Pennington (@tompennington) — release-trust lane.

## Rule

Every GitHub Actions `uses:` reference in any workflow MUST be pinned to a full
**40-character commit SHA**. Tag refs (`@v4`), branch refs (`@main`), and short
SHAs are **not** acceptable, because tags and branches are mutable and a
compromised upstream can repoint them at malicious code.

Required form:

```yaml
uses: owner/repo@<full-40-char-commit-sha> # vX.Y.Z (human-readable tag in comment)
```

- The 40-char SHA is the authoritative pin: regex `@[0-9a-f]{40}\b`.
- A human-readable version MAY be recorded in a trailing comment for review
  ergonomics, but the comment is advisory only and is never the pin.
- This rule applies to first-party and third-party actions alike, including
  re-usable workflows referenced via `uses:`.

## Rationale

Pinning to an immutable commit SHA removes the supply-chain risk of mutable tag
or branch references being silently repointed. It is the baseline control the
security-observe workflow (see `.github/workflows/security.yml`) leads by
example on before any enforcement is promoted.

## Scope

This policy is enforced in **observe/warn** mode only. Promotion to a
blocking/required check is tracked on the release-trust roadmap and requires the
release-trust owner's sign-off.

## Verification

A promoted enforcement check would assert, for every `uses:` line, a match of
`@[0-9a-f]{40}` and reject any tag/branch/short-SHA ref. In observe mode this is
reported, not enforced.
