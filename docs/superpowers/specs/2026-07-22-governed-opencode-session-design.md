# Governed OpenCode Session Design

## Status

- Design status: Approved for implementation
- Date: 2026-07-22
- Owner: OpenCode add-on and browser-first bridge
- Runtime status: Optional developer preview; not an Alpha release requirement
- Governing decisions: ADR-006, ADR-015, ADR-021, ADR-034
- Implementation plan:
  [Governed OpenCode Session Implementation Plan](../plans/2026-07-22-governed-opencode-session.md)

## Purpose

This design defines the first production-grade boundary between ResonantOS and
an interactive OpenCode service. It replaces the existing prototype, which
exposes an unauthenticated OpenCode URL to the extension and relies on stale
HTTP and event contracts.

The broader coding-system architecture remains:

1. Resonant Apex is the deterministic conductor and policy owner.
2. OpenSpec owns proposed-change specifications and their lifecycle.
3. OpenCode supplies an optional coding execution and interaction substrate.
4. ResonantOS owns workspace scope, capability consent, credentials, service
   lifecycle, audit evidence, and completion claims.

This change secures and makes truthful the live OpenCode session boundary. It
does not make OpenCode, OpenSpec, or Resonant Apex part of the browser-first
Alpha runtime, and it does not claim to complete the full Apex coding system.

## Existing Problem

The current live-session prototype violates the intended ownership boundary in
several ways:

- The bridge starts `opencode serve` without authentication or `--pure`.
- The child inherits the bridge's complete environment rather than an explicit
  allowlist.
- A fixed port can collide with an unrelated service, and a healthy response is
  treated as permission to reuse that service.
- The bridge returns the OpenCode base URL and event URL to the extension, which
  then connects directly to the OpenCode event bus.
- Session start does not require the host-owned execution setting, required
  grants, or a selected workspace.
- Permission replies and event normalization target older or invented payload
  shapes instead of the installed OpenCode 1.18.4 API.
- The UI exposes controls, including revert and remembered approvals, that the
  host does not correctly implement.

These are security and correctness defects in an optional preview. They do not
change the Alpha runtime boundary, but the unsafe preview must not remain
available as if it were governed.

## Goals

- Fail closed unless the OpenCode runtime is available and the user has
  explicitly enabled local execution and the live session.
- Require a workspace selected under the repository root, bind the OpenCode
  process to that workspace, and deny OpenCode's `external_directory`
  permission.
- Require the live-session grants that match the authority actually exercised:
  `filesystem`, `shell`, and `providers`.
- Start a bridge-owned OpenCode server on loopback with generated Basic
  authentication and `--pure`.
- Pass only allowlisted process variables and the selected provider credential
  to OpenCode.
- Use the pinned OpenCode 1.18.4 SDK contract for sessions, prompts,
  permissions, and events.
- Keep the OpenCode URL and service credential inside the bridge process.
- Relay only events belonging to the active ResonantOS-created session.
- Make controls truthful: approve once, deny, start, prompt, and stop only.
- Keep events and credentials ephemeral and bounded in memory.
- Preserve the existing one-shot governed delegation and artifact path.

## Non-Goals

- Making OpenCode a required Alpha component.
- Shipping Tauri, Electron, native browser hosts, or a native IDE.
- Implementing the complete Resonant Apex conductor or OpenSpec lifecycle.
- Treating OpenCode output as verified completion evidence.
- Allowing OpenCode to write trusted Living Archive knowledge directly.
- Claiming that `cwd` is an operating-system sandbox. OpenCode's file tools are
  denied external-directory access and every other tool action is approval
  gated, but the optional preview still runs as the current OS user.
- Reusing an arbitrary pre-existing OpenCode service.
- Implementing automatic approval, persistent approval, or a fake revert.
- Rebuilding OpenCode's full IDE inside ResonantOS.

## Trust Boundary

### Extension

