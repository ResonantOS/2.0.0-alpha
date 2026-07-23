# Governed OpenCode Session Implementation Plan

> **Execution contract:** Follow Superpowers test-driven development and
> subagent-driven development. Use the Resonant Rig full tier at the plan,
> deterministic, multi-vendor, and meta-audit gates. Do not push, merge, or mark
> a pull request ready without human approval.

**Goal:** Replace the unsafe OpenCode live-session prototype with a fail-closed,
bridge-owned, authenticated, workspace-scoped, session-bound developer preview
that uses the OpenCode 1.18.4 SDK contract.

**Architecture:** The browser-first bridge is the sole policy and lifecycle
owner. Host-owned settings authorize a selected workspace and explicit grants.
The bridge starts a private `opencode serve --pure` child with generated Basic
authentication and an allowlisted environment, drives it through the pinned
SDK, and exposes only session-scoped JSON routes. The extension polls a bounded
bridge event relay and never connects to OpenCode directly.

**Tech stack:** Node.js 22 ESM, `@opencode-ai/sdk` 1.18.4, Chrome Manifest V3,
Node test runner, repository security and Alpha verification pipelines.

**Design reference:**
[Governed OpenCode Session Design](../specs/2026-07-22-governed-opencode-session-design.md)

## Global Constraints

- OpenCode remains optional and is not an Alpha runtime or release gate.
- The session start request cannot override host-owned consent, grants,
  workspace, provider, model, command, environment, host, or port.
- Required live-session grants are exactly `filesystem`, `shell`, `providers`,
  and `ui-embedding`; all default denied.
- The selected workspace must resolve to the repository root or a descendant.
- The OpenCode child uses loopback, an available bridge-selected port,
  `--pure`, a generated password, an explicit working directory, `shell: false`,
  and an allowlisted environment.
- The bridge never reuses or kills a service it did not start.
- The extension never receives the OpenCode URL, service password,
  Authorization header, provider credential, full environment, or unfiltered
  event stream.
- Prompts use the host-selected model. Extension requests contain text only.
- Permission replies are only `once` or `reject`; persistent approval is not
  exposed.
- Every prompt, permission, event, and stop request must match the one active
  ResonantOS-created session.
- The in-memory relay retains at most 500 session-attributable events and
  reports cursor gaps explicitly.
- No fake revert or remembered-approval control remains visible.
- OpenCode events and output are untrusted evidence, not verified completion.
- Provider credentials, generated server credentials, absolute paths, event
  payloads, and local evidence are never committed or logged.
- Changes follow `docs/architecture/MODULE-OWNERSHIP.md`; route ownership and
  capability declarations are updated with the implementation.

## Task 1: Certify This Plan Before Runtime Changes

**Files:**

- Review: `docs/superpowers/specs/2026-07-22-governed-opencode-session-design.md`
- Review: `docs/superpowers/plans/2026-07-22-governed-opencode-session.md`
- Record: `.resonant-rig/`

**Step 1: Build a read-only review package**

Generate a file handoff containing the design, this plan, ADR-021, module
ownership, the current OpenCode prototype, and its tests.

**Step 2: Dispatch a diverse plan panel**

Use at least three independent vendors. Assign architecture/order,
security/trust-boundary, and test/anti-false-green lenses. Reviewers must cite
file and line evidence and return `CONFIRM` or `REVISE`.

**Step 3: Adjudicate every finding**

Verify findings against repository code and the locally captured OpenCode
1.18.4 OpenAPI/SDK declarations. Revise and recommit the plan if any real
Critical or Important gap survives adjudication.

**Step 4: Re-run the documentation gate**

Run:

```bash
npm run docs:check
npm run test:docs
```

Expected: both exit zero before Task 2.

## Task 2: Add Host-Owned Live-Session Consent And Preflight

**Files:**

