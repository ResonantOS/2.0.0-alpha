# Embedded Harness Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The conductor runs live proof; workers write and syntax-check it only.

**Goal:** Add the approved optional manifest interfaces, visible self-governed boundary, and opt-in local metadata history with durable consent and retention.

**Architecture:** Preserve the operator-configured embed tunnel and capture only projected metadata at the extension relay boundary. A pure core contract is packaged deterministically for the extension; a dedicated host service owns private serialized storage, while the bridge authenticates all six governance routes. Page sharing, recording consent, interface view selection, and primary-agent slot authority remain separate.

**Tech Stack:** Node.js 24.21.0, TypeScript, native ESM JavaScript, Chrome MV3, node:test, jsdom, Vitest, Playwright, Node filesystem/crypto/http APIs. No new dependency.

## Upstream protocol amendment (2026-10-15)

EMBED-UPSTREAM-1 confirmed that the spec and copied examples below used wrong
upstream names. `augmentor-agent` at `79784a5`,
`apps/browser/embed/entry.mjs` lines 44–54 and 78, emits status
`{type:'augmentor-status', online, busy, sessionId?}` and events
`{type:'augmentor-event', event, data}`. `session.changed` and `turn.started`
carry `{sessionId}`; `turn.finished` carries `{sessionId, reason}`;
`tool.completed` carries `{sessionId, tool, isError}`.

This amendment supersedes `conversationId`, `conversation.changed`, and
`tool.finished` with top-level `toolName` / `error` in upstream examples.
Use status `sessionId`, `session.changed` with `data.sessionId`, and
`tool.completed` with `data.tool` / strict boolean `data.isError`.
Internal metadata kinds and `toolName` / `error` fields stay unchanged;
IDs remain in memory and prompts, arguments, results and reasons are excluded.
Update the live observer likewise and wait for online status before its first
send. Verify with failing upstream-shaped controller tests before the fix,
passing tests after it, and `rig-mutate` red evidence for `tool.completed`.

## Global Constraints

The following normative excerpts are copied verbatim from the approved spec. Every task inherits them. References to implementation below are future work; this plan authoring task changes only this document and makes no commit.

Status: design specification only. No runtime behavior is implemented by this
document. It applies to `testing/augmentor-embed-sidecar` and targets beta.
The embed experiment remains off unless `RESONANTOS_EMBED_POC=1` is set.
It is outside the Alpha release.

### Authority and scope

The [interface decisions](embed-interface-decisions.md), approved by the project
owner on 2026-10-10, fix decisions 1 through 5. This spec implements their
direction without reopening them. The [bar design](embed-bar-design.md) remains
the layout and page-sharing baseline.

This design covers three additions: the optional manifest interface list, a
self-governed marker, and metadata recording with consent controls. It adds no
harness launcher, terminal mode, interface marketplace, transcript archive,
cross-panel synchronization, or new channel for harness actions.

The future implementation must preserve these boundaries:

- An interface change does not assign the primary-agent slot. A change of
  harness uses the existing host compare-and-swap operation. This spec adds no
  slot assignment path.
- A governed runtime checks every tool call against the capability floor.
  A self-governed runtime uses its own approvals for its own tools. It receives
  no ResonantOS capability or capability token.
- Requests for ResonantOS memory, archive, files, browser actions or credentials
  need their own mediated, receipted channel. This work creates none of those
  channels. An embed grant, context share, prompt or harness approval is never
  authority to perform such an action.
- The existing Assistant choices remain views. Do not relabel normal mode as
  an adapter for the external Augmentor unless that adapter actually exists.
- Before any merge into `dev`, an ADR must capture decisions 1 through 4 under
  the numbering process already specified in the approved decisions. This spec
  neither allocates an ADR number nor authorizes a merge.

Relevant constraints come from [ADR-018](../architecture/ADR-018-addon-sdk-v0.md),
[ADR-026](../architecture/ADR-026-minimal-kernel-replaceable-default-addons.md),
[ADR-031](../architecture/ADR-031-agent-addon-sdk-lessons-from-hermes.md), and
[Module Ownership](../architecture/MODULE-OWNERSHIP.md).


#### Type contract

Add these types beside the existing manifest types in `src/core/contracts.ts`.
Export them through `packages/addon-sdk/src/contracts.ts` and
`packages/addon-sdk/src/index.ts`.
`AddOnSdkManifest` inherits the optional field from `AddOnManifest`.
Keep SDK version `0.1.0`; this is an additive optional contract.

```ts
export type AddOnInterfaceMode = "adapter-chat" | "embed";
export type AddOnInterfaceGovernance = "governed" | "self-governed";

type AddOnInterfaceBase = {
  id: string;
  label: string;
  governance: AddOnInterfaceGovernance;
  requiredCapabilities: Capability[];
};

export type AddOnInterface = AddOnInterfaceBase & (
  | {
      mode: "adapter-chat";
      agentRuntimeRef: "agentRuntime";
      surfaceId?: never;
    }
  | {
      mode: "embed";
      surfaceId: string;
      agentRuntimeRef?: never;
    }
);

// Addition to the existing AddOnManifest interface:
export interface AddOnManifest {
  interfaces?: AddOnInterface[];
}
```

There is one `agentRuntime` per current manifest. The literal reference avoids
inventing a runtime registry. Interface identity is `(manifest.id, interface.id)`.
Authors retain IDs across label and version changes. IDs are not URLs, commands,
surface titles, adapter IDs or slot IDs.

`governance` describes the intended execution boundary. It is not provenance,
release trust, a grant, or proof of enforcement. Either mode may declare either
tier. No code may infer the tier from the mode. A runtime may present
`governed` only when the host has verified that its execution path checks every
tool call. A reviewed transport adapter alone does not prove that property.

`interfaces[].requiredCapabilities` lists requirements of the ResonantOS add-on
or reviewed adapter that presents the interface. It never lists authority to
pass into the external harness. An `agent-runtime` grant lets the host invoke
the reviewed adapter. A `ui-embedding` grant lets it present the surface.
Neither grant gives the self-governed harness a capability or token. Additional
requirements still need host mediation for each ResonantOS operation.

#### Validator rules

Add one interface-validation pass after existing surface, tool and runtime
validation in `packages/addon-sdk/src/validation.ts`. All failures below have
severity `error`. Validation is pure. It does not load modules, read files,
resolve endpoints, grant capabilities or mutate the input.

| Field or relation | Exact rule | Issue code |
| --- | --- | --- |
| `interfaces` | Omitted or JavaScript `undefined` skips the entire new pass. Otherwise require an array of 0 to 16 entries. `null` is invalid. | `interfaces-array` |
| Entry | Require a plain JSON object. Permit only the base keys and keys for its mode. Reject all unknown keys, including endpoints, credentials, defaults and executable paths. | `interface-object`, `interface-field` |
| `id` | Match `^[a-z][a-z0-9-]{0,63}$`. IDs must be unique within the list. Do not trim or repair input. | `interface-id`, `duplicate-interface-id` |
| `label` | String of 1 to 80 Unicode code points, with no U+0000 through U+001F or U+007F. Reject leading or trailing whitespace; do not trim. Render as text. | `interface-label` |
| `mode` | Exactly `adapter-chat` or `embed`. Reject `web`, `terminal` and all other values. | `interface-mode` |
| `governance` | Exactly `governed` or `self-governed`. Required for every entry. | `interface-governance` |
| `requiredCapabilities` | Required array of unique values from `ADDON_CAPABILITIES`. Each must occur in `requestedCapabilities[].capability`. Empty arrays fail the mode-specific rules below. | `interface-capabilities`, `interface-unrequested-capability` |
| Adapter reference | `agentRuntimeRef` must equal `agentRuntime`. Require a valid `agentRuntime` object with the complete version 1 adapter contract. Legacy invocation-tool-only runtimes remain valid without this interface, but cannot back a new `adapter-chat` entry. Forbid `surfaceId`. | `interface-runtime-reference` |
| Adapter dependencies | Require `agent-runtime`. Include every capability in `agentRuntime.requiredCapabilities` and the referenced invocation tool's `requiredCapabilities`. When model selection is supported, also include `modelSelection.requiredCapabilities` and the referenced change tool's `requiredCapabilities`, if a change tool is declared. Include capability values, not tool names or objects. | `interface-missing-capability` |
| Embed reference | `surfaceId` must match exactly one declared `surfaces[].id` whose type is `embedded-pane`. Forbid `agentRuntimeRef`. | `interface-surface-reference` |
| Embed dependencies | Require `ui-embedding`. Include that surface's `shellNavigation.requiredCapabilities`, if present. If `embeddedWorkspace.surfaceId` names that surface, also include its `requiredCapabilities`. | `interface-missing-capability` |

An embed entry does not require `embeddedWorkspace`. A declared embedded-pane
surface plus `ui-embedding` is sufficient. The existing workspace contract stays
optional and retains its existing validator rules. It does not acquire launch
authority through this list.

The inclusion rule is:

```text
referenced dependency capabilities
  subset of interface.requiredCapabilities
  subset of manifest.requestedCapabilities[].capability
```

Dependencies include the mandatory capability for the chosen mode. Additional
interface requirements are allowed only within the manifest request set.
The `granted` boolean in a manifest does not satisfy any host grant check.
Host grants, scope and revocation remain separate runtime decisions.

Issue paths use `interfaces[i]` and the failing field, or the capability index
for an invalid list member. Messages contain fixed explanations, never rejected
values. Existing diagnostics still apply to invalid referenced contracts.
A reference error does not suppress an existing runtime or surface error.

#### Compatibility and selection

Absent means unchanged. Old manifests keep the same validity, diagnostics,
installation behavior, surfaces, slots and dispatch. Do not synthesize
interfaces for them or write migration data. An empty list declares no new
interface choices and also leaves legacy behavior intact.

The list describes choices; it does not choose a default. List order confers no
priority. This step adds no generic interface picker or bridge dependency on
the list. Existing surface routing continues to use host projections and
grants. Preserve interfaces as manifest data through the existing registry.


#### Mapping the PoC configuration

Keep `RESONANTOS_EMBED_POC`, `RESONANTOS_EMBED_UPSTREAM_URL`,
`RESONANTOS_EMBED_PROFILE`, `RESONANTOS_EMBED_TOKEN_FILE` and
`RESONANTOS_EMBED_EXTENSION_ID` as operator-only configuration.
The profile remains the proxy path segment. It is not a harness identity or
consent key. The upstream, token file and extension ID have no new manifest
fields. No actual local profile, path or credential belongs in an example.

The host defines a public PoC descriptor with fixed product fields and a
recipient-specific notice key:

```ts
type EmbedHarnessDescriptor = {
  harnessId: "addon.augmentor-embed";
  interfaceId: "panel";
  label: "Augmentor";
  governance: "self-governed";
  noticeKey: string;
};
```

`noticeKey` is `augmentor-v1-` followed by the lowercase SHA-256 hex digest of
the UTF-8 JSON array `["addon.augmentor-embed", new URL(upstreamUrl).origin]`.
The host computes it from validated startup configuration. A different origin,
including a different port, requires a new notice. Profile, interface and
manifest version changes do not. The key is an opaque consent identifier, not
a credential or a proof of product identity. Keep the upstream URL out of the
descriptor, dialog, activity records and diagnostics. Only the notice map persists
the key. Never accept a key supplied by the harness relay.

This PoC supports an operator-configured Augmentor endpoint only. It does not
discover the product behind an arbitrary endpoint. The named live gate below
must verify that the configured recipient is Augmentor. Replacing it with a
different product requires a reviewed descriptor and notice update first.
Reusing an origin for a different product does not prove identity continuity.

Expose it as `harness` in `/embed/status` when available, and alongside
`hostPath` in `/embed/session`. Return `harness: null` when disabled.
Preserve existing `available`, `profile` and `hostPath` semantics and the normal
bridge `{ ok: true }` envelope. Session identity comes from this host response,
never from a relay message or URL query. These responses add no credentials.
The session descriptor is authoritative for that mounted frame.

This descriptor matches the example but does not load it. A manifest cannot
turn on the PoC or overwrite its fixed tier. `ui-embedding` describes permission
for the host to present a surface. It does not pass a capability into that
surface. The extension's `addon-runtime-control` bridge capability is a separate
transport permission and is never sent through the relay.

### 2. Self-governed marker

In embed mode, put a visible `Self-governed` text badge between Approvals and
Status. Keep the four existing controls in their existing order. Keep the bar
at most 36 px high. At 320 px, show Status as a static state dot with its full
existing accessible label and tooltip. Do not truncate or hide the tier text.
The badge uses existing dark tokens, readable contrast and no animation.
Normal mode retains only the Assistant control when an embed is available.

The badge description is:

> Augmentor runs outside ResonantOS approvals. Its own approvals cover its
> tools. ResonantOS access still requires separate permission.

Use the host-provided label in place of Augmentor. Render all text with
`textContent`. Make the badge keyboard focusable with visible focus.
Use `aria-describedby` to attach the description, expose it on focus and hover,
and let Escape dismiss the description. The visible text also supplies its
accessible name. Do not use color or a shield icon as the only tier indicator.
The badge is informational, not a switch or approval button.

The source is the session's host descriptor. Neither manifest provenance,
`agents[].trustTier`, connection status nor `augmentor-status` can set the tier.
While starting, or after descriptor failure, this PoC still displays
`Self-governed` using its fixed host-contract fallback. It never displays
`Governed` by inference. Failure leaves Workspace and Assistant usable.
Do not mount an unrecognized descriptor as a different trusted harness.

The Approvals tooltip becomes `ResonantOS approvals: N pending`. Its accessible
name uses the same text. Its count and action remain unchanged. It must not
suggest that it approves the harness's own tools.

### 3. Metadata capture and consent

#### Event contract

Use a shared pure module at `src/core/embed-governance-contract.js`.
It owns the metadata validator, domain projection, redaction check and fixed
constants. It contains no Chrome, filesystem, DOM or network calls.
The Node host imports the canonical module. Package the same source for the
unpacked extension at `src/lib/generated/embed-governance-contract.js` inside
the extension root. Do not import a path outside the loaded extension root.
The packaged file is a deterministic generated copy, never a second authored
validator. The implementation must add a generation and byte-parity check to
the extension preparation and test path. Keep the redaction rule source shared
with the existing trace redactor; do not fork its secret patterns. Any needed
pure extraction belongs in `src/core/` and preserves existing redactor behavior.
Keep this log contract separate from SDK manifests and from `HarnessEvent`,
which carries reply content and host execution provenance.

The following types specify the exact JSON shapes. Union members allow only
their stated keys. There is no generic `data`, `message`, `details` or `extra`
object in a recorded event.

```ts
type EmbedMetadata =
  | { kind: "conversation-changed" }
  | { kind: "reply-started" }
  | { kind: "reply-finished" }
  | { kind: "tool-finished"; toolName: string; error: boolean }
  | { kind: "page-shared"; domain: string };

type EmbedEventSubmission = {
  writeEpoch: string;
  eventId: string;
  event: EmbedMetadata;
};

type EmbedEventRecord = {
  version: 1;
  eventId: string;
  recordedAt: string;
  harnessId: "addon.augmentor-embed";
  interfaceId: "panel";
  governance: "self-governed";
  source: "harness-report" | "local-share";
  event: EmbedMetadata;
};
```

`eventId` is a lowercase UUID v4 generated by the extension for each observation.
It is not a harness conversation, turn, request or tool-call ID. The host uses
its own clock for `recordedAt`, in UTC ISO 8601 with millisecond precision.
The host supplies harness identity, interface, tier, version and source.
`page-shared` always has source `local-share`; all other kinds have source
`harness-report`. The client cannot submit those host-owned fields.

Only tool records have `toolName` and `error`. Tool names must match
`^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`. Require a literal boolean error flag.
Reject a name if the existing trace secret redactor would change it. Do not
truncate, stringify or store an invalid name. Drop that tool observation.
Names remain untrusted labels, not proof that a tool ran or was authorized.
No schema can prove that a malicious harness has not encoded content inside
a syntactically valid name. Recording is an opt-in observation facility, not
a trusted or complete audit of an outside harness.

For page shares, `domain` means the URL hostname, including subdomains. Use
`new URL(sanitizedUrl).hostname`, lowercase it and remove a final DNS dot.
URL parsing supplies ASCII IDNA form. Keep `localhost`, canonical IPv4 and
bracketed IPv6 hostnames for local fixture pages. The result is 1 to 253 ASCII
characters and must round-trip as the hostname of `http://${domain}/`.
Reject userinfo, a port, path, query, fragment or whitespace in the submitted
domain. Do not reduce to a registrable domain or add a public suffix dependency.

Never record page title, full URL, path, prompt, response text, context content,
tool arguments, results, error text, settings, model output, upstream identity
strings, authorization headers, cookies, tokens or credential file paths.
The approved page context sent to the harness still contains the sanitized
title and URL. Only its separate log projection contains the domain.


The selected input mapping is exact, with no recursive search or guessed
aliases. Fields below are top-level fields on the relay object:

| Input | Capture rule |
| --- | --- |
| `augmentor-status` with `online` and `busy` booleans | Update the existing bar state. Do not create online/offline or busy log records. |
| `augmentor-status.conversationId` | If it is a string of 1 to 128 code points without control characters, compare it in memory. The first value establishes a baseline. A later different value records `conversation-changed`. Never persist the ID. |
| `augmentor-event`, `event: "conversation.changed"`, valid `conversationId` | Apply the same comparison and update the same baseline. The first explicit change event records a change even without a baseline. This avoids a duplicate when a following status repeats it. |
| `augmentor-event`, `event: "turn.started"` | Record `reply-started` on the transition from no open reply to an open reply. Ignore repeated starts while open. |
| `augmentor-event`, `event: "turn.finished"` | Record `reply-finished` unless the last observed reply transition was already finished. A first finish is valid if observation began mid-turn. |
| `augmentor-event`, `event: "tool.finished"`, `toolName`, boolean `error` | Record `tool-finished` after the strict name and boolean checks. Two separate tool events remain two observations, even with the same name. |
| All other messages and fields | Ignore for recording. Never interpret `augmentor-result`, reply deltas, settings or error text as log metadata. |

A recorded conversation change resets the reply transition state. An offline
status or a replaced frame resets both baselines. Neither synthesizes a reply
completion. Do not infer turns from busy transitions, since reconnects and
tool activity could manufacture false records. The metadata history is
observation-only and can contain gaps.

The checked-in live proof confirms the `turn.finished` event name and the
status booleans. It does not establish every other upstream field above.
These rows specify the accepted protocol projection for implementation, not
a claim that all rows are already emitted by the current upstream version.
Before implementing the event mapping, run **EMBED-UPSTREAM-1: recipient and
relay verification** with the real configured Augmentor version. Record the
version and field-presence results in redacted evidence outside Git. Verify the
recipient label and every required event, including `conversationId`, without
saving payloads. If the recipient and fields match, implement the table as
written. If an event is absent or has a different shape, stop implementation of
that mapping and require a reviewed narrow spec update. If the recipient is not
Augmentor, do not use this descriptor or enable page sharing to it. No live run
has established those facts for this revision. Repeat this gate for a changed
upstream version or recipient configuration. Do not silently
claim full coverage, inspect proxy bytes, or start retaining raw payloads to
work around it. Any upstream protocol reconciliation stays in this narrow
projection and needs a reviewed spec update before changing the mapping.

`window.__resonantosEmbed.last` becomes an in-memory ring of at most 50 safe
objects: readiness type, status booleans, or a validated `EmbedMetadata` value.
It contains no raw messages or IDs. Metadata event history is empty while
recording is off; readiness and current status remain usable for live proof.
It never acts as a retry buffer or a persistence source.

#### Recording choice and event delivery

Recording defaults to **off**, even when the PoC is enabled. The choice is one
boolean per local bridge user root. It covers all recorded events in this
feature, including page-share domains. It does not change existing security
receipts in other services or the harness's own history.

Put an `Embedded harness activity` card in the extension workspace's
Settings > Privacy section. Use the label `Record harness activity` for its
checkbox and this description:

> Save conversation changes, reply starts and finishes, tool names and error
> flags, and shared page domains on this computer for 30 days. No prompts,
> replies, tool arguments or results are saved.

The card reads host state before showing a checked checkbox. A load failure
shows `Recording unavailable`, disables enablement and displays no success
claim. Turning on waits for the host acknowledgement. Turning off immediately
stops this controller's submissions and clears its pending metadata. Display
`Recording is off` only after the durable host acknowledgement. If the save
fails, show `Recording preference could not be saved` and refresh host state.
Never falsely claim that other panels or a later restart are disabled.

The side-panel controller loads state on mount, polls every 5 seconds while
mounted, and refreshes on window focus. Unknown state is treated as off.
The host checks its current enabled flag on every append, so disabling through
Settings takes effect there even before another panel refreshes. Enabling
starts with newly observed events only. No replay or backfill occurs.

Use a memory-only queue of at most 32 already projected events, one request at
a time, with a 2-second request timeout. Drop the newest event when full.
Do not retry failed or timed-out appends. Destroy the queue on pagehide,
disablement, bridge change or frame replacement. No unload beacon is used.
Refresh a stale write epoch but do not replay the rejected event. A logging
failure never rejects a chat operation or the Page action promise.

#### First-share notice

Show the notice before the first permitted Page share to an outside harness.
Use the mounted session's host-issued `noticeKey`. One acknowledgement covers
all profiles and interfaces at that configured recipient under the same local
user root. It survives browser and bridge restarts at the same upstream origin.
A changed recipient key requires a new notice. A missing or invalid descriptor
blocks Page sharing with `Assistant unavailable`; other bar controls still work.
State responses identify the current key. A mismatch with the mounted descriptor
invalidates its cached acknowledgement and requires a fresh session before share.

First resolve the tab and check its site permission through the existing
strict reader. A blocked, unreadable or unsupported page produces the existing
inline message and no notice or share. Otherwise, when no acknowledgement is
known, open an accessible modal dialog owned by the extension, outside the
harness frame. Its exact text is:

> Share this page with Augmentor?
>
> Augmentor runs outside ResonantOS approvals. Its own approvals cover its
> tools. Sharing sends this page's title and address to Augmentor. It does not
> give Augmentor permission to use ResonantOS tools or control this page.

Use the host label in every position. Buttons are `Cancel` and `Share page`.
Initial focus is on Cancel. Escape cancels. Trap focus while open and restore
focus to Page on close. Associate the heading and description using dialog
ARIA attributes. Cancel sends nothing and remembers nothing.

After Share page, re-resolve the tab and permission. If the tab ID or sanitized
URL differs from the candidate selected when opening the notice, send nothing and
announce `Page changed. Select Page again.` Do not remember that attempt.
If the permission is now blocked or unreadable, send nothing and retain the
existing denial message. Remember nothing. Do not use an earlier permission
snapshot. Also require the same mounted frame and recipient key as when the
dialog opened. A replacement cancels the attempt without remembering it.

For a valid confirmed attempt, call `sendContext` once immediately after the
final checks. Only `sendContext(message) === true` permits caching notice
version 1 for this key and starting its durable write. A false return or thrown
error shows `Assistant offline` and creates neither cache nor durable notice.
Cancellation, URL or tab change, permission failure and frame replacement also
create neither. A later valid attempt must show the notice again. Successful
local dispatch does not prove upstream receipt and is not a grant.
`Page shared` continues to mean local dispatch only.

Notice state is separate from recording consent. The dialog does not turn
recording on. Turning recording off, pruning records, or deleting event
history does not clear the notice acknowledgement. A deliberate future change
to the notice text requires increasing the notice version, not guessing from
a manifest version.

A notice-state read failure means unknown, so show the dialog. After confirmation,
the final checks and successful local dispatch, bound the acknowledgement write to
2 seconds. If saving fails, keep the acknowledgement only for this mounted
controller. It does not affect the share already dispatched. Show
`Notice preference could not be saved. It may
appear again.` A later mount asks again. Failure to log or remember a notice
must not block an explicitly confirmed, otherwise permitted share. On later
shares, complete any notice-state read before the final tab and permission
check. Do not await a log or notice write between that check and dispatch.

#### Bridge storage and retention

Add `browser-first/host/embed-governance-host-service.mjs`. It owns route
validation, notice state and persistence. Use a single bounded JSON document
for this small local log. This permits preference changes, deletion and log
appends to be atomic without a database, journal or multi-file transaction.

The sole durable file is
`<userRoot>/BrowserFirst/EmbedGovernance/state.json`. `userRoot` is the existing
launcher resolver: `RESONANTOS_BROWSER_FIRST_USER_ROOT`, or
`~/ResonantOS_User` by default. Never use the extension directory, a browser
storage API, a repository-relative path or the proxy profile as a file path.
Production storage must resolve outside the repository. The launcher's lexical
`path.resolve` check is insufficient. Before creating feature data, inspect
every existing component of the absolute configured root with `lstat`. Reject
a symlink in the root or any ancestor, even when its target is outside the repo.
Canonicalize the existing root with `realpath` and compare it with the
repository's `realpath` using a path-component containment check. Reject equality
or containment. For a missing root, first validate and canonicalize the nearest
existing ancestor, check the intended path, then create missing directories
without following links. Recheck with `lstat` and `realpath` before use.
Apply the same checks to `BrowserFirst`, `EmbedGovernance`, lock and temporary
paths. Use canonical paths in test fixtures, such as `/private/tmp` on macOS.
Recheck before reads and replacements; refuse path substitution. An unsafe root
disables this service without preventing bridge or embed startup.

```ts
type EmbedGovernanceState = {
  version: 1;
  recordingEnabled: boolean;
  writeEpoch: string;
  notices: Record<string, 1>;
  events: EmbedEventRecord[];
};
```

`writeEpoch` is a host-generated lowercase UUID v4. It is an append freshness
value, not a credential or grant. `notices` stores host-issued recipient keys.
Stored keys must match `^augmentor-v1-[0-9a-f]{64}$`, with value exactly 1.
Retain earlier recipient acknowledgements, but lookup only the current descriptor's
key. Notice writes must match that current key exactly. Missing state initializes
to recording off, a new epoch, an empty notice map and no events. Persist on
the first mutation. No event IDs, timestamps or request bodies enter notices.

Use UTF-8 JSON with a trailing newline. Require a private directory (`0700`)
and private regular file (`0600`), owned by the bridge user. Reject symlinks
and unsafe ownership or permissions in the service's directory and file.
Fix the configured root at startup. Route arguments never choose paths. Permit
only one writer process per user root. Acquire ownership by atomically creating
a private `writer.lock` directory and writing a private `owner.json` containing
only the bridge PID and a random ownership UUID. Reclaim a stale lock only when
its valid owner PID is absent, as shown by a local process-existence check that
returns `ESRCH`. Permission errors, malformed lock data and a still-live PID
mean unavailable. An interrupted lock creation needs operator cleanup, never
automatic takeover. On close, remove only a lock with this process's ownership
UUID. The lock directory and its owner file contain no event data. They are
coordination artifacts in addition to `state.json`.
PID reuse is a deliberate availability limit: an unrelated live process with
that PID also blocks takeover. Never kill it or infer that a lock is stale from
age. Operator cleanup must first establish that no bridge owns this user root.
Automatic PID-reuse recovery is deferred beyond this PoC.

Serialize all operations inside the owning service. Write a complete validated
snapshot to a private temporary file in the same directory, flush it, rename
it over `state.json`, and sync the directory before reporting durable success.
Remove abandoned temporary snapshots at startup before serving routes. Keep
no backup copies, exports, telemetry, raw request dumps or alternate event log.
Release the writer lock and stop the pruning timer on shutdown.

Keep at most 10,000 records and at most 10 MiB of serialized state. Each record
must be at most 1,024 UTF-8 bytes. After pruning, refuse a new append that would
exceed either bound. Preserve the existing records. Show `Activity recording
paused: local log is full` in Settings. It resumes after deletion or pruning
creates room. This is a capacity failure, not permission to retain less data
silently. The log is best effort and does not promise complete coverage.

The retention cutoff is 30 times 24 hours on the host wall clock. Remove every
record with `recordedAt <= now - 2_592_000_000` milliseconds. Prune on startup,
before every read and mutation, and every hour while the bridge runs, including
when recording or the embed experiment is off. Clock rollback can delay removal
of records that still exist. It never restores a removed record. This is not a
guarantee of exactly 30 elapsed days under clock changes or bridge downtime.
No process can prune while the bridge is stopped;
startup pruning runs before any retained record is returned.

If disk pruning fails, exclude expired records from every read anyway. Stop
recording until a durable rewrite succeeds and expose `Retention cleanup
failed` in Settings. Do not claim that expired bytes were removed. Retry the
cleanup on the next operation and hourly tick. No expired data is replayed.

Invalid JSON, unknown state versions, oversized state or invalid stored
records make the store unavailable. Do not copy the bad file into diagnostics
or silently rewrite its contents. Expose a fixed error and keep chat working.
The explicit Delete activity action can replace an invalid regular state file
with fresh disabled state. Unsafe paths remain an error, even for deletion.

#### Routes and authorization

Use `/embed-governance/*`, outside `/embed/*`. The existing proxy matcher
intercepts that latter namespace before normal route authentication. These
new routes must go through `bridge-server.mjs` and never through the cookie
proxy. No special exemption or new relay command is needed.

Every route requires the bridge token, the capability below and
`loopbackHostOnly: true`. Add `requiredOrigin: "extension"`,
`errorFamily: "embed-governance"` and `maxBodyBytes` route options for these
routes. In `authorizeBridgeRoute`, require exact string equality between the
single request Origin and the configured `extensionOrigin`. A missing configured
origin fails closed. Reject missing or duplicate Origin, the bridge page origin
and every other origin, even when an allowed-origin wildcard matches it.
Do not use `pickAllowedOrigin` for authorization. The bridge and embed service
must use the same configured extension origin or governance is unavailable.
Enforce the check before invoking a service. CORS headers alone
are not authorization. Use fixed public errors for this route family and
`Cache-Control: no-store` on every response. Do not return exception strings.

| Method and path | Capability | Exact input | Successful payload, in the existing `ok: true` envelope |
| --- | --- | --- | --- |
| `GET /embed-governance/state` | `addon-runtime-read` | No query or body | `{ recordingEnabled, writeEpoch, noticeKey, noticeVersion: 1, noticeAcknowledged, available, problem }` |
| `POST /embed-governance/recording` | `embed-governance-consent-write` | `{ enabled: boolean }` | `{ recordingEnabled, writeEpoch }` |
| `POST /embed-governance/notice` | `embed-governance-consent-write` | `{ noticeKey: string, version: 1 }` | `{ noticeKey, noticeAcknowledged: true }` |
| `POST /embed-governance/events` | `addon-record-write` | One `EmbedEventSubmission` | `{ recorded: boolean, reason }` |
| `GET /embed-governance/events` | `addon-record-read` | Optional `before` UUID v4 query only | `{ events, nextBefore }` |
| `POST /embed-governance/events/delete` | `addon-record-write` | `{}` only | `{ deleted: true, writeEpoch, recordingEnabled, noticeKey, noticeAcknowledged }` |

`noticeKey` is the current descriptor's key, or null when unavailable.
`noticeAcknowledged` refers only to that key at version 1. It is false for a
null key. This is an explicit single-active-recipient API. Generic multi-harness
selection is deferred. The notice map retains earlier keys without exposing it
as a new registry or selection API. Reject a mismatched notice write with 400
`invalid-request`; never apply it to the current recipient instead.

Read returns up to 100 records, newest first, in insertion order reversed.
`nextBefore` is the last returned event ID if older records remain, otherwise
null. `before` selects records strictly older in that order than the matching
record. If pruning or deletion removed the anchor, return HTTP 409 with code
`cursor-expired`; the UI clears its page and reloads from the start. No client
path, arbitrary filter or raw-file download is supported.

`available` means the embed service is currently enabled and can accept
observations. It does not mean the harness is online. Read and delete remain
available for old records even when the PoC is disabled. Notice writes and
enablement require an available descriptor. Disabling is always allowed with
valid storage. Appends while the PoC is unavailable are dropped.

`problem` is null or one of `storage-unavailable`, `retention-failed`, `log-full`.
For an unreadable store, state returns recording off, `writeEpoch: null`,
`noticeAcknowledged: false` and `problem: "storage-unavailable"`. It does not
pretend a saved preference has changed. Other unavailable reads or writes
return HTTP 503 with a fixed public message.

Validate unknown keys, JSON types and bounds before any mutation. The append
body limit is 2,048 UTF-8 bytes; other POST bodies are limited to 512 bytes.
Apply these limits during body reading, not after arbitrary buffering.
Pass `route.maxBodyBytes` into `readJsonBody`. Count raw byte lengths before
decoding or appending chunks. Stop accumulating at the first excess byte, return
413, and drain or close the request with a bounded timeout. Preserve this error
through the POST catch path; do not remap it to a generic 400. Other route
families keep their existing defaults. For these GET routes, reject nonzero
Content-Length or any Transfer-Encoding with 400 before the handler. The zero
body limit also rejects any actual body bytes with 400. Never ignore a GET body.
Unsupported methods, duplicate query keys and malformed URLs are rejected.
Malformed input returns 400; oversized input returns 413. Set `maxBodyBytes`
to the stated POST limit and to zero for GET, with the GET exception above.
Authorization keeps the bridge's 401 and 403 distinction. Error bodies contain
exactly `{ ok: false, code, error }`. `error` is the fixed message below, matching
the bridge client's existing field. Use these exact public errors:

| HTTP status | Code | Message |
| --- | --- | --- |
| 400 | `invalid-request` | `Invalid activity request.` |
| 401 | `unauthorized` | `Bridge authentication required.` |
| 403 | `forbidden` | `Activity access denied.` |
| 404 | `unknown-route` | `Activity route unavailable.` |
| 405 | `method-not-allowed` | `Activity method unavailable.` |
| 409 | `cursor-expired` | `Activity changed. Refresh the list.` |
| 413 | `request-too-large` | `Activity request too large.` |
| 503 | `storage-unavailable` | `Activity storage unavailable.` |

Add a method-independent path classifier before `compileRoutes` lookup in both
the HTTP handler and self-test evaluator, and use it in `authorizeBridgeRoute`.
The exact `/embed-governance` namespace and its slash-prefixed children belong
to this family. They never fall back to the generic or OpenCode serializers.
Within it, a known path with an unsupported method returns 405 and an unknown
path returns 404, after bridge-token, Host and exact-origin checks. Supported
routes also require their declared capability before body parsing or service
dispatch. Reject malformed namespace targets with fixed 400 responses.

Add explicit `embed-governance` branches to authorization's `refuse` helper and
`routeError`. Map auth failures, parser failures, service failures and the outer
HTTP catch to this table. Unknown exceptions become 503 `storage-unavailable`.
An IP allowlist refusal in this family uses the fixed 403 response too.
No exception message, rejected value or OpenCode error may escape these paths.
Keep the existing global `OPTIONS` 204 preflight. It runs no service, exposes no
activity data and grants no authorization. Include `Cache-Control: no-store`
on these preflight responses as well as all data and error responses.
The service has no network or process-launch
authority, and may access only its own storage directory.

For appends, `reason` is exactly null when recorded, otherwise `disabled`,
`unavailable`, `stale-epoch`, `duplicate` or `full`. These are successful HTTP
responses describing a dropped observation. Disk failures return 503 instead.
Reject an event ID already in retained history as `duplicate`.

Each actual recording toggle and each Delete activity operation rotates
`writeEpoch` in the same atomic snapshot. Setting an already equal boolean is
idempotent and does not rotate it. Check the epoch and current recording flag
inside the serialized append operation. An old in-flight append cannot restore
deleted records or cross an off/on boundary. New post-delete observations may
be recorded if recording remains enabled. Deletion preserves a valid recording
preference and notice map. Recovery from an invalid file resets both to defaults.

Add all six method/path pairs to the extension bridge capability map and route
audit fixtures. Add only `embed-governance-consent-write` to the canonical
`bridge-capability-tokens.mjs` mint map and the client's derived allowlist.
Its argument is `embed-governance-consent-token`; its environment name is
`RESONANTOS_BROWSER_FIRST_EMBED_GOVERNANCE_CONSENT_TOKEN`. Use the existing
authenticated bootstrap. An `addon-runtime-control` or `addon-record-write`
token alone cannot acknowledge a notice or enable recording. This is a bridge
transport capability for the trusted extension, not an SDK manifest capability
or a grant to the outside harness. It does not prove a human click by itself.
The trusted controller issues consent writes only from the explicit checkbox
action or a confirmed, successfully dispatched first share. A relay event,
mount, poll, grant or slot action must never issue those writes. Do not claim
protection from a compromised extension or a holder of its bootstrap credential.
The bar,
notice dialog and history renderer receive callbacks and safe data, never a
bridge config, token, ticket or upstream credential. The controller calls the
existing bridge client. No route accepts a harness-supplied approval as consent.

#### Read and delete UI

The same Settings > Privacy card includes `View activity`, `Refresh`,
`Load older` and `Delete activity`. View activity reads the first page on demand.
Render timestamp, harness label, self-governed tier and event description.
Tool rows show the tool name and `Error` or `No error reported`. Page rows show
only the domain. Use text nodes, never HTML or automatic links.

Above the list show:

> Local metadata only. Harness events are reports from the outside harness,
> not ResonantOS approval receipts. Recording can miss events while the side
> panel is closed or disconnected.

No records displays `No recorded activity`. A failed read displays `Activity
unavailable`, not an empty-success state. Pagination is explicit and does not
poll. Refresh reloads the newest page. After a deletion acknowledgement, render
its `recordingEnabled`, `writeEpoch`, `noticeKey` and `noticeAcknowledged` snapshot
and clear visible rows before showing success. Recovery must uncheck recording
and clear the card's notice state. Ignore any older in-flight read that could
overwrite this snapshot. The card does not rely on the side panel's polling.

Delete activity opens a confirmation: `Delete all recorded harness activity on
this computer? This keeps your recording choice and first-share notices.`
Buttons are `Cancel` and `Delete activity`. A failed deletion shows
`Activity could not be deleted` and keeps the current rows with an error state.
For an invalid store, use recovery copy: `Reset unreadable harness activity?
This turns recording off and clears remembered first-share notices.`
This route deletes only feature-owned data. It does not delete harness chats,
ResonantOS chats, security receipts or unrelated user files.

#### Failure isolation and security limits

The controller catches projection, state-read, queue, transport and persistence
failures independently of chat and sharing. Its methods never throw into the
relay handler or successful Page action. Show one polite inline notice per
failure episode: `Activity was not recorded`. Details in Settings use only
the fixed codes above. Do not console-log event payloads or exception values.

Site permission failures still block a share. Logging failures never do.
First-share confirmation is an intentional user step, not a logging prerequisite.
Switching views and opening Workspace remain possible during all log failures.

The harness cannot read, append or delete this log through its embed cookie.
Relayed metadata is untrusted even after source checks. It cannot change the
recording flag, notice state, tier, host identity, slot ownership, grants or
capability floor. The metadata log is not a signed governance receipt. Never
feed it into approval, grant, billing or trusted-memory decisions.

The host keeps upstream credentials in its existing custody. The existing
single-use tickets, cookie/origin checks and header stripping stay intact.
No credentials enter manifests, records, settings, the badge, the notice or
relay messages. Domain names and tool identifiers can still be sensitive, which
is why recording is off by default and the user can inspect and delete it.


## Findings

Read-only baseline: branch `testing/augmentor-embed-sidecar`; working tree initially clean. No branch switch, container launch, bridge launch, implementation, or commit is part of authoring this plan. The approved testing-branch exception controls this experiment; no merge into `dev` is authorized. `RTK.md` is absent in the worktree; the inherited `~/RTK.md` was read. The spec's new module paths do not exist yet.

