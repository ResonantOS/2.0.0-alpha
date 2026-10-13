# Embedded harness interfaces, authority and local event history

Status: design specification only. No runtime behavior is implemented by this
document. It applies to `testing/augmentor-embed-sidecar` and targets beta.
The embed experiment remains off unless `RESONANTOS_EMBED_POC=1` is set.
It is outside the Alpha release.

## Authority and scope

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

## Current implementation and chosen approach

`packages/addon-sdk/src/validation.ts` is the canonical manifest validator.
The SDK imports manifest types from `src/core/contracts.ts`. The old
`src/sdk/addons/` files are compatibility exports. Extend this arrangement.
Do not create a second manifest model.

`embed-host-service.mjs` reads operator configuration, holds the harness token,
issues embed tickets and proxies HTTP and WebSocket traffic. Its host page
relays messages between the harness frame and the extension. The Node proxy
does not decode harness events. `side-panel-entry.js` receives the relayed
`augmentor-status` and `augmentor-event` messages. That is the capture point.

The bridge currently exposes `{ available, profile }` through `/embed/status`.
The bar consumes online and busy state. It has no authority tier or event store.
`side-panel-entry.js` also retains up to 50 raw relay objects in
`window.__resonantosEmbed.last`. Replace that raw history with the safe
projection described below when implementing this design.

Use a declarative SDK extension plus a small host-owned governance service.
Do not make the PoC discover or launch manifests. That would mix schema work
with registry and lifecycle migration. Do not decode proxy traffic for logging.
It would duplicate protocol handling and put private payloads in the host log
path. Capture a safe projection in the extension and validate it again at the
host instead.

## 1. Manifest `interfaces[]`

### Type contract

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

### Validator rules

Add one interface-validation pass after existing surface, tool and runtime
validation in `packages/addon-sdk/src/validation.ts`. All failures below have
severity `error`. Validation is pure. It does not load modules, read files,
resolve endpoints, grant capabilities or mutate the input.

| Field or relation | Exact rule | Issue code |
| --- | --- | --- |
| `interfaces` | Omitted or JavaScript `undefined` skips the entire new pass. Otherwise require an array of 0 to 16 entries. `null` is invalid. | `interfaces-array` |
| Entry | Require a plain JSON object. Permit only the base keys and keys for its mode. Reject all unknown keys, including endpoints, credentials, defaults and executable paths. | `interface-object`, `interface-field` |
| `id` | Match `^[a-z][a-z0-9-]{0,63}$`. IDs must be unique within the list. Do not trim or repair input. | `interface-id`, `duplicate-interface-id` |
| `label` | String of 1 to 80 Unicode code points, already trimmed, with no U+0000 through U+001F or U+007F. Render as text. | `interface-label` |
| `mode` | Exactly `adapter-chat` or `embed`. Reject `web`, `terminal` and all other values. | `interface-mode` |
| `governance` | Exactly `governed` or `self-governed`. Required for every entry. | `interface-governance` |
| `requiredCapabilities` | Required array of unique values from `ADDON_CAPABILITIES`. Each must occur in `requestedCapabilities[].capability`. Empty arrays fail the mode-specific rules below. | `interface-capabilities`, `interface-unrequested-capability` |
| Adapter reference | `agentRuntimeRef` must equal `agentRuntime`. Require a valid `agentRuntime` object with the complete version 1 adapter contract. Legacy invocation-tool-only runtimes remain valid without this interface, but cannot back a new `adapter-chat` entry. Forbid `surfaceId`. | `interface-runtime-reference` |
| Adapter dependencies | Require `agent-runtime`. Include every capability in `agentRuntime.requiredCapabilities`, its invocation tool, and its model-selection contract and change tool when model selection is supported. | `interface-missing-capability` |
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

### Compatibility and selection

Absent means unchanged. Old manifests keep the same validity, diagnostics,
installation behavior, surfaces, slots and dispatch. Do not synthesize
interfaces for them or write migration data. An empty list declares no new
interface choices and also leaves legacy behavior intact.

The list describes choices; it does not choose a default. List order confers no
priority. This step adds no generic interface picker or bridge dependency on
the list. Existing surface routing continues to use host projections and
grants. Preserve interfaces as manifest data through the existing registry.

### Example manifests

This complete proposed manifest describes the current external Augmentor PoC.
It does not install, enable or grant the PoC. Its ID is deliberately distinct
from the bundled `addon.augmentor-chat` identity.

