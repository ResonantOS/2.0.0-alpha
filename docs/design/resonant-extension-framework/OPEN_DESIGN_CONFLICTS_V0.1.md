# Resonant Extension Framework V0.1 — Open Design Conflicts for External Review

## Purpose of This Document

This document lists the unresolved design conflicts discovered when the
Resonant Extension Framework (REF) V0.1 proposal was reviewed against the
actual ResonantOS `2.0.0-alpha` codebase (state: 2026-08-24, version
2.0.0-beta.1).

It is written for external review (ChatGPT and the ResonantOS development
team). It is self-contained: all evidence needed to evaluate each conflict
is included inline. File paths and symbol names refer to the
`2.0.0-alpha` repository so the team can verify claims against the source.

### How to review

For each conflict (C1–C13):

1. State whether you agree with the framing. If not, reframe it.
2. Pick one of the options, or propose a better one, with reasoning.
3. Flag anything that makes the conflict more or less urgent than stated.

After the conflicts:

4. Identify conflicts this document misses.
5. Re-order the priority list if you disagree with it.

## Background in Sixty Seconds

REF is a proposal to evolve the existing internal **Add-on SDK V0** into a
governed add-on ecosystem: trust tiers (Developer / Verified / Resonant
Approved), a signed `.rpkg` package format, an automated certification
pipeline, a developer CLI, and a plugin registry.

Core principle:

```text
Manifest declares.
Certification evaluates.
Signature identifies.
User grants.
Host enforces.
```

Terminology note: the unit of the ecosystem is an **add-on** (matching
existing repo vocabulary: `AddOnManifest`, `src/sdk/addons/`, ADR-018).
Earlier drafts used the word "plugin"; the concepts are identical.
"Resonant Extension Framework" names the governance architecture, not a
second artifact type.

The full proposal lives beside this document:

- `PROPOSAL-resonant-extension-framework.md` (draft for ADR-038)
- `RESONANT_ADDON_SDK_SPEC_V0.1.md`
- `ADDON_PACKAGE_AND_MANIFEST_SPEC_V0.1.md`
- `ADDON_CERTIFICATION_AND_SIGNING_V0.1.md`
- `ADDON_DEVELOPER_WORKFLOW_AND_CLI_V0.1.md`
- `IMPLEMENTATION_ROADMAP_V0.1.md`

## Grounding: What the Repo Actually Has Today

### The Alpha runtime

Exactly two privileged components:

1. a Chrome Manifest V3 extension
   (`browser-first/resonantos-side-panel-extension/`);
2. an authenticated loopback Node bridge (`browser-first/host/`), HTTP port
   47773 / HTTPS 47774, bound to 127.0.0.1.

The only privileged path is: extension → bridge-token-authenticated request
→ per-route capability-token check in `bridge-server.mjs` → named host
service → provider endpoint / local filesystem / local service.

### The existing Add-on SDK V0 (ADR-018)

- Typed manifests (`AddOnManifest`, `src/core/contracts.ts`), validated by
  `validateAddOnManifest` (`src/sdk/addons/validation.ts`, ~1,180 lines).
- Manifests are **declarative only** — shell add-ons carry no executable
  code. UI surfaces are hand-written per-add-on React panels
  (`src/modules/addons/`). Effects happen through host-mediated services,
  declared tools, and scripts/hooks.
- Capability coherence is enforced: every capability referenced by any
  sub-contract must be declared in `requestedCapabilities`.
- Trust vocabulary already exists as types:

```text
AddOnProvenanceTier        = bundled-core | curated-signed |
                             enterprise-signed | sideloaded-unverified
ManifestVerificationState  = verified | unverified | not-applicable | failed
AddOnRegistryReviewState   = unreviewed | reviewed | approved |
                             blocked | deprecated
```

- The registry already implements "no trust by omission": a bundled
  manifest without provenance is downgraded to
  `sideloaded-unverified / unverified / unreviewed`
  (`src/sdk/addons/registry.ts`).