- Modify: `browser-first/host/addon-delegation-service.mjs`
- Modify: `browser-first/test/addon-delegation-service.test.mjs`
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/settings/addons-section.js`
- Modify: the existing focused Add-ons settings test under `browser-first/test/`

**Step 1: Write failing host-policy tests**

Add tests proving:

- normalized settings default `liveSession.enabled` false, workspace empty, and
  grants empty;
- update rejects unknown grants and stores only the four allowed grants;
- update rejects live enablement without all required grants or a workspace;
- preflight rejects disabled CLI execution, disabled live session, each missing
  grant, missing runtime, missing provider credential, and an out-of-repository
  workspace;
- request fields and execution environment flags cannot bypass live-session
  consent;
- successful preflight returns internal command, workspace, model, and scoped
  environment while public status returns only a redacted workspace label and
  readiness reasons;
- revocation produces a stop-required signal for an active session.

Run the focused test and confirm the new assertions fail for the intended
missing behavior.

**Step 2: Implement closed-by-default settings**

Extend only the OpenCode settings shape:

```js
{
  localCliExecution: false,
  liveSession: {
    enabled: false,
    workspacePath: "",
    grantedCapabilities: []
  }
}
```

Keep the file mode `0600`. Preserve legacy settings by normalizing absent
fields to closed defaults. Export an in-process
`executeOpenCodeLiveSessionPreflight()` from the add-on delegation service; do
not register it as a bridge route.

**Step 3: Add explicit Settings controls**

For the OpenCode card only, render a workspace input, the four grant
checkboxes, and a live-session enable checkbox inside Runtime controls. Save
one complete desired OpenCode setting through the existing capability-gated
execution-settings route. Use labels and status text that state the preview is
optional and that OpenCode receives scoped filesystem, shell, and provider
authority.

**Step 4: Run focused tests**

Run the host-policy and Add-ons settings tests. Expected: zero failures.

**Step 5: Commit**

Commit message:

```text
feat(opencode): require host-owned live-session consent
```

## Task 3: Replace The Raw HTTP Prototype With An Authenticated SDK Lifecycle

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Rewrite: `browser-first/host/opencode-client.mjs`
- Rewrite: `browser-first/test/opencode-client.test.mjs`

**Step 1: Pin the SDK**

Install exactly `@opencode-ai/sdk@1.18.4` as a runtime dependency. Confirm the
lockfile resolves exactly 1.18.4.

**Step 2: Write failing lifecycle and contract tests**

Cover:

- available loopback port allocation;
- generated Basic Authorization without credential disclosure;
- spawn arguments include `serve --pure --hostname 127.0.0.1 --port`;
- `cwd`, `shell: false`, and the exact allowlisted environment reach spawn;
- readiness probes are authenticated;
- an occupied or unauthenticated listener is never reused;
- timeout and early child exit kill only the spawned child and clear state;
- SDK creation receives base URL, directory, Authorization, and
  `throwOnError: true`;
- session creation, prompt, permission reply, and event subscription use the
  1.18.4 v2 SDK shapes;
- model identifiers split once into `{ providerID, modelID }` and invalid
  identifiers fail before a request;
- public lifecycle results contain no base URL, credential, or absolute path.

Run the focused test and confirm red.

**Step 3: Implement the bridge-owned lifecycle**

Replace the dependency-free HTTP wrapper with:

- a loopback port allocator;
- a lifecycle that always starts a new authenticated `--pure` child;
- an authenticated readiness probe;
- a narrow SDK adapter injected for unit tests and backed by
  `@opencode-ai/sdk/v2` in production;
- idempotent cleanup for timeout, exit, stop, and event-pump failure.

Do not add direct extension-facing URLs.

**Step 4: Run focused tests and dependency audit**

Run:

```bash
node --test browser-first/test/opencode-client.test.mjs
npm audit --omit=dev
```

Record any advisory without suppressing it. Expected focused test: zero
failures.

**Step 5: Commit**

Commit message:

```text
feat(opencode): own authenticated sdk lifecycle
```

## Task 4: Enforce Session Ownership And Relay Bounded Events

**Files:**

- Rewrite: `browser-first/host/opencode-session-host-service.mjs`
- Rewrite: `browser-first/test/opencode-session-host-service.test.mjs`

**Step 1: Write failing route and state-machine tests**

Prove:

- the event route exists and requires `addon-runtime-read`;
- all mutation routes require `addon-runtime-control`;
- start calls preflight before lifecycle start;
- repeated start for the same workspace is idempotent and a different
  workspace is rejected;
- start returns only session ID and redacted workspace;
- prompt, permission, events, and stop reject absent or non-owned sessions;
- prompts send only host-selected model and validated text;
- permission allows only `once` and `reject` with `requestID`;
- events from other sessions and unattributable global events are discarded;
- the 501st retained event evicts the oldest and reports `droppedBefore`;
- cursors increase monotonically and polling after a cursor returns no
  duplicates;
- child exit, pump failure, preflight revocation, and explicit stop clear all
  session, event, client, and credential state;
- cleanup never kills an injected foreign process.

Run the focused test and confirm red.

**Step 2: Implement one active session per bridge**

Create a controller with explicit states `stopped`, `starting`, `running`, and
`failed`. Inject preflight, lifecycle start, clock, and buffer limit. Keep SDK
client and credentials in closure state only. Extract session IDs from the
documented 1.18.4 event property locations and enqueue only active-session
events.

**Step 3: Implement JSON polling route**

Add `POST /opencode/session/events`. Validate `after` as a non-negative safe
integer. Return entries as `{ cursor, event }`, plus `nextCursor` and
`droppedBefore`.

**Step 4: Run focused tests**

Run:

```bash
node --test browser-first/test/opencode-session-host-service.test.mjs
```

Expected: zero failures.

**Step 5: Commit**

Commit message:

```text
feat(opencode): relay owned session events through bridge
```

## Task 5: Correct The Extension Event And Permission Contracts

**Files:**

- Rewrite: `browser-first/resonantos-side-panel-extension/src/lib/opencode-session-model.js`
- Rewrite: `browser-first/test/opencode-session-model.test.mjs`
- Rewrite: `browser-first/resonantos-side-panel-extension/src/lib/opencode-bridge-source.js`
- Rewrite: `browser-first/test/opencode-bridge-source.test.mjs`

**Step 1: Write failing OpenCode 1.18.4 event fixtures**

Use fixtures matching the captured SDK declarations, including
`properties.delta`, `properties.diff`, `properties.file`,
`permission.v2.asked`, `permission.v2.replied`, nested `session.updated.info`,
session status, idle, and message-part deltas. Prove cross-session events are
ignored even if they reach the reducer.

**Step 2: Write failing polling-source tests**

Prove one start, monotonic `after` cursors, no direct fetch or SSE URL, polling
shutdown, cursor-gap disclosure, prompt/permission session IDs, and bridge stop.

**Step 3: Implement the reducer and polling source**

Normalize only documented fields. Keep unknown events non-fatal. Replace the
SSE parser and raw-event fetch with the authenticated bridge polling loop. Use
an injected sleeper in tests and prevent concurrent polls.

**Step 4: Run focused tests**

Run:

```bash
node --test \
  browser-first/test/opencode-session-model.test.mjs \
  browser-first/test/opencode-bridge-source.test.mjs
