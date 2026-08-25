# ADR-038 — Resonant Extension Framework

> **Draft.** The ADR's body prose is drafted from the framework package and
> the resolution documents. The §12 walk is complete; every conflict
> from `OPEN_DESIGN_CONFLICTS_V0.1.md` and `RESOLUTIONS_V0.1.md` has a
> V0.1 commitment or an explicit future-ADR pointer. The Decision Metadata
> still records the ADR as `Deferred` (draft stage) pending proposer
> review and acceptance. The body prose is reviewable section by
> section.

## Decision Metadata

- Decision status: **Deferred**
- Superseded by: None
- Alpha applicability: **Partial**
- Owner: Add-on SDK
- Decision date: **pending** (will be set when promoted to Accepted)

The trust-tier mapping (§4), capability model (§5), and runtime boundary (§7) are locked enough to be cross-referenced from `RESOLUTIONS_V0.1.md`. The remaining sections (1, 2, 3, 6, 8, 9, 10, 11, 13, 14) are drafted prose from existing source documents, ready for reviewer shaping.
- Source: forked from `PROPOSAL-resonant-extension-framework.md`, with the resolutions from `RESOLUTIONS_V0.1.md`, the conflict framing from `OPEN_DESIGN_CONFLICTS_V0.1.md`, the review-feedback notes (`EXTERNAL_REVIEW_FEEDBACK_V0.1.md`, `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md`, `ADDON_PERSONAL_PLUGIN_GOVERNANCE.md`), and the runtime hardening notes (`docs/security-pipeline/REF_HARDENING_NOTES_V0.1.md`).

## 1. Decision

ResonantOS formalizes its existing add-on architecture as the
**Resonant Extension Framework (REF)** — extension of, not replacement
for, ADR-006 and ADR-018.

REF is the governed system by which third-party and first-party add-ons
are defined, validated, tested, reviewed, signed, distributed, installed,
granted capabilities, executed, updated, disabled, and removed. The
existing `src/sdk/addons/` contracts remain the starting point; the
framework packages and hardens those boundaries into a stable
developer-facing contract.

An add-on that wants to operate inside ResonantOS must:

1. declare itself using the Resonant Add-on SDK manifest contract;
2. request all capabilities explicitly;
3. pass SDK validation;
4. execute privileged operations only through host-mediated APIs;
5. pass the applicable automated certification suite;
6. be cryptographically signed for verified or approved distribution;
7. receive explicit user grants before using requested capabilities.

Official catalog distribution additionally requires ResonantOS review and
approval for the specific add-on version.

Source: `PROPOSAL-resonant-extension-framework.md` Decision; the four
questions of the architectural principle (§2); ADR-006 (Add-on Runtime
& SDK); ADR-018 (Add-on SDK V0).

## 2. Architectural Principle

The framework separates four questions that must never be conflated:

1. **What is the add-on?** — declared by the manifest.
2. **What does the add-on request?** — declared capabilities.
3. **What may the add-on do on this machine?** — decided by the
   ResonantOS host and user grants.
4. **What does the ResonantOS project trust and distribute?** —
   decided by certification and signing policy.

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

The core principle, restated from the framework package and
`OPEN_DESIGN_CONFLICTS_V0.1.md`:

> Manifest declares. Validation checks. Certification evaluates.
> Signature identifies. User grants. Host enforces.
>
> Approval is never a substitute for runtime authorization.

SDK validation, approval, and runtime authority stay separate. Per
`ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 6, a positive
review decision **never lowers** a runtime authority check.

Source: `PROPOSAL-resonant-extension-framework.md` Architectural
Principle; `OPEN_DESIGN_CONFLICTS_V0.1.md` Background in Sixty Seconds;
`ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 6.

## 3. Lineage

ADR-038 is an evolution of existing work, not a replacement.

```text
ADR-006 Add-on Runtime & SDK
    ↓
ADR-018 Add-on SDK V0  (binding internal standard, src/sdk/addons)
    ↓
ADR-038 Resonant Extension Framework (public evolution; declarative-only V0.1)
    ↓
ADR-023 / ADR-024 (registry / commerce — deferred per C10)
```

ADR-006 establishes the Add-on Runtime & SDK with manifest validation,
provenance, capabilities, and host mediation. ADR-018 establishes the
binding internal standard at `src/sdk/addons/`. ADR-038 extends both
toward a public, third-party-capable contract.

`ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 8 makes the
evolution-not-replacement posture explicit: future public/third-party
work should extend the existing Add-on SDK decisions, not introduce an
unrelated extension framework that duplicates manifests, capabilities,
lifecycle, or runtime authority.

The framework package (`docs/addons/resonant-extension-framework/`)
carries the design-stage documentation that this ADR accepts. On
acceptance, the proposal becomes the body of this ADR and the
specifications move to `docs/addons/`, per the framework README
"Staging" section.

Source: `EXTERNAL_REVIEW_FEEDBACK_V0.1.md` Alignment Map and Fork
Strategy; `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 8;
framework package README.

## 4. Trust Model