- Signing fields exist (`provenance.signed`, `signer`, `signatureRef`,
  `AddOnArtifactReference.sha256`) but are **self-asserted — nothing
  verifies them**.
- `sdkVersion` exists (`ADDON_SDK_VERSION = "0.1.0"`) but is **never
  validated**; `compatibility.shellVersion` is only checked as a non-empty
  string.

### Three capability vocabularies coexist

1. **Manifest capabilities** (13, coarse): `filesystem`, `archive-read`,
   `archive-intake-write`, `chat-interface`, `memory-provider`,
   `providers`, `shell`, `network`, `ui-embedding`, `browser-control`,
   `agent-delegation`, `notifications`, `device-integration`
   (`ADDON_CAPABILITIES`, `src/sdk/addons/contracts.ts`).
2. **Bridge route capabilities** (23, fine-grained):
   `BRIDGE_CAPABILITY_TOKEN_SPECS`
   (`browser-first/host/bridge-capability-tokens.mjs`) — e.g.
   `provider-model-invoke`, `agent-control-plan`, `archive-read`,
   `archive-write`, `memory-source-*`, `browser-download-action`,
   `addon-runtime-control`. A consistency test locks this list to the
   extension-side allowlist.
3. **Browser-first add-on capabilities** (informal): a second, untyped
   manifest format (`browser-first/addons/*/addon.json`) with its own
   `capabilities` field.

### The second add-on system

`browser-first/addons/resonant-context/addon.json` and
`resonator/addon.json` use an untyped schema (`mode`, `trust`, `entry`,
`contentScripts`, `commands`, `messageChannel`, `capabilities`,
`requires`, `boundary`) and **do carry executable JavaScript**, injected as
Chrome content scripts. Their dashboards render through
`lib/addon-iframe.js`: bridge-proxied HTML inlined into a sandboxed
`srcdoc` iframe.

### The enforcement gap (most important single fact)

- Bridge capability tokens are minted per extension session
  (`POST /api/capability-tokens`, gated by a bootstrap token) and are
  **not caller-attributed**: any holder of a scoped token is
  indistinguishable from the extension itself.
- `lib/addon-iframe.js` passes `bridgeUrl` and the `bridgeToken` into
  sandboxed iframes. Today's de-facto add-on channel therefore hands every
  add-on extension-grade authority.
- Per-add-on `requestedCapabilities / grantedCapabilities /
  deniedCapabilities` records exist
  (`browser-first/host/addon-delegation-service.mjs`) but are **descriptive
  only**. The code states this explicitly: "Capability enforcement happens
  at the bridge via per-route tokens; these chips describe the add-on
  contract."
- The sideload path exists in `src/core/runtime.ts` but
  `hasCommandHost()` is hardcoded `false` — sideloading is disabled in
  this build.

### Governance gates any change must pass

`npm run verify:alpha` sequences 16 checks including: repo hygiene (no
`*.zip`, no symlinks, no >10 MiB files, multi-encoding secret scans), docs
validation (link reachability, ADR index parity, command truthfulness),
build, vitest + `node --test` suites, security-pipeline certification, and
a release scope audit that fails strict mode on any unregistered path.

---

## C1 — Trust tiers: three new tiers vs. the existing enum stack

**Conflict.** The proposal defines three tiers (Developer / Verified /
Resonant Approved). The repo already models four provenance tiers, four
verification states, and five review states (see Grounding). Inventing a
parallel vocabulary would fork the domain model; ignoring the proposal
loses the ecosystem semantics.

**Plausible mapping:**

| REF tier | Existing enums |
|---|---|
| Developer | `sideloaded-unverified` + `unverified` + `unreviewed` |
| Verified | `curated-signed` + `verified` + `reviewed` |
| Resonant Approved | `curated-signed` + `verified` + `approved` (bound to package digest) |

**Open:** what happens to `bundled-core` (first-party, trusted by
bundling, not signature) and `enterprise-signed` (no enterprise flow
exists yet)? Does "Verified" require a new provenance tier value, or is it
`curated-signed` with a verification state?