```json
{
  "sdkVersion": "0.1.0",
  "id": "addon.augmentor-embed",
  "name": "Augmentor",
  "version": "0.1.0",
  "author": "Manolo Remiddi",
  "category": "agent",
  "description": "External Augmentor interface through the local embed proxy.",
  "runtimeType": "embedded-module",
  "surfaces": [
    {
      "id": "augmentor-panel",
      "type": "embedded-pane",
      "label": "Augmentor",
      "description": "The harness's own panel."
    }
  ],
  "requestedCapabilities": [
    {
      "capability": "ui-embedding",
      "granted": false,
      "scope": "self",
      "revocationBehavior": "hide-surface"
    }
  ],
  "interfaces": [
    {
      "id": "panel",
      "label": "Augmentor",
      "mode": "embed",
      "governance": "self-governed",
      "surfaceId": "augmentor-panel",
      "requiredCapabilities": ["ui-embedding"]
    }
  ],
  "providerRequirements": {
    "sharedProfiles": [],
    "supportsPrivateCredentials": false
  },
  "archiveIntegration": {
    "readScopes": [],
    "intakeWriteScopes": [],
    "canRequestIngest": false,
    "canWriteKnowledgePages": false
  },
  "health": { "strategy": "manual" },
  "installHooks": {},
  "compatibility": { "shellVersion": "2.0.0-alpha", "platforms": ["browser"] }
}
```

This second complete manifest is a schema example for a reviewed chat adapter.
The `example-agent` adapter name is illustrative. Validation does not make it
available in the host adapter allowlist. The example claims no governed tier.

```json
{
  "sdkVersion": "0.1.0",
  "id": "addon.example-agent",
  "name": "Example Agent",
  "version": "0.1.0",
  "author": "Example Maintainer",
  "category": "agent",
  "description": "An external agent presented through ResonantOS chat.",
  "runtimeType": "agent-addon",
  "surfaces": [],
  "requestedCapabilities": [
    {
      "capability": "agent-runtime",
      "granted": false,
      "scope": "self",
      "revocationBehavior": "hard-stop"
    }
  ],
  "tools": [
    {
      "name": "example.chat",
      "description": "Invoke the reviewed chat adapter.",
      "requiredCapabilities": ["agent-runtime"],
      "inputSchema": { "type": "object" },
      "outputSchema": { "type": "object" },
      "audit": { "artifactTypes": [] }
    }
  ],
  "agentRuntime": {
    "invocationTool": "example.chat",
    "chatAuthorLabel": "Example Agent",
    "displayNameSource": "manifest",
    "supportsStreaming": true,
    "supportsCancellation": false,
    "supportsModelSelection": false,
    "outputFiltering": "assistant-reply-only",
    "requiredCapabilities": ["agent-runtime"],
    "adapterVersion": 1,
    "adapterId": "example-agent",
    "authScheme": "none",
    "supportedOperations": ["createSession", "invoke"],
    "contextRoleFidelity": "text-only",
    "toolCallbacks": false
  },
  "interfaces": [
    {
      "id": "chat",
      "label": "Example Agent chat",
      "mode": "adapter-chat",
      "governance": "self-governed",
      "agentRuntimeRef": "agentRuntime",
      "requiredCapabilities": ["agent-runtime"]
    }
  ],
  "providerRequirements": {
    "sharedProfiles": [],
    "supportsPrivateCredentials": false
  },
  "archiveIntegration": {
    "readScopes": [],
    "intakeWriteScopes": [],
    "canRequestIngest": false,
    "canWriteKnowledgePages": false
  },
  "health": { "strategy": "manual" },
  "installHooks": {},
  "compatibility": { "shellVersion": "2.0.0-alpha", "platforms": ["browser"] }
}
```

An add-on offering both views combines both entries and their backing contracts
under one manifest ID. The two interface IDs remain distinct. The union of
requested capabilities describes requirements, not a combined grant preset.

### Mapping the PoC configuration

Keep `RESONANTOS_EMBED_POC`, `RESONANTOS_EMBED_UPSTREAM_URL`,
`RESONANTOS_EMBED_PROFILE`, `RESONANTOS_EMBED_TOKEN_FILE` and
`RESONANTOS_EMBED_EXTENSION_ID` as operator-only configuration.
The profile remains the proxy path segment. It is not a harness identity or
consent key. The upstream, token file and extension ID have no new manifest
fields. No actual local profile, path or credential belongs in an example.

The host defines a fixed public PoC descriptor:

```ts
type EmbedHarnessDescriptor = {
  harnessId: "addon.augmentor-embed";
  interfaceId: "panel";
  label: "Augmentor";
  governance: "self-governed";
};
```

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

## 2. Self-governed marker

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

## 3. Metadata capture and consent

### Event contract

Use a shared pure module at
`browser-first/resonantos-side-panel-extension/src/lib/embed-governance-contract.js`.
It exports the metadata validator, domain projection and fixed constants.
The Node host imports this module through the existing host-to-extension pure
helper pattern. It contains no Chrome, filesystem, DOM or network calls.
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

### Relay mapping and data flow

1. The host page keeps its existing source and origin checks and four-command
   outbound allowlist. Node continues to tunnel bytes without event parsing.
2. `side-panel-entry.js` first checks the exact host-frame `contentWindow` and
   exact bridge origin. It then dispatches only recognized relay message types
   to a new `embed-governance-controller.js`.
3. The controller selects fields into a new metadata object. It never spreads
   a raw relay object, serializes one for diagnostics, or forwards one to the
   log endpoint.
4. The existing status handler updates the bar independently of recording.
   The event controller uses the exact mapping below.
5. For a successful local `sendContext(message) === true`, the page action
   reports a `page-shared` observation through a narrow callback. Do not log
   blocked, cancelled, invalid or offline attempts as successful shares.
6. When recording is known to be enabled, the controller posts one validated
   submission to the authenticated log route. The host validates again and
   stamps the record. No event record is stored in extension storage.

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
The live acceptance gate must demonstrate each required event using the real
harness. A missing or differently shaped event fails that gate. Do not silently
claim full coverage, inspect proxy bytes, or start retaining raw payloads to
work around it. Any upstream protocol reconciliation stays in this narrow
projection and needs a reviewed spec update before changing the mapping.

`window.__resonantosEmbed.last` becomes an in-memory ring of at most 50 safe
objects: readiness type, status booleans, or a validated `EmbedMetadata` value.
It contains no raw messages or IDs. Metadata event history is empty while
recording is off; readiness and current status remain usable for live proof.
It never acts as a retry buffer or a persistence source.

### Recording choice and event delivery

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

### First-share notice

Show the notice before the first permitted Page share to an outside harness.
The key is the host's stable `harnessId`, not profile, interface, origin, port,
manifest version or conversation ID. One acknowledgement covers all profiles
and interfaces of that harness under the same local user root. It survives
browser and bridge restarts. A new harness ID requires its own notice.

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

Use the host label in both positions. Buttons are `Cancel` and `Share page`.
Initial focus is on Cancel. Escape cancels. Trap focus while open and restore
focus to Page on close. Associate the heading and description using dialog
ARIA attributes. Cancel sends nothing and remembers nothing.

After Share page, re-resolve the tab and permission. If the tab ID or sanitized
URL differs from the candidate selected when opening the notice, send nothing and
announce `Page changed. Select Page again.` Do not remember that attempt.
If the permission is now blocked or unreadable, send nothing and retain the
existing denial message. Do not use an earlier permission snapshot.

For a valid confirmed attempt, cache notice version 1 for the harness in memory
and send the context once. Start the durable notice write independently of the
dispatch result. Remembering means acknowledgement, so it still counts
if the subsequent dispatch finds the harness offline. It is not a receipt of
delivery or a grant. `Page shared` continues to mean local dispatch only.

Notice state is separate from recording consent. The dialog does not turn
recording on. Turning recording off, pruning records, or deleting event
history does not clear the notice acknowledgement. A deliberate future change
to the notice text requires increasing the notice version, not guessing from
a manifest version.

A notice-state read failure means unknown, so show the dialog. After confirmation
and the final permission check, bound the independent acknowledgement write to
2 seconds. If saving fails, keep the acknowledgement only for this mounted
controller. It does not affect the share already dispatched. Show
`Notice preference could not be saved. It may
appear again.` A later mount asks again. Failure to log or remember a notice
must not block an explicitly confirmed, otherwise permitted share. On later
shares, complete any notice-state read before the final tab and permission
check. Do not await a log or notice write between that check and dispatch.

### Bridge storage and retention

Add `browser-first/host/embed-governance-host-service.mjs`. It owns route
validation, notice state and persistence. Use a single bounded JSON document
for this small local log. This permits preference changes, deletion and log
appends to be atomic without a database, journal or multi-file transaction.

