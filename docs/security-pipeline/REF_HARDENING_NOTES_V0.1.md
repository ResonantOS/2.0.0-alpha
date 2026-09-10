# REF Bridge Hardening Notes — V0.1

Status: design-stage proposal at the framework level, with hardening
landed at the runtime level on the spike branch.

This document is the security companion to
`docs/design/resonant-extension-framework/` (forthcoming), and the
applied-runtime companion to `RESOLUTIONS_V0.1.md` items C2 and C5
(see the open-design-conflicts document for the full set). It is read
alongside the framework package, not in place of it.

## Where the live code lives

All hardening lives on branch `spike/caller-attributed-tokens` in
`vonstegen/2.0.0-alpha` (your fork). The branch contains four commits in
this order:

```
92659c1  bridge: redaction, rotation, allowlist, fail-fast, boot log (H3)
779f16d  bridge: denied audit emission with reason codes (H2)
0d5f7ae  bridge: callerId-bound HMAC tokens (Phase 3.5 hardening H1)
6617a63  bridge: caller-attributed grants store + audit ledger (hook-up B)
 9e28f3f  bridge: thread perCallerGrants + auditSink through handler (hook-up A)
 60c0129  spike: caller-attributed bridge capability tokens (kernel)
```

It is not yet merged into `feat/tab-referencing` or `dev`. ADR-038
acceptance is the natural moment to surface a single squashed or
cherry-picked "Phase 3.5 implementation" commit on the framework
branch.

## Threat model addressed