**Options:**

- **(a) Map only.** Keep existing enums; ADR-038 documents the mapping.
  Cheapest; no migration; but "Verified vs Approved" distinction lives
  only in review state, which is registry-derived today, not stored per
  release.
- **(b) Extend.** Add explicit tier values and a per-(addonId, version)
  approval record. More invasive; matches the proposal's
  version-specific approval requirement.
- **(c) Replace.** New REF trust model supersedes the old enums with a
  migration. Cleanest end state; highest churn across validation,
  registry, and UI.

**Question for reviewer:** which option, and what is the fate of
`bundled-core` / `enterprise-signed`?

## C2 — Capability tokens are not caller-attributed (highest priority)

**Conflict.** REF's promise — "User grants. Host enforces." — cannot be
implemented on the current bridge. Enforcement is a static route→token
map; any token holder has the extension's authority; the add-on iframe
channel is handed the bridge URL and bridge token directly.

**Consequence:** every runtime phase of the roadmap (install, lifecycle,
certification runtime tests) inherits this hole. Per-add-on grants are UI
decoration until tokens carry caller identity.

**Options:**

- **(a) Per-caller grant store at the dispatcher.** Extend
  `isAuthorizedCapabilityRequest` (`bridge-server.mjs`) from a static map
  lookup to a grant store keyed `(callerId, capability, scope)`. Mint
  per-add-on tokens at grant time; stop passing the bootstrap-derived
  credential set into iframes. Reuse the existing
  requested/granted/denied record shape as the schema.
- **(b) Full mediation.** Add-on iframes get no bridge credentials at
  all; they call a `postMessage` API surfaced by the shell, which
  authorizes and forwards. Strongest isolation; requires building the
  message API surface.
- **(c) Hybrid.** (a) now for local-service add-ons; (b) as the target
  for any UI-embedded third-party code.