The sole durable file is
`<userRoot>/BrowserFirst/EmbedGovernance/state.json`. `userRoot` is the existing
launcher resolver: `RESONANTOS_BROWSER_FIRST_USER_ROOT`, or
`~/ResonantOS_User` by default. Never use the extension directory, a browser
storage API, a repository-relative path or the proxy profile as a file path.
Production storage must resolve outside the repository. An unsafe root disables
this service without preventing bridge or embed startup.

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
value, not a credential or grant. `notices` permits only host-known harness IDs.
For this PoC its only key is `addon.augmentor-embed`. Missing state initializes
to recording off, a new epoch, an empty notice map and no events. Persist on
the first mutation. No event IDs, timestamps or request bodies enter notices.

Use UTF-8 JSON with a trailing newline. Require a private directory (`0700`)
and private regular file (`0600`), owned by the bridge user. Reject symlinks
and unsafe ownership or permissions in the service's directory and file.
Resolve the configured root once. Route arguments never choose paths. Permit
only one writer process per user root. Acquire ownership by atomically creating
a private `writer.lock` directory and writing a private `owner.json` containing
only the bridge PID and a random ownership UUID. Reclaim a stale lock only when
its valid owner PID is absent, as shown by a local process-existence check that
returns `ESRCH`. Permission errors, malformed lock data and a still-live PID
mean unavailable. An interrupted lock creation needs operator cleanup, never
automatic takeover. On close, remove only a lock with this process's ownership
UUID. The lock directory and its owner file contain no event data. They are
coordination artifacts in addition to `state.json`.

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

Retention is exactly 30 times 24 hours, using the host clock. Remove every
record with `recordedAt <= now - 2_592_000_000` milliseconds. Prune on startup,
before every read and mutation, and every hour while the bridge runs, including
when recording or the embed experiment is off. Clock rollback never extends an
already removed record. No process can prune while the bridge is stopped;
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

### Routes and authorization

Use `/embed-governance/*`, outside `/embed/*`. The existing proxy matcher
intercepts that latter namespace before normal route authentication. These
new routes must go through `bridge-server.mjs` and never through the cookie
proxy. No special exemption or new relay command is needed.

Every route requires the bridge token, the capability below and
`loopbackHostOnly: true`. Add `requiredOrigin: "extension"`,
`errorFamily: "embed-governance"` and `maxBodyBytes` route options for these
routes. Require the configured extension origin, rejecting
missing Origin, the bridge page origin and other CORS-allowed origins. Enforce
that check in `bridge-server.mjs`, before invoking a service. CORS headers alone
are not authorization. Use fixed public errors for this route family and
`Cache-Control: no-store` on every response. Do not return exception strings.

| Method and path | Capability | Exact input | Successful payload, in the existing `ok: true` envelope |
| --- | --- | --- | --- |
| `GET /embed-governance/state` | `addon-runtime-read` | No query or body | `{ recordingEnabled, writeEpoch, noticeVersion: 1, noticeAcknowledged, available, problem }` |
| `POST /embed-governance/recording` | `addon-runtime-control` | `{ enabled: boolean }` | `{ recordingEnabled, writeEpoch }` |
| `POST /embed-governance/notice` | `addon-runtime-control` | `{ harnessId: "addon.augmentor-embed", version: 1 }` | `{ noticeAcknowledged: true }` |
| `POST /embed-governance/events` | `addon-record-write` | One `EmbedEventSubmission` | `{ recorded: boolean, reason }` |
| `GET /embed-governance/events` | `addon-record-read` | Optional `before` UUID v4 query only | `{ events, nextBefore }` |
| `POST /embed-governance/events/delete` | `addon-record-write` | `{}` only | `{ deleted: true, writeEpoch }` |

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
Unsupported methods, duplicate query keys and malformed URLs are rejected.
Malformed input returns 400; oversized input returns 413. Set `maxBodyBytes`
to the stated POST limit and to zero for GET. Authorization keeps the bridge's
401 and 403 distinction. Error bodies contain only `ok: false`, a fixed code
and fixed message. Use these exact public errors:

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

Classify these exact registered paths as this error family even when the method
is unsupported, so a method mismatch cannot bypass the fixed-error policy.
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
audit fixtures. Reuse existing capability names; mint no new tokens. The bar,
notice dialog and history renderer receive callbacks and safe data, never a
bridge config, token, ticket or upstream credential. The controller calls the
existing bridge client. No route accepts a harness-supplied approval as consent.

### Read and delete UI

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
poll. Refresh reloads the newest page. Clear visible rows immediately after
a confirmed deletion acknowledgement.