The extension may request a live session, submit prompts, answer a displayed
permission request, poll session events, and stop its session. It receives only
a ResonantOS session identifier, a redacted workspace label, and normalized
session events. It never receives the OpenCode base URL, server password,
provider credential, raw process environment, or an unscoped event stream.

### Browser-First Bridge

The bridge is the policy enforcement point. It validates host-owned consent,
capability grants, runtime availability, workspace scope, and session
ownership. It generates service credentials, owns the child process, creates
the SDK client, filters events, bounds the event buffer, and tears down all
ephemeral state.

### OpenCode

OpenCode is an add-on worker. It receives the selected workspace, the minimum
runtime environment, and only the provider credential needed for the selected
model. Its responses, diffs, tool results, and completion status are evidence
for human review, not ResonantOS verification.

### Resonant Apex And OpenSpec

The future Apex conductor will invoke this same bridge-owned boundary after an
OpenSpec change packet passes policy. It must not bypass or duplicate the
session authorization, workspace, credential, permission, or evidence rules
defined here.

## Host-Owned Consent

The host execution settings add an OpenCode live-session section:

```json
{
  "opencode": {
    "localCliExecution": false,
    "liveSession": {
      "enabled": false,
      "workspacePath": "",
      "grantedCapabilities": []
    }
  }
}
```

The settings file remains local host state written with mode `0600`. A live
session is authorized only when all of the following are true:

1. `localCliExecution` is true.
2. `liveSession.enabled` is true.
3. `workspacePath` resolves to the repository root or one of its descendants.
4. `grantedCapabilities` contains exactly the required authority for the
   governance session: `filesystem`, `shell`, and `providers`.
5. The fixed-root OpenCode resolver finds an executable.
6. The selected provider route is configured.

Request payloads cannot override these settings. Operator environment flags
that enable one-shot delegation do not silently enable a live session.
Revoking any required setting stops an active session.

The live-session preflight reads these persisted settings directly. It does
not call the one-shot delegation override helper and ignores
`payload.enableOpenCodeExecution` and `RESONANTOS_OPENCODE_EXECUTION`.

The Add-ons settings UI presents the three grants as explicit checkboxes, a
workspace field, and a separate live-session enable control. Local CLI
execution remains its own control. The UI sends one complete desired OpenCode
setting, and the host normalizes and validates it before persisting.

`ui-embedding` is not a live-session grant. The current center panel is a
ResonantOS governance and evidence view, not OpenCode's web UI. A future design
that proxies and embeds OpenCode's web UI must request `ui-embedding`
separately and pass its own security and platform review.

## Service Lifecycle

1. The bridge performs the authorization preflight.
2. It selects an available loopback port. It never accepts an already-running
   service as its own.
3. It generates a high-entropy password and sets the fixed non-secret username
   `resonantos` through `OPENCODE_SERVER_USERNAME` and
   `OPENCODE_SERVER_PASSWORD`.
4. It starts:

   ```text
   opencode serve --pure --hostname 127.0.0.1 --port <ephemeral-port>
   ```

5. The child working directory is the approved workspace.
6. The child environment is built from an explicit system allowlist, only the
   selected provider credential, and the generated OpenCode server
   credentials. Inherited `OPENCODE_SERVER_USERNAME`,
   `OPENCODE_SERVER_PASSWORD`, every `RESONANTOS_BROWSER_FIRST_*` value, and
   unselected provider credentials are excluded. Generated server credentials
   are overlaid in memory and are never placed in `process.env` or passed to
   the one-shot CLI delegation path.
7. The host sets an isolated OpenCode configuration directory, disables
   project configuration, and supplies the closed permission policy
   `{"*":"ask","external_directory":"deny"}`. This makes all executable
   actions visible for one-time approval and denies file-tool traversal outside
   the selected workspace. It does not claim OS-level process isolation.
8. Readiness requires an authenticated request to `/doc`. An unauthenticated
   response is not accepted as proof of ownership.
9. The bridge creates `@opencode-ai/sdk/v2` with the authenticated base URL and
   explicit workspace directory.