```

Expected: zero failures.

**Step 5: Commit**

Commit message:

```text
fix(opencode): consume session-bound 1.18.4 events
```

## Task 6: Make The OpenCode Workspace Controls Truthful

**Files:**

- Modify: `browser-first/resonantos-side-panel-extension/src/lib/main-workspace-opencode.js`
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/opencode-session-view.js`
- Modify: `browser-first/test/main-workspace-opencode-session.test.mjs`
- Modify: `browser-first/test/opencode-session-view.test.mjs`
- Modify: relevant extension CSS only if required for stable layout

**Step 1: Write failing UI tests**

Prove Start is disabled unless status is ready, preflight reasons are visible,
no raw URL is read, stop tears down the source, and only Approve once and Deny
are rendered for permissions. Assert that Revert and Approve + remember are not
present.

**Step 2: Implement truthful states and controls**

Drive readiness from host status. Use the bridge source once per Start action.
Display cursor-gap and terminated-session messages. Keep this surface labeled a
governance/evidence preview, not the complete OpenCode IDE.

**Step 3: Run focused tests**

Run:

```bash
node --test \
  browser-first/test/main-workspace-opencode-session.test.mjs \
  browser-first/test/opencode-session-view.test.mjs
```

Expected: zero failures.

**Step 4: Commit**

Commit message:

```text
fix(opencode): expose only implemented session controls
```

## Task 7: Wire Production Dependencies And Route Capabilities

**Files:**