| Fact resolved before task design | Repository evidence |
| --- | --- |
| The canonical manifest has no interfaces field; runtime adapter fields form an all-or-none union. | `src/core/contracts.ts:609`, `src/core/contracts.ts:622` |
| SDK manifests inherit core and version stays 0.1.0; compatibility files re-export the package. | `packages/addon-sdk/src/contracts.ts:24`, `packages/addon-sdk/src/contracts.ts:26`, `src/sdk/addons/validation.ts:7`, `src/sdk/addons/contracts.ts:7` |
| Validator accepts unknown top-level fields today; surfaces are checked before tools and runtime. Existing runtime validation can be reused to decide whether a reference is valid without recursive validation. | `packages/addon-sdk/src/validation.ts:308`, `packages/addon-sdk/src/validation.ts:341`, `packages/addon-sdk/src/validation.ts:671`, `packages/addon-sdk/src/validation.ts:1110` |
| Existing adapter validation checks adapterVersion, supported operations, auth and model-selection consistency. Tool dependencies are arrays of capability values. | `packages/addon-sdk/src/validation.ts:143`, `src/core/contracts.ts:300`, `src/core/contracts.ts:531` |
| Registry captures a structured clone of the whole validated manifest; no migration or picker is necessary to preserve interfaces. | `browser-first/host/harness-registry.mjs:199`, `browser-first/host/harness-registry.mjs:201` |
| Embed configuration is operator-only, defaults disabled, validates a loopback HTTP origin and profile, then privately reads the credential. | `browser-first/host/embed-host-service.mjs:12`, `browser-first/host/embed-host-service.mjs:45` |
| Status and session are addon-runtime-control routes. Session currently returns only hostPath. Proxy uses `/embed/` and `/embed-host/`, not `/embed-governance/`. | `browser-first/host/embed-host-service.mjs:33`, `browser-first/host/embed-host-service.mjs:87`, `browser-first/host/embed-host-service.mjs:254` |
| Host relay validates frame/source and origin and allows exactly four outbound commands; tunnel does not interpret events. | `browser-first/host/embed-host-service.mjs:171`, `browser-first/host/embed-host-service.mjs:182`, `browser-first/host/embed-host-service.mjs:218` |
| Extension relay validates exact contentWindow/origin but stores raw event.data in a 50-element history. send returns false while unavailable and bounds context at 16000 bytes. | `browser-first/resonantos-side-panel-extension/src/side-panel-entry.js:76`, `browser-first/resonantos-side-panel-extension/src/side-panel-entry.js:89` |
| Page uses the real active-tab resolver, strict permission reader, and existing sanitizers; success is exactly a true dispatch return. | `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js:11`, `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js:24`, `browser-first/resonantos-side-panel-extension/src/lib/site-permission-store.js:22` |
| Sanitized context is `message.context.page`; URL sanitizer removes credentials/query/fragment but preserves path. | `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-model.js:11`, `browser-first/resonantos-side-panel-extension/src/lib/chat-turn-controller.js:24` |
| Assistant selection persists only resonantos.agentView then reloads; it does not assign a slot. | `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js:40` |
| Bar has Workspace, Assistant, Page, Approvals, Status, a polite notice and callback-only actions. CSS already fixes 36px height with dark tokens. | `browser-first/resonantos-side-panel-extension/src/lib/embed-bar.js:3`, `browser-first/resonantos-side-panel-extension/src/styles/side-panel/base-layout.css:247` |
| Privacy is static; Settings already passes getBridgeRequest in its render context, so no new Settings store/composition API is needed. | `browser-first/resonantos-side-panel-extension/src/lib/settings/privacy-section.js:20`, `browser-first/resonantos-side-panel-extension/src/lib/main-workspace-settings.js:167`, `browser-first/resonantos-side-panel-extension/src/lib/main-workspace-settings.js:193` |
| Trace redaction's classic core owns all patterns and registers a frozen API; the ESM wrapper exports the same functions. Extraction must preserve classic registration behavior. | `browser-first/resonantos-side-panel-extension/src/lib/trace-redaction-core.js:5`, `browser-first/resonantos-side-panel-extension/src/lib/trace-redaction-core.js:19`, `browser-first/resonantos-side-panel-extension/src/lib/trace-redaction.js:2` |
| Transport serializer handles harness/OpenCode only. Route lookup is method-dependent. Harness origin checking permits absent Origin and wildcard CORS. | `browser-first/host/bridge-server.mjs:80`, `browser-first/host/bridge-server.mjs:114`, `browser-first/host/bridge-server.mjs:312`, `browser-first/host/bridge-server.mjs:1080` |
| Reader sets UTF-8 decoding before counting and has a hardcoded 1MiB boundary limit. GET-body check is harness-only; parser catch remaps owned failures. | `browser-first/host/bridge-server.mjs:438`, `browser-first/host/bridge-server.mjs:1344`, `browser-first/host/bridge-server.mjs:1357` |
| OPTIONS is global and early; the outer catch and IP rejection require explicit family handling. Self-test and HTTP both call authorization. | `browser-first/host/bridge-server.mjs:1237`, `browser-first/host/bridge-server.mjs:1309`, `browser-first/host/bridge-server.mjs:1314` |
| Consent capability does not exist; launcher mint specs are canonical and extension allowlist derives from method/path values. Client passes AbortSignal and preserves public error.code. | `browser-first/host/bridge-capability-tokens.mjs:23`, `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js:27`, `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js:142`, `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js:368`, `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js:407` |
| Launcher resolves userRoot lexically and uses a fixed extension origin; embed can use an operator override. New service must reject an origin mismatch. | `browser-first/host/run-bridge-minimal.mjs:68`, `browser-first/host/run-bridge-minimal.mjs:90`, `browser-first/host/run-bridge-minimal.mjs:410` |
| Existing registry store is not safe to reuse for this feature: lexical repository containment, separate watermark, no specified writer lock. | `browser-first/host/harness-registry-store.mjs:14` |
| Root launcher is a one-line static import; no extension preparation stage currently exists. Test runner discovers only browser-first/test/*.test.mjs. | `run-bridge-minimal.mjs:3`, `scripts/run-browser-first-extension-tests.mjs:11` |
| Route audit constructs each service array and checks launcher's spread names. It must construct the new array, not merely whitelist its name. | `browser-first/test/bridge-route-capability-audit.test.mjs:189`, `browser-first/test/bridge-route-capability-audit.test.mjs:262` |
| Existing frame tests require raw event fields and must change with the safe ring; lifecycle/control regressions stay intact. | `browser-first/test/side-panel-entry.test.mjs:107`, `browser-first/test/side-panel-entry.test.mjs:115` |
| Workspace loads its own settings stylesheet; side-panel dialog styling is not sufficient there. | `browser-first/resonantos-side-panel-extension/src/main-workspace.css:9`, `browser-first/resonantos-side-panel-extension/src/styles/main-workspace/settings.css:17` |
| Registry route returns slots directly in the projected snapshot, so live view switching compares `.slots` and first asserts it exists. | `browser-first/host/harness-host-service.mjs:208`, `browser-first/host/harness-host-service.mjs:272` |
| Live proof establishes status booleans and turn.finished only. It starts a disposable browser, assumes an already-running bridge, and is not discovered by node:test. | `browser-first/test/embed-live.mjs:2`, `browser-first/test/embed-live.mjs:78`, `browser-first/test/embed-live.mjs:103` |
| Ownership requires shared helpers in core and transport enforcement in bridge-server; composition must remain thin. | `docs/architecture/MODULE-OWNERSHIP.md:115`, `docs/architecture/MODULE-OWNERSHIP.md:175` |
| Shared TS changes require the full TS/Vitest build gates; node:test accepts .mjs fixtures importing the canonical .ts validator on the pinned Node version. | `.nvmrc:1`, `package.json:10`, `package.json:12`, `tsconfig.json:17`, `browser-first/host/harness-adapter-contract.mjs:1` |

The approved decisions, the complete design, its adjacent `embed-governance-design-review-1.md`, the bar design, ADR-018, ADR-026, ADR-031, all existing source files cited by the design, component READMEs, and the five-file contributor path were read. Review findings G1–G6 and D1–D10 are accepted constraints, not decisions to reconsider. **EMBED-UPSTREAM-1 remains a conductor-run dependency, not a code fact.**

## File Structure

Each row names one responsibility. Generated files are committed deterministic source artifacts, not credentials. Tests use canonical external temporary directories and clean only their own fixtures.

| Action and exact path | One responsibility |
| --- | --- |
| Modify `src/core/contracts.ts` | Optional interface types |
| Modify `packages/addon-sdk/src/contracts.ts` | SDK type exports |
| Modify `packages/addon-sdk/src/index.ts` | Public type exports |
| Modify `packages/addon-sdk/src/validation.ts` | Pure interface diagnostics |
| Create `browser-first/test/embed-interface-validation.test.mjs` | Manifest contract regression coverage |
| Create `src/core/trace-redaction-core.js` | Canonical pure redaction implementation and classic registration |
| Create `src/core/trace-redaction.js` | Canonical ESM redaction exports |
| Modify `browser-first/resonantos-side-panel-extension/src/lib/trace-redaction-core.js` | Generated classic redactor copy |
| Create `src/core/embed-governance-contract.js` | Closed metadata schema and public constants |
| Create `browser-first/resonantos-side-panel-extension/src/lib/generated/trace-redaction-core.js` | Generated redaction dependency |
| Create `browser-first/resonantos-side-panel-extension/src/lib/generated/trace-redaction.js` | Generated ESM adapter |
| Create `browser-first/resonantos-side-panel-extension/src/lib/generated/embed-governance-contract.js` | Generated metadata contract |
| Create `scripts/prepare-embed-governance.mjs` | Deterministic extension preparation/parity |
| Modify `scripts/run-browser-first-extension-tests.mjs` | Preparation before extension test discovery |
| Modify `run-bridge-minimal.mjs` | Preparation before bridge startup |
| Create `browser-first/test/embed-governance-contract.test.mjs` | Metadata privacy and packaging coverage |
| Modify `browser-first/host/embed-host-service.mjs` | Host-owned recipient descriptor |
| Create `browser-first/test/embed-descriptor.test.mjs` | Origin-bound descriptor coverage |
| Modify `browser-first/test/embed-host-service.test.mjs` | Existing status projection compatibility |
| Create `browser-first/host/embed-governance-storage.mjs` | Private path, lock and atomic snapshot boundary |
| Create `browser-first/test/embed-governance-storage.test.mjs` | Filesystem boundary coverage |
| Create `browser-first/host/embed-governance-host-service.mjs` | Serialized consent, retention and route policy |
| Create `browser-first/test/embed-governance-host-service.test.mjs` | Durable state lifecycle coverage |
| Modify `browser-first/host/bridge-server.mjs` | Governance transport enforcement |
| Modify `browser-first/host/bridge-capability-tokens.mjs` | Consent token mint specification |
| Modify `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js` | Six method/path capability mappings |
| Modify `browser-first/host/run-bridge-minimal.mjs` | Governance service lifecycle wiring |
| Modify `browser-first/test/bridge-route-capability-audit.test.mjs` | Constructed route/capability parity |
| Create `browser-first/test/embed-governance-transport.test.mjs` | Real HTTP authorization and body-bound tests |
| Create `browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js` | Safe relay observations and bounded delivery |
| Create `browser-first/test/embed-governance-controller.test.mjs` | Relay, queue and consent-cache coverage |
| Create `browser-first/resonantos-side-panel-extension/src/lib/embed-governance-dialog.js` | Accessible confirmation dialog |
| Modify `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js` | Revalidated successful-dispatch-only sharing |
| Modify `browser-first/test/embed-bar-actions.test.mjs` | Existing permission regression with required consent callback |
| Create `browser-first/test/embed-first-share.test.mjs` | First-share races and dialog coverage |
| Modify `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-model.js` | Safe descriptor presentation |
| Modify `browser-first/resonantos-side-panel-extension/src/lib/embed-bar.js` | Tier badge and accessible status presentation |
| Modify `browser-first/resonantos-side-panel-extension/src/styles/side-panel/base-layout.css` | One-row badge and dialog styling |
| Modify `browser-first/resonantos-side-panel-extension/src/side-panel-entry.js` | Controller/frame composition |
| Modify `browser-first/test/embed-bar.test.mjs` | Tier presentation regression coverage |
| Create `browser-first/test/embed-governance-composition.test.mjs` | Source/origin, no raw history and safe composition |
| Modify `browser-first/test/side-panel-entry.test.mjs` | Existing frame lifecycle with metadata-only history |
| Modify `browser-first/resonantos-side-panel-extension/src/styles/main-workspace/settings.css` | Workspace confirmation dialog styling |
| Modify `browser-first/resonantos-side-panel-extension/src/lib/settings/privacy-section.js` | Consent and paged activity UI |
| Create `browser-first/test/embed-governance-privacy.test.mjs` | Privacy acknowledgement and stale-read coverage |
| Modify `browser-first/test/embed-live.mjs` | Conductor-only recipient and integrated browser proof |
| Create `browser-first/test/embed-live-contract.test.mjs` | Live-proof script contract and syntax coverage |
| Modify `docs/architecture/MODULE-OWNERSHIP.md` | Ownership contract updated with each module task |
| Modify `browser-first/README.md` | Operator-facing feature behavior and proof limits |
| Create `browser-first/test/embed-governance-acceptance.test.mjs` | Final feature composition/documentation acceptance |

## Execution rules

All shell commands below run from `.resonant-rig/worktrees/poc-augembed`. Commit commands are instructions for later implementation only. Before each commit run `git diff --check`; stage only the enumerated files. Never stage generated bridge config, evidence or user roots. Existing tests remain; additions below are complete code unless explicitly described as a whole-file replacement. No task changes SDK capabilities, slots, grants, DSH, or harness lifecycle.

For each security guard, the named failing-test step is its required fail-before-fix red evidence: run it against the pre-task code, retain its nonzero result outside Git, then run the same assertion after the fix. A missing-module failure establishes only introduction, not guard sensitivity. Where a guard is new, execute the task's executable `rig-mutate` matrix after green and inspect the named behavioral assertion. The wrapper snapshots and restores only the guarded file, then verifies byte identity. A syntax/import failure is not acceptable red evidence. All filesystem mutation fixtures use a synthetic repository beneath their own external temporary root, so removing containment cannot write into the real repository. Do not count import failures as mutation kills. Do not commit a mutation.

### Task 1: Optional manifest interfaces and exact diagnostics

**Files:**
- Modify: `src/core/contracts.ts`, `packages/addon-sdk/src/contracts.ts`, `packages/addon-sdk/src/index.ts`, `packages/addon-sdk/src/validation.ts`, `docs/architecture/MODULE-OWNERSHIP.md`
- Create/Test: `browser-first/test/embed-interface-validation.test.mjs`

**Interfaces:**
- Consumes: `validateAddOnManifest(candidate: unknown, options?: { source?: AddOnManifestSource }): AddOnManifestValidationResult`; `ADDON_CAPABILITIES: readonly Capability[]`.
- Produces: `AddOnInterfaceMode`, `AddOnInterfaceGovernance`, `AddOnInterface`, `AddOnManifest.interfaces?: AddOnInterface[]`; private `validateInterfaces(issues: AddOnValidationIssue[], candidate: Record<string, unknown>): void`.

- [ ] Write the failing test (complete new file):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAddOnManifest } from '../../packages/addon-sdk/src/validation.ts';
const design = readFileSync(new URL('../../docs/planning/embed-governance-design.md', import.meta.url), 'utf8');
const examples = [...design.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
const fresh = () => structuredClone(examples[0]);
const issues = m => validateAddOnManifest(m).issues.filter(i => i.path.startsWith('interfaces'));
function rejects(edit, code, path) {
  const m = fresh(); edit(m);
  assert.ok(issues(m).some(i => i.code === code && i.path === path && i.severity === 'error'), code);
}
test('complete examples, both tiers, dual interfaces, and unchanged legacy diagnostics', () => {
  assert.equal(examples.length, 2);
  for (const example of examples) {
    const before = structuredClone(example);
    assert.equal(validateAddOnManifest(example).valid, true);
    assert.deepEqual(example, before);
    example.interfaces[0].governance = 'governed';
    assert.equal(validateAddOnManifest(example).valid, true);
  }
  const dual = fresh(), adapter = structuredClone(examples[1]);
  dual.tools = adapter.tools; dual.agentRuntime = adapter.agentRuntime;
  dual.requestedCapabilities.push(...adapter.requestedCapabilities);
  dual.interfaces.push(...adapter.interfaces);
  assert.equal(validateAddOnManifest(dual).valid, true);
  const legacy = fresh(); delete legacy.interfaces;
  const old = validateAddOnManifest(legacy);
  for (const value of [undefined, []]) {
    legacy.interfaces = value; assert.deepEqual(validateAddOnManifest(legacy), old);
  }
  legacy.name = null;
  const badOld = validateAddOnManifest(legacy);
  delete legacy.interfaces;
  assert.deepEqual(validateAddOnManifest(legacy), badOld);
});
test('closed entries, exact lexical bounds, explicit tiers and reserved modes', () => {
  for (const v of [null, {}, 'x', Array(17).fill({})]) rejects(m => m.interfaces = v, 'interfaces-array', 'interfaces');
  for (const v of [null, [], new Date(), 'x']) rejects(m => m.interfaces = [v], 'interface-object', 'interfaces[0]');
  for (const key of ['endpoint', 'credentials', 'default', 'command']) rejects(m => m.interfaces[0][key] = 'PRIVATE', 'interface-field', `interfaces[0].${key}`);
  for (const id of ['', 'Upper', ' x', 'x ', 'a'.repeat(65)]) rejects(m => m.interfaces[0].id = id, 'interface-id', 'interfaces[0].id');
  rejects(m => m.interfaces.push(structuredClone(m.interfaces[0])), 'duplicate-interface-id', 'interfaces[1].id');
  for (const label of ['', ' x', 'x ', '\0x', 'x\x7f', '😀'.repeat(81)]) rejects(m => m.interfaces[0].label = label, 'interface-label', 'interfaces[0].label');
  for (const mode of ['web', 'terminal', '', null]) rejects(m => m.interfaces[0].mode = mode, 'interface-mode', 'interfaces[0].mode');
  for (const tier of [undefined, null, 'trusted']) rejects(m => m.interfaces[0].governance = tier, 'interface-governance', 'interfaces[0].governance');
  const m = fresh(); m.interfaces[0].label = '😀'.repeat(80); m.interfaces[0].id = 'a'.repeat(64);
  assert.deepEqual(issues(m), []);
});
test('references and both capability subset directions', () => {
  rejects(m => m.interfaces[0].requiredCapabilities = null, 'interface-capabilities', 'interfaces[0].requiredCapabilities');
  rejects(m => m.interfaces[0].requiredCapabilities = ['ui-embedding', 'ui-embedding'], 'interface-capabilities', 'interfaces[0].requiredCapabilities[1]');
  rejects(m => m.interfaces[0].requiredCapabilities = ['private'], 'interface-capabilities', 'interfaces[0].requiredCapabilities[0]');
  rejects(m => m.interfaces[0].requiredCapabilities.push('network'), 'interface-unrequested-capability', 'interfaces[0].requiredCapabilities[1]');
  rejects(m => m.interfaces[0].requiredCapabilities = [], 'interface-missing-capability', 'interfaces[0].requiredCapabilities');
  rejects(m => m.interfaces[0].surfaceId = 'missing', 'interface-surface-reference', 'interfaces[0].surfaceId');
  rejects(m => m.surfaces[0].type = 'panel', 'interface-surface-reference', 'interfaces[0].surfaceId');
  rejects(m => m.interfaces[0].agentRuntimeRef = 'agentRuntime', 'interface-surface-reference', 'interfaces[0].agentRuntimeRef');
  for (const source of ['navigation', 'workspace']) {
    const m = fresh();
    m.requestedCapabilities.push({ capability: 'network', granted: false, scope: 'self', revocationBehavior: 'hard-stop' });
    if (source === 'navigation') m.surfaces[0].shellNavigation = { sectionId: 'test', dockIcon: 'browser', eyebrow: 'Test', requiredCapabilities: ['network'] };
    else m.embeddedWorkspace = { surfaceId: 'augmentor-panel', mode: 'hosted-dashboard', autoStart: false, settingsVisibility: 'visible', requiredCapabilities: ['network'] };
    assert.ok(issues(m).some(i => i.code === 'interface-missing-capability'));
    m.interfaces[0].requiredCapabilities.push('network'); assert.deepEqual(issues(m), []);
  }
  for (const dependency of ['runtime', 'invoke', 'selection', 'change']) {
    const m = structuredClone(examples[1]);
    m.requestedCapabilities.push({ capability: 'network', granted: false, scope: 'self', revocationBehavior: 'hard-stop' });
    if (dependency === 'runtime') m.agentRuntime.requiredCapabilities.push('network');
    if (dependency === 'invoke') m.tools[0].requiredCapabilities.push('network');
    if (['selection', 'change'].includes(dependency)) {
      m.agentRuntime.supportsModelSelection = true; m.agentRuntime.supportedOperations.push('selectModel');
      m.agentRuntime.modelSelection = { source: 'runtime-audit', currentModelField: 'model', selectable: true, requiredCapabilities: dependency === 'selection' ? ['network'] : [] };
      if (dependency === 'change') {
        m.tools.push({ ...structuredClone(m.tools[0]), name: 'example.model', requiredCapabilities: ['network'] });
        m.agentRuntime.modelSelection.changeTool = 'example.model';
      }
    }
    assert.ok(issues(m).some(i => i.code === 'interface-missing-capability'));
    m.interfaces[0].requiredCapabilities.push('network'); assert.deepEqual(issues(m), []);
  }
  const legacy = structuredClone(examples[1]);
  for (const k of ['adapterVersion','adapterId','authScheme','supportedOperations','contextRoleFidelity','toolCallbacks']) delete legacy.agentRuntime[k];
  assert.ok(issues(legacy).some(i => i.code === 'interface-runtime-reference'));
  delete legacy.interfaces; assert.equal(validateAddOnManifest(legacy).valid, true);
});
```

- [ ] Run `node --test browser-first/test/embed-interface-validation.test.mjs`. Expect assertion failures for `interfaces-array` and missing-capability cases; retain this fail-before-fix evidence.
- [ ] Implement the types before `AddOnManifest`, add `interfaces?: AddOnInterface[];` inside it, and append the type export to both SDK export files:

```ts
export type AddOnInterfaceMode = "adapter-chat" | "embed";
export type AddOnInterfaceGovernance = "governed" | "self-governed";
type AddOnInterfaceBase = {
  id: string;
  label: string;
  governance: AddOnInterfaceGovernance;
  requiredCapabilities: Capability[];
};
export type AddOnInterface = AddOnInterfaceBase & (
  | { mode: "adapter-chat"; agentRuntimeRef: "agentRuntime"; surfaceId?: never }
  | { mode: "embed"; surfaceId: string; agentRuntimeRef?: never }
);
```

```ts
export type { AddOnInterface, AddOnInterfaceMode, AddOnInterfaceGovernance } from "../../../src/core/contracts";
```

Insert this private validator before `validateAddOnManifest`, and call `validateInterfaces(issues, candidate);` immediately before the `if (Array.isArray(candidate.smokeTests))` block:

```ts
const validateInterfaces = (issues: AddOnValidationIssue[], candidate: Record<string, unknown>): void => {
  if (candidate.interfaces === undefined) return;
  const add = (code: string, path: string, message: string) => pushIssue(issues, "error", code, path, message);
  const entries = candidate.interfaces;
  if (!Array.isArray(entries) || entries.length > 16) {
    add("interfaces-array", "interfaces", "Interfaces must be an array of at most 16 entries."); return;
  }
  const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : [];
  const caps = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const requested = new Set(records(candidate.requestedCapabilities).map(v => v.capability));
  const seen = new Set<string>();
  entries.forEach((entry: unknown, index: number) => {
    const p = `interfaces[${index}]`;
    if (!isRecord(entry) || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) {
      add("interface-object", p, "Interface must be a plain JSON object."); return;
    }
    const allowed = ["id", "label", "mode", "governance", "requiredCapabilities",
      ...(entry.mode === "embed" ? ["surfaceId"] : entry.mode === "adapter-chat" ? ["agentRuntimeRef"] : [])];
    for (const key of Object.keys(entry)) if (!allowed.includes(key)) add("interface-field", `${p}.${key}`, "Interface field is not allowed.");
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id)) add("interface-id", `${p}.id`, "Interface ID must be a bounded stable name.");
    else {
      if (seen.has(entry.id)) add("duplicate-interface-id", `${p}.id`, "Interface IDs must be unique.");
      seen.add(entry.id);
    }
    if (typeof entry.label !== "string" || [...entry.label].length < 1 || [...entry.label].length > 80 ||
        /[\x00-\x1f\x7f]/.test(entry.label) || entry.label.trim() !== entry.label) add("interface-label", `${p}.label`, "Interface label must be bounded text without controls or surrounding whitespace.");
    if (!["adapter-chat", "embed"].includes(entry.mode as string)) add("interface-mode", `${p}.mode`, "Interface mode is not supported.");
    if (!["governed", "self-governed"].includes(entry.governance as string)) add("interface-governance", `${p}.governance`, "Interface governance must be explicit.");
    const requirements = new Set<unknown>();
    if (!Array.isArray(entry.requiredCapabilities)) add("interface-capabilities", `${p}.requiredCapabilities`, "Interface capabilities must be an array.");
    else entry.requiredCapabilities.forEach((capability: unknown, i: number) => {
      const q = `${p}.requiredCapabilities[${i}]`;
      if (!ADDON_CAPABILITIES.includes(capability as Capability) || requirements.has(capability)) add("interface-capabilities", q, "Interface capabilities must be unique supported values.");
      else if (!requested.has(capability)) add("interface-unrequested-capability", q, "Interface capability must be requested by the manifest.");
      requirements.add(capability);
    });
    const dependencies: unknown[] = [];
    if (entry.mode === "embed") {
      const matches = records(candidate.surfaces).filter(s => s.id === entry.surfaceId);
      if (typeof entry.surfaceId !== "string" || matches.length !== 1 || matches[0].type !== "embedded-pane") add("interface-surface-reference", `${p}.surfaceId`, "Embed must reference exactly one embedded-pane surface.");
      if (Object.hasOwn(entry, "agentRuntimeRef")) add("interface-surface-reference", `${p}.agentRuntimeRef`, "Embed cannot reference an agent runtime.");
      dependencies.push("ui-embedding");
      const nav = matches.length === 1 && isRecord(matches[0].shellNavigation) ? matches[0].shellNavigation : null;
      dependencies.push(...caps(nav?.requiredCapabilities));
      if (isRecord(candidate.embeddedWorkspace) && candidate.embeddedWorkspace.surfaceId === entry.surfaceId) dependencies.push(...caps(candidate.embeddedWorkspace.requiredCapabilities));
    }
    if (entry.mode === "adapter-chat") {
      const runtime = isRecord(candidate.agentRuntime) ? candidate.agentRuntime : null;
      const runtimeErrors = issues.some(i => i.severity === "error" && (i.path === "agentRuntime" || i.path.startsWith("agentRuntime.")));
      if (entry.agentRuntimeRef !== "agentRuntime" || !runtime || runtime.adapterVersion !== 1 || runtimeErrors) add("interface-runtime-reference", `${p}.agentRuntimeRef`, "Adapter chat requires a valid version 1 agent runtime.");
      if (Object.hasOwn(entry, "surfaceId")) add("interface-runtime-reference", `${p}.surfaceId`, "Adapter chat cannot reference a surface.");
      dependencies.push("agent-runtime", ...caps(runtime?.requiredCapabilities));
      const tools = records(candidate.tools);
      const invocation = tools.find(t => t.name === runtime?.invocationTool);
      dependencies.push(...caps(invocation?.requiredCapabilities));
      if (runtime?.supportsModelSelection === true && isRecord(runtime.modelSelection)) {
        dependencies.push(...caps(runtime.modelSelection.requiredCapabilities));
        const change = tools.find(t => t.name === (runtime.modelSelection as Record<string, unknown>).changeTool);
        dependencies.push(...caps(change?.requiredCapabilities));
      }
    }
    if (dependencies.some(c => !requirements.has(c))) add("interface-missing-capability", `${p}.requiredCapabilities`, "Interface must include every referenced dependency capability.");
  });
};
```

Append this ownership row to the Shared Source Ownership table:

```markdown
| `src/core/contracts.ts`, `packages/addon-sdk/src/contracts.ts`, `packages/addon-sdk/src/index.ts`, `packages/addon-sdk/src/validation.ts` | Declarative interface types, exports and pure validation | No runtime grants, tier verification, launches or slot mutation |
```

- [ ] Run `node --test browser-first/test/embed-interface-validation.test.mjs` and `npm test -- --run src/sdk/addons/validation.test.ts src/sdk/addons/registry.test.ts`. Expect all pass. Security red evidence is the pre-fix behavioral rejection failures; legacy fixtures must stay green. Run `npm run build` for type exports.
- [ ] Commit:

```bash
git diff --check
git add src/core/contracts.ts packages/addon-sdk/src/contracts.ts packages/addon-sdk/src/index.ts packages/addon-sdk/src/validation.ts browser-first/test/embed-interface-validation.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(sdk): validate optional harness interfaces"
```

### Task 2: Shared metadata contract and deterministic extension packaging

**Files:**
- Create: `src/core/trace-redaction-core.js`, `src/core/trace-redaction.js`, `src/core/embed-governance-contract.js`, `scripts/prepare-embed-governance.mjs`, `browser-first/resonantos-side-panel-extension/src/lib/generated/trace-redaction-core.js`, `browser-first/resonantos-side-panel-extension/src/lib/generated/trace-redaction.js`, `browser-first/resonantos-side-panel-extension/src/lib/generated/embed-governance-contract.js`
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/trace-redaction-core.js`, `run-bridge-minimal.mjs`, `scripts/run-browser-first-extension-tests.mjs`, `docs/architecture/MODULE-OWNERSHIP.md`
- Create/Test: `browser-first/test/embed-governance-contract.test.mjs`

**Interfaces:**
- Consumes: `redactTraceText(value:unknown, options?:{replacement?:string, tokenReplacement?:string}): string` from the existing trace implementation.
- Produces: `metadata(value:unknown): EmbedMetadata | null`, `domainFromUrl(url:string): string | null`, `validDomain(value:unknown): boolean`, `validDescriptor(value:unknown): boolean`, `exact(value:unknown, keys:string[]): boolean`, `UUID`, `NOTICE_KEY`, `LIMITS`, `ERRORS`, `activityError(code:string): Error & {code:string}`, `publicActivityError(error:unknown): {status:number, payload:{ok:false,code:string,error:string}}`, `prepareEmbedGovernance({ check?: boolean }): Promise<void>`.

- [ ] Write the failing test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { metadata, domainFromUrl, validDomain, validDescriptor, publicActivityError } from '../../src/core/embed-governance-contract.js';
import { prepareEmbedGovernance } from '../../scripts/prepare-embed-governance.mjs';
test('closed metadata excludes content and uses strict tool names and booleans', () => {
  for (const kind of ['conversation-changed','reply-started','reply-finished']) {
    assert.deepEqual(metadata({kind}), {kind});
    for (const key of ['prompt','response','arguments','result','token','error','title','url','conversationId']) assert.equal(metadata({kind, [key]:'CANARY'}), null);
  }
  for (const toolName of ['read.page','read_page','Tool:read-1']) assert.deepEqual(metadata({kind:'tool-finished',toolName,error:false}), {kind:'tool-finished',toolName,error:false});
  for (const toolName of ['', 'a b', 'a'.repeat(65), 'sk_live_abcdefghijk', 'a'.repeat(40)]) assert.equal(metadata({kind:'tool-finished',toolName,error:false}), null);
  for (const error of [0,1,'false',null,undefined]) assert.equal(metadata({kind:'tool-finished',toolName:'read',error}), null);
  assert.equal(metadata({kind:'tool-finished',toolName:'read',error:false,result:'CANARY'}), null);
  assert.deepEqual(publicActivityError(Error('CANARY')), {status:503,payload:{ok:false,code:'storage-unavailable',error:'Activity storage unavailable.'}});
});
test('domain normalization is host-only and canonical', () => {
  for (const [url,domain] of [['https://Sub.Example.COM./p?q=1#x','sub.example.com'],['http://bücher.example/x','xn--bcher-kva.example'],['http://127.0.0.1:80/x','127.0.0.1'],['http://[::1]:88/x','[::1]'],['http://[2001:0DB8::1]:8080/x','[2001:db8::1]'],['http://localhost:9/x','localhost']]) {
    assert.equal(domainFromUrl(url),domain); assert.equal(validDomain(domain),true);
  }
  for (const domain of ['::1','[::1]:88','[2001:0db8::1]','x:80','user@x','x/p','x?q','x#f',' x','EXAMPLE.com','x.','','a'.repeat(254)]) assert.equal(validDomain(domain),false);
  assert.equal(domainFromUrl('file:///private/x'),null);
});
test('descriptor is a closed fixed host contract', () => {
  const d={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:'augmentor-v1-'+ 'a'.repeat(64)};
  assert.equal(validDescriptor(d),true);
  for (const [k,v] of [['governance','governed'],['label','Other'],['token','CANARY'],['noticeKey','bad']]) assert.equal(validDescriptor({...d,[k]:v}),false);
});
test('generated source is byte-identical and never independently authored', async () => {
  await prepareEmbedGovernance({check:true});
  for (const name of ['trace-redaction-core.js','trace-redaction.js','embed-governance-contract.js']) {
    assert.deepEqual(await readFile(new URL('../../src/core/'+name,import.meta.url)),await readFile(new URL('../resonantos-side-panel-extension/src/lib/generated/'+name,import.meta.url)));
  }
});
```

- [ ] Run `node --test browser-first/test/embed-governance-contract.test.mjs`. Expect `ERR_MODULE_NOT_FOUND`. Guard sensitivity is separately tested below.
- [ ] Copy the existing redactor without changing a byte; this is the complete extraction/preparation edit command:

```bash
python3 - <<'PY'
from pathlib import Path
root=Path('browser-first/resonantos-side-panel-extension/src/lib')
Path('src/core/trace-redaction-core.js').write_bytes((root/'trace-redaction-core.js').read_bytes())
Path('src/core/trace-redaction.js').write_bytes((root/'trace-redaction.js').read_bytes())
p=Path('run-bridge-minimal.mjs')
p.write_text('#!/usr/bin/env node\nimport { prepareEmbedGovernance } from "./scripts/prepare-embed-governance.mjs";\nawait prepareEmbedGovernance();\nawait import("./browser-first/host/run-bridge-minimal.mjs");\n')
p=Path('scripts/run-browser-first-extension-tests.mjs')
s=p.read_text(); anchor='const files = (await readdir(testRoot))'
assert anchor in s
s=s.replace(anchor,'await prepareEmbedGovernance();\n\n'+anchor,1)
s=s.replace('import { readdir }','import { prepareEmbedGovernance } from "./prepare-embed-governance.mjs";\n\nimport { readdir }',1)
p.write_text(s)
PY
```

Create the complete canonical contract:

```js
import { redactTraceText } from './trace-redaction.js';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const NOTICE_KEY = /^augmentor-v1-[0-9a-f]{64}$/;
export const LIMITS = Object.freeze({ retention:2592000000, prune:3600000, records:10000, state:10*1024*1024, record:1024, page:100, queue:32, timeout:2000, poll:5000, history:50 });
export const ERRORS = Object.freeze({
  'invalid-request':[400,'Invalid activity request.'], unauthorized:[401,'Bridge authentication required.'], forbidden:[403,'Activity access denied.'],
  'unknown-route':[404,'Activity route unavailable.'], 'method-not-allowed':[405,'Activity method unavailable.'],
  'cursor-expired':[409,'Activity changed. Refresh the list.'], 'request-too-large':[413,'Activity request too large.'],
  'storage-unavailable':[503,'Activity storage unavailable.']
});
export function activityError(code) { const e=new Error('Activity request failed.'); e.code=Object.hasOwn(ERRORS,code)?code:'storage-unavailable'; return e; }
export function publicActivityError(error) {
  const code=Object.hasOwn(ERRORS,error?.code)?error.code:'storage-unavailable';
  return {status:ERRORS[code][0],payload:{ok:false,code,error:ERRORS[code][1]}};
}
export function exact(value, keys) {
  if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors=Object.getOwnPropertyDescriptors(value), names=Object.keys(descriptors);
  return names.length===keys.length && keys.every(k => Object.hasOwn(descriptors,k) && Object.hasOwn(descriptors[k],'value') && descriptors[k].enumerable);
}
export function validDescriptor(d) {
  return exact(d,['harnessId','interfaceId','label','governance','noticeKey']) && d.harnessId==='addon.augmentor-embed' && d.interfaceId==='panel' && d.label==='Augmentor' && d.governance==='self-governed' && typeof d.noticeKey==='string' && NOTICE_KEY.test(d.noticeKey);
}
function bracketHostname(hostname) {
  return hostname.includes(':')&&!hostname.startsWith('[')?`[${hostname}]`:hostname;
}
export function validDomain(value) {
  if (typeof value!=='string' || !/^[\x21-\x7e]{1,253}$/.test(value) || /[@/?#\\]/.test(value) || value.endsWith('.') || value!==value.toLowerCase()) return false;
  try { const u=new URL(`http://${value}/`); return !u.username && !u.password && !u.port && bracketHostname(u.hostname)===value && u.pathname==='/'; } catch { return false; }
}
export function domainFromUrl(value) {
  try { const u=new URL(value); if (!['http:','https:'].includes(u.protocol)) return null;
    const d=bracketHostname(u.hostname).toLowerCase().replace(/\.$/,''); return validDomain(d)?d:null;
  } catch { return null; }
}
export function metadata(value) {
  try {
    if (exact(value,['kind']) && ['conversation-changed','reply-started','reply-finished'].includes(value.kind)) return {kind:value.kind};
    if (exact(value,['kind','toolName','error']) && value.kind==='tool-finished' && typeof value.toolName==='string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value.toolName) && typeof value.error==='boolean' && redactTraceText(value.toolName)===value.toolName) return {kind:'tool-finished',toolName:value.toolName,error:value.error};
    if (exact(value,['kind','domain']) && value.kind==='page-shared' && validDomain(value.domain)) return {kind:'page-shared',domain:value.domain};
  } catch { return null; }
  return null;
}
```

Create the complete generator:

```js
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root=new URL('../',import.meta.url);
export async function prepareEmbedGovernance({check=false}={}) {
  const pairs=['trace-redaction-core.js','trace-redaction.js','embed-governance-contract.js'].map(name=>['src/core/'+name,'browser-first/resonantos-side-panel-extension/src/lib/generated/'+name]);
  pairs.push(['src/core/trace-redaction-core.js','browser-first/resonantos-side-panel-extension/src/lib/trace-redaction-core.js']);
  for (const [source,target] of pairs) {
    const bytes=await readFile(new URL(source,root));
    if (check) {
      if (!bytes.equals(await readFile(new URL(target,root)))) throw new Error('Generated governance source differs.');
    } else {
      await mkdir(new URL('.',new URL(target,root)),{recursive:true});
      await writeFile(new URL(target,root),bytes);
    }
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await prepareEmbedGovernance({check:process.argv.includes('--check')});
```

Replace the old redaction ownership row and append two Shared Source rows:

```markdown
| `browser-first/resonantos-side-panel-extension/src/lib/trace-redaction-core.js` and `trace-redaction.js` | Generated classic redaction policy and stable ESM adapter | Canonical core redaction source and caller values | Detached sanitized values and versioned realm-local registration | Independent secret patterns, storage writes or credential custody |
| `src/core/trace-redaction-core.js`, `src/core/trace-redaction.js`, `src/core/embed-governance-contract.js` | Pure shared redaction and closed embed metadata contracts | No raw event persistence, Chrome, filesystem, network or credentials |
| `scripts/prepare-embed-governance.mjs` and `browser-first/resonantos-side-panel-extension/src/lib/generated/` | Deterministic extension copies and byte-parity validation | Generated source only; never credentials or independent validators |
```

- [ ] Run `node scripts/prepare-embed-governance.mjs`, then `node --test browser-first/test/embed-governance-contract.test.mjs browser-first/test/trace-redaction.test.mjs browser-first/test/trace-redaction-packaging.test.mjs`. Expect pass.
- [ ] Red evidence: temporarily replace `names.length===keys.length &&` with an empty string in canonical `exact`, regenerate, run the same metadata test and require the extra-content assertion to fail. Restore the clause. Temporarily remove `&& redactTraceText(value.toolName)===value.toolName`; require the secret-name assertion to fail. Restore it. Temporarily return true at the start of `validDomain`; require the domain-only rejection test to fail. Restore, regenerate and rerun the command above. Temporarily append one newline to a generated copy; `node scripts/prepare-embed-governance.mjs --check` must fail; regenerate and check green. Run the executable mutation matrix below; it restores only the guarded file and regenerates deterministic copies afterward.
- [ ] Run this exact guard-mutation matrix after green. Each `rig-mutate` invocation must return zero (behavioral failure under mutation and byte-identical restoration). Inspect any failure; import or syntax errors are not guard evidence. The strings below are exact edits, not patterns.

```bash
python3 - <<'PYMUTATE'
from pathlib import Path
import shlex, subprocess
rig=str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate')
mutations=[('src/core/embed-governance-contract.js', [('names.length===keys.length &&', '')]), ('src/core/embed-governance-contract.js', [('&& redactTraceText(value.toolName)===value.toolName', '')]), ('src/core/embed-governance-contract.js', [("typeof value.error==='boolean'", 'true')]), ('src/core/embed-governance-contract.js', [('/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value.toolName)', 'true')]), ('src/core/embed-governance-contract.js', [('export function validDomain(value) {', 'export function validDomain(value) { return true;')]), ('src/core/embed-governance-contract.js', [("d.governance==='self-governed'", 'true')]), ('src/core/embed-governance-contract.js', [('error:ERRORS[code][1]', 'error:error.message')])]
test_command='node scripts/prepare-embed-governance.mjs && node --test browser-first/test/embed-governance-contract.test.mjs'
for filename,changes in mutations:
    edit='from pathlib import Path\np=Path('+repr(filename)+')\ns=p.read_text()\n'
    for before,after in changes:
        edit+='assert '+repr(before)+' in s\ns=s.replace('+repr(before)+','+repr(after)+',1)\n'
    edit+='p.write_text(s)\n'
    try:
        subprocess.run([rig,filename,'python3 -c '+shlex.quote(edit),test_command],check=True)
    finally:
        subprocess.run(['node','scripts/prepare-embed-governance.mjs'],check=True)
subprocess.run(shlex.split('node --test browser-first/test/embed-governance-contract.test.mjs'),check=True)
PYMUTATE
```

- [ ] Prove generated-copy parity independently of generation:

```bash
python3 - <<'PYPARITY'
from pathlib import Path
import shlex, subprocess
filename='browser-first/resonantos-side-panel-extension/src/lib/generated/embed-governance-contract.js'
edit='from pathlib import Path; p=Path('+repr(filename)+'); p.write_bytes(p.read_bytes()+bytes([10]))'
subprocess.run([str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate'),filename,'python3 -c '+shlex.quote(edit),'node scripts/prepare-embed-governance.mjs --check'],check=True)
subprocess.run(['node','scripts/prepare-embed-governance.mjs','--check'],check=True)
PYPARITY
```

- [ ] Commit:

```bash
git diff --check
git add src/core/trace-redaction-core.js src/core/trace-redaction.js src/core/embed-governance-contract.js browser-first/resonantos-side-panel-extension/src/lib/trace-redaction-core.js browser-first/resonantos-side-panel-extension/src/lib/generated/trace-redaction-core.js browser-first/resonantos-side-panel-extension/src/lib/generated/trace-redaction.js browser-first/resonantos-side-panel-extension/src/lib/generated/embed-governance-contract.js scripts/prepare-embed-governance.mjs scripts/run-browser-first-extension-tests.mjs run-bridge-minimal.mjs browser-first/test/embed-governance-contract.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(embed): share closed metadata and redaction contracts"
```
### Task 3: Bind the public descriptor to the configured recipient

**Files:**
- Modify: `browser-first/host/embed-host-service.mjs`, `browser-first/test/embed-host-service.test.mjs`, `docs/architecture/MODULE-OWNERSHIP.md`
- Create/Test: `browser-first/test/embed-descriptor.test.mjs`

**Interfaces:**
- Consumes: `readEmbedHostConfig(env?:Record<string,string|undefined>): {enabled:false} | {enabled:true,upstreamUrl:string,profile:string,tokenFile:string,extensionId:string}`.
- Produces: `service.getDescriptor(): EmbedHarnessDescriptor | null`, `service.extensionOrigin: string | null`; status/session add `harness` without changing existing fields.

- [ ] Write the failing test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createEmbedHostService } from '../host/embed-host-service.mjs';
test('descriptor binds origin, survives profile/restart and never exposes configuration',async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'embed-descriptor-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const tokenFile=join(root,'token'); await writeFile(tokenFile,'private-fixture',{mode:0o600});
  const env={RESONANTOS_EMBED_POC:'1',RESONANTOS_EMBED_UPSTREAM_URL:'http://127.0.0.1:18872',RESONANTOS_EMBED_PROFILE:'one',RESONANTOS_EMBED_TOKEN_FILE:tokenFile};
  const key='augmentor-v1-'+createHash('sha256').update(JSON.stringify(['addon.augmentor-embed',env.RESONANTOS_EMBED_UPSTREAM_URL])).digest('hex');
  const expected={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:key};
  for(const profile of ['one','two']) {
    const s=createEmbedHostService({env:{...env,RESONANTOS_EMBED_PROFILE:profile}}); t.after(()=>s.close());
    assert.deepEqual(s.getDescriptor(),expected);
    assert.deepEqual((await s.embedRoutes[0].handler()).harness,expected);
    assert.deepEqual((await s.embedRoutes[1].handler()).harness,expected);
    assert.equal(JSON.stringify(s.getDescriptor()).includes('127.0.0.1'),false);
    s.close(); assert.equal(s.getDescriptor(),null);
  }
  const changed=createEmbedHostService({env:{...env,RESONANTOS_EMBED_UPSTREAM_URL:'http://127.0.0.1:18873'}}); t.after(()=>changed.close());
  assert.notEqual(changed.getDescriptor().noticeKey,key);
  const disabled=createEmbedHostService({env:{}});
  assert.equal(disabled.getDescriptor(),null); assert.equal((await disabled.embedRoutes[0].handler()).harness,null);
});
```

- [ ] Run `node --test browser-first/test/embed-descriptor.test.mjs`. Expect `getDescriptor is not a function`.
- [ ] Apply these exact edits:

```bash
python3 - <<'PY'
from pathlib import Path
p=Path('browser-first/host/embed-host-service.mjs'); s=p.read_text()
s=s.replace("import { randomBytes }", "import { randomBytes, createHash }",1)
s=s.replace("available: false, profile: null", "available: false, profile: null, harness: null",1)
s=s.replace("  enabled: false,\n  embedRoutes:", "  enabled: false,\n  extensionOrigin: null,\n  getDescriptor: () => null,\n  embedRoutes:",1)
a="  const prefix = `/embed/${config.profile}/`;"
b="""  const harness = Object.freeze({ harnessId: 'addon.augmentor-embed', interfaceId: 'panel',
    label: 'Augmentor', governance: 'self-governed', noticeKey: 'augmentor-v1-' +
      createHash('sha256').update(JSON.stringify(['addon.augmentor-embed', upstream.origin]), 'utf8').digest('hex') });
"""
assert a in s; s=s.replace(a,b+a,1)
s=s.replace('    enabled: true,\n    embedRoutes:', '    enabled: true,\n    extensionOrigin,\n    getDescriptor: () => closed ? null : { ...harness },\n    embedRoutes:',1)
s=s.replace('profile: closed ? null : config.profile }','profile: closed ? null : config.profile, harness: closed ? null : { ...harness } }',1)
s=s.replace('return { hostPath: `/embed-host/?ticket=${ticket}` };','return { hostPath: `/embed-host/?ticket=${ticket}`, harness: { ...harness } };',1)
p.write_text(s)
PY
```

In the existing embed-host ownership row replace `status projects availability/profile only` with `status projects availability/profile and a fixed host-owned descriptor with an origin-bound notice key; session projects the same descriptor`. No upstream address enters that projection.

Update the three existing status projections in `browser-first/test/embed-host-service.test.mjs` with this exact patching command:

```bash
python3 - <<'PYTEST'
from pathlib import Path
p=Path('browser-first/test/embed-host-service.test.mjs');s=p.read_text()
s=s.replace("{ ok: true, available: true, profile: 'poc' }", "{ ok: true, available: true, profile: 'poc', harness: f.service.getDescriptor() }")
s=s.replace("{ available: false, profile: null }", "{ available: false, profile: null, harness: null }")
s=s.replace("{ ok: true, available: false, profile: null }", "{ ok: true, available: false, profile: null, harness: null }")
p.write_text(s)
PYTEST
```

- [ ] Run `node --test browser-first/test/embed-descriptor.test.mjs browser-first/test/embed-host-service.test.mjs`; expect pass. Preserve all existing tunnel guard assertions.
- [ ] Red evidence: replace `upstream.origin` in the hash input with `'constant'`; the changed-port assertion must fail. Restore it and rerun. Existing ticket/cookie/header guard tests must remain green.
- [ ] Run this exact guard-mutation matrix after green. Each `rig-mutate` invocation must return zero (behavioral failure under mutation and byte-identical restoration). Inspect any failure; import or syntax errors are not guard evidence. The strings below are exact edits, not patterns.

```bash
python3 - <<'PYMUTATE'
from pathlib import Path
import shlex, subprocess
rig=str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate')
mutations=[('browser-first/host/embed-host-service.mjs', [("upstream.origin]), 'utf8'", "'constant']), 'utf8'")])]
test_command='node --test browser-first/test/embed-descriptor.test.mjs'
for filename,changes in mutations:
    edit='from pathlib import Path\np=Path('+repr(filename)+')\ns=p.read_text()\n'
    for before,after in changes:
        edit+='assert '+repr(before)+' in s\ns=s.replace('+repr(before)+','+repr(after)+',1)\n'
    edit+='p.write_text(s)\n'
    try:
        subprocess.run([rig,filename,'python3 -c '+shlex.quote(edit),test_command],check=True)
    finally:
        subprocess.run(['node','scripts/prepare-embed-governance.mjs'],check=True)
subprocess.run(shlex.split('node --test browser-first/test/embed-descriptor.test.mjs'),check=True)
PYMUTATE
```

- [ ] Commit:

```bash
git diff --check
git add browser-first/host/embed-host-service.mjs browser-first/test/embed-descriptor.test.mjs browser-first/test/embed-host-service.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(embed): bind first-share identity to recipient origin"
```

### Task 4: Private atomic snapshots and single-writer ownership

**Files:**
- Create: `browser-first/host/embed-governance-storage.mjs`
- Create/Test: `browser-first/test/embed-governance-storage.test.mjs`
- Modify: `docs/architecture/MODULE-OWNERSHIP.md`

**Interfaces:**
- Consumes: `LIMITS.state:number`, `UUID:RegExp`, `activityError(code:string):Error & {code:string}`.
- Produces: `openEmbedGovernanceStorage({ userRoot: string, repoRoot: string, fs?: typeof import('node:fs/promises'), processExists?: (pid: number) => void }): Promise<{ read(): Promise<string|null>, write(text: string): Promise<void>, close(): Promise<void> }>`; constructor rejects unsafe paths and ownership. No routes or policy in this module.

- [ ] Write the failing test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openEmbedGovernanceStorage } from '../host/embed-governance-storage.mjs';
async function fixture(t) {
  const base=await fs.mkdtemp(join(await fs.realpath(tmpdir()),'embed-store-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const userRoot=join(base,'user'),repoRoot=join(base,'repository');
  await fs.mkdir(repoRoot,{mode:0o700});
  return {base,userRoot,repoRoot,dir:join(userRoot,'BrowserFirst','EmbedGovernance')};
}
test('private durable snapshot, lock contention, restart and stale temporary cleanup',async t=>{
  const f=await fixture(t),s=await openEmbedGovernanceStorage(f); t.after(()=>s.close());
  assert.equal(await s.read(),null); await s.write('{"version":1}\n');
  assert.equal((await fs.stat(join(f.dir,'state.json'))).mode&0o777,0o600);
  assert.equal((await fs.stat(f.dir)).mode&0o777,0o700);
  await assert.rejects(openEmbedGovernanceStorage(f),{code:'storage-unavailable'});
  await s.close();
  const temp=join(f.dir,`.state-${randomUUID()}.tmp`); await fs.writeFile(temp,'abandoned',{mode:0o600});
  const next=await openEmbedGovernanceStorage(f); t.after(()=>next.close());
  assert.equal(await next.read(),'{"version":1}\n'); await assert.rejects(fs.stat(temp),{code:'ENOENT'});
});
test('restrictive umask does not remove owner access from new private paths or files',async t=>{
  const f=await fixture(t),previous=process.umask(0o277);let store;
  try {
    store=await openEmbedGovernanceStorage(f);await store.write('{}\n');
    for(const path of [f.userRoot,join(f.userRoot,'BrowserFirst'),f.dir,join(f.dir,'writer.lock')])assert.equal((await fs.stat(path)).mode&0o777,0o700);
    for(const path of [join(f.dir,'state.json'),join(f.dir,'writer.lock','owner.json')])assert.equal((await fs.stat(path)).mode&0o777,0o600);
    assert.equal(await store.read(),'{}\n');await store.close();
    store=await openEmbedGovernanceStorage(f);assert.equal(await store.read(),'{}\n');
  } finally {process.umask(previous);await store?.close();}
});
test('root and ancestor links, repository destinations and missing roots beneath links create no feature data',async t=>{
  for(const destination of ['outside','repo']) {
    const f=await fixture(t),target=destination==='repo'?f.repoRoot:join(f.base,'target');
    if(destination==='outside') await fs.mkdir(target);
    await fs.symlink(target,f.userRoot);
    for(const root of [f.userRoot,join(f.userRoot,'missing')]) await assert.rejects(openEmbedGovernanceStorage({...f,userRoot:root}),{code:'storage-unavailable'});
    if(destination==='outside') assert.deepEqual(await fs.readdir(target),[]);
  }
  const f=await fixture(t);
  await assert.rejects(openEmbedGovernanceStorage({...f,userRoot:f.repoRoot}),{code:'storage-unavailable'});
});
test('permission and path substitution refuse reads and replacements',async t=>{
  const f=await fixture(t),s=await openEmbedGovernanceStorage(f); t.after(()=>s.close());
  await s.write('{}\n'); await fs.chmod(join(f.dir,'state.json'),0o644);
  await assert.rejects(s.read(),{code:'storage-unavailable'});
  await assert.rejects(s.write('{}\n'),{code:'storage-unavailable'});
  await fs.chmod(join(f.dir,'state.json'),0o600);
  await fs.rename(f.dir,f.dir+'-old'); await fs.cp(f.dir+'-old',f.dir,{recursive:true});
  await assert.rejects(s.read(),{code:'storage-unavailable'});
  await assert.rejects(s.write('{}\n'),{code:'storage-unavailable'});
  assert.equal(await fs.readFile(join(f.dir,'state.json'),'utf8'),'{}\n');
});
test('only ESRCH permits stale-lock recovery; malformed, interrupted, EPERM and reused live PID refuse',async t=>{
  for(const mode of ['dead','alive','denied','malformed','interrupted']) {
    const f=await fixture(t); const first=await openEmbedGovernanceStorage(f); await first.close();
    const lock=join(f.dir,'writer.lock'); await fs.mkdir(lock,{mode:0o700});
    if(mode!=='interrupted') await fs.writeFile(join(lock,'owner.json'),mode==='malformed'?'bad':JSON.stringify({pid:12345,ownership:randomUUID()}),{mode:0o600});
    const processExists=()=>{if(mode==='dead'||mode==='denied') throw Object.assign(Error(),{code:mode==='dead'?'ESRCH':'EPERM'});};
    if(mode==='dead') { const s=await openEmbedGovernanceStorage({...f,processExists}); await s.close(); }
    else await assert.rejects(openEmbedGovernanceStorage({...f,processExists}),{code:'storage-unavailable'});
  }
});
test('failed atomic rename preserves old state; oversized snapshots are refused',async t=>{
  const f=await fixture(t); let fail=false;
  const s=await openEmbedGovernanceStorage({...f,fs:{...fs,rename:async(...args)=>{if(fail) throw Error('PRIVATE'); return fs.rename(...args);}}}); t.after(()=>s.close());
  await s.write('{"old":true}\n'); fail=true;
  await assert.rejects(s.write('{"new":true}\n'),{code:'storage-unavailable'});
  assert.equal(await s.read(),'{"old":true}\n');
  fail=false;await assert.rejects(s.write('x'.repeat(10*1024*1024+1)),{code:'storage-unavailable'});
});
```

Append these independent guard cases before the first run:

```js
test('private directory modes, linked state and hardlinked snapshots fail closed',async t=>{
  for(const kind of ['feature-mode','state-link','state-hardlink']) {
    const f=await fixture(t),s=await openEmbedGovernanceStorage(f);t.after(()=>s.close());await s.write('{}');
    if(kind==='feature-mode')await fs.chmod(f.dir,0o755);
    if(kind==='state-link'){await fs.rename(join(f.dir,'state.json'),join(f.base,'outside'));await fs.symlink(join(f.base,'outside'),join(f.dir,'state.json'));}
    if(kind==='state-hardlink')await fs.link(join(f.dir,'state.json'),join(f.base,'linked'));
    await assert.rejects(s.read(),{code:'storage-unavailable'});
    await assert.rejects(s.write('{}'),{code:'storage-unavailable'});
  }
});
test('foreign state owner, replaced BrowserFirst and unknown writer identity cannot be used',async t=>{
  const f=await fixture(t);let foreign=false;
  const s=await openEmbedGovernanceStorage({...f,fs:{...fs,lstat:async p=>{const st=await fs.lstat(p);if(foreign&&p===join(f.dir,'state.json'))return new Proxy(st,{get:(target,key)=>key==='uid'?st.uid+1:Reflect.get(target,key)});return st;}}});t.after(()=>s.close());
  await s.write('{}');foreign=true;await assert.rejects(s.read(),{code:'storage-unavailable'});foreign=false;
  const owner=join(f.dir,'writer.lock','owner.json');await fs.writeFile(owner,JSON.stringify({pid:process.pid,ownership:randomUUID()}),{mode:0o600});
  await assert.rejects(s.write('{}'),{code:'storage-unavailable'});
  await fs.rename(join(f.userRoot,'BrowserFirst'),join(f.userRoot,'BrowserFirst-old'));await fs.mkdir(join(f.userRoot,'BrowserFirst'),{mode:0o700});
  await assert.rejects(s.read(),{code:'storage-unavailable'});
});
```

Append the lock-release ownership test:

```js
test('close never removes a lock whose ownership UUID changed',async t=>{
  const f=await fixture(t),s=await openEmbedGovernanceStorage(f);
  const owner=join(f.dir,'writer.lock','owner.json'),replacement={pid:process.pid,ownership:randomUUID()};
  await fs.writeFile(owner,JSON.stringify(replacement),{mode:0o600});await s.close();
  assert.deepEqual(JSON.parse(await fs.readFile(owner,'utf8')),replacement);
});
```

- [ ] Run `node --test browser-first/test/embed-governance-storage.test.mjs`. Expect missing module.
- [ ] Create the complete storage module:

```js
import * as nativeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, relative, sep, dirname, join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS, UUID, exact, activityError } from '../../src/core/embed-governance-contract.js';
export async function openEmbedGovernanceStorage({userRoot,repoRoot,fs=nativeFs,processExists=pid=>process.kill(pid,0)}={}) {
  const fail=()=>activityError('storage-unavailable');
  const uid=process.getuid?.();
  if(typeof userRoot!=='string'||!isAbsolute(userRoot)||typeof repoRoot!=='string'||uid===undefined) throw fail();
  const root=resolve(userRoot),repository=await fs.realpath(repoRoot),pins=new Map();
  const inside=(base,target)=>{const r=relative(base,target);return !r||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
  if(inside(repository,root)) throw fail();
  async function directory(path,{create=false,privateMode=false,pin=false}={}) {
    const parent=dirname(path);
    if(parent!==path) await directory(parent,{create});
    let stat;
    try { stat=await fs.lstat(path); }
    catch(e) {
      if(e.code!=='ENOENT'||!create) throw fail();
      const ancestor=await fs.realpath(parent);
      if(ancestor!==parent||inside(repository,path)) throw fail();
      try { await fs.mkdir(path,{mode:0o700}); await fs.chmod(path,0o700); } catch(e2) { if(e2.code!=='EEXIST') throw fail(); }
      stat=await fs.lstat(path);
    }
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(path)!==path) throw fail();
    if(privateMode&&(stat.uid!==uid||(stat.mode&0o777)!==0o700)) throw fail();
    const identity=`${stat.dev}:${stat.ino}`;
    if(pins.has(path)&&pins.get(path)!==identity) throw fail();
    if(pin) pins.set(path,identity);
  }
  // Pin every root component, not merely the final feature directory.
  try {
    await directory(root,{create:true});
    for(let p=root;;p=dirname(p)) { await directory(p,{pin:true}); if(p===parse(p).root) break; }
  } catch { throw fail(); }
  const browser=join(root,'BrowserFirst'),dir=join(browser,'EmbedGovernance'),lock=join(dir,'writer.lock'),owner=join(lock,'owner.json'),state=join(dir,'state.json');
  const ownership=randomUUID(); let owned=false,closed=false;
  async function check() {
    await directory(root); await directory(browser); await directory(dir,{privateMode:true});
  }
  async function file(path,missing=false) {
    await check();
    let stat; try { stat=await fs.lstat(path); } catch(e) { if(missing&&e.code==='ENOENT') return null; throw fail(); }
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o777)!==0o600||stat.nlink!==1) throw fail();
    return stat;
  }
  async function readPrivate(path,limit) {
    const before=await file(path,true); if(!before) return null;
    if(before.size>limit) throw fail();
    const handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const current=await handle.stat(); if(current.dev!==before.dev||current.ino!==before.ino||current.size>limit||current.uid!==uid||(current.mode&0o777)!==0o600||current.nlink!==1) throw fail();
      const buffer=Buffer.alloc(limit+1); let used=0;
      while(used<=limit) { const {bytesRead}=await handle.read(buffer,used,buffer.length-used,null); if(!bytesRead) break; used+=bytesRead; }
      if(used>limit) throw fail(); await check(); return buffer.subarray(0,used).toString('utf8');
    } finally { await handle.close(); }
  }
  async function lockOwner() {
    await directory(lock,{privateMode:true});
    const v=JSON.parse(await readPrivate(owner,512));
    if(!exact(v,['pid','ownership'])||!Number.isSafeInteger(v.pid)||v.pid<=0||!UUID.test(v.ownership)) throw fail();
    return v;
  }
  async function release(expected) {
    const v=await lockOwner(); if(v.ownership!==expected) throw fail();
    await file(owner); await fs.unlink(owner); await fs.rmdir(lock);
  }
  try {
    await directory(browser,{create:true,pin:true});
    await directory(dir,{create:true,privateMode:true,pin:true});
    try { await fs.mkdir(lock,{mode:0o700}); }
    catch(e) {
      if(e.code!=='EEXIST') throw fail();
      const old=await lockOwner(); let absent=false;
      try { processExists(old.pid); } catch(error) { if(error.code==='ESRCH') absent=true; else throw fail(); }
      if(!absent) throw fail(); await release(old.ownership);
      await fs.mkdir(lock,{mode:0o700});
    }
    await fs.chmod(lock,0o700);
    await directory(lock,{privateMode:true});
    const handle=await fs.open(owner,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify({pid:process.pid,ownership})+'\n'); await handle.sync(); } finally { await handle.close(); }
    owned=true;
    for(const name of await fs.readdir(dir)) if(/^\.state-[0-9a-f-]{36}\.tmp$/.test(name)) {const p=join(dir,name);await file(p);await fs.unlink(p);}
  } catch { if(owned) await release(ownership).catch(()=>{}); throw fail(); }
  return {
    async read() {try {if(closed) throw fail();return await readPrivate(state,LIMITS.state);}catch{throw fail();}},
    async write(text) {
      let temp;
      try {
        if(closed||typeof text!=='string'||Buffer.byteLength(text)>LIMITS.state) throw fail();
        await check(); if((await lockOwner()).ownership!==ownership) throw fail();
        await file(state,true); temp=join(dir,`.state-${randomUUID()}.tmp`);
        const handle=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try {await handle.chmod(0o600);await handle.writeFile(text,'utf8');await handle.sync();}finally{await handle.close();}
        await check(); await file(temp); await file(state,true);
        await fs.rename(temp,state); temp=null;
        const parent=await fs.open(dir,constants.O_RDONLY|constants.O_NOFOLLOW);
        try {await parent.sync();}finally{await parent.close();}
        await check();
      } catch {throw fail();}
      finally {if(temp) {try{await file(temp);await fs.unlink(temp);}catch{ /* Startup safely removes an abandoned private snapshot. */ }}}
    },
    async close() {if(closed)return;closed=true;if(owned){owned=false;await release(ownership).catch(()=>{});}}
  };
}
```

Append the ownership row in the Alpha table:

```markdown
| `browser-first/host/embed-governance-storage.mjs` | Private embed snapshot filesystem boundary | Canonical external user root and its own private files | Exclusive writer lock, private atomic snapshots and directory sync | Consent, routes, relay parsing, network or process launch |
```

- [ ] Run `node --test browser-first/test/embed-governance-storage.test.mjs`; expect pass. For red evidence, individually remove the repository containment guard, the `stat.isSymbolicLink()`/realpath directory rejection, the private file-mode check, the pinned-inode comparison and `if(!absent) throw fail()` lock guard. Each respective named filesystem test must fail behaviorally; restore each immediately. Also remove the snapshot size guard and require the oversized-write assertion to fail. Rerun the entire file after restoring all guards.
- [ ] Run this exact guard-mutation matrix after green. Each `rig-mutate` invocation must return zero (behavioral failure under mutation and byte-identical restoration). Inspect any failure; import or syntax errors are not guard evidence. The strings below are exact edits, not patterns.

```bash
python3 - <<'PYMUTATE'
from pathlib import Path
import shlex, subprocess
rig=str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate')
mutations=[('browser-first/host/embed-governance-storage.mjs', [('if(inside(repository,root)) throw fail();', ''), ('ancestor!==parent||inside(repository,path)', 'ancestor!==parent')]), ('browser-first/host/embed-governance-storage.mjs', [('if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(path)!==path) throw fail();', ''), ('ancestor!==parent||inside(repository,path)', 'inside(repository,path)')]), ('browser-first/host/embed-governance-storage.mjs', [('if(privateMode&&(stat.uid!==uid||(stat.mode&0o777)!==0o700)) throw fail();', '')]), ('browser-first/host/embed-governance-storage.mjs', [('||stat.uid!==uid', ''), ('||current.uid!==uid', '')]), ('browser-first/host/embed-governance-storage.mjs', [('||(stat.mode&0o777)!==0o600', ''), ('||(current.mode&0o777)!==0o600', '')]), ('browser-first/host/embed-governance-storage.mjs', [('||stat.nlink!==1', ''), ('||current.nlink!==1', '')]), ('browser-first/host/embed-governance-storage.mjs', [('if(pins.has(path)&&pins.get(path)!==identity) throw fail();', '')]), ('browser-first/host/embed-governance-storage.mjs', [('if(!absent) throw fail();', '')]), ('browser-first/host/embed-governance-storage.mjs', [("if(error.code==='ESRCH') absent=true; else throw fail();", 'absent=true;')]), ('browser-first/host/embed-governance-storage.mjs', [('if((await lockOwner()).ownership!==ownership) throw fail();', '')]), ('browser-first/host/embed-governance-storage.mjs', [('||Buffer.byteLength(text)>LIMITS.state', '')]), ('browser-first/host/embed-governance-storage.mjs', [('if(v.ownership!==expected) throw fail();', '')])]
test_command='node --test browser-first/test/embed-governance-storage.test.mjs'
for filename,changes in mutations:
    edit='from pathlib import Path\np=Path('+repr(filename)+')\ns=p.read_text()\n'
    for before,after in changes:
        edit+='assert '+repr(before)+' in s\ns=s.replace('+repr(before)+','+repr(after)+',1)\n'
    edit+='p.write_text(s)\n'
    try:
        subprocess.run([rig,filename,'python3 -c '+shlex.quote(edit),test_command],check=True)
    finally:
        subprocess.run(['node','scripts/prepare-embed-governance.mjs'],check=True)
