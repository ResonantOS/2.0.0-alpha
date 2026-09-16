# ADR-038: Guardian/Engineer Boundary And Core-Only Invariants

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Core and add-ons
- Decision date: 2026-09-15
- Alpha note: Authority boundaries and invariants govern Alpha changes. The
  Guardian, confined DSH runtime, request/grant type separation, and invariant
  review mechanism are not implemented by this decision.

## Context

[ADR-026](ADR-026-minimal-kernel-replaceable-default-addons.md) is the ancestor:
replaceable chat and memory must not own the system's recovery floor. This ADR
refines its minimal kernel and replaces the requirement for a mandatory
Engineer AI recovery floor with a deterministic Guardian. The Engineer remains
an optional adviser, not a recovery dependency or authority.

[ADR-010](ADR-010-recovery-ladder.md) remains deferred; restoring a stronger
model can assist diagnosis but cannot be a prerequisite for recovery.
[ADR-034](ADR-034-engineer-runner-guardrails.md) governs development-only
repository tooling, not a runtime component, and is not the Guardian's ancestor.
The [Alpha runtime boundary](ALPHA_RUNTIME_BOUNDARY.md) remains the Chrome
extension plus authenticated Node bridge; this decision adds no Alpha process
or native-host requirement.

## Decision

### Guardian And Engineer

The Guardian is a small, separate, deterministic process with no model in it.
It holds a known-good baseline, including hashes of installed versions and
configuration, watches the bridge and the confined DSH runtime, and can restart
them or roll back to that baseline.

Its recovery authority is limited to restart and rollback. It cannot grant
capabilities, approve commits, change policy, or replace its own baseline.
Restoring an approved baseline is distinct from accepting a new one; rollback
must not undo a subsequent invariant tightening or restore revoked authority.
The Engineer AI may advise alongside it when a model is available, but is never
required for recovery and never holds recovery authority.

Rejected alternatives:

- A kernel module inside the bridge shares the failure domain of the component
  it must recover.
- An internal AI harness needs a working model exactly when models may be
  unavailable, and gives repair authority to reasoning that injected page
  content can steer.

### Privilege Follows Authority

First-party does not imply privileged. The privileged boundary contains only
what holds or exercises authority:

- the actuation executor that clicks and types, with the field classifier
  inside that enforcement boundary;
- the commit broker;
- credential custody: the DSH session cookie in the native host and connector
  OAuth credentials;
- the update channel.

The Guardian has only the separate recovery authority described above. Chat
panels, sessions and workspaces, the plugin suite, page observation, and
summaries are first-party public extensions and must request authority through
the privileged boundary. Bundling, authorship, or model output conveys none.
The DSH/native-host custody and commit-broker design does not claim those
components already ship in Alpha; current ownership remains in
[Module Ownership](MODULE-OWNERSHIP.md).

### Core-Only Invariant Class

Core-only is a capability class that a manifest cannot request at all:
**policy override, trust-root modification, credential export, baseline
replacement, and signing-root modification**. It is outside the requestable
capability vocabulary, including grant presets. No trust tier, setting, grant,
first-party identity, or Engineer recommendation can obtain it.

There is a real contract defect on `dev` at `6281d97b`:
[`CapabilityGrant`](../../src/core/contracts.ts) carries an author-writable
`granted: boolean`; both `AddOnManifest.requestedCapabilities` and
`AddOnGrantPreset.grants` reuse that type. An author can therefore express
`granted: true` in their own manifest or preset. Installation seeding in
[`createInstallationSnapshot`](../../src/core/policies.ts) forces grants to
`false`; refresh preserves existing installation decisions rather than the
manifest boolean. This is a **latent defect, not a live self-grant through
seeding**.

The structural fix is to separate an author's **request** type from a
host-issued **grant** type. Requests and presets must contain no authorization
boolean and must exclude Core-only operations. Host validation must reject
attempts to encode either; only the host may issue and enforce a grant after
authorization. A type rename or UI check alone is insufficient. This ADR records
the fix; it does not implement it.

### Invariants In Force

This class protects these policy invariants at every automation level:

- Payment and checkout automation require a separately reviewed product-policy
  exception stored outside the automation ladder, never a setting, grant, trust
  tier, or preset. This ADR creates no such exception.
- Personal-contact fields require named, destination-bound disclosure; general
  task consent or approval of a plan does not authorize disclosure.
- Controls the classifier does not positively recognize remain human-only at
  every automation level.
- Authority never lives in a client and never arrives as a boolean beside the
  request it authorizes.

## Existing Enforcement And Gaps