10. The bridge creates one ResonantOS-owned OpenCode session and starts its event
   subscription.
11. Stop, bridge shutdown, child exit, authorization revocation, or event-pump
    failure closes the subscription, kills only the bridge-owned child, clears
    credentials, and discards the event buffer.

Only one live OpenCode workspace is active per bridge process in this first
slice. A repeated start for the same authorized workspace returns the current
session. A start for another workspace is rejected until the current session
is stopped.

## Bridge API

All routes require normal bridge authentication. Capability tokens remain
separate from the OpenCode service credential.

| Method and path | Capability | Request | Response |
| --- | --- | --- | --- |
| `POST /opencode/session/start` | `addon-runtime-control` | `{}` | `{ ok, sessionId, workspace }` |
| `POST /opencode/session/prompt` | `addon-runtime-control` | `{ sessionId, text }` | `{ ok }` |
| `POST /opencode/session/permission` | `addon-runtime-control` | `{ sessionId, requestId, reply }` | `{ ok }` |
| `POST /opencode/session/events` | `addon-runtime-read` | `{ sessionId, after? }` | `{ events, nextCursor, droppedBefore }` |
| `POST /opencode/session/stop` | `addon-runtime-control` | `{ sessionId }` | `{ ok }` |

`reply` is one of `once` or `reject`. Persistent approval is intentionally not
exposed. Every operation verifies that `sessionId` is the active
ResonantOS-owned session.

No response contains `baseUrl`, `eventUrl`, an Authorization header, a provider
credential, or an absolute workspace path.

## Event Relay

The bridge consumes OpenCode's authenticated v2 event stream through the SDK and
places matching events in an in-memory ring buffer. Each accepted event gets a
monotonic ResonantOS cursor. The buffer holds at most 500 events.

The extension polls the authenticated bridge route with its last cursor. The
bridge returns events after that cursor, the next cursor, and the earliest
cursor still retained. If the caller has fallen behind, `droppedBefore`
explicitly signals the gap rather than silently presenting an incomplete
transcript.

Events are checked before buffering and accepted only when
`event.data.sessionID` equals the active session.
Global events without an attributable active session are not relayed. In
particular, `file.edited` has no session identifier in OpenCode 1.18.4 and is
discarded; attributable changed-file evidence comes from session diffs, step
completion, and tool results.

The extension normalizes these OpenCode 1.18.4 event shapes:

- `session.next.text.delta.data.delta`
- `session.next.reasoning.delta.data.delta`
- `session.next.tool.called|success|failed`
- `session.diff.data.diff`
- `permission.v2.asked.data.id`
- `permission.v2.replied.data.requestID`
- `todo.updated.data.todos`
- `session.updated.data.info`
- `session.status.data.status`
- `session.idle`
- `message.part.delta.data.delta`

Unknown events are ignored without widening access or failing the session.

## SDK Contract

The root dependency pins `@opencode-ai/sdk` to exact version `1.18.4`. The host
uses the `@opencode-ai/sdk/v2` export and these operations:

- `createOpencodeClient({ baseUrl, directory, headers, throwOnError: true })`
- `client.v2.session.create({ model: { providerID, id }, location: { directory } })`
- `client.v2.session.prompt({ sessionID, prompt: { text }, delivery: "queue" })`
- `client.v2.session.permission.reply({ sessionID, requestID, reply })`
- `client.v2.event.subscribe()`

The event pump consumes the SDK's async stream with an abort signal. The
permission-request adapter deliberately maps
`permission.v2.asked.data.id` to the v2 reply argument `requestID`; a request
identifier is never forwarded through the global legacy permission endpoint.
The production SDK module is loaded lazily only after host preflight succeeds;
unit tests inject an adapter and do not need to start or import OpenCode.

The dependency is pinned because the existing prototype already demonstrated
that silently drifting API assumptions produce apparently functional but
incorrect controls. An SDK upgrade requires contract tests and a deliberate
dependency change.