subprocess.run(shlex.split('node --test browser-first/test/embed-governance-storage.test.mjs'),check=True)
PYMUTATE
```

- [ ] Commit:

```bash
git diff --check
git add browser-first/host/embed-governance-storage.mjs browser-first/test/embed-governance-storage.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(embed): isolate private atomic activity storage"
```
### Task 5: Serialized governance state, retention and six routes

**Files:**
- Create: `browser-first/host/embed-governance-host-service.mjs`
- Create/Test: `browser-first/test/embed-governance-host-service.test.mjs`
- Modify: `docs/architecture/MODULE-OWNERSHIP.md`

**Interfaces:**
- Consumes: `openEmbedGovernanceStorage({userRoot:string,repoRoot:string,fs?:typeof import("node:fs/promises"),processExists?:(pid:number)=>void}):Promise<{read():Promise<string|null>,write(text:string):Promise<void>,close():Promise<void>}>`, `getDescriptor(): EmbedHarnessDescriptor|null`, `metadata(value:unknown):EmbedMetadata|null`, `UUID:RegExp`, `NOTICE_KEY:RegExp`, `LIMITS` (the exact frozen numeric object in Task 2), `exact(value:unknown, keys:string[]):boolean`, `activityError(code:string):Error & {code:string}`.
- Produces: `createEmbedGovernanceHostService({userRoot:string, repoRoot?:string, getDescriptor?:()=>object|null, now?:()=>number, storageFactory?:typeof openEmbedGovernanceStorage, setIntervalImpl?:typeof setInterval, clearIntervalImpl?:typeof clearInterval}): Promise<{governanceRoutes: Array<{method:"GET"|"POST",path:string,requiredCapability:string,requiredOrigin:"extension",errorFamily:"embed-governance",maxBodyBytes:number,loopbackHostOnly:true,handler(payload:unknown,request:{url:string}):Promise<object>}>, close():Promise<void>}>`. Handlers return the exact successful payloads in Global Constraints and throw only fixed coded errors.

- [ ] Write the failing test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmbedGovernanceHostService } from '../host/embed-governance-host-service.mjs';
const descriptor={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:'augmentor-v1-'+ 'a'.repeat(64)};
async function fixture(t,options={}) {
  const userRoot=await mkdtemp(join(await realpath(tmpdir()),'embed-service-'));
  let now=Date.UTC(2026,9,13),tick;
  const make=()=>createEmbedGovernanceHostService({userRoot,getDescriptor:()=>descriptor,now:()=>now,setIntervalImpl:fn=>{tick=fn;return {unref(){}};},clearIntervalImpl(){},...options});
  const s=await make();
  t.after(async()=>{await s.close();await rm(userRoot,{recursive:true,force:true});});
  const call=async(path,body={},method='POST',service=s)=>service.governanceRoutes.find(r=>r.path==='/embed-governance/'+path&&r.method===method).handler(body,{url:'/embed-governance/'+path});
  return {s,make,call,userRoot,file:join(userRoot,'BrowserFirst','EmbedGovernance','state.json'),advance:ms=>now+=ms,tick:()=>tick()};
}
test('off by default, exact requests, durable preference/notice, identity stamping and epoch barriers',async t=>{
  const f=await fixture(t),state=()=>f.call('state',{},'GET');
  let s=await state();assert.equal(s.recordingEnabled,false);
  const event={kind:'page-shared',domain:'example.test'},eventId=randomUUID();
  assert.deepEqual(await f.call('events',{writeEpoch:s.writeEpoch,eventId,event}),{recorded:false,reason:'disabled'});
  const on=await f.call('recording',{enabled:true});assert.notEqual(on.writeEpoch,s.writeEpoch);
  assert.equal((await f.call('recording',{enabled:true})).writeEpoch,on.writeEpoch);
  for(const body of [{enabled:1},{enabled:true,token:'CANARY'}]) await assert.rejects(f.call('recording',body),{code:'invalid-request'});
  await assert.rejects(f.call('notice',{noticeKey:'augmentor-v1-'+ 'b'.repeat(64),version:1}),{code:'invalid-request'});
  await f.call('notice',{noticeKey:descriptor.noticeKey,version:1});
  const body={writeEpoch:on.writeEpoch,eventId,event};
  for(const key of ['eventId','writeEpoch'])for(const bad of ['not-a-uuid',eventId.toUpperCase()])await assert.rejects(f.call('events',{...body,[key]:bad}),{code:'invalid-request'});
  for(const key of ['recordedAt','harnessId','governance','source','conversationId']) await assert.rejects(f.call('events',{...body,[key]:'CANARY'}),{code:'invalid-request'});
  assert.deepEqual(await f.call('events',body),{recorded:true,reason:null});
  assert.deepEqual(await f.call('events',body),{recorded:false,reason:'duplicate'});
  const page=await f.call('events',{},'GET');assert.equal(page.events[0].source,'local-share');assert.deepEqual(page.events[0].event,event);
  assert.equal((await readFile(f.file,'utf8')).includes('CANARY'),false);
  const deleted=await f.call('events/delete');assert.equal(deleted.recordingEnabled,true);assert.equal(deleted.noticeAcknowledged,true);
  assert.deepEqual(await f.call('events',{...body,eventId:randomUUID()}),{recorded:false,reason:'stale-epoch'});
  await f.s.close();const next=await f.make();t.after(()=>next.close());
  const reopened=await f.call('state',{},'GET',next);assert.equal(reopened.recordingEnabled,true);assert.equal(reopened.noticeAcknowledged,true);
  assert.deepEqual((await f.call('events',{},'GET',next)).events,[]);
});
test('30-day inclusive cutoff, hourly disabled pruning and rollback never restore records',async t=>{
  const f=await fixture(t),s=await f.call('recording',{enabled:true});
  await f.call('events',{writeEpoch:s.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}});
  await f.call('recording',{enabled:false});f.advance(2592000000-1);
  assert.equal((await f.call('events',{},'GET')).events.length,1);
  f.advance(1);await f.tick();assert.equal((await f.call('events',{},'GET')).events.length,0);
  f.advance(-2592000000);assert.equal((await f.call('events',{},'GET')).events.length,0);
  assert.equal(JSON.parse(await readFile(f.file,'utf8')).events.length,0);
});
test('invalid state recovery disables recording and clears notices; unavailable PoC still reads/deletes',async t=>{
  const f=await fixture(t);await f.call('recording',{enabled:true});await f.s.close();
  await writeFile(f.file,'invalid',{mode:0o600});const next=await f.make();t.after(()=>next.close());
  const state=await f.call('state',{},'GET',next);assert.equal(state.problem,'storage-unavailable');assert.equal(state.writeEpoch,null);
  const reset=await f.call('events/delete',{},'POST',next);assert.equal(reset.recordingEnabled,false);assert.equal(reset.noticeAcknowledged,false);
  const disabled=await fixture(t,{getDescriptor:()=>null});
  assert.equal((await disabled.call('state',{},'GET')).available,false);
  await assert.rejects(disabled.call('recording',{enabled:true}),{code:'storage-unavailable'});
  const ds=await disabled.call('state',{},'GET');
  assert.deepEqual(await disabled.call('events',{writeEpoch:ds.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}}),{recorded:false,reason:'unavailable'});
  assert.equal((await disabled.call('events/delete')).deleted,true);
});
test('pagination is insertion order and removed anchors expire',async t=>{
  const f=await fixture(t),s=await f.call('recording',{enabled:true});
  for(let i=0;i<101;i++) await f.call('events',{writeEpoch:s.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}});
  const page=await f.call('events',{},'GET');assert.equal(page.events.length,100);assert.ok(page.nextBefore);
  const route=f.s.governanceRoutes.find(r=>r.method==='GET'&&r.path.endsWith('/events'));
  assert.equal((await route.handler({},{url:'/embed-governance/events?before='+page.nextBefore})).events.length,1);
  await f.call('events/delete');await assert.rejects(route.handler({},{url:'/embed-governance/events?before='+page.nextBefore}),{code:'cursor-expired'});
  await assert.rejects(route.handler({},{url:'/embed-governance/events?before=x&before=x'}),{code:'invalid-request'});
});
test('retention failure hides expired rows and blocks appends until durable repair',async t=>{
  let raw=null,fail=false;
  const f=await fixture(t,{storageFactory:async()=>({read:async()=>raw,write:async v=>{if(fail)throw Error('CANARY');raw=v;},close:async()=>{}})});
  const on=await f.call('recording',{enabled:true});await f.call('events',{writeEpoch:on.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}});
  fail=true;f.advance(2592000000);
  assert.equal((await f.call('state',{},'GET')).problem,'retention-failed');
  assert.deepEqual((await f.call('events',{},'GET')).events,[]);
  await assert.rejects(f.call('events',{writeEpoch:on.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}}),{code:'storage-unavailable'});
  fail=false;assert.equal((await f.call('state',{},'GET')).problem,null);
});
```

Append this read-time guard test to the same file:

```js
test('every read revalidates private paths and modes; unsafe state cannot be reset',async t=>{
  const f=await fixture(t);await f.call('recording',{enabled:true});
  const {chmod,rename,mkdir}=await import('node:fs/promises');
  await chmod(f.file,0o644);
  assert.equal((await f.call('state',{},'GET')).problem,'storage-unavailable');
  await assert.rejects(f.call('events',{},'GET'),{code:'storage-unavailable'});
  await assert.rejects(f.call('events/delete'),{code:'storage-unavailable'});
  await chmod(f.file,0o600);
  assert.equal((await f.call('state',{},'GET')).recordingEnabled,true);
  const dir=join(f.userRoot,'BrowserFirst','EmbedGovernance');
  await rename(dir,dir+'-moved');await mkdir(dir,{mode:0o700});
  assert.equal((await f.call('state',{},'GET')).problem,'storage-unavailable');
  await assert.rejects(f.call('events',{},'GET'),{code:'storage-unavailable'});
});
```

Append the stored-state rejection and serialized-byte-cap tests:

```js
test('unknown versions, invalid records/notices/epochs and oversized state require explicit recovery',async t=>{
  for(const kind of ['version','record','notice','epoch','oversized']) {
    const f=await fixture(t);await f.call('recording',{enabled:true});await f.s.close();
    const saved=JSON.parse(await readFile(f.file,'utf8'));
    if(kind==='version')saved.version=2;
    if(kind==='record')saved.events=[{kind:'reply-finished',text:'CANARY'}];
    if(kind==='notice')saved.notices={invalid:1};
    if(kind==='epoch')saved.writeEpoch='invalid';
    await writeFile(f.file,kind==='oversized'?' '.repeat(10*1024*1024+1):JSON.stringify(saved),{mode:0o600});
    const next=await f.make();t.after(()=>next.close());
    assert.equal((await f.call('state',{},'GET',next)).problem,'storage-unavailable');
    await assert.rejects(f.call('events',{},'GET',next),{code:'storage-unavailable'});
    assert.equal((await f.call('events/delete',{},'POST',next)).recordingEnabled,false);
    assert.equal((await f.call('state',{},'GET',next)).problem,null);
  }
});
test('10 MiB cap includes notice bytes and preserves prior state when an append cannot fit',async t=>{
  let raw=null;const f=await fixture(t,{storageFactory:async()=>({read:async()=>raw,write:async v=>{raw=v;},close:async()=>{}})});
  const on=await f.call('recording',{enabled:true});await f.s.close();
  const saved=JSON.parse(raw),key='augmentor-v1-'+ '0'.repeat(64);
  const entryBytes=Buffer.byteLength(JSON.stringify({[key]:1}))-1;
  const count=Math.floor((10*1024*1024-Buffer.byteLength(JSON.stringify(saved)+'\n'))/entryBytes);
  saved.notices=Object.fromEntries(Array.from({length:count},(_,i)=>['augmentor-v1-'+i.toString(16).padStart(64,'0'),1]));
  raw=JSON.stringify(saved)+'\n';assert.ok(Buffer.byteLength(raw)<=10*1024*1024);
  const next=await f.make();t.after(()=>next.close());const before=raw;
  assert.equal((await f.call('state',{},'GET',next)).problem,'log-full');
  assert.deepEqual(await f.call('events',{writeEpoch:on.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}},'POST',next),{recorded:false,reason:'full'});
  assert.equal(raw,before);
  await next.close();const restarted=await f.make();t.after(()=>restarted.close());
  assert.equal((await f.call('state',{},'GET',restarted)).problem,'log-full');
});
test('startup pruning frees a full record log before exposing state',async t=>{
  let raw=null;const f=await fixture(t,{storageFactory:async()=>({read:async()=>raw,write:async v=>{raw=v;},close:async()=>{}})});
  await f.call('recording',{enabled:true});await f.s.close();
  const saved=JSON.parse(raw),record={version:1,recordedAt:new Date(Date.UTC(2026,9,13)).toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',source:'harness-report',event:{kind:'reply-started'}};
  raw=JSON.stringify({...saved,events:Array.from({length:10000},()=>({...record,eventId:randomUUID()}))})+'\n';
  f.advance(2592000000);const next=await f.make();t.after(()=>next.close());
  assert.equal((await f.call('state',{},'GET',next)).problem,null);
  assert.deepEqual(JSON.parse(raw).events,[]);
});
```

- [ ] Run `node --test browser-first/test/embed-governance-host-service.test.mjs`; expect missing module.
- [ ] Create the complete service:

```js
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openEmbedGovernanceStorage } from './embed-governance-storage.mjs';
import { LIMITS, UUID, NOTICE_KEY, metadata, exact, validDescriptor, activityError } from '../../src/core/embed-governance-contract.js';
const bytes=v=>Buffer.byteLength(JSON.stringify(v)+'\n');
const fresh=()=>({version:1,recordingEnabled:false,writeEpoch:randomUUID(),notices:{},events:[]});
function validRecord(v) {
  return exact(v,['version','eventId','recordedAt','harnessId','interfaceId','governance','source','event'])&&v.version===1&&typeof v.eventId==='string'&&UUID.test(v.eventId)&&typeof v.recordedAt==='string'&&Number.isFinite(Date.parse(v.recordedAt))&&new Date(v.recordedAt).toISOString()===v.recordedAt&&v.harnessId==='addon.augmentor-embed'&&v.interfaceId==='panel'&&v.governance==='self-governed'&&metadata(v.event)!==null&&v.source===(v.event.kind==='page-shared'?'local-share':'harness-report')&&bytes(v)<=LIMITS.record;
}
function parseState(raw) {
  if(raw===null) return fresh();
  if(Buffer.byteLength(raw)>LIMITS.state) throw activityError('storage-unavailable');
  const v=JSON.parse(raw);
  if(!exact(v,['version','recordingEnabled','writeEpoch','notices','events'])||v.version!==1||typeof v.recordingEnabled!=='boolean'||typeof v.writeEpoch!=='string'||!UUID.test(v.writeEpoch)||!v.notices||typeof v.notices!=='object'||Array.isArray(v.notices)||Object.entries(v.notices).some(([k,n])=>!NOTICE_KEY.test(k)||n!==1)||!Array.isArray(v.events)||v.events.length>LIMITS.records||v.events.some(e=>!validRecord(e))||new Set(v.events.map(e=>e.eventId)).size!==v.events.length) throw activityError('storage-unavailable');
  return v;
}
export async function createEmbedGovernanceHostService({userRoot,repoRoot=resolve(import.meta.dirname,'../..'),getDescriptor=()=>null,now=Date.now,storageFactory=openEmbedGovernanceStorage,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}) {
  let storage=null,state=null,problem=null,retentionPending=false,closed=false,tail=Promise.resolve(),diskRaw=undefined;
  const descriptor=()=>{try{const d=getDescriptor();return validDescriptor(d)?d:null;}catch{return null;}};
  const serialize=work=>{const result=tail.then(()=>{if(closed)throw activityError('storage-unavailable');return work();});tail=result.catch(()=>{});return result;};
  async function save(next) {
    if(!storage||bytes(next)>LIMITS.state) throw activityError('storage-unavailable');
    parseState(JSON.stringify(next));
    try {const raw=JSON.stringify(next)+'\n';await storage.write(raw);diskRaw=raw;state=next;retentionPending=false;problem=null;}
    catch {throw activityError('storage-unavailable');}
  }
  async function readDisk() {
    if(!storage){state=null;problem='storage-unavailable';return;}
    try {
      // This read repeats the storage layer's path, owner and mode checks on every operation.
      const raw=await storage.read();
      if(raw!==diskRaw||state===null){const next=parseState(raw);diskRaw=raw;state=next;retentionPending=false;problem=null;}
    }catch{state=null;problem='storage-unavailable';}
  }
  async function prune() {
    await readDisk();
    if(!state) return;
    const events=state.events.filter(e=>Date.parse(e.recordedAt)>now()-LIMITS.retention);
    if(events.length!==state.events.length||retentionPending) {
      // A failed durable rewrite must still exclude expired rows from reads.
      state={...state,events};retentionPending=true;
      try{await save(state);}catch{problem='retention-failed';}
    }
    if(problem==='log-full'&&events.length<LIMITS.records&&bytes(state)<LIMITS.state- LIMITS.record) problem=null;
  }
  try {storage=await storageFactory({userRoot,repoRoot});await prune();}
  catch {problem='storage-unavailable';state=null;}
  function fullFromState() {
    if(!state)return false;
    if(state.events.length>=LIMITS.records)return true;
    // Test the smallest legal records, including JSON array separator and final newline.
    const base={version:1,eventId:'00000000-0000-4000-8000-000000000000',recordedAt:'2000-01-01T00:00:00.000Z',harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed'};
    const candidates=[{...base,source:'harness-report',event:{kind:'reply-started'}},{...base,source:'local-share',event:{kind:'page-shared',domain:'a'}}];
    return candidates.every(record=>bytes({...state,events:[...state.events,record]})>LIMITS.state);
  }
  function snapshot() {
    const currentProblem=problem??(fullFromState()?'log-full':null);
    const d=descriptor();return {recordingEnabled:state?.recordingEnabled??false,writeEpoch:state?.writeEpoch??null,noticeKey:d?.noticeKey??null,noticeVersion:1,noticeAcknowledged:!!(d&&state?.notices[d.noticeKey]===1),available:!!d,problem:currentProblem};
  }
  function requireState(){if(!state||!storage||retentionPending)throw activityError('storage-unavailable');}
  function query(request,paged=false) {
    let u;try{u=new URL(request?.url,'http://127.0.0.1');}catch{throw activityError('invalid-request');}
    const keys=[...u.searchParams.keys()];
    if(keys.length>(paged?1:0)||keys.some(k=>k!=='before')||keys.length&&(!paged||!UUID.test(u.searchParams.get('before')))) throw activityError('invalid-request');
    return u.searchParams.get('before');
  }
  const routes=[
    ['GET','state','addon-runtime-read',0,async()=>snapshot()],
    ['POST','recording','embed-governance-consent-write',512,async p=>{
      if(!exact(p,['enabled'])||typeof p.enabled!=='boolean')throw activityError('invalid-request');
      requireState();if(p.enabled&&!descriptor())throw activityError('storage-unavailable');
      if(p.enabled!==state.recordingEnabled)await save({...state,recordingEnabled:p.enabled,writeEpoch:randomUUID()});
      return {recordingEnabled:state.recordingEnabled,writeEpoch:state.writeEpoch};
    }],
    ['POST','notice','embed-governance-consent-write',512,async p=>{
      if(!exact(p,['noticeKey','version'])||p.version!==1||typeof p.noticeKey!=='string'||!NOTICE_KEY.test(p.noticeKey))throw activityError('invalid-request');
      const d=descriptor();if(!d)throw activityError('storage-unavailable');if(p.noticeKey!==d.noticeKey)throw activityError('invalid-request');
      requireState();if(state.notices[d.noticeKey]!==1)await save({...state,notices:{...state.notices,[d.noticeKey]:1}});
      return {noticeKey:d.noticeKey,noticeAcknowledged:true};
    }],
    ['POST','events','addon-record-write',2048,async p=>{
      if(!exact(p,['writeEpoch','eventId','event'])||typeof p.writeEpoch!=='string'||!UUID.test(p.writeEpoch)||typeof p.eventId!=='string'||!UUID.test(p.eventId)||!metadata(p.event))throw activityError('invalid-request');
      requireState();const d=descriptor();let reason=null;
      if(!d)reason='unavailable';else if(p.writeEpoch!==state.writeEpoch)reason='stale-epoch';else if(!state.recordingEnabled)reason='disabled';else if(state.events.some(e=>e.eventId===p.eventId))reason='duplicate';
      if(reason)return {recorded:false,reason};
      const record={version:1,eventId:p.eventId,recordedAt:new Date(now()).toISOString(),harnessId:d.harnessId,interfaceId:d.interfaceId,governance:d.governance,source:p.event.kind==='page-shared'?'local-share':'harness-report',event:metadata(p.event)};
      if(bytes(record)>LIMITS.record)throw activityError('invalid-request');
      const next={...state,events:[...state.events,record]};
      if(next.events.length>LIMITS.records||bytes(next)>LIMITS.state){problem='log-full';return {recorded:false,reason:'full'};}
      await save(next);return {recorded:true,reason:null};
    }],
    ['GET','events','addon-record-read',0,async(_p,request)=>{
      if(!state)throw activityError('storage-unavailable');const before=query(request,true);
      let end=state.events.length;if(before){end=state.events.findIndex(e=>e.eventId===before);if(end<0)throw activityError('cursor-expired');}
      const events=state.events.slice(Math.max(0,end-LIMITS.page),end).reverse();
      return {events:structuredClone(events),nextBefore:end>LIMITS.page?events.at(-1).eventId:null};
    }],
    ['POST','events/delete','addon-record-write',512,async p=>{
      if(!exact(p,[]))throw activityError('invalid-request');
      if(!storage)throw activityError('storage-unavailable');
      await save(state?{...state,events:[],writeEpoch:randomUUID()}:fresh());
      const s=snapshot();return {deleted:true,writeEpoch:s.writeEpoch,recordingEnabled:s.recordingEnabled,noticeKey:s.noticeKey,noticeAcknowledged:s.noticeAcknowledged};
    }]
  ];
  const governanceRoutes=routes.map(([method,name,requiredCapability,maxBodyBytes,operation])=>({
    method,path:'/embed-governance/'+name,requiredCapability,maxBodyBytes,loopbackHostOnly:true,requiredOrigin:'extension',errorFamily:'embed-governance',
    handler:(payload,request)=>serialize(async()=>{
      query(request,method==='GET'&&name==='events');await prune();
      return operation(payload,request);
    })
  }));
  const timer=setIntervalImpl(()=>serialize(prune).catch(()=>{}),LIMITS.prune);timer.unref?.();
  return {governanceRoutes,async close(){if(closed)return;closed=true;clearIntervalImpl(timer);await tail;await storage?.close();}};
}
```

Append the ownership row:

```markdown
| `browser-first/host/embed-governance-host-service.mjs` | Serialized recording, notices, metadata validation and 30-day retention | Private feature snapshots and current host descriptor | Six `/embed-governance/*` routes: read state via addon-runtime-read; recording and notice via embed-governance-consent-write; append/delete via addon-record-write; paged events via addon-record-read | Proxy parsing, harness execution, grants, trusted receipts or unrelated files |
```

- [ ] Run `node --test browser-first/test/embed-governance-host-service.test.mjs browser-first/test/embed-governance-storage.test.mjs`. Expect pass.
- [ ] Red evidence: remove each of the epoch comparison, disabled flag check, descriptor notice-key equality, exact submission-key check, retention timestamp filter and storage revalidation one at a time. Require the corresponding tests above to fail; the read-time guard test also checks that unsafe deletion is refused. Restore every edit. Add this capacity/race regression to the same test file before treating limits as complete:

```js
test('capacity preserves history and queued pre-delete appends cannot resurrect it',async t=>{
  let raw=null;
  const f=await fixture(t,{storageFactory:async()=>({read:async()=>raw,write:async v=>{raw=v;},close:async()=>{}})});
  const s=await f.call('recording',{enabled:true});
  const initial=JSON.parse(raw),record={version:1,eventId:randomUUID(),recordedAt:new Date(Date.UTC(2026,9,13)).toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',source:'harness-report',event:{kind:'reply-started'}};
  await f.s.close();raw=JSON.stringify({...initial,events:Array.from({length:10000},()=>({...record,eventId:randomUUID()}))});
  const next=await f.make();t.after(()=>next.close());
  const before=raw;
  assert.equal((await f.call('state',{},'GET',next)).problem,'log-full');
  assert.deepEqual(await f.call('events',{writeEpoch:s.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}},'POST',next),{recorded:false,reason:'full'});
  assert.equal(raw,before);assert.equal((await f.call('state',{},'GET',next)).problem,'log-full');
  const deletion=f.call('events/delete',{},'POST',next);
  const stale=f.call('events',{writeEpoch:s.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}},'POST',next);
  await deletion;assert.equal((await stale).reason,'stale-epoch');assert.deepEqual((await f.call('events',{},'GET',next)).events,[]);
  assert.equal((await f.call('state',{},'GET',next)).problem,null);
  await next.close();const afterDelete=await f.make();t.after(()=>afterDelete.close());
  assert.equal((await f.call('state',{},'GET',afterDelete)).problem,null);
});
```

Temporarily remove the record-count bound, require this test to fail, restore and rerun. Capacity test avoids 10,000 filesystem syncs by injecting only the storage adapter.

- [ ] Run this exact guard-mutation matrix after green. Each `rig-mutate` invocation must return zero (behavioral failure under mutation and byte-identical restoration). Inspect any failure; import or syntax errors are not guard evidence. The strings below are exact edits, not patterns.

```bash
python3 - <<'PYMUTATE'
from pathlib import Path
import shlex, subprocess
rig=str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate')
mutations=[('browser-first/host/embed-governance-host-service.mjs', [('p.writeEpoch!==state.writeEpoch', 'false')]), ('browser-first/host/embed-governance-host-service.mjs', [("!state.recordingEnabled)reason='disabled'", "false)reason='disabled'")]), ('browser-first/host/embed-governance-host-service.mjs', [("if(p.noticeKey!==d.noticeKey)throw activityError('invalid-request');", '')]), ('browser-first/host/embed-governance-host-service.mjs', [("!exact(p,['writeEpoch','eventId','event'])||", '')]), ('browser-first/host/embed-governance-host-service.mjs', [('!UUID.test(p.eventId)', 'false')]), ('browser-first/host/embed-governance-host-service.mjs', [('state.events.some(e=>e.eventId===p.eventId)', 'false')]), ('browser-first/host/embed-governance-host-service.mjs', [("if(!d)reason='unavailable'", "if(false)reason='unavailable'")]), ('browser-first/host/embed-governance-host-service.mjs', [('state.events.filter(e=>Date.parse(e.recordedAt)>now()-LIMITS.retention)', 'state.events.slice()')]), ('browser-first/host/embed-governance-host-service.mjs', [('async function readDisk() {', 'async function readDisk() { if(state)return;')]), ('src/core/embed-governance-contract.js', [('records:10000', 'records:10001')]), ('src/core/embed-governance-contract.js', [('state:10*1024*1024', 'state:10*1024*1024+1024')])]
test_command='node --test browser-first/test/embed-governance-host-service.test.mjs'
for filename,changes in mutations:
    edit='from pathlib import Path\np=Path('+repr(filename)+')\ns=p.read_text()\n'
    for before,after in changes:
        edit+='assert '+repr(before)+' in s\ns=s.replace('+repr(before)+','+repr(after)+',1)\n'
    edit+='p.write_text(s)\n'
    try:
        subprocess.run([rig,filename,'python3 -c '+shlex.quote(edit),test_command],check=True)
    finally:
        subprocess.run(['node','scripts/prepare-embed-governance.mjs'],check=True)
subprocess.run(shlex.split('node --test browser-first/test/embed-governance-host-service.test.mjs'),check=True)
PYMUTATE
```

- [ ] Commit:

```bash
git diff --check
git add browser-first/host/embed-governance-host-service.mjs browser-first/test/embed-governance-host-service.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(embed): persist consent and bounded metadata history"
```
### Task 6: Enforce the governance transport family and compose the service

**Live amendment 2026-10-15 (Brief O).** The conductor's real Chrome for Testing
1217 evidence table in [Routes and authorization](embed-governance-design.md#routes-and-authorization)
shows absent Origin on extension state/events GETs and exact extension Origin
on notice POST, with `none` / `cors` / `empty` fetch metadata on all three.
This supersedes Task 6's original reject-missing-Origin assumption and helper
call sites below. The governance family block uses
`governanceRequestOrigin(request, extensionOrigin)`. The generic
`requiredOrigin: 'extension'` check uses `governanceRequestOrigin` only when
`route.errorFamily === 'embed-governance'`, and `exactExtensionOrigin` otherwise.
Accept exactly one raw Origin equal to the configured extension origin, or
`request.method === 'GET'`, no raw Origin header, and exactly one raw header
each of `Sec-Fetch-Site: none`, `Sec-Fetch-Mode: cors` and
`Sec-Fetch-Dest: empty` (exact, case-sensitive values). A present Origin cannot
use the GET alternative. POST requires exact Origin. Missing configured origin
still fails closed; Host, bridge-token and capability-token gates are unchanged.
Fetch metadata separates extension GETs from harness pages, web pages and
navigations, preserving the intent. Local processes can forge headers; tokens
still gate access.

- [ ] Cover both GET routes with raw HTTP acceptance and rejection cases for
  missing/duplicate metadata, case changes, same-origin/same-site/cross-site,
  navigate/non-empty dest, present invalid/duplicate Origin, POST without exact
  Origin, missing configured origin, Host and credential failures.
- [ ] Use `~/.claude/skills/resonant-rig/scripts/rig-mutate` to disable the GET
  alternative and require the acceptance test to fail; separately allow
  `same-origin` and require the harness-iframe rejection test to fail. Restore
  byte-identically and rerun the deterministic checks. Live proof belongs to
  the conductor.


**Files:**
- Modify: `browser-first/host/bridge-server.mjs`, `browser-first/host/bridge-capability-tokens.mjs`, `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js`, `browser-first/host/run-bridge-minimal.mjs`, `browser-first/test/bridge-route-capability-audit.test.mjs`, `docs/architecture/MODULE-OWNERSHIP.md`
- Create/Test: `browser-first/test/embed-governance-transport.test.mjs`

**Interfaces:**
- Consumes: `createEmbedGovernanceHostService({userRoot,repoRoot,getDescriptor,now,storageFactory,setIntervalImpl,clearIntervalImpl}):Promise<{governanceRoutes:Array<object>,close():Promise<void>}>`, `service.getDescriptor():EmbedHarnessDescriptor|null`, `service.extensionOrigin:string|null`, `publicActivityError(error:unknown):{status:number,payload:{ok:false,code:string,error:string}}`, `activityError(code:string):Error & {code:string}`.
- Produces: `classifyEmbedGovernanceTarget(target: string): { pathname:string, malformed:boolean } | null`; extends existing `readJsonBody(request, boundaryOwned=false, maxBodyBytes, errorFamily)` with raw-byte counting for governance; keeps `authorizeBridgeRoute(request, options)` and existing route handlers compatible.

- [ ] Write the failing test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridgeServer, evaluateBridgeRequestForSelfTest } from '../host/bridge-server.mjs';
import { createEmbedHostService } from '../host/embed-host-service.mjs';
import { createEmbedGovernanceHostService } from '../host/embed-governance-host-service.mjs';
import { ERRORS } from '../../src/core/embed-governance-contract.js';
const origin='chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl';
const caps={'addon-runtime-read':'read','addon-runtime-control':'control','addon-record-read':'records','addon-record-write':'write','embed-governance-consent-write':'consent'};
async function fixture(t) {
  const userRoot=await mkdtemp(join(await realpath(tmpdir()),'embed-http-'));
  const service=await createEmbedGovernanceHostService({userRoot});
  const embed=createEmbedHostService({env:{}});let calls=0;
  const routes=service.governanceRoutes.map(r=>({...r,handler:async(...args)=>{calls++;return r.handler(...args);}}));
  const options={port:0,host:'127.0.0.1',bridgeToken:'bridge',bridgeCapabilityTokens:caps,extensionOrigin:origin,allowedOrigins:['chrome-extension://*'],routes,embedService:embed};
  const server=await startBridgeServer(options),port=server.address().port;
  t.after(async()=>{await service.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(userRoot,{recursive:true,force:true});});
  const request=async(path='/embed-governance/state',method='GET',token='read',extra={})=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':token,...extra},...(method==='POST'?{body:'{}'}:{})});
    assert.equal(response.headers.get('cache-control'),'no-store');
    return {status:response.status,payload:response.status===204?await response.text():await response.json()};
  };
  const rawRequest=(path,extra={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path,method:'GET',headers:{Host:`127.0.0.1:${port}`,Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':'read',...extra}},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('error',reject);res.on('end',()=>{
        try{assert.equal(res.headers['cache-control'],'no-store');resolve({status:res.statusCode,payload:JSON.parse(body)});}catch(error){reject(error);}
      });
    });
    req.on('error',reject);req.setTimeout(1500,()=>req.destroy(Error('Raw request timed out')));req.end();
  });
  return {request,rawRequest,port,options,routes,calls:()=>calls};
}
function error(result,code){assert.deepEqual(result,{status:ERRORS[code][0],payload:{ok:false,code,error:ERRORS[code][1]}});}
test('family authentication precedes method lookup and wildcards never authorize',async t=>{
  const f=await fixture(t);
  error(await f.request('/embed-governance/state','GET','read',{'X-ResonantOS-Bridge-Token':''}), 'unauthorized');
  error(await f.request('/embed-governance/state','GET','read',{Origin:''}), 'forbidden');
  error(await f.request('/embed-governance/state','GET','read',{Origin:'chrome-extension://foreign'}), 'forbidden');
  error(await f.request('/embed-governance/state','GET','read',{Origin:`http://127.0.0.1:${f.port}`}), 'forbidden');
  const beforeForged=f.calls();
  error(await f.rawRequest('/embed-governance/state',{Host:'evil.test'}), 'forbidden');
  assert.equal(f.calls(),beforeForged);
  error(await f.request('/embed-governance/state','PUT','read'), 'method-not-allowed');
  error(await f.request('/embed-governance/unknown'), 'unknown-route');
  for(const token of ['control','write']) for(const path of ['recording','notice']) error(await f.request('/embed-governance/'+path,'POST',token),'forbidden');
  error(await f.request('/embed-governance/state?x=1'), 'invalid-request');
  const beforeMalformed=f.calls();
  for(const path of ['/embed-governance/state?x=%ZZ','/embed-governance/%ZZ'])error(await f.rawRequest(path), 'invalid-request');
  assert.equal(f.calls(),beforeMalformed);
  assert.deepEqual(await f.request('/embed-governance/state','OPTIONS'),{status:204,payload:''});
  assert.equal((await f.request()).status,200);
});
test('self-test uses the same method-independent family and fixed exception serializer',async t=>{
  const f=await fixture(t),headers={host:`127.0.0.1:${f.port}`,origin,'x-resonantos-bridge-token':'bridge','x-resonantos-bridge-capability-token':'read'};
  const rawHeaders=['Host',headers.host,'Origin',origin];
  const run=(url,method='GET',changes={})=>evaluateBridgeRequestForSelfTest({...f.options,listenerPort:f.port,url,method,headers,rawHeaders,...changes});
  error(await run('/embed-governance/state','PUT'),'method-not-allowed');
  error(await run('/embed-governance/state','GET',{rawHeaders:[...rawHeaders,'Origin',origin]}),'forbidden');
  error(await run('/embed-governance/state','GET',{routes:f.routes.map(r=>({...r,handler:()=>{throw Error('CANARY');}}))}),'storage-unavailable');
  error(await run('/embed-governance/state','GET',{headers:{...headers,'content-length':'1'}}),'invalid-request');
});
test('chunked POST limits reject before stream end and never invoke a service',async t=>{
  const f=await fixture(t);
  for(const [path,limit,token] of [['recording',512,'consent'],['events',2048,'write']]) {
    const before=f.calls();
    const result=await new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:f.port,path:'/embed-governance/'+path,method:'POST',headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':token,'Transfer-Encoding':'chunked'}},res=>{
        let body='';res.on('data',c=>body+=c);res.on('end',()=>{req.destroy();resolve({status:res.statusCode,payload:JSON.parse(body)});});
      });
      req.on('error',reject);req.setTimeout(1500,()=>{req.destroy();reject(Error('Did not reject before end'));});
      req.write(Buffer.alloc(limit+1,32));
    });
    error(result,'request-too-large');assert.equal(f.calls(),before);
  }
});
```

- [ ] Run `node --test browser-first/test/embed-governance-transport.test.mjs`. Expect the no-store, Origin, wrong-method and streaming-boundary assertions to fail. Keep the behavioral red result.
- [ ] Add this import and functions to `bridge-server.mjs` before `routeError`:

```js
import { activityError, publicActivityError } from '../../src/core/embed-governance-contract.js';
export function classifyEmbedGovernanceTarget(target) {
  const raw=String(target??'/');
  const path=raw.replace(/^https?:\/\/[^/]+/i,'').split('?')[0];
  let decoded;try{decoded=decodeURIComponent(path);}catch{decoded=path;}
  if(![path,decoded].some(p=>p==='/embed-governance'||p.startsWith('/embed-governance/')))return null;
  let pathname=path,malformed=false;
  try {
    const u=new URL(raw,'http://127.0.0.1');pathname=u.pathname;
    malformed=!/^\/(?!\/)[^\s#\\]*$/.test(raw)||/%(?![0-9a-f]{2})/i.test(raw)||pathname!==path||decoded!==path;
  }catch{malformed=true;}
  return {pathname,malformed};
}
function exactExtensionOrigin(request,extensionOrigin) {
  const origins=[];
  for(let i=0;i<(request.rawHeaders??[]).length;i+=2)if(String(request.rawHeaders[i]).toLowerCase()==='origin')origins.push(request.rawHeaders[i+1]);
  return typeof extensionOrigin==='string'&&/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin)&&origins.length===1&&origins[0]===extensionOrigin&&request.headers.origin===extensionOrigin;
}
function governanceBodyShape(request,body) {
  if(request.method==='GET'&&(request.headers['transfer-encoding']!==undefined||Number(request.headers['content-length']??0)!==0||Object.keys(body??{}).length))throw activityError('invalid-request');
}
```

Replace `routeError` and `authorizeBridgeRoute` in full:

```js
function routeError(error,family) {
  if(family==='embed-governance')return publicActivityError(error);
  return family==='harness'?publicHarnessTransportError(error):boundaryError(error);
}
export function authorizeBridgeRoute(request, {
  routes=[],bridgeToken,bridgeCapabilityTokens={},capabilityBootstrapToken,
  listenerPort=request.socket?.localPort,getPublicPort=()=>undefined,extensionOrigin,allowedOrigins=[]
}={}) {
  const family=classifyEmbedGovernanceTarget(request.url);
  let route;
  try{route=compileRoutes(routes).get(routeKey(request.method,request.url));}catch{if(!family)throw Error('Invalid route');}
  const owned=!!family||boundaryPath(request.url)||route?.loopbackHostOnly;
  const refuse=(status,code,error)=>{
    if(family){const mapped={400:'invalid-request',401:'unauthorized',403:'forbidden',404:'unknown-route',405:'method-not-allowed'};return publicActivityError(activityError(mapped[status]));}
    return route?.errorFamily==='harness'?publicHarnessTransportError({code},status):owned?publicOpenCodeError(code):{status,payload:{ok:false,error}};
  };
  if(!isAuthorizedBridgeRequest(request,bridgeToken))return refuse(401,'OPENCODE_BRIDGE_UNAUTHORIZED','Unauthorized browser-first bridge request.');
  if(family) {
    // IncomingMessage headers are prototype accessors; spreading request loses them.
    if(!validateLoopbackHost({url:'/embed-governance/state',headers:request.headers,rawHeaders:request.rawHeaders,socket:request.socket},{listenerPort,getPublicPort})||!exactExtensionOrigin(request,extensionOrigin))return refuse(403,'OPENCODE_HOST_REJECTED','Host rejected.');
    if(family.malformed)return refuse(400,'OPENCODE_INVALID_REQUEST','Invalid request.');
    if(!route)return refuse(routes.some(r=>r.path===family.pathname)?405:404,'OPENCODE_ROUTE_UNKNOWN','Unknown route.');
  }
  if(!route)return refuse(404,'OPENCODE_ROUTE_UNKNOWN','Unknown browser-first bridge route.');
  if(route.requiredCapabilityBootstrap&&!isAuthorizedCapabilityBootstrapRequest(request,capabilityBootstrapToken))return refuse(403,'OPENCODE_CAPABILITY_REQUIRED','Bridge route requires capability bootstrap authorization.');
  if(!route.requiredCapability&&!route.requiredCapabilityBootstrap)return refuse(403,'OPENCODE_CAPABILITY_REQUIRED','Bridge route declares no capability; refused by default.');
  if(route.requiredCapability&&!isAuthorizedCapabilityRequest(request,bridgeCapabilityTokens,route.requiredCapability))return refuse(403,'OPENCODE_CAPABILITY_REQUIRED',`Bridge route requires ${route.requiredCapability} capability.`);
  if(route.loopbackHostOnly&&!validateLoopbackHost(request,{listenerPort,getPublicPort}))return refuse(403,'OPENCODE_HOST_REJECTED','Host rejected.');
  if(route.requiredOrigin==='extension'&&!exactExtensionOrigin(request,extensionOrigin))return refuse(403,'OPENCODE_HOST_REJECTED','Origin rejected.');
  if(route.errorFamily==='harness'&&request.headers?.origin&&pickAllowedOrigin(request.headers,extensionOrigin,allowedOrigins)!==request.headers.origin)return refuse(403,'OPENCODE_HOST_REJECTED','Origin rejected.');
  return {route};
}
```

Replace `readJsonBody` with this complete function. Its default branch is preserved byte-for-byte:

```js
async function readJsonBody(request, boundaryOwned = false, maxBodyBytes, errorFamily) {
  if(errorFamily==='embed-governance') {
    return new Promise((resolve,reject)=>{
      const chunks=[];let bytes=0,finished=false;
      const fail=code=>{if(finished)return;finished=true;chunks.length=0;reject(activityError(code));};
      request.on('data',chunk=>{
        if(finished)return;
        // No setEncoding: IncomingMessage chunks are Buffers, counted before decoding.
        bytes+=chunk.length;
        if(bytes>maxBodyBytes){fail(maxBodyBytes===0?'invalid-request':'request-too-large');return;}
        chunks.push(chunk);
      });
      request.once('end',()=>{
        if(finished)return;
        try {
          const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
          if(maxBodyBytes===0){finished=true;resolve({});return;}
          const value=JSON.parse(text);finished=true;resolve(value);
        } catch {fail('invalid-request');}
      });
      request.once('error',()=>fail('invalid-request'));
      request.once('aborted',()=>fail('invalid-request'));
    });
  }
  return new Promise((resolve, reject) => {
    let body = "", bytes = 0, rejected = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (rejected) return;
      bytes += Buffer.byteLength(chunk);
      if (boundaryOwned && bytes > 1048576) {
        rejected = true; body = "";
        reject(new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST"));
        return;
      }
      body += chunk;
      if (!boundaryOwned && body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}
```

Apply these remaining exact transport edits:

```bash
python3 - <<'PY'
from pathlib import Path
p=Path('browser-first/host/bridge-server.mjs');s=p.read_text()
a='errorFamily = compileRoutes(routes).get(routeKey(method, url))?.errorFamily;'
s=s.replace(a,"errorFamily = classifyEmbedGovernanceTarget(url) ? 'embed-governance' : compileRoutes(routes).get(routeKey(method, url))?.errorFamily;\n    owned ||= errorFamily === 'embed-governance';",1)
a='errorFamily = compileRoutes(internalRoutes).get(routeKey(request.method, request.url))?.errorFamily;'
s=s.replace(a,"errorFamily = classifyEmbedGovernanceTarget(request.url) ? 'embed-governance' : compileRoutes(internalRoutes).get(routeKey(request.method, request.url))?.errorFamily;\n      owned ||= errorFamily === 'embed-governance';\n      if (errorFamily === 'embed-governance') response.setHeader('Cache-Control', 'no-store');",1)
a='    const result = await route.handler(method === "POST" ? body : {}, request);'
s=s.replace(a,"    if (errorFamily === 'embed-governance') {\n      governanceBodyShape(request, body);\n      if (method === 'POST' && Buffer.byteLength(JSON.stringify(body)) > route.maxBodyBytes) throw activityError('request-too-large');\n    }\n"+a,1)
a='writeJson(response, 403, {ok:false,error:"Client IP not allowlisted for browser-first bridge."}, extensionOrigin, request.headers, allowedOrigins);'
s=s.replace(a,"writeJson(response, 403, errorFamily === 'embed-governance' ? publicActivityError(activityError('forbidden')).payload : {ok:false,error:'Client IP not allowlisted for browser-first bridge.'}, extensionOrigin, request.headers, allowedOrigins);",1)
a="      if (route.errorFamily === 'harness' && request.method === 'GET' &&"
s=s.replace(a,"      if (errorFamily === 'embed-governance') governanceBodyShape(request, {});\n"+a,1)
a='      try { if (request.method === "POST") body = await readJsonBody(request, owned); }\n      catch (error) { if (owned) throw new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST"); throw error; }'
b='''      try {
        if (request.method === "POST" || errorFamily === 'embed-governance') body = await readJsonBody(request, owned, route.maxBodyBytes, errorFamily);
      } catch (error) {
        if (errorFamily === 'embed-governance') throw error;
        if (owned) throw new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST");
        throw error;
      }'''
assert a in s;s=s.replace(a,b,1)
s=s.replace('    if (error instanceof HarnessTransportError)', "    if (errorFamily === 'embed-governance') return publicActivityError(error);\n    if (error instanceof HarnessTransportError)",1)
p.write_text(s)
PY
```

Add the six exact entries to `BRIDGE_ROUTE_CAPABILITIES`:

```js
  'GET /embed-governance/state': 'addon-runtime-read',
  'POST /embed-governance/recording': 'embed-governance-consent-write',
  'POST /embed-governance/notice': 'embed-governance-consent-write',
  'POST /embed-governance/events': 'addon-record-write',
  'GET /embed-governance/events': 'addon-record-read',
  'POST /embed-governance/events/delete': 'addon-record-write',
```

Add one mint spec:

```js
  { capability: 'embed-governance-consent-write', arg: 'embed-governance-consent-token', env: 'RESONANTOS_BROWSER_FIRST_EMBED_GOVERNANCE_CONSENT_TOKEN' },
```

In `browser-first/host/run-bridge-minimal.mjs` add the service import, construct immediately after `const { embedRoutes } = embedService;`, spread `...governanceRoutes,` in `bridgeRoutes`, close before every explicit `process.exit` following service construction and first in `shutdown`:

```js
import { createEmbedGovernanceHostService } from './embed-governance-host-service.mjs';
```

```js
const governanceService = await createEmbedGovernanceHostService({
  userRoot: userRoot(), repoRoot,
  getDescriptor: () => embedService.extensionOrigin === resonantExtensionOrigin ? embedService.getDescriptor() : null
});
const { governanceRoutes } = governanceService;
```

```js
await governanceService.close();
```

The exit sites after construction are `if (selfTestHandled)` and the missing extension-manifest branch. Replace the server-start declaration with:

```js
let bridgeInfo;
try {
  bridgeInfo = await startBridgeServerWithFallback({
    port: bridgePort,
    bridgeToken,
    bridgeCapabilityTokens,
    capabilityBootstrapToken,
    extensionOrigin: resonantExtensionOrigin,
    routes: bridgeRoutes,
    embedService,
    host: getBridgeHost(),
    getPublicPort,
  });
} catch (error) {
  await governanceService.close();
  throw error;
}
```

In the route audit import `realpath` with the existing fs imports and add `import { createEmbedGovernanceHostService } from '../host/embed-governance-host-service.mjs';`. After constructing `embed`, construct:

```js
const governance = await createEmbedGovernanceHostService({ userRoot: await realpath(root), getDescriptor: () => embed.getDescriptor() });
```

Add `governanceRoutes: governance.governanceRoutes,` to `routeArrays` and `await governance.close();` before `embed.close()` in its finally. Append:

```js
test('governance routes have exact capabilities, origin and byte boundaries',async()=>{
  await withBridgeRoutes(async(_routes,arrays)=>{
    assert.deepEqual(arrays.governanceRoutes.map(r=>[bridgeRouteKey(r),r.requiredCapability,r.maxBodyBytes]),[
      ['GET /embed-governance/state','addon-runtime-read',0],
      ['POST /embed-governance/recording','embed-governance-consent-write',512],
      ['POST /embed-governance/notice','embed-governance-consent-write',512],
      ['POST /embed-governance/events','addon-record-write',2048],
      ['GET /embed-governance/events','addon-record-read',0],
      ['POST /embed-governance/events/delete','addon-record-write',512]
    ]);
    for(const r of arrays.governanceRoutes){assert.equal(r.loopbackHostOnly,true);assert.equal(r.requiredOrigin,'extension');assert.equal(r.errorFamily,'embed-governance');}
  });
});
```

Replace these two existing ownership rows in the same task:

```markdown
| `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js` | Bridge target policy, authenticated method/path capability mapping, scoped token acquisition and request transport | Generated bridge config, target override and memory-only scoped tokens | Existing request headers and token cache, including the consent-write transport scope | Consent decisions, SDK grants, passing tokens into UI callbacks or filesystem access |
| `browser-first/host/run-bridge-minimal.mjs` | Composition, token creation, startup and shutdown | Service constructors, existing user root, descriptor provider and operator environment | Construct governance service, compose its routes and close owned resources with the listener | Inline event, consent, storage or retention policy |
```

Update the bridge-server ownership row's Owns field to `HTTP transport, listener binding, authentication, exact extension-origin authorization, fixed error families, raw per-route byte limits, unchanged empty OPTIONS preflight and dispatch`. Append a capability-token row:

```markdown
| `browser-first/host/bridge-capability-tokens.mjs` | Canonical extension transport capability mint map | Operator token overrides | Scoped per-capability tokens including embed-governance-consent-write | Human consent decisions, SDK grants or harness capabilities |
```

- [ ] Run `node --test browser-first/test/embed-governance-transport.test.mjs browser-first/test/bridge-server.test.mjs browser-first/test/bridge-route-capability-audit.test.mjs browser-first/test/bridge-capability-token-consistency.test.mjs`; expect pass. Add real HTTP cases for cookie-only, malformed JSON, GET body and IP refusal using this full code:

```js
test('cookie cannot authorize, parser errors stay fixed, GET bodies and IP refusal never dispatch',async t=>{
  const f=await fixture(t);
  error(await f.request('/embed-governance/state','GET','',{'X-ResonantOS-Bridge-Token':'',Cookie:'ros_embed=fixture'}),'unauthorized');
  async function raw(method,body,headers={}) {
    return new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:f.port,path:'/embed-governance/state',method,headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':'read','Content-Length':Buffer.byteLength(body),...headers}},res=>{
        let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,payload:JSON.parse(data)}));
      });req.on('error',reject);req.end(body);
    });
  }
  error(await raw('GET','x'),'invalid-request');
  error(await raw('GET','',{Origin:[origin,origin]}),'forbidden');
  const response=await fetch(`http://127.0.0.1:${f.port}/embed-governance/events/delete`,{method:'POST',headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':'write'},body:'{'});
  error({status:response.status,payload:await response.json()},'invalid-request');
  const server=await startBridgeServer({...f.options,allowedCidrs:['192.0.2.1/32']});t.after(()=>new Promise(r=>server.close(r)));
  const denied=await fetch(`http://127.0.0.1:${server.address().port}/embed-governance/state`);
  assert.equal(denied.headers.get('cache-control'),'no-store');error({status:denied.status,payload:await denied.json()},'forbidden');
});
```

- [ ] Red evidence: the pre-fix tests cover the existing transport guards being tightened. Additionally mutate `exactExtensionOrigin` to return true, remove the capability-token check for this family, and change each route body limit to 1MiB, one edit at a time. Require Origin, consent-scope and before-stream-end tests respectively to fail. Restore, rerun. No event or exception payload may appear in diagnostics.
- [ ] Run this exact guard-mutation matrix after green. Each `rig-mutate` invocation must return zero (behavioral failure under mutation and byte-identical restoration). Inspect any failure; import or syntax errors are not guard evidence. The strings below are exact edits, not patterns.

```bash
python3 - <<'PYMUTATE'
from pathlib import Path
import shlex, subprocess
rig=str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate')
mutations=[('browser-first/host/bridge-server.mjs', [('function exactExtensionOrigin(request,extensionOrigin) {', 'function exactExtensionOrigin(request,extensionOrigin) { return true;')]), ('browser-first/host/bridge-server.mjs', [('if(route.requiredCapability&&!isAuthorizedCapabilityRequest(request,bridgeCapabilityTokens,route.requiredCapability))', 'if(!family&&route.requiredCapability&&!isAuthorizedCapabilityRequest(request,bridgeCapabilityTokens,route.requiredCapability))')]), ('browser-first/host/bridge-server.mjs', [('if(bytes>maxBodyBytes)', 'if(bytes>1048576)')]), ('browser-first/host/bridge-server.mjs', [('if(!isAuthorizedBridgeRequest(request,bridgeToken))', 'if(!family&&!isAuthorizedBridgeRequest(request,bridgeToken))')]), ('browser-first/host/bridge-server.mjs', [("if(family==='embed-governance')return publicActivityError(error);", "if(family==='embed-governance')return {status:503,payload:{ok:false,error:error.message}};")]), ('browser-first/host/bridge-server.mjs', [('function governanceBodyShape(request,body) {', 'function governanceBodyShape(request,body) { return;')])]
test_command='node --test browser-first/test/embed-governance-transport.test.mjs'
for filename,changes in mutations:
    edit='from pathlib import Path\np=Path('+repr(filename)+')\ns=p.read_text()\n'
    for before,after in changes:
        edit+='assert '+repr(before)+' in s\ns=s.replace('+repr(before)+','+repr(after)+',1)\n'
    edit+='p.write_text(s)\n'
    try:
        subprocess.run([rig,filename,'python3 -c '+shlex.quote(edit),test_command],check=True)
    finally:
        subprocess.run(['node','scripts/prepare-embed-governance.mjs'],check=True)
subprocess.run(shlex.split('node --test browser-first/test/embed-governance-transport.test.mjs'),check=True)
PYMUTATE
```

- [ ] Commit:

```bash
git diff --check
git add browser-first/host/bridge-server.mjs browser-first/host/bridge-capability-tokens.mjs browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js browser-first/host/run-bridge-minimal.mjs browser-first/test/bridge-route-capability-audit.test.mjs browser-first/test/embed-governance-transport.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(bridge): enforce embed governance transport boundaries"
```
### Task 11: Write and syntax-check conductor-only live proof

Screenshot integration proof requires `RESONANTOS_EMBED_LIVE_CONTROL`, an absolute path to a conductor-owned executable outside the repository; a missing, invalid or non-executable hook fails closed at startup. The hook accepts `restart`, `stop`, `start`, `storage-fail` and `storage-restore`; the conductor preserves the disposable user root and upstream and refreshes the disposable extension configuration on restart. Screenshot-mode restart verification requires bridge credentials that rotate on restart. Do not pin `RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN` for live proof: a pinned token makes the check fail closed. Start/restart proof requires a changed digest of the parsed bridge token, rejection of the old token with HTTP 401, and a non-401 response to the new token from the listening bridge. Storage failure proof reopens the damaged store, checks isolation, then restores and restarts it. Exit zero records that the conductor ran the requested action in `summary.controlActions`; it is not owner proof, and screenshot attestations remain pending owner review.

**Files:**
- Modify: `browser-first/test/embed-live.mjs`, `browser-first/README.md`
- Create/Test: `browser-first/test/embed-live-contract.test.mjs`

**Interfaces:**
- Consumes: running conductor-managed spike bridge, Manolo's real container, disposable extension copy, external test-owned user root; environment `RESONANTOS_EMBED_LIVE_OUT`, `RESONANTOS_EMBED_LIVE_USER_ROOT`, `RESONANTOS_EMBED_LIVE_EXTENSION_ROOT`, `RESONANTOS_EMBED_LIVE_VERSION`, optional `RESONANTOS_EMBED_LIVE_STAGE=upstream`, optional `RESONANTOS_LIVE_CHROME_PATH`.
- Produces: external `embed-governance-summary.json` containing version, fixed check names and booleans only. A failed/missing protocol field exits nonzero. Workers execute only syntax/contract checks, never the live command.

Execute this proof-authoring task now, after Task 6 and before Task 7. Task numbers remain stable for existing cross-references. Run the `upstream` stage before implementing that mapping, then run the full integrated stage after Tasks 7–10. The conductor owns starting/restarting the bridge/container and providing its disposable extension copy with matching generated bridge configuration. The proof does not launch or inspect the container, read its credentials, or infer its product identity from an endpoint.

- [ ] Write the failing deterministic script-contract test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
test('live proof is syntax-valid, conductor-owned and checks every required upstream field',()=>{
  const path=new URL('./embed-live.mjs',import.meta.url),source=readFileSync(path,'utf8');
  const syntax=spawnSync(process.execPath,['--check',path.pathname],{encoding:'utf8',shell:false});assert.equal(syntax.status,0,syntax.stderr);
  for(const text of ['EMBED-UPSTREAM-1','RESONANTOS_EMBED_LIVE_USER_ROOT','RESONANTOS_EMBED_LIVE_VERSION','conversationId','conversation.changed','turn.started','turn.finished','tool.finished','toolSuccess','toolError'])assert.ok(source.includes(text),text);
  assert.equal(source.includes('state.last.push(event.data)'),false);
  assert.equal(source.includes('__barProofContexts'),false);
  assert.ok(source.includes("stage==='upstream'"));
  assert.ok(source.includes("assert.ok(slots&&typeof slots==='object')"));
});
```

- [ ] Run `node --test browser-first/test/embed-live-contract.test.mjs`; expect assertion failure for `EMBED-UPSTREAM-1` against the old proof.
- [ ] Replace `browser-first/test/embed-live.mjs` with the complete proof below. The conductor answers fixed prompts with `yes`; those answers are explicit human attestations, separate from programmatic observations. Product/version verification is not replaced by a synthetic fixture.

```js
#!/usr/bin/env node
// EMBED-UPSTREAM-1 and final live acceptance. Conductor only; never a deterministic test.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chromium } from 'playwright';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const env=process.env,stage=env.RESONANTOS_EMBED_LIVE_STAGE??'integration';
const version=env.RESONANTOS_EMBED_LIVE_VERSION;
assert.ok(typeof version==='string'&&/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version),'Supply the verified upstream version, not an endpoint.');
assert.ok(['upstream','integration'].includes(stage));
const repository=await realpath(resolve(import.meta.dirname,'../..'));
async function external(name,create=false) {
  const value=env[name];assert.ok(value&&isAbsolute(value),name+' must be an absolute test-owned path');
  const lexical=relative(repository,resolve(value));
  assert.ok(lexical&&(lexical==='..'||lexical.startsWith('..'+sep)||isAbsolute(lexical)),name+' must be outside Git');
  let ancestor=resolve(value);
  for(;;){try{await lstat(ancestor);break;}catch(error){if(error.code!=='ENOENT')throw error;ancestor=dirname(ancestor);}}
  const ancestorRelative=relative(repository,await realpath(ancestor));
  assert.ok(ancestorRelative&&(ancestorRelative==='..'||ancestorRelative.startsWith('..'+sep)||isAbsolute(ancestorRelative)),name+' resolves inside Git');
  if(create)await mkdir(value,{recursive:true,mode:0o700});
  const stat=await lstat(value);assert.equal(stat.isSymbolicLink(),false);
  const canonical=await realpath(value),r=relative(repository,canonical);
  assert.ok(r&&(r==='..'||r.startsWith('..'+sep)||isAbsolute(r)),name+' must be outside Git');return canonical;
}
const out=await external('RESONANTOS_EMBED_LIVE_OUT',true),userRoot=await external('RESONANTOS_EMBED_LIVE_USER_ROOT'),extensionPath=await external('RESONANTOS_EMBED_LIVE_EXTENSION_ROOT');
const extensionId='cdpdmmalhmokbfcfgogoepnjplaakgnl',panelUrl=`chrome-extension://${extensionId}/src/side-panel.html?agentView=embed`;
const statePath=join(userRoot,'BrowserFirst','EmbedGovernance','state.json');
const profile=await mkdtemp(join(await realpath(tmpdir()),'embed-live-profile-'));
const terminal=createInterface({input:stdin,output:stdout});
const summary={pass:false,stage,upstreamVersion:version,checks:{},protocol:{}};
let context,page,workspace;
const fixtureTitle='Fixture '+randomUUID(),fixture=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(`<title>${fixtureTitle}</title><h1>Local page sharing fixture</h1>`);});
async function attest(key,text){assert.equal((await terminal.question(text+' Type yes when verified: ')).trim(),'yes');summary.checks[key]=true;}
async function launch() {
  context=await chromium.launchPersistentContext(profile,{headless:false,viewport:{width:420,height:900},args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`,'--no-first-run','--no-default-browser-check'],...(env.RESONANTOS_LIVE_CHROME_PATH?{executablePath:env.RESONANTOS_LIVE_CHROME_PATH}:{})});
  await context.addInitScript(()=>{
    window.__embedProtocol={status:false,conversationId:false,conversationChanged:false,replyStarted:false,replyFinished:false,toolSuccess:false,toolError:false};
    window.addEventListener('message',event=>{
      const frame=document.querySelector('#embed-root iframe');if(!frame||event.source!==frame.contentWindow||event.origin!==new URL(frame.src).origin)return;
      const d=event.data,p=window.__embedProtocol;
      if(d?.type==='augmentor-status'){
        if(typeof d.online==='boolean'&&typeof d.busy==='boolean')p.status=true;
        if(typeof d.conversationId==='string'&&[...d.conversationId].length>=1&&[...d.conversationId].length<=128&&!/[\x00-\x1f\x7f]/.test(d.conversationId))p.conversationId=true;
      }
      if(d?.type==='augmentor-event'){
        if(d.event==='conversation.changed'&&typeof d.conversationId==='string'&&[...d.conversationId].length>=1&&[...d.conversationId].length<=128&&!/[\x00-\x1f\x7f]/.test(d.conversationId))p.conversationChanged=true;
        if(d.event==='turn.started')p.replyStarted=true;
        if(d.event==='turn.finished')p.replyFinished=true;
        if(d.event==='tool.finished'&&typeof d.toolName==='string'&&/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(d.toolName)){
          if(d.error===false)p.toolSuccess=true;if(d.error===true)p.toolError=true;
        }
      }
    });
  });
  const fixturePage=await context.newPage();await fixturePage.goto(`http://127.0.0.1:${fixture.address().port}/fixture/path?q=canary#fragment`);
  page=await context.newPage();await page.goto(panelUrl);
  await page.waitForFunction(()=>window.__resonantosEmbed?.ready===true,null,{timeout:90000});
}
async function protocol() {
  await attest('recipient','Verify in Manolo’s container/version UI that the configured recipient is Augmentor and matches the supplied version.');
  await attest('upstreamExercise','In the real harness, change conversation, start/finish a reply, and exercise a safe tool success and a safe tool error. Do not enter credentials or perform an external mutation.');
  summary.protocol=await page.evaluate(()=>({...window.__embedProtocol}));
  assert.deepEqual(summary.protocol,{status:true,conversationId:true,conversationChanged:true,replyStarted:true,replyFinished:true,toolSuccess:true,toolError:true},'EMBED-UPSTREAM-1 failed: a required field/event is absent. Stop mapping implementation; obtain a reviewed narrow spec update.');
  summary.checks.upstream=true;
}
async function bridge(route,options={}) {
  return page.evaluate(async({route,options})=>{
    const api=await import('./lib/bridge-client.js');const config=await api.resolveBridgeConfig({refreshGenerated:true});await api.initCapabilityTokens(config);
    return api.createBridgeClient(config)(route,options);
  },{route,options});
}
async function privacy() {
  await page.locator('[data-control=workspace]').click();
  workspace=context.pages().find(p=>p.url().includes('/src/main-workspace.html'));
  if(!workspace){workspace=await context.waitForEvent('page');await workspace.waitForURL('**/src/main-workspace.html');}
  await workspace.locator('[data-workspace=settings]').click();
  await workspace.getByRole('button',{name:/Privacy/}).click();
  await workspace.getByText('Embedded harness activity',{exact:true}).waitFor();
  return workspace.locator('[data-embed-activity]');
}
async function recording(card,enabled) {
  await card.getByLabel('Record harness activity').setChecked(enabled);
  await card.getByText(enabled?'Recording is on':'Recording is off',{exact:true}).waitFor();
}
async function clickPage(){await page.evaluate(()=>{const n=document.querySelector('.embed-bar-notice');if(n)n.textContent='';});await page.locator('[data-control=page]').click();}
async function durable(){return JSON.parse(await readFile(statePath,'utf8'));}
async function choose(mode) {
  await page.locator('[data-control=assistant]').click();
  await Promise.all([page.waitForNavigation(),page.locator(`[data-mode=${mode}]`).click()]);
}
try {
  fixture.listen(0,'127.0.0.1');await once(fixture,'listening');await launch();
  if(stage==='upstream'){await protocol();summary.pass=true;}
  else {
    assert.equal((await bridge('/embed-governance/state')).recordingEnabled,false);
    for(const width of [320,420]) {
      await page.setViewportSize({width,height:900});
      const layout=await page.evaluate(()=>{const b=document.querySelector('#resonantos-bar').getBoundingClientRect(),f=document.querySelector('#embed-root iframe').getBoundingClientRect(),t=document.querySelector('[data-tier]').getBoundingClientRect();return {height:b.height,aligned:Math.abs(f.top-b.bottom)<=1,fit:document.documentElement.scrollWidth<=innerWidth,tier:t.width>0};});
      assert.ok(layout.height<=36&&layout.height>0&&layout.aligned&&layout.fit&&layout.tier);summary.checks['layout'+width]=true;
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    await attest('keyboardAndLayout','Verify keyboard focus, badge description and Escape, reduced motion, and that the harness panel looks unchanged.');
    await page.evaluate(()=>{const s=window.__resonantosEmbed,send=s.send;window.__localShares=0;s.send=m=>{const ok=send(m);if(ok&&m?.type==='augmentor-context')window.__localShares++;return ok;};});
    await clickPage();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>window.__localShares),0);
    await clickPage();await page.getByRole('button',{name:'Share page',exact:true}).click();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__localShares),1);
    const inner=page.frames().find(f=>f.parentFrame()?.parentFrame()===page.mainFrame()&&new URL(f.url()).pathname.startsWith('/embed/'));assert.ok(inner);
    const before=await inner.getByText(fixtureTitle,{exact:true}).count();
    assert.equal(await page.evaluate(()=>window.__resonantosEmbed.send({type:'augmentor-prompt',text:'What is the title of the page shared by ResonantOS? Reply with exactly that title and no other text.',send:true,fresh:true})),true);
    await inner.getByText(fixtureTitle,{exact:true}).nth(before).waitFor({timeout:180000});summary.checks.fixtureReply=true;
    assert.deepEqual((await bridge('/embed-governance/events')).events,[]);
    await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
    await context.close();context=null;
    await attest('restartSameRecipient','Restart the spike bridge with the SAME external user root and upstream origin, refresh the disposable extension configuration, and leave recording off.');
    await launch();await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
    let card=await privacy();await recording(card,true);await page.bringToFront();await page.waitForTimeout(5200);await protocol();
    await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();
    await page.waitForTimeout(2200);
    const stored=await durable(),events=(await bridge('/embed-governance/events')).events;
    assert.ok(events.some(r=>r.event.kind==='page-shared'&&r.event.domain==='127.0.0.1'));
    for(const kind of ['conversation-changed','reply-started','reply-finished','tool-finished'])assert.ok(events.some(r=>r.event.kind===kind),kind);
    for(const error of [true,false])assert.ok(events.some(r=>r.event.kind==='tool-finished'&&r.event.error===error));
    for(const r of stored.events){assert.equal(Object.hasOwn(r,'conversationId'),false);assert.equal(Object.hasOwn(r.event,'conversationId'),false);assert.equal(Object.hasOwn(r.event,'text'),false);assert.equal(Object.hasOwn(r.event,'url'),false);assert.equal(Object.hasOwn(r.event,'title'),false);}
    assert.equal(JSON.stringify(stored).includes(fixtureTitle),false);assert.equal(JSON.stringify(stored).includes('canary'),false);summary.checks.domainOnly=true;
    await workspace.bringToFront();await card.getByRole('button',{name:'View activity',exact:true}).click();await card.getByText(/Page shared: 127.0.0.1/).waitFor();
    await recording(card,false);const count=(await durable()).events.length;await page.bringToFront();await clickPage();await page.waitForTimeout(2200);assert.equal((await durable()).events.length,count);
    await workspace.bringToFront();await card.getByRole('button',{name:'Delete activity',exact:true}).click();await workspace.getByRole('dialog').getByRole('button',{name:'Delete activity',exact:true}).click();await card.getByText('Activity deleted',{exact:true}).waitFor();
    assert.deepEqual((await durable()).events,[]);assert.ok(Object.keys((await durable()).notices).length>0);
    await context.close();context=null;
    await attest('restartAfterDeletion','Restart the bridge with the same test root and recipient; refresh the disposable extension configuration.');
    await launch();assert.deepEqual((await bridge('/embed-governance/events')).events,[]);assert.equal((await bridge('/embed-governance/state')).noticeAcknowledged,true);
    await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);summary.checks.deleteSurvivesRestart=true;
    await context.close();context=null;
    await attest('stoppedForRetention','Stop the bridge before seeding this test-owned state. Verify no bridge owns this root.');
    const seed=await durable();seed.events=[{version:1,eventId:randomUUID(),recordedAt:new Date(Date.now()-2592000001).toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',source:'harness-report',event:{kind:'reply-finished'}}];await writeFile(statePath,JSON.stringify(seed)+'\n',{mode:0o600});
    await attest('restartedForRetention','Restart the bridge with the same test root; refresh the disposable extension config.');await launch();assert.deepEqual((await bridge('/embed-governance/events')).events,[]);assert.deepEqual((await durable()).events,[]);summary.checks.retention=true;
    await attest('storageFailureIsolation','Using only this disposable root, induce a storage failure, verify Page sharing, chat, Workspace and Assistant still work, then restore safe permissions.');
    const slots=(await bridge('/addons/registry')).slots;assert.ok(slots&&typeof slots==='object');
    await choose('normal');await page.locator('#command-input').waitFor();assert.deepEqual(await page.locator('#resonantos-bar [data-control]').evaluateAll(nodes=>nodes.map(n=>n.dataset.control)),['assistant']);
    await choose('embed');await page.waitForFunction(()=>window.__resonantosEmbed?.ready);assert.deepEqual((await bridge('/addons/registry')).slots,slots);summary.checks.viewOnly=true;
    summary.pass=true;
  }
}catch{summary.pass=false;summary.failure='Live acceptance incomplete; inspect fixed check names and rerun with the conductor.';process.exitCode=1;}
finally{
  terminal.close();await context?.close();fixture.closeAllConnections();if(fixture.listening)await new Promise(r=>fixture.close(r));await rm(profile,{recursive:true,force:true});
  await writeFile(join(out,'embed-governance-summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});
}
console.log(JSON.stringify(summary));
```

Append this complete operator section to `browser-first/README.md`:

```markdown
## Testing-branch embedded harness activity

The embed experiment remains outside Alpha and off unless `RESONANTOS_EMBED_POC=1` is set. Its bar shows Self-governed: Augmentor's own tool approvals do not approve ResonantOS operations. Changing Assistant view does not assign a primary-agent slot.

Settings > Privacy > Embedded harness activity controls opt-in metadata recording, which defaults off. The bridge stores conversation changes, reply transitions, validated tool names/error flags and shared page hostnames for 30 days under its external user root. No prompt, reply, tool arguments/results, page title, URL path, query or fragment belongs in this log. Recording is best effort, local, inspectable and deletable; it is not an approval receipt.

First permitted page sharing asks about the configured Augmentor recipient. Cancel or failed local dispatch remembers nothing. A successful local share may remember the notice even while activity recording is off. A changed upstream origin or port asks again. Deleting readable history preserves that choice and notices; recovery of an unreadable store turns recording off and clears notices.

The conductor alone runs `browser-first/test/embed-live.mjs` with Manolo's container and the spike bridge. Workers write and syntax-check the proof. `EMBED-UPSTREAM-1` must verify the real recipient/version and every required relay field before mapping implementation; fixtures cannot satisfy it. Live evidence stays outside Git. A reviewed ADR number is required before any merge into dev.
```

- [ ] Worker checks only: `node --check browser-first/test/embed-live.mjs` and `node --test browser-first/test/embed-live-contract.test.mjs`; expect pass. No browser/container/bridge run is authorized for the worker by this task.
- [ ] Conductor execution commands, after setting the four required external test configuration variables in the conductor's private environment:

```bash
RESONANTOS_EMBED_LIVE_STAGE=upstream node browser-first/test/embed-live.mjs
```

Expected: the upstream command establishes recipient and all seven field-presence booleans before Task 7. Task 12 runs the integration stage after Tasks 7–10 and records all acceptance checks. An absent event means nonzero exit and blocked live acceptance. Never retain relay payloads, screenshots of private harness chats, tokens or conversation IDs. Conductor attestations remain labeled separately from protocol observations.

- [ ] Red evidence for live acceptance integrity: temporarily remove `conversationId` from the observer's accepted status path and rerun only the deterministic source-contract test with an assertion that the exact assignment `p.conversationId=true` exists; restore. The conductor's missing-field assertion itself must fail when a required upstream field is absent; workers must not fake a passing observation.
- [ ] Commit code/docs only, whether live acceptance is pending or passed; do not claim live completion from a syntax check:

```bash
git diff --check
git add browser-first/test/embed-live.mjs browser-first/test/embed-live-contract.test.mjs browser-first/README.md
git commit -m "test(embed): define conductor-owned upstream and consent proof"
```

### Task 7: Safe relay controller and bounded observation delivery

**Prerequisite:** The conductor must first complete **EMBED-UPSTREAM-1** using Task 11's written proof. The preceding Task 11 block creates the proof and completes its deterministic syntax/contract checks before this task. Do not implement relay mapping until its recipient/version/field checks pass. Missing fields block this task and require a reviewed narrow mapping correction; they do not justify synthetic events. All independent preceding tasks can proceed.

**Files:**
- Create: `browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js`
- Create/Test: `browser-first/test/embed-governance-controller.test.mjs`
- Modify: `docs/architecture/MODULE-OWNERSHIP.md`

**Interfaces:**
- Consumes: `request(route:string, options?:{method?:string,body?:object,signal?:AbortSignal}):Promise<object>`; `confirmShare(label:string):Promise<boolean>`; `announce(text:string):void`.
- Produces: `createEmbedGovernanceController({request,windowRef,chromeApi?,confirmShare,announce,uuid?,setTimeoutImpl?,clearTimeoutImpl?,setIntervalImpl?,clearIntervalImpl?})` returning `mount({frame,origin,descriptor}):void`, `relay(event):void`, `refresh():Promise<void>`, `beginShare():Promise<ShareTicket|string>`, `currentShare(ticket):boolean`, `didShare(ticket,url):void`, `stopRecording():void`, `destroy():void`, `history:Array<object>`. `ShareTicket` is `{frame:Window, noticeKey:string, remember:boolean}`. No raw messages escape or survive method return.

- [ ] Write the failing test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEmbedGovernanceController } from '../resonantos-side-panel-extension/src/lib/embed-governance-controller.js';
const d={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:'augmentor-v1-'+ 'a'.repeat(64)};
const settle=()=>new Promise(r=>setImmediate(r));
function fixture({enabled=false,post,confirm=true}={}) {
  const frame={},calls=[],notices=[],listeners=new Map();let polls=0,poll,timeout=()=>{},epoch=randomUUID(),asks=0,noticeKey=d.noticeKey;
  const state=()=>({recordingEnabled:enabled,writeEpoch:epoch,noticeKey,noticeVersion:1,noticeAcknowledged:false,available:true,problem:null});
  const request=async(path,options={})=>{calls.push({path,options});if(path.endsWith('/state')){polls++;return state();}return post?post(path,options):{recorded:true,reason:null};};
  const c=createEmbedGovernanceController({request,uuid:randomUUID,windowRef:{addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)},confirmShare:async()=>{asks++;return confirm;},announce:s=>notices.push(s),setIntervalImpl:(fn,ms)=>{assert.equal(ms,5000);poll=fn;return 1;},clearIntervalImpl(){},setTimeoutImpl:(fn,ms)=>{assert.equal(ms,2000);timeout=fn;return 2;},clearTimeoutImpl(){}});
  c.mount({frame,origin:'http://127.0.0.1:9',descriptor:d});
  const relay=data=>c.relay({source:frame,origin:'http://127.0.0.1:9',data});
  return {c,frame,calls,notices,listeners,relay,enable:v=>enabled=v,epoch:()=>epoch=randomUUID(),poll:()=>poll(),timeout:()=>timeout(),asks:()=>asks,polls:()=>polls,changeRecipient:key=>noticeKey=key};
}
test('unknown/off records nothing; enabling has no backfill; exact transitions never persist IDs/content',async()=>{
  const f=fixture();await f.c.refresh();
  f.relay({type:'augmentor-event',event:'turn.started',prompt:'CANARY'});assert.equal(f.c.history.length,0);
  f.enable(true);await f.c.refresh();
  f.relay({type:'augmentor-status',online:true,busy:false,conversationId:'CANARY-ID-1'});
  f.relay({type:'augmentor-event',event:'conversation.changed',conversationId:'CANARY-ID-2',text:'CANARY'});
  f.relay({type:'augmentor-status',online:true,busy:false,conversationId:'CANARY-ID-2'});
  f.relay({type:'augmentor-event',event:'turn.started'});f.relay({type:'augmentor-event',event:'turn.started'});
  f.relay({type:'augmentor-event',event:'turn.finished'});f.relay({type:'augmentor-event',event:'turn.finished'});
  f.relay({type:'augmentor-event',event:'tool.finished',toolName:'read.page',error:false,result:'CANARY'});
  f.relay({type:'augmentor-event',event:'tool.finished',toolName:'read.page',error:false});
  for(let i=0;i<10;i++)await settle();
  const posts=f.calls.filter(c=>c.path.endsWith('/events'));
  assert.deepEqual(posts.map(p=>p.options.body.event.kind),['conversation-changed','reply-started','reply-finished','tool-finished','tool-finished']);
  assert.equal(JSON.stringify(posts).includes('CANARY'),false);assert.equal(JSON.stringify(f.c.history).includes('CANARY'),false);
  const before=posts.length;
  f.c.relay({source:{},origin:'http://127.0.0.1:9',data:{type:'augmentor-event',event:'turn.started'}});
  f.c.relay({source:f.frame,origin:'http://evil',data:{type:'augmentor-event',event:'turn.started'}});
  f.relay({type:'augmentor-result',text:'CANARY'});f.relay({type:'augmentor-status',online:false,busy:false});
  await settle();assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,before);
  f.c.destroy();assert.equal(f.listeners.size,0);
});
test('queue bounds, timeout drops, stale epoch refresh and pagehide cleanup',async()=>{
  const f=fixture({enabled:true,post:()=>new Promise(()=>{})});await f.c.refresh();
  for(let i=0;i<60;i++)f.relay({type:'augmentor-event',event:'tool.finished',toolName:'read',error:false});
  assert.ok(f.c.history.length<=50);await settle();assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,1);
  f.timeout();await settle();assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,2);
  f.listeners.get('pagehide')();await settle();assert.equal(f.c.history.length,0);
  const stale=fixture({enabled:true,post:async()=>({recorded:false,reason:'stale-epoch'})});await stale.c.refresh();
  const polls=stale.polls();stale.relay({type:'augmentor-event',event:'turn.started'});await settle();await settle();
  assert.ok(stale.polls()>polls);assert.equal(stale.calls.filter(c=>c.path.endsWith('/events')).length,1);stale.c.destroy();
});
test('notice consent only follows successful-share callback and survives remember failure in this mount',async()=>{
  const f=fixture({post:async()=>{throw Error('CANARY');}});await f.c.refresh();
  const ticket=await f.c.beginShare();assert.equal(typeof ticket,'object');
  assert.equal(f.calls.some(c=>c.path.endsWith('/notice')),false);
  f.c.didShare(ticket,'https://example.test/path?q=CANARY');await settle();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/notice')).length,1);
  assert.equal(f.calls.some(c=>c.path.endsWith('/recording')),false);
  await f.c.beginShare();assert.equal(f.asks(),1);
  assert.ok(f.notices.includes('Notice preference could not be saved. It may appear again.'));
  f.c.mount({frame:{},origin:'http://127.0.0.1:9',descriptor:d});
  assert.equal(f.c.currentShare(ticket),false);await f.c.beginShare();assert.equal(f.asks(),2);f.c.destroy();
});
```

Append a drain test that measures the full bounded queue, including drop-newest order:

```js
test('one in flight and at most 32 waiting; full queue drops newest without retry',async()=>{
  const releases=[];
  const f=fixture({enabled:true,post:()=>new Promise(resolve=>releases.push(resolve))});await f.c.refresh();
  for(let i=0;i<60;i++)f.relay({type:'augmentor-event',event:'tool.finished',toolName:'tool'+i,error:false});
  await settle();assert.equal(releases.length,1);
  for(let i=0;i<33;i++){assert.equal(releases.length,1);releases.shift()({recorded:true,reason:null});await settle();}
  assert.equal(releases.length,0);
  assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/events')).map(c=>c.options.body.event.toolName),Array.from({length:33},(_,i)=>'tool'+i));
  assert.deepEqual(f.notices,['Activity was not recorded']);f.c.destroy();
});
```

Append the disablement-history guard case:

```js
test('disablement clears pending metadata and keeps only bounded ready/status proof',async()=>{
  const f=fixture({enabled:true});await f.c.refresh();
  f.relay({type:'augmentor-ready'});f.relay({type:'augmentor-event',event:'turn.started'});await settle();
  assert.ok(f.c.history.some(row=>row.kind==='reply-started'));
  f.enable(false);await f.c.refresh();
  assert.ok(f.c.history.every(row=>row.type==='augmentor-ready'||row.type==='augmentor-status'));
  const count=f.calls.filter(c=>c.path.endsWith('/events')).length;
  f.relay({type:'augmentor-event',event:'turn.finished'});await settle();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,count);f.c.destroy();
});
```

Append baseline and recipient-change regressions:

```js
test('offline resets baselines without synthesizing finishes; busy transitions are not turns',async()=>{
  const f=fixture({enabled:true});await f.c.refresh();
  f.relay({type:'augmentor-status',online:true,busy:false,conversationId:'first'});
  f.relay({type:'augmentor-event',event:'turn.started'});
  f.relay({type:'augmentor-status',online:false,busy:false});
  f.relay({type:'augmentor-status',online:true,busy:true,conversationId:'second'});
  f.relay({type:'augmentor-status',online:true,busy:false,conversationId:'second'});
  await settle();assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/events')).map(c=>c.options.body.event.kind),['reply-started']);
  f.relay({type:'augmentor-event',event:'turn.started'});await settle();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,2);f.c.destroy();
});
test('changed host recipient key invalidates this mounted frame and never remembers a share',async()=>{
  const f=fixture();await f.c.refresh();const ticket=await f.c.beginShare();
  f.changeRecipient('augmentor-v1-'+ 'b'.repeat(64));await f.c.refresh();
  assert.equal(f.c.currentShare(ticket),false);assert.equal(await f.c.beginShare(),'Assistant unavailable');
  f.c.didShare(ticket,'https://example.test/');await settle();
  assert.equal(f.calls.some(c=>c.path.endsWith('/notice')),false);f.c.destroy();
});
```

- [ ] Run `node --test browser-first/test/embed-governance-controller.test.mjs`; expect missing module. Only proceed with implementation after the conductor's live prerequisite passes.
The `resonantos.embedRecordingChange` local-storage value is only a notification `{id: UUID, pending: boolean}`. It contains no consent, epoch, recipient, metadata or credential. A pending notification stops submissions, aborts in-flight work, clears the queue, invalidates old reads and holds polling until settlement. A settled notification only requests authenticated host state; it cannot enable recording itself. Ignore stored notification values on mount; durable choice remains host-owned. Remove the listener on destruction. This narrow recording-stop signal adds no harness history or view synchronization. If notification delivery fails, the host still enforces its durable flag on appends; never report other pages disabled from a storage write alone.

- [ ] Create the complete controller:

```js
import { LIMITS, UUID, metadata, domainFromUrl, validDescriptor } from './generated/embed-governance-contract.js';
export function createEmbedGovernanceController({request,windowRef=globalThis.window,chromeApi=globalThis.chrome,confirmShare,announce=()=>{},uuid=()=>crypto.randomUUID(),setTimeoutImpl=setTimeout,clearTimeoutImpl=clearTimeout,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}) {
  let frame=null,origin='',descriptor=null,enabled=false,epoch=null,keyKnown=null,ack=false,stale=false,conversation=null,reply=null,closed=false,generation=0,readSequence=0,failure=false;
  const history=[],queue=[],pending=new Set(),recordingChanges=new Set();let pumping=false;
  function tell(text){try{announce(text);}catch{}}
  function failed(){if(!failure){failure=true;tell('Activity was not recorded');}}
  function ring(value){history.push(value);if(history.length>LIMITS.history)history.splice(0,history.length-LIMITS.history);}
  function clear(){generation++;queue.length=0;for(const ac of pending)ac.abort();pending.clear();history.splice(0,history.length,...history.filter(v=>v.type==='augmentor-ready'||v.type==='augmentor-status'));}
  async function bounded(path,options={}) {
    const ac=new AbortController();pending.add(ac);let timer;
    const timeout=new Promise((_,reject)=>{
      ac.signal.addEventListener('abort',()=>reject(Error('Activity unavailable')),{once:true});
      timer=setTimeoutImpl(()=>ac.abort(),LIMITS.timeout);
    });
    try{return await Promise.race([Promise.resolve().then(()=>{if(ac.signal.aborted)throw Error('Activity unavailable');return request(path,{...options,signal:ac.signal});}),timeout]);}
    finally{clearTimeoutImpl(timer);pending.delete(ac);}
  }
  async function refresh() {
    if(closed||recordingChanges.size)return;
    const seq=++readSequence,gen=generation;
    try {
      const s=await bounded('/embed-governance/state');
      if(closed||seq!==readSequence||gen!==generation)return;
      if(typeof s?.recordingEnabled!=='boolean'||!(s.writeEpoch===null||typeof s.writeEpoch==='string'&&UUID.test(s.writeEpoch))||typeof s.noticeAcknowledged!=='boolean'||s.noticeVersion!==1)throw Error();
      keyKnown=s.noticeKey;
      if(descriptor&&s.noticeKey!==descriptor.noticeKey){stale=true;ack=false;enabled=false;epoch=null;clear();return;}
      if(!s.recordingEnabled||!s.available||s.problem){enabled=false;epoch=null;clear();}
      else {if(!enabled||epoch!==s.writeEpoch)clear();enabled=true;epoch=s.writeEpoch;}
      if(s.noticeAcknowledged)ack=true;
      failure=false;
    }catch{if(!closed&&seq===readSequence){enabled=false;epoch=null;keyKnown=null;clear();failed();}}
  }
  async function pump() {
    if(pumping||closed)return;pumping=true;
    try {
      while(queue.length&&enabled&&!closed) {
        const item=queue.shift(),gen=generation;
        try {
          const result=await bounded('/embed-governance/events',{method:'POST',body:item});
          if(gen!==generation||closed)continue;
          if(result.recorded===true){failure=false;continue;}
          failed();
          if(['stale-epoch','disabled','unavailable'].includes(result.reason)){enabled=false;clear();await refresh();}
        }catch{if(gen===generation&&!closed)failed();}
      }
    }finally{pumping=false;if(queue.length&&enabled&&!closed)void pump();}
  }
  function observe(value) {
    try {
      if(!enabled||!epoch||closed)return;
      const event=metadata(value);if(!event)return;
      ring(event);
      if(queue.length>=LIMITS.queue){failed();return;}
      queue.push({writeEpoch:epoch,eventId:uuid(),event});void pump();
    }catch{failed();}
  }
  function change(id,explicit) {
    if(typeof id!=='string'||[...id].length<1||[...id].length>128||/[\x00-\x1f\x7f]/.test(id))return;
    if(id!==conversation){if(conversation!==null||explicit){observe({kind:'conversation-changed'});reply=null;}conversation=id;}
  }
  function relay(event) {
    try {
      if(closed||!frame||event.source!==frame||event.origin!==origin)return;
      const data=event.data;if(!data||typeof data!=='object')return;
      if(data.type==='augmentor-ready'){ring({type:'augmentor-ready'});return;}
      if(data.type==='augmentor-status') {
        if(typeof data.online!=='boolean'||typeof data.busy!=='boolean')return;
        ring({type:'augmentor-status',online:data.online,busy:data.busy});
        if(!data.online){conversation=null;reply=null;return;}
        change(data.conversationId,false);return;
      }
      if(data.type!=='augmentor-event')return;
      if(data.event==='conversation.changed')change(data.conversationId,true);
      else if(data.event==='turn.started'&&reply!=='started'){reply='started';observe({kind:'reply-started'});}
      else if(data.event==='turn.finished'&&reply!=='finished'){reply='finished';observe({kind:'reply-finished'});}
      else if(data.event==='tool.finished')observe({kind:'tool-finished',toolName:data.toolName,error:data.error});
    }catch{failed();}
  }
  function mount(value) {
    if(closed)return;clear();readSequence++;conversation=null;reply=null;ack=false;keyKnown=null;stale=false;enabled=false;epoch=null;history.length=0;
    frame=value?.frame??null;origin=value?.origin??'';descriptor=validDescriptor(value?.descriptor)?{...value.descriptor}:null;
    void refresh();
  }
  function currentShare(ticket){return !closed&&!stale&&!!descriptor&&ticket?.frame===frame&&ticket?.noticeKey===descriptor.noticeKey;}
  async function beginShare() {
    try {
      if(closed||!frame||!descriptor||stale)return 'Assistant unavailable';
      const mounted=frame,key=descriptor.noticeKey;
      await refresh();
      if(closed||frame!==mounted||descriptor?.noticeKey!==key||stale)return 'Assistant unavailable';
      const remember=!ack;
      if(remember&&await confirmShare(descriptor.label)!==true)return '';
      const ticket={frame:mounted,noticeKey:key,remember};
      return currentShare(ticket)?ticket:'Assistant unavailable';
    }catch{return 'Assistant unavailable';}
  }
  function didShare(ticket,url) {
    try {
      if(!currentShare(ticket))return;
      if(ticket.remember){ack=true;const gen=generation;
        void bounded('/embed-governance/notice',{method:'POST',body:{noticeKey:ticket.noticeKey,version:1}}).catch(()=>{
          if(!closed&&gen===generation)tell('Notice preference could not be saved. It may appear again.');
        });
      }
      const domain=domainFromUrl(url);if(domain)observe({kind:'page-shared',domain});
    }catch{failed();}
  }
  function stopRecording(){enabled=false;epoch=null;readSequence++;clear();}
  function destroy(){if(closed)return;closed=true;stopRecording();history.length=0;clearIntervalImpl(timer);windowRef?.removeEventListener('focus',focus);windowRef?.removeEventListener('pagehide',destroy);chromeApi?.storage?.onChanged?.removeListener(recordingChanged);recordingChanges.clear();}
  const recordingChanged=(changes,area)=>{
    if(closed||area!=='local')return;
    const change=changes['resonantos.embedRecordingChange']?.newValue;
    if(!change||typeof change.id!=='string'||!UUID.test(change.id)||typeof change.pending!=='boolean')return;
    if(change.pending){recordingChanges.add(change.id);stopRecording();}
    else {recordingChanges.delete(change.id);void refresh();}
  };
  const focus=()=>{void refresh();};
  const timer=setIntervalImpl(focus,LIMITS.poll);
  windowRef?.addEventListener('focus',focus);windowRef?.addEventListener('pagehide',destroy);chromeApi?.storage?.onChanged?.addListener(recordingChanged);
  return {mount,relay,refresh,beginShare,currentShare,didShare,stopRecording,destroy,history};
}
```

Append ownership:

```markdown
| `browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js` | Safe relay observations, notice cache and bounded metadata delivery | Validated session descriptor, exact-source relay and authenticated host snapshots | In-memory baselines, projected queue and notice acknowledgement after dispatch | Authority, filesystem, raw transcript retention or credentials in UI |
```

- [ ] Run `node --test browser-first/test/embed-governance-controller.test.mjs`; expect pass. Test off-to-on explicitly with a new turn after a finish: baselines may track while off but must not emit old observations. Verify polling/focus requests contain no `/recording` or `/notice` call without `didShare`.
- [ ] Red evidence: individually remove exact source, exact origin, `if(!enabled||!epoch||closed)return`, queue bound, and `currentShare` frame comparison. Require the corresponding controller test failures. Remove metadata-history filtering in `clear`; the disablement-history test must fail. Restore and rerun. Retain only fixed assertion outcomes in mutation evidence; payload tests use synthetic canaries.
- [ ] Run this exact guard-mutation matrix after green. Each `rig-mutate` invocation must return zero (behavioral failure under mutation and byte-identical restoration). Inspect any failure; import or syntax errors are not guard evidence. The strings below are exact edits, not patterns.

```bash
python3 - <<'PYMUTATE'
from pathlib import Path
import shlex, subprocess
rig=str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate')
mutations=[('browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js', [('if(!enabled||!epoch||closed)return;', 'if(closed)return;')]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js', [('event.source!==frame||event.origin!==origin', 'false')]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js', [('if(queue.length>=LIMITS.queue)', 'if(false)')]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js', [("ring({type:'augmentor-status',online:data.online,busy:data.busy})", 'ring(data)')]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js', [("data.event==='turn.started'&&reply!=='started'", "data.event==='turn.started'")]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js', [('timer=setTimeoutImpl(()=>ac.abort(),LIMITS.timeout);', 'timer=0;')]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js', [('ticket?.frame===frame&&', '')]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js', [("history.filter(v=>v.type==='augmentor-ready'||v.type==='augmentor-status')", 'history')])]
test_command='node --test browser-first/test/embed-governance-controller.test.mjs'
for filename,changes in mutations:
    edit='from pathlib import Path\np=Path('+repr(filename)+')\ns=p.read_text()\n'
    for before,after in changes:
        edit+='assert '+repr(before)+' in s\ns=s.replace('+repr(before)+','+repr(after)+',1)\n'
    edit+='p.write_text(s)\n'
    try:
        subprocess.run([rig,filename,'python3 -c '+shlex.quote(edit),test_command],check=True)
    finally:
        subprocess.run(['node','scripts/prepare-embed-governance.mjs'],check=True)
subprocess.run(shlex.split('node --test browser-first/test/embed-governance-controller.test.mjs'),check=True)
PYMUTATE
```

- [ ] Commit:

```bash
git diff --check
git add browser-first/resonantos-side-panel-extension/src/lib/embed-governance-controller.js browser-first/test/embed-governance-controller.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(embed): capture bounded consented relay metadata"
```

### Task 8: Accessible first-share dialog and final permission revalidation

**Files:**
- Create: `browser-first/resonantos-side-panel-extension/src/lib/embed-governance-dialog.js`
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js`, `browser-first/test/embed-bar-actions.test.mjs`, `docs/architecture/MODULE-OWNERSHIP.md`
- Create/Test: `browser-first/test/embed-first-share.test.mjs`

**Interfaces:**
- Consumes: controller `beginShare():Promise<ShareTicket|string>`, `currentShare(ticket:ShareTicket):boolean`, `didShare(ticket:ShareTicket,url:string):void`; existing `activeTab():Promise<{id:number,url:string,title?:string}|null>`, `permissionForUrl(url:string):Promise<string>`, `pageContextMessage(tab:{url:string,title?:string}):{type:"augmentor-context",context:{source:"resonantos",page:{title:string,url:string}}}|null`.
- Produces: `confirmEmbedAction({documentRef,heading,description,confirmLabel,returnFocus}):Promise<boolean>`; `confirmEmbedShare({documentRef,label,returnFocus}):Promise<boolean>`; extended `createEmbedBarActions({chromeApi,locationRef,sendContext,beforeShare,isShareCurrent,onShared})`.

- [ ] Write the failing test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEmbedBarActions } from '../resonantos-side-panel-extension/src/lib/embed-bar-actions.js';
import { confirmEmbedShare } from '../resonantos-side-panel-extension/src/lib/embed-governance-dialog.js';
function fixture({confirm=true,change,dispatch=true}={}) {
  const tab={id:2,url:'https://example.test/path?q=CANARY',title:'Fixture'},sent=[],remembered=[];let mode='read-only',reads=0,notices=0,current=true;
  const chromeApi={tabs:{query:async()=>[tab],get:async()=>tab},webNavigation:{getAllFrames:async()=>[]},storage:{local:{get:async key=>{if(key==='augmentorSitePermissions'){reads++;return {[key]:{'example.test':mode}};}return {};},set:async()=>{}}}};
  const ticket={frame:{},noticeKey:'key',remember:true};
  const actions=createEmbedBarActions({chromeApi,locationRef:{},sendContext:m=>{if(dispatch==='throw')throw Error('CANARY');sent.push(m);return dispatch;},beforeShare:async()=>{notices++;if(change==='url')tab.url='https://example.test/other';if(change==='permission')mode='blocked';if(change==='frame')current=false;if(change==='read')chromeApi.storage.local.get=async()=>{throw Error('CANARY');};return confirm?ticket:'';},isShareCurrent:()=>current,onShared:(value,url)=>remembered.push({value,url})});
  return {actions,sent,remembered,reads:()=>reads,notices:()=>notices};
}
test('cancel, navigation, permission failure, frame replacement and failed dispatch remember nothing',async()=>{
  for(const opts of [{confirm:false},{change:'url'},{change:'permission'},{change:'frame'},{change:'read'},{dispatch:false},{dispatch:'throw'}]) {
    const f=fixture(opts);assert.notEqual(await f.actions.sharePage(),'Page shared');assert.deepEqual(f.remembered,[]);
    if(!Object.hasOwn(opts,'dispatch'))assert.deepEqual(f.sent,[]);
  }
  const f=fixture();assert.equal(await f.actions.sharePage(),'Page shared');assert.equal(f.sent.length,1);assert.equal(f.remembered.length,1);assert.equal(f.reads(),2);
  assert.equal(f.remembered[0].url,'https://example.test/path');
});
test('dialog focuses Cancel, traps Tab, escapes, names recipient and restores Page focus',async t=>{
  const dom=new JSDOM('<button id="page">Page</button>');t.after(()=>dom.window.close());const documentRef=dom.window.document,page=documentRef.querySelector('#page');page.focus();
  const answer=confirmEmbedShare({documentRef,label:'Augmentor',returnFocus:page});
  const dialog=documentRef.querySelector('[role=dialog]'),buttons=[...dialog.querySelectorAll('button')];
  assert.equal(documentRef.activeElement,buttons[0]);assert.equal(dialog.getAttribute('aria-modal'),'true');
  assert.match(dialog.textContent,/does not give Augmentor permission/);
  buttons[0].dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(documentRef.activeElement,buttons[1]);
  dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(await answer,false);assert.equal(documentRef.activeElement,page);
  const yes=confirmEmbedShare({documentRef,label:'Augmentor',returnFocus:page});documentRef.querySelector('[data-confirm]').click();assert.equal(await yes,true);
});
```

- [ ] Run `node --test browser-first/test/embed-first-share.test.mjs`; expect missing dialog. For fail-before-fix action evidence temporarily omit only the dialog import/test and run the first test against existing actions; it must fail because current actions ignore cancellation and navigation. Restore the full test.
- [ ] Create the complete dialog module:

```js
let sequence=0;
export function confirmEmbedAction({documentRef=globalThis.document,heading,description,confirmLabel,returnFocus=documentRef.activeElement}) {
  return new Promise(resolve=>{
    const overlay=documentRef.createElement('div');overlay.className='embed-dialog-overlay';
    const dialog=documentRef.createElement('section');dialog.className='embed-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
    const title=documentRef.createElement('h2'),body=documentRef.createElement('p');
    const id='embed-dialog-'+(++sequence);title.id=id+'-title';body.id=id+'-body';title.textContent=heading;body.textContent=description;
    dialog.setAttribute('aria-labelledby',title.id);dialog.setAttribute('aria-describedby',body.id);
    const cancel=documentRef.createElement('button'),confirm=documentRef.createElement('button');
    cancel.type=confirm.type='button';cancel.textContent='Cancel';confirm.textContent=confirmLabel;confirm.dataset.confirm='true';
    dialog.append(title,body,cancel,confirm);overlay.append(dialog);documentRef.body.append(overlay);
    let done=false;
    const finish=value=>{if(done)return;done=true;documentRef.removeEventListener('keydown',key,true);documentRef.removeEventListener('focusin',focus,true);documentRef.defaultView?.removeEventListener('pagehide',hide);overlay.remove();returnFocus?.focus?.();resolve(value);};
    const key=event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(false);}
      if(event.key==='Tab'){event.preventDefault();(documentRef.activeElement===cancel?confirm:cancel).focus();}
    };
    const focus=event=>{if(!dialog.contains(event.target))cancel.focus();};
    const hide=()=>finish(false);
    cancel.addEventListener('click',()=>finish(false));confirm.addEventListener('click',()=>finish(true));
    documentRef.addEventListener('keydown',key,true);documentRef.addEventListener('focusin',focus,true);documentRef.defaultView?.addEventListener('pagehide',hide,{once:true});cancel.focus();
  });
}
export function confirmEmbedShare({documentRef,label,returnFocus}) {
  return confirmEmbedAction({documentRef,returnFocus,heading:`Share this page with ${label}?`,description:`${label} runs outside ResonantOS approvals. Its own approvals cover its tools. Sharing sends this page's title and address to ${label}. It does not give ${label} permission to use ResonantOS tools or control this page.`,confirmLabel:'Share page'});
}
```

Replace its constructor declaration with `export function createEmbedBarActions({ chromeApi, locationRef, sendContext, beforeShare = async () => 'Assistant unavailable', isShareCurrent = () => false, onShared = () => {} }) {`. Replace only its `sharePage` function with:

```js
  async function candidate() {
    let tab;try{tab=await activeTab();}catch{return 'No readable page';}
    if(!isControllableTabUrl(tab?.url))return 'No readable page';
    let mode;try{mode=await permissionForUrl(tab.url);}catch{return 'Site permissions unavailable';}
    if(mode==='blocked')return 'Page sharing blocked';
    if(!['read-only','ask-before-action','trusted-for-safe-actions'].includes(mode))return 'Site permissions unavailable';
    const message=pageContextMessage(tab);if(!message)return 'Page context unavailable';
    return {tabId:tab.id,url:message.context.page.url,message};
  }
  async function sharePage() {
    const first=await candidate();if(typeof first==='string')return first;
    let ticket;try{ticket=await beforeShare();}catch{return 'Assistant unavailable';}
    if(typeof ticket==='string')return ticket;
    if(!ticket)return 'Assistant unavailable';
    const final=await candidate();if(typeof final==='string')return final;
    if(first.tabId!==final.tabId||first.url!==final.url)return 'Page changed. Select Page again.';
    if(!isShareCurrent(ticket))return 'Assistant unavailable';
    // No await between the final checks and this one local dispatch.
    try{if(sendContext(final.message)!==true)return 'Assistant offline';}catch{return 'Assistant offline';}
    try{onShared(ticket,final.url);}catch{ /* A successful share is independent of recording. */ }
    return 'Page shared';
  }
```

Existing action tests need explicit host-session callbacks instead of an implicit permission bypass. At each `createEmbedBarActions({` in `browser-first/test/embed-bar-actions.test.mjs`, insert these exact properties:

```js
beforeShare: async () => ({ frame: {}, noticeKey: 'fixture', remember: false }),
isShareCurrent: () => true,
```

Replace the actions ownership row's write column with `Explicit mode preference and permitted context callback after final tab/permission/frame checks; successful-share callback only`. Append:

```markdown
| `browser-first/resonantos-side-panel-extension/src/lib/embed-governance-dialog.js` | Accessible extension-owned confirmations | Safe text and return-focus element | Modal DOM, focus and boolean user result | Credentials, persistence, grants or harness DOM |
```

- [ ] Run `node --test browser-first/test/embed-first-share.test.mjs browser-first/test/embed-bar-actions.test.mjs`; expect pass. Red evidence: remove the final candidate read, the tab/URL equality check, the frame check and the `sendContext(final.message)!==true` condition individually; each named failed-share case must turn red. Restore each. Original strict permission tests remain red-sensitive without weakening them.
- [ ] Run this exact guard-mutation matrix after green. Each `rig-mutate` invocation must return zero (behavioral failure under mutation and byte-identical restoration). Inspect any failure; import or syntax errors are not guard evidence. The strings below are exact edits, not patterns.

```bash
python3 - <<'PYMUTATE'
from pathlib import Path
import shlex, subprocess
rig=str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate')
mutations=[('browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js', [('const final=await candidate();', 'const final=first;')]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js', [('if(first.tabId!==final.tabId||first.url!==final.url)', 'if(false)')]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js', [('if(!isShareCurrent(ticket))', 'if(false)')]), ('browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js', [('if(sendContext(final.message)!==true)', 'if((sendContext(final.message),false))')])]
test_command='node --test browser-first/test/embed-first-share.test.mjs'
for filename,changes in mutations:
    edit='from pathlib import Path\np=Path('+repr(filename)+')\ns=p.read_text()\n'
    for before,after in changes:
        edit+='assert '+repr(before)+' in s\ns=s.replace('+repr(before)+','+repr(after)+',1)\n'
    edit+='p.write_text(s)\n'
    try:
        subprocess.run([rig,filename,'python3 -c '+shlex.quote(edit),test_command],check=True)
    finally:
        subprocess.run(['node','scripts/prepare-embed-governance.mjs'],check=True)
subprocess.run(shlex.split('node --test browser-first/test/embed-first-share.test.mjs'),check=True)
PYMUTATE
```

- [ ] Commit:

```bash
git diff --check
git add browser-first/resonantos-side-panel-extension/src/lib/embed-governance-dialog.js browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js browser-first/test/embed-bar-actions.test.mjs browser-first/test/embed-first-share.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(embed): confirm first shares after fresh permission checks"
```
### Task 9: Visible tier badge and safe frame composition

**Files:**
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-model.js`, `browser-first/resonantos-side-panel-extension/src/lib/embed-bar.js`, `browser-first/resonantos-side-panel-extension/src/styles/side-panel/base-layout.css`, `browser-first/resonantos-side-panel-extension/src/side-panel-entry.js`, `browser-first/test/embed-bar.test.mjs`, `browser-first/test/side-panel-entry.test.mjs`, `docs/architecture/MODULE-OWNERSHIP.md`
- Create/Test: `browser-first/test/embed-governance-composition.test.mjs`

**Interfaces:**
- Consumes: `createEmbedGovernanceController({request,windowRef,chromeApi?,confirmShare,announce,uuid?,setTimeoutImpl?,clearTimeoutImpl?,setIntervalImpl?,clearIntervalImpl?})` with the returned `mount`, `relay`, `beginShare`, `currentShare`, `didShare`, `destroy` methods; `confirmEmbedShare({documentRef,label,returnFocus}):Promise<boolean>`; `validDescriptor(value:unknown):boolean`; session `{hostPath:string,harness:EmbedHarnessDescriptor}`.
- Produces: `embedGovernanceDescription(descriptor:unknown):string`; bar adds `setDescriptor(value:unknown):void`, `announce(text:string):void`; `window.__resonantosEmbed.last` aliases controller's safe history only.

- [ ] Append the failing badge test to `browser-first/test/embed-bar.test.mjs`:

```js
test('self-governed badge is visible, focusable, dismissible and never inferred from status',async t=>{
  const f=fixture();t.after(()=>{f.bar.destroy();f.dom.window.close();});await f.bar.ready;
  const badge=f.bar.root.querySelector('[data-tier]');assert.ok(badge);assert.equal(badge.textContent,'Self-governed');assert.equal(badge.tabIndex,0);
  assert.equal(badge.previousElementSibling.dataset.control,'approvals');assert.equal(badge.nextElementSibling.dataset.control,'status');
  const description=f.dom.window.document.getElementById(badge.getAttribute('aria-describedby'));assert.match(description.textContent,/outside ResonantOS approvals/);
  badge.focus();assert.equal(description.hidden,false);
  badge.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(description.hidden,true);
  f.bar.setDescriptor({governance:'governed',label:'CANARY'});f.bar.setStatus({online:true,busy:false,governance:'governed'});
  assert.equal(badge.textContent,'Self-governed');assert.equal(description.textContent.includes('CANARY'),false);
  assert.equal(f.bar.root.querySelector('[data-control=approvals]').title,'ResonantOS approvals: 2 pending');
});
```

Create the failing composition test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { mountEmbedView } from '../resonantos-side-panel-extension/src/side-panel-entry.js';
const d={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:'augmentor-v1-'+ 'a'.repeat(64)};
const settle=()=>new Promise(r=>setImmediate(r));
async function fixture(t,harness=d) {
  const dom=new JSDOM('<body></body>',{url:'https://extension.test/'});const calls=[];
  const event={addListener(){},removeListener(){}};
  const chromeApi={runtime:{getURL:p=>'chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl/'+p},tabs:{query:async()=>[],onUpdated:event,onActivated:event,onRemoved:event},storage:{onChanged:event,local:{get:async()=>({}),set:async()=>{}}}};
  const view=await mountEmbedView({documentRef:dom.window.document,windowRef:dom.window,chromeApi,locationRef:dom.window.location,getConnection:async()=>({bridgeUrl:'http://127.0.0.1:9',request:async(path)=>{calls.push(path);if(path==='/embed/session')return {hostPath:'/embed-host/?ticket='+ 'a'.repeat(43),harness};return {recordingEnabled:false,writeEpoch:randomUUID(),noticeKey:d.noticeKey,noticeVersion:1,noticeAcknowledged:false,available:true,problem:null};}})});
  t.after(()=>{view.bar.destroy();dom.window.close();});return {dom,view,calls};
}
test('real composition refuses foreign relays and retains safe proof state only',async t=>{
  const f=await fixture(t),frame=f.view.root.querySelector('iframe');
  const relay=(data,source=frame.contentWindow,origin='http://127.0.0.1:9')=>f.dom.window.dispatchEvent(new f.dom.window.MessageEvent('message',{source,origin,data}));
  relay({type:'augmentor-ready'});relay({type:'augmentor-status',online:true,busy:false,conversationId:'CANARY'});
  relay({type:'augmentor-result',text:'CANARY'});relay({type:'augmentor-event',event:'turn.finished',text:'CANARY'});
  relay({type:'augmentor-status',online:false,busy:false},{},'http://evil');
  await settle();assert.equal(f.view.state.ready,true);assert.equal(JSON.stringify(f.view.state.last).includes('CANARY'),false);
  assert.deepEqual(f.view.state.last,[{type:'augmentor-ready'},{type:'augmentor-status',online:true,busy:false}]);
  assert.equal(f.calls.some(p=>p.includes('/slots/')||p.includes('/grants')||p.endsWith('/recording')),false);
});
test('malformed descriptor never mounts an alternative harness and keeps escape controls',async t=>{
  const f=await fixture(t,{...d,label:'Other'});assert.equal(f.view.root.querySelector('iframe'),null);
  assert.ok(f.view.bar.root.querySelector('[data-control=workspace]'));assert.ok(f.view.bar.root.querySelector('[data-control=assistant]'));
  assert.equal(f.view.bar.root.querySelector('[data-tier]').textContent,'Self-governed');
});
```

- [ ] Run `node --test browser-first/test/embed-bar.test.mjs browser-first/test/embed-governance-composition.test.mjs`; expect missing badge and raw-history canary failures.
- [ ] Append to `embed-bar-model.js`:

```js
export function embedGovernanceDescription(_descriptor) {
  return 'Augmentor runs outside ResonantOS approvals. Its own approvals cover its tools. ResonantOS access still requires separate permission.';
}
```

Import this function with `embedStatusLabel` in `embed-bar.js`. Before `if (mode === 'embed')` that creates Page, declare `let tierDescription;`. Immediately after the Approvals click listener insert:

```js
    const badge=documentRef.createElement('span');badge.dataset.tier='self-governed';badge.className='embed-tier';badge.tabIndex=0;badge.textContent='Self-governed';
    tierDescription=documentRef.createElement('span');tierDescription.id='embed-tier-description';tierDescription.className='embed-tier-description';tierDescription.setAttribute('role','tooltip');tierDescription.textContent=embedGovernanceDescription(null);tierDescription.hidden=true;
    badge.setAttribute('aria-describedby',tierDescription.id);
    const showTier=()=>{tierDescription.hidden=false;},hideTier=()=>{tierDescription.hidden=true;};
    badge.addEventListener('focus',showTier);badge.addEventListener('mouseenter',showTier);badge.addEventListener('blur',hideTier);badge.addEventListener('mouseleave',hideTier);
    badge.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();hideTier();}});
    root.append(badge);
```

Append `tierDescription` after appending Status, keeping it outside the badge/status sibling pair:

```js
    root.append(tierDescription);
```

In `setStatus`, replace `status.textContent = label; status.title = label;` with:

```js
    let text=status.querySelector('.embed-status-text');
    if(!text){text=documentRef.createElement('span');text.className='embed-status-text';status.append(text);}
    text.textContent=label;status.title=label;
```

Replace the Page handler's `.finally(() => { page.disabled = false; });` with `.finally(() => { page.disabled = false; page.focus(); });` so dialog focus restoration completes after the action is reenabled. Change only the non-null Approvals label template to `` `ResonantOS approvals: ${count} pending` ``. Add `announce` and `setDescriptor(value) { if(tierDescription) tierDescription.textContent=embedGovernanceDescription(value); }` to the returned bar object. Append CSS:

```css
.embed-tier { flex: 0 0 auto; white-space: nowrap; font-size: 11px; line-height: 20px; padding: 0 5px; border: 1px solid var(--embed-bar-line); border-radius: 4px; }
.embed-tier:focus-visible { outline: 2px solid var(--embed-bar-focus); outline-offset: 1px; }
.embed-tier-description { position: absolute; top: 36px; right: 6px; max-width: 290px; padding: 8px; background: var(--embed-bar-bg); color: var(--embed-bar-text); border: 1px solid var(--embed-bar-line); border-radius: 4px; white-space: normal; font-size: 12px; }
@media (max-width: 360px) {
  .embed-status-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .embed-bar-status::before { content: ''; display: block; width: 7px; height: 7px; border-radius: 50%; background: #b2bac4; }
  .embed-bar-status[data-state="online"]::before { background: #8bd3a6; }
  .embed-bar-status[data-state="busy"]::before { background: #e7c778; }
}
.embed-dialog-overlay { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: #0009; padding: 12px; }
.embed-dialog { width: min(100%, 420px); box-sizing: border-box; padding: 16px; border: 1px solid #3b4149; border-radius: 8px; background: #111315; color: #eef1f4; font: 14px system-ui; }
.embed-dialog h2 { margin: 0 0 12px; font-size: 16px; }
.embed-dialog button { padding: 8px 12px; margin-right: 8px; background: #282e35; color: #eef1f4; border: 1px solid #68717d; border-radius: 4px; }
.embed-dialog button:focus-visible { outline: 2px solid #7fc4ff; outline-offset: 2px; }
```

In `side-panel-entry.js` add these imports, replace its opening declaration with `function mountSidePanelBar({ mode, sendContext = () => false, beforeShare, isShareCurrent, onShared, documentRef = globalThis.document, windowRef = globalThis.window, chromeApi = globalThis.chrome, locationRef = globalThis.location } = {}) {`, and replace its actions initializer with `const actions = createEmbedBarActions({ chromeApi, locationRef, sendContext, beforeShare, isShareCurrent, onShared });`:

```js
import { createEmbedGovernanceController } from './lib/embed-governance-controller.js';
import { confirmEmbedShare } from './lib/embed-governance-dialog.js';
import { validDescriptor } from './lib/generated/embed-governance-contract.js';
```

Replace `mountEmbedView` in full:

```js
export async function mountEmbedView({documentRef=globalThis.document,windowRef=globalThis.window,chromeApi=globalThis.chrome,locationRef=globalThis.location,getConnection=createEmbedConnection}={}) {
  documentRef.documentElement.classList.add('embed-mode');
  const root=documentRef.createElement('section');root.id='embed-root';documentRef.body.prepend(root);
  let frame=null,origin='',online=false,connection=null,descriptor=null,disposed=false;
  const state={ready:false,last:[],send(message){
    if(disposed||!state.ready||!online||!frame?.contentWindow||!RELAY_COMMANDS.has(message?.type))return false;
    try{if(message.type==='augmentor-context'&&new TextEncoder().encode(JSON.stringify(message)).byteLength>16000)return false;frame.contentWindow.postMessage(message,origin);return true;}catch{return false;}
  }};
  const controller=createEmbedGovernanceController({windowRef,chromeApi,
    request:(path,options)=>connection?connection.request(path,options):Promise.reject(Error('Activity unavailable')),
    announce:text=>bar.announce(text),
    confirmShare:label=>confirmEmbedShare({documentRef,label,returnFocus:bar.root.querySelector('[data-control=page]')})
  });
  state.last=controller.history;windowRef.__resonantosEmbed=state;
  const bar=mountSidePanelBar({mode:'embed',documentRef,windowRef,chromeApi,locationRef,
    sendContext:message=>state.send(message),beforeShare:controller.beginShare,isShareCurrent:controller.currentShare,onShared:controller.didShare});
  const offline=()=>{state.ready=false;online=false;bar.setStatus(null);controller.relay({source:frame?.contentWindow,origin,data:{type:'augmentor-status',online:false,busy:false}});};
  const relay=event=>{
    if(disposed||!frame||event.source!==frame.contentWindow||event.origin!==origin||!event.data||typeof event.data!=='object')return;
    if(event.data.type==='augmentor-ready')state.ready=true;
    if(event.data.type==='augmentor-status'&&typeof event.data.online==='boolean'&&typeof event.data.busy==='boolean'){
      online=event.data.online;bar.setStatus({online,busy:event.data.busy});
    }
    if(['augmentor-ready','augmentor-status','augmentor-event'].includes(event.data.type))controller.relay(event);
  };
  const bridgeChanged=(changes,area)=>{if(area==='local'&&changes.bridgeTargetOverride){offline();controller.destroy();descriptor=null;}};
  windowRef.addEventListener('message',relay);chromeApi?.storage?.onChanged?.addListener(bridgeChanged);
  const destroy=bar.destroy;
  bar.destroy=()=>{if(disposed)return;disposed=true;windowRef.removeEventListener('message',relay);chromeApi?.storage?.onChanged?.removeListener(bridgeChanged);controller.destroy();offline();destroy();};
  try {
    connection=await bounded(getConnection);
    const session=await bounded(()=>connection.request('/embed/session',{method:'POST',body:{}}));
    if(disposed)return {bar,root,state};
    if(typeof session.hostPath!=='string'||!/^\/embed-host\/\?ticket=[A-Za-z0-9_-]{43}$/.test(session.hostPath)||!validDescriptor(session.harness))throw Error('Invalid embed session');
    descriptor=session.harness;origin=new URL(connection.bridgeUrl).origin;bar.setDescriptor(descriptor);
    frame=documentRef.createElement('iframe');frame.title=descriptor.label;frame.allow='clipboard-write';frame.addEventListener('error',offline);
    frame.src=connection.bridgeUrl.replace(/\/$/,'')+session.hostPath;root.append(frame);
    controller.mount({frame:frame.contentWindow,origin,descriptor});
  }catch{offline();root.textContent='Unable to open the embedded chat. Check that the PoC bridge is running and try again.';}
  return {bar,root,state};
}
```

Update the existing composition fixture and raw-history assertion in `browser-first/test/side-panel-entry.test.mjs`, preserving all tab-refresh, permissions, relay-origin and teardown tests:

```bash
python3 - <<'PYTEST'
from pathlib import Path
p=Path('browser-first/test/side-panel-entry.test.mjs');s=p.read_text()
a="""      assert.equal(route, '/embed/session'); assert.equal(options.method, 'POST');
      return { hostPath: `/embed-host/?ticket=${'a'.repeat(43)}` };"""
b="""      const harness = { harnessId: 'addon.augmentor-embed', interfaceId: 'panel', label: 'Augmentor', governance: 'self-governed', noticeKey: 'augmentor-v1-' + 'a'.repeat(64) };
      if (route === '/embed-governance/state') return { recordingEnabled: false, writeEpoch: '12345678-1234-4234-8234-123456789abc', noticeKey: harness.noticeKey, noticeVersion: 1, noticeAcknowledged: false, available: true, problem: null };
      assert.equal(route, '/embed/session'); assert.equal(options.method, 'POST');
      return { hostPath: `/embed-host/?ticket=${'a'.repeat(43)}`, harness };"""
assert a in s;s=s.replace(a,b,1)
a="  assert.equal(view.state.last.length, 50); assert.equal(view.state.last[0].i, 10);"
b="""  assert.deepEqual(view.state.last, [{ type: 'augmentor-ready' }, { type: 'augmentor-status', online: true, busy: false }]);
  for (let i = 0; i < 60; i++) relay(frame.contentWindow, 'http://127.0.0.1:18873', { type: 'augmentor-status', online: true, busy: false, conversationId: 'CANARY-' + i });
  assert.equal(view.state.last.length, 50);
  assert.ok(view.state.last.every(row => JSON.stringify(row) === JSON.stringify({ type: 'augmentor-status', online: true, busy: false })));"""
assert a in s;s=s.replace(a,b,1)
p.write_text(s)
PYTEST
```

Update ownership: the side-panel-entry row may retain only `Frame identity, lifecycle and projected proof state`; its exclusion column must say `Protocol-domain persistence, raw relay history, new relay authority or slot selection`. The bar-model/bar rows receive safe descriptor data, never credentials. Add badge presentation to their existing responsibility text.

- [ ] Run `node --test browser-first/test/embed-bar.test.mjs browser-first/test/embed-governance-composition.test.mjs browser-first/test/embed-bar-model.test.mjs browser-first/test/side-panel-entry.test.mjs`; expect pass. Red evidence: the pre-fix composition test must expose the raw-history canary; temporarily remove `validDescriptor(session.harness)` and require malformed-descriptor mounting test to fail. Restore. Existing five control order and normal Assistant-only tests remain unchanged.
- [ ] Run this exact guard-mutation matrix after green. Each `rig-mutate` invocation must return zero (behavioral failure under mutation and byte-identical restoration). Inspect any failure; import or syntax errors are not guard evidence. The strings below are exact edits, not patterns.

```bash
python3 - <<'PYMUTATE'
from pathlib import Path
import shlex, subprocess
rig=str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate')
mutations=[('browser-first/resonantos-side-panel-extension/src/side-panel-entry.js', [('||!validDescriptor(session.harness)', '')])]
test_command='node --test browser-first/test/embed-governance-composition.test.mjs'
for filename,changes in mutations:
    edit='from pathlib import Path\np=Path('+repr(filename)+')\ns=p.read_text()\n'
    for before,after in changes:
        edit+='assert '+repr(before)+' in s\ns=s.replace('+repr(before)+','+repr(after)+',1)\n'
    edit+='p.write_text(s)\n'
    try:
        subprocess.run([rig,filename,'python3 -c '+shlex.quote(edit),test_command],check=True)
    finally:
        subprocess.run(['node','scripts/prepare-embed-governance.mjs'],check=True)
subprocess.run(shlex.split('node --test browser-first/test/embed-governance-composition.test.mjs'),check=True)
PYMUTATE
```

- [ ] Commit:

```bash
git diff --check
git add browser-first/resonantos-side-panel-extension/src/lib/embed-bar-model.js browser-first/resonantos-side-panel-extension/src/lib/embed-bar.js browser-first/resonantos-side-panel-extension/src/styles/side-panel/base-layout.css browser-first/resonantos-side-panel-extension/src/side-panel-entry.js browser-first/test/embed-bar.test.mjs browser-first/test/side-panel-entry.test.mjs browser-first/test/embed-governance-composition.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(embed): show self-governed tier and project relay proof safely"
```
### Task 10: Privacy recording choice, paged history and durable deletion

**Files:**
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/settings/privacy-section.js`, `browser-first/resonantos-side-panel-extension/src/styles/main-workspace/settings.css`, `docs/architecture/MODULE-OWNERSHIP.md`
- Create/Test: `browser-first/test/embed-governance-privacy.test.mjs`

**Interfaces:**
- Consumes: existing Settings context `getBridgeRequest(): (path:string,options?:{method?:string,body?:object,signal?:AbortSignal})=>Promise<object>`, six route payloads, `confirmEmbedAction(options):Promise<boolean>`.
- Produces: `mountEmbedActivityCard({container,documentRef,chromeApi?,request,confirm?}): {ready:Promise<void>,refresh():Promise<void>,destroy():void}`; `renderPrivacySection(container, context={})` keeps existing trust-boundary cards and mounts this additional card.

- [ ] Write the failing test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { mountEmbedActivityCard } from '../resonantos-side-panel-extension/src/lib/settings/privacy-section.js';
import { createEmbedGovernanceController } from '../resonantos-side-panel-extension/src/lib/embed-governance-controller.js';
const settle=()=>new Promise(r=>setImmediate(r));
const initial=()=>({recordingEnabled:true,writeEpoch:randomUUID(),noticeKey:'augmentor-v1-'+ 'a'.repeat(64),noticeVersion:1,noticeAcknowledged:true,available:true,problem:null});
async function fixture(t,request,confirm=async()=>true,chromeApi) {
  const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());const container=dom.window.document.querySelector('main');
  const card=mountEmbedActivityCard({container,documentRef:dom.window.document,chromeApi,request,confirm});t.after(()=>card.destroy());await card.ready;
  return {dom,container,card,checkbox:container.querySelector('input')};
}
test('load fails closed; toggles wait for durable acknowledgement and never display exception text',async t=>{
  const failed=await fixture(t,async()=>{throw Error('CANARY');});assert.equal(failed.checkbox.checked,false);assert.equal(failed.checkbox.disabled,true);assert.match(failed.container.textContent,/Recording unavailable/);assert.equal(failed.container.textContent.includes('CANARY'),false);
  let resolveSave;const state=initial();const f=await fixture(t,async(path)=>path.endsWith('/state')?state:new Promise(r=>resolveSave=r));
  f.checkbox.checked=false;f.checkbox.dispatchEvent(new f.dom.window.Event('change'));await settle();
  assert.equal(f.container.textContent.includes('Recording is off'),false);
  resolveSave({recordingEnabled:false,writeEpoch:randomUUID()});await settle();assert.match(f.container.textContent,/Recording is off/);
});
test('Settings off reaches another page, clears queued data and fences reads before durable save',async t=>{
  const listeners=new Set(),signals=[],chromeApi={storage:{onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},local:{set:async value=>{signals.push(value);for(const fn of listeners)fn(Object.fromEntries(Object.entries(value).map(([key,newValue])=>[key,{newValue}])), 'local');}}}};
  const panel=new JSDOM('<main></main>');t.after(()=>panel.window.close());
  const state=initial(),posts=[];let save,oldRead,holdRead=false;
  const controller=createEmbedGovernanceController({windowRef:panel.window,chromeApi,confirmShare:async()=>true,request:async(path,options)=>{
    if(path.endsWith('/state'))return holdRead?new Promise(resolve=>oldRead=resolve):{...state};
    posts.push(options);return new Promise(()=>{});
  }});t.after(()=>controller.destroy());
  const frame={},descriptor={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:state.noticeKey};
  controller.mount({frame,origin:'http://127.0.0.1:9',descriptor});await controller.refresh();
  const relay=()=>controller.relay({source:frame,origin:'http://127.0.0.1:9',data:{type:'augmentor-event',event:'tool.finished',toolName:'read',error:false}});
  relay();relay();await settle();assert.equal(posts.length,1);
  holdRead=true;const stale=controller.refresh();await settle();
  const f=await fixture(t,async path=>path.endsWith('/state')?{...state}:new Promise(resolve=>save=resolve),async()=>true,chromeApi);
  assert.notEqual(f.dom.window,panel.window);
  f.checkbox.checked=false;f.checkbox.dispatchEvent(new f.dom.window.Event('change'));await settle();
  assert.equal(signals[0]['resonantos.embedRecordingChange'].pending,true);
  assert.equal(posts[0].signal.aborted,true);assert.equal(controller.history.length,0);
  oldRead({...state});await stale;await controller.refresh();relay();await settle();
  assert.equal(posts.length,1);assert.equal(f.container.textContent.includes('Recording is off'),false);
  holdRead=false;state.recordingEnabled=false;state.writeEpoch=randomUUID();save({recordingEnabled:false,writeEpoch:state.writeEpoch});await settle();await settle();
  assert.match(f.container.textContent,/Recording is off/);assert.equal(signals.at(-1)['resonantos.embedRecordingChange'].pending,false);
  relay();await settle();assert.equal(posts.length,1);
  controller.destroy();assert.equal(listeners.size,0);
});
test('delete recovery snapshot wins over older reads and clears rows before success',async t=>{
  let reads=0,oldRead;const state={...initial(),problem:'storage-unavailable',writeEpoch:null,recordingEnabled:false,noticeAcknowledged:false};
  const f=await fixture(t,async(path)=>{
    if(path.endsWith('/state')){reads++;if(reads===1)return state;return new Promise(r=>oldRead=r);}
    if(path.endsWith('/events/delete'))return {deleted:true,recordingEnabled:false,writeEpoch:randomUUID(),noticeKey:state.noticeKey,noticeAcknowledged:false};
    return {events:[],nextBefore:null};
  });
  const stale=f.card.refresh();await settle();f.container.querySelector('[data-action=delete]').click();await settle();
  oldRead(initial());await stale;assert.equal(f.checkbox.checked,false);assert.equal(f.container.dataset.noticeAcknowledged,'false');assert.match(f.container.textContent,/Activity deleted/);
});
test('history is text only, pagination expires explicitly and deletion failure retains rows',async t=>{
  let failDelete=false,expired=false;const state=initial();
  const f=await fixture(t,async(path)=>{
    if(path.endsWith('/state'))return state;
    if(path.endsWith('/events/delete')){if(failDelete)throw Error('CANARY');return {deleted:true,...state};}
    if(path.includes('?before=')){expired=true;throw Object.assign(Error(),{code:'cursor-expired'});}
    return {events:[{version:1,eventId:randomUUID(),recordedAt:new Date().toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',source:'local-share',event:{kind:'page-shared',domain:'example.test'}}],nextBefore:randomUUID()};
  });
  f.container.querySelector('[data-action=view]').click();await settle();assert.match(f.container.textContent,/example.test/);assert.equal(f.container.querySelectorAll('a').length,0);
  f.container.querySelector('[data-action=older]').click();await settle();await settle();assert.equal(expired,true);
  failDelete=true;f.container.querySelector('[data-action=delete]').click();await settle();assert.match(f.container.textContent,/Activity could not be deleted/);assert.match(f.container.textContent,/example.test/);
});
```

Append the rejected-content test to that file:

```js
test('history rejects content-bearing metadata without rendering it',async t=>{
  const f=await fixture(t,async path=>path.endsWith('/state')?initial():{events:[{version:1,eventId:randomUUID(),recordedAt:new Date().toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',event:{kind:'page-shared',domain:'example.test',url:'CANARY'}}],nextBefore:null});
  f.container.querySelector('[data-action=view]').click();await settle();
  assert.match(f.container.textContent,/Activity unavailable/);assert.equal(f.container.textContent.includes('CANARY'),false);
});
```

Add a cancellation case for deletion:

```js
test('cancelled deletion does not mutate host state',async t=>{
  const calls=[];const f=await fixture(t,async path=>{calls.push(path);return initial();},async()=>false);
  f.container.querySelector('[data-action=delete]').click();await settle();
  assert.deepEqual(calls,['/embed-governance/state']);assert.equal(f.container.textContent.includes('Activity deleted'),false);
});
```

- [ ] Run `node --test browser-first/test/embed-governance-privacy.test.mjs`; expect missing export.
- [ ] Add these imports to the existing Privacy module and append the complete card implementation:

```js
import { confirmEmbedAction } from '../embed-governance-dialog.js';
import { metadata, UUID, NOTICE_KEY } from '../generated/embed-governance-contract.js';
export function mountEmbedActivityCard({container,documentRef=globalThis.document,chromeApi=globalThis.chrome,request,confirm=options=>confirmEmbedAction(options)}) {
  const card=documentRef.createElement('section');card.className='settings-control-list embed-activity-card';card.dataset.embedActivity='true';
  const heading=documentRef.createElement('h3');heading.textContent='Embedded harness activity';
  const label=documentRef.createElement('label'),checkbox=documentRef.createElement('input');checkbox.type='checkbox';checkbox.disabled=true;checkbox.checked=false;
  label.append(checkbox,documentRef.createTextNode('Record harness activity'));
  const description=documentRef.createElement('p');description.textContent='Save conversation changes, reply starts and finishes, tool names and error flags, and shared page domains on this computer for 30 days. No prompts, replies, tool arguments or results are saved.';
  const status=documentRef.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Recording unavailable';
  const note=documentRef.createElement('p');note.textContent='Local metadata only. Harness events are reports from the outside harness, not ResonantOS approval receipts. Recording can miss events while the side panel is closed or disconnected.';
  const controls=documentRef.createElement('div'),list=documentRef.createElement('ol');list.hidden=true;
  const buttons={};for(const [key,text] of [['view','View activity'],['refresh','Refresh'],['older','Load older'],['delete','Delete activity']]){const b=documentRef.createElement('button');b.type='button';b.textContent=text;b.dataset.action=key;buttons[key]=b;controls.append(b);}
  buttons.older.disabled=true;card.append(heading,label,description,status,note,controls,list);container.append(card);
  let dead=false,sequence=0,pageSequence=0,snapshot=null,nextBefore=null,rows=[];
  const say=text=>{if(!dead)status.textContent=text;};
  function validSnapshot(s) {
    return s&&typeof s.recordingEnabled==='boolean'&&(s.writeEpoch===null||typeof s.writeEpoch==='string'&&UUID.test(s.writeEpoch))&&(s.noticeKey===null||typeof s.noticeKey==='string'&&NOTICE_KEY.test(s.noticeKey))&&typeof s.noticeAcknowledged==='boolean'&&typeof s.available==='boolean'&&[null,'storage-unavailable','retention-failed','log-full'].includes(s.problem);
  }
  function renderState(s) {
    if(!validSnapshot(s))throw Error('Invalid activity state');snapshot=s;
    checkbox.checked=s.recordingEnabled;checkbox.disabled=s.problem==='storage-unavailable'||(!s.available&&!s.recordingEnabled);
    container.dataset.noticeAcknowledged=String(s.noticeAcknowledged);
    container.dataset.writeEpoch=s.writeEpoch??'';
    const problems={'storage-unavailable':'Recording unavailable','retention-failed':'Retention cleanup failed','log-full':'Activity recording paused: local log is full'};
    say(problems[s.problem]??(s.recordingEnabled?'Recording is on':'Recording is off'));
  }
  function descriptionFor(event) {
    if(event.kind==='tool-finished')return `Tool: ${event.toolName} — ${event.error?'Error':'No error reported'}`;
    if(event.kind==='page-shared')return `Page shared: ${event.domain}`;
    return {'conversation-changed':'Conversation changed','reply-started':'Reply started','reply-finished':'Reply finished'}[event.kind];
  }
  function renderRows(){list.replaceChildren();list.hidden=false;for(const record of rows){const li=documentRef.createElement('li');li.textContent=`${record.recordedAt} · Augmentor · Self-governed · ${descriptionFor(record.event)}`;list.append(li);}if(!rows.length){const li=documentRef.createElement('li');li.textContent='No recorded activity';list.append(li);}buttons.older.disabled=!nextBefore;}
  async function refresh(){const seq=++sequence;try{const s=await request('/embed-governance/state');if(!dead&&seq===sequence)renderState(s);}catch{if(!dead&&seq===sequence){snapshot=null;checkbox.checked=false;checkbox.disabled=true;say('Recording unavailable');}}}
  async function load(older=false){const seq=++pageSequence;const anchor=older?nextBefore:null;try{
    const page=await request('/embed-governance/events'+(anchor?'?before='+encodeURIComponent(anchor):''));
    if(dead||seq!==pageSequence)return;
    if(!Array.isArray(page.events)||page.events.length>100||!(page.nextBefore===null||typeof page.nextBefore==='string'&&UUID.test(page.nextBefore)))throw Error();
    const clean=page.events.map(r=>{const event=metadata(r.event);if(!event||typeof r.recordedAt!=='string'||!Number.isFinite(Date.parse(r.recordedAt))||new Date(r.recordedAt).toISOString()!==r.recordedAt||r.harnessId!=='addon.augmentor-embed'||r.interfaceId!=='panel'||r.governance!=='self-governed')throw Error();return {recordedAt:r.recordedAt,event};});
    rows=older?[...rows,...clean]:clean;nextBefore=page.nextBefore;renderRows();
  }catch(e){if(dead||seq!==pageSequence)return;if(e?.code==='cursor-expired'){rows=[];nextBefore=null;list.replaceChildren();await load(false);}else say('Activity unavailable');}}
  checkbox.addEventListener('change',()=>{const enabled=checkbox.checked,seq=++sequence;checkbox.disabled=true;
    checkbox.checked=snapshot?.recordingEnabled??false;say('Saving recording preference');
    const changeId=crypto.randomUUID();
    const signal=pending=>chromeApi?.storage?.local?.set({'resonantos.embedRecordingChange':{id:changeId,pending}});
    void (async()=>{
      // Pause recipients before awaiting the durable host write; never store consent here.
      if(!enabled)try{await signal(true);}catch{ /* Host disablement still proceeds. */ }
      try{const s=await request('/embed-governance/recording',{method:'POST',body:{enabled}});if(!dead&&seq===sequence)renderState({...snapshot,...s});}
      catch{if(!dead&&seq===sequence){await refresh();say('Recording preference could not be saved');}}
      finally{try{await signal(false);}catch{ /* Recipients already paused stay fail-closed until remount if settlement fails. */ }}
    })();
  });
  buttons.view.addEventListener('click',()=>{void load();});buttons.refresh.addEventListener('click',()=>{void refresh();void load();});buttons.older.addEventListener('click',()=>{if(nextBefore)void load(true);});
  buttons.delete.addEventListener('click',()=>{void(async()=>{
    const recovery=snapshot?.problem==='storage-unavailable';
    let accepted;try{accepted=await confirm({documentRef,returnFocus:buttons.delete,heading:recovery?'Reset unreadable harness activity?':'Delete all recorded harness activity on this computer?',description:recovery?'This turns recording off and clears remembered first-share notices.':'This keeps your recording choice and first-share notices.',confirmLabel:'Delete activity'});}catch{say('Activity could not be deleted');return;}
    if(!accepted||dead)return;
    const seq=++sequence;++pageSequence;buttons.delete.disabled=true;
    try{const s=await request('/embed-governance/events/delete',{method:'POST',body:{}});if(dead||seq!==sequence)return;if(s.deleted!==true)throw Error();
      renderState({...snapshot,...s,problem:null});rows=[];nextBefore=null;renderRows();say('Activity deleted');
    }catch{if(!dead&&seq===sequence)say('Activity could not be deleted');}
    finally{if(!dead)buttons.delete.disabled=false;}
  })();});
  const ready=refresh();return {ready,refresh,destroy(){dead=true;sequence++;pageSequence++;card.remove();}};
}
```

Change the existing signature to `renderPrivacySection(container, context = {})`. After the existing `container.replaceChildren` statement, before the closing brace of `renderPrivacySection`, add:

```js
  mountEmbedActivityCard({container,documentRef:container.ownerDocument,
    request:(path,options)=>{
      const bridge=typeof context.getBridgeRequest==='function'?context.getBridgeRequest():context.bridgeRequest;
      return typeof bridge==='function'?bridge(path,options):Promise.reject(Error('Activity unavailable'));
    }
  });
```

Append these complete dialog rules to `browser-first/resonantos-side-panel-extension/src/styles/main-workspace/settings.css` (these are the exact rules needed by the workspace, which does not load side-panel CSS):

```css
.embed-dialog-overlay { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: #0009; padding: 12px; }
.embed-dialog { width: min(100%, 420px); box-sizing: border-box; padding: 16px; border: 1px solid #3b4149; border-radius: 8px; background: #111315; color: #eef1f4; font: 14px system-ui; }
.embed-dialog h2 { margin: 0 0 12px; font-size: 16px; }
.embed-dialog button { padding: 8px 12px; margin-right: 8px; background: #282e35; color: #eef1f4; border: 1px solid #68717d; border-radius: 4px; }
.embed-dialog button:focus-visible { outline: 2px solid #7fc4ff; outline-offset: 2px; }
.embed-activity-card ol { padding-left: 24px; overflow-wrap: anywhere; }
.embed-activity-card label { display: flex; gap: 8px; align-items: center; }
```

Append ownership:

```markdown
| `browser-first/resonantos-side-panel-extension/src/lib/settings/privacy-section.js` | Explicit recording controls and paged read/delete presentation | Validated host snapshots and safe metadata | Privacy DOM and acknowledged user intents; deletion supersedes older reads | Filesystem policy, authoritative preference cache, payload logs or credentials |
```

- [ ] Run `node --test browser-first/test/embed-governance-privacy.test.mjs browser-first/test/main-workspace-settings.test.mjs`; expect pass. Red evidence: remove `seq===sequence` from the state-read acknowledgement check and require the delete-recovery race test to fail. Restore. Replace `metadata(r.event)` with `r.event` in `load`; require the rejected-content test to fail, then restore. No failed load may be rendered as empty success.
- [ ] Run this exact guard-mutation matrix after green. Each `rig-mutate` invocation must return zero (behavioral failure under mutation and byte-identical restoration). Inspect any failure; import or syntax errors are not guard evidence. The strings below are exact edits, not patterns.

```bash
python3 - <<'PYMUTATE'
from pathlib import Path
import shlex, subprocess
rig=str(Path.home()/'.claude/skills/resonant-rig/scripts/rig-mutate')
mutations=[('browser-first/resonantos-side-panel-extension/src/lib/settings/privacy-section.js', [('if(!dead&&seq===sequence)renderState(s)', 'if(!dead)renderState(s)')]), ('browser-first/resonantos-side-panel-extension/src/lib/settings/privacy-section.js', [('const event=metadata(r.event)', 'const event=r.event')]), ('browser-first/resonantos-side-panel-extension/src/lib/settings/privacy-section.js', [('if(!accepted||dead)return;', 'if(dead)return;')])]
test_command='node --test browser-first/test/embed-governance-privacy.test.mjs'
for filename,changes in mutations:
    edit='from pathlib import Path\np=Path('+repr(filename)+')\ns=p.read_text()\n'
    for before,after in changes:
        edit+='assert '+repr(before)+' in s\ns=s.replace('+repr(before)+','+repr(after)+',1)\n'
    edit+='p.write_text(s)\n'
    try:
        subprocess.run([rig,filename,'python3 -c '+shlex.quote(edit),test_command],check=True)
    finally:
        subprocess.run(['node','scripts/prepare-embed-governance.mjs'],check=True)
subprocess.run(shlex.split('node --test browser-first/test/embed-governance-privacy.test.mjs'),check=True)
PYMUTATE
```

- [ ] Commit:

```bash
git diff --check
git add browser-first/resonantos-side-panel-extension/src/lib/settings/privacy-section.js browser-first/resonantos-side-panel-extension/src/styles/main-workspace/settings.css browser-first/test/embed-governance-privacy.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(settings): expose embedded harness consent and activity"
```
### Task 12: Final acceptance matrix and complete deterministic gates

**Files:**
- Create/Test: `browser-first/test/embed-governance-acceptance.test.mjs`
- Modify: `browser-first/README.md`
- Test: every file named in the command below, including existing touched regression files.

**Interfaces:**
- Consumes: `createEmbedHostService({env:Record<string,string>}):{enabled:boolean,getDescriptor():EmbedHarnessDescriptor|null,embedRoutes:Array<object>,matches(url:string):boolean,close():void}`, `createEmbedGovernanceHostService({userRoot:string,getDescriptor:()=>EmbedHarnessDescriptor|null}):Promise<{governanceRoutes:Array<object>,close():Promise<void>}>`, `startBridgeServer({port:number,host:string,bridgeToken:string,bridgeCapabilityTokens:Record<string,string>,extensionOrigin:string,routes:Array<object>,embedService:object}):Promise<import("node:http").Server>`, `capabilityForBridgeRoute(route:string,method?:string):string`, all six route payloads in Global Constraints, and `browser-first/README.md`.
- Produces: deterministic composition acceptance; separate pending/passed conductor live evidence. No new runtime API.

- [ ] Write the failing test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmbedHostService } from '../host/embed-host-service.mjs';
import { createEmbedGovernanceHostService } from '../host/embed-governance-host-service.mjs';
import { startBridgeServer } from '../host/bridge-server.mjs';
import { capabilityForBridgeRoute } from '../resonantos-side-panel-extension/src/lib/bridge-client.js';
const origin='chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl';
test('enabled and disabled compositions use authenticated governance, never the cookie proxy',async t=>{
  for(const enabled of [false,true]) {
    const userRoot=await mkdtemp(join(await realpath(tmpdir()),'embed-accept-')),tokenFile=join(userRoot,'fixture-token');
    await writeFile(tokenFile,'synthetic-upstream-token',{mode:0o600});
    const embed=createEmbedHostService({env:enabled?{RESONANTOS_EMBED_POC:'1',RESONANTOS_EMBED_UPSTREAM_URL:'http://127.0.0.1:18872',RESONANTOS_EMBED_PROFILE:'proof',RESONANTOS_EMBED_TOKEN_FILE:tokenFile}:{}});
    const service=await createEmbedGovernanceHostService({userRoot,getDescriptor:()=>embed.getDescriptor()});
    const tokens=Object.fromEntries(service.governanceRoutes.map(r=>[r.requiredCapability,randomUUID()]));tokens['addon-runtime-control']=randomUUID();
    const server=await startBridgeServer({port:0,host:'127.0.0.1',bridgeToken:'bridge',bridgeCapabilityTokens:tokens,extensionOrigin:origin,routes:[...embed.embedRoutes,...service.governanceRoutes],embedService:embed});
    t.after(async()=>{await service.close();embed.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(userRoot,{recursive:true,force:true});});
    async function call(path,method='GET',body){const res=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':tokens[capabilityForBridgeRoute(path,method)]},...(method==='POST'?{body:JSON.stringify(body)}:{})});return {status:res.status,payload:await res.json()};}
    for(const r of service.governanceRoutes){assert.equal(embed.matches(r.path),false);const res=await fetch(`http://127.0.0.1:${server.address().port}${r.path}`,{method:r.method,headers:{Origin:origin,Cookie:'ros_embed=fixture'},...(r.method==='POST'?{body:'{}'}:{})});assert.equal(res.status,401);}
    const state=(await call('/embed-governance/state')).payload;assert.equal(state.available,enabled);assert.equal(state.recordingEnabled,false);
    if(enabled){
      const on=(await call('/embed-governance/recording','POST',{enabled:true})).payload;
      assert.equal((await call('/embed-governance/events','POST',{writeEpoch:on.writeEpoch,eventId:randomUUID(),event:{kind:'page-shared',domain:'example.test'}})).payload.recorded,true);
      assert.equal((await call('/embed-governance/events')).payload.events.length,1);
    }
    assert.equal((await call('/embed-governance/events/delete','POST',{})).payload.deleted,true);
  }
});
test('operator docs separate deterministic results from live acceptance and release authority',async()=>{
  const doc=await readFile(new URL('../README.md',import.meta.url),'utf8');
  assert.ok(doc.includes('Deterministic green does not complete EMBED-UPSTREAM-1 or authorize a merge into dev.'));
});
```

- [ ] Run `node --test browser-first/test/embed-governance-acceptance.test.mjs`; expect the final documentation assertion to fail until the acceptance boundary is added. Runtime failures are implementation defects, not evidence to waive.
- [ ] Minimal implementation: append this exact sentence to the testing-branch activity section in `browser-first/README.md`:

```markdown
Deterministic green does not complete EMBED-UPSTREAM-1 or authorize a merge into dev.
```

- [ ] After Tasks 7–10, the conductor repeats the upstream checks and runs final integration with Task 11's prepared script and private configuration:

```bash
RESONANTOS_EMBED_LIVE_STAGE=integration node browser-first/test/embed-live.mjs
```

Expected: all live checks pass against the integrated feature. Workers do not execute this command; absent conductor evidence remains pending.

- [ ] Run every touched test file explicitly, then all required repository gates:

```bash
node --test --test-concurrency=1 browser-first/test/embed-interface-validation.test.mjs browser-first/test/embed-governance-contract.test.mjs browser-first/test/embed-descriptor.test.mjs browser-first/test/embed-host-service.test.mjs browser-first/test/embed-governance-storage.test.mjs browser-first/test/embed-governance-host-service.test.mjs browser-first/test/embed-governance-transport.test.mjs browser-first/test/bridge-route-capability-audit.test.mjs browser-first/test/embed-governance-controller.test.mjs browser-first/test/embed-first-share.test.mjs browser-first/test/embed-bar-actions.test.mjs browser-first/test/embed-bar.test.mjs browser-first/test/side-panel-entry.test.mjs browser-first/test/embed-governance-composition.test.mjs browser-first/test/embed-governance-privacy.test.mjs browser-first/test/embed-live-contract.test.mjs browser-first/test/embed-governance-acceptance.test.mjs
node scripts/prepare-embed-governance.mjs --check
node --check browser-first/test/embed-live.mjs
npm run test:browser-first
npm run docs:check
npm run test:docs
node scripts/security-pipeline/run-check.mjs
npm test -- --run
npm run build
node --test --test-concurrency=1 scripts/module-ownership-doc.test.mjs
npm run verify:alpha
```

Expected: all deterministic commands exit zero. `npm test -- --run` and `npm run build` are mandatory because Task 1 changes shared TypeScript. Record exact commands and actual outcomes outside Git; do not invent counts or hide baseline failures. `verify:alpha` is required for this cross-module final certification. Live proof remains conductor-owned and separately reported.

- [ ] Review the complete diff for credentials, raw payloads, unrelated changes, interface-to-slot calls, and accidental SDK inclusion of `embed-governance-consent-write`. Verify every guard's red evidence exists and the restored implementation is green. No mutation or generated bridge credential is staged.
- [ ] Commit:

```bash
git diff --check
git add browser-first/test/embed-governance-acceptance.test.mjs browser-first/README.md
git commit -m "test(embed): gate governance integration and document acceptance limits"
```

## Self-review

### Spec coverage

| Spec requirement | Task(s) and evidence |
| --- | --- |
| Approved decisions 1–5, beta/testing/off-by-default, no ADR allocation or merge authority | Global Constraints; 1, 3, 11, 12 |
| Additive 0.1.0 interface types, exports, legacy absence/undefined/empty behavior | 1 |
| Every validator row: closed fields, bounds, exact mode/tier, unique capabilities, both subset directions, backing runtime/surface and dependency union | 1 parameterized validator tests |
| Complete example manifests and dual view under one ID; no synthetic interfaces or picker | 1 reads the actual spec JSON; unchanged registry clone path in Findings |
| Host identity, origin-bound notice key, profile-independent acknowledgement, fixed tier, disabled harness:null | 3 |
| Host custody, unchanged tunnel guards, no manifest launch, no capability relay | 3, 6, 9, 12 plus existing embed-host tests |
| Visible Self-governed badge, 36px, 320/420px, dot, focus, description/Escape, Approvals copy, normal Assistant-only | 9 deterministic tests; 11 conductor layout/accessibility proof |
| Canonical pure metadata module, generated extension parity, shared redaction behavior | 2 |
| Closed metadata, strict names/booleans, UUID v4, host-stamped identity/time/source, domain normalization and no content | 2, 5, 7, 9, 12 |
| Exact relay mapping, baselines, no synthetic finish, safe 50-entry history | 7, 9; 11 prerequisite and repeat proof |
| Recording defaults off, no backfill, 5-second poll/focus, 32 queue, one request, 2-second timeout, no retry/beacon, lifecycle destruction | 7 |
| First-share recipient-specific consent; cancellation/navigation/permission/frame/offline attempts remember nothing; final synchronous dispatch | 7, 8 |
| Recording independent from notice; 2-second remember, mount-only fallback; origin changes invalidate acknowledgement | 3, 5, 7, 8 |
| External canonical root, every ancestor link rejection, private modes/ownership, path pinning | 4 |
| Single-writer lock, PID/UUID only, ESRCH-only takeover, PID reuse limit, safe close/temp cleanup | 4 |
| Serialized atomic state, file and directory flush, restart durability, invalid recovery | 4, 5 |
| 30-day inclusive cutoff, startup/hourly/read/write while disabled, rollback, failure exclusion and retry | 5 |
| 10,000 records, 10MiB state, 1024-byte record, full drop preserving history | 2, 4, 5 |
| Six route shapes, namespace outside proxy, separate consent capability, mint/client/audit parity | 5, 6, 12 |
| Bridge token, loopback Host, exact single Origin, wildcard rejection, fixed public errors for methods/paths/parsers/exceptions/IP | 6 |
| Streaming 512/2048 raw-byte limits, GET-body rejection, no-store and empty OPTIONS 204 | 6 |
| Epoch rotation, idempotent toggles, duplicate IDs, stale appends cannot restore deleted history | 5, 7 |
| Paged newest-first reads, cursor expiry, safe text rows, delete confirmation/recovery, late-read suppression | 5, 10 |
| Logging failure isolation, once-per-episode notice, no raw diagnostics, unchanged Page/Workspace/Assistant access | 7–11 |
| Ownership map updated when each module is added; thin composition | 1–10 |
| Full deterministic gates and separate conductor live acceptance | 11, 12 |
| Review G1–G6, D1–D10 | G1: 7–8; G2: 4; G3: 6; G4: 6/10; G5: 2; G6: 3/7/11; D1: 1/6; D2–D4: 6; D5–D7: 1; D8–D10: 3–5 |

### Placeholder scan

Run against this plan only:

```bash
rg -n 'TBD|TODO|implement later|fill in details|similar to task|appropriate error handling|handle edge cases|<placeholder>' docs/planning/embed-governance-plan.md
```

The sole permitted match is this scan command's own pattern. There are no unspecified external recipient values in code: the conductor supplies named required environment variables and explicitly verifies their context. New module exports and code snippets are defined in their task. No runtime files were created while authoring this document.

### Name/signature consistency

- `AddOnManifest.interfaces` flows through `AddOnSdkManifest`; interface dependencies use capability values only.
- Core `metadata`, `domainFromUrl`, `validDescriptor`, `exact`, `UUID`, `NOTICE_KEY`, `LIMITS`, `activityError`, and `publicActivityError` have one canonical definition and deterministic copies.
- Host storage is `openEmbedGovernanceStorage`; host policy is `createEmbedGovernanceHostService`; its array is consistently `governanceRoutes` in constructor, launcher, tests and audit.
- The fixed descriptor uses `harnessId`, `interfaceId`, `label`, `governance`, `noticeKey`; records omit noticeKey and label, and the notice map alone persists notice keys.
- Controller methods `beginShare`, `currentShare`, `didShare` connect to actions as `beforeShare`, `isShareCurrent`, `onShared`. The URL callback receives `message.context.page.url` after sanitization.
- `confirmEmbedShare` delegates to `confirmEmbedAction`; Privacy uses the same accessible boolean confirmation primitive, without receiving a bridge config.
- All six method/path pairs, public codes, capability names, byte limits, payloads and delete snapshots match Global Constraints. No `message` error field replaces `error`.
- The shared TypeScript scope is explicit in the final gates. Live proof is written/syntax-checked by workers and run only by the conductor. It is not claimed complete by this plan.

- Original plan-author validation (before review 1): Only this plan was written. The documentation validator passed during authoring. JavaScript, TypeScript and Python code fences were syntax-checked through stdin or in memory; object-property fragments were checked in their stated enclosing object. The live script was parsed without execution. All 50 task-owned paths appear in File Structure, and every touched test file appears in Task 12. No implementation tests, mutation commands, live bridge/container proof or commits were executed during planning.

- Review 1 revision: see [finding decisions and verification](embed-governance-plan-review-1.md). Only this plan and that review table are changed; approved spec and decisions remain fixed. Execution order is Tasks 1–6, Task 11 proof preparation/upstream gate, Tasks 7–10, then Task 12 integration/final gates.