- [`content.js`](../../browser-first/resonantos-side-panel-extension/src/content.js)
  enforces the unconditional public-submit guard in `clickElement` (near line
  507). Its comment says not to add a `userApproved` or any other bypass: the
  human must click on the page. A future commit broker cannot silently bypass
  this guard.
- [`content-field-safety.js`](../../browser-first/resonantos-side-panel-extension/src/lib/content-field-safety.js)
  blocks credential, payment, login, and personal-contact typing and submission.
  It currently permits generic-text typing; that fallback does not establish
  the stronger positive-recognition invariant above. Named, destination-bound
  disclosure is a required boundary, not a claim of an existing disclosure
  authorization flow. These gaps require implementation work, not weaker policy.
- The merged [`opencode-boundary.mjs`](../../browser-first/host/opencode-boundary.mjs)
  supplies the existing pattern: host-held upstream credentials, sanitized
  client results, and generation-fenced revocation. Retirement increments the
  generation, aborts requests, closes subscribers, and clears the session
  registry before asynchronous cleanup. Its
  [session routes](../../browser-first/host/opencode-session-host-service.mjs)
  declare read/control capabilities enforced by the
  [bridge transport](../../browser-first/host/bridge-server.mjs). This is evidence
  for host mediation, not an implementation of Guardian or Core-only grants.

## Invariant Changes: Working Assumption

The working assumption is a two-person rule for invariant-bearing paths through
CODEOWNERS plus a ruleset requiring code-owner review for those paths only,
with an accompanying ADR. Either owner may **tighten** an invariant alone in an
emergency (revert, block, suspend), subject to review afterwards. **Loosening**
always requires both owners before merge. A rollback that loosens an invariant
is not an emergency-tightening exception.

This depends on a second active maintainer and is **not yet applied**. Merely
listing two owners is not proof that both approvals are enforced; the eventual
ruleset must demonstrably implement the two-person requirement and the limited
emergency asymmetry. Ordinary non-invariant paths do not acquire this rule.

Initial CODEOWNERS path list to protect (owner identities remain unassigned):

```text
/.github/CODEOWNERS
/docs/architecture/ADR-038-guardian-engineer-core-only-invariants.md
/src/core/contracts.ts
/src/core/policies.ts
/src/core/policies.test.ts
/packages/addon-sdk/src/contracts.ts
/packages/addon-sdk/src/validation.ts
/src/sdk/addons/validation.ts
/src/sdk/addons/validation.test.ts
/browser-first/resonantos-side-panel-extension/src/content.js
/browser-first/resonantos-side-panel-extension/src/lib/content-field-safety.js
/browser-first/resonantos-side-panel-extension/src/lib/approval-policy.js
/browser-first/host/bridge-server.mjs
/browser-first/host/bridge-capability-tokens.mjs
/browser-first/host/opencode-boundary.mjs
/browser-first/host/opencode-session-host-service.mjs
/browser-first/test/agent-control-public-submit.test.mjs
/browser-first/test/approval-policy.test.mjs
/browser-first/test/bridge-route-capability-audit.test.mjs
/browser-first/test/opencode-boundary.test.mjs
/browser-first/test/opencode-execution-revocation.test.mjs
```

Before their implementation, extend this list to the actual paths owning the
Guardian baseline and recovery policy, commit broker, DSH native-host cookie
custody, connector OAuth custody, product-policy exceptions, disclosure
authorization, trust/signing roots, and update verification, with their boundary
tests. Their paths are not selected here. Protect any repository ruleset
configuration when introduced; no CODEOWNERS, ruleset, or workflow is changed
by this ADR.

## Not Decided

- Guardian implementation language, supervisor integration, health probes,
  restart limits, baseline storage/selection, and rollback packaging.
- DSH confinement mechanics, native-host packaging, commit-broker protocol,
  connector OAuth implementation, and update/signing technology.
- A delivery date, expanded Alpha release scope, model choice, or migration
  implementation for the request/grant types and classifier gaps.
- Maintainer identities and the exact ruleset configuration; the review
  mechanism remains the working assumption above.

## Consequences

- Recovery must work with every model unavailable and without optional chat or
  memory add-ons. The separate process adds supervision and baseline-integrity
  work, while constraining recovery to known operations.
- First-party surfaces use the same authority-request boundary as public
  extensions. Policy cannot be relaxed by a preset or client-side approval.
- The SDK must migrate requests and presets separately from host grants, with
  rejection tests for author-supplied authority and Core-only requests.
- Implementation must close the documented enforcement gaps and test recovery
  without a model, denied Guardian policy changes, and rollback preservation of
  tightened invariants. Acceptance of this ADR is not proof those checks pass.
- Invariant changes have a higher review cost; emergency tightening stays
  possible, while loosening awaits both active owners.
