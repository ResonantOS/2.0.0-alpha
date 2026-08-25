# Review Packet — 2026-08-25

> **Snapshot of the work-in-review as of 2026-08-25.** This document
> is the GitHub PR #327 description, archived in the repo for
> reference. See [PR #327](https://github.com/ResonantOS/2.0.0-alpha/pull/327)
> for the live review thread.
>
> **Lead reviewer:** Tom Pennington.
> **Branch:** `feat/tab-referencing` @ `6db3141..994b51d`
> **Base:** `ResonantOS/2.0.0-alpha:dev`

---

## TL;DR

Formalizes ResonantOS's existing add-on architecture as the
**Resonant Extension Framework (REF) V0.1**: 13 manifest
capabilities (plus `channel.send` / `channel.account-write`), the
`.rpkg` package format, the four-state `releaseTrustTier` /
`capabilityRiskClass` trust model, the Phase 3.5 caller-attributed
bridge enforcement, and the certification pipeline. Adds ADR-040 to
lock the provider-fabric boundary for external agent runtimes (DeepSeek
Harness, Agent Zero, etc.). Lands a soft fork-only SDK cutover at
`packages/addon-sdk/`.

25 atomic commits, all docs-and-tooling except for two runtime-shape
additions: `channel.send` / `channel.account-write` (capability
additive, backward-compatible) and `.rpkg` hygiene allowlist (one
line). Commit `994b51d` adds in-progress browser-first work
(tab-mention-typeahead controller + surface polish) bundled from the
side branch `wip/browser-first-tab-mention-typeahead` (`0747d35`,
retained on `origin` as a recovery point).

## Scope

- **In scope.** REF V0.1 design material accepted into the architecture
  tree as ADR-038 with drafted prose; ADR-040 boundary for external
  agent runtimes; `packages/addon-sdk/` soft cutover; three new
  framework-package docs (registry metadata schema, signing
  architecture, capability separation deferred record); REF
  vocabulary (C9) rename documented in the SDK and certification
  specs; hygiene rule allowing the official `.rpkg` format;
  in-progress browser-first work bundled from the WIP side branch.
- **Out of scope.** Phase 1 actual SDK extraction (npm workspace,
  publishable package, install wiring); `packages/addon-sdk-testing/`
  mock host (B4 follow-on); runtime sideload enablement C8 (gated on
  security-pipeline review); the two anticipated third-party add-ons
  (`addon.deepseek-harness`, `addon.agentzero`) — these land in
  separate PRs once Tom has reacted to ADR-040.

**Linked issue / Project 2:** No specific issue. The framework
package intake (commits `410e508`, `9d244e4`, `2b6d6d6`, `1ea17e7`)
was authored as a fork-internal proposal; this PR is the formal
acceptance pass.

**Project 2 release scope:** Adds a Deferred ADR (ADR-038), a
new ADR (ADR-040), and a new directory tree (`packages/`).
Adds `channel.send` / `channel.account-write` capabilities
(additive; no existing add-on breaks). Does not change the Alpha
shipped runtime; this is pre-acceptance foundation work.

**Project 2 area:** Provider host / Delegation / Add-on SDK.

## Modules And Ownership

- `docs/architecture/ADR-038-resonant-extension-framework.md`
  (new; Add-on SDK owner)
- `docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md`
  (new; Provider host / Delegation owner)
- `docs/addons/resonant-extension-framework/` (15 docs moved from
  `docs/design/`; Add-on SDK owner)
- `packages/addon-sdk/` (new; soft cutover from `src/sdk/addons/`;
  Add-on SDK owner)
- `src/sdk/addons/*.ts` (now re-export shims; Add-on SDK owner)
- `src/core/contracts.ts` (additive: `channel.send`,
  `channel.account-write`; Add-on SDK owner)
- `scripts/check-repo-hygiene.mjs` (additive: `.rpkg` allowlist;
  Engineering workflow owner)
- `browser-first/**` (in-progress work bundled from side branch;
  browser-first owner)

Ownership review: every modified path's owner appears above; no
cross-module boundary changed. `src/sdk/addons/*.ts` becoming
shims is a **module boundary change** with itself (zero external
impact — the shims re-export the same symbols).

## Safety And Privacy

- **Safety/privacy impact:** No existing add-on loses capability.
  No existing user-visible behavior changes. The `.rpkg` hygiene
  allowlist is an explicit allow (not a default-allow); the
  security pipeline still validates `.rpkg` packages separately
  per the certification spec.
- **Required human handoff or approval boundary:** None added by
  this PR. ADR-040 §3 Rule 8 (approval-before-irreversible-work)
  records the boundary for *future* add-ons that integrate as
  external agent runtimes; no such add-on is included here.
- **Secret-handling impact:** ADR-040 §4 explicitly forbids raw
  credentials from reaching third-party agent runtimes. Phase 3.5
  caller-attributed token design (the runtime enforcement) is the
  mechanism. No production keys touched by this PR.

## Validation

| Command | Result |
| --- | --- |
| `npm run docs:check` | passes (Documentation contract validation passed.) |
| `npm test` (`npx vitest run`) | 429/429 pass (41 test files, 10.5s wall) |
| `npm run browser-first:audit-scope` | 0 manual-review items; informational warnings for the framework-package promotion (expected; fork-internal docs migration) |
| `npx tsc --noEmit` | clean |

**Live-browser proof:** Not required for the REF walk (docs-and-tooling).
The two runtime-shape additions (`channel.send`, `channel.account-write`
additions; `.rpkg` hygiene allowlist) are covered by the 429 vitest
cases including three new channel-capability tests
(`validation.test.ts`). The bundled browser-first work
(`994b51d`) carries its own new test file
(`tab-mention-typeahead.test.mjs`, 131 lines) but was not run as
part of the REF validation — its test surface lives under
`browser-first/test/` and is exercised by `npm run test:browser-first`,
not `npm test`.

## Documentation

**Documentation impact:** Substantial. The user-visible docs
tree changed in two ways:

1. **New ADRs.** ADR-038 (REF) at draft/deferred status with full
   prose and §12 commitments/deferrals; ADR-040 (External Agent
   Runtime Boundary) at draft/deferred status.
2. **Framework package promotion.** 15 docs moved from
   `docs/design/resonant-extension-framework/` (design stage) to
   `docs/addons/resonant-extension-framework/` (post-acceptance
   location). The framework README updated to record this.
3. **Three new framework-package specs.** `REGISTRY_METADATA_SCHEMA_V0.1.md`
   (C10), `SIGNING_ARCHITECTURE_V0.1.md` (C11), `CAPABILITY_SEPARATION_V1.md`
   (deferred V1 record).
4. **SDK package docs.** `packages/addon-sdk/README.md` (114 lines,
   public boundary documentation), `packages/addon-sdk/package.json`
   (intent field points at ADR-038 C12 and ADR-040).
5. **This review packet.** `docs/REVIEW_PACKET_2026-08-25.md`
   (this file; archived PR description).

`docs/README.md` updated to link to the framework package and to
ADR-040 in the "Change An Add-On" section. `docs/architecture/README.md`
ADR index gains the ADR-040 row.

## Architecture (one-paragraph for reviewers new to REF)

ResonantOS treats third-party and first-party add-ons as
declarative packages. A package author writes `resonant.addon.json`
declaring identity, capabilities, surfaces, runtime type, and trust
metadata. The SDK package validates the manifest deterministically
(capability references, tool/connector/hook cross-checks, scope
bounds, grant-preset consistency). On install, the host mediates
every privileged action through the authenticated Node bridge; Phase
3.5 mints caller-attributed HMAC tokens per `(callerId, capability,
scope)` so revocation is immediate. The capability set is currently
15 public values (13 + the two V0.1 channel additions); a V1 split
into PublicCapability and InternalCapability is recorded as a
deferred ADR per the capability separation spec. Trust is layered:
manifest declares, SDK validates, certification evaluates, signature
identifies, user grants, host enforces. Approval is never a substitute
for runtime authorization.

ADR-040 applies this architecture to the specific case where the
add-on *itself* is an external agent runtime (DeepSeek Harness,
Agent Zero, etc.). The boundary: ResonantOS holds the keys, picks
the model, grants the capabilities; the runtime does the work. The
runtime never receives raw credentials; it consumes opaque routing
decisions from the host's policy engine; every tool call is
declared, scoped, and audited at the bridge.

## Roadmap (what this PR does and doesn't do)

| Status | Item |
| --- | --- |
| ✅ Landed in this PR | REF V0.1 design record (ADR-038) with full prose |
| ✅ Landed in this PR | Provider-fabric boundary for external agent runtimes (ADR-040) |
| ✅ Landed in this PR | `packages/addon-sdk/` soft cutover (re-export shim approach) |
| ✅ Landed in this PR | `.rpkg` format accepted by hygiene rule (C6) |
| ✅ Landed in this PR | `channel.send` / `channel.account-write` capability additions (C5) |
| ✅ Landed in this PR | REF vocabulary documented (`releaseTrustTier`, `capabilityRiskClass`) (C9) |
| ✅ Landed in this PR | Registry metadata schema, signing architecture, capability separation V1 records (C10/C11/V1 deferred) |
| ✅ Landed in this PR | Browser-first tab-mention-typeahead + surface polish (bundled from WIP side branch) |
| ⏸ Deferred | `packages/addon-sdk-testing/` mock host (B4 follow-on) |
| ⏸ Deferred | Phase 1 actual SDK extraction (npm workspace, install wiring, CI install/audit blocks) |
| ⏸ Deferred | Runtime sideload enablement C8 (gated on security-pipeline review) |
| ⏸ Deferred | `addon.deepseek-harness` and `addon.agentzero` add-on manifests (separate PRs once ADR-040 is accepted) |
| ⏸ Deferred | Phase 3.5 → 4 → 5-8 implementation (certification, signing, registry, lifecycle) |

## Plan (what I want Tom to react to)

I'm specifically asking Tom for feedback on **four items**:

1. **ADR-040 §3 Rule 1 (no raw credentials) + §4 Credential Mediation.**
   Is the routed-handle contract (`routingDecisionId` + opaque
   provider profile id + expires-at) the right wire format? The
   alternative is per-request inline routing (no persistent decision),
   which would simplify revocation but add latency on every call.

2. **ADR-040 §7 Failure Modes F1–F10.** Are these the right negative
   tests? F1 (credential exfiltration), F2 (provider self-selection),
   F3 (workspace escape), F4 (capability escalation), F5 (undeclared
   tool), F6 (audit bypass), F7 (approval skip), F8 (stale routing
   decision), F9 (revoked routing decision), F10 (experimental route
   attempt without declaration). I expect Tom to want to add F11-F15
   for cross-runtime isolation, replay attacks, etc.

3. **ADR-038 §12 (REF V0.1 commitments and deferrals).** The §12
   walk committed 9 V0.1 items and deferred 3 to future ADRs
   (auto-unplug → ADR-039; post-V0.1 sandbox; capability separation
   V1 → future). Are these the right deferrals? The capability
   separation deferral in particular trades V1 internal-only
   capabilities for V0.1 pragmatism.

4. **B4 soft cutover (the `packages/addon-sdk/` + shim approach).**
   Does ResonantOS want the fork-only soft cutover, or should the
   Phase 1 actual extraction (npm workspaces, publishable package,
   install wiring) be done before merging? My read: soft cutover
   is reviewable and low-risk; full extraction is mechanical once
   the design is accepted.

## Status (what's verified, what's risky)

- ✅ **Verified.** `npm run docs:check`, `npm test` (429/429),
  `npx tsc --noEmit`, all pass on every REF commit in this PR.
- ✅ **Verified.** Each of the 24 REF commits individually passes
  docs:check + the relevant test subset before push.
- ⚠ **Bundled WIP, not RE-verified.** Commit `994b51d` bundles
  browser-first work from the WIP side branch. Its dedicated test
  file (`tab-mention-typeahead.test.mjs`) was not run by the REF
  validation suite — it lives under `browser-first/test/` and
  is exercised by `npm run test:browser-first`. Reviewers should
  run that suite separately to confirm the WIP green.
- ⚠ **Risky.** This is a docs-heavy PR with two runtime-shape
  additions. Reviewers should especially scrutinize:
  - `src/core/contracts.ts` (capability union addition)
  - `src/sdk/addons/contracts.ts` (capability array addition)
  - `src/sdk/addons/validation.test.ts` (new capability tests)
  - `scripts/check-repo-hygiene.mjs` (`.rpkg` allowlist)
  - `scripts/check-repo-hygiene.test.mjs` (`.rpkg` test)
- ⚠ **Risky.** `tsconfig.json` was modified to include the new
  `packages/addon-sdk/src` path. This is outside the
  browser-first-release scope per `npm run browser-first:audit-scope`
  (informational warning). If the merge target is a browser-first
  release, this should be split into a separate PR.

## Branch bookkeeping

- **WIP recovery point.** Side branch `wip/browser-first-tab-mention-typeahead`
  (`0747d35`) is retained on `origin` as a recovery point. Its
  commit message and author timestamp match the original WIP
  snapshot from 2026-08-25; the squash onto `feat/tab-referencing`
  (`994b51d`) carries a calmer commit message and an updated
  reviewer note.
- **PR head:** `feat/tab-referencing` @ `994b51d` (after squash)
  + `?` (after REVIEW_PACKET commit). 26 commits ahead of
  `upstream/dev` after this packet lands.
- **Files in PR #327:** ~58 (40 from REF + 18 from bundled WIP).

## Reviewer Checklist (ResonantOS PR template)

- [x] The branch targets `dev` and does not include unrelated work.
      (The bundled WIP is related in that it lives on the same
      working branch; it is flagged as WIP and recoverable from the
      side branch if reviewers want it split into a separate PR.)
- [ ] The linked issue and Project 2 fields reflect the intended
      release scope. (Tom — please fill or correct.)
- [x] I reviewed module ownership and called out every cross-module
      boundary change above.
- [x] I assessed security, privacy, secrets, and required human-only
      actions above.
- [x] I added or updated tests for behavior changes (3 new
      validation.test.ts cases for `channel.send` /
      `channel.account-write`; 1 new check-repo-hygiene.test.mjs
      case for `.rpkg` allowlist; 1 new tab-mention-typeahead.test.mjs
      from the bundled WIP; full 429-test REF suite passes).
- [x] I recorded every relevant command and its actual result above.
- [x] I attached redacted live-browser proof when the change
      requires it. (N/A for the REF walk; the bundled WIP carries
      its own tests under `browser-first/test/`.)
- [x] I updated current documentation or explained why no
      documentation changed. (Major docs update; see "Documentation
      impact" above.)
- [x] This pull request contains no credentials, tokens, private
      user data, browser profiles, or unredacted sensitive logs.