The original Phase 3.5 kernel (commit `410e508` "docs: define
Resonant Extension Framework V0.1") describes caller attribution as
`X-ResonantOS-Bridge-Caller-Id` alongside `X-ResonantOS-Bridge-
Capability-Token`. That data shape is honest about its limitations:

- `callerId` is whatever the client claims.
- `capabilityToken` is a static per-bridge opaque string.

The kernel proves the *data shape* of per-caller attribution. It does
not bind `callerId` to the holder of the token. Combined, an adversary
who possesses any capability token (legitimately or by stealing) can
forge the `callerId` header and the bridge accepts the request as if it
came from any caller. H1-H3 close that gap and several adjacent ones.

### What an adversary on the loopback bridge interface can do today

Loopback-only, but attacker code does not need the extension:

1. **Token replay** — the static capability tokens minted at bridge
   startup are reusable until bridge restart. Combined with #2, this
   is the dominant attack.

2. **Caller-id spoofing** — `X-ResonantOS-Bridge-Caller-Id` is
   unauthenticated in the kernel. Without H1, an attacker holding one
   valid token can claim to be any caller.

3. **Forged tokens** — `capabilityToken` was a `randomBytes` string
   with no integrity. An adversary who guessed any of 23 strings
   (one per capability type) got the capability.

4. **Audit blindness on denial** — denial paths (401/403/404/500) did
   not write audit records, so the chip UI couldn't triage probing.

5. **No redaction** — the audit trail could carry URL secrets, header
   secrets, or token-shaped values verbatim.

6. **Disk DoS via unbounded growth** — audit ledger wrote with no
   rotation, no cap.

7. **No callerId allowlist** — `mintGrant` would mint for any string,
   including `"../etc/passwd"`-shape strings.

8. **Smuggle callerId via shape** — the caller-id regex was loose; a
   caller could send whitespace or slashes that survived serialization.

9. **Boot had no observability** — misconfigured launchers shipped with
   no add-ons authorised, silently.

## What H1-H3 change

### H1 — caller-attributed HMAC tokens (commit `0d5f7ae`)

- New `bridge-attributed-token.mjs`: tokens are now
  `<base64url(payload)>.<base64url(signature)>` where:
  - `payload = { callerId, capability, expiresAt, nonce }` as JSON
  - `signature = HMAC-SHA256(tokenKey, rawPayloadBytes)`
- New `bridge-token-key.mjs`: per-bridge-process 32-byte HMAC key,
  regenerated on every bridge restart. Tokens minted in a previous run
  become unverifiable on next start (matches the in-memory grants
  store's lifetime; see RESOLUTIONS_V0.1 C2 option (a)).
- `bridge-grants-store.mjs`: `verifyCallerGrant` consults the live
  bucket before letting the HMAC verifier run, so revocation is
  immediate. `mintGrant` no longer accepts a forgeable string.
- `bridge-server.mjs`: every launcher-func accepts and threads
  `tokenKey` and `callerGrantVerifier` through to
  `evaluateBridgeRequestForSelfTest`. A callerGrantVerifier callback
  from the live store is the bridge's primary auth path; the snapshot
  map (still accepted) is the legacy fallback for launchers that
  haven't opted in.

Adversary case closed: forging the caller-id header no longer
matters; the callerId comes from the verified HMAC payload inside
the token. TokenForgery closes because the signature is constant-time
compared against a per-process secret an attacker cannot read.

### H2 — denied-audit emission with reason codes (commit `779f16d`)

Every deny path inside `evaluateBridgeRequestForSelfTest` now emits a
JSONL record through the auditSink:

| HTTP | Reason              | CallerId logged        |
| ---- | ------------------- | ---------------------- |
| 401  | `bridge-token`      | `anonymous`            |
| 404  | `unknown-route`      | `anonymous`            |
| 403  | `bootstrap-missing`  | `anonymous` (or header) |
| 403  | `capability-denied`  | header value if present |
| 500  | `internal-error`     | `internal`              |
| 200  | `authorized`         | verified callerId      |

Audit records never carry the supplied capability token. The supplied
callerId is logged only when present in the request shape — it does
not authenticate, only attribute.

### H3 — redaction, rotation, allowlist, fail-fast, boot log
(commit `92659c1`)

- `bridge-redact-audit.mjs`: walks each string field of the record
  through the existing `redactTraceText` scrubber. URL parameters
  matching `(token|key|secret|password|...)` are replaced with
  `REDACTED`. Hex-shaped tokens are replaced with `[REDACTED-TOKEN]`.
- `bridge-audit-ledger.mjs`: append-only is no longer the only mode.
  When a write crosses `maxBytes` (default 10 MiB), the file rotates
  to `<filePath>.1`, `.2`, ..., `.<maxFiles-1>`. Beyond that, the
  oldest is best-effort dropped. Path sanitation rejects NUL bytes and
  `..` path components.
- `bridge-grants-store.mjs`: optional `callerIdAllowlist` rejects
  mintGrant for callerIds outside a hard-coded list. The minimal
  launcher passes `["hermes", "opencode", "resonant-context",
  "resonator"]`, so the bundled add-ons are the entire known keyspace.
- `run-bridge-minimal.mjs`: wraps `createBridgeAuditLedger` in a
  try/catch and exits non-zero if init throws — a misconfigured audit
  surface can no longer go unnoticed.
- `run-bridge-minimal.mjs`: prints a `caller_grants_ready` JSON line
  at boot with caller count, grant count, the allowlist, the audit
  path, and an 8-character SHA-256 fingerprint of the per-process
  tokenKey.
- `bridge-server.mjs`: `callerIdFromHeaders` now uses the same regex
  as the mint layer (`/^[a-z0-9][a-z0-9._-]{0,80}$/`) so a caller-id
  header can't smuggle whitespace or path components.

## How to read this against RESOLUTIONS_V0.1.md

- C2 / Phase 3.5 (caller attribution, capability tokens): **closed**.
  H1-H3 deliver the runtime against which ADR-038 will be drafted.
- C5 (capability mapping): still open. The capability vocabulary at
  the bridge layer is 23 fine-grained tokens; the manifest vocabulary
  is 13 coarse entries. The H1 + H3 design does not collapse this; an
  explicit mapping table is the next step.
- C4 (executable surface): still deferred. V0.1 add-ons remain
  declarative. M0 Test A is still deferred past V0.1.
- C1, C6, C7, C8, C9, C10, C11, C12, C13: unchanged from the
  resolutions doc. None of H1-H3 close them.

## What is not yet addressed (deferred from the hardening review)

- **C2 option (b)** — full mediation where add-on iframes have no
  bridge credentials and call a `postMessage` API. This is the
  long-term direction; H1 is the local ground-truth that we will
  re-enter when iframes are next touched.
- **On-disk HMAC key** — the per-process key is regenerated on
  restart, so tokens die with the bridge. Persisting the key across
  restarts requires key custody (HSM/CI KMS), which is the C11
  signing-architecture decision that was deferred to the security
  pipeline.
- **Bridge-side enforcement of Test B's "denied unauthorized action"
  half** — M0 Test B refers to a real Local Files reference add-on that
  does not yet exist. The kernel of Test B is enforced (H1's
  verifyCallerGrant rejects revoked grants; H3's allowlist rejects
  rogue callers). The full integration with a sample add-on is a
  separate effort.
- **Production launcher wiring** — `resonantos-bridge-full.mjs`
  (when the file lands in this fork) needs the same H1-H3 wiring as
  the minimal launcher. The wiring is a copy of `run-bridge-
  minimal.mjs`'s grant-store + audit + tokenKey dance.
- **Extension-side `X-ResonantOS-Bridge-Caller-Id` plumbing in
  `bridge-client.js`** — H1 makes the header redundant as the source
  of attribution (it's now in the token), but production code still
  needs to pass the header so the call site is recognisable in
  legacy logs. A future commit flips bridge-client.js to *only* send
  the token and drop the caller-id header; H1 already supports that
  path (the legacy-fallback static-token path).

## Test surface

The hardening pass added or extended the following test files; all
green at HEAD:

- `browser-first/test/bridge-attributed-token.test.mjs` — 9 cases.
  Mint/verify round-trip, expiry, signature tampering, caller-id
  mismatch, capability mismatch, malformed input, shape regex
  enforcement, unsafe-input rejection.
- `browser-first/test/bridge-grants-store.test.mjs` — 11 cases.
  H1 token verification through the store; H3 allowlist honour;
  malformed-allowlist rejection; revocation observability.
- `browser-first/test/bridge-audit-ledger.test.mjs` — 8 cases.
  H3 redaction pipeline; redact:false opt-out; rotation under
  maxBytes; path sanitation (NUL, `..`); bad `maxBytes`/`maxFiles`
  rejection.
- `browser-first/test/bridge-caller-attributed-integration.test.mjs`
  — 2 cases. End-to-end through `createBridgeRequestHandler` with a
  real grants store + audit ledger.
- `browser-first/test/bridge-denied-audit.test.mjs` — 6 cases. H2
  reason-code emission per deny path; no-token-leak invariant.

Together: 36 hardening-related tests, all green at HEAD.

## Reviewer checklist

1. The `bridgeAudit.sink` reference in `run-bridge-minimal.mjs`
   lines 446 ish must continue to resolve. If a refactor removes the
   `bridgeAudit` const, the launcher crashes silently at startup.
   The fail-fast in H3 should make this obvious in CI.
2. The `tokenKey` and `callerGrantVerifier` parameters must remain
   optional in every launcher-func signature. Removing `= undefined`
   would break any downstream consumer who calls these with positional
   arguments.
3. Audit-record consumers in the chip UI should now filter on
   `reason` (string) plus `status` (numeric), not just `status`.
   Reason code values are stable across H1-H3.