Delete activity opens a confirmation: `Delete all recorded harness activity on
this computer? This keeps your recording choice and first-share notices.`
Buttons are `Cancel` and `Delete activity`. A failed deletion shows
`Activity could not be deleted` and keeps the current rows with an error state.
For an invalid store, use recovery copy: `Reset unreadable harness activity?
This turns recording off and clears remembered first-share notices.`
This route deletes only feature-owned data. It does not delete harness chats,
ResonantOS chats, security receipts or unrelated user files.

### Failure isolation and security limits

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

## Ownership changes for the later implementation

Add or amend these rows in `MODULE-OWNERSHIP.md` when the code lands. This
spec-only task does not edit that file. Paths under `extension/` below mean
`browser-first/resonantos-side-panel-extension/`.

| Path | Primary responsibility | Allowed state and writes | Excluded responsibility |
| --- | --- | --- | --- |
| `src/core/contracts.ts`, `packages/addon-sdk/src/contracts.ts`, `index.ts`, `validation.ts` | Interface types, exports and pure manifest validation | Declarative input and detached diagnostics | Runtime grants, tier verification, launches or slot mutation |
| `extension/src/lib/embed-governance-contract.js` | Closed metadata schema and pure sanitizing projections | Bounded detached metadata | Raw event persistence, Chrome, filesystem or credentials |
| `extension/src/lib/embed-governance-controller.js` | Relay observations, consent reads, first-share flow and bounded event delivery | In-memory baselines, notice acknowledgement cache and safe queue | Authority decisions, filesystem access or raw transcript storage |
| `extension/src/lib/embed-bar-actions.js` | Existing page resolver and strict permission gate, now with notice and successful-share callbacks | Explicit page-share intent and mode preference | Consent persistence, capability issuance or log storage |
| `extension/src/lib/embed-bar.js`, `embed-bar-model.js` | Tier badge, accessible descriptions and existing controls | Safe host descriptor, DOM and narrow callbacks | Bridge config, credentials, raw events or harness approval decisions |
| `extension/src/lib/settings/privacy-section.js` | Recording controls and paged read/delete presentation | Validated host snapshots and explicit user intents | Filesystem policy, authoritative preference cache or payload logging |
| `extension/src/side-panel-entry.js` | Compose the controller, validated relay, bar and frame lifecycle | Frame identity and projected proof state | Protocol-domain persistence, new relay authority or slot selection |
| `extension/src/lib/bridge-client.js` | Authenticated method/path capability mapping | Existing scoped transport | Consent decisions or passing tokens into UI callbacks |
| `browser-first/host/embed-host-service.mjs` | Existing tunnel plus fixed public harness descriptor | Operator config, tickets and sessions | Event parsing, recording storage or manifest-driven launch |
| `browser-first/host/embed-governance-host-service.mjs` | Validated routes, recording preference, notices, event storage and pruning | Its private user-root directory only | Proxy parsing, harness execution, grants or trusted audit receipts |
| `browser-first/host/bridge-server.mjs` | Existing authentication plus exact-origin, body-limit and fixed-error route policy | Transport authorization and bounded request parsing | Consent, log projection, storage or retention policy |
| `browser-first/host/run-bridge-minimal.mjs` | Construct the governance service, compose routes and close resources | Pass the existing user root and descriptor provider | Inline event, consent or retention logic |

No ownership moves to a desktop shell, native browser host or upstream harness.
The Settings composition may pass its existing bridge callback to the Privacy
section. It must not gain domain logic. No new application-level store is needed.

## Test plan

### Unit tests

- SDK tests cover both complete examples and a dual-interface fixture. Test
  absence, `undefined`, empty list, null, non-arrays, invalid objects, duplicate
  IDs, bounds, reserved modes, missing tiers and unknown fields. Cover dangling
  references, wrong surface types, legacy-only runtimes, both subset directions,
  duplicate capabilities and undeclared requirements. Pin issue codes and paths.
  Prove old manifests receive unchanged diagnostics and are not mutated.
- Metadata tests use payloads containing canary prompts, responses, arguments,
  results, tokens, error strings, page titles and URLs. Assert none reaches the
  projected record, proof history, body, stored JSON or fixed diagnostics.
  Test name rejection, strict booleans, domain normalization, IDNA, IPv4,
  IPv6, localhost, ports, query strings and fragments.
- Controller tests cover exact relay source/origin, unknown messages, transition
  deduplication, baseline reset, no synthetic finish and successful-dispatch-only
  page events. Test off by default, enable without backfill, 5-second refresh,
  stale epochs, queue bounds, timeout and pagehide cleanup.