## User Experience

The OpenCode workspace reports one of these states:

- unavailable: runtime missing;
- disabled: local execution is off;
- consent required: live session or required grants are missing;
- workspace required: no valid workspace is selected;
- ready: all preflight checks pass;
- starting, running, waiting for approval, stopped, or failed.

The Start button is enabled only in `ready`. Errors name the exact missing host
setting without exposing local paths or secrets. Session controls include
prompt submission, approve once, deny, refresh/poll, and stop. Revert and
remembered approval are absent until they have real host implementations.

The session panel is a governance and evidence view, not a replacement claim
for the complete OpenCode IDE. Future embedding of OpenCode's own web UI must
use a separate authenticated bridge proxy design and platform validation.

## Audit And Evidence

This slice does not persist raw prompts or events beyond existing browser UI
state. Host diagnostics may record only redacted lifecycle facts: start/stop
time, redacted workspace label, selected model identifier, session result
state, and error category. They must not record credentials, Authorization
headers, full environment variables, or unrestricted event payloads.

OpenCode-reported diffs and tool results remain untrusted evidence. ADR-034's
deterministic runner, Git state checks, or a future Apex certification gate must
verify completion before ResonantOS claims a coding task succeeded.

## Failure Behavior

- Missing consent, grant, workspace, runtime, or provider: reject before spawn.
- Port collision: allocate another loopback port; do not reuse the listener.
- Readiness timeout or authentication mismatch: kill the child and clear state.
- Child exit: mark failed, stop polling, and clear credentials.
- Invalid session identifier: reject without disclosing the active identifier.
- Invalid permission reply: reject before calling OpenCode.
- Event cursor gap: return `droppedBefore` and require the UI to disclose that
  history is incomplete.
- Bridge shutdown: kill the bridge-owned OpenCode child.

## Verification Strategy

### Deterministic tests

- Settings normalization defaults closed and preserves explicit grants only.
- Preflight rejects every missing requirement and all out-of-scope paths.
- Spawn uses loopback, `--pure`, a selected workspace, generated Basic auth,
  and an allowlisted environment.
- Spawn replaces inherited OpenCode server credentials, excludes bridge and
  unselected-provider secrets, isolates configuration, disables project
  configuration, and installs the closed OpenCode permission policy.
- The one-shot CLI environment does not inherit live server credentials.
- A foreign or unauthenticated service is never reused.
- SDK calls use the OpenCode 1.18.4 v2 request shapes, including
  session-scoped permission replies and `{ providerID, id }` model references.
- Route capabilities distinguish event reads from runtime control.
- Session ownership is enforced on prompt, permission, events, and stop.
- Event relay filters other sessions before buffering, bounds memory, and
  reports cursor gaps.
- Reducer fixtures cover the exact 1.18.4 event schemas.
- UI has no raw URL fetch, fake revert, or remembered approval.
- Responses and diagnostics contain no URL credentials, provider secrets, or
  absolute workspace paths.

### Anti-false-green checks

Mutation tests temporarily remove the session filter, environment allowlist,
authentication argument, and required-grant check. Each corresponding focused
test must fail before the original implementation is restored byte-for-byte.

### Live contract check

With a locally installed OpenCode 1.18.4 and a disposable repository
subdirectory, start the real authenticated service, create a session, observe a
session-bound event, and stop the process. This check may use a fake or
non-invoking prompt when no provider credential is available. It must prove
that unauthenticated `/doc` access returns `401` and that the service is gone
after stop.

### Repository gates

Run `npm run test:browser-first`, the security pipeline, documentation checks,
and `npm run verify:alpha`. The optional OpenCode preview may not weaken or
redefine any Alpha gate.

## Rollout

The feature remains labeled optional and experimental. It can merge only after
the deterministic gate, anti-false-green evidence, live contract check, and a
diverse security/correctness review pass. Release notes must state that the
community Alpha is the Chrome extension plus local bridge and that OpenCode is
an opt-in developer preview.