- Modify: `browser-first/host/run-bridge-minimal.mjs`
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js`
- Modify: `browser-first/test/bridge-capability-token-consistency.test.mjs`
- Add or modify: focused bridge wiring test under `browser-first/test/`

**Step 1: Write failing wiring tests**

Assert the production bridge injects the host preflight, scoped lifecycle, SDK
factory, and random credential generator; it must not pass `process.env` as the
OpenCode child environment. Assert the event route maps to
`addon-runtime-read` in the extension and the bridge.

**Step 2: Implement production wiring**

Use the fixed-root command resolver, the in-process preflight, the exact SDK
factory, and bridge token utilities. Register process-shutdown cleanup. Remove
the fixed 4231 port, raw client, raw URL, and direct-event comments.

**Step 3: Run focused and complete browser-first tests**

Run:

```bash
node --test browser-first/test/bridge-capability-token-consistency.test.mjs
npm run test:browser-first
```

Expected: zero failures.

**Step 4: Commit**

Commit message:

```text
feat(opencode): wire governed session into bridge
```

## Task 8: Update Canonical Ownership And Optional-Preview Documentation

**Files:**

- Modify: `docs/architecture/ADR-021-opencode-addon-hosted-service.md`
- Modify: `docs/architecture/MODULE-OWNERSHIP.md`
- Modify: `docs/reference/CAPABILITY_MATRIX.md`
- Modify: `docs/STATUS.md` only if the final live check is green
- Modify: `docs/superpowers/specs/2026-07-22-governed-opencode-session-design.md`

**Step 1: Update current-truth documentation**

Record the implemented JSON routes, host/session ownership, exact capability
mapping, SDK pin, workspace and consent rules, event relay, limitations, and
test ownership. Keep OpenCode Partial/optional and outside Alpha requirements.
Do not add dated status claims before verification.

**Step 2: Run documentation and ownership gates**

Run:

```bash
npm run docs:check
npm run test:docs
npm run test:module-ownership
```

Expected: zero failures.

**Step 3: Commit**

Commit message:

```text
docs(opencode): record governed preview contracts
```

## Task 9: Live Contract, Security Mutations, And Full Certification

**Files:**

- Add: `browser-first/test/opencode-live-contract.mjs`
- Add or modify: package script only if the live check needs an explicit entry
- Record: `.resonant-rig/`

**Step 1: Add an opt-in live contract check**

The script must use a disposable subdirectory, the installed fixed-root
OpenCode 1.18.4 runtime, and no provider invocation unless a test provider is
explicitly supplied. It proves unauthenticated readiness returns 401,
authenticated SDK session creation and attributable event receipt work, no
OpenCode URL or credential crosses the public controller result, and the child
is unreachable after stop. It must clean up in `finally`.

**Step 2: Run deterministic gates**

Commit the candidate, then run:

```bash
npm run test:browser-first
node scripts/security-pipeline/run-check.mjs
npm run docs:check
npm run test:docs
npm run verify:alpha
```

Capture exit codes and complete logs in the rig evidence directory.

**Step 3: Run the live contract check**

Run the opt-in script against the fixed-root OpenCode 1.18.4 installation.
Record runtime version, redacted workspace label, and lifecycle results without
credentials or absolute paths.

**Step 4: Run anti-false-green mutations**

Use `rig-mutate` against committed snapshots. Independently remove or bypass:

1. the required-grant check;
2. the child environment allowlist;
3. the authenticated `--pure` lifecycle requirement;
4. the active-session event filter.

Each named focused test must fail. Restore byte-identical files and rerun every
focused test green.

**Step 5: Run diverse read-only certification**

Create a review package from the branch merge base to candidate head. Dispatch
runtime, security/hygiene, code-correctness, docs-accuracy, and merge-integrity
lenses across at least three vendors. Adjudicate every finding. Fix introduced
Critical and Important issues, request re-review from the raising reviewer, and
rerun affected gates.

**Step 6: Run meta-audit**

Give a high-reasoning reviewer the plan, ledger, deterministic logs, mutation
logs, live-check log, panel reports, and adjudication. Require it to reproduce
the key claims and identify any skipped gate or unproven assertion.

**Step 7: Prepare handback**

Report exact commits, files, tests, live evidence, residual risks, and Alpha
boundary. Keep the branch and worktree. Do not push, open a pull request, mark
ready, or merge until the human selects the integration option.