**Question for reviewer:** which mediation shape, and should this become
an explicit roadmap phase (proposed: "Phase 3.5 — caller-attributed
capability tokens") gating all later runtime phases?

## C3 — Two manifest systems, one proposal

**Conflict.** The proposal assumes a single manifest contract. The repo
has two: the typed, declarative shell SDK v0, and the informal,
code-carrying browser-first `addon.json` (see Grounding).

**Options:**

- **(a) Subsume.** Type the browser-first fields into the SDK manifest
  (content scripts, message channel, boundary) and migrate
  `resonant-context` / `resonator`. One contract; real migration cost.
- **(b) Bridge.** Keep both; write an adapter that projects browser-first
  manifests into SDK records. Two contracts forever; adapter drift risk.
- **(c) Scope-exclude.** Declare browser-first add-ons "extension-internal
  modules," out of REF scope. Honest but leaves executable code outside
  the governance model REF claims to own.

**Question for reviewer:** which — and if (c), how is the boundary
worded so third-party code cannot route around REF through the
browser-first path?

## C4 — No executable surface exists for third-party add-on code

**Conflict.** Shell add-ons today are declarative JSON plus hand-written
React panels. M0 Test A in the roadmap ("Hello Resonant" with a UI
surface) implicitly requires a sandboxed execution/rendering surface for
third-party code that does not exist in the shell. This is the largest
hidden work item in the proposal; no roadmap phase builds it.

**Options:**

- **(a) V0.1 is declarative-only.** Add-ons = manifest + host-mediated
  tools + local services; no shipped code runs in the shell. Defers the
  problem; severely limits what ecosystem add-ons can be.
- **(b) Extend the browser-first iframe model** to shell surfaces — but
  only after C2 is fixed, since that model currently leaks bridge
  credentials.
- **(c) Build a dedicated sandboxed module runner** (isolated JS realm,
  SDK API only). Most work; cleanest end state.

**Question for reviewer:** is code-carrying add-ons in V0.1 scope at all?
If not, say so explicitly in the spec and adjust M0 Test A.

## C5 — Three capability vocabularies with no mapping layer

**Conflict.** The proposal wants fine-grained capabilities
(`network.http`, `filesystem.read`, …). The repo has 13 coarse manifest
capabilities, 23 bridge route capabilities, and the informal browser-first
set — with no declared mapping between a manifest request and the bridge
tokens an operation actually requires. That mapping **is** the
developer-facing contract; it is currently unwritten.

**Options:**

- **(a) Mapping table owned by the SDK package**, consumed by validation
  (warn when a requested capability maps to nothing) and by the bridge
  (authorize at route granularity). Single source of truth.
- **(b) Collapse to one vocabulary.** Migrate manifest capabilities to
  the bridge's finer set with a deprecation window. More honest; touches
  every bundled manifest.
- **(c) Two-layer model, documented:** coarse "product capabilities" for
  users, fine "route capabilities" for enforcement, mapping shipped as
  data.

**Question for reviewer:** who owns the mapping, and what migration order
avoids breaking the 16 bundled manifests in `public/addons/`?

## C6 — `.rpkg` container format vs. repository hygiene rules

**Conflict.** The proposal suggests a deterministic ZIP container. The
repo forbids `*.zip` files anywhere (`scripts/check-repo-hygiene.mjs`),
and the supply-chain conventions treat archives as hostile until scanned.
Test fixtures of a zip-based `.rpkg` would collide with that posture.

**Options:**

- **(a) ZIP with explicit allowlist.** Keep the proposal; add a hygiene
  allowlist entry for `*.rpkg` fixtures under test paths. Least spec
  churn; weakens a blanket rule.
- **(b) Deterministic tar (`.tar.zst`)**. No zip ban collision; equally
  reproducible; slightly less familiar tooling.
- **(c) Custom manifest-first bundle** (canonical JSON + content-addressed
  blob tree). Best determinism story; most tooling to build.

**Question for reviewer:** which container, given that deterministic
digest reproducibility is a certification requirement?

## C7 — `sdkVersion` and `compatibility` are never evaluated

**Conflict.** The proposal makes compatibility ranges load-bearing
(`compatibility.resonantOS`, `compatibility.sdk`). Today `sdkVersion` is
unchecked and `compatibility.shellVersion` is a non-empty-string check.
Nobody evaluates a semver range anywhere in the host.

**Options:**

- **(a) Enforce at validation time only** (`validateAddOnManifest`
  rejects out-of-range manifests). Simple; but a host upgrade can strand
  already-installed add-ons with no signal.
- **(b) Enforce at install + evaluate at launch.** Install-time rejection
  plus launch-time degrade/quarantine when the host no longer matches.
  Safer; needs a runtime state (`degraded`) the lifecycle model already
  names.

**Question for reviewer:** install-time only, or install + launch? And is
range evaluation an SDK-package export or host-internal?

## C8 — Sideload is disabled in the current build

**Conflict.** REF Tier 1 (Developer) requires sideloading. The runtime
sideload path exists but is disabled (`hasCommandHost()` hardcoded
`false`). Enabling it is a security-relevant runtime change, not a docs
change: ADR-018 already requires sideloaded add-ons to be treated as
unverified, and validation runs before trust — but the disabled path has
never been exercised as an attack surface.

**Options:**

- **(a) Enable + harden in Alpha scope.** Required for any developer
  ecosystem; adds a reviewable privileged path.
- **(b) Defer sideload; developer mode = bundled dev catalog**
  (`dev-index.json` exists). Zero new attack surface; no real third-party
  story.

**Question for reviewer:** is enabling sideload in scope for the Alpha
timeline, and what hardening does the security pipeline require first?

## C9 — Naming collisions: "trust tier" and "risk class"

**Conflict.** Manifests already have `agents[].trustTier` — a trust label
for *agent personas*, unrelated to add-on release trust. The proposal uses
"trust tier" for releases and "risk class" for capabilities. Three similar
terms for three different axes invites confusion in validation messages,
UI, and docs.

**Options:**

- **(a) Rename in REF:** `releaseTrustTier` (Developer/Verified/Approved)
  and `capabilityRiskClass` (low/moderate/high/critical); leave
  `agents[].trustTier` alone. Document all three in the spec glossary.
- **(b) Rename the agent field** to `agentPersonaTrust` at next SDK
  major. Cleaner long-term; migration cost now.

**Question for reviewer:** is (a) sufficient, or is the agent field worth
migrating?

## C10 — Registry plans vs. existing deferrals (ADR-023 / ADR-024)

**Conflict.** ADR-023 (add-on repository/registry) and ADR-024 (store)
are explicitly deferred. REF Phase 8 proposes a registry metadata format,
approved-release index, revocation feed, and update lookup. The
relationship between REF and those deferrals is unstated.

**Options:**

- **(a) Inherit the deferral.** REF specifies the metadata *format* and
  review-record schema now; the live registry *service* remains deferred
  per ADR-023/024. Approved-release index lives as a signed JSON document
  in a git repository until a service exists.
- **(b) Supersede.** ADR-038 declares the registry in-scope and
  un-defers ADR-023. Larger commitment; needs staffing reality check.

**Question for reviewer:** (a) or (b)? If (a), what is the minimal signed
index format that a future service can adopt without breaking clients?

## C11 — Signing key architecture and first-party signing

**Conflict.** The proposal specifies ed25519 publisher + approval
signatures, an offline root, rotating release keys, and revocation. Open
implementation questions the spec defers:

- ed25519 exists in the repo only via openssl shell-out for bridge TLS
  (`bridge-tls.mjs`). The security pipeline's runtime-hardening family
  gates new subprocess-spawning code; Node's native `crypto.sign`/
  `crypto.verify` (ed25519) avoids that entirely for the verifier path.
- Key custody for the Resonant release-signing key is undecided (offline
  vs. CI KMS/HSM). Repo hygiene scans make "keys in repo" a non-starter,
  which the spec already states.
- **First-party add-ons are currently trusted by bundling, not
  signature.** Does REF change that (sign the 16 bundled manifests too),
  or does `bundled-core` remain a separate trust root?

**Question for reviewer:** native-crypto verification (recommended), key
custody model, and whether first-party bundles get signatures in V0.1.

## C12 — SDK package location and its governance cost

**Conflict.** The roadmap proposes `packages/addon-sdk/`. The repo is a
single npm package with no workspaces; the one sub-package precedent
(`addons/resonant-browser-host/`) requires registration in ~5 places:
root `package.json` scripts, CI install/audit blocks, the release scope
audit classifier, docs links, and module ownership docs.

**Options:**

- **(a) `packages/addon-sdk/` from the start.** True external packaging
  (exports map, no deep imports) from day one; pays the registration cost
  once, up front.
- **(b) `src/sdk/addon-public/` first** (the roadmap's own fallback).
  Free vitest coverage and zero CI changes, but "importable as an
  external package" is only simulated until extraction.
- **(c) Stay in `src/sdk/addons/`** and treat the existing barrel
  (`index.ts`) as the public surface with an explicit export-boundary
  test. Cheapest; weakest external-consumption proof.

**Question for reviewer:** which option, and is "an external fixture
project compiles against only the SDK" (the roadmap's Phase 1 exit gate)
worth the `packages/` cost in V0.1?

## C13 — Roadmap sequencing: the missing phases and M0 order

**Conflict.** The proposed Phase 0–8 sequence has three holes visible
from the repo side:

1. No phase delivers caller-attributed capability tokens (C2), yet every
   runtime phase after packaging depends on enforcement being real.
2. No phase reconciles the two manifest formats (C3); Phase 0
   ("inventory") would discover the split but has no decision gate for
   it.
3. Phase 4's exit gate ("Hello Resonant completes the full lifecycle"
   with a UI surface) assumes an executable surface (C4) that no phase
   builds.

Also: M0 Test B (Local Files: grants, scope restriction, audit) exercises
the capability model without needing a UI surface; Test A needs C4.
Running B first de-risks the sequence.

**Proposed revision:**

```text
Phase 0   inventory (+ explicit decision: C3 manifest reconciliation)
Phase 1   extract public SDK contracts
Phase 2   package format
Phase 3   developer CLI
Phase 3.5 caller-attributed capability tokens + iframe credential
          containment (C2) — NEW, gates everything below
Phase 4   host install + lifecycle (surface scope depends on C4 decision)
Phase 5–8 certification, signing, review, registry (unchanged)
M0 order: Test B (Local Files) → Test C (Local AI) → Test A (UI surface)
```

**Question for reviewer:** agree with the revised order? Is 3.5 correctly
placed, or should it precede Phase 2?

---

## Priority Summary (proposed)

| Priority | Conflict | Why |
|---|---|---|
| 1 | C2 caller attribution | REF's core promise is unimplementable without it |
| 2 | C4 executable surface | Determines what V0.1 add-ons can even be |
| 3 | C1 trust tiers | Vocabulary decision that touches every later artifact |
| 4 | C3 manifest reconciliation | One-contract claim is currently false |
| 5 | C5 capability mapping | The actual developer-facing contract |
| 6 | C13 sequencing | Cheap to fix now, expensive to fix later |
| 7 | C7 compatibility evaluation | Small, early, load-bearing |
| 8 | C8 sideload enablement | Security review needed before Tier 1 exists |
| 9 | C10 registry deferral | Scope honesty for ADR-038 |
| 10 | C11 signing architecture | Needed by Phase 6, not before |
| 11 | C6 container format | Needed by Phase 2, low risk either way |
| 12 | C12 package location | Reversible decision |
| 13 | C9 naming collisions | Cosmetic but cheap |

## Already Resolved (for reviewer context)

- **Terminology:** the unit is an **add-on**; "plugin" is retired.
  Proposed API names (`defineAddon`, `validateAddOnManifest`,
  `assertValidAddOnManifest`) intentionally match existing code.
- **ADR numbering:** the proposal targets **ADR-038** (ADR-031 is taken).
- **Staging:** this package lives at
  `docs/design/resonant-extension-framework/` and passes the repo's docs
  and release-scope gates as a design-stage proposal.

## Requested Output From the Reviewer

1. Per conflict C1–C13: agree/reframe, chosen option, reasoning.
2. Conflicts missing from this list.
3. A revised priority order, if different.
4. Any conflict where the honest answer is "do not build this in V0.1."

---

## Resolutions (2026-08-24, fork author)

Decisions on the six conflicts the roadmap depends on. Recorded for traceable carry into the ADR-038 draft.

### C1 — Trust tiers: option (a) Map only + a per-(addonId, version) approval record

**Decision:** (a) for vocabulary; layer per-version approval records on top so the "Verified vs Approved" distinction survives.

Keep the existing `AddOnProvenanceTier`, `ManifestVerificationState`, and `AddOnRegistryReviewState` enums. Map REF tiers onto them per the table in C1. Add a per-(addonId, version) approval record stored alongside the add-on in the registry: presence of a record with status `approved` and `packageDigest` equal to the package's digest is what distinguishes Resonant Approved from Verified. This honours the version-specific-approval invariant from the proposal without forking the domain model.

`bundled-core` stays as a separate trust root (signed by bundling, not signature) and is documented as such. `enterprise-signed` remains a future value; no work in V0.1.

### C2 — Capability tokens: option (a) Per-caller grant store at the dispatcher, as Phase 3.5

**Decision:** (a) for V0.1; record (b) as the target for any UI-embedded third-party code.

Extend `isAuthorizedCapabilityRequest` (`browser-first/host/bridge-server.mjs`) from a static route→token map to a grant store keyed `(callerId, capability, scope)`. Mint per-add-on tokens at grant time using the existing requested/granted/denied record shape. Stop passing the bootstrap-derived credential set into iframes; iframes receive only the per-caller, scope-bounded token.

Phase 3.5 is hard-pinned *before* Phase 4 (host install + lifecycle) and *before* any M0 reference test that exercises enforcement (Tests B and C). Phase 3.5 is the gate.

### C3 — Manifest systems: option (c) Scope-exclude browser-first from REF, with an explicit boundary

**Decision:** (c) for V0.1; document the boundary so it cannot be routed around.

`browser-first/addons/*` are declared *extension-internal modules* — first-party code shipped inside the Chrome extension — and are out of REF scope. The boundary is the privilege boundary, not the directory boundary: anything reachable from extension content scripts without going through the Phase 3.5 bridge-caller-token machinery is first-party and may be unreachable to third-party add-ons. This is the only option that does not require migrating the existing `resonant-context` and `resonator` add-ons in V0.1.

The boundary clause to put in ADR-038: *third-party add-on code cannot invoke any bridge route that is not gated by a caller-attributed token minted under Phase 3.5; the browser-first executable content scripts remain first-party because they are not in the add-on loader path.*

### C4 — Executable surface: option (a) V0.1 is declarative-only

**Decision:** (a). M0 Test A is deferred past V0.1.

V0.1 add-ons are manifest + host-mediated tools + local services; no shipped third-party code runs in the shell. M0 Test A (Hello Resonant with a UI surface) is removed from the M0 milestone and renamed to "post-V0.1 sandbox surface" in the roadmap. Options (b) and (c) — extending the iframe model or building a sandboxed module runner — both depend on a Phase 3.5 that doesn't exist yet. Building C4 before C2 would require rolling back the iframe-credential containment from C2.

The V0.1 cut is honest: it delivers the external ecosystem's *enforcement* half (trust tiers, capability model, lifecycle, certification, signing, registry) without its *code-running* half.

### C5 — Capability mapping: option (a) Single mapping table owned by the SDK package

**Decision:** (a). The mapping table is an SDK export, consumed by both validation and the bridge.

Ship the manifest-capability → bridge-route-capability mapping as a versioned data file inside the public SDK package. Validation warns when a requested manifest capability maps to nothing. The bridge authorises at route granularity using the same data. This makes the mapping the developer-facing contract instead of an unwritten assumption.

Migration order to avoid breaking the 16 bundled manifests in `public/addons/`: introduce the mapping in Phase 1 alongside the SDK extraction; back-fill existing manifests in Phase 0's inventory deliverable; deprecation window starts after M0.

### C13 — Sequencing: revised order adopted

**Decision:** Insert Phase 3.5 *between* Phase 3 and Phase 4 (not before Phase 2; the SDK extraction and packaging work does not depend on it). Re-order M0 tests: **Test B (Local Files) → Test C (Local AI) → Test A (UI surface, deferred past V0.1)**.

Phase 3.5 gates Tests B and C; Test A drops out of V0.1 entirely (see C4). Keeping Phase 3.5 after Phase 2 lets `.rpkg` packaging and the developer CLI land in parallel with the security work.

### Deferred (no decision needed today)

- **C6** container format: chosen git-tarball-with-deterministic-permissions unless the security pipeline vetoes; defer until Phase 2 starts.
- **C7** compatibility evaluation: install + launch (option b); small, fold into Phase 1.
- **C8** sideload enablement: option (a), enabled + hardened; security-pipeline review is its own gate before any Tier 1 exists.
- **C9** naming: option (a) — rename in REF only (`releaseTrustTier`, `capabilityRiskClass`); leave `agents[].trustTier` alone.
- **C10** registry deferral: option (a) — inherit the deferral; metadata format and signed approved-release index now, live service later per ADR-023/024.
- **C11** signing architecture: native `crypto.sign` / `crypto.verify` ed25519 (no subprocess); first-party bundles remain trust-by-bundling in V0.1; key custody decision deferred to security pipeline.
- **C12** package location: `packages/addon-sdk/` from the start (option a); pay the registration cost once.

These are recorded so the ADR-038 draft carries them as "acknowledged, deferred to Phase N" rather than rediscovery work.