The four-state core rule governs every add-on, regardless of trust tier:

```text
VALID != VERIFIED != APPROVED != GRANTED
```

`ADDON_CERTIFICATION_AND_SIGNING_V0.1.md` documents the rule in full. REF
inherits it unchanged.

REF's three trust tiers map onto the existing `AddOnProvenanceTier` enum
(`bundled-core | curated-signed | enterprise-signed | sideloaded-unverified`)
per `RESOLUTIONS_V0.1.md` C1 (option a — Map only). The mapping table:

| REF tier | Existing enums |
|---|---|
| Developer / Sideloaded | `sideloaded-unverified` + `unverified` + `unreviewed` |
| Verified | `curated-signed` + `verified` + `reviewed` |
| Resonant Approved | `curated-signed` + `verified` + `approved`, bound to per-`(addonId, version)` approval record |

`bundled-core` is first-party (trust-by-bundling, not signature). `enterprise-signed`
is a future value with no V0.1 work. Per-version approval is mandatory — the
package digest and manifest digest both bind to the approval record.

### User policy for personal / self-built add-ons

`ADDON_PERSONAL_PLUGIN_GOVERNANCE.md` records the user's policy: approved
add-ons appear in the official listing stamped by the ResonantOS team;
private or self-built add-ons are **not approved** and **may cause a
ResonantOS crash requiring automatic recovery**. The chip-UI warning text
is the user-facing surface for this consequence. The runtime contract
itself does not distinguish "personal" from "sideloaded" by enum value —
that distinction is a display concern in V0.1, recorded as the
`personal-local` deferred item in §12.

### The boundary the runtime enforces

Capability grants (manifest declared → user-granted → host-mediated →
audit-attributed via Phase 3.5) are authoritative regardless of trust
tier. Approval is never a substitute for runtime authorization.

## 5. Capability Model

Three vocabularies coexist today:

1. **Manifest capabilities** (13 coarse + 2 V0.1 additions; see
   §12.1): `filesystem`, `archive-read`, `archive-intake-write`,
   `chat-interface`, `memory-provider`, `providers`, `shell`, `network`,
   `ui-embedding`, `browser-control`, `agent-delegation`,
   `notifications`, `device-integration`, plus `channel.send` and
   `channel.account-write` per the §12 commitment.
2. **Bridge route capabilities** (23, fine-grained): the per-route
   capability-token set at `browser-first/host/bridge-capability-tokens.mjs`.
   A consistency test locks this list to the extension-side allowlist.
3. **Browser-first add-on capabilities** (informal): a second, untyped
   manifest format at `browser-first/addons/*/addon.json` for the
   bundled first-party add-ons.

`RESOLUTIONS_V0.1.md` C5 (option a) ships a single mapping table owned
by the SDK package. The mapping is a versioned data file inside the
public SDK (`packages/addon-sdk/`). Validation warns when a requested
manifest capability maps to nothing; the bridge authorises at route
granularity using the same data.

```text
Manifest capability (coarse, public SDK surface)
        |
        v
SDK-owned capability-mapping table (data, not code)
        |
        v
Bridge route capability (fine-grained, runtime)
```

The principle: **manifest declares; bridge enforces at route granularity.**
The host retains final authority over what any operation actually does,
independent of manifest or signing.

`ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 3 records the
deferred refinement for V1: `channel.receive` and `channel.account-read`
as further subdivisions of the `communication-channel` capability.
The C5 mapping table picks up all capability entries including the
`channel.*` additions.

Source: `OPEN_DESIGN_CONFLICTS_V0.1.md` §"Three capability
vocabularies coexist"; `RESOLUTIONS_V0.1.md` C5;
`ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 3.

## 6. Manifest & Package Format

The manifest is the developer-facing source of truth. V0.1 retains the
existing `AddOnManifest` shape from `RESONANT_ADDON_SDK_SPEC_V0.1.md`
and `src/sdk/addons/contracts.ts`:

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

The package format is `.rpkg` (per `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`).
A package may be a deterministic ZIP container internally; the file
extension and packaging conventions are `.rpkg`. The
`scripts/check-repo-hygiene.mjs` archive-zip rule is amended to add
`.rpkg` to the allowlist (see §12.1, C6).

```text
example-notes-1.0.0.rpkg
|
+-- resonant.addon.json
+-- package/
|   +-- compiled add-on assets
|   +-- UI assets
|   +-- service assets
+-- skills/
+-- docs/
+-- tests/
+-- provenance/
|   +-- checksums.json
|   +-- build.json
+-- signatures/
    +-- publisher.sig
    +-- resonant-approval.sig   # official releases only
```

Certification binds to a cryptographic digest of the normalized package.
The digest and manifest digest both bind to the per-version approval
record (`§4 Trust Model`). Updates are new packages with new release
identities; permission expansion returns the release to manual review.

Source: `RESONANT_ADDON_SDK_SPEC_V0.1.md` Required Manifest Fields;
`ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md` Package Layout and Required
Package Properties; §12.1, C6 resolution.

## 7. Runtime Boundary

Add-on code reaches privileged resources only through the chain:

```text
Add-on / Extension UI
        |
        v
Resonant SDK API
        |
        v
Authenticated Resonant Bridge  (browser-first/host/bridge-server.mjs)
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
Provider secrets, raw credential values, protected user state, trusted
archive promotion, unrestricted process launch, and other privileged
resources remain host-side. Add-ons never receive raw provider
credentials (§8 Phase 3.5 hardening).

`RESOLUTIONS_V0.1.md` C3 (option c) scope-excludes the browser-first
`browser-first/addons/*` add-on system from REF V0.1: those add-ons are
declared *extension-internal*, not third-party. The boundary is the
privilege boundary, not the directory boundary: anything reachable from
extension content scripts without going through the Phase 3.5
bridge-caller-token machinery is first-party and out of REF scope.

The boundary clause:

> Third-party add-on code cannot invoke any bridge route that is not
> gated by a caller-attributed token minted under Phase 3.5. The
> browser-first executable content scripts remain first-party because
> they are not in the add-on loader path.

V0.1 add-ons are declarative-only per §9: no shipped third-party code
runs in the shell.

Source: `PROPOSAL-resonant-extension-framework.md` Runtime Boundary;
`RESOLUTIONS_V0.1.md` C3; §8 Phase 3.5 — Caller-Attributed Capability Tokens;
`REF_HARDENING_NOTES_V0.1.md`.

## 8. Phase 3.5 — Caller-Attributed Capability Tokens

The runtime kernel of REF in this fork is Phase 3.5 caller-attributed
capability tokens. `RESOLUTIONS_V0.1.md` C2 (option a) records the
decision: a per-caller grant store keyed `(callerId, capability,
scope)`, with HMAC-signed tokens per caller.

The implementation landed on branch `spike/caller-attributed-tokens` and
is documented in `docs/security-pipeline/REF_HARDENING_NOTES_V0.1.md`.
The H1–H4 design choices — HMAC-signed tokens, denied-audit reason
codes, redaction pipeline, rotation, allowlist, fail-fast, boot log —
are part of REF's runtime contract, not optional hardening:

- **H1 callerId-bound HMAC tokens.** Each token carries
  `{ callerId, capability, expiresAt, nonce }` inside an HMAC-SHA256-signed
  payload separated by `.`. The bridge auth path prefers a
  `callerGrantVerifier` callback from the live grants store over the
  snapshot map, so revocation takes effect immediately.
- **H2 denied-audit emission with reason codes.** Every deny path
  inside `evaluateBridgeRequestForSelfTest` emits a JSONL record with
  a structured reason: `bridge-token` (401), `unknown-route` (404),
  `bootstrap-missing` (403), `capability-denied` (403),
  `internal-error` (500), or `authorized` (200). Records never carry the
  supplied capability token.
- **H3 redaction, rotation, allowlist, fail-fast, boot log.** Audit
  records are redacted (URL/header parameters) before serialisation. The
  ledger rotates at a configurable byte cap with rolling files. The
  grants store accepts an optional `callerIdAllowlist` that constrains
  the keyspace. The minimal launcher fails fast on audit-ledger init
  failure. A boot log line summarises caller count, grant count, and a
  short tokenKey fingerprint.

Phase 3.5 is the gate before Phase 4 (host install + lifecycle) and
before M0 Tests B and C. The runtime hardening work landed on a fork
branch; `UPSTREAM_DELTA.md` records the fork-only status.

Source: `RESOLUTIONS_V0.1.md` C2; `REF_HARDENING_NOTES_V0.1.md`;
`IMPLEMENTATION_ROADMAP_V0.1.md` Phase 3.5.

## 9. V0.1 is Declarative-Only

`RESOLUTIONS_V0.1.md` C4 locks V0.1 as declarative-only:

> **Decision:** Option (a) — V0.1 is declarative-only.

V0.1 add-ons are manifest + host-mediated tools + local services; no
shipped third-party code runs in the shell. The runtime is responsible
for any executable surface.

Consequences:

- **M0 Test A (Hello Resonant with a UI surface) is removed** from the
  M0 milestone and renamed to "post-V0.1 sandbox surface" (§12.3).
- **C4 (executable surface)** is the largest hidden work item in the
  proposal. No roadmap phase builds it in V0.1.
- The "no shipped third-party code runs in the shell" rule is locked
  for V0.1. Add-ons that need to ship code (e.g. local services) ship
  it through the host-mediated local-service definition; the host runs
  it; the add-on declares it.

V0.1 still delivers the ecosystem's enforcement half (trust tiers,
capability model, lifecycle, certification, signing, registry, capability
mapping, Phase 3.5 hardening). It defers the code-running half until
after Phase 3.5 is mature and a sandbox surface decision can be made
with real evidence.

Source: `RESOLUTIONS_V0.1.md` C4; `IMPLEMENTATION_ROADMAP_V0.1.md` V0.1
declarative-only decision.

## 10. Certification, Signing, Review, Registry

The certification pipeline carries the four-state core rule from
`ADDON_CERTIFICATION_AND_SIGNING_V0.1.md`:

```text
VALID != VERIFIED != APPROVED != GRANTED
```

- **Valid**: conforms to SDK contracts.
- **Verified**: release identity/signature and required automated checks
  are valid.
- **Approved**: ResonantOS review accepted this exact release for official
  distribution.
- **Granted**: the current user or authorized policy allowed a requested
  capability on this machine.

Approval is **version-specific**. A new version must be certified again.
A release that adds or materially broadens sensitive capabilities
automatically returns to human review (§4 Trust Model mapping table;
§6 Manifest & Package Format permission expansion rules).

Automated certification gates (V0.1 minimum):

- **Manifest**: schema valid; stable add-on id; valid semver; supported
  SDK range; supported runtime type; tool capabilities appear in
  requested capabilities; no unknown privileged capability; no duplicate
  tool ids; no invalid system-slot claims.
- **Package integrity**: structure valid; no path traversal;
  normalized digest reproducible; no secret-like files in prohibited
  locations; no unsigned mutation after submission.
- **Dependencies**: dependency inventory produced; lockfile present when
  applicable; known critical vulnerabilities flagged; prohibited
  dependency classes flagged by policy; bundled executable/native
  assets identified.
- **Capability audit**: machine-readable capability report (requested,
  granted-by-default: none, risk class, scope, reason, tools/hooks/
  connectors requiring capability).
- **Runtime tests**: install in clean test profile; enable; health
  check; deterministic smoke test; disable; re-enable; remove; verify
  no unauthorized host calls.
- **Compatibility**: supported ResonantOS range; supported SDK range;
  manifest schema version; runtime protocol support; deprecated API
  warnings.

Review triggers (manual review required when any of these apply):
requests a high-risk or critical capability; expands sensitive
capabilities from the prior approved version; launches or installs a
local service; bundles native executable code; controls a browser;
accesses microphone/camera/device integrations; performs external
account mutation; requests shell-mediated commands; participates in
identity signing; handles credentials beyond approved host references;
supplies self-updating code; changes publisher signing identity; requests
a broad filesystem scope; modifies installation behavior.

Review outcomes: `approved`, `approved-with-constraints`,
`changes-requested`, `rejected`, `suspended`, `revoked`. Constraints
are machine-readable where possible.

Key management: production signing keys do not live in the source
repository. Recommended separation: offline or protected root trust
key; rotating release-signing keys; publisher keys; revocation
metadata. Key rotation does not invalidate historical package records
when the old key remains trusted for its valid time window. Detailed
key custody deferred to security pipeline review (§12.1, C11).

The SDK Reviewer Agent (`SDK_REVIEWER_AGENT_V0.1.md`) is the
dogfooded review copilot. It contributes to VALID and VERIFIED; it
*drafts* an APPROVED review record; the APPROVED transition and the
release signature always require a human (or explicit enterprise policy)
decision. The agent's job is to argue against the submission.

Registry (ADR-023) and commerce (ADR-024) are referenced but not
redefined here. Per §12.1 C10, V0.1 ships metadata format and signed
approved-release index as a versioned JSON document in the public SDK
package; the live registry service is deferred.

Source: `ADDON_CERTIFICATION_AND_SIGNING_V0.1.md`; `SDK_REVIEWER_AGENT_V0.1.md`;
`RESOLUTIONS_V0.1.md` C10/C11; ADR-023; ADR-024.

## 11. Developer Workflow

The guiding principle from `ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md`:
make the safe path the easiest path. A developer should not need to
learn ResonantOS kernel internals to produce a compliant add-on.

Developer journey:

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

CLI commands (`@resonantos/addon-sdk-cli`, target V0.1):

- `create` — select template; generate manifest; generate tests; pin
  compatible SDK; create example capability declaration.
- `validate` — manifest schema; capability references; tool/connector/
  hook references; compatibility; package identity; required fields.
- `test` — SDK contract tests; deterministic add-on tests; smoke tests
  against a mock host; lifecycle tests.
- `audit` — human-readable and machine-readable report covering
  capabilities, network access, shell access, native executables,
  certification readiness.
- `package` — build add-on assets; normalize package; generate
  checksums; generate provenance metadata; produce `.rpkg`; optionally
  create publisher signature.
- `submit` (V0.1 may output a submission bundle rather than talking to
  a live registry): `.rpkg` + audit + test + provenance + publisher +
  requested certification tier.

The mock host (`@resonantos/addon-sdk-testing`) rejects undeclared and
ungranted operations. Tests prove that add-ons handle denied
capabilities correctly.

M0 reference add-ons (the three that prove the safe-path principle
end-to-end):

- **Hello Resonant** — manifest, lifecycle, enable/disable. (M0 Test A;
  deferred past V0.1 per §9 declarative-only.)
- **Local Files** — bounded filesystem read; denied filesystem write;
  scope enforcement; audit output. (M0 Test B; runs in V0.1.)
- **Local AI** — provider/inference request; local vs host-selected
  provider abstraction; cancellation; no raw provider credential
  exposure. (M0 Test C; runs in V0.1.)

Documentation requirements for every public SDK API: purpose; authority
boundary; capability requirement; input/output contract; error
behavior; version stability; minimal example.

Developer mode may relax distribution trust requirements but must not
disable capability enforcement (§7 Runtime Boundary).

Source: `ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md`; `RESONANT_ADDON_SDK_SPEC_V0.1.md`
Developer CLI; `IMPLEMENTATION_ROADMAP_V0.1.md` M0 Reference Tests.

## 12. Decisions Recorded by This ADR

The §12 walk committed V0.1 decisions for every item previously deferred
in `RESOLUTIONS_V0.1.md` (C6–C12), recorded two new rows surfaced by
the framework package and the user’s policy on personal/local add-ons,
and resolved the §4 trust-model commitment. The result is that every
conflict on the framework roadmap has either a V0.1 commitment recorded
below or an explicit deferral to a follow-on ADR.

The section is structured as: V0.1 commitments first (these become
implementation gates once the prose is filled in), then cross-references
to source documents, then the deferrals that survive V0.1.

### 12.1 V0.1 commitments

- **C6 container format** — **V0.1:** `.rpkg` is the official package
  format per `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`. The
  `scripts/check-repo-hygiene.mjs` archive-zip rule is amended to add
  `.rpkg` to the allowlist (one-line change). Test fixtures live under
  `tests/fixtures/`. The security pipeline validates `.rpkg` packages
  separately; the hygiene rule is not the security boundary.
- **C7 compatibility evaluation** — install + launch; fold into Phase 1.
- **C8 sideload enablement** — **V0.1:** enable + harden; security-pipeline
  review is its own gate before Tier 1 (Developer/Sideloaded) add-ons
  can be installed. The runtime has `hasCommandHost()` hardcoded
  `false` today; the enable step unblocks the path through the
  host-mediated capability broker (per `RESOLUTIONS_V0.1.md` C2 / Phase
  3.5 hardening, already landed). Per `ADDON_PERSONAL_PLUGIN_GOVERNANCE.md`,
  the personal/local tier follows the same enablement gate with the
  user-facing warning covering the auto-unplug safety policy (deferred to
  ADR-039).
- **C9 naming** — **V0.1:** rename in REF only — `releaseTrustTier`
  (releases) and `capabilityRiskClass` (capabilities) replace any
  parallel vocabulary in REF-produced artifacts. The existing
  `agents[].trustTier` field stays (it describes agent personas, not
  add-on release trust); renaming it is out of REF scope. The rename
  is **landed in docs**: `RESONANT_ADDON_SDK_SPEC_V0.1.md` gains a
  "REF Vocabulary" reference section and
  `ADDON_CERTIFICATION_AND_SIGNING_V0.1.md` gains a "REF Vocabulary
  (C9)" section with the canonical table and explicit values
  (`developer`/`verified`/`approved` for `releaseTrustTier`;
  `low`/`moderate`/`high`/`critical` for `capabilityRiskClass`).
  The runtime fields `provenance.tier` and `agents[].trustTier`
  keep their existing value sets for V0.1 backward compat; the
  formal field rename lands when the SDK is extracted to
  `packages/addon-sdk/`.
- **C10 registry deferral** — **V0.1:** metadata format and signed
  approved-release index ship now as a versioned JSON document in the
  public SDK package; the live registry service is deferred per
  ADR-023/024. The approved-release index carries per-(`addonId`,
  `version`) records: `packageDigest`, `manifestDigest`,
  `publisherKeyId`, `reviewId`, `signerKeyId`, `signedAt`. Index
  rotation: a release removed from the index is no longer installable;
  existing installations follow the revocation flow in
  `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`.
  **The schema is landed in docs:**
  `docs/addons/resonant-extension-framework/REGISTRY_METADATA_SCHEMA_V0.1.md`
  defines the canonical JSON shape, the verifier behavior, the rotation
  rules, and the compatibility guarantees. When the SDK package is
  extracted (Phase 1), this becomes `packages/addon-sdk/registry-metadata.schema.json`
  plus a typed loader.
- **C11 signing architecture** — **V0.1:** native
  `crypto.sign` / `crypto.verify` ed25519 via Node’s built-in
  `crypto` module. Publisher signature format:
  `{ algorithm: ed25519, keyId, addonId, version, packageSha256,
  signedAt, reviewId }` (mirrors the envelope in
  `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`, with `algorithm` set to
  ed25519). First-party bundles remain trust-by-bundling in V0.1
  (`bundled-core` provenance tier; per-version approval records not
  required for bundled). Key custody (offline root, rotating
  release-signing key, publisher keys, revocation metadata) is
  deferred to the security pipeline review.
  **The architecture is landed in docs:**
  `docs/addons/resonant-extension-framework/SIGNING_ARCHITECTURE_V0.1.md`
  defines the canonical signing envelope, key id format
  (`<role>-<owner>-<year>`), trust tier signature requirements, the
  canonical payload format, the verifier behavior, and the V0.1
  algorithm allowlist (`ed25519` only). When the SDK package is
  extracted (Phase 1), this becomes `packages/addon-sdk/sign.ts`
  plus a typed verifier.
- **C12 package location** — **V0.1:** `packages/addon-sdk/` (and
  `packages/addon-sdk-testing/`) from the start, per the §12 Public
  SDK External Boundary resolution. Single source of truth immediately;
  `src/sdk/addons/` becomes a re-export shim pointing at the new
  package. Pay the registration cost once (root `package.json`,
  CI install/audit blocks, release scope audit, docs links, module
  ownership) rather than migrating it incrementally.
- **`personal-local` provenance tier** — **V0.1:** option (a) — `personal-local`
  is a display label over `sideloaded-unverified`. The runtime contract
  (`AddOnProvenanceTier`) is unchanged. The chip UI shows a distinct
  badge for add-ons the user authored locally; the user-facing warning
  text covers the consequence that loading such an add-on may crash
  ResonantOS requiring automatic recovery. Runtime enforcement
  (capability grants, host mediation, Phase 3.5 caller attribution) is
  unchanged. **V1:** revisit if upstream ResonantOS requests a distinct
  enum value.

- **Add-on safety / auto-unplug mechanism** — **deferred.** A runtime
  safety algorithm (small LLM or heuristic) that detects a failing
  add-on, isolates it, and restores the system to a usable state is
  needed to make the `personal-local` runtime story safe. The recovery
  policy (auto-unplug all add-ons vs. auto-unplug only the offending
  add-on) is **yet to be determined**. Deferred to a follow-on ADR,
  candidate **ADR-039**.

- **Communication-channel capability refinement** — **V0.1:** add
  `channel.send` and `channel.account-write` as new manifest
  capabilities alongside the existing `notifications.send`. The chatgpt
  `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 3 subdivisions
  into `channel.receive` and `channel.account-read` are deferred to
  V1. `notifications.send` remains for V0.1 backward-compat. The SDK
  spec records the migration in
  `RESONANT_ADDON_SDK_SPEC_V0.1.md` Capability Model section. The C5
  mapping table picks up the new entries in the same file.

- **Post-V0.1 sandbox surface** — deferred. M0 Test A (Hello Resonant
  with a UI surface) was deferred past V0.1 by `RESOLUTIONS_V0.1.md` C4.
  The "what defines V0.1 done" exit criteria are: Phase 3.5 hardening
  landed; M0 Test B (Local Files) and M0 Test C (Local AI) green; the
  capability-mapping table operational; signing + registry metadata in
  place per Phase 6/8. Only then is Test A reopened.

### 12.2 Cross-references

Every V0.1 commitment above is grounded in source documents:

| Decision | Source |
|---|---|
| §4 Trust Model mapping table | `RESOLUTIONS_V0.1.md` C1 + `PROPOSAL-resonant-extension-framework.md` Trust Tiers |
| `personal-local` display-only stance | `ADDON_PERSONAL_PLUGIN_GOVERNANCE.md` + user policy |
| `channel.send` / `channel.account-write` V0.1 additions | `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 3 |
| `channel.receive` / `channel.account-read` V1 deferral | Same Finding 3 |
| Public SDK external boundary inventory | Phase 0 deliverable; `IMPLEMENTATION_ROADMAP_V0.1.md` Phase 0 |
| C6 `.rpkg` stays official | `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md` + `check-repo-hygiene.mjs` amend |
| C8 sideload enablement | `RESOLUTIONS_V0.1.md` C8 + Phase 3.5 hardening notes |
| C9 naming (`releaseTrustTier`, `capabilityRiskClass`) | `RESOLUTIONS_V0.1.md` C9 |
| C10 registry metadata format | `RESOLUTIONS_V0.1.md` C10 + ADR-023/024 |
| C11 ed25519 signing | `RESOLUTIONS_V0.1.md` C11 |
| C12 package location | `RESOLUTIONS_V0.1.md` C12 + §12 Public SDK boundary |

### 12.3 Deferred to future ADRs

Three items are recorded as deferred and not addressed in V0.1:

- **Add-on safety / auto-unplug mechanism** — **deferred.** A runtime
  safety algorithm (small LLM or heuristic) that detects a failing
  add-on, isolates it, and restores the system to a usable state is
  needed to make the `personal-local` runtime story safe. The recovery
  policy (auto-unplug all add-ons vs. auto-unplug only the offending
  add-on) is **yet to be determined**. Deferred to a follow-on ADR,
  candidate **ADR-039**.

- **Post-V0.1 sandbox surface** — deferred. M0 Test A (Hello Resonant
  with a UI surface) was deferred past V0.1 by `RESOLUTIONS_V0.1.md` C4.
  The "what defines V0.1 done" exit criteria are: Phase 3.5 hardening
  landed; M0 Test B (Local Files) and M0 Test C (Local AI) green; the
  capability-mapping table operational; signing + registry metadata in
  place per Phase 6/8. Only then is Test A reopened.

- **Resonant-OS vs Third-Party SDK capability separation** —
  **deferred to V1.** The 13 coarse manifest capabilities (plus the two
  `channel.*` additions from item 2) are currently all exposed as
  public SDK surface. Resonant-OS devs see internal capabilities (likely
  candidates: `shell`, `browser-control`, `device-integration`,
  `network`) that third-party authors should not be able to request.
  Capability classification: each capability gets a visibility tier
  (Resonant-OS-internal, curated-approved-only, public). The
  third-party SDK rejects capability names above its visibility tier at
  `validateAddOnManifest` time, per chatgpt
  `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 6
  ("SDK validation, approval, and runtime authority must stay
  separate"). V0.1 keeps the current all-public surface; V1 introduces
  the visibility-tier classification in the SDK spec and runtime.
  The classification table itself is a follow-on design call requiring
  review of each capability's blast radius. **Deferred record landed:**
  `docs/addons/resonant-extension-framework/CAPABILITY_SEPARATION_V1.md`
  captures the proposed V1 shape (parallel `PublicCapability` and
  `InternalCapability` enums; SDK-owned mapping at the bridge
  boundary; V1 manifest validation rules; ADR pointer) so a future
  ADR can pick up the work without rediscovery. No V0.1 contract
  changes.

### 12.4 Summary

- **9 V0.1 commitments** recorded (C6, C7, C8, C9, C10, C11, C12,
  `personal-local`, `communication-channel`).
- **1 §4 commitment** recorded (the trust-model mapping table).
- **1 V0.1 commitment** recorded via cross-reference (public SDK external
  boundary — depends on the Phase 0 inventory commit landing first; the
  inventory is recorded as part of the §12 walk and is complete).
- **3 deferrals** recorded (auto-unplug, Post-V0.1 sandbox, capability
  separation).
- **0 unresolved** items from the original §12 outline.

- **Public SDK external boundary** — **V0.1 fork-only, soft cutover
  (alias):** create `packages/addon-sdk/` (and `packages/addon-sdk-testing/`)
  as the public SDK contract boundary. `src/sdk/addons/` becomes a
  thin re-export shim pointing at the new package. Single source of
  truth immediately; consumers don't notice the change.
  **Inventory complete (Phase 0 deliverable):** 5 SDK source files
  move (`src/sdk/addons/{contracts,validation,registry,surface-routing,index}.ts`),
  4 SDK test files move with them. `src/core/contracts.ts` re-exports
  the SDK types so runtime code (chat, browser-tools, delegation,
  logician, memory-provider, policies, runtime) keeps importing from
  `src/core/contracts.ts` without churn. `src/modules/` consumers
  (chip UI, settings, etc.) also unchanged — they only need the
  add-on types, which continue to flow through `src/core/contracts.ts`.
  No runtime blast radius; the cutover is mechanical.
  **V1:** upstream rebase is its own problem; `UPSTREAM_DELTA.md`
  records the fork-only status. The cutover is prerequisite to M0
  (external fixture project compiles and validates while importing only
  the SDK package) and to Phase 4 (host install + lifecycle), per the
  chatgpt `ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Findings 9
  and 10.

## 13. Fork Strategy and Hygiene

REF is fork-owned experimental work. Per `EXTERNAL_REVIEW_FEEDBACK_V0.1.md`
Fork Strategy Guidance:

- Build the framework **beside** the current SDK; do not rewrite the
  Alpha core first. Adapt `src/sdk/addons` contracts into the public
  package; change host/runtime code only when an M0 test proves a
  specific need.
- Mark the work clearly as fork-owned and experimental, with the
  upstream dependency stated (`ResonantOS 2.0.0-alpha`), so it is never
  confused with upstream ResonantOS.
- Keep an `UPSTREAM_DELTA.md` alongside the framework: record every
  change the fork makes to an upstream contract, so future rebases show
  exactly where the fork diverges.
- Suggested progression: document → extract public SDK → external
  add-on fixture → sideload lifecycle → capability enforcement →
  certification → signing → registry.

The fork's `packages/addon-sdk/` (§12.1, public SDK boundary) is a
*demonstration* that the boundary can exist, not a claim about how
upstream will do it. The Phase 3.5 hardening work landed on
`spike/caller-attributed-tokens` (§8); rebasing it back into a
framework branch is its own conversation.

Source: `EXTERNAL_REVIEW_FEEDBACK_V0.1.md` Fork Strategy Guidance;
framework package README "Intended Repository Target".

## 14. Consequence Summary

ADR-038 enables:

- Third-party developers receive a stable target via
  `@resonantos/addon-sdk` (§12.1, public SDK boundary).
- The ResonantOS team gains a repeatable review and signing process
  (§10 certification pipeline; per-`(addonId, version)` approval
  records).
- Users can distinguish installed, verified, and approved software
  (§4 Trust Model mapping table; four-state VALID/VERIFIED/APPROVED/
  GRANTED core rule).
- Add-ons remain modular and replaceable (replaceable system slots
  per ADR-026; `communication-channel`, `primary-agent`, etc.).
- Privileged authority remains with the host, not with signatures or
  manifests (§7 Runtime Boundary; §8 Phase 3.5 hardening).
- The existing Add-on SDK can evolve toward a public package without
  rewriting the kernel architecture (§3 Lineage).

ADR-038 does **not** require, and explicitly defers:

- a commercial marketplace (per `PROPOSAL-resonant-extension-framework.md`
  Non-Goals for V0.1; ADR-024 deferred);
- add-on payments, ratings/reviews, revenue sharing;
- cross-device license management;
- arbitrary native binaries (V0.1 is declarative-only per §9);
- remote code execution;
- automatic approval of sensitive permission changes.

The framework package's `Distribution Policy` section restates the
catalog constraints: only certified, signed, compatible-with-running-
ResonantOS, non-revoked, approved-for-official-distribution releases
appear in the official catalog. Developer mode may expose additional
sideloaded or experimental releases; it does not disable capability
enforcement.

Source: `PROPOSAL-resonant-extension-framework.md` Consequences;
`PROPOSAL-resonant-extension-framework.md` Non-Goals for V0.1;
`PROPOSAL-resonant-extension-framework.md` Distribution Policy;
`RESONANT_ADDON_SDK_SPEC_V0.1.md` Public API Stability.

---

## Appendix A — Input Source Map

Every claim in this outline is traceable to one of these sources.

| Source | Path | Role in ADR |
|---|---|---|
| Original proposal | `docs/addons/resonant-extension-framework/PROPOSAL-resonant-extension-framework.md` | Decision, principle, framework components, trust tiers, runtime boundary, replaceability |
| Add-on SDK spec | `docs/addons/resonant-extension-framework/RESONANT_ADDON_SDK_SPEC_V0.1.md` | §6 manifest, §11 SDK modules, lifecycle, tools, connectors, agents |
| Package & manifest spec | `docs/addons/resonant-extension-framework/ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md` | §6 `.rpkg`, manifest fields, publisher block, digests, signature envelope |
| Certification & signing | `docs/addons/resonant-extension-framework/ADDON_CERTIFICATION_AND_SIGNING_V0.1.md` | §10 pipeline, gates, review triggers, signing model, revocation |
| Developer workflow | `docs/addons/resonant-extension-framework/ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md` | §11 CLI commands, mock host, reference add-ons, error codes |
| Implementation roadmap | `docs/addons/resonant-extension-framework/IMPLEMENTATION_ROADMAP_V0.1.md` | §8 Phase 3.5, §9 M0 test ordering, §13 suggested repo additions |
| Open design conflicts | `docs/addons/resonant-extension-framework/OPEN_DESIGN_CONFLICTS_V0.1.md` | §3 lineage grounding, §4-§7 conflict-driven decisions, §12 deferred |
| Resolutions | `docs/addons/resonant-extension-framework/RESOLUTIONS_V0.1.md` | §4 C1, §5 C5, §7 C3, §8 C2, §9 C4, §10 sequencing, §12 deferred C6-C12 |
| External review | `docs/addons/resonant-extension-framework/EXTERNAL_REVIEW_FEEDBACK_V0.1.md` | §13 fork strategy, alignment map |
| SDK code-review feedback | `docs/addons/resonant-extension-framework/ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` | §12 communication-channel refinement; §12 external SDK boundary; §13 M0-first priority |
| Personal/local governance | `docs/addons/resonant-extension-framework/ADDON_PERSONAL_PLUGIN_GOVERNANCE.md` | §12 `personal-local` tier proposal (deferred) |
| SDK Reviewer Agent | `docs/addons/resonant-extension-framework/SDK_REVIEWER_AGENT_V0.1.md` | §10 dogfooded reviewer add-on |
| Runtime hardening notes | `docs/security-pipeline/REF_HARDENING_NOTES_V0.1.md` | §8 H1–H4 hardening is part of the runtime contract |
| Upstream ADRs | `docs/architecture/ADR-006-*.md`, `ADR-018-*.md`, `ADR-023-*.md`, `ADR-024-*.md`, `ADR-026-*.md`, `ADR-034-*.md` | §3 lineage; §10 references |
| Hardening implementation | branch `spike/caller-attributed-tokens`, commits `60c0129` `9e28f3f` `6617a63` `0d5f7ae` `779f16d` `92659c1` `a6ee86c` | §8 evidence; reviewable as a single squashed or cherry-picked commit when this fork merges back |
| Framework package intake | commits `410e508` `9d244e4` `2b6d6d6` on `feat/tab-referencing` | Records the framework package's source; reviewed in §3 |

---

## Appendix B — Reviewer Checklist

For each section above, a reviewer can shape the prose by asking:

1. Does this section *commit* to something, or only *record* something
   that was decided elsewhere? If the latter, the section is one
   paragraph summarising the source's decision with a pointer.
2. Is there a source in Appendix A this section doesn't yet cite?
3. Does the section introduce any *new* commitment not in any source?
   If yes, that's a design change and should be flagged before
   acceptance.
4. Does the section preserve the four-question separation from §2?
   (Manifest declares / what it requests / what host grants / what
   Resonant certifies.)