- First-share tests cover a fresh harness, another profile of the same harness,
  repeat mounts, cancellation, permission-read failure, navigation during the
  dialog, a permission change, remember failure and recording off. Assert one
  context dispatch, no implicit recording consent and no grant mutation.
- Bar tests cover visible tier text, host-owned tier, malformed descriptor,
  offline fallback, keyboard focus, tooltip Escape behavior and Approvals copy.
- Storage tests use an injected clock and isolated temporary user root. Cover
  exact 30-day cutoff, startup/hourly/read/write pruning while disabled,
  permission and symlink rejection, unsafe roots, lock contention, atomic-write
  failure, stale temp cleanup, invalid state, size limits, durable restart,
  pagination and cursor expiry. Race deletion and toggles against queued writes.
  Prove deleted records cannot return through a stale epoch.

### Composition tests

- Instantiate the actual bridge server with both embed services. Prove that
  every governance route reaches normal authentication, not the proxy. Exercise
  both PoC-enabled and PoC-disabled compositions.
- Audit method/path capability parity between host and client. Reject a missing
  bridge token, wrong capability, embed cookie alone, forged Host, missing or
  foreign Origin, bridge-page Origin, malformed query, oversized body and
  client attempts to provide identity, timestamps or extra content fields.
- Run real bar actions, permission store, metadata controller and local service
  against fixtures. Confirm domain-only durable records and local-dispatch
  semantics. Inject log failures while chat, Page, Workspace and Assistant work.
- Reopen state after restart. Verify preference and per-harness notice survive,
  expired records do not appear, deletion is durable and off blocks appends.
- Confirm view selection makes no registry or slot assignment calls. Existing
  compare-and-swap slot tests remain the authority for changing harnesses.

### Live proof

Extend the manual `browser-first/test/embed-live.mjs` proof using a disposable
browser profile and external temporary user root. Use the real external
Augmentor and retain only redacted evidence outside Git.

1. Start with recording off. Inspect the marker and description at 320 px and
   420 px. Confirm a single row, an unchanged harness panel, keyboard access,
   reduced motion and normal-mode Assistant-only behavior.
2. Share a fixture page. Cancel the first notice and prove no context dispatch.
   Confirm it on the next attempt. Verify the existing fixture-title reply.
   Repeat and restart the bridge and browser. The notice stays acknowledged
   for this harness. The activity log remains empty while recording is off.
3. Enable recording through Settings. Change conversations, start and finish a
   reply, and exercise a safe tool success and tool error. Prove the exact relay
   mapping for every required record against this upstream version. A missing
   event is a failed acceptance item, not a synthetic passing fixture.
4. Share a page with a path, query and fragment. Inspect Settings and the private
   state file. Only its domain appears in the page record. Check all records
   for canary content absence. Do not save raw harness messages as proof.
5. Turn recording off during activity. New appends stop at the host. Chat and
   sharing continue. Delete history, restart and verify it stays deleted while
   notice consent survives. Exercise storage failure and confirm sharing works.
6. Seed expired metadata in the test-owned root, restart and verify pruning.
   Switch views both ways and confirm no primary-agent slot change occurred.

For the later implementation, run `npm run test:browser-first`,
`npm test -- --run`, `npm run build`,
`node scripts/security-pipeline/run-check.mjs`, `npm run docs:check`,
`npm run test:docs`, and `npm run verify:alpha`. Run the focused ownership check
`node --test --test-concurrency=1 scripts/module-ownership-doc.test.mjs`.
These commands are implementation gates, not claims of completed live proof.

## Self-review

- Placeholder scan: no unfinished sections or deferred implementation choices.
  Example identities are explicitly illustrative and contain no local secrets.
  Both JSON examples parse and pass the existing SDK validator. The new
  interface rules still require the implementation tests specified above.
- Internal consistency: SDK declarations confer no runtime authority. The host
  owns identity and storage. The extension captures metadata. Off, deletion,
  retention and first-share acknowledgement have separate stated effects.
- Scope check: only the three approved additions are designed. The PoC remains
  operator-configured, off by default, outside Alpha and without manifest-driven
  launch, new harness capabilities or slot-selection behavior.
- Ambiguity check: types, references, capability subsets, labels, event fields,
  capture rules, routes, consent keys, defaults, retention cutoff and failure
  behavior are explicit. The current upstream evidence limit is called out and
  has a required live acceptance gate rather than an invented support claim.
