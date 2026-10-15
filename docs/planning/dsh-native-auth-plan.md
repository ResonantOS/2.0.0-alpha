# DSH Native Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The conductor alone runs Task 0. Do not run the historical probe. This document contains proposed code, not executed implementation or certification.

**Goal:** Add opt-in, governed, plugin-free DSH authentication with a bridge-owned process and memory-only login-token/cookie custody while preserving plugin mode.

**Architecture:** `dsh-runtime.mjs` owns validated local launch, isolated state, epochs and termination. Credentials share authentication state across leases; transport owns guarded exchange; the Typert adapter owns protocol validation; host composition owns readiness and output sanitation; the boundary owns authorization and retirement. No new public routes or UI are introduced.

**Tech Stack:** Node.js 24.21.0+, ESM, Node test runner, TypeScript contracts and canonical SDK validation, Undici 7.30.0 with a private direct Agent, existing Typert RPC/WebSocket protocol, Vitest/Vite. Undici is promoted from the inspected transitive dependency to an exact production dependency; no DSH package becomes a repository dependency.

> **Review record:** [plan review round 1](dsh-native-auth-plan-review-1.md); [plan review round 2](dsh-native-auth-plan-review-2.md); [execution notes](dsh-native-auth-execution-notes.md).

## Global Constraints

The following requirements are copied verbatim from the approved spec; only their heading depth is adjusted to keep them inside this section. No task may relax these values.

### Decision and scope

Add an opt-in `dsh-native-cookie` authentication mode to `dsh-typert-v1`.
The bridge starts and owns a DSH web child. It reads the child's boot login
token from a private stdout pipe. It exchanges that token for a DSH cookie.
The token and cookie stay in bridge memory. Native mode never calls the
Augmentor plugin or sends `x-augmentor-token`.

Keep `dsh-action-token` and its existing bindings working. There is no automatic
mode detection, fallback between modes, or removal date for plugin mode.
The DSH Typert session protocol stays shared between both modes.

The implementation targets DSH 0.1.x and 0.2.x, including prereleases.
Native mode initially supports macOS and Linux. Windows native process control
is outside this change and must fail explicitly. Plugin mode keeps its existing
platform behavior. DSH stays an optional add-on behind the Alpha bridge.

Three approaches were considered:

| Approach | Decision |
| --- | --- |
| Own a DSH child and exchange its boot token | Selected. Establishes process and credential custody without a plugin. |
| Attach to an arbitrary running DSH using a pasted login token | Rejected. Adds a secret input flow and cannot establish process ownership. |
| Patch, install, or bypass the plugin's DSH version checks | Rejected. Retains the dependency that this work removes. |

There is no DSH installer, package updater, general process supervisor, remote
DSH support, embedded DSH UI, automatic resumption of failed sessions, or provider-settings
integration in this change. No browser tools, approval waterfall, plugin
save/unsave/state actions, or new bridge routes are added.


### Operator configuration

Use the existing `RESONANTOS_HARNESS_BINDINGS` JSON array. The new scheme and
source select native mode. There is no additional mode flag. With no native
binding, no DSH child starts. Existing modes keep working. The shared DSH
connector hardening described below also applies to plugin mode.

The proposed native binding has this exact shape:

```json
{
  "name": "dsh.native",
  "addonId": "addon.deepseek-harness-native",
  "adapterId": "dsh-typert-v1",
  "authScheme": "dsh-native-cookie",
  "endpoint": "http://127.0.0.1:3081",
  "source": { "managedDsh": true }
}
```

The manifest repeats the five public binding fields through its ID and
`agentRuntime`. It never contains `source`, executable paths, home paths,
headers, tokens, or cookies. The native example uses a distinct add-on ID so
both modes can be installed at once. The example port is not a default.

| Setting | Required value or default |
| --- | --- |
| `RESONANTOS_HARNESS_BINDINGS` | Existing default `[]`. At most one native binding per bridge. Existing plugin and bearer bindings may coexist. |
| Native `endpoint` | Required exact `http://127.0.0.1:<port>`, with port 1024 through 65535. No default, port zero, DNS name, TLS, path, query, fragment, or userinfo. No trailing slash in the binding or manifest. |
| Native `source` | Exactly `{ "managedDsh": true }`. File, environment-token, and mixed sources are rejected for this scheme. |
| `RESONANTOS_DSH_PACKAGE_ROOT` | Required for native launch only. Absolute path to the dedicated npm install prefix that contains `node_modules/@deepseek-ai/dsh`. The value is the prefix, not the package directory or `node_modules`. No search through PATH, npm execution, download, or desktop bundle discovery. |
| `RESONANTOS_DSH_HOME` | Optional absolute path. Default is `<userRoot>/BrowserFirst/Harnesses/dsh-native`, outside the repository. This is the child's actual DSH_HOME. |
| `DEEPSEEK_API_KEY` | Optional bridge environment value forwarded only to the native child. Missing means no key is injected. Provider setup errors appear on model use. No lookup in another application's credentials. |
| `RESONANTOS_HARNESS_DEMO` | Existing default remains off. Enabling it offers the separate native example only when a native binding is configured. It grants nothing. |

Snapshot native settings only when a `dsh-native-cookie` binding is present.
Without one, ignore `RESONANTOS_DSH_PACKAGE_ROOT` and `RESONANTOS_DSH_HOME`.
Do not validate them or read their paths. Plugin-only and non-DSH bridges keep
working without either variable. There are no new CLI flags, dotenv reads,
settings persistence, hot reload, or arbitrary child arguments.

Use this exact validation split:

| Phase | Failures | Result |
| --- | --- | --- |
| Bridge composition | Malformed binding; duplicate native bindings; wrong adapter, scheme, source, or endpoint; nonempty relative prefix/home path; native binding on a platform other than macOS or Linux | Refuse bridge startup with the fixed configuration error. Reject a second native binding even if its name or endpoint differs. |
| First authorized native acquisition | Unset or empty install prefix; absent path; unreadable metadata; wrong package name; invalid or unsupported version; unsafe prefix tree; validation ceiling exceeded; missing or invalid entry | Return `runtime-unavailable` for native use. Keep the bridge and other modes available. |
| First authorized native acquisition | Unsafe home, lock conflict, busy port, spawn, announcement, cookie, or protocol failure | Use the matching runtime error below. Never install or adopt a process. |

Snapshotting a path does not resolve or inspect it. Prefix and home filesystem
checks are lazy and follow authorization. Restart the bridge after changing
any setting. An unset install prefix is a missing runtime dependency, not a
malformed binding.

Keep the setting name `RESONANTOS_DSH_PACKAGE_ROOT`, but define its value as
the npm install prefix. Require a dedicated prefix used only for this harness
and its dependencies. Recommend an operator-created prefix at
`<userRoot>/BrowserFirst/Harnesses/dsh-native-install`, outside the repository
and separate from DSH_HOME. Do not use a shared project or global npm prefix.
The bridge does not create, install, or repair this prefix.

The trust boundary is the entire install prefix. Resolve it with `realpath`.
Check the canonical prefix and every
ancestor directory through filesystem root `/`, inclusive. Each must be owned
by root or the current user and satisfy `(mode & 0o022) === 0`. Do not stop at
the prefix's parent. A writable ancestor can permit replacement of the tree.
There is no sticky-directory exception. Scratch installs for this check must
use a private location with safe ancestors, not a shared temporary directory.

Walk every entry in the entire prefix tree. Include every hoisted dependency
under `node_modules`, scoped packages, nested dependencies, and
`node_modules/.bin`. Dependencies beside `@deepseek-ai/dsh` are inside this
trust boundary even though they are outside the DSH package directory. Use
`lstat` to distinguish links. Real directories and regular files must meet the
same ownership and mode rules. Reject special files. Allow npm's normal
symlinks, including entries in `node_modules/.bin`, only when every link hop
and the final resolved target stay inside the canonical install prefix. Use
path-component containment, not a string prefix. Reject escaping, dangling,
or unresolvable cyclic links. Check link ownership, but do not apply file mode
bits to the link itself. Symlink modes commonly include write bits and do not
control target access. Validate the target and its parent directories under
the same rules. Track visited canonical directories to avoid repeated walks
through aliases. Checking only `package.json` and `lib/bin.js` is insufficient.
Group or other read/execute permissions are allowed. The private credential-file
rule remains stricter and still rejects symlinks.

The full walk costs filesystem I/O and launch time proportional to the entry
count, plus ancestor and link checks. Bound the file count at 50,000 entries,
including the prefix itself, directories, regular files, and symlinks. Count
each directory entry once; a link counts even when its target was already
visited. Bound depth at 64 path components below the canonical prefix, whose
depth is zero. Check both encountered paths and resolved targets. These are
fixed ceilings, not operator overrides. Exceeding either ceiling refuses
launch with the fixed limit error below. Never skip entries or accept a partial
walk. The walk also consumes the existing 30-second startup deadline. Expiry
refuses launch with `deadline-exceeded`; it does not permit partial validation.

Derive `packageRoot` as `<installPrefix>/node_modules/@deepseek-ai/dsh`.
Validate package name and semver from that package's `package.json`. Resolve
its `lib/bin.js` as before. Both metadata and entry must resolve inside the
validated prefix. Do not search another prefix or run a `.bin` wrapper.
Complete validation before spawn on every launch. The operator must
keep the validated installation stable during use. This is a trust check, not
a sandbox against code or replacements by an already trusted owner. Never take
an install prefix or package path from a manifest or route payload.

Use the bridge's absolute `process.execPath` to launch the validated entry:

```text
node <packageRoot>/lib/bin.js --profile web --no-open --host 127.0.0.1 --port <approvedPort>
```

This is a spawn argv array with `shell: false`, not a shell command string.
The program uses pipes for stdout and stderr and ignores stdin. It stays
attached to the bridge lifecycle. No login token or cookie appears in argv,
environment, a browser launch, or a health-check command.

### Isolated state and child environment

Treat the configured DSH_HOME as an exclusive bridge-managed directory.
Resolve its parent and reject repository paths, symlinks in the managed path,
and any nonempty unmarked directory. Apply these distinct path rules after
normalization. Resolve existing ancestors for paths that do not yet exist.

| Protected path | Rejection rule |
| --- | --- |
| `os.homedir()` | Reject equality only. A dedicated descendant may be used. |
| `~/.dsh` | Reject equality and every descendant, even an empty directory. |
| `~/Library/Application Support/Augmentor/data/augmentor/managed-dsh/home` | Reject equality and every descendant, even an empty directory. |

Compare canonical path components, not string prefixes. Do not read desktop
config to discover more paths. The default under
`~/ResonantOS_User/BrowserFirst/Harnesses/dsh-native` passes these path rules.
A custom path still must be dedicated to the bridge. On first use, create
it with mode 0700 and a mode 0600 ownership marker. The marker contains only
format version, native binding name, and canonical bridge user root.
An existing marker must match. Never adopt, copy, migrate, clear, or chmod
an existing desktop or ordinary DSH home into compliance.

Inside that directory reserve `.resonantos/` for the marker, lock, synthetic
OS home, temporary directory, and empty working directory. Use the working
directory as the child's cwd. Set child HOME to the synthetic home and set
XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, and XDG_CACHE_HOME beneath it.
Set TMPDIR beneath `.resonantos/`. This avoids implicit use of the user's
desktop configuration. It is not an OS filesystem sandbox for trusted DSH code.

Acquire an exclusive mode 0600 lock before any launch. Its nonsecret contents
are the bridge PID and a random ownership nonce. A lock conflict fails closed.
Only its holder may remove it, after confirming the owned child has exited.
Do not recover stale locks by killing a PID or matching a process name. After
an unclean bridge death, the operator must inspect the leftover process and
remove a stale lock explicitly. State and transcripts are not deleted at stop.
Bridge sessions still never resume old DSH sessions.

Build the child environment from an allowlist, not `{ ...process.env }`.
Copy only LANG, LC_ALL, TZ, and the optional DEEPSEEK_API_KEY. Add the isolated
paths above. Set PATH to the directory of `process.execPath`, `/usr/bin`, and
`/bin`, in that order. Do not inherit bridge credentials, NODE_OPTIONS, proxy
settings, DSH flags, telemetry exporters, or unrelated provider keys.

Always set `DSH_TELEMETRY_MODE=DISABLED` on every launch.
A parent value cannot override it. There is no telemetry opt-in
in this change. This is the owner-directed policy for the managed child,
addressing the documented decision and live assertion requested by
[issue #519](https://github.com/ResonantOS/2.0.0-alpha/issues/519).
It does not claim control over an externally managed plugin-mode service.
The live lane must verify the installed version honors it. Setting the
environment variable alone is not proof of absent telemetry traffic.

### Process lifecycle and endpoint ownership

Add one host-only `dsh-runtime.mjs` module. It manages at most one child for
the bridge and its single native binding. Concurrent acquisitions share one
launch promise. It resolves at Announced with a private runtime lease. Host
composition then gates session creation on its separate shared Ready promise.
Each child gets a fresh in-memory runtime epoch and lifetime abort signal.
That epoch is separate from the registry's boot epoch and slot generation.

| State | Transition |
| --- | --- |
| Stopped | An authorized session creation acquires the first runtime lease and starts a child. Registry reads, installation, grants, and slot assignment do not spawn. |
| Starting | Lock and port checks pass; spawn succeeds; wait for the exact boot announcement. |
| Announced | Token and endpoint are captured. Host composition sequences transport authentication and the adapter protocol probe. No session reference is returned yet. |
| Ready | Authenticated protocol readiness is established. Provider readiness is separate. Sessions share the child and its cookie, with separate transport leases and DSH sessions. |
| Stopping | Last lease is released, all runtime authority is revoked, initial readiness fails, or the bridge closes. New acquisitions wait for cleanup. |
| Failed | Initial startup, child exit, or cleanup fails. Associated sessions are retired. No background restart occurs. |

Before spawn, try an exclusive TCP bind to the approved loopback port, then
close the reservation. If busy, do not make an HTTP request to that listener.
Report a port conflict. There is no available-port fallback. The bind-to-spawn
race is handled by child failure or an announcement mismatch, never by
adopting a listener. DSH must announce exactly the approved origin and port.
No health success without an owned, still-live child and its captured token
counts as readiness.

`harness-host-service.mjs` owns the acquire, authenticate, probe, and mark-Ready
sequence in its `resolveAdapter` path. It shares one readiness promise per
runtime epoch. The runtime owns spawn and token capture. The transport owns
HTTP authentication. The adapter validates Typert envelopes and catalog values.
Composition reports readiness or failure to the runtime. The runtime must not
import RPC or registry logic.

The startup deadline is 30 seconds from acquisition through token exchange
and protocol readiness validation. Each HTTP or WebSocket opening retains
the existing 10-second transport bound, capped by the startup deadline.
There is no startup retry loop. Follow readiness retains its 15-second bound.
Direct `/agent/turn` turns retain the adapter's 120-second bound. Governed
`/augmentor/chat` keeps its existing 30-second reply deadline after session
creation and turn allocation. Startup is outside that reply race, as it is
today in `harness-host-service.mjs:351` and `:358`. Do not move session creation
into that race or cancel before a turn ID exists. Cold chat can take the
30-second startup budget, a bounded session/create RPC, and then the separate
30-second reply budget. It does not promise 120 seconds for a browser reply.
These are constants, not new environment flags.

Concurrent waiters share the first launch's deadline. Later transport leases
use the current shared cookie without another login exchange. Requests keep
the existing 10-second bound. Initial transport, authentication, or schema
failure stops the child. A recognized provider rejection follows the separate
readiness rule below and does not stop it.

Propagate the boundary's pending-session abort signal through adapter
resolution, runtime acquisition, and transport startup. Add the signal to the
host-only `resolveAdapter` contract; the current call does not pass it.
The boundary owns registry checks before acquisition, after acquisition, and
before returning a session. Its synchronous registry fence aborts each affected
pending signal. Immediately before spawn, the runtime checks that at least one
authorized waiter's signal remains live and that its epoch is current. It
checks them again after acquisition. These signal checks carry the boundary's
authorization decision. Do not inject the registry or grants into the runtime.
A revoked or timed-out pending session releases its lease even if startup
settles late. One cancelled waiter must not stop a child still needed by
another authorized waiter. No queued acquisition survives its authorization.

An unexpected child exit fences that runtime epoch synchronously. Composition
notifies the boundary to emit one fixed `runtime-unavailable` terminal error
on each active stream, then abort and retire all associated pending and active
sessions. It closes streams and suppresses late output. New calls using retired references
return `session-not-found`. A new explicit session request may start one new
child after confirmed cleanup, with a new runtime epoch, token, and cookie.
It cannot replay a prompt or reconnect an old session. The registry does not
silently change owners or grants to recover a process failure.

Session retirement must also invalidate the browser chat cache. Add a host-only
synchronous retirement notification from `harness-boundary.mjs` to composition.
Emit it when a registered session is removed, before awaiting cleanup.
`harness-host-service.mjs` clears `compatibilitySession` only when all four
reference fields match the retired session. A late notification for an old
session must not clear a replacement. Do not change slot generation or grants.

Each governed chat call holds its session reference in a local variable for
events, invocation, receipts, reply provenance, and timeout cancellation.
Clearing the shared cache must not erase that in-flight identity. Before caching
a newly awaited session, use a host-only boundary liveness check against its
registered reference and current authorization. If retirement already occurred,
fail that call without caching or retrying it.

The next user-submitted `/augmentor/chat` call rechecks authorization and creates
a fresh session when the cache is empty. This is an explicit new request and
may launch a new child after confirmed cleanup. The failed chat call is never
retried. Never copy or resend its prompt as part of recovery. If authority was
revoked or cleanup remains unconfirmed, the next call fails without spawning.

Releasing one session disposes its adapter and transport. The final lease
release stops the child, including after slot replacement, disablement, or
revocation that disables session creation. A turn-only cancellation uses
`session/cancel` and keeps the session's runtime lease. It does not kill other
sessions. Dependency-only revocation preserves the current policy semantics.

Use one stop clock, starting at the synchronous fence (`t = 0`). Abort ordinary
network work and start best-effort adapter cancellation under a cleanup-only
signal. It cannot publish output or accept new work. Allow at most one second
for that phase. Send SIGTERM to the exact live child by `t = 1s`. Wait at most
one more second. If still live, send SIGKILL by `t = 2s` and await confirmed
exit until `t = 3s`. Move to the next phase early when possible. Exit at any
phase completes cleanup. All waits share the same three-second cap.

Cleanup is idempotent. The existing one-second adapter cleanup race occupies
the first phase; it is not an extra wait before the stop clock. Track runtime
stop promises separately so that race cannot discard them. On bridge close,
start the native fence and stop clock immediately, in parallel with other
service cleanup. `harnessService.close()` drains those promises before the
launcher exits. At the cap, retain the lock and emit the unconfirmed-exit
message only if exit is still unconfirmed. A synchronous exit hook may only
best-effort signal owned live handles.

The bridge must own the final exit on SIGINT and SIGTERM. Today OpenCode can
register another signal handler that calls `process.exit()` immediately.
Add a host-only `installSignalHandlers` option to `ensureOpencodeServer`,
defaulting to true for existing callers. Bridge composition passes false at
its `ensureServer` injection into the OpenCode boundary. Retain OpenCode's synchronous
exit cleanup hook. Split registration into two independently guarded paths:
always install the exit cleanup hook once; install signal handlers only when
`installSignalHandlers` is true. Do not gate the whole existing
`installShutdownHooks` function or share its single flag between these paths.
The bridge's one idempotent shutdown promise drains both services before
exiting. This is a lifecycle integration change only; OpenCode
authentication, session behavior, and streams stay unchanged.

Never signal a process found by port, name, desktop configuration, or a saved
PID. Never signal an already-exited handle to clean up guessed descendants.
If exit cannot be confirmed, retain the lock and refuse another launch.
SIGKILL of the bridge and detached descendants cannot be guaranteed clean.
Report that limit; do not add process discovery or a daemon supervisor here.
Late callbacks must check the runtime epoch so an old exit cannot clear a
replacement child or its secrets.

### Token capture and credential lease

Decode stdout incrementally as UTF-8. Before readiness, drain and discard
complete lines that do not begin `dsh web: `. Banners and warnings are not token
candidates and do not themselves fail startup. They still count toward the
line and total byte limits. Never forward or log them. Validate every line
with the exact prefix; malformed prefixed lines fail startup.
Accept only a complete announcement line beginning
`dsh web: ` followed by the login URL. Accept LF or CRLF. The URL must have the
exact approved origin, path `/`, no userinfo or fragment, and exactly one
query field named `token`. After decoding, the token must match
`[A-Za-z0-9._~-]{1,8192}`. No extra URL or arbitrary log prefix is accepted.
An identical repeated announcement is ignored. A conflicting one fails startup.

Bound a line at 16 KiB and total stdout before initial readiness at 1 MiB. Reject
overflow, malformed token lines, early EOF, and missing announcements. There
is no fallback to DSH_HOME, a token file, stderr, a desktop app, or an anonymous
HTTP endpoint. Drain and discard stderr. Until initial readiness completes,
keep checking complete announcement lines for conflicts within the same bounds.
After readiness, drain and discard stdout too. Do not log raw chunks, child
errors, or parser input, even on failure. Do not first log and later redact
the announcement.

Extend `createHarnessCredentials` with a host-injected native runtime source.
Keep the existing exact binding comparison before any acquisition. Native
acquisition returns a lease tied to that binding and runtime epoch. The public
registry still receives only binding metadata. The runtime source is never a
manifest-loadable factory or executable path.

The lease carries `endpoint`, `authScheme`, `loginToken`, and `cookie` through
its private `use(callback)` interface. Plugin leases retain `actionToken`.
Only the transport receives these values. `harness-credentials.mjs` owns one
native credential record per binding and live runtime epoch. All native leases
reference that record. It holds one cookie generation and one shared exchange
promise. The runtime supplies the boot token and lifetime signal; it does not
perform HTTP authentication. The transport supplies the guarded exchange
operation to the record's single-flight coordinator.

Exchange once at initial startup. Acquiring a second session must not exchange
again. A refresh, when permitted by DSH-NATIVE-AUTH-1 below, is single-flight
across every session on that child. Atomically replace the shared cookie and
advance its generation. Requests snapshot the generation they used. A late
401 from an older generation uses the current cookie for its one retry, when
the verified policy permits replay, without starting another exchange. Pause new authenticated sends while refresh is
pending. Cancelled waiters cannot publish a cookie or cancel refresh needed by
another authorized waiter. Epoch change or loss of the last authorized lease
aborts the exchange. Never copy usable cookies into per-session caches.

Register the login token, full login URL, cookie pair, cookie value, and their
supported encoded forms with the existing recursive sanitizer before any
response can escape. Include the injected provider key in native output
redaction. The adapter receives methods, never credentials. Neither receipts,
public errors, event streams, diagnostics, manifests, registry files, generated
bridge config, nor browser storage may contain them.

Native mode publishes status and final replies, with `supportsStreaming: false`
as in the current DSH example. That metadata does not suppress host events.
The `resolveAdapter` invoke wrapper must drop every native `delta` before it
reaches the boundary event bus. Gate this behavior on
`authScheme === 'dsh-native-cookie'`. Expose a narrow `transport.sanitize(value)`
method to this wrapper, never the credentials themselves.

Sanitize every assembled native frame and public method result after the
adapter finishes joining text and before any publication or receipt signing.
This includes final text, history messages, catalog names, status, and selection
results. Wrap `history`, `modelCatalog`, `status`, and `selectModel` at the same
composition point. Sanitation of individual upstream JSON strings is still
required but is insufficient. A token split across two history text parts must
be redacted in both the returned history and its signed route receipt. Keep
plugin streaming and output behavior unchanged.

Disposal invalidates the caller's secret access and releases its runtime lease.
It must not clear the shared cookie while another authorized lease exists.
Final release or epoch failure clears usable token and cookie references.
Retain every issued cookie's redaction patterns for all leases while late
callbacks can still run, including callbacks after rotation or disposal.
Drop those objects once cleanup completes. JavaScript cannot promise physical
erasure of immutable strings. No application-level secret persistence, debug
dump, or heap snapshot is part of this design.

### Native transport protocol

Keep authentication in `harness-transport.mjs`. Use the existing endpoint guard
for every connection. The production endpoint guard must use an explicitly
proxy-disabled dispatcher for HTTP and a direct connector for WebSockets.
Neither may inherit the global dispatcher or consult environment proxy settings.
This applies to native and plugin DSH exchanges, including token queries and
cookie requests. Keep numeric-address pinning, Host/port checks, and manual
redirects. Child environment filtering alone does not protect bridge requests.
Do not change the parent environment or global networking for other services.
This is shared transport hardening. Plugin authentication, headers, grants,
and session protocol remain compatible. Plugin requests also bypass proxies.

Native authentication runs before the first session RPC:

1. GET `/?token=<encoded login token>` with manual redirects and no cookie.
2. Require status 303. An optional Location must resolve to `/` on the same
   approved origin. Inspect it; never follow it.
3. Require exactly one valid `dsh-auth-*` cookie pair, using the current
   name/value grammar and an 8192-byte pair limit. Reject missing, duplicate,
   expired, or conflicting authentication cookies. Ignore unrelated cookies.
   Never create a general cookie jar or persist response headers.
4. Store only `name=value` in the shared epoch credential record. Cancel the
   response body without reading the SPA. Make a read-only modelCatalog probe
   through the adapter. Reuse the catalog decoder without requiring a session.
   A valid empty catalog establishes Ready with no available models. It does
   not prove provider readiness.

The current `rpc()` collapses all `result.ok !== true` responses into one error.
For native readiness, distinguish transport/authentication failures, malformed
protocol envelopes or catalog values, and recognized provider/model rejection.
The first two fail startup. A recognized provider/model rejection establishes
protocol readiness with provider availability false. Return that classification
to composition, not a thrown startup error. Continue session creation. If that
succeeds, return the session normally. Keep the child and use the fixed
model/provider error on affected operations. Normal final-lease cleanup still
applies if session creation fails. Do not manufacture an
empty success catalog from an error. DSH-NATIVE-PROVIDER-1 must establish the
exact structured rejection shape before implementing this classification.
Never classify by free-text substring or treat every RPC error as provider
failure. Keep plugin probe behavior unchanged. The shared decoder may be
reused, but the native readiness policy is scheme-specific.

Session RPCs send only the cookie and normal JSON content headers. The native
`/api/remote.mux` handshake sends the cookie with no explicit Origin header.
It sends neither a token query nor `x-augmentor-token`. No plugin route appears
in the native request allowlist. Keep the current plugin branch, including its
auth exchange and WebSocket action header, intact.

DSH-NATIVE-AUTH-1 determines whether refresh is permitted. When permitted, an
explicit RPC 401 allows at most one shared refresh and one replay of that RPC,
within the original request deadline. Require the same live authorized epoch.
An explicit WebSocket handshake 401 allows the same shared refresh and at most
one new socket within the original opening deadline. No prompt is sent until
the replacement socket supplies the required follow snapshot. A second 401
from either path fences the epoch and retires its sessions as
`runtime-unavailable`. There is no mode switch or new child inside a retry.

The current socket wrapper reduces handshake failures to a generic error.
Do not infer 401 from that error. The host connector must expose an observed
HTTP rejection status internally, without exposing headers or response text.
If the production socket API cannot expose it, use one read-only modelCatalog
request to diagnose a failed opening. This internal diagnostic returns its
status without automatic retry or refresh. Only an explicit HTTP 401 there
may trigger refresh and one replacement socket. If that request succeeds or
fails in another way, fail the opening without refresh. This diagnostic is bounded
by the original opening deadline and cannot dispatch a prompt.

Timeouts, disconnects, redirects, parsing errors, and 5xx responses never cause
RPC replay. Never reconnect an active failed follow stream to replay an
uncertain prompt. A stale-cookie follow test must observe zero prompt calls
before authentication and the follow snapshot succeed, and zero total prompt
calls if they fail. If refresh is disabled, any confirmed auth 401 fences the
epoch. A new explicit session may launch a fresh child after cleanup.

Keep current response, message, queue, and history bounds. Keep the fixed
session RPC allowlist, loopback destination checks, pinned port, and redirect
refusal. Do not add a generic URL, header, RPC, or command passthrough.

### Registry, consent, and capability floor

Add `dsh-native-cookie` to the shared authScheme union in
`src/core/contracts.ts` and the canonical SDK validator in
`packages/addon-sdk/src/validation.ts`. Preserve the SDK re-export. Only the
reviewed `dsh-typert-v1` host path may use the scheme. Unknown combinations and
native sources on plugin or bearer bindings are denied.

The five-field binding comparison remains exact at installation and at lease
acquisition. The manifest cannot request a different runtime endpoint after
launch. A fixed port avoids adding runtime endpoint aliases or wildcard
binding approval. No credential or runtime epoch enters the durable registry.
Registry availability still means governance eligibility, not process health.

Keep the DSH base floor `agent-runtime` and `network`. For
`dsh-typert-v1` with `dsh-native-cookie`, extend that floor with `filesystem`
and `shell`. The native path writes an isolated home and starts a process.
The floor is enforced by host policy even if the manifest understates its
requirements. The native example requests all four with system scope and
hard-stop revocation, plus its existing `chat-interface` request.
Reject native manifests missing any floor request. Do not infer a grant from
the operator's binding, an installed package, a previous plugin grant, or a
working cookie.

Plugin mode retains its existing floor and grants. Other adapters are unchanged.
No `providers` permission is inferred or removed: this path does not call the
ResonantOS provider fabric. Its dedicated child receives only the explicitly
documented environment key. No browser, payment, wallet, login, credential-entry,
signing, public-submit, or trusted-memory authority is added.

Preserve compare-and-swap revisions, slot generations, rollback refusal,
replacement policy, and synchronous revocation fences. Runtime failure retires
ephemeral sessions; it does not forge a governance transaction. Hard-stop
revocation still advances the slot generation before asynchronous cleanup.
Stopping the owned child narrows continued execution but does not prove that
provider requests or previously spawned external side effects have stopped.

### Errors and recovery

Public routes keep the fixed harness error vocabulary. Do not interpolate
child output, paths, request URLs, response bodies, or credentials into errors.
The bridge terminal may emit one structured lifecycle record per transition:
fixed event `harness.dsh_native`, binding name, state, fixed reason, numeric
exit code or signal, and a message selected from the table below. No stack or
raw exception is included. These terminal messages are the operator-facing
detail; the existing client displays the public harness message.

| Failure | Public result | Fixed operator message and recovery |
| --- | --- | --- |
| Composition failures listed in the validation split, including a second native binding or unsupported native platform | Bridge startup refused | `Invalid native DSH configuration. Check the native binding and DSH settings, then restart the bridge.` |
| Unset/empty install prefix, missing package, unsafe prefix tree, bad entry, or unsupported version | `runtime-unavailable`: `Runtime unavailable.` | `Native DSH install prefix is unavailable or unsupported. Select a dedicated prefix with a supported local package and restart the bridge.` |
| Prefix validation exceeds the entry-count or depth ceiling | `runtime-unavailable`: `Runtime unavailable.` | `Native DSH install prefix exceeds the validation limit of 50000 entries or depth 64. Use a smaller dedicated prefix and restart the bridge. No child was started.` |
| Unsafe home or conflicting lock | `runtime-unavailable` | `Native DSH home is unavailable. Use a dedicated home and inspect any existing owner before retrying.` |
| Port busy or announcement endpoint mismatch | `runtime-unavailable` | `Native DSH could not use its approved port. Choose another port in both binding and manifest, then restart and reinstall the manifest.` |
| Prefix validation deadline, missing announcement, or readiness timeout | `deadline-exceeded`: `Runtime deadline exceeded.` | `Native DSH did not become ready within 30 seconds. Check the package and retry with a new session.` |
| Malformed announcement, child exit, failed cookie exchange, transport failure, or invalid protocol schema | `runtime-unavailable` | `Native DSH startup or authentication failed. Check the installed version and retry with a new session.` |
| Missing grants, binding mismatch, or forbidden operation | Existing `permission-denied` or `invalid-manifest` | `Native DSH requires its exact approved binding and explicit capability grants.` |
| Child exits during a session | Active stream terminates with `runtime-unavailable`; later references get `session-not-found`; the next user-submitted browser chat creates a fresh session after cleanup | `Native DSH stopped. Send a new chat request or create a new session. The previous turn was not retried.` |
| Recognized model/provider rejection | The probe records provider unavailability without failing protocol readiness. An affected public operation returns sanitized `runtime-unavailable`; no provider-triggered child stop. | `Native DSH could not complete the request. Check its model and provider configuration.` |
| Stop deadline exceeded | Local authority remains fenced | `Native DSH exit could not be confirmed. Inspect the owned process before reusing its home or port.` |

A route that loses ownership during startup keeps the existing
`ownership-conflict` result. Runtime failure emits the fixed terminal error
before closing the session's event bus. No subsequent output is accepted.
Do not add UI controls or a raw diagnostic download to explain these errors.

### Version handling and coexistence

Parse the installed package version without executing a discovery command.
Accept semver major 0 with minor 1 or 2, including prereleases. Reject other
versions and malformed package metadata. The common argv and Typert path is
used for both families. There is no version-specific auth fallback. A version
inside that range still has to pass startup and protocol validation.

The first live native matrix is `0.1.5-rc.1`, `0.1.7-rc.2`, and `0.2.0-rc.2`.
The existing guide documents plugin-mode use on the first two. Only the
owner's local probe establishes native auth on the third so far. These exact
versions must pass the native live lane before claiming their support.
Acceptance of a version range is not certification of every patch release.
Record tested package versions and integrity hashes. Never install `latest`
or modify the user's package during bridge startup.

Keep the existing plugin example unchanged. Add a separate native example in
the future implementation. It uses the same adapter, a distinct ID and binding,
the native scheme, and the stronger floor. The demo remains opt-in and private.
Installation grants nothing, and selecting a primary agent is still separate.

For migration, configure the native binding and dedicated install prefix, restart the bridge,
install the native example, explicitly grant its requests, and replace the
primary-agent slot using the existing generation check. Assign chat-interface
separately if wanted. Old plugin sessions retire through the current boundary.
The external plugin process is never stopped. It may continue serving the
desktop app. Switching back uses the same explicit slot transaction.

Changing an existing native manifest's endpoint requires vacating its slots
and reinstalling it. Reinstallation resets its grants, as today. There is no
silent rewrite of manifests, consent, endpoints, or stored owners. Neither mode
imports the other's sessions, cookies, home, or transcripts. Removing plugin

## Findings

Line references describe the pre-implementation checkout on `feat/dsh-native-auth`; subsequent edits will move lines. The approved design and all three adjacent review records were read. Review 2 supersedes review 1's blanket link ban; review 3 supersedes package-only containment with whole-prefix containment. No live gate has been run by the plan author.

| Fact resolved from source | Evidence |
| --- | --- |
| Launcher already passes bindings and environment; no new CLI option is necessary. Default user state is below the OS home. | `browser-first/host/run-bridge-minimal.mjs:89`, `:405` |
| Composition creates credentials before the registry and strips sources before giving bindings to governance. | `browser-first/host/harness-host-service.mjs:119`, `:133` |
| Registry compares all five fields; no source or runtime epoch is persisted. | `browser-first/host/harness-registry.mjs:20`, `:220`; `browser-first/host/harness-registry-store.mjs:14` |
| Floor policy feeds installation rejection, saved-state disablement, slot eligibility and operation checks. Extending that one policy is sufficient; registry transaction code need not change. | `browser-first/host/harness-policy.mjs:29`, `:41`; `browser-first/host/harness-registry.mjs:64`, `:102`, `:128`, `:228` |
| Existing SDK allows only none/action-token/bearer. Adapter fields reject unknown keys. The compatibility module is a re-export. | `src/core/contracts.ts:526`; `packages/addon-sdk/src/validation.ts:145`, `:156`; `src/sdk/addons/validation.ts:7` |
| Existing token files use O_NOFOLLOW and owner-only modes; keep this stricter policy separate from installation permissions. | `browser-first/host/harness-credentials.mjs:17`, `:21` |
| Current lease use returns endpoint/actionToken; transport stores cookie and exchange promise per session. Native state must instead be shared per epoch. | `browser-first/host/harness-credentials.mjs:69`; `browser-first/host/harness-transport.mjs:21`, `:70` |
| Plugin bootstrap and socket headers are explicit and can stay on the plugin branch. Current RPC replays only 401. | `browser-first/host/harness-transport.mjs:77`, `:110`, `:119` |
| Endpoint guard revalidates DNS and pins numeric address, but defaults to global connectors. | `browser-first/host/agent-runtime-endpoint.mjs:30`, `:45`, `:60`, `:73` |
| Local Undici 7.30.0 supports explicit dispatcher for fetch and WebSocket; its opening has redirect error mode. Generic socket errors do not provide a stable public HTTP status API. Use the spec's single read-only diagnostic. | `node_modules/undici/package.json:3`; `node_modules/undici/types/websocket.d.ts:149`; `node_modules/undici/lib/web/websocket/connection.js:45`, `:95` |
| Adapter joins parts before publication, creating the split-secret hazard. Probe currently skips catalog validation. Catalog decoder requires group.id and model.id, not projected provider/model fields. | `browser-first/host/agent-adapters/dsh-typert.mjs:29`, `:168`, `:260` |
| Follow snapshot precedes prompt dispatch; preserve cancellation barrier and separate 15s/120s bounds. | `browser-first/host/agent-adapters/dsh-typert.mjs:40`, `:115`, `:208`, `:213`, `:216` |
| Pending boundary signal currently starts only at createSession, after resolution. Session references have exactly four fields. Event bus close already emits one fixed terminal error without publishing through current(). | `browser-first/host/harness-boundary.mjs:77`, `:120`, `:123`; `browser-first/host/harness-event-bus.mjs:23` |
| Native sanitation belongs before invoke yields and before route receipt signing; every other result wrapper is needed too. | `browser-first/host/harness-host-service.mjs:193`, `:202`, `:258` |
| Browser chat caches by add-on/generation only and uses shared cache during a turn. Startup is correctly outside the reply race. | `browser-first/host/harness-host-service.mjs:351`, `:356`, `:358`, `:363`, `:371` |
| OpenCode's single hook flag couples exit cleanup to immediate signal exit; launcher cleans services sequentially and lacks a shared shutdown promise. | `browser-first/host/opencode-client.mjs:24`, `:319`, `:401`; `browser-first/host/run-bridge-minimal.mjs:240`, `:501` |
| OpenCode PATH discovery, persisted PID recovery and port fallback must not be copied. | `browser-first/host/opencode-runtime.mjs:44`; `browser-first/host/opencode-client.mjs:145`, `:367` |
| Existing DSH example has no modelCatalog supported operation even though boundary has the method. Native example can explicitly include it; no new route follows from that. | `browser-first/host/harness-examples/deepseek-harness.json:83`; `browser-first/host/harness-boundary.mjs:192`; `browser-first/host/harness-host-service.mjs:314` |
| Protocol fixtures exercise real credentials/transport but only action-token mode; fixture catalog differs from actual catalog fixture in adapter tests. | `browser-first/test/harness-wire-fixtures.mjs:12`, `:39`; `browser-first/test/dsh-harness-adapter.test.mjs:9` |
| Historical native probe reads a token file and supplies Origin; it cannot prove the required memory-only, absent-Origin lane. No credential lookup or probe command was executed. | `/path/to/2.0.0-alpha/.resonant-rig/livepass-dsh02/native.sh:7`; `/path/to/2.0.0-alpha/.resonant-rig/livepass-dsh02/native.mjs:6`, `:36` |
| Scratch 0.2 package declares lib/bin.js and hoisted dependencies. Its browser auth stores a signing key, not the launch token; read-only source evidence does not certify live token reuse. | `/path/to/2.0.0-alpha/.resonant-rig/livepass-dsh02/prefix/node_modules/@deepseek-ai/dsh/package.json:4`, `:15`, `:23`; same prefix `node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:245`, `:324`, `:394` |
| Scratch telemetry configuration reads the environment; disabled backend returns before reporter construction; feedback is a separate trigger. | Same scratch prefix `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:207`; `node_modules/@deepseek-ai/dsh-session-telemetry-otel/lib/index.js:98`, `:127`, `:172` |
| Governing telemetry issue requires a documented policy plus live assertion, not an environment-only test. | [Issue 519](https://github.com/ResonantOS/2.0.0-alpha/issues/519); design lines 249–254, 867–877 |
| Required validation commands exist. Shared TypeScript edits require both build and Vitest. Ownership has its own deterministic check. | `package.json:10`, `:12`, `:17`, `:41`; `docs/architecture/MODULE-OWNERSHIP.md:195` |

Additional implementation facts resolved during the consistency review:

| Fact | Evidence |
| --- | --- |
| OpenCode's public ensure function delegates to a separate start function, so the signal option must be passed through both signatures and the call. | `browser-first/host/opencode-client.mjs:220`, `:245`, `:321` |
| Alpha ownership uses five columns; the three-column table describes shared source. New host rows belong in the former. | `docs/architecture/MODULE-OWNERSHIP.md:15`, `:73` |
| Registry mutation APIs increment revision on slot assignment as well as install/grant, and replacement needs explicit `replace`. | `browser-first/host/harness-registry.mjs:159`, `:261` |
| Real route tests can reuse the production request evaluator; missing bridge auth is 401 and missing capability is 403 before handlers. | `browser-first/test/harness-host-service.test.mjs:43`, `:122`; `browser-first/host/bridge-server.mjs:1238` |
| The fixture signing seed is deliberately public and must mark synthetic process tests as fixture evidence. | `scripts/harness-swap-demo.mjs:18` |
| The exact inspected feedback request is generated, with a strict codec for the put request and result. Unknown versions must pass their own installed descriptor rather than receive a guessed payload. | `/path/to/2.0.0-alpha/.resonant-rig/livepass-dsh02/prefix/node_modules/@deepseek-ai/dsh-message-feedback/lib/typert.remote-client.js:166` |
| Feedback targets the assistant message object ID; the inspected projection returns `event.data.message` for a nonempty assistant event. | `/path/to/2.0.0-alpha/.resonant-rig/livepass-dsh02/prefix/node_modules/@deepseek-ai/dsh-session/lib/index.js:214`; `dsh-message-feedback/lib/index.js:197` in the same scratch prefix |
| Security runner exit success permits nonblocking warnings; preserve individual check statuses when reporting certification. | `scripts/security-pipeline/run-check.mjs:205` |

## File Structure

Each path has one responsibility. Scratch probe files are conductor-owned external artifacts, never staged. Existing files not listed are read-only dependencies.

| Action | Exact path | Responsibility |
| --- | --- | --- |
| Create | `/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/probe.mjs` | Conductor's isolated live protocol gate |
| Create | `/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/observe.mjs` | Conductor's count-only child instrumentation |
| Create | `/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/results.json` | Sanitized exact-package live observations |
| Create | `/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/final-gate.json` | Conductor-authored final observation gate |
| Modify | `src/core/contracts.ts` | Declarative native auth vocabulary |
| Modify | `packages/addon-sdk/src/validation.ts` | Native manifest shape validation |
| Modify | `browser-first/host/harness-policy.mjs` | Native capability floor |
| Create | `browser-first/host/harness-examples/deepseek-harness-native.json` | Separate ungranted native candidate |
| Create | `browser-first/test/dsh-native-policy.test.mjs` | Native declarations and governance denial proof |
| Create | `browser-first/host/dsh-runtime.mjs` | Native config, prefix/home checks, parser, child/lock lifetime |
| Create | `browser-first/test/dsh-native-runtime.test.mjs` | Process and filesystem guard proof |
| Modify | `docs/architecture/MODULE-OWNERSHIP.md` | Explicit runtime/credential/transport/composition ownership |
| Modify | `browser-first/host/harness-credentials.mjs` | Shared native epoch credential custody |
| Create | `browser-first/test/dsh-native-credentials.test.mjs` | Lease, refresh and redaction proof |
| Modify | `package.json` | Direct connector dependency declaration |
| Modify | `package-lock.json` | Reproducible connector dependency resolution |
| Modify | `browser-first/host/agent-runtime-endpoint.mjs` | Private direct dispatcher |
| Modify | `browser-first/host/harness-transport.mjs` | Native cookie exchange and bounded authenticated sends |
| Create | `browser-first/test/dsh-native-transport.test.mjs` | Authentication, proxy isolation and replay guard proof |
| Modify | `browser-first/host/agent-adapters/dsh-typert.mjs` | Validated native readiness and shared catalog decoding |
| Create | `browser-first/test/dsh-native-readiness.test.mjs` | Protocol/provider separation proof |
| Modify | `browser-first/host/harness-boundary.mjs` | Resolution cancellation and runtime retirement |
| Create | `browser-first/test/dsh-native-boundary.test.mjs` | Fences, terminal error and liveness proof |
| Modify | `browser-first/host/harness-host-service.mjs` | Native orchestration, sanitation and chat cache |
| Create | `browser-first/test/dsh-native-host.test.mjs` | Governed composition, receipts and restart proof |
| Create | `browser-first/host/bridge-shutdown.mjs` | Shared bridge signal and asynchronous drain ordering |
| Modify | `browser-first/host/opencode-client.mjs` | Independent signal/exit hook registration |
| Modify | `browser-first/host/run-bridge-minimal.mjs` | Single bridge shutdown owner |
| Create | `browser-first/test/dsh-native-shutdown.test.mjs` | Shared-service shutdown proof |
| Create | `browser-first/test/dsh-native-fake-child.mjs` | Built-in-only synthetic DSH executable for real connector tests |
| Create | `browser-first/test/dsh-native-integration.test.mjs` | Production composition, route denial, foreign-listener and restart proof |
| Modify | `docs/addons/harness-adapter-demo.md` | Separate native setup, migration and certification instructions |
| Modify | `browser-first/host/README.md` | Native operator settings and recovery pointer |
| Create | `browser-first/test/dsh-native-docs.test.mjs` | Operator contract regression check |

Execution prerequisite: conductor checks the feature branch against current `dev` and preserves unrelated work. No task pushes. Commit commands below are instructions for future execution, not authorization to commit during this planning turn. Every security test must produce behavioral red evidence: an import failure alone is insufficient. Record the named failing assertion before its guard is added; when a guard already exists, temporarily apply the exact task-local mutant, run the focused test, restore the guard, and rerun. If redundant guards mask a single-line deletion, use the explicitly described grouped behavioral mutant and report the group; never claim that it proves each line independently. Tests must reach the named assertion with the mutant and pass with the original. Never commit the mutant.

### Recorded conductor evidence and implementation policy

The conductor has already collected three Task 0 runs. This revision records
the supplied outcome; it does not rerun the probe, alter its procedure, or
claim production live certification. Preserve each original run independently;
do not fill run 1's missing telemetry observation from another run.

| Exact version | Collected Task 0 evidence | Policy for later tasks |
| --- | --- | --- |
| `0.2.0-rc.2` | Support-eligible in two of three runs: auth `refresh`, provider `catalog`, origin, telemetry and persistence checks passed. Run 1's telemetry check was incomplete. | The only native-eligible version in this revision. Bake refresh `true` and the strict catalog decoder; production certification still requires Task 12. |
| `0.1.5-rc.1` | Blocked: `observe.mjs` finds none of its source anchors in 0.1.x; `anchor-missing` at probe line 352. | Refuse native acquisition before home preparation or spawn; bake refresh `false`. |
| `0.1.7-rc.2` | Same 0.1.x observer blocker: `anchor-missing` at probe line 352. | Refuse native acquisition before home preparation or spawn; bake refresh `false`. |

These observer failures are missing verification, not proof that 0.1.x itself
cannot implement the protocol. Nevertheless, all 0.1.x native launches are
refused under the current policy. The spec's 0.1.x/0.2.x semver range remains a
candidate range, not blanket eligibility. Task 2 additionally admits exactly
`0.2.0-rc.2`; other versions need separately reviewed evidence and a source
policy change. The refusal is the spec's fixed public
`runtime-unavailable`: `Runtime unavailable.`, with operator message
`Native DSH install prefix is unavailable or unsupported. Select a dedicated prefix with a supported local package and restart the bridge.`
Plugin mode's version behavior is unchanged.

For Tasks 4 and 12, the conductor selects one of the two complete existing
runs as the reviewed `results.json` input, retaining all three version rows
and their original blockers. Do not regenerate evidence or use incomplete run
1 as the policy input. No integrity value, prompt count or unobserved result is
invented by this plan.

> **Paths:** Task 0 commands use `/path/to/2.0.0-alpha` for the repository checkout root; substitute your own. Task 0 was run on 2026-10-13 and its sanitized outcome is recorded in this plan.

### Task 0: Conductor-only exact-package verification

**Files:**
- Create: `/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/observe.mjs`
- Create: `/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/probe.mjs`
- Create/test: `/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/results.json`
- Modify: no repository files in this task.

**Interfaces:**
- Consumes: Node `spawn(file, argv, options)`, scratch packages `@deepseek-ai/dsh@0.1.5-rc.1`, `@deepseek-ai/dsh@0.1.7-rc.2`, `@deepseek-ai/dsh@0.2.0-rc.2`, `DEEPSEEK_API_KEY` supplied privately at probe launch; never read another application's configuration.
- Produces: sanitized per-version `{ version, integrity, auth: 'refresh' | 'once' | 'blocked', provider: 'catalog' | 'structured' | 'blocked', origin: boolean, telemetry: boolean, persistence: boolean, promptDispatches: number, blockedReasons: string[], supportEligible: boolean }`. These are review evidence, not operator overrides or automatic runtime detection. A `structured` provider result requires a reviewed exact decoder before Task 6 can proceed; an unknown shape must not be generalized.

- [ ] **Write the failing evidence assertion.** Run in a private, non-recorded terminal. It deliberately fails before a successful probe exists:

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const path = '/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/results.json';
const rows = JSON.parse(await readFile(path, 'utf8').catch(() => '[]'));
assert.equal(rows.length, 3, 'all three exact packages require live evidence');
for (const version of ['0.1.5-rc.1', '0.1.7-rc.2', '0.2.0-rc.2']) {
  const row = rows.find(row => row.version === version);
  assert.ok(row && ['refresh', 'once', 'blocked'].includes(row.auth));
  assert.ok(['catalog', 'structured', 'blocked'].includes(row.provider));
  assert.ok(Array.isArray(row.blockedReasons));
  assert.ok(row.blockedReasons.every(reason => ['incomplete-observations', 'auth-unobservable', 'provider-unproven', 'origin-unproven', 'telemetry-unproven', 'persistence-unproven'].includes(reason)));
  for (const key of ['origin', 'telemetry', 'persistence', 'supportEligible']) assert.equal(typeof row[key], 'boolean');
  if (row.auth !== 'blocked') assert.ok(row.integrity);
  const eligible = Boolean(row.integrity && ['refresh', 'once'].includes(row.auth) && row.provider === 'catalog' && row.origin && row.telemetry && row.persistence && !row.blockedReasons.length);
  assert.equal(row.supportEligible, eligible);
  if (!eligible) assert.ok(row.blockedReasons.length, 'retain an exact-version blocker');
}
JS
```

Expected before observations: nonzero exit with `all three exact packages require live evidence`. After the probe, this asserts complete accounting, including explicitly blocked rows; it does not certify every version. Missing rows are never skips, and a blocked row cannot grant refresh or a support claim.

- [ ] **Prepare dedicated installs.** These commands are for the conductor, not the plan author. They use no production DSH home, no desktop configuration, no package `latest`, and no port 19387. Refuse an existing task directory rather than reuse unknown state. npm receives no provider key.

```bash
umask 077
mkdir /path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0
node --input-type=module <<'JS'
import { mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = '/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0';
for (let p = await realpath(root); ; p = dirname(p)) {
  const s = await lstat(p);
  assert.ok(s.isDirectory() && [0, process.getuid()].includes(s.uid) && !(s.mode & 0o022), 'unsafe scratch ancestor');
  if (p === '/') break;
}
const npm = join(dirname(process.execPath), 'npm');
for (const version of ['0.1.5-rc.1', '0.1.7-rc.2', '0.2.0-rc.2']) {
  const dir = join(root, version);
  for (const part of ['prefix', 'npm-home', 'npm-cache']) await mkdir(join(dir, part), { recursive: true, mode: 0o700 });
  const result = spawnSync(npm, ['install', '--prefix', join(dir, 'prefix'), '--save-exact', '--package-lock', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`], {
    shell: false, cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { HOME: join(dir, 'npm-home'), npm_config_cache: join(dir, 'npm-cache'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 0, 'scratch npm install failed; inspect privately without sharing output');
  await writeFile(join(dir, 'install-status.json'), JSON.stringify({ version, ok: true }), { mode: 0o600 });
}
JS
```

- [ ] **Write the count-only instrumentation.** Save this complete code to `observe.mjs`. It changes loaded source only in the isolated probe process, never files in an installed package. Missing anchors are an unproven observation, not a successful test. Run an uninstrumented replication afterward; instrumented behavior alone cannot certify an installed package.

```js
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { writeSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
const emit = kind => { try { writeSync(3, JSON.stringify({ kind }) + '\n'); } catch {} };
globalThis.__dshProbe = emit;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.includes('/node_modules/@deepseek-ai/')) return result;
    let source = String(result.source ?? '');
    const insert = (needle, event) => {
      if (source.split(needle).length !== 2) { emit('anchor-missing'); return; }
      source = source.replace(needle, needle + ` globalThis.__dshProbe(${JSON.stringify(event)});`);
      emit(`anchor-${event}`);
    };
    if (url.endsWith('/dsh-api-session-controller/lib/index.js')) insert('async prompt(request) {', 'prompt');
    if (url.endsWith('/dsh-session-telemetry-otel/lib/index.js')) {
      insert('constructor(ctx, config) {', 'telemetry-config');
      insert('if (mode === SessionTelemetryMode.DISABLED) {', 'telemetry-disabled');
      const needle = 'const reporter = ctx.otel.createSessionLogReporter(';
      if (source.split(needle).length === 2) source = source.replace(needle, 'globalThis.__dshProbe("exporter"); ' + needle);
      else emit('anchor-missing');
      const report = 'reporter.reportSessionLog(';
      if (source.split(report).length === 2) source = source.replace(report, 'globalThis.__dshProbe("export-attempt"); ' + report);
      else emit('anchor-missing');
      const feedback = 'if (isFeedback(session, event)) ctx.logger.warn(DISABLED_FEEDBACK_WARNING);';
      if (source.includes(feedback)) source = source.replace(feedback, 'if (isFeedback(session, event)) { globalThis.__dshProbe("feedback-disabled"); ctx.logger.warn(DISABLED_FEEDBACK_WARNING); }');
      else emit('anchor-missing');
    }
    if (url.includes('/dsh-client-product-analytics/') || url.includes('/dsh-host-product-telemetry-otel/')) emit('product-module-loaded');
    return { ...result, source };
  },
});
for (const owner of [http, https]) {
  const original = owner.request;
  owner.request = function (...args) {
    const first = args[0];
    const host = typeof first === 'string' ? new URL(first).hostname : first?.hostname ?? first?.host;
    if (String(host).includes('dsh-otel-collector')) { emit('public-telemetry-attempt'); throw new Error('probe refuses public collector'); }
    return original.apply(this, args);
  };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : args[1];
  if (String(host).includes('dsh-otel-collector')) { emit('public-telemetry-attempt'); throw new Error('probe refuses public collector'); }
  if (host && !['127.0.0.1', 'localhost', 'api.deepseek.com'].includes(String(host))) emit('unexpected-network');
  return connect.apply(this, args);
};
syncBuiltinESMExports();
```

- [ ] **Write the probe.** Save the complete code below to `probe.mjs`. It never prints exception values, headers, token URLs, cookies, prompts or responses. It uses the repository's existing protocol adapter solely as a Typert client, with a probe-local cookie transport. Every child gets fresh HOME and DSH_HOME. No child of this procedure uses port 19387. A key is copied only at spawn and is never persisted. Parent `DEEPSEEK_API_KEY` is read only when launching the keyed child; missing-key and rejected-key children get separate homes.

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
const root = '/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0';
const repo = '/path/to/2.0.0-alpha/.resonant-rig/worktrees/dsh-native';
const { Agent, fetch, WebSocket } = await import(pathToFileURL(join(repo, 'node_modules/undici/index.js')));
const { createDshTypertAdapter } = await import(pathToFileURL(join(repo, 'browser-first/host/agent-adapters/dsh-typert.mjs')));
const direct = new Agent();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, ms = 30000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe deadline')), ms); })]).finally(() => clearTimeout(timer));
};
async function port() {
  const server = tcpServer(); server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  await once(server, 'listening'); const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(value >= 1024 && value !== 19387); return value;
}
async function persisted(dir, secrets) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { if (await persisted(path, secrets)) return true; }
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      if (secrets.some(secret => secret && bytes.includes(Buffer.from(secret)))) return true;
    }
  }
  return false;
}
async function launch(version, mode, instrumented, sink) {
  const base = join(root, version, `${mode}-${instrumented ? 'observed' : 'plain'}-${randomUUID()}`);
  for (const part of ['home', 'dsh', 'tmp', 'cwd']) await mkdir(join(base, part), { recursive: true, mode: 0o700 });
  const selectedPort = await port(), origin = `http://127.0.0.1:${selectedPort}`;
  const env = {
    HOME: join(base, 'home'), DSH_HOME: join(base, 'dsh'), TMPDIR: join(base, 'tmp'),
    XDG_CONFIG_HOME: join(base, 'home/config'), XDG_DATA_HOME: join(base, 'home/data'),
    XDG_STATE_HOME: join(base, 'home/state'), XDG_CACHE_HOME: join(base, 'home/cache'),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    DSH_TELEMETRY_MODE: mode === 'control' ? 'FEEDBACK_ONLY' : 'DISABLED',
  };
  if (['keyed', 'feedback', 'control'].includes(mode)) {
    const key = process.env.DEEPSEEK_API_KEY;
    assert.ok(key, 'private launch key required'); env.DEEPSEEK_API_KEY = key;
  }
  if (mode === 'rejected') env.DEEPSEEK_API_KEY = `probe-invalid-${randomUUID()}`;
  if (mode === 'control') env.DSH_TELEMETRY_OTLP_URL = sink;
  const bin = join(root, version, 'prefix/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const argv = [...(instrumented ? ['--import', join(root, 'observe.mjs')] : []), bin, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(selectedPort)];
  const sockets = new Set(), secrets = [];
  if (env.DEEPSEEK_API_KEY) secrets.push(env.DEEPSEEK_API_KEY);
  const child = spawn(process.execPath, argv, { shell: false, cwd: join(base, 'cwd'), env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  delete env.DEEPSEEK_API_KEY;
  const counts = Object.create(null); let observations = '';
  child.stdio[3].on('data', chunk => {
    observations += chunk.toString();
    while (observations.includes('\n')) {
      const end = observations.indexOf('\n'), line = observations.slice(0, end); observations = observations.slice(end + 1);
      try { const { kind } = JSON.parse(line); if (/^[a-z-]+$/.test(kind)) counts[kind] = (counts[kind] ?? 0) + 1; } catch {}
    }
  });
  child.stderr.resume();
  let exited = false; const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  let token = '', cookie = '', buffer = '', bytes = 0, announceResolve, announceReject;
  let protocolReady = false, announcementFailure;
  const announced = new Promise((resolve, reject) => { announceResolve = resolve; announceReject = reject; });
  announced.catch(() => {});
  const decoder = new StringDecoder('utf8');
  function failAnnouncement() {
    if (protocolReady || announcementFailure) return;
    announcementFailure = new Error('announcement refused'); buffer = '';
    announceReject(announcementFailure); // May already be resolved: the latch is authoritative.
  }
  function checkAnnouncement() { if (announcementFailure) throw announcementFailure; }
  const startupTimer = setTimeout(failAnnouncement, 30000);
  function ready() {
    checkAnnouncement(); assert.ok(token && !exited);
    protocolReady = true; buffer = ''; clearTimeout(startupTimer);
  }
  child.on('error', failAnnouncement);
  child.stdout.on('end', () => {
    if (protocolReady || announcementFailure) return;
    buffer += decoder.end();
    if (!token || buffer.startsWith('dsh web: ')) failAnnouncement();
    buffer = '';
  });
  child.stdout.on('data', chunk => {
    if (protocolReady || announcementFailure) return;
    bytes += chunk.length; buffer += decoder.write(chunk);
    if (bytes > 1048576) { failAnnouncement(); return; }
    while (buffer.includes('\n')) {
      const i = buffer.indexOf('\n'), raw = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (Buffer.byteLength(raw) > 16384) { failAnnouncement(); return; }
      const line = raw.replace(/\r$/, '');
      if (!line.startsWith('dsh web: ')) continue;
      try {
        const rawUrl = line.slice(9), url = new URL(rawUrl);
        assert.equal(url.origin, origin); assert.equal(url.pathname, '/');
        assert.ok(rawUrl.startsWith(origin + '/?token=') && rawUrl === rawUrl.trim());
        assert.equal(url.username + url.password + url.hash, '');
        assert.deepEqual([...url.searchParams.keys()], ['token']);
        const value = url.searchParams.get('token'); assert.match(value, /^[A-Za-z0-9._~-]{1,8192}$/);
        if (token) assert.equal(value, token);
        else { token = value; announceResolve(); }
      } catch { failAnnouncement(); return; }
    }
    if (Buffer.byteLength(buffer) > 16384) failAnnouncement();
  });
  async function stop() {
    clearTimeout(startupTimer);
    for (const socket of sockets) socket.close();
    if (!exited) child.kill('SIGTERM');
    await Promise.race([exit, delay(1000)]);
    if (!exited) child.kill('SIGKILL');
    await within(exit, 1000);
    checkAnnouncement(); // Even a late conflict after announced resolved fails this version.
  }
  async function exchange() {
    checkAnnouncement();
    const response = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { dispatcher: direct, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
    checkAnnouncement();
    if ([401, 403].includes(response.status)) return null; // Explicit re-exchange rejection.
    assert.equal(response.status, 303, 'unobservable exchange is not verified non-reuse');
    const pairs = response.headers.getSetCookie().map(row => row.split(';')[0]).filter(row => /^dsh-auth-/.test(row));
    assert.equal(pairs.length, 1); assert.match(pairs[0], /^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/);
    assert.equal(new URL(response.headers.get('location') ?? '/', origin).href, origin + '/');
    secrets.push(pairs[0], pairs[0].split('=').slice(1).join('=')); return pairs[0];
  }
  let sequence = 0, lastPage;
  async function raw(method, args = {}, selectedCookie = cookie) {
    checkAnnouncement();
    const rpcId = `probe-${++sequence}`;
    const response = await fetch(`${origin}/api/${method}`, {
      dispatcher: direct, redirect: 'manual', signal: AbortSignal.timeout(10000), method: 'POST',
      headers: { cookie: selectedCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    });
    const body = response.status === 200 ? await response.json() : null;
    await response.body?.cancel().catch(() => {});
    if (method === 'session/page' && body?.result?.ok) lastPage = body.result.value;
    if (body) assert.ok(body.type === 'server-response' && body.rpcId === rpcId && typeof body.result?.ok === 'boolean');
    checkAnnouncement(); return { status: response.status, body };
  }
  const transport = {
    async request(route, options) {
      const result = await raw(route.slice(5), options.body.payload.args);
      if (result.body) result.body.rpcId = options.body.rpcId;
      return result;
    },
    async openStream({ onMessage, onError, onClose } = {}) {
      checkAnnouncement();
      const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/remote.mux', { dispatcher: direct, headers: { cookie } });
      sockets.add(socket);
      socket.addEventListener('message', event => { try { onMessage?.(JSON.parse(event.data)); } catch { onError?.(new Error('invalid message')); } });
      socket.addEventListener('close', () => { sockets.delete(socket); onClose?.(); });
      await within(new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('opening failed')), { once: true }); }), 10000);
      checkAnnouncement(); return { send: value => socket.send(JSON.stringify(value)), close: () => socket.close() };
    },
    dispose() { for (const socket of sockets) socket.close(); },
  };
  try { await within(announced); secrets.push(token, origin + '/?token=' + token); cookie = await exchange(); assert.ok(cookie); }
  catch (error) { await stop(); throw error; }
  return { raw, exchange, transport, counts, base, stop, secrets, ready,
    get page() { return lastPage; }, get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}
async function telemetry(version) {
  const modules = join(root, version, 'prefix/node_modules/@deepseek-ai');
  const config = await readFile(join(modules, 'dsh-base/cordis.patch.yml'), 'utf8');
  assert.ok(config.includes('process.env.DSH_TELEMETRY_MODE'));
  assert.ok(config.includes('process.env.DSH_TELEMETRY_OTLP_URL'), 'control must use local exporter');
  const { TYPERT_REMOTE } = await import(pathToFileURL(join(modules, 'dsh-message-feedback/lib/typert.remote-client.js')));
  const descriptor = TYPERT_REMOTE.descriptors.find(d => d.service === 'messageFeedback' && d.method === 'put');
  assert.ok(descriptor && descriptor.invocation.kind === 'direct');
  assert.deepEqual(descriptor.parameters.map(p => [p.name, p.wire, p.source]), [['request', 'request', 'json']]);
  let sinkRequests = 0;
  const sink = createServer((request, response) => { sinkRequests++; request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
  sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
  assert.notEqual(sink.address().port, 19387);
  const sinkURL = `http://127.0.0.1:${sink.address().port}/v1/logs`;
  try {
    for (const mode of ['feedback', 'control']) {
      const p = await launch(version, mode, true, sinkURL);
      const adapter = createDshTypertAdapter({ transport: p.transport });
      try {
        const session = await adapter.createSession();
        await adapter.modelCatalog({ session }); p.ready(); // Validated protocol Ready, not token capture.
        const frames = await within(Array.fromAsync(adapter.invoke({ session, input: { messages: [{ role: 'user', content: 'Reply with the word synthetic. Do not use tools.' }] } })), 120000);
        assert.equal(frames.at(-1)?.type, 'final');
        await adapter.history({ session });
        const messageId = p.page.records.filter(r => r.event?.type === 'assistant/message').at(-1)?.event?.data?.message?.id;
        assert.equal(typeof messageId, 'string');
        const request = descriptor.parameters[0].codec.create().parse({ sessionId: session.sessionId, messageId, rating: 'positive', note: 'Synthetic telemetry probe', ifVersion: null });
        const feedback = await p.raw('messageFeedback/put', { request });
        assert.equal(feedback.status, 200); assert.equal(feedback.body.result.ok, true);
        const committed = descriptor.result.create().parse(feedback.body.result.value);
        assert.equal(committed.ok, true, 'feedback must commit, not merely reach a handler');
        await delay(1000);
      } finally { await adapter.dispose(); await p.stop(); }
      assert.equal(p.counts['anchor-missing'] ?? 0, 0);
      assert.equal(p.counts['product-module-loaded'] ?? 0, 0);
      assert.equal(p.counts['public-telemetry-attempt'] ?? 0, 0);
      if (mode === 'feedback') {
        assert.ok(p.counts['telemetry-disabled'] > 0);
        assert.ok(p.counts['feedback-disabled'] > 0);
        assert.equal(p.counts.exporter ?? 0, 0);
        assert.equal(p.counts['export-attempt'] ?? 0, 0);
        assert.equal(p.counts['unexpected-network'] ?? 0, 0);
        assert.equal(sinkRequests, 0);
      } else {
        assert.ok(p.counts.exporter > 0);
        assert.ok(p.counts['export-attempt'] > 0);
        assert.ok(sinkRequests > 0, 'enabled positive control must reach loopback sink');
      }
      assert.equal(await persisted(p.base, p.secrets), false);
    }
    return true;
  } finally { await new Promise(resolve => sink.close(resolve)); }
}
import * as filesystem from 'node:fs/promises';
import { relative, resolve, sep, isAbsolute } from 'node:path';
const probeFailure = () => new Error('scratch prefix refused');
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
const own = stat => [0, process.getuid()].includes(stat.uid);
const safeNode = stat => own(stat) && !(stat.mode & 0o022) && (stat.isDirectory() || stat.isFile());
async function inspectPrefix(prefix, { fs = filesystem, deadline, now = Date.now } = {}) {
  const check = () => { if (now() >= deadline) throw probeFailure('deadline-exceeded', 'deadline'); };
  try {
    check(); if (!prefix || !isAbsolute(prefix)) throw probeFailure('runtime-unavailable', 'package');
    const root = await fs.realpath(prefix); check();
    for (let p = root; ; p = dirname(p)) {
      const stat = await fs.lstat(p); check();
      if (!stat.isDirectory() || !safeNode(stat)) throw probeFailure('runtime-unavailable', 'package');
      if (p === '/') break;
    }
    let count = 0, depth = 0;
    const counted = new Set(), visited = new Set();
    function bound(path) {
      if (!inside(root, path)) throw probeFailure('runtime-unavailable', 'package');
      const d = relative(root, path).split(sep).filter(Boolean).length;
      depth = Math.max(depth, d); if (d > 64) throw probeFailure('runtime-unavailable', 'limit');
    }
    async function target(path, seen = new Set()) {
      bound(path); check();
      if (seen.has(path)) throw probeFailure('runtime-unavailable', 'package');
      seen.add(path);
      const components = relative(root, path).split(sep).filter(Boolean);
      let current = root;
      for (let i = 0; i < components.length; i++) {
        current = join(current, components[i]); bound(current);
        const stat = await fs.lstat(current); check();
        if (stat.isSymbolicLink()) {
          if (!own(stat)) throw probeFailure('runtime-unavailable', 'package');
          const link = resolve(dirname(current), await fs.readlink(current)); check(); bound(link);
          const resolved = await target(link, new Set(seen));
          return target(join(resolved, ...components.slice(i + 1)), new Set(seen));
        }
        if (!safeNode(stat) || (i < components.length - 1 && !stat.isDirectory())) throw probeFailure('runtime-unavailable', 'package');
      }
      return current;
    }
    async function walk(path, ancestry = new Set()) {
      check(); bound(path);
      if (counted.has(path)) return;
      counted.add(path); if (++count > 50000) throw probeFailure('runtime-unavailable', 'limit');
      const stat = await fs.lstat(path); check();
      if (stat.isSymbolicLink()) {
        if (!own(stat)) throw probeFailure('runtime-unavailable', 'package');
        const end = await target(path); if (ancestry.has(end)) throw probeFailure('runtime-unavailable', 'package'); await walk(end, ancestry); return;
      }
      if (!safeNode(stat)) throw probeFailure('runtime-unavailable', 'package');
      if (stat.isDirectory() && !visited.has(path)) {
        visited.add(path);
        for (const name of await fs.readdir(path)) await walk(join(path, name), new Set([...ancestry, path]));
      }
    }
    await walk(root);
    const metadataPath = await target(join(root, 'node_modules/@deepseek-ai/dsh/package.json'));
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); check();
    const semver = /^(0)\.(1|2)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
    if (metadata.name !== '@deepseek-ai/dsh' || typeof metadata.version !== 'string' || !semver.test(metadata.version)) throw probeFailure('runtime-unavailable', 'package');
    const entry = await target(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
    if (!(await fs.lstat(entry)).isFile()) throw probeFailure('runtime-unavailable', 'package');
    check(); return { entry, version: metadata.version, count, depth };
  } catch (error) {
    if (error?.reason) throw error;
    throw probeFailure('runtime-unavailable', 'package');
  }
}
const rows = [];
try {
  for (const version of ['0.1.5-rc.1', '0.1.7-rc.2', '0.2.0-rc.2']) {
    const row = { version, integrity: null,
      auth: 'blocked', provider: 'blocked', origin: false, telemetry: false, persistence: false, promptDispatches: 0,
      blockedReasons: [], supportEligible: false };
    rows.push(row);
    try {
    const lock = JSON.parse(await readFile(join(root, version, 'prefix/package-lock.json'), 'utf8'));
    row.integrity = lock.packages['node_modules/@deepseek-ai/dsh'].integrity;
    let observedAuth = 'blocked';
    const started = Date.now(), checked = await inspectPrefix(join(root, version, 'prefix'), { deadline: started + 30000 });
    Object.assign(row, { entries: checked.count, depth: checked.depth, walkMs: Date.now() - started });
    for (const instrumented of [true, false]) {
      const p = await launch(version, 'keyed', instrumented);
      const adapter = createDshTypertAdapter({ transport: p.transport });
      try {
        const a = await adapter.createSession(), b = await adapter.createSession();
        await adapter.modelCatalog({ session: a }); p.ready();
        const frames = [];
        const input = { messages: [{ role: 'user', content: 'Return integers one through fifty as plain text. Do not use tools.' }] };
        const ta = Array.fromAsync(adapter.invoke({ session: a, input })).then(v => { frames.push(v); return v; }, () => []);
        const tb = Array.fromAsync(adapter.invoke({ session: b, input })).then(v => { frames.push(v); return v; }, () => []);
        const end = Date.now() + 10000;
        while (instrumented && (p.counts.prompt ?? 0) < 2 && Date.now() < end) await delay(10);
        assert.ok(!frames.length, 'turns must overlap exchange while active');
        const initialSocket = await p.transport.openStream(); initialSocket.close(); row.origin = true;
        const old = p.cookie, replacement = await p.exchange();
        const oldStatus = (await p.raw('session/modelCatalog', {}, old)).status, oldValid = oldStatus === 200;
        let replacementValid = false, socketValid = false;
        if (replacement) {
          replacementValid = (await p.raw('session/modelCatalog', {}, replacement)).status === 200;
          p.cookie = replacement;
          try { const stream = await p.transport.openStream(); stream.close(); socketValid = true; } catch {}
        }
        p.cookie = old;
        let oldSocketValid = false;
        try { const originalSocket = await p.transport.openStream(); originalSocket.close(); oldSocketValid = true; } catch {}
        const completed = await within(Promise.all([ta, tb]), 120000).catch(() => [[], []]);
        const turnsValid = completed.every(value => value.at(-1)?.type === 'final');
        const before = p.counts.prompt ?? 0;
        const bad = `dsh-auth-invalid=${randomUUID()}`;
        const refused = await p.raw('session/prompt', { request: { sessionId: a.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Synthetic auth rejection probe.' }], requestId: randomUUID() } }, bad);
        p.cookie = bad;
        let rejectedSocket = false;
        try { const stream = await p.transport.openStream(); stream.close(); } catch { rejectedSocket = true; }
        p.cookie = replacement ?? old;
        let restoredSocket = false;
        try { const restored = await p.transport.openStream(); restored.close(); restoredSocket = true; } catch {}
        await delay(50);
        const predispatch = refused.status === 401 && (!instrumented || (p.counts.prompt ?? 0) === before);
        if (instrumented) {
          assert.equal(p.counts['anchor-missing'] ?? 0, 0);
          assert.equal(p.counts['anchor-prompt'], 1);
          row.promptDispatches = before;
          const reusable = replacement && oldValid && replacementValid && socketValid && oldSocketValid && restoredSocket && turnsValid && predispatch && rejectedSocket && before === 2;
          const nonReusable = replacement === null || oldStatus === 401;
          const postDispatch401 = refused.status === 401 && (p.counts.prompt ?? 0) > before;
          observedAuth = reusable ? 'refresh' : (nonReusable || postDispatch401) ? 'once' : 'blocked';
          // A timeout, missing opening/status, or incomplete active-stream observation
          // is blocked, never silently classified as exchange-once.
        } else {
          if (observedAuth === 'refresh') assert.ok(replacement && oldValid && replacementValid && socketValid && oldSocketValid && restoredSocket && turnsValid && predispatch && rejectedSocket, 'uninstrumented protocol replication');
          // A verified adverse instrumented result stays conservative (once).
          // Any additional uninstrumented fault throws and leaves row.auth blocked.
        }
        if (restoredSocket) {
        await adapter.history({ session: a });
        const catalog = await adapter.modelCatalog({ session: a });
        if (catalog.default) await adapter.selectModel({ session: a, input: catalog.default });
        const pending = Array.fromAsync(adapter.invoke({ session: a, input }));
        await delay(100); await adapter.cancel({ session: a }); await within(pending);
        }
      } finally { await adapter.dispose(); await p.stop(); }
      row.persistence = !(await persisted(p.base, p.secrets));
      assert.equal(row.persistence, true);
    }
    row.auth = observedAuth;
    let providerCatalog = true;
    for (const mode of ['missing', 'rejected']) {
      const p = await launch(version, mode, true);
      const adapter = createDshTypertAdapter({ transport: p.transport });
      try {
        const catalog = await p.raw('session/modelCatalog');
        providerCatalog &&= catalog.status === 200 && catalog.body?.result?.ok === true && Array.isArray(catalog.body.result.value?.groups);
        if (!providerCatalog) continue;
        const session = await adapter.createSession();
        await adapter.modelCatalog({ session }); p.ready();
        const frames = await within(Array.fromAsync(adapter.invoke({ session, input: { messages: [{ role: 'user', content: 'Reply OK without tools.' }] } })), 120000);
        assert.ok(['error', 'final'].includes(frames.at(-1)?.type));
      } finally { await adapter.dispose(); await p.stop(); }
    }
    row.provider = providerCatalog ? 'catalog' : 'blocked';
    row.telemetry = await telemetry(version);
    } catch { row.blockedReasons.push('incomplete-observations'); }
    if (row.auth === 'blocked') row.blockedReasons.push('auth-unobservable');
    if (row.provider !== 'catalog') row.blockedReasons.push('provider-unproven');
    if (!row.origin) row.blockedReasons.push('origin-unproven');
    if (!row.telemetry) row.blockedReasons.push('telemetry-unproven');
    if (!row.persistence) row.blockedReasons.push('persistence-unproven');
    row.supportEligible = Boolean(row.integrity && !row.blockedReasons.length);
    if (!row.supportEligible) process.exitCode = 1;
  }
} catch { process.exitCode = 1; console.error('FAIL evidence collection; incomplete rows are not certification.'); }
finally { await direct.close(); await writeFile(join(root, 'results.json'), JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 }); }
```

- [ ] **Check the probe parser independently before any live launch.** This extracts only its stdout-parser block, attaches synthetic emitters and proves that rejection after the first announcement remains observable. It does not load a DSH package or open a connection. A missing-token EOF fails, valid-token EOF succeeds before Ready, conflicts still fail before Ready, and post-Ready output is discarded. Run with the post-token early return restored, with the conflict assertion removed, and with the unconditional EOF rejection restored; each mutant must fail its named assertion. Restore before running live.

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
const source = await readFile('/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/probe.mjs', 'utf8');
const start = source.indexOf("  let token = '', cookie = '', buffer = ''");
const end = source.indexOf('  async function stop() {', start);
assert.ok(start >= 0 && end > start);
const build = new Function('assert', 'StringDecoder', 'child', 'origin', 'exited', source.slice(start, end) +
  '\nreturn { ready, checkAnnouncement, dispose() { clearTimeout(startupTimer); } };');
const origin = 'http://127.0.0.1:3081', line = `dsh web: ${origin}/?token=synthetic\n`;
function check(run) {
  const child = new EventEmitter(); child.stdout = new EventEmitter();
  const parser = build(assert, StringDecoder, child, origin, false);
  try { run(parser, text => child.stdout.emit('data', Buffer.from(text)), () => child.stdout.emit('end')); }
  finally { parser.dispose(); }
}
check((p, write, end) => { write(line); end(); assert.doesNotThrow(p.ready, 'valid announcement EOF is allowed'); });
check((p, write, end) => { end(); assert.throws(p.ready, 'missing announcement EOF fails'); });
for (const together of [true, false]) check((p, write) => {
  const conflict = `dsh web: ${origin}/?token=other\n`;
  if (together) write(line + conflict); else { write(line); write(conflict); }
  assert.throws(p.ready, 'conflict after resolved announcement still blocks readiness');
});
check((p, write, end) => { write(line); write(`dsh web: ${origin}/?token=other`); end(); assert.throws(p.ready); });
check((p, write) => { write(line); write(line); assert.doesNotThrow(p.ready); write(`dsh web: ${origin}/?token=other\n`); assert.doesNotThrow(p.checkAnnouncement); });
check((p, write) => { write(line); for (let i = 0; i < 1024; i++) write('x'.repeat(1023) + '\n'); assert.throws(p.ready, 'post-token bytes still count'); });
console.log('Synthetic probe-parser assertions passed; no live probe ran.');
JS
```

- [ ] **Run the protocol probe with launch-only key input.** No `set -x`, pipe to `tee`, shell history value, or credential file:

```bash
read -r -s 'dsh_probe_key?DeepSeek key for isolated live probe: '
DEEPSEEK_API_KEY="$dsh_probe_key" node /path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/probe.mjs
unset dsh_probe_key
```

- [ ] **Accept telemetry only when the executable assertions pass.** The probe loads and validates the feedback descriptor from each exact install before sending a request. Missing descriptors, source anchors, loaded-product checks or local exporter configuration fail closed. The disabled lane observes committed feedback and zero exporter/export/network counts; the enabled lane must export to the local sink. No hand-edited observation may set a result to true. The network counter observes Node `net.Socket.connect`; a package using an unobserved native transport blocks certification until the conductor supplies a reviewed observer. Unobservable traffic is not zero traffic.


| Probe result | Later-task branch |
| --- | --- |
| Reusable token, old/new cookies accepted, both fresh sockets work without Origin, both active turns finish with exactly one upstream prompt, invalid-cookie RPC 401 causes zero dispatch | Task 4 enables shared refresh for that exact reviewed package; Task 5 allows one replay/replacement within the original deadline. |
| Second exchange fails, invalidates old cookie, interrupts a stream, or a 401 follows dispatch | Task 4 uses `refreshAllowed: false`; Task 5 fences on confirmed 401 and never resends. A new explicit session is required. |
| Auth dispatch count or active-stream observation unavailable | Block refresh implementation and support claim for that package. Repeat with an audited count hook; client send counts are insufficient. |
| Missing/rejected-key catalog validates, including empty groups | Task 6's strict success decoder establishes Ready. Provider failure during a turn remains an operation error without process stop. |
| Stable machine-readable provider rejection found | Block that version's Task 6 decoder and support claim until the exact structure and negative auth/schema controls are recorded; add a strict decoder for that structure with full tests. Never infer from error text. |
| Provider rejection cannot be distinguished | Block native support for that package; no key-required workaround. |
| Cookie-only socket without explicit Origin fails | Block that version; do not add Origin or action-token headers. |
| Disabled feedback has exporter/attempt/traffic, or positive control cannot be observed | Block native support and final certification for that exact version. Do not weaken the telemetry policy. |
| A token/cookie is persisted | Block native support for that exact version. A separate DSH cookie-signing secret is not itself the boot token/cookie, but must stay inside the private home. |
| Package validation exceeds 50,000 entries, depth 64 or 30 seconds | Task 2 refuses launch with the specified fixed result; do not raise a ceiling. |

- [ ] **Account for every version with the evidence assertion.** Repeat the first command after collection; keep every blocked row and its fixed reason. A nonzero probe exit means at least one version is blocked, not that other rows are unusable. Tasks 4/6 may proceed for independently verified versions. A verified non-reusable version must be encoded as exchange-once. Unknown versions get no refresh or support claim. Report per-version completion; never claim all three gates passed while any row is blocked.
- [ ] **Commit:** no repository commit for scratch evidence. Confirm with `git status --short`. Never `git add` the scratch directory. Task 0 produces external evidence only.

### Task 1: Declare native mode and enforce its capability floor

**Files:**
- Modify: `src/core/contracts.ts:526`
- Modify: `packages/addon-sdk/src/validation.ts:156`
- Modify: `browser-first/host/harness-policy.mjs:29`
- Create: `browser-first/host/harness-examples/deepseek-harness-native.json`
- Create/test: `browser-first/test/dsh-native-policy.test.mjs`

**Interfaces:**
- Consumes: `validateAddOnManifest(candidate, options?) -> { valid, issues }`, `adapterCapabilityFloor(manifest) -> string[]`, `createHarnessRegistry({store, reviewedAdapterIds, bindings}) -> Promise<registry>`.
- Produces: auth scheme literal `'dsh-native-cookie'`, native example ID `addon.deepseek-harness-native`, binding `dsh.native`, and floor `['agent-runtime', 'network', 'filesystem', 'shell']` only for `dsh-typert-v1` plus the native scheme. Existing registry APIs and SDK re-export remain unchanged.

- [ ] **Write the failing test** in the new test file:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAddOnManifest } from '../../packages/addon-sdk/src/validation.ts';
import { adapterCapabilityFloor } from '../host/harness-policy.mjs';
import { createHarnessRegistry } from '../host/harness-registry.mjs';
const plugin = JSON.parse(await readFile(new URL('../host/harness-examples/deepseek-harness.json', import.meta.url)));
function native() {
  const m = structuredClone(plugin);
  m.id = 'addon.deepseek-harness-native';
  Object.assign(m.agentRuntime, { authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081', credentialBinding: 'dsh.native' });
  for (const capability of ['filesystem', 'shell']) m.requestedCapabilities.push({ capability, scope: 'system', revocationBehavior: 'hard-stop', granted: false });
  return m;
}
const bindings = [{ name: 'dsh.native', addonId: 'addon.deepseek-harness-native', adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081' }];
test('native scheme is declarative and narrowly paired', () => {
  assert.equal(validateAddOnManifest(native()).valid, true);
  for (const endpoint of ['http://localhost:3081', 'http://127.0.0.1:3081/', 'http://127.0.0.1:0', 'http://127.0.0.1:1023', 'https://127.0.0.1:3081', 'http://127.0.0.1:3081/?token=x']) {
    const m = native(); m.agentRuntime.endpoint = endpoint;
    assert.equal(validateAddOnManifest(m).valid, false, endpoint);
  }
  const wrong = native(); wrong.agentRuntime.adapterId = 'openai-compatible-v1';
  assert.equal(validateAddOnManifest(wrong).valid, false);
  const path = native(); path.agentRuntime.source = { managedDsh: true };
  assert.equal(validateAddOnManifest(path).valid, false);
  assert.deepEqual(adapterCapabilityFloor(plugin), ['agent-runtime', 'network']);
  assert.deepEqual(adapterCapabilityFloor(native()), ['agent-runtime', 'network', 'filesystem', 'shell']);
});
for (const capability of ['agent-runtime', 'network', 'filesystem', 'shell']) {
  test(`native floor ${capability} cannot be omitted or implicitly granted`, async () => {
    let saved = null;
    const store = { read: async () => saved, write: async value => { saved = structuredClone(value); } };
    const registry = await createHarnessRegistry({ store, reviewedAdapterIds: ['dsh-typert-v1'], bindings });
    const missing = native(); missing.requestedCapabilities = missing.requestedCapabilities.filter(g => g.capability !== capability);
    await assert.rejects(registry.install(missing, { enabled: true, expectedRevision: 0 }));
    const m = native(); await registry.install(m, { enabled: true, expectedRevision: 0 });
    const grants = m.requestedCapabilities.map(g => ({ ...g, granted: g.capability !== capability }));
    await registry.setGrants(m.id, grants, { consent: true, expectedRevision: 1 });
    await assert.rejects(registry.assignSlot('primary-agent', m.id, { expectedGeneration: 0 }), { code: 'permission-denied' });
    await registry.setGrants(m.id, m.requestedCapabilities.map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: 2 });
    await registry.assignSlot('primary-agent', m.id, { expectedGeneration: 0 });
    const authorization = registry.authorize('primary-agent', m.id);
    for (const operation of m.agentRuntime.supportedOperations) registry.assertOperation(authorization, operation);
    await registry.setGrants(m.id, grants, { consent: true, expectedRevision: 4 });
    for (const operation of m.agentRuntime.supportedOperations) assert.throws(() => registry.assertOperation(authorization, operation));
    assert.equal(registry.snapshot().slots['primary-agent'].generation, 2);
  });
}
// filesystem/shell are the additional native floor. Unlike agent-runtime/network,
// this fixture can omit either without violating existing SDK dependencies.
for (const capability of ['filesystem', 'shell']) {
  test(`saved native floor ${capability} vacates the owner without invalid grants`, async () => {
    let saved = null;
    const store = { read: async () => saved, write: async value => { saved = structuredClone(value); } };
    const options = { store, reviewedAdapterIds: ['dsh-typert-v1'], bindings };
    const registry = await createHarnessRegistry(options), m = native();
    await registry.install(m, { enabled: true, expectedRevision: 0 });
    await registry.setGrants(m.id, m.requestedCapabilities.map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: 1 });
    await registry.assignSlot('primary-agent', m.id, { expectedGeneration: 0 });
    assert.deepEqual(registry.snapshot().slots['primary-agent'], { addonId: m.id, generation: 1, available: true });
    const entry = saved.state.installations[m.id];
    entry.manifest.requestedCapabilities = entry.manifest.requestedCapabilities.filter(g => g.capability !== capability);
    entry.grants = entry.grants.filter(g => g.capability !== capability);
    assert.equal(validateAddOnManifest(entry.manifest).valid, true);
    assert.ok(entry.grants.every(g => g.granted && entry.manifest.requestedCapabilities.some(r =>
      r.capability === g.capability && r.scope === g.scope && r.revocationBehavior === g.revocationBehavior)));
    const loaded = (await createHarnessRegistry(options)).snapshot();
    assert.equal(loaded.revision, 3, 'valid document loaded, not the catch/reset path');
    assert.equal(loaded.installations[m.id].enabled, false);
    assert.deepEqual(loaded.slots['primary-agent'], { addonId: null, generation: 2, available: false });
  });
}
```

- [ ] **Run and see red:** `node --test browser-first/test/dsh-native-policy.test.mjs`. Expected: native validity false and missing native filesystem/shell floor. Record these assertion failures.
- [ ] **Minimal implementation.** Run this exact edit script; its input anchors must match once. It derives the complete separate JSON from the unchanged plugin example, so no manifest fields are omitted:

```bash
python3 - <<'PY'
from pathlib import Path
import json
p=Path('src/core/contracts.ts'); s=p.read_text(); old='authScheme: "none" | "dsh-action-token" | "bearer";'; assert s.count(old)==1
p.write_text(s.replace(old, 'authScheme: "none" | "dsh-action-token" | "dsh-native-cookie" | "bearer";'))
p=Path('packages/addon-sdk/src/validation.ts'); s=p.read_text(); old='["none", "dsh-action-token", "bearer"].includes(runtime.authScheme as string)'; assert s.count(old)==1
s=s.replace(old, '["none", "dsh-action-token", "dsh-native-cookie", "bearer"].includes(runtime.authScheme as string)')
anchor='  if (runtime.authScheme !== "none" || runtime.credentialBinding !== undefined) {'; assert s.count(anchor)==1
s=s.replace(anchor, '''  if (runtime.authScheme === "dsh-native-cookie") {
    if (runtime.adapterId !== "dsh-typert-v1") reject("auth-scheme", "authScheme", "Native authentication requires the reviewed DSH adapter.");
    const match = typeof runtime.endpoint === "string" && /^http:\\/\\/127\\.0\\.0\\.1:([1-9][0-9]{3,4})$/.exec(runtime.endpoint);
    if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) reject("endpoint", "endpoint", "Native DSH requires an exact numeric loopback origin and approved port.");
  }
'''+anchor); p.write_text(s)
p=Path('browser-first/host/harness-policy.mjs'); s=p.read_text(); anchor='  const adapterId = manifest?.agentRuntime?.adapterId;'; assert s.count(anchor)==1
p.write_text(s.replace(anchor, anchor+'''\n  if (adapterId === 'dsh-typert-v1' && manifest.agentRuntime.authScheme === 'dsh-native-cookie') {
    return ['agent-runtime', 'network', 'filesystem', 'shell'];
  }'''))
m=json.loads(Path('browser-first/host/harness-examples/deepseek-harness.json').read_text())
m['id']='addon.deepseek-harness-native'; m['name']='DeepSeek Harness Native'
m['compatibility']['platforms']=['macOS','linux']
r=m['agentRuntime']; r.update(authScheme='dsh-native-cookie',endpoint='http://127.0.0.1:3081',credentialBinding='dsh.native',chatAuthorLabel='DeepSeek Harness Native')
r['supportedOperations'].append('modelCatalog')
for c in ['filesystem','shell']:
 m['requestedCapabilities'].append(dict(capability=c,scope='system',revocationBehavior='hard-stop',granted=False))
 r['requiredCapabilities'].append(c)
 m['tools'][0]['requiredCapabilities'].append(c)
Path('browser-first/host/harness-examples/deepseek-harness-native.json').write_text(json.dumps(m,indent=2)+'\n')
PY
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-policy.test.mjs browser-first/test/harness-manifest.test.mjs browser-first/test/harness-policy.test.mjs browser-first/test/harness-registry.test.mjs`.
- [ ] **Red evidence for every declaration/floor guard:** independently remove the native adapter pairing, endpoint check and native floor return; run the named native test file after each mutation. Each must produce a behavioral failure. Restore the exact block before moving on. Run `node --test --test-name-pattern="saved native floor" browser-first/test/dsh-native-policy.test.mjs` separately for the native-floor mutant, so an earlier install assertion cannot mask saved-load coverage. It must fail the enabled/owner/generation assertions; unchanged grants or a catch/reset result are invalid evidence. Check installation, slot and operation denial assertions separately. Do not use the `agent-runtime`/`network` omissions to claim coverage of the additional native floor: the SDK already rejects those. For slot denial use a fresh, fully declared manifest with only filesystem or shell ungranted; skip the earlier missing-manifest install assertion so it cannot stop the test. For operation denial directly evaluate `evaluateHarnessPolicy` on that manifest/grant pair before any revocation (no hard-stop or generation change): `disabledOperations` must include every runtime operation. Removing the native floor makes that list empty because this test's `native()` fixture derives runtime/tool dependencies from the plugin, not the separate generated native example. Run saved-load cases separately as above.
- [ ] **Commit:**

```bash
git add src/core/contracts.ts packages/addon-sdk/src/validation.ts browser-first/host/harness-policy.mjs browser-first/host/harness-examples/deepseek-harness-native.json browser-first/test/dsh-native-policy.test.mjs
git commit -m "feat(harness): declare governed native DSH authentication"
```

### Task 2: Validate native configuration, installation, home and boot output

**Files:**
- Create: `browser-first/host/dsh-runtime.mjs`
- Create/test: `browser-first/test/dsh-native-runtime.test.mjs`
- Modify: `docs/architecture/MODULE-OWNERSHIP.md`

**Interfaces:**
- Consumes: `fs` implementing Node promises `lstat`, `realpath`, `readlink`, `readdir`, `readFile`, `mkdir`, `open`, `unlink`; trusted dependency injection only.
- Produces: `snapshotDshConfig({bindings, env, userRoot, platform?, home?, repository?}) -> null | config`; `validateDshPrefix(prefix, {fs?, deadline, now?}) -> Promise<{entry, version, count, depth}>`; `prepareDshHome(config, {fs?}) -> Promise<{cwd, env, release(exited:boolean):Promise<void>}>`; `createDshAnnouncement({endpoint,onToken,onFailure}) -> {write(chunk),end(),ready()}`. No export accepts a manifest-controlled executable or command.

- [ ] **Write failing tests** in `browser-first/test/dsh-native-runtime.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { snapshotDshConfig, validateDshPrefix, createDshAnnouncement } from '../host/dsh-runtime.mjs';
const binding = { name: 'dsh.native', addonId: 'addon.deepseek-harness-native', adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081', source: { managedDsh: true } };
test('configuration is native-only, absolute and singular', () => {
  const badEnv = new Proxy({}, { get() { throw new Error('native settings read without binding'); } });
  assert.equal(snapshotDshConfig({ bindings: [], env: badEnv }), null);
  const config = snapshotDshConfig({ bindings: [binding], env: {}, userRoot: '/safe/user', home: '/safe/os', repository: '/repo', platform: 'linux' });
  assert.equal(config.prefix, '');
  assert.equal(config.dshHome, '/safe/user/BrowserFirst/Harnesses/dsh-native');
  for (const change of [
    { bindings: [binding, { ...binding, name: 'another' }] },
    { bindings: [{ ...binding, source: { managedDsh: true, env: 'KEY' } }] },
    { bindings: [{ ...binding, authScheme: 'bearer' }] },
    { bindings: [{ ...binding, adapterId: 'openai-compatible-v1' }] },
    { bindings: [{ ...binding, endpoint: 'http://127.0.0.1:3081/' }] },
    { platform: 'win32' }, { env: { RESONANTOS_DSH_PACKAGE_ROOT: 'relative' } },
    { env: { RESONANTOS_DSH_HOME: 'relative' } },
  ]) assert.throws(() => snapshotDshConfig({ bindings: [binding], env: {}, userRoot: '/safe/user', platform: 'linux', ...change }), /Invalid native DSH configuration/);
});
function tree() {
  const nodes = new Map();
  const dir = path => nodes.set(path, { kind: 'dir', mode: 0o755, uid: 0 });
  for (const path of ['/', '/safe', '/safe/p', '/safe/p/node_modules', '/safe/p/node_modules/@deepseek-ai', '/safe/p/node_modules/@deepseek-ai/dsh', '/safe/p/node_modules/@deepseek-ai/dsh/lib', '/safe/p/node_modules/.bin', '/safe/p/node_modules/js-yaml', '/safe/p/node_modules/js-yaml/bin']) dir(path);
  const file = (path, text = '') => nodes.set(path, { kind: 'file', mode: 0o644, uid: 0, text });
  file('/safe/p/node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }));
  file('/safe/p/node_modules/@deepseek-ai/dsh/lib/bin.js');
  file('/safe/p/node_modules/js-yaml/bin/js-yaml.js');
  nodes.set('/safe/p/node_modules/.bin/js-yaml', { kind: 'link', mode: 0o777, uid: 0, target: '../js-yaml/bin/js-yaml.js' });
  const get = path => { if (!nodes.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return nodes.get(path); };
  const fs = {
    realpath: async path => { get(path); return path; },
    lstat: async path => { const row = get(path); return { ...row, isDirectory: () => row.kind === 'dir', isFile: () => row.kind === 'file', isSymbolicLink: () => row.kind === 'link' }; },
    readlink: async path => get(path).target,
    readFile: async path => get(path).text,
    readdir: async path => [...nodes.keys()].filter(key => key !== path && key.slice(0, key.lastIndexOf('/')) === (path === '/' ? '' : path)).map(key => key.slice(key.lastIndexOf('/') + 1)),
  };
  return { nodes, fs, dir, file };
}
test('walk includes hoisted dependencies, contained npm links and every ancestor', async () => {
  const t = tree(); const result = await validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity });
  assert.equal(result.version, '0.2.0-rc.2'); assert.equal(result.count, t.nodes.size - 2);
  for (const path of ['/', '/safe', '/safe/p', '/safe/p/node_modules/js-yaml/bin/js-yaml.js']) {
    for (const bits of [0o020, 0o002]) {
      const old = t.nodes.get(path).mode; t.nodes.get(path).mode |= bits;
      await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { code: 'runtime-unavailable' });
      t.nodes.get(path).mode = old;
    }
  }
  await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: 0, now: () => 1 }), { code: 'deadline-exceeded' });
});
test('prefix escape fixtures exist and fail containment, not ENOENT', async () => {
  const link = '/safe/p/node_modules/.bin/js-yaml';
  for (const target of ['/outside/ok.js', '../../../outside/ok.js', '/safe/p-neighbor/ok.js', '../../../outside/back']) {
    const t = tree(); t.dir('/outside'); t.file('/outside/ok.js');
    t.dir('/safe/outside'); t.file('/safe/outside/ok.js');
    t.dir('/safe/p-neighbor'); t.file('/safe/p-neighbor/ok.js');
    // The final target is inside, but the intermediate hop escapes the prefix.
    t.nodes.set('/safe/outside/back', { kind: 'link', mode: 0o777, uid: 0, target: '/safe/p/node_modules/js-yaml/bin/js-yaml.js' });
    t.nodes.get(link).target = target;
    let missing = 0;
    const lstat = t.fs.lstat;
    t.fs.lstat = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') missing++; throw error; } };
    await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { code: 'runtime-unavailable', reason: 'package' });
    assert.equal(missing, 0, 'all escape hops must exist and have safe ownership/modes');
  }
});
test('prefix rejects dangling links separately from containment', async () => {
  const t = tree(); t.nodes.get('/safe/p/node_modules/.bin/js-yaml').target = '../missing';
  await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { code: 'runtime-unavailable' });
});
test('prefix rejects link cycles promptly and directory ancestry cycles', async () => {
  const t = tree(), a = '/safe/p/node_modules/.bin/js-yaml', b = '/safe/p/node_modules/.bin/back';
  t.nodes.get(a).target = 'back';
  t.nodes.set(b, { kind: 'link', mode: 0o777, uid: 0, target: 'js-yaml' });
  let reads = 0; const readlink = t.fs.readlink;
  t.fs.readlink = async path => { if (++reads > 4) throw new Error('test cycle watchdog'); return readlink(path); };
  await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { code: 'runtime-unavailable', reason: 'package' });
  assert.equal(reads, 2, 'seen-path guard must reject before the watchdog; a caught watchdog is not cycle proof');
  const d = tree(); d.nodes.get(a).target = '..';
  await assert.rejects(validateDshPrefix('/safe/p', { fs: d.fs, deadline: Infinity }), { code: 'runtime-unavailable', reason: 'package' });
});
test('fixed inclusive count and depth limits refuse partial validation', async () => {
  const t = tree();
  while (t.nodes.size - 2 < 50000) t.file(`/safe/p/f${t.nodes.size}`);
  assert.equal((await validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity })).count, 50000);
  t.file('/safe/p/overflow');
  await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }), { reason: 'limit' });
  const d = tree(); let path = '/safe/p';
  for (let i = 0; i < 64; i++) { path += '/d'; d.dir(path); }
  assert.equal((await validateDshPrefix('/safe/p', { fs: d.fs, deadline: Infinity })).depth, 64);
  d.file(path + '/overflow');
  await assert.rejects(validateDshPrefix('/safe/p', { fs: d.fs, deadline: Infinity }), { reason: 'limit' });
});
test('announcement is incremental, bounded, exact and silent', () => {
  const token = randomBytes(32).toString('base64url'), tokens = [], errors = [];
  const p = createDshAnnouncement({ endpoint: binding.endpoint, onToken: value => tokens.push(value), onFailure: value => errors.push(value) });
  const line = Buffer.from(`banner é\ndsh web: ${binding.endpoint}/?token=${token}\r\n`);
  for (const byte of line) p.write(Buffer.from([byte]));
  p.write(Buffer.from(`warning\ndsh web: ${binding.endpoint}/?token=${token}\n`));
  assert.deepEqual(tokens, [token]); assert.equal(errors.length, 0);
  p.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=other\n`));
  assert.equal(errors.length, 1); assert.ok(!JSON.stringify(errors).includes(token));
  for (const line of ['dsh web: http://evil.test:3081/?token=x\n', 'dsh web: http://127.0.0.1:3082/?token=x\n', `dsh web: ${binding.endpoint}/?token=x&token=x\n`, `dsh web: ${binding.endpoint}/?token=%00\n`, 'x'.repeat(16385)]) {
    let failed = false;
    const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failed = true; } });
    parser.write(Buffer.from(line)); assert.equal(failed, true);
  }
  let eof = false;
  createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { eof = true; } }).end();
  assert.equal(eof, true);
});
import { prepareDshHome } from '../host/dsh-runtime.mjs';
function homeTree() {
  const t = tree();
  t.fs.mkdir = async path => {
    if (t.nodes.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    t.nodes.set(path, { kind: 'dir', mode: 0o700, uid: process.getuid() });
  };
  t.fs.open = async (path, flags, mode) => {
    assert.equal(flags, 'wx');
    if (t.nodes.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    const row = { kind: 'file', uid: process.getuid(), mode, text: '' }; t.nodes.set(path, row);
    return { writeFile: async text => { row.text = text; }, close: async () => {} };
  };
  t.fs.unlink = async path => { t.nodes.delete(path); };
  const config = snapshotDshConfig({ bindings: [binding], env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', DEEPSEEK_API_KEY: 'synthetic-provider', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'http://bad.invalid', OPENAI_API_KEY: 'not-forwarded', DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY' }, userRoot: '/safe/os/ResonantOS_User', home: '/safe/os', repository: '/safe/repo', platform: 'linux' });
  return { ...t, config };
}
test('managed home protects exact OS home and both DSH subtrees, permits dedicated sibling/default', async () => {
  const blocked = ['/safe/os', '/safe/os/.dsh', '/safe/os/.dsh/empty', '/safe/os/Library/Application Support/Augmentor/data/augmentor/managed-dsh/home', '/safe/os/Library/Application Support/Augmentor/data/augmentor/managed-dsh/home/empty', '/safe/repo/empty'];
  for (const dshHome of blocked) { const t = homeTree(); await assert.rejects(prepareDshHome({ ...t.config, dshHome }, { fs: t.fs }), { reason: 'home' }); }
  for (const custom of [undefined, '/safe/os/.dsh-neighbor']) {
    const t = homeTree(), config = { ...t.config, ...(custom ? { dshHome: custom } : {}) };
    const home = await prepareDshHome(config, { fs: t.fs });
    assert.equal(home.env.DSH_HOME, config.dshHome); assert.equal(home.env.DSH_TELEMETRY_MODE, 'DISABLED');
    assert.deepEqual(Object.keys(home.env).sort(), ['LANG', 'LC_ALL', 'TZ', 'DEEPSEEK_API_KEY', 'HOME', 'DSH_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'PATH', 'DSH_TELEMETRY_MODE'].sort());
    const marker = t.nodes.get(config.dshHome + '/.resonantos/owner.json');
    assert.equal(marker.mode, 0o600); assert.deepEqual(Object.keys(JSON.parse(marker.text)).sort(), ['binding', 'userRoot', 'version']);
    await assert.rejects(prepareDshHome(config, { fs: t.fs }), { reason: 'home' });
    await home.release(false); assert.ok(t.nodes.has(config.dshHome + '/.resonantos/lock'));
    await home.release(true); assert.ok(!t.nodes.has(config.dshHome + '/.resonantos/lock'));
    const reopened = await prepareDshHome(config, { fs: t.fs }); await reopened.release(true);
  }
});
test('managed state rejects adoption, symlinks, loose permissions, wrong identity and dirty cwd', async () => {
  const mutate = [
    (t, root) => t.nodes.set(root + '/.resonantos/home', { kind: 'link', mode: 0o777, uid: process.getuid(), target: '/safe/os' }),
    (t, root) => { t.nodes.get(root).mode = 0o755; },
    (t, root) => { t.nodes.get(root).uid = process.getuid() + 1; },
    (t, root) => { t.nodes.get(root + '/.resonantos/owner.json').mode = 0o644; },
    (t, root) => { t.nodes.get(root + '/.resonantos/owner.json').text = JSON.stringify({ version: 1, binding: 'other', userRoot: '/safe/os/ResonantOS_User' }); },
    (t, root) => t.file(root + '/.resonantos/cwd/unrelated'),
    (t, root) => t.nodes.delete(root + '/.resonantos/owner.json'),
  ];
  for (const change of mutate) {
    const t = homeTree(), root = t.config.dshHome; const home = await prepareDshHome(t.config, { fs: t.fs }); await home.release(true);
    change(t, root); await assert.rejects(prepareDshHome(t.config, { fs: t.fs }), { reason: 'home' });
  }
  const foreign = homeTree(); await foreign.fs.mkdir('/safe/foreign'); foreign.file('/safe/foreign/state');
  await assert.rejects(prepareDshHome({ ...foreign.config, dshHome: '/safe/foreign' }, { fs: foreign.fs }));
});
test('prefix ownership, special files, package identity and strict semver are checked', async () => {
  for (const change of [
    t => { t.nodes.get('/safe').uid = process.getuid() + 1; },
    t => { t.nodes.get('/safe/p/node_modules/.bin/js-yaml').uid = process.getuid() + 1; },
    t => { t.nodes.get('/safe/p/node_modules/js-yaml/bin/js-yaml.js').kind = 'fifo'; },
    t => { t.nodes.get('/safe/p/node_modules/@deepseek-ai/dsh/package.json').text = '{'; },
    t => { t.nodes.get('/safe/p/node_modules/@deepseek-ai/dsh/package.json').text = JSON.stringify({ name: 'wrong', version: '0.2.0' }); },
  ]) { const t = tree(); change(t); await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity })); }
  for (const version of ['0.0.9', '0.3.0', '1.0.0', '0.2', '0.2.0-01', '0.2.0;rm']) {
    const t = tree(); t.nodes.get('/safe/p/node_modules/@deepseek-ai/dsh/package.json').text = JSON.stringify({ name: '@deepseek-ai/dsh', version });
    await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }));
  }
});
test('native version policy admits only the reviewed exact package', async () => {
  for (const version of ['0.1.5-rc.1', '0.1.7-rc.2', '0.1.9', '0.2.0', '0.2.1', '0.2.0-rc.2+unreviewed']) {
    const t = tree(); t.nodes.get('/safe/p/node_modules/@deepseek-ai/dsh/package.json').text = JSON.stringify({ name: '@deepseek-ai/dsh', version });
    await assert.rejects(validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity }),
      { code: 'runtime-unavailable', reason: 'package', message: 'Runtime unavailable.' }, version);
  }
  const t = tree(); assert.equal((await validateDshPrefix('/safe/p', { fs: t.fs, deadline: Infinity })).version, '0.2.0-rc.2');
});
for (const together of [true, false]) test(`announcement ${together ? 'same-write' : 'later-write'} conflict blocks readiness`, () => {
  const first = `dsh web: ${binding.endpoint}/?token=synthetic\n`;
  const conflict = `dsh web: ${binding.endpoint}/?token=other\n`;
  const tokens = [], errors = [];
  const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken: value => tokens.push(value), onFailure: error => errors.push(error) });
  if (together) parser.write(Buffer.from(first + conflict));
  else { parser.write(Buffer.from(first)); parser.write(Buffer.from(conflict)); }
  assert.deepEqual(tokens, ['synthetic']);
  assert.equal(errors.length, 1, together ? 'same-write conflict blocks readiness' : 'later-write conflict blocks readiness');
  parser.ready(); // No later write/end may be needed to discover the conflict.
});
test('announcement wrong origin retains the fixed port failure reason', () => {
  const errors = [];
  const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure: error => errors.push(error) });
  parser.write(Buffer.from('dsh web: http://127.0.0.1:3082/?token=synthetic\n'));
  assert.equal(errors[0]?.reason, 'port');
});
test('announcement EOF after a valid line permits later protocol Ready', () => {
  for (const tail of ['', 'ordinary trailing warning']) {
    const tokens = [], errors = [];
    const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken: t => tokens.push(t), onFailure: e => errors.push(e) });
    parser.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=synthetic\n${tail}`)); parser.end();
    assert.deepEqual(tokens, ['synthetic']); assert.deepEqual(errors, []);
    parser.ready(); assert.deepEqual(errors, []);
  }
  for (const tail of [`dsh web: ${binding.endpoint}/?token=other`, `dsh web: ${binding.endpoint}/?token=other\n`]) {
    let failures = 0;
    const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failures++; } });
    parser.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=synthetic\n`));
    parser.write(Buffer.from(tail)); parser.end(); assert.equal(failures, 1);
  }
});
test('announcement post-token byte budget remains active', () => {
  let failures = 0;
  const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failures++; } });
  parser.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=synthetic\n`));
  for (let i = 0; i < 1024; i++) parser.write(Buffer.from('x'.repeat(1023) + '\n'));
  assert.equal(failures, 1, 'the total limit still applies after token capture');
});
for (const terminated of [false, true]) test(`announcement line limit applies to ${terminated ? 'complete' : 'partial'} banners`, () => {
  const errors = [];
  const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure: error => errors.push(error) });
  parser.write(Buffer.from('x'.repeat(16385) + (terminated ? '\n' : '')));
  assert.equal(errors.length, 1, 'oversized ordinary line is rejected before token parsing');
});
test('announcement total budget, truncated EOF, equivalent authority and post-Ready discard', () => {
  for (const raw of [`dsh web: http://127.0.0.1:03081/?token=x\n`, `dsh web: ${binding.endpoint}/./?token=x\n`, `dsh web: ${binding.endpoint}/?token=${'x'.repeat(8193)}\n`]) {
    let failed = 0; const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failed++; } }); parser.write(Buffer.from(raw)); assert.equal(failed, 1);
  }
  let failed = 0; const parser = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { failed++; } });
  for (let i = 0; i < 1025; i++) parser.write(Buffer.from('x'.repeat(1023) + '\n'));
  assert.equal(failed, 1);
  let truncated = 0; const partial = createDshAnnouncement({ endpoint: binding.endpoint, onToken() { assert.fail('unterminated URL accepted'); }, onFailure() { truncated++; } });
  partial.write(Buffer.from(`dsh web: ${binding.endpoint}/?token=x`)); partial.end(); assert.equal(truncated, 1);
  const ready = createDshAnnouncement({ endpoint: binding.endpoint, onToken() {}, onFailure() { assert.fail('post-ready output parsed'); } });
  ready.ready(); ready.write(Buffer.alloc(1048577, 120)); ready.end();
});

```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-runtime.test.mjs`. Initially the module is missing. After adding the exports, record behavioral failures with each guard removed, as specified below.
- [ ] **Minimal implementation:** create `browser-first/host/dsh-runtime.mjs` with this complete validation/parser portion. Task 3 appends the process owner.

```js
import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { publicHarnessError } from './harness-adapter-contract.mjs';
const configurationError = 'Invalid native DSH configuration. Check the native binding and DSH settings, then restart the bridge.';
const runtimeError = (code = 'runtime-unavailable', reason = 'startup') => Object.assign(new Error(publicHarnessError({ code }).message), { code, reason });
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
const own = stat => [0, process.getuid()].includes(stat.uid);
const safeNode = stat => own(stat) && !(stat.mode & 0o022) && (stat.isDirectory() || stat.isFile());
export function snapshotDshConfig({ bindings = [], env = process.env, userRoot, platform = process.platform, home = homedir(), repository = resolve(import.meta.dirname, '../..') } = {}) {
  const native = bindings.filter(b => b?.authScheme === 'dsh-native-cookie');
  const refuse = () => { throw new Error(configurationError); };
  if (bindings.some(b => b?.authScheme !== 'dsh-native-cookie' && b?.source && Object.hasOwn(b.source, 'managedDsh'))) refuse();
  if (!native.length) return null;
  if (native.length !== 1 || !['darwin', 'linux'].includes(platform)) refuse();
  const binding = structuredClone(native[0]);
  if (!['name', 'addonId', 'adapterId', 'authScheme', 'endpoint'].every(k => typeof binding[k] === 'string' && binding[k]) || binding.adapterId !== 'dsh-typert-v1' || !binding.source || Object.keys(binding.source).length !== 1 || binding.source.managedDsh !== true) refuse();
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(binding.endpoint);
  if (!match || +match[1] < 1024 || +match[1] > 65535) refuse();
  const prefix = env.RESONANTOS_DSH_PACKAGE_ROOT ?? '';
  const configuredHome = env.RESONANTOS_DSH_HOME ?? '';
  if ([prefix, configuredHome].some(p => typeof p !== 'string' || (p && !isAbsolute(p))) || !isAbsolute(userRoot)) refuse();
  const inherited = {};
  for (const k of ['LANG', 'LC_ALL', 'TZ', 'DEEPSEEK_API_KEY']) if (typeof env[k] === 'string') inherited[k] = env[k];
  return Object.freeze({ binding, prefix, dshHome: configuredHome || join(userRoot, 'BrowserFirst/Harnesses/dsh-native'), userRoot, home, repository, inherited: Object.freeze(inherited), port: +match[1] });
}
export async function validateDshPrefix(prefix, { fs = filesystem, deadline, now = Date.now } = {}) {
  const check = () => { if (now() >= deadline) throw runtimeError('deadline-exceeded', 'deadline'); };
  try {
    check(); if (!prefix || !isAbsolute(prefix)) throw runtimeError('runtime-unavailable', 'package');
    const root = await fs.realpath(prefix); check();
    for (let p = root; ; p = dirname(p)) {
      const stat = await fs.lstat(p); check();
      if (!stat.isDirectory() || !safeNode(stat)) throw runtimeError('runtime-unavailable', 'package');
      if (p === '/') break;
    }
    let count = 0, depth = 0;
    const counted = new Set(), visited = new Set();
    function bound(path) {
      if (!inside(root, path)) throw runtimeError('runtime-unavailable', 'package');
      const d = relative(root, path).split(sep).filter(Boolean).length;
      depth = Math.max(depth, d); if (d > 64) throw runtimeError('runtime-unavailable', 'limit');
    }
    async function target(path, seen = new Set()) {
      bound(path); check();
      if (seen.has(path)) throw runtimeError('runtime-unavailable', 'package');
      seen.add(path);
      const components = relative(root, path).split(sep).filter(Boolean);
      let current = root;
      for (let i = 0; i < components.length; i++) {
        current = join(current, components[i]); bound(current);
        const stat = await fs.lstat(current); check();
        if (stat.isSymbolicLink()) {
          if (!own(stat)) throw runtimeError('runtime-unavailable', 'package');
          const link = resolve(dirname(current), await fs.readlink(current)); check(); bound(link);
          const resolved = await target(link, new Set(seen));
          return target(join(resolved, ...components.slice(i + 1)), new Set(seen));
        }
        if (!safeNode(stat) || (i < components.length - 1 && !stat.isDirectory())) throw runtimeError('runtime-unavailable', 'package');
      }
      return current;
    }
    async function walk(path, ancestry = new Set()) {
      check(); bound(path);
      if (counted.has(path)) return;
      counted.add(path); if (++count > 50000) throw runtimeError('runtime-unavailable', 'limit');
      const stat = await fs.lstat(path); check();
      if (stat.isSymbolicLink()) {
        if (!own(stat)) throw runtimeError('runtime-unavailable', 'package');
        const end = await target(path); if (ancestry.has(end)) throw runtimeError('runtime-unavailable', 'package'); await walk(end, ancestry); return;
      }
      if (!safeNode(stat)) throw runtimeError('runtime-unavailable', 'package');
      if (stat.isDirectory() && !visited.has(path)) {
        visited.add(path);
        for (const name of await fs.readdir(path)) await walk(join(path, name), new Set([...ancestry, path]));
      }
    }
    await walk(root);
    const metadataPath = await target(join(root, 'node_modules/@deepseek-ai/dsh/package.json'));
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); check();
    const semver = /^(0)\.(1|2)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
    if (metadata.name !== '@deepseek-ai/dsh' || typeof metadata.version !== 'string' || !semver.test(metadata.version)) throw runtimeError('runtime-unavailable', 'package');
    // Recorded conductor outcome: native eligibility is exact, not the semver candidate range.
    if (metadata.version !== '0.2.0-rc.2') throw runtimeError('runtime-unavailable', 'package');
    const entry = await target(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
    if (!(await fs.lstat(entry)).isFile()) throw runtimeError('runtime-unavailable', 'package');
    check(); return { entry, version: metadata.version, count, depth };
  } catch (error) {
    if (error?.reason) throw error;
    throw runtimeError('runtime-unavailable', 'package');
  }
}
export async function prepareDshHome(config, { fs = filesystem } = {}) {
  try {
    const requested = resolve(config.dshHome);
    async function normalized(path) {
      try { return await fs.realpath(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return join(await normalized(dirname(path)), basename(path)); }
    }
    const path = await normalized(requested), userRoot = await normalized(resolve(config.userRoot));
    const realHome = await normalized(config.home), repository = await normalized(config.repository);
    if (path === realHome || inside(repository, path) || inside(await normalized(join(realHome, '.dsh')), path) || inside(await normalized(join(realHome, 'Library/Application Support/Augmentor/data/augmentor/managed-dsh/home')), path)) throw runtimeError();
    // Inspect every managed path component. Never chmod existing state into compliance.
    let current = '/';
    for (const part of requested.split('/').filter(Boolean)) {
      current = join(current, part);
      try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw runtimeError(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(current, { mode: 0o700 }); }
    }
    const stat = await fs.lstat(path);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw runtimeError();
    const reserved = join(path, '.resonantos'), marker = join(reserved, 'owner.json');
    const expected = JSON.stringify({ version: 1, binding: config.binding.name, userRoot });
    const names = await fs.readdir(path);
    if (names.length) {
      const r = await fs.lstat(reserved), m = await fs.lstat(marker);
      if (!r.isDirectory() || r.isSymbolicLink() || r.uid !== process.getuid() || (r.mode & 0o077) || !m.isFile() || m.isSymbolicLink() || m.uid !== process.getuid() || (m.mode & 0o077) || await fs.readFile(marker, 'utf8') !== expected) throw runtimeError();
    } else {
      await fs.mkdir(reserved, { mode: 0o700 });
      const file = await fs.open(marker, 'wx', 0o600);
      try { await file.writeFile(expected); } finally { await file.close(); }
    }
    const lockPath = join(reserved, 'lock'), nonce = randomUUID();
    const lockText = JSON.stringify({ pid: process.pid, nonce });
    const lock = await fs.open(lockPath, 'wx', 0o600);
    try { await lock.writeFile(lockText); } finally { await lock.close(); }
    let released = false;
    async function release(exited) {
      if (released || !exited) return;
      if (await fs.readFile(lockPath, 'utf8') !== lockText) throw runtimeError();
      await fs.unlink(lockPath); released = true;
    }
    try {
      for (const part of ['home', 'home/config', 'home/data', 'home/state', 'home/cache', 'tmp', 'cwd']) {
        const dir = join(reserved, part);
        try { await fs.mkdir(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const s = await fs.lstat(dir);
        if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw runtimeError();
      }
      if ((await fs.readdir(join(reserved, 'cwd'))).length) throw runtimeError();
      return { cwd: join(reserved, 'cwd'), release, env: {
        ...config.inherited, HOME: join(reserved, 'home'), DSH_HOME: path, TMPDIR: join(reserved, 'tmp'),
        XDG_CONFIG_HOME: join(reserved, 'home/config'), XDG_DATA_HOME: join(reserved, 'home/data'),
        XDG_STATE_HOME: join(reserved, 'home/state'), XDG_CACHE_HOME: join(reserved, 'home/cache'),
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, DSH_TELEMETRY_MODE: 'DISABLED',
      } };
    } catch (error) { await release(true); throw error; }
  } catch { throw runtimeError('runtime-unavailable', 'home'); }
}
export function createDshAnnouncement({ endpoint, onToken, onFailure }) {
  const decoder = new StringDecoder('utf8'); let pending = '', total = 0, token, done = false, failed = false;
  function reject(reason = 'startup') { if (!failed && !done) { failed = true; pending = ''; onFailure(runtimeError('runtime-unavailable', reason)); } }
  return {
    write(chunk) {
      if (done || failed) return;
      total += Buffer.byteLength(chunk); if (total > 1048576) { reject(); return; }
      pending += decoder.write(chunk);
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n'), raw = pending.slice(0, end); pending = pending.slice(end + 1);
        if (Buffer.byteLength(raw) > 16384) { reject(); return; }
        const line = raw.replace(/\r$/, ''); if (!line.startsWith('dsh web: ')) continue;
        try {
          const rawUrl = line.slice(9), url = new URL(rawUrl);
          if (url.origin !== endpoint) { reject('port'); return; }
          if (!rawUrl.startsWith(endpoint + '/?token=') || url.pathname !== '/' || url.username || url.password || url.hash || [...url.searchParams.keys()].join(',') !== 'token' || rawUrl !== rawUrl.trim()) throw runtimeError();
          const value = url.searchParams.get('token');
          if (!/^[A-Za-z0-9._~-]{1,8192}$/.test(value)) throw runtimeError();
          if (token !== undefined && value !== token) throw runtimeError();
          if (token === undefined) { token = value; onToken(value); }
        } catch { reject(); return; }
      }
      if (Buffer.byteLength(pending) > 16384) reject();
    },
    end() {
      if (done || failed) return;
      pending += decoder.end();
      if (token === undefined || pending.startsWith('dsh web: ')) reject();
      pending = ''; // EOF after a valid line is allowed; readiness is still separate.
    },
    ready() { done = true; pending = ''; token = undefined; },
  };
}
```

- [ ] **Update ownership in this task.** Add this row to the Browser-First ownership table, directly before the existing harness credentials row:

```markdown
| `browser-first/host/dsh-runtime.mjs` | Native configuration, prefix/home validation, boot parser and child epochs | Operator settings and pending authorization signals | Private home/lock, owned child handles and memory-only boot token | Grants, HTTP/RPC, desktop discovery, foreign processes or PID recovery |
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-runtime.test.mjs` and `node --test --test-concurrency=1 scripts/module-ownership-doc.test.mjs`.
- [ ] **Guard red evidence:** independently remove native-only settings gate; native-count check; platform check; source exactness; endpoint validation; absolute-path check; ancestor loop; ownership/mode predicates; file-kind predicate; count ceiling; depth ceiling; deadline check. Use the relevant otherwise-valid fixture; for the ancestor-only mutant use `/` or `/safe`, not the prefix that the tree walk rechecks. Remove ownership/mode/file-kind terms from the shared predicates, not one of several call sites. Keep valid package metadata so version refusal cannot mask filesystem mutants. For symlink containment run the existing-target escape test alone; deleting only `bound`'s `inside` rejection must resolve and fail `assert.rejects`. Mutate `seen.has(path)` and `ancestry.has(end)` separately: the former fails the read-count assertion, the latter `assert.rejects`.
- [ ] **Version-policy red evidence:** remove only the exact `metadata.version !== '0.2.0-rc.2'` refusal and run `native version policy admits only the reviewed exact package`; valid 0.1.x metadata now resolves, failing `assert.rejects`. The semver grammar remains a separate guard: isolate it by allowing the test version through the exact policy in both baseline and mutant, then remove only the semver predicate; malformed semver must resolve only in the mutant. Do not claim a semver mutant killed while exact-version refusal still masks it.
- [ ] **Announcement red evidence:** remove the origin comparison and require the new `reason === 'port'` assertion to fail (`startup` from the remaining URL-shape check is insufficient). Remove token grammar and use `%00`; remove conflict comparison and run the separately named same-write/later-write conflict tests. For continued scanning, add closure state `let captured = false`, change the entry guard to `if (done || failed || captured) return;`, and set `captured = true; return;` immediately after `onToken(value)` in the first-capture branch. This disables every later write and the remainder of the capture write until Ready. The later-write conflict assertion sees zero failures instead of one; the post-token total-budget assertion likewise sees zero. Run the named later-write and post-token-budget tests separately so an earlier conflict failure cannot mask either assertion. Separately add only `return;` after `onToken(value)` without the flag: the **same-write** conflict assertion must go red because the unparsed conflict remains buffered until `ready()` clears it. This single-call mutant does not prove later-write coverage. Remove each line/total bound using an ordinary banner exceeding that bound (include both complete and partial overlong lines); remove missing-token/truncated-EOF checks and restore unconditional EOF rejection separately. Require the respective count/EOF assertions to fail. Restore each mutant before proceeding; an import failure is not evidence.
- [ ] **Commit:**

```bash
git add browser-first/host/dsh-runtime.mjs browser-first/test/dsh-native-runtime.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(harness): validate native DSH installation and isolated state"
```

### Task 3: Own one child, deadline and confirmed-stop clock

**Files:**
- Modify: `browser-first/host/dsh-runtime.mjs`
- Modify/test: `browser-first/test/dsh-native-runtime.test.mjs`

**Interfaces:**
- Consumes: Task 2 functions; Node `spawn`; a trusted `beforeStop(epoch, cleanupSignal) -> Promise<void>` callback and synchronous `onFailure({epoch,code})` notification.
- Produces: `createDshRuntime({config,spawnImpl?,validatePrefix?,prepareHome?,reservePort?,now?,onFailure?,beforeStop?,log?}) -> { acquire({signal}):Promise<runtimeLease>, close():Promise<void> }`.
- `runtimeLease` is `{epoch, signal, deadline, version, use(callback), ready(), fail(code?), release()}`. `use(callback)` supplies only `{endpoint,loginToken,providerKey}` to host credentials. `signal` is the epoch lifetime. `ready()` is called only by composition after authentication and validated protocol readiness. `release()` is idempotent and returns the stop promise when last. No public projection includes the lease.

- [ ] **Append failing lifecycle tests:**

```js
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDshRuntime } from '../host/dsh-runtime.mjs';
function lifecycle(overrides = {}) {
  const children = [], calls = [], releases = [], failures = [];
  const config = snapshotDshConfig({ bindings: [binding], env: { DEEPSEEK_API_KEY: 'generated-test-provider', NODE_OPTIONS: '--inspect', DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY' }, userRoot: '/safe/user', platform: 'linux' });
  const runtime = createDshRuntime({ config,
    validatePrefix: async () => ({ entry: '/safe/p/node_modules/@deepseek-ai/dsh/lib/bin.js', version: '0.2.0-rc.2' }),
    prepareHome: async () => ({ cwd: '/safe/cwd', env: { HOME: '/safe/home', DSH_HOME: '/safe/dsh', DSH_TELEMETRY_MODE: 'DISABLED' }, release: async exited => releases.push(exited) }),
    reservePort: async () => {}, onFailure: event => failures.push(event),
    spawnImpl(file, argv, options) {
      calls.push({ file, argv, options });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
      child.signals = []; child.kill = signal => { child.signals.push(signal); queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); }); return true; };
      children.push(child);
      queueMicrotask(() => child.stdout.write(`dsh web: ${binding.endpoint}/?token=${randomBytes(32).toString('base64url')}\n`));
      return child;
    },
    log() {}, ...overrides,
  });
  return { runtime, children, calls, releases, failures };
}
test('two authorized leases share one child and only final release stops it', async () => {
  const f = lifecycle(), a = new AbortController(), b = new AbortController();
  assert.equal(f.calls.length, 0);
  const [one, two] = await Promise.all([f.runtime.acquire({ signal: a.signal }), f.runtime.acquire({ signal: b.signal })]);
  assert.equal(one.epoch, two.epoch); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, process.execPath);
  assert.deepEqual(f.calls[0].argv.slice(1), ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '3081']);
  assert.equal(f.calls[0].options.shell, false);
  assert.deepEqual(f.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  const oldExitHandler = f.children[0].listeners('exit')[0];
  assert.equal(typeof oldExitHandler, 'function');
  one.ready(); await one.release(); assert.equal(f.children[0].signals.length, 0);
  await two.release(); assert.deepEqual(f.children[0].signals, ['SIGTERM']); assert.deepEqual(f.releases, [true]);
  await assert.rejects(one.use(() => true));
  const three = await f.runtime.acquire({ signal: new AbortController().signal });
  assert.notEqual(three.epoch, one.epoch); three.ready();
  const replacement = f.children[1], replacementToken = await three.use(value => value.loginToken);
  assert.equal(f.children[0].listenerCount('exit'), 0, 'once listener was consumed during stop');
  oldExitHandler(0, null); // Invoke the captured callback itself after replacement.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(three.signal.aborted, false);
  assert.equal(await three.use(value => value.loginToken), replacementToken);
  assert.equal(f.children[1], replacement); assert.deepEqual(replacement.signals, []);
  assert.equal(f.calls.length, 2);
  await f.runtime.close();
});
test('revoked waiter cannot spawn or publish a late lease', async () => {
  const f = lifecycle(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.runtime.acquire({ signal: controller.signal }));
  assert.equal(f.calls.length, 0); await f.runtime.close();
});
test('child exit fences both leases and next explicit acquisition starts a new epoch', async () => {
  const f = lifecycle(); const a = await f.runtime.acquire({ signal: new AbortController().signal }); a.ready();
  f.children[0].exitCode = 1; f.children[0].emit('exit', 1, null);
  assert.equal(a.signal.aborted, true); assert.equal(f.failures.length, 1);
  await assert.rejects(a.use(() => true)); await a.release();
  const b = await f.runtime.acquire({ signal: new AbortController().signal }); b.ready();
  assert.notEqual(a.epoch, b.epoch); await b.release();
});
test('pending authorization is rechecked after validation; one remaining waiter survives', async () => {
  let finish;
  const install = new Promise(resolve => { finish = resolve; });
  const f = lifecycle({ validatePrefix: () => install });
  const a = new AbortController(), b = new AbortController();
  const first = f.runtime.acquire({ signal: a.signal }), rejected = assert.rejects(first);
  const second = f.runtime.acquire({ signal: b.signal });
  await new Promise(resolve => setImmediate(resolve)); a.abort();
  finish({ entry: '/safe/p/bin.js', version: '0.2.0-rc.2' });
  await rejected; const lease = await second; lease.ready(); assert.equal(f.calls.length, 1); await lease.release();
  let finishDenied;
  const denied = lifecycle({ validatePrefix: () => new Promise(resolve => { finishDenied = resolve; }) });
  const controller = new AbortController(), waiting = denied.runtime.acquire({ signal: controller.signal }), refused = assert.rejects(waiting);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  finishDenied({ entry: '/safe/p/bin.js', version: '0.2.0-rc.2' });
  await refused; await new Promise(resolve => setImmediate(resolve));
  assert.equal(denied.calls.length, 0); await denied.runtime.close();
});
test('one stop clock escalates by 1s/2s/3s and retains lock on unconfirmed exit', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = lifecycle({ beforeStop: () => new Promise(() => {}) });
  const lease = await f.runtime.acquire({ signal: new AbortController().signal }); lease.ready();
  const child = f.children[0], signals = [];
  child.kill = signal => { signals.push({ signal, at: Date.now() }); return true; };
  const stop = lease.release(); assert.equal(lease.signal.aborted, true);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush(); t.mock.timers.tick(1000); await flush();
  assert.deepEqual(signals, [{ signal: 'SIGTERM', at: 2000 }]);
  t.mock.timers.tick(1000); await flush(); assert.equal(signals[1].signal, 'SIGKILL'); assert.equal(signals[1].at, 3000);
  t.mock.timers.tick(1000); await flush(); await stop;
  assert.equal(f.releases.length, 0);
  await assert.rejects(f.runtime.acquire({ signal: new AbortController().signal })); assert.equal(f.calls.length, 1);
  await f.runtime.close();
});
test('startup deadline includes prefix validation and never spawns after expiry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let finish;
  const f = lifecycle({ validatePrefix: () => new Promise(resolve => { finish = resolve; }) });
  const waiting = f.runtime.acquire({ signal: new AbortController().signal });
  const refused = assert.rejects(waiting, { code: 'deadline-exceeded' });
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(30000);
  finish({ entry: '/safe/p/bin.js', version: '0.2.0-rc.2' });
  await refused; assert.equal(f.calls.length, 0); await f.runtime.close();
});

```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-runtime.test.mjs`. Expected: missing `createDshRuntime`; after adding the export, remove final-lease gating temporarily and observe the two-lease test fail before restoring it.
- [ ] **Minimal implementation:** append the complete process owner:

```js
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
async function reserveDshPort(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch { try { server.close(); } catch {} throw runtimeError('runtime-unavailable', 'port'); }
}
const operatorMessages = Object.freeze({
  package: 'Native DSH install prefix is unavailable or unsupported. Select a dedicated prefix with a supported local package and restart the bridge.',
  limit: 'Native DSH install prefix exceeds the validation limit of 50000 entries or depth 64. Use a smaller dedicated prefix and restart the bridge. No child was started.',
  home: 'Native DSH home is unavailable. Use a dedicated home and inspect any existing owner before retrying.',
  port: 'Native DSH could not use its approved port. Choose another port in both binding and manifest, then restart and reinstall the manifest.',
  deadline: 'Native DSH did not become ready within 30 seconds. Check the package and retry with a new session.',
  startup: 'Native DSH startup or authentication failed. Check the installed version and retry with a new session.',
  exit: 'Native DSH stopped. Send a new chat request or create a new session. The previous turn was not retried.',
  unconfirmed: 'Native DSH exit could not be confirmed. Inspect the owned process before reusing its home or port.',
});
export function createDshRuntime({ config, spawnImpl = spawn, validatePrefix = validateDshPrefix, prepareHome = prepareDshHome, reservePort = reserveDshPort, now = Date.now, onFailure = () => {}, beforeStop = async () => {}, log = value => console.error(JSON.stringify(value)) } = {}) {
  let current = null, closing = false, blocked = false;
  const stops = new Set();
  const wait = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  function transition(record, state, reason = 'startup') {
    record.state = state;
    try { log({ event: 'harness.dsh_native', binding: config.binding.name, state, reason,
      ...(Number.isInteger(record.exitCode) ? { exitCode: record.exitCode } : {}),
      ...(['SIGINT', 'SIGTERM', 'SIGKILL'].includes(record.exitSignal) ? { signal: record.exitSignal } : {}),
      message: operatorMessages[reason] ?? operatorMessages.startup }); } catch {}
  }
  function fence(record, code, reason) {
    if (record.fenced) return;
    record.fenced = true;
    clearTimeout(record.timer);
    record.token = '';
    record.reject?.(runtimeError(code, reason));
    record.controller.abort(runtimeError(code, reason));
    try { onFailure({ epoch: record.epoch, code }); } catch {}
  }
  function stop(record, code = 'runtime-unavailable', reason = 'startup') {
    if (record.stop) return record.stop;
    const start = now(); fence(record, code, reason); transition(record, 'Stopping', reason);
    const cleanup = new AbortController();
    const job = (async () => {
      await Promise.race([Promise.resolve().then(() => beforeStop(record.epoch, cleanup.signal)).catch(() => {}), wait(start + 1000 - now())]);
      cleanup.abort();
      if (record.child && !record.exited) {
        try { record.child.kill('SIGTERM'); } catch {}
        await Promise.race([record.exit, wait(start + 2000 - now())]);
      }
      if (record.child && !record.exited) {
        try { record.child.kill('SIGKILL'); } catch {}
        await Promise.race([record.exit, wait(start + 3000 - now())]);
      }
      if (record.child && !record.exited) { blocked = true; transition(record, 'Failed', 'unconfirmed'); return; }
      // Startup validation may settle after cancellation. Its continuation checks
      // fenced before spawn and releases a subsequently acquired lock itself.
      await record.home?.release(true);
      if (current === record) current = null;
      transition(record, reason === 'exit' ? 'Failed' : 'Stopped', reason);
    })().catch(() => { blocked = true; transition(record, 'Failed', 'unconfirmed'); });
    record.stop = job; stops.add(job); void job.finally(() => stops.delete(job)); return job;
  }
  function active(record) {
    if (current !== record || record.fenced || closing || ![...record.clients].some(client => !client.signal.aborted)) throw record.controller.signal.reason ?? runtimeError();
  }
  function begin() {
    const record = { epoch: randomUUID(), controller: new AbortController(), clients: new Set(), deadline: now() + 30000, child: null, exited: false, token: '', fenced: false };
    current = record;
    record.timer = setTimeout(() => { record.reject?.(runtimeError('deadline-exceeded', 'deadline')); void stop(record, 'deadline-exceeded', 'deadline'); }, 30000);
    // Start on a microtask so acquire registers its first authorized waiter first.
    record.started = Promise.resolve().then(async () => {
      transition(record, 'Starting');
      const install = await validatePrefix(config.prefix, { deadline: record.deadline, now }); active(record);
      record.version = install.version;
      const home = await prepareHome(config); record.home = home;
      try { active(record); } catch (error) { await home.release(true); throw error; }
      await reservePort(config.port); active(record);
      if (now() >= record.deadline) throw runtimeError('deadline-exceeded', 'deadline');
      const announced = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
      record.child = spawnImpl(process.execPath, [install.entry, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(config.port)], { shell: false, cwd: home.cwd, env: home.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const child = record.child;
      record.exit = new Promise(resolve => {
        child.once('exit', (code, signal) => {
          record.exited = true; record.exitCode = code; record.exitSignal = signal; resolve();
          if (current !== record) return;
          // This callback may act on the active epoch only after identity matches.
          // stop is already idempotent for a fenced current epoch.
          record.reject(runtimeError()); void stop(current, 'runtime-unavailable', 'exit');
        });
      });
      child.once('error', () => { record.reject(runtimeError()); void stop(record); });
      if (!child.stdout || !child.stderr) throw runtimeError();
      const parser = createDshAnnouncement({ endpoint: config.binding.endpoint,
        onToken(token) { if (!record.fenced && current === record) { record.token = token; record.resolve(); } },
        onFailure(error) { record.reject(error); void stop(record, error.code, error.reason); },
      });
      record.parser = parser;
      child.stdout.on('data', chunk => parser.write(chunk)); child.stdout.on('end', () => parser.end()); child.stderr.resume();
      await announced; active(record); transition(record, 'Announced'); return record;
    }).catch(async error => { await stop(record, error.code ?? 'runtime-unavailable', error.reason ?? 'startup'); throw runtimeError(error.code, error.reason); });
    record.started.catch(() => {}); return record;
  }
  return Object.freeze({
    async acquire({ signal } = {}) {
      if (!signal || signal.aborted || closing || blocked || !config) throw runtimeError();
      if (current?.stop) await current.stop;
      if (signal.aborted || closing || blocked) throw runtimeError();
      const record = current ?? begin(), client = { signal, released: false };
      record.clients.add(client);
      const release = () => {
        if (client.released) return record.stop ?? Promise.resolve();
        client.released = true; signal.removeEventListener('abort', abort); record.clients.delete(client);
        return record.clients.size ? Promise.resolve() : stop(record);
      };
      let rejectAbort;
      const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
      const abort = () => { rejectAbort(runtimeError()); void release(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await Promise.race([record.started, cancelled]);
        if (signal.aborted || client.released) throw runtimeError(); active(record);
        return Object.freeze({
          epoch: record.epoch, signal: record.controller.signal, deadline: record.deadline, version: record.version,
          async use(callback) { if (client.released || signal.aborted) throw runtimeError(); active(record); return callback({ endpoint: config.binding.endpoint, loginToken: record.token, providerKey: config.inherited.DEEPSEEK_API_KEY }); },
          ready() { active(record); clearTimeout(record.timer); record.parser.ready(); if (record.state !== 'Ready') transition(record, 'Ready'); },
          fail(code = 'runtime-unavailable') { return stop(record, code, code === 'deadline-exceeded' ? 'deadline' : 'startup'); },
          release,
        });
      } catch (error) { await release(); throw error; }
    },
    async close() { closing = true; if (current) stop(current); await Promise.allSettled([...stops]); },
  });
}
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-runtime.test.mjs`.
- [ ] **Red evidence:** replace the shared `active(record)` function with a no-op as one grouped authorization-fence mutant; do not claim that deleting one early call defeats later calls. Hold validation, abort its only waiter, release validation, then flush the continuation with `setImmediate` before asserting zero spawns: the mutant spawns despite cancellation. Keep the one-cancelled/one-live-waiter positive control. For final-lease gating, replace the `record.clients.size` conditional with unconditional `stop(record)`; the two-lease test must fail its zero-signals assertion after the first release. For epoch isolation remove only `if (current !== record) return;`: the captured old exit callback fences the replacement, failing `three.signal.aborted === false`. Re-emitting the consumed once event is not evidence. For unconfirmed cleanup replace that branch's `blocked = true` with `blocked = false; current = null` as one grouped unsafe-reacquisition mutant; the next acquisition now resolves and `assert.rejects` fails. Deleting `blocked` checks alone is masked by the retained fenced current record and is not red evidence. Mutate the TERM/KILL/return deadlines independently and require the fake-clock signal/time assertions to fail; the unchanged branch must retain the lock and refuse relaunch. No process-name/PID cleanup is allowed.
- [ ] **Commit:**

```bash
git add browser-first/host/dsh-runtime.mjs browser-first/test/dsh-native-runtime.test.mjs
git commit -m "feat(harness): own native DSH process epochs and bounded cleanup"
```

### Task 4: Share native credentials across leases and retain late-output redaction

**Files:**
- Modify: `browser-first/host/harness-credentials.mjs`
- Create/test: `browser-first/test/dsh-native-credentials.test.mjs`

**Interfaces:**
- Consumes: `nativeRuntime.acquire({signal}) -> Promise<runtimeLease>` from Task 3; Task 0's reviewed exact-version refresh evidence.
- Produces: extended `createHarnessCredentials({bindings,env,nativeRuntime,refreshPolicy?})`; `acquire({addonId,runtime,signal}) -> Promise<lease>`. Native lease adds `epoch`, `signal`, `deadline`, `version`, `ready()`, `fail(code)`, `authenticate(exchange,{signal,generation?,refresh?})`, async `dispose()`, and `readinessLease() -> lease` with epoch-scoped access and no extra process reference; `use(callback)` supplies `{endpoint,authScheme,loginToken,cookie,generation}` only. `exchange({endpoint,loginToken,signal}) -> Promise<string>` returns one already-validated cookie pair. Plugin lease remains as before.

- [ ] **Write failing tests:**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHarnessCredentials } from '../host/harness-credentials.mjs';
const runtime = { credentialBinding: 'dsh.native', adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081' };
const binding = { name: 'dsh.native', addonId: 'addon.native', adapterId: runtime.adapterId, authScheme: runtime.authScheme, endpoint: runtime.endpoint, source: { managedDsh: true } };
function fixture(refresh = true) {
  const controller = new AbortController(), token = randomBytes(24).toString('base64url'), providerKey = randomBytes(24).toString('base64url');
  let released = 0, failed = 0;
  const nativeRuntime = { async acquire() { return { epoch: 'epoch-1', signal: controller.signal, deadline: Date.now() + 30000, version: '0.2.0-rc.2',
    use: callback => callback({ endpoint: runtime.endpoint, loginToken: token, providerKey }), ready() {},
    fail() { failed++; controller.abort(); }, release() { released++; } }; } };
  const credentials = createHarnessCredentials({ bindings: [binding], nativeRuntime, refreshPolicy: () => refresh });
  return { credentials, token, providerKey, released: () => released, failed: () => failed, controller };
}
test('one exchange and atomic generation across two leases', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const a = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  const b = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  let calls = 0;
  const exchange = async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return `dsh-auth-test=${randomBytes(24).toString('base64url')}`; };
  await Promise.all([a.authenticate(exchange, { signal }), b.authenticate(exchange, { signal })]);
  assert.equal(calls, 1);
  const old = await a.use(value => value.cookie);
  await Promise.all([a.authenticate(exchange, { signal, generation: 1, refresh: true }), b.authenticate(exchange, { signal, generation: 1, refresh: true })]);
  assert.equal(calls, 2);
  await b.authenticate(exchange, { signal, generation: 1, refresh: true }); assert.equal(calls, 2);
  await a.dispose(); await assert.rejects(a.use(() => true));
  assert.equal(await b.use(value => value.generation), 2);
  for (const secret of [old, old.slice(old.indexOf('=') + 1), f.token, f.providerKey, `${runtime.endpoint}/?token=${f.token}`]) {
    for (const text of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]) {
      assert.equal(a.sanitize({ text }).text, '[redacted]', 'each complete registered secret is redacted after disposal');
    }
  }
  await b.dispose(); assert.equal(f.released(), 2);
});
test('disabled refresh fences instead of replaying', async () => {
  const f = fixture(false), signal = new AbortController().signal;
  const a = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  let exchanges = 0;
  const exchange = async () => { exchanges++; return 'dsh-auth-test=synthetic'; };
  await a.authenticate(exchange, { signal });
  await assert.rejects(a.authenticate(exchange, { signal, generation: 1, refresh: true }));
  assert.equal(exchanges, 1); assert.equal(f.failed(), 1); await a.dispose();
});
test('epoch loss during exchange cannot publish credentials', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const a = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  let finish;
  const pending = a.authenticate(() => new Promise(resolve => { finish = resolve; }), { signal });
  await new Promise(resolve => setImmediate(resolve)); f.controller.abort(); finish('dsh-auth-test=late');
  await assert.rejects(pending); await assert.rejects(a.use(() => true)); await a.dispose();
});
test('simultaneous acquisitions share initialization; cancelled waiter cannot kill live refresh', async () => {
  const f = fixture(), first = new AbortController(), second = new AbortController();
  const [a, b] = await Promise.all([f.credentials.acquire({ addonId: binding.addonId, runtime, signal: first.signal }), f.credentials.acquire({ addonId: binding.addonId, runtime, signal: second.signal })]);
  let complete, exchanges = 0;
  const exchange = () => { exchanges++; return new Promise(resolve => { complete = resolve; }); };
  const one = a.authenticate(exchange, { signal: first.signal }); const rejected = assert.rejects(one);
  const two = b.authenticate(exchange, { signal: second.signal });
  await new Promise(resolve => setImmediate(resolve)); first.abort(); complete('dsh-auth-test=surviving');
  await rejected; await two; assert.equal(exchanges, 1); assert.equal(f.failed(), 0);
  assert.equal(await b.use(value => value.cookie), 'dsh-auth-test=surviving');
  await assert.rejects(a.authenticate(exchange)); assert.throws(() => a.readinessLease());
  await b.dispose();
});

```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-credentials.test.mjs`. Expected: native acquisition rejected by old source reader.
- [ ] **Minimal implementation.** Add this complete native owner below `readSecret`, then apply the exact integration edits in the following script:

```js
function createNativeCustody(nativeRuntime, refreshPolicy) {
  const records = new Map();
  return async function acquireNative(binding, signal) {
    if (!nativeRuntime || !signal || signal.aborted) throw fail('runtime-unavailable');
    const owned = await nativeRuntime.acquire({ signal });
    let record = records.get(owned.epoch);
    if (!record) {
      record = { endpoint: binding.endpoint, token: '', cookie: '', generation: 0, pending: null, forbidden: new Set(), clients: new Set(), signal: owned.signal, alive: true };
      records.set(owned.epoch, record);
      record.remember = value => {
        if (typeof value !== 'string' || !value) return;
        for (const item of [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]) record.forbidden.add(item);
      };
      record.initialized = owned.use(value => {
        if (owned.signal.aborted) throw fail('runtime-unavailable');
        record.token = value.loginToken;
        record.remember(value.loginToken); record.remember(`${value.endpoint}/?token=${encodeURIComponent(value.loginToken)}`); record.remember(value.providerKey);
      });
      owned.signal.addEventListener('abort', () => { record.alive = false; record.token = ''; record.cookie = ''; records.delete(owned.epoch); }, { once: true });
    }
    const client = {}; record.clients.add(client);
    const live = () => { if (!record.alive || record.signal.aborted || !record.clients.size) throw fail('runtime-unavailable'); };
    function makeLease(shared = false) {
      let disposed = false;
      const accessSignal = shared ? record.signal : signal;
      const check = () => { live(); if (disposed || accessSignal.aborted) throw fail('runtime-unavailable'); };
      async function waitFor(promise, waiterSignal) {
        const combined = AbortSignal.any([accessSignal, record.signal, ...(waiterSignal ? [waiterSignal] : [])]); let abort;
        try {
          check(); if (combined.aborted) throw fail('runtime-unavailable');
          await Promise.race([promise, new Promise((_, reject) => { abort = () => reject(fail('runtime-unavailable')); combined.addEventListener('abort', abort, { once: true }); })]);
          check(); if (combined.aborted) throw fail('runtime-unavailable');
        } finally { combined.removeEventListener('abort', abort); }
      }
      const lease = Object.freeze({
        epoch: owned.epoch, signal: owned.signal, deadline: owned.deadline, version: owned.version,
        ready: () => owned.ready(), fail: code => owned.fail(code),
        readinessLease() { check(); return makeLease(true); },
        async use(callback) {
          check(); await record.initialized; if (record.pending) await waitFor(record.pending);
          check(); return callback({ endpoint: record.endpoint, authScheme: 'dsh-native-cookie', loginToken: record.token, cookie: record.cookie, generation: record.generation });
        },
        async authenticate(exchange, { signal: waiterSignal, generation, refresh = false } = {}) {
          check(); await record.initialized; check();
          if (refresh && !refreshPolicy(owned.version)) { await owned.fail('runtime-unavailable'); throw fail('runtime-unavailable'); }
          if (record.pending) { await waitFor(record.pending, waiterSignal); return; }
          if ((!refresh && record.cookie) || (refresh && generation < record.generation)) return;
          const operation = Promise.resolve().then(async () => {
            live(); const pair = await exchange({ endpoint: record.endpoint, loginToken: record.token, signal: record.signal }); live();
            record.remember(pair); record.remember(pair.slice(pair.indexOf('=') + 1)); record.cookie = pair; record.generation++;
          });
          record.pending = operation;
          void operation.finally(() => { if (record.pending === operation) record.pending = null; }).catch(() => {});
          await waitFor(operation, waiterSignal);
        },
        remember(value) { check(); record.remember(value); },
        sanitize(value) { try { return sanitizeOpenCodePayload(value, [...record.forbidden]); } catch { throw fail('runtime-unavailable'); } },
        async dispose() {
          if (disposed) return; disposed = true;
          if (shared) return;
          signal.removeEventListener('abort', disposeOnAbort); record.clients.delete(client);
          if (!record.clients.size) { record.alive = false; record.token = ''; record.cookie = ''; records.delete(owned.epoch); }
          await owned.release();
        },
      });
      const disposeOnAbort = () => { void lease.dispose(); };
      if (!shared) signal.addEventListener('abort', disposeOnAbort, { once: true });
      return lease;
    }
    const lease = makeLease();
    try { await record.initialized; if (signal.aborted || owned.signal.aborted) throw fail('runtime-unavailable'); return lease; }
    catch (error) { await lease.dispose(); throw error; }
  };
}
```

Bake the recorded conductor outcome as ordinary source, never a runtime-loaded file: native eligibility is exactly `0.2.0-rc.2` in Task 2, and its refresh permission is `true`. Both reviewed 0.1.x entries bake `false` and are refused before acquisition, rather than offered exchange-once mode. Other exact versions are unreviewed and refused for native use. Plugin policy is unchanged. The script verifies one complete existing conductor run against this outcome before writing the map; the incomplete first run must not silently change policy. A future `once` or structured-provider result requires a new reviewed policy revision.

```bash
python3 - <<'PY'
from pathlib import Path
import json
rows=json.loads(Path('/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/results.json').read_text())
versions={'0.1.5-rc.1','0.1.7-rc.2','0.2.0-rc.2'}
assert len(rows)==3 and {r['version'] for r in rows}==versions
for r in rows:
 assert r['auth'] in ['refresh','once','blocked']
 assert r['provider'] in ['catalog','structured','blocked']
 assert isinstance(r['blockedReasons'],list)
 eligible=bool(r.get('integrity') and r['auth'] in ['refresh','once'] and r['provider']=='catalog' and all(r[k] is True for k in ['origin','telemetry','persistence']) and not r['blockedReasons'])
 assert r['supportEligible'] is eligible
 assert eligible or r['blockedReasons'], 'blocked versions need explicit reasons'
p=Path('browser-first/host/harness-credentials.mjs'); s=p.read_text()
old='export function createHarnessCredentials({ bindings = [], env = process.env } = {}) {'; assert s.count(old)==1
def refresh_allowed(row):
 return row['auth']=='refresh' and row['supportEligible']
# Synthetic policy proof only: no assertion here certifies an installed package.
assert [refresh_allowed(dict(auth=auth,supportEligible=eligible)) for auth,eligible in
 [('refresh',True),('once',True),('blocked',False),('refresh',False)]] == [True,False,False,False]
expected={'0.1.5-rc.1':False,'0.1.7-rc.2':False,'0.2.0-rc.2':True}
assert {r['version']:r['supportEligible'] for r in rows} == expected, 'select a complete reviewed conductor run'
assert {r['version']:refresh_allowed(r) for r in rows} == expected
verified=next(r for r in rows if r['version']=='0.2.0-rc.2')
assert verified['auth']=='refresh' and verified['provider']=='catalog'
policy=json.dumps(expected,sort_keys=True)
s=s.replace(old, 'const nativeRefreshByVersion = Object.freeze('+policy+');\nexport function createHarnessCredentials({ bindings = [], env = process.env, nativeRuntime, refreshPolicy = version => nativeRefreshByVersion[version] === true } = {}) {\n  const acquireNative = createNativeCustody(nativeRuntime, refreshPolicy);')
s=s.replace('async acquire({ addonId, runtime } = {}) {','async acquire({ addonId, runtime, signal } = {}) {')
anchor='      let actionToken;'; assert s.count(anchor)==1
s=s.replace(anchor, "      if (binding.authScheme === 'dsh-native-cookie') return acquireNative(binding, signal);\n"+anchor)
p.write_text(s)
PY
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-credentials.test.mjs browser-first/test/harness-credentials.test.mjs`.
- [ ] **Red evidence:** use native acquisition inputs mismatching each public binding field, with an otherwise working runtime stub; remove the exact-binding comparison and require the permission-denial assertion to fail. Remove only `disposed` from `check()` and call `a.use` after disposing `a` while `b` remains live: `assert.rejects` fails. Remove the pending single-flight branch: concurrent exchanges become two. Remove the stale-generation comparison: the third refresh makes `calls` three instead of two. Remove the refresh-policy branch: disabled refresh resolves and `assert.rejects` fails. Replace shared `live()` with a no-op: after aborting the epoch during exchange, `waitFor` still rejects via its signal, so that rejection is NOT red evidence; the subsequent `a.use` now resolves a late cookie and its `assert.rejects` must fail. Remove each `remember` registration independently and require the strengthened exact `[redacted]` assertions for raw/full-URL/full-cookie/value-only and base64 forms to fail. Checking only that a cookie pair no longer contains its value would be masked by overlapping registrations. Retain the simultaneous-acquisition/cancellation positive control. Add a default-policy test without `refreshPolicy` injection: `0.2.0-rc.2` refreshes, both blocked exact versions and an unknown version refuse refresh; use a synthetic runtime stub solely to reach this defense behind Task 2 admission.
- [ ] **Commit:**

```bash
git add browser-first/host/harness-credentials.mjs browser-first/test/dsh-native-credentials.test.mjs
git commit -m "feat(harness): share native epoch credentials and refresh authority"
```

### Task 5: Direct connections and native cookie transport

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `browser-first/host/agent-runtime-endpoint.mjs`
- Modify: `browser-first/host/harness-transport.mjs`
- Create/test: `browser-first/test/dsh-native-transport.test.mjs`

**Interfaces:**
- Consumes: Task 4 credential lease; existing endpoint methods `connectHttp(path, options, acceptRedirect?)` and `connectWebSocket(path, options, handleSocket)`.
- Produces: `createHarnessTransport({credentials,addonId,runtime,signal,lookup,fetchImpl?,WebSocketImpl?,timeoutMs?,maxResponseBytes?,maxMessageBytes?}) -> Promise<transport>`; transport adds `authenticate({signal})`, `sanitize(value)`, `epoch`, `runtimeSignal`, `deadline`, `version`, `markReady()`, `failRuntime(code)`. Existing `request`, `openStream`, `dispose` signatures remain. Native HTTP and socket requests never contain the action header or an explicit Origin.

- [ ] **Write failing tests:**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHarnessTransport } from '../host/harness-transport.mjs';
const runtime = { adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081', credentialBinding: 'dsh.native' };
function credentials() {
  const loginToken = randomBytes(24).toString('base64url');
  let cookie = '', generation = 0, failure = 0, disposed = false;
  const signal = new AbortController().signal;
  return { loginToken, failed: () => failure,
    async acquire() { return { epoch: 'epoch', signal, deadline: Date.now() + 30000, version: '0.2.0-rc.2',
      async use(fn) { assert.equal(disposed, false); return fn({ endpoint: runtime.endpoint, loginToken, cookie, generation }); },
      async authenticate(exchange, { refresh = false } = {}) { if (!cookie || refresh) { cookie = await exchange({ endpoint: runtime.endpoint, loginToken, signal }); generation++; } },
      remember() {}, sanitize: value => value, ready() {}, fail() { failure++; }, dispose() { disposed = true; },
    }; },
  };
}
async function fixture(headers = { 'set-cookie': 'dsh-auth-test=synthetic; HttpOnly', location: '/' }, exchangeStatus = 303, socketOutcomes = []) {
  const creds = credentials(), calls = [], sockets = [];
  let statuses = [], promptCalls = 0;
  class Socket extends EventTarget {
    bufferedAmount = 0;
    constructor(url, options) { super(); sockets.push({ url: String(url), options }); const outcome = socketOutcomes.shift() ?? 'open';
      if (outcome === 'denied') throw Object.assign(new Error('synthetic guard denial'), { code: 'permission-denied' });
      if (outcome === 'constructor-failure') throw new Error('synthetic constructor failure');
      queueMicrotask(() => { const event = new Event(outcome === 'status-503' ? 'error' : outcome); if (outcome === 'status-503') event.status = 503; this.dispatchEvent(event); }); }
    close() {} send() {}
  }
  const transport = await createHarnessTransport({ credentials: creds, addonId: 'addon.native', runtime, signal: new AbortController().signal, WebSocketImpl: Socket,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (new URL(url).search) return new Response(null, { status: exchangeStatus, headers });
      if (new URL(url).pathname === '/api/session/prompt') promptCalls++;
      const status = statuses.shift() ?? 200;
      if (status === 'lost') throw new Error('synthetic uncertain result');
      return Response.json({ ok: true }, { status });
    },
  });
  return { transport, calls, sockets, creds, statuses: value => { statuses = value; }, promptCalls: () => promptCalls };
}
test('native exchanges before RPC, uses cookie only, refuses plugin route', async () => {
  const f = await fixture();
  await f.transport.request('/api/session/modelCatalog');
  await f.transport.openStream();
  assert.equal(f.calls.filter(c => c.url.includes('?token=')).length, 1);
  assert.ok(f.calls[0].url.includes('?token='));
  assert.ok(f.calls.every(c => !c.url.includes('/augmentor') && !('x-augmentor-token' in c.options.headers)));
  assert.deepEqual(f.sockets[0].options.headers, { cookie: 'dsh-auth-test=synthetic' });
  await assert.rejects(f.transport.request('/api/augmentor'), { code: 'permission-denied' });
  await f.transport.dispose();
});
for (const setCookie of ['', 'dsh-auth-test=bad value', 'dsh-auth-test=x; Max-Age=0', 'dsh-auth-test=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'dsh-auth-test=' + 'x'.repeat(8192)]) {
  test('reject invalid native cookie ' + setCookie.length, async () => {
    const f = await fixture({ 'set-cookie': setCookie });
    await assert.rejects(f.transport.authenticate()); await f.transport.dispose();
  });
}
test('only one explicit 401 retry; 5xx and uncertain prompt never replay', async () => {
  const f = await fixture(); await f.transport.authenticate();
  f.statuses([401, 200]); await f.transport.request('/api/session/prompt'); assert.equal(f.promptCalls(), 2);
  f.statuses([503]); await assert.rejects(f.transport.request('/api/session/prompt')); assert.equal(f.promptCalls(), 3);
  f.statuses([401, 401]); await assert.rejects(f.transport.request('/api/session/prompt')); assert.equal(f.promptCalls(), 5); assert.equal(f.creds.failed(), 1);
  await f.transport.dispose();
});
test('only exact 303 root redirect with one live auth cookie is accepted', async () => {
  for (const [headers, status] of [
    [{ 'set-cookie': 'dsh-auth-test=x', location: '/' }, 200],
    [{ 'set-cookie': 'dsh-auth-test=x', location: '/' }, 302],
    [{ 'set-cookie': 'dsh-auth-test=x', location: 'http://evil.invalid/' }, 303],
    [{ 'set-cookie': 'dsh-auth-test=x', location: '/other' }, 303],
    [[['set-cookie', 'dsh-auth-one=x'], ['set-cookie', 'dsh-auth-two=y']], 303],
    [{ 'set-cookie': 'dsh-auth-test=x; Max-Age=1; Max-Age=2' }, 303],
  ]) { const f = await fixture(headers, status); await assert.rejects(f.transport.authenticate()); await f.transport.dispose(); }
});
test('uncertain prompt response is sent only once', async () => {
  const f = await fixture(); await f.transport.authenticate(); f.statuses(['lost']);
  await assert.rejects(f.transport.request('/api/session/prompt')); assert.equal(f.promptCalls(), 1);
  assert.equal(f.calls.filter(call => call.url.includes('?token=')).length, 1); await f.transport.dispose();
});
for (const outcome of ['denied', 'constructor-failure', 'status-503']) test(`WS ${outcome} never runs an auth diagnostic`, async () => {
  const f = await fixture(undefined, 303, [outcome]); await f.transport.authenticate();
  // A tempting diagnostic 401 must never be requested in these cases.
  f.statuses([401]);
  await assert.rejects(f.transport.openStream(), { code: outcome === 'denied' ? 'permission-denied' : 'runtime-unavailable' });
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/api/session/modelCatalog').length, 0);
  assert.equal(f.calls.filter(call => call.url.includes('?token=')).length, 1);
  await f.transport.dispose();
});
for (const diagnostic of [200, 401, 503]) test(`generic WS failure diagnoses ${diagnostic} without guessing auth`, async () => {
  const f = await fixture(undefined, 303, ['error', 'open']); await f.transport.authenticate(); f.statuses([diagnostic]);
  if (diagnostic === 401) { const stream = await f.transport.openStream(); stream.close(); assert.equal(f.sockets.length, 2); }
  else { await assert.rejects(f.transport.openStream()); assert.equal(f.sockets.length, 1); }
  assert.equal(f.promptCalls(), 0);
  assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/api/session/modelCatalog').length, 1);
  assert.equal(f.calls.filter(call => call.url.includes('?token=')).length, diagnostic === 401 ? 2 : 1);
  await f.transport.dispose();
});

import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { getGlobalDispatcher, setGlobalDispatcher, ProxyAgent } from 'undici';
import { createHarnessCredentials as realCredentials } from '../host/harness-credentials.mjs';
test('both DSH schemes bypass hostile environment and global proxies for real HTTP and WS', async () => {
  let proxyTraffic = 0, directHttp = 0, upgrades = 0;
  const sockets = new Set();
  const sink = createHttpServer((request, response) => { proxyTraffic++; response.writeHead(502); response.end(); });
  sink.on('connect', (_request, socket) => { proxyTraffic++; socket.destroy(); });
  sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
  const token = randomBytes(24).toString('base64url'), cookie = `dsh-auth-local=${randomBytes(24).toString('base64url')}`;
  const server = createHttpServer(async (request, response) => {
    directHttp++; request.resume();
    if (request.url.startsWith('/?token=')) { response.writeHead(303, { location: '/', 'set-cookie': cookie }); response.end(); return; }
    if (request.url === '/api/augmentor/auth') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ token })); return; }
    if (request.headers.cookie !== cookie) { response.writeHead(401); response.end(); return; }
    response.setHeader('content-type', 'application/json'); response.end('{}');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket) => {
    if (request.headers.cookie !== cookie) { socket.destroy(); return; }
    upgrades++;
    const key = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  assert.notEqual(server.address().port, 19387); assert.notEqual(sink.address().port, 19387);
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const savedDispatcher = getGlobalDispatcher(), proxy = new ProxyAgent(`http://127.0.0.1:${sink.address().port}`);
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) if (name.toLowerCase().endsWith('_proxy') && !name.toLowerCase().startsWith('no_')) process.env[name] = `http://127.0.0.1:${sink.address().port}`;
    delete process.env.NO_PROXY; delete process.env.no_proxy; process.env.NODE_USE_ENV_PROXY = '1'; setGlobalDispatcher(proxy);
    for (const authScheme of ['dsh-native-cookie', 'dsh-action-token']) {
      const selected = { ...runtime, endpoint, authScheme }, lifetime = new AbortController();
      const custody = realCredentials({ bindings: [{ name: selected.credentialBinding, addonId: 'addon.native', adapterId: selected.adapterId, authScheme, endpoint,
        source: authScheme === 'dsh-native-cookie' ? { managedDsh: true } : { env: 'SYNTHETIC_TOKEN' } }], env: { SYNTHETIC_TOKEN: token },
        nativeRuntime: { acquire: async () => ({ epoch: 'proxy-test', signal: lifetime.signal, deadline: Date.now() + 30000, version: '0.2.0-rc.2',
          use: fn => fn({ endpoint, loginToken: token }), ready() {}, fail() { lifetime.abort(); }, release() {} }) } });
      const transport = await createHarnessTransport({ credentials: custody, addonId: 'addon.native', runtime: selected, signal: lifetime.signal, timeoutMs: 1000 });
      let failure;
      try { await transport.request('/api/session/modelCatalog'); const stream = await transport.openStream(); stream.close(); }
      catch (error) { failure = error; }
      finally { await transport.dispose(); }
      assert.equal(proxyTraffic, 0, 'proxy must never receive DSH credentials or requests');
      assert.equal(failure, undefined, 'real direct connectors must complete HTTP and upgrade');
    }
    assert.equal(upgrades, 2); assert.ok(directHttp >= 4);
  } finally {
    setGlobalDispatcher(savedDispatcher); for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    for (const socket of sockets) socket.destroy(); await proxy.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => sink.close(resolve))]);
  }
});

```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-transport.test.mjs`. Expected: native scheme denied by current transport.
- [ ] **Minimal direct connector implementation:** pin the inspected library, then edit exact defaults. The private Agent uses Undici's direct connector and never the global dispatcher or `EnvHttpProxyAgent`.

```bash
npm install --save-exact undici@7.30.0
python3 - <<'PY'
from pathlib import Path
p=Path('browser-first/host/agent-runtime-endpoint.mjs'); s=p.read_text()
anchor="import { lookup as dnsLookup } from 'node:dns/promises';"
s=s.replace(anchor, "import { Agent, fetch as directFetch, WebSocket as DirectWebSocket } from 'undici';\nconst directDispatcher = new Agent();\n"+anchor)
s=s.replace('fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket', 'fetchImpl = directFetch, WebSocketImpl = DirectWebSocket')
s=s.replace("signal, redirect: 'manual'", "signal, redirect: 'manual', dispatcher: directDispatcher")
s=s.replace('headers, followRedirects: false', 'headers, followRedirects: false, dispatcher: directDispatcher')
p.write_text(s)
p=Path('browser-first/host/harness-transport.mjs'); s=p.read_text()
s=s.replace('fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timeoutMs = 10000,', 'fetchImpl, WebSocketImpl, signal: acquisitionSignal, timeoutMs = 10000,')
s=s.replace("runtime?.authScheme !== 'dsh-action-token'", "!['dsh-action-token', 'dsh-native-cookie'].includes(runtime?.authScheme)")
s=s.replace('credentials.acquire({ addonId, runtime })', 'credentials.acquire({ addonId, runtime, signal: acquisitionSignal })')
s=s.replace("  const origin = endpointGuard.origin;", "  const origin = endpointGuard.origin;\n  const native = runtime.authScheme === 'dsh-native-cookie';")
s=s.replace('AbortSignal.any([lifetime.signal, deadline.signal,', 'AbortSignal.any([lifetime.signal, ...(native ? [lease.signal] : []), deadline.signal,')
s=s.replace('  async function authorize(signal) {', '  async function authorize(signal) {\n    if (native) return lease.authenticate(nativeExchange, { signal });')
s=s.replace("if (!routes.has(route) ||", "if (!routes.has(route) || (native && route === '/api/augmentor') ||")
s=s.replace('    dispose() {', '    dispose() {')
s=s.replace('      lease.dispose();\n    },', '      return lease.dispose();\n    },')
anchor='  return Object.freeze({'; assert s.count(anchor)==1
s=s.replace(anchor, '''  return Object.freeze({
    ...(native ? { epoch: lease.epoch, runtimeSignal: lease.signal, deadline: lease.deadline, version: lease.version,
      markReady: () => lease.ready(), failRuntime: code => lease.fail(code) } : {}),
    authenticate: ({ signal } = {}) => bounded(authorize, signal),
    sanitize: value => lease.sanitize(value),''')
p.write_text(s)
PY
```

Add the following complete function within `createHarnessTransport`, immediately before `authorize`. It uses the epoch signal rather than the first waiter's signal; a cancelled waiter cannot kill another lease's shared exchange.

```js
  async function nativeExchange({ endpoint, loginToken, signal }) {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const response = await endpointGuard.connectHttp(`/?token=${encodeURIComponent(loginToken)}`, {
      method: 'GET', headers: {}, signal: boundedSignal,
    }, response => response.status === 303);
    try {
      const location = response.headers.get('location');
      if (response.status !== 303 || (location && new URL(location, endpoint).href !== endpoint + '/')) throw fail('runtime-unavailable');
      const auth = response.headers.getSetCookie().filter(value => /^\s*dsh-auth-/i.test(value));
      if (auth.length !== 1) throw fail('runtime-unavailable');
      const [pair, ...attributes] = auth[0].split(';');
      if (Buffer.byteLength(pair) > 8192 || !/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/.test(pair)) throw fail('runtime-unavailable');
      const seen = new Set();
      for (const attribute of attributes) {
        const at = attribute.indexOf('='), name = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
        const value = at < 0 ? '' : attribute.slice(at + 1).trim();
        if (['expires', 'max-age'].includes(name)) {
          if (seen.has(name)) throw fail('runtime-unavailable'); seen.add(name);
          if (name === 'max-age' && (!/^[0-9]+$/.test(value) || Number(value) <= 0)) throw fail('runtime-unavailable');
          if (name === 'expires' && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())) throw fail('runtime-unavailable');
        }
      }
      if (boundedSignal.aborted) throw fail('runtime-unavailable');
      return pair;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
```

Replace the `request` method in the returned transport with this complete method:

```js
    async request(route, options = {}) {
      if (!routes.has(route) || (native && route === '/api/augmentor') || Object.keys(options).some(key => !['body', 'signal', 'method'].includes(key)) ||
          (options.method !== undefined && !['GET', 'POST'].includes(options.method))) throw fail('permission-denied');
      return bounded(async signal => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        if (body !== undefined && Buffer.byteLength(body) > maxResponseBytes) throw fail('permission-denied');
        if (native) await authorize(signal);
        let usedGeneration;
        const send = async () => {
          const value = native ? await lease.use(value => ({ cookie: value.cookie, generation: value.generation })) : { cookie };
          usedGeneration = value.generation;
          return requestRaw(route, { method: options.method ?? 'POST', body, signal,
            headers: { 'content-type': 'application/json', ...(value.cookie ? { cookie: value.cookie } : {}) } });
        };
        let response = await send();
        if (response.status === 401) {
          if (native) await lease.authenticate(nativeExchange, { signal, generation: usedGeneration, refresh: true });
          else await authorize(signal);
          check(signal); response = await send();
          if (native && response.status === 401) await lease.fail('runtime-unavailable');
        }
        if (response.status < 200 || response.status >= 300) throw fail('runtime-unavailable');
        return { status: response.status, body: lease.sanitize(JSON.parse(response.text)) };
      }, options.signal);
    },
```

Replace the complete `openStream` method with this method. Only a completed opening failure without an exposed HTTP status uses one read-only diagnostic. Denial, construction failure, cancellation, and failures after open preserve their original result. No uncertain prompt is involved in that diagnostic.

```js
    async openStream({ signal, onMessage = () => {}, onError = () => {}, onClose = () => {} } = {}) {
      return bounded(async openingSignal => {
        await authorize(openingSignal); check(openingSignal);
        let attempted;
        const opaqueOpeningFailure = Symbol('opaque-opening-failure');
        async function openOnce() {
          const values = await lease.use(value => ({ actionToken: value.actionToken, cookie: native ? value.cookie : cookie, generation: value.generation }));
          attempted = values;
          return endpointGuard.connectWebSocket('/api/remote.mux', {
            headers: native ? { cookie: values.cookie } : { 'x-augmentor-token': values.actionToken, cookie: values.cookie }, signal: openingSignal,
          }, socket => new Promise((resolve, reject) => {
            let opened = false, closed = false;
            const streamSignal = AbortSignal.any([lifetime.signal, ...(native ? [lease.signal] : []), ...(signal ? [signal] : [])]);
            function close(openingError = fail('runtime-unavailable')) {
              if (closed) return;
              closed = true; streams.delete(close);
              openingSignal.removeEventListener('abort', close); streamSignal.removeEventListener('abort', close);
              socket.close(); if (!opened) reject(openingError);
            }
            streams.add(close); openingSignal.addEventListener('abort', close, { once: true }); streamSignal.addEventListener('abort', close, { once: true });
            socket.addEventListener('open', () => {
              if (closed || openingSignal.aborted) { close(); return; }
              opened = true; openingSignal.removeEventListener('abort', close);
              resolve(Object.freeze({
                send(value) {
                  try {
                    check(streamSignal); const text = JSON.stringify(value);
                    if (closed || typeof text !== 'string' || Buffer.byteLength(text) > maxMessageBytes || socket.bufferedAmount > maxMessageBytes) throw fail('runtime-unavailable');
                    socket.send(text);
                  } catch (error) { close(); throw safe(error); }
                }, close,
              }));
            });
            socket.addEventListener('message', event => {
              if (closed || streamSignal.aborted) return;
              try {
                if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > maxMessageBytes) throw fail('runtime-unavailable');
                onMessage(lease.sanitize(JSON.parse(event.data)));
              } catch (error) { try { onError(safe(error)); } catch {} close(); }
            });
            function openingFailure(event) {
              const error = fail('runtime-unavailable');
              // Undici has no stable public handshake status. A trusted connector
              // exposing a status must not fall through to the opaque diagnostic.
              if (!opened && !closed && !openingSignal.aborted && !streamSignal.aborted &&
                  event?.status === undefined && event?.error?.status === undefined) error[opaqueOpeningFailure] = true;
              return error;
            }
            socket.addEventListener('error', event => { if (opened && !closed) { try { onError(fail('runtime-unavailable')); } catch {} } close(openingFailure(event)); });
            socket.addEventListener('close', event => { const notify = opened && !closed; close(openingFailure(event)); if (notify) { try { onClose(); } catch {} } });
          }));
        }
        try { return await openOnce(); }
        catch (error) {
          if (!native || openingSignal.aborted || error?.code === 'permission-denied' || error?.[opaqueOpeningFailure] !== true) throw error;
          const diagnostic = await requestRaw('/api/session/modelCatalog', {
            method: 'POST', headers: { cookie: attempted.cookie, 'content-type': 'application/json' }, signal: openingSignal, consumeBody: false,
            body: JSON.stringify({ type: 'client-request', rpcId: 'native-auth-diagnostic', method: 'session/modelCatalog', payload: { args: {} } }),
          });
          if (diagnostic.status !== 401) throw fail('runtime-unavailable');
          await lease.authenticate(nativeExchange, { signal: openingSignal, generation: attempted.generation, refresh: true });
          try { return await openOnce(); }
          catch {
            await lease.fail('runtime-unavailable'); throw fail('runtime-unavailable');
          }
        }
      }, signal);
    },
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-transport.test.mjs browser-first/test/harness-transport.test.mjs browser-first/test/agent-runtime-endpoint.test.mjs browser-first/test/dsh-harness-adapter.test.mjs browser-first/test/dsh-harness-stream.test.mjs`.
- [ ] **Red evidence:** remove each named predicate with an otherwise-valid fixture. Cookie grammar uses `bad value`; size uses one valid auth pair over 8192 bytes; expiry uses one valid pair with `Max-Age=0` or a past Expires independently. Cardinality uses **two valid auth cookies**: zero cookies still throw at `auth[0].split` if the length guard is deleted and therefore do not kill that mutant. Remove `response.status !== 303` and use a 200 response with a valid cookie: a 302 is independently rejected by the endpoint guard. Remove only Location validation and use a foreign root URL. Remove the native `/api/augmentor` exclusion and require its permission-denial assertion to fail; add an action header to native socket options and require exact cookie-only headers to fail. Broaden the 401 retry predicate to include 503 and require the no-5xx-replay rejection/count assertions to fail; remove the second-401 fence and require `failed() === 1` to fail. Use valid oversized JSON/message payloads to isolate byte bounds from JSON/schema failures, and test inbound and outbound limits separately.
- [ ] **Opening/connector red evidence:** remove only `error?.[opaqueOpeningFailure] !== true` from the catch predicate and require constructor/status cases to fail their zero-diagnostic assertion; remove both that predicate and `permission-denied` exclusion for the denial case. The remaining exclusion otherwise masks a denial-only deletion. Use the real loopback proxy sink under the hostile environment/global dispatcher as specified in the test. Remove HTTP and WebSocket `dispatcher: directDispatcher` arguments in separate mutants; each must increment sink traffic and fail `proxyTraffic === 0`. The test records connection errors before asserting the sink count, so early network rejection cannot hide the observation. Restore global networking inside the isolated test process only.
- [ ] **Commit:**

```bash
git add package.json package-lock.json browser-first/host/agent-runtime-endpoint.mjs browser-first/host/harness-transport.mjs browser-first/test/dsh-native-transport.test.mjs
git commit -m "feat(harness): authenticate native DSH over direct bounded connections"
```

### Task 6: Validate native protocol readiness without requiring provider readiness

**Files:**
- Modify: `browser-first/host/agent-adapters/dsh-typert.mjs`
- Create/test: `browser-first/test/dsh-native-readiness.test.mjs`

**Interfaces:**
- Consumes: authenticated `transport.request(route, options)`, Task 0's provider result.
- Produces: `decodeDshCatalog(catalog) -> {groups,default?}` and `adapter.probe({signal,native?:boolean}) -> Promise<{available,protocolReady?,providerAvailable?,...capabilities}>`. Native probe success means validated protocol, not a working provider. Plugin probe retains its previous return and behavior.
- Dependency gate: the recorded `0.2.0-rc.2` result is `provider: 'catalog'`; use this strict success decoder for that sole native-eligible version. Task 2 refuses 0.1.x before transport/probe. No structured-provider decoder or 0.1.x fallback is authorized by the collected evidence; plugin probe behavior stays unchanged.

- [ ] **Write failing tests:**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshTypertAdapter } from '../host/agent-adapters/dsh-typert.mjs';
function adapter(value, result) {
  return createDshTypertAdapter({ transport: {
    request: async (_path, options) => ({ status: 200, body: { type: 'server-response', rpcId: options.body.rpcId, result: result ?? { ok: true, value } } }),
    openStream: async () => { throw new Error('probe must not open a follow stream'); }, dispose() {},
  } });
}
test('empty validated catalog is protocol ready without a model', async () => {
  const a = adapter({ groups: [] }); const result = await a.probe({ native: true });
  assert.equal(result.protocolReady, true); assert.equal(result.providerAvailable, false); await a.dispose();
});
test('native validates catalog while plugin probe keeps its existing behavior', async () => {
  for (const value of [{}, { groups: null }, { groups: [{ id: '', models: [] }] }, { groups: [{ id: 'deepseek', models: [{ id: '' }] }] }]) {
    const a = adapter(value); await assert.rejects(a.probe({ native: true }));
    assert.equal((await a.probe()).available, true); await a.dispose();
  }
});
test('unknown or auth-shaped error is never manufactured into provider readiness', async () => {
  for (const error of [{ code: 'unauthorized' }, { code: 'unknown' }, { message: 'provider key missing' }]) {
    for (const value of [undefined, { groups: [] }]) {
      const a = adapter(null, { ok: false, error, value });
      await assert.rejects(a.probe({ native: true }), { code: 'runtime-unavailable' }, 'error envelope must fail even with a valid catalog value'); await a.dispose();
    }
  }
});
test('valid model catalog establishes availability', async () => {
  const a = adapter({ groups: [{ id: 'deepseek', models: [{ id: 'model', name: 'Model' }] }] });
  const result = await a.probe({ native: true }); assert.equal(result.protocolReady, true); assert.equal(result.providerAvailable, true); await a.dispose();
});
```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-readiness.test.mjs`. Expected: missing protocolReady and malformed catalogs incorrectly accepted.
- [ ] **Minimal implementation:** move the existing catalog decoder unchanged into a named function and reuse it; the exact transformation is:

```bash
python3 - <<'PY'
from pathlib import Path
p=Path('browser-first/host/agent-adapters/dsh-typert.mjs'); s=p.read_text()
start=s.index('      if (!Array.isArray(catalog?.groups)')
end=s.index('\n    },\n    async selectModel',start)
body=s[start:end]
function='export function decodeDshCatalog(catalog) {\n'+'\n'.join(line[4:] for line in body.splitlines())+'\n}\n\n'
s=s[:start]+'      return decodeDshCatalog(catalog);'+s[end:]
anchor='export function createDshTypertAdapter('; assert s.count(anchor)==1
s=s.replace(anchor,function+anchor)
old="    async probe({ signal } = {}) { await rpc('session/modelCatalog', {}, signal); return { available: true, ...capabilities }; },"
new="""    async probe({ signal, native = false } = {}) {
      const value = await rpc('session/modelCatalog', {}, signal);
      if (!native) return { available: true, ...capabilities };
      const catalog = decodeDshCatalog(value);
      return { available: true, protocolReady: true, providerAvailable: catalog.groups.some(group => group.models.length > 0), ...capabilities };
    },"""
assert s.count(old)==1; p.write_text(s.replace(old,new))
PY
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-readiness.test.mjs browser-first/test/dsh-harness-adapter.test.mjs browser-first/test/dsh-harness-stream.test.mjs`.
- [ ] **Red evidence:** replace `decodeDshCatalog(value)` with `{ groups: [] }`, then run the malformed-catalog test and require rejection assertions to fail. Restore. Remove only `body.result?.ok !== true` from `rpc`'s rejection predicate; require the error-envelope case carrying `value: { groups: [] }` to fail `assert.rejects`. The mutant returns a valid catalog and reaches Ready. The undefined-value cases still reject at the decoder and do not kill this mutant. Restore. No free-text provider classifier may be added.
- [ ] **Commit:**

```bash
git add browser-first/host/agent-adapters/dsh-typert.mjs browser-first/test/dsh-native-readiness.test.mjs
git commit -m "feat(harness): validate native DSH protocol readiness"
```

### Task 7: Carry authorization cancellation and synchronously retire runtime sessions

**Files:**
- Modify: `browser-first/host/harness-boundary.mjs`
- Create/test: `browser-first/test/dsh-native-boundary.test.mjs`

**Interfaces:**
- Consumes: registry authorization/fence APIs and `resolveAdapter(authorization,{signal,bindRuntime(epoch):void}) -> Promise<adapter>`.
- Produces: optional `onRetired(ref):void` constructor callback, `boundary.isLive(ref):boolean`, `boundary.retireRuntime(epoch,code='runtime-unavailable'):Promise<void>`. References remain exactly `{addonId,sessionId,bootEpoch,generation}`. Runtime epochs never enter public references or governance.

- [ ] **Write failing tests:**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessBoundary } from '../host/harness-boundary.mjs';
function registry() {
  let listener, valid = true;
  const authorization = { slot: 'primary-agent', addonId: 'addon.native', bootEpoch: 'boot', generation: 1, runtime: { supportedOperations: ['createSession', 'invoke', 'cancel', 'history', 'status', 'modelCatalog', 'selectModel'] } };
  return { authorize: () => structuredClone(authorization), isCurrent: () => valid, assertOperation() { if (!valid) throw Object.assign(new Error('denied'), { code: 'permission-denied' }); },
    onFence(fn) { listener = fn; return () => {}; }, revoke() { valid = false; return listener({ slot: 'primary-agent' }); } };
}
function adapter() { return { createSession: async () => ({}), dispose: async () => {}, async *invoke() { yield { type: 'final', data: { text: 'reply' } }; } }; }
test('pending authorization signal crosses resolution and fences before late acquisition', async () => {
  const r = registry(); let args, release, creates = 0;
  const boundary = createHarnessBoundary({ registry: r, resolveAdapter: async (_authorization, options) => { args = options; await new Promise(resolve => { release = resolve; }); return { ...adapter(), createSession: async () => { creates++; return {}; } }; } });
  const result = boundary.createSession({ addonId: 'addon.native' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(args.signal.aborted, false); const revoking = r.revoke(); assert.equal(args.signal.aborted, true);
  release(); await assert.rejects(result, { code: 'ownership-conflict' });
  assert.equal(creates, 0, 'revoked resolution cannot dispatch createSession'); await revoking; await boundary.close();
});
test('runtime retirement emits one error, invalidates reference and notifies synchronously', async () => {
  const retired = [], r = registry();
  const boundary = createHarnessBoundary({ registry: r, onRetired: ref => retired.push(ref), resolveAdapter: async (_authorization, { bindRuntime }) => { bindRuntime('epoch'); return adapter(); } });
  const ref = await boundary.createSession({ addonId: 'addon.native' }), reader = boundary.events(ref);
  assert.equal(boundary.isLive(ref), true);
  const stopping = boundary.retireRuntime('epoch');
  assert.deepEqual(retired, [ref]); assert.equal(boundary.isLive(ref), false);
  assert.equal((await reader.next()).value.data.code, 'runtime-unavailable');
  assert.equal((await reader.next()).done, true);
  assert.throws(() => boundary.invoke(ref, {}), { code: 'session-not-found' });
  await stopping; await boundary.retireRuntime('epoch'); assert.equal(retired.length, 1); await boundary.close();
});
test('old epoch cannot retire a replacement', async () => {
  const r = registry(); let epoch = 'old';
  const boundary = createHarnessBoundary({ registry: r, resolveAdapter: async (_authorization, { bindRuntime }) => { bindRuntime(epoch); return adapter(); } });
  const old = await boundary.createSession({ addonId: 'addon.native' }); await boundary.retireRuntime('old');
  epoch = 'new'; const next = await boundary.createSession({ addonId: 'addon.native' });
  await boundary.retireRuntime('old'); assert.equal(boundary.isLive(next), true); assert.equal(boundary.isLive(old), false); await boundary.close();
});
```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-boundary.test.mjs`. Expected: missing resolution options and retirement APIs.
- [ ] **Minimal implementation:** apply this complete bounded edit script:

```bash
python3 - <<'PY'
from pathlib import Path
p=Path('browser-first/host/harness-boundary.mjs'); s=p.read_text()
s=s.replace('createHarnessBoundary({ registry, resolveAdapter, maxSessions', 'createHarnessBoundary({ registry, resolveAdapter, onRetired = () => {}, maxSessions')
s=s.replace("function check(ctx) { if (!current(ctx)) throw fail('ownership-conflict'); }", "function check(ctx) { if (!current(ctx)) throw fail(ctx.failureCode ?? 'ownership-conflict'); }")
a=s.index('  function retire(ctx) {'); b=s.index('  const unsubscribe =',a)
s=s[:a]+'''  function retire(ctx, code = 'ownership-conflict') {
    if (!ctx.retired) {
      ctx.retired = true; ctx.failureCode = code;
      ctx.bus?.close(code);
      ctx.controller.abort(); ctx.turn?.controller.abort();
      if (sessions.delete(ctx.sessionId)) {
        try { onRetired(structuredClone(ctx.ref)); } catch {}
      }
    }
    return dispose(ctx).catch(() => {});
  }
'''+s[b:]
old='        ctx.adapter = await resolveAdapter(structuredClone(authorization));'
new='''        ctx.adapter = await resolveAdapter(structuredClone(authorization), {
          signal: ctx.controller.signal,
          bindRuntime(epoch) {
            check(ctx); registry.assertOperation(authorization, 'createSession');
            if (typeof epoch !== 'string' || !epoch || (ctx.runtimeEpoch && ctx.runtimeEpoch !== epoch)) throw fail('runtime-unavailable');
            ctx.runtimeEpoch = epoch;
          },
        });
        registry.assertOperation(authorization, 'createSession');'''
assert s.count(old)==1; s=s.replace(old,new)
s=s.replace("        if (!current(ctx)) throw fail('ownership-conflict');", "        if (!current(ctx)) throw fail(ctx.failureCode ?? 'ownership-conflict');")
anchor='    events(ref) { return registered(ref).bus.subscribe(); },'
s=s.replace(anchor, '''    isLive(ref) {
      try { const ctx = registered(ref); registry.assertOperation(ctx.authorization, 'createSession'); return true; } catch { return false; }
    },
    retireRuntime(epoch, code = 'runtime-unavailable') {
      const fixed = code === 'deadline-exceeded' ? code : 'runtime-unavailable';
      return Promise.allSettled([...pending, ...sessions.values()].filter(ctx => ctx.runtimeEpoch === epoch).map(ctx => retire(ctx, fixed)));
    },
'''+anchor)
s=s.replace('.map(retire)', '.map(ctx => retire(ctx))')
p.write_text(s)
PY
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-boundary.test.mjs browser-first/test/harness-boundary.test.mjs browser-first/test/harness-event-bus.test.mjs`.
- [ ] **Red evidence:** remove the `signal` resolution option and require the pending test's signal assertion to fail. Remove the adjacent post-resolution `check(ctx)` and `registry.assertOperation(..., 'createSession')` as one grouped dispatch-fence mutant; neither deletion alone defeats the other. The pending test still rejects at the later check, but now `creates === 0` fails because the signal-ignoring synthetic adapter was called. Test the final post-create pair separately by holding `adapter.createSession`, revoking, then resolving `{}`; remove both final checks together and require session creation to reject (the mutant resolves). Remove epoch filtering and require the replacement `isLive(next) === true` assertion to fail. Remove/defer `onRetired` and require the immediately inspected `retired` array to fail. To isolate `isLive`'s operation check, use a registry stub whose `isCurrent` stays true but whose `assertOperation` starts throwing after creation, without emitting a fence; require `isLive(ref) === false`. Ordinary revocation removes the session and cannot kill that mutant. Keep terminal-error-before-close and late-output assertions as independent positive contracts; do not credit them to an unrelated guard deletion.
- [ ] **Commit:**

```bash
git add browser-first/host/harness-boundary.mjs browser-first/test/dsh-native-boundary.test.mjs
git commit -m "feat(harness): fence native runtime epochs and notify retirement"
```

### Task 8: Compose shared readiness, sanitize assembled output and invalidate chat cache

**Files:**
- Modify: `browser-first/host/harness-host-service.mjs`
- Modify: `browser-first/host/harness-transport.mjs`
- Create/test: `browser-first/test/dsh-native-host.test.mjs`
- Modify: `docs/architecture/MODULE-OWNERSHIP.md`

**Interfaces:**
- Consumes: Task 3 runtime factory; Task 7 `bindRuntime`, `isLive`, `onRetired`, `retireRuntime`; Task 6 native `probe`.
- Produces: `resolveAdapter(authorization,{signal,bindRuntime})`; shared Ready promise keyed by runtime epoch; transport sanitation wrappers; exact-reference cache retirement. `createHarnessHostService` adds trusted `nativeRuntimeFactory = createDshRuntime` only. No route accepts this injection.
- Shared readiness must hold an epoch-scoped transport capability while at least one authorized runtime lease exists. It must not depend on the lifetime of the first session's transport. `lease.readinessLease() -> sharedLease` creates this host-only capability; `sharedLease.dispose()` destroys only that capability, never a session lease. It has no independent process reference count and cannot keep an otherwise unowned child alive.

- [ ] **Write failing tests:**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createHarnessHostService } from '../host/harness-host-service.mjs';
const native = JSON.parse(await readFile(new URL('../host/harness-examples/deepseek-harness-native.json', import.meta.url)));
async function fixture(t, { sessionGate, retireBeforeCache = false } = {}) {
  let stored = null, epoch = 0, onFailure, resolves = 0, retiredOnCreate = false;
  const receipts = [], secret = randomBytes(24).toString('base64url');
  const host = await createHarnessHostService({ userRoot: '/safe/user', env: {},
    bindings: [{ name: 'dsh.native', addonId: native.id, adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: native.agentRuntime.endpoint, source: { managedDsh: true } }],
    store: { read: async () => stored, write: async value => { stored = structuredClone(value); } }, onReceipt: receipt => receipts.push(receipt),
    nativeRuntimeFactory(options) { onFailure = options.onFailure; return { close: async () => {} }; },
    transportFactory: async () => ({ epoch: `epoch-${epoch}`, runtimeSignal: new AbortController().signal, deadline: Date.now() + 30000,
      authenticate: async () => {}, markReady() {}, failRuntime() {}, dispose: async () => {},
      readinessLease: () => ({ ready() {}, fail: async () => {}, dispose: async () => {} }), sanitize: value => JSON.parse(JSON.stringify(value).split(secret).join('[redacted]')),
    }),
    dshAdapterFactory: () => ({ probe: async () => ({ protocolReady: true, providerAvailable: true }),
      createSession: async () => { resolves++; if (sessionGate) await sessionGate;
        if (retireBeforeCache && !retiredOnCreate) { retiredOnCreate = true; queueMicrotask(() => queueMicrotask(() => onFailure({ epoch: `epoch-${epoch++}`, code: 'runtime-unavailable' }))); }
        return {}; }, dispose: async () => {}, cancel: async () => {},
      async *invoke() { yield { type: 'delta', data: { text: secret.slice(0, 12) } }; yield { type: 'delta', data: { text: secret.slice(12) } }; yield { type: 'final', data: { text: secret } }; },
      history: async () => ({ messages: [{ role: 'assistant', content: secret }], hasMore: false }), status: async () => ({ status: 'idle', detail: secret }), modelCatalog: async () => ({ groups: [], detail: secret }), selectModel: async () => ({ selected: true, detail: secret }),
    }),
  });
  t.after(() => host.close());
  await host.registry.install(native, { enabled: true, expectedRevision: 0 });
  await host.registry.setGrants(native.id, native.requestedCapabilities.map(g => ({ ...g, granted: true })), { consent: true, expectedRevision: 1 });
  await host.registry.assignSlot('primary-agent', native.id, { expectedGeneration: 0 });
  return { host, secret, receipts, resolves: () => resolves, lateCrash() { onFailure({ epoch: 'epoch-0', code: 'runtime-unavailable' }); }, crash() { onFailure({ epoch: `epoch-${epoch++}`, code: 'runtime-unavailable' }); } };
}
test('native final and method results are sanitized before event/receipt publication', async t => {
  const f = await fixture(t), ref = await f.host.boundary.createSession({ addonId: native.id });
  const reader = f.host.boundary.events(ref); const turn = f.host.boundary.invoke(ref, { messages: [{ role: 'user', content: 'hello' }] });
  const event = (await reader.next()).value; assert.equal(event.type, 'final'); assert.equal(event.data.text, '[redacted]'); await turn.completion; await reader.return();
  const route = f.host.harnessRoutes.find(r => r.path === '/agent/history');
  const history = await route.handler({ session: ref });
  assert.ok(!JSON.stringify(history).includes(f.secret));
  for (const [path, payload] of [['/agent/status', { session: ref }], ['/agent/select-model', { session: ref, model: { provider: 'synthetic', model: 'synthetic' } }]]) {
    const result = await f.host.harnessRoutes.find(route => route.path === path).handler(payload); assert.ok(!JSON.stringify(result).includes(f.secret));
  }
  assert.ok(!JSON.stringify(await f.host.boundary.modelCatalog(ref)).includes(f.secret));
  assert.ok(!JSON.stringify(f.receipts).includes(f.secret));
});
test('idle runtime crash clears only matching compatibility session', async t => {
  const f = await fixture(t), input = { messages: [{ role: 'user', content: 'hello' }] };
  const one = await f.host.executeBridgeChat(input); const projection = f.host.registry.snapshot();
  f.crash(); const two = await f.host.executeBridgeChat(input);
  assert.notEqual(one.harness.sessionId, two.harness.sessionId); assert.equal(f.resolves(), 2);
  assert.deepEqual(f.host.registry.snapshot(), projection);
  assert.equal(f.host.boundary.isLive(one.harness), false);
});
test('cold chat starts reply clock after session allocation', async t => {
  let release; const sessionGate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { sessionGate }), original = globalThis.setTimeout; let replyClocks = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => { if (ms === 30000) replyClocks++; return original(callback, ms, ...args); });
  const pending = f.host.executeBridgeChat({ messages: [{ role: 'user', content: 'cold synthetic' }] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(replyClocks, 0);
  release(); await pending; assert.equal(replyClocks, 1);
});
test('late old-epoch retirement cannot erase replacement compatibility cache', async t => {
  const f = await fixture(t), input = { messages: [{ role: 'user', content: 'synthetic' }] };
  await f.host.executeBridgeChat(input); f.crash(); const replacement = await f.host.executeBridgeChat(input);
  f.lateCrash(); const reused = await f.host.executeBridgeChat(input);
  assert.equal(reused.harness.sessionId, replacement.harness.sessionId); assert.equal(f.resolves(), 2);
});

test('retirement callback compares each of the four reference fields', async () => {
  const source = await readFile(new URL('../host/harness-host-service.mjs', import.meta.url), 'utf8');
  const signature = '    onRetired(ref) {', start = source.indexOf(signature);
  const end = source.indexOf('\n    },', start);
  assert.ok(start >= 0 && end > start);
  const retire = new Function('compatibilitySession', 'ref', source.slice(start + signature.length, end) + '\nreturn compatibilitySession;');
  const current = { addonId: 'addon.native', sessionId: 'session', bootEpoch: 'boot', generation: 2 };
  assert.equal(retire(current, { ...current }), undefined);
  for (const key of Object.keys(current)) {
    const stale = { ...current, [key]: key === 'generation' ? 1 : 'old-' + current[key] };
    assert.equal(retire(current, stale), current, `retirement must compare ${key}`);
  }
});

test('retirement between session return and cache assignment cannot retain a dead reference', async t => {
  const f = await fixture(t, { retireBeforeCache: true }), input = { messages: [{ role: 'user', content: 'cache race' }] };
  await assert.rejects(f.host.executeBridgeChat(input));
  const next = await f.host.executeBridgeChat(input); assert.ok(next.harness.sessionId); assert.equal(f.resolves(), 2);
});

```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-host.test.mjs`. Expected: native delta is published and crash does not retire cached session.
- [ ] **Minimal implementation: composition.** Apply these exact edits; the readiness-lease implementation is specified immediately after them.

```bash
python3 - <<'PY'
from pathlib import Path
p=Path('browser-first/host/harness-host-service.mjs'); s=p.read_text()
s=s.replace("import { createHarnessCredentials }", "import { snapshotDshConfig, createDshRuntime } from './dsh-runtime.mjs';\nimport { createHarnessCredentials }")
s=s.replace('transportFactory = createHarnessTransport, dshAdapterFactory', 'nativeRuntimeFactory = createDshRuntime, transportFactory = createHarnessTransport, dshAdapterFactory')
s=s.replace('  const credentials = createHarnessCredentials({ bindings: approvedBindings, env });\n  const manifests = new Map(), resources = new Set();', '''  const manifests = new Map(), resources = new Set(), readyByEpoch = new Map();
  let boundary, compatibilitySession;
  const nativeConfig = snapshotDshConfig({ bindings: approvedBindings, env, userRoot });
  const nativeRuntime = nativeConfig ? nativeRuntimeFactory({ config: nativeConfig,
    onFailure({ epoch, code }) {
      readyByEpoch.delete(epoch);
      void boundary?.retireRuntime(epoch, code);
    },
    beforeStop: (epoch, signal) => Promise.allSettled([...resources].filter(resource => resource.epoch === epoch).map(resource => resource.cancel(signal))),
  }) : null;
  const credentials = createHarnessCredentials({ bindings: approvedBindings, env, nativeRuntime });''')
s=s.replace("['deepseek-harness', 'provider-chat-demo'].map", "['deepseek-harness', 'provider-chat-demo', ...(nativeConfig ? ['deepseek-harness-native'] : [])].map")
s=s.replace('  async function resolveAdapter(authorization) {', '  async function resolveAdapter(authorization, { signal, bindRuntime } = {}) {')
s=s.replace('runtime: authorization.runtime });\n      try { adapter = dshAdapterFactory', 'runtime: authorization.runtime, signal });\n      try { adapter = dshAdapterFactory')
anchor="      catch (error) { await bounded(() => transport.dispose()); throw error; }"
assert s.count(anchor)==1
s=s.replace(anchor,anchor+'''
      if (authorization.runtime.authScheme === 'dsh-native-cookie') {
        try {
          bindRuntime(transport.epoch);
          if (!readyByEpoch.has(transport.epoch)) {
            const sharedLease = transport.readinessLease();
            const ready = (async () => {
              const startupSignal = AbortSignal.any([transport.runtimeSignal, AbortSignal.timeout(Math.max(1, transport.deadline - Date.now()))]);
              let readinessTransport, readinessAdapter;
              try {
                readinessTransport = await transportFactory({ credentialLease: sharedLease, credentials, addonId: authorization.addonId, runtime: authorization.runtime, signal: startupSignal });
                await readinessTransport.authenticate({ signal: startupSignal });
                readinessAdapter = dshAdapterFactory({ transport: readinessTransport });
                const probe = await readinessAdapter.probe({ native: true, signal: startupSignal });
                if (!probe.protocolReady) throw fail('runtime-unavailable');
                sharedLease.ready();
              } catch (error) {
                await sharedLease.fail(startupSignal.aborted && !transport.runtimeSignal.aborted ? 'deadline-exceeded' : 'runtime-unavailable'); throw error;
              } finally { await readinessAdapter?.dispose(); await readinessTransport?.dispose(); await sharedLease.dispose(); }
            })();
            readyByEpoch.set(transport.epoch, ready); ready.catch(() => {});
          }
          let abortReady;
          try {
            await Promise.race([readyByEpoch.get(transport.epoch), new Promise((_, reject) => {
              abortReady = () => reject(fail('runtime-unavailable'));
              if (signal.aborted) abortReady(); else signal.addEventListener('abort', abortReady, { once: true });
            })]);
          } finally { signal.removeEventListener('abort', abortReady); }
          if (signal.aborted || transport.runtimeSignal.aborted) throw fail('runtime-unavailable');
        } catch (error) { await transport.dispose(); throw error; }
      }''')
s=s.replace('    const resource = {\n      async dispose(args)', '''    let upstream;
    const resource = {
      epoch: transport?.epoch,
      cancel: signal => upstream ? adapter.cancel?.({ session: upstream, signal }) : Promise.resolve(),
      async dispose(args)''')
s=s.replace('    return { ...adapter, dispose: resource.dispose,', '''    const native = authorization.runtime.authScheme === 'dsh-native-cookie';
    const methods = {};
    for (const name of ['history', 'modelCatalog', 'status', 'selectModel']) {
      if (native && typeof adapter[name] === 'function') methods[name] = async args => transport.sanitize(await adapter[name](args));
    }
    return { ...adapter, ...methods, dispose: resource.dispose,
      async createSession(args) { upstream = await adapter.createSession(args); return upstream; },''')
s=s.replace('        try { yield* await adapter.invoke(args); }', '''        try {
          for await (const frame of adapter.invoke(args)) {
            if (native && frame.type === 'delta') continue;
            yield native ? transport.sanitize(frame) : frame;
          }
        }''')
s=s.replace('  const boundary = createHarnessBoundary({ registry, resolveAdapter, cleanupTimeoutMs });', '''  boundary = createHarnessBoundary({ registry, resolveAdapter, cleanupTimeoutMs,
    onRetired(ref) {
      if (compatibilitySession && ['addonId', 'sessionId', 'bootEpoch', 'generation'].every(key => compatibilitySession[key] === ref[key])) compatibilitySession = undefined;
    },
  });''')
s=s.replace('  let compatibilitySession, compatibilityBusy = false;', '  let compatibilityBusy = false;')
s=s.replace('    let reader, timer, turn;', '    let reader, timer, turn, callSession;')
s=s.replace('        compatibilitySession = await boundary.createSession({ addonId: owner.addonId });', '''        const created = await boundary.createSession({ addonId: owner.addonId });
        if (!boundary.isLive(created)) throw fail('runtime-unavailable');
        compatibilitySession = created;''')
s=s.replace('      reader = boundary.events(compatibilitySession);', '      callSession = structuredClone(compatibilitySession);\n      reader = boundary.events(callSession);')
s=s.replace('session: structuredClone(compatibilitySession)', 'session: structuredClone(callSession)')
s=s.replace('boundary.invoke(compatibilitySession, input)', 'boundary.invoke(callSession, input)')
s=s.replace('harness: { ...compatibilitySession, turnId:', 'harness: { ...callSession, turnId:')
s=s.replace('boundary.cancel(compatibilitySession, turn.turnId)', 'boundary.cancel(callSession, turn.turnId)')
s=s.replace('        closing = boundary.close().catch(() => {}).then(() => Promise.allSettled([...resources].map(resource => resource.dispose({}))));', '''        const nativeStop = nativeRuntime?.close();
        closing = Promise.allSettled([nativeStop, boundary.close(), ...[...resources].map(resource => resource.dispose({}))]);''')
p.write_text(s)
PY
```

- [ ] **Minimal implementation: transport access to shared readiness.** Consume the already-defined `lease.readinessLease()` capability; it holds no extra process reference.

In `harness-transport.mjs`, change its constructor's destructuring from `{ credentials, addonId` to `{ credentials, credentialLease, addonId`; replace its lease acquisition with:

```js
  const lease = credentialLease ?? await credentials.acquire({ addonId, runtime, signal: acquisitionSignal });
```

Add to the native-only returned properties:

```js
      readinessLease: () => lease.readinessLease(),
```

- [ ] **Ownership update:** run this exact edit in the same task:

```bash
python3 - <<'PY'
from pathlib import Path
p=Path('docs/architecture/MODULE-OWNERSHIP.md'); lines=p.read_text().splitlines()
rows=['| `browser-first/host/harness-credentials.mjs` | Exact binding and shared epoch custody | Approved bindings and native leases | Cookie generation, single-flight exchange, readiness scope and late-output redaction | Process discovery, HTTP, consent or public secrets |', '| `browser-first/host/harness-transport.mjs` | Plugin/native authentication and bounded Typert transport | Credential leases and pinned direct guard | Cookie I/O, permitted retry, streams and sanitation | Spawn, grants, arbitrary routes/headers or manifest authority |', '| `browser-first/host/harness-host-service.mjs` | Harness routes, native readiness, assembled sanitation, compatibility cache and signed receipts | Approved bindings, pending signals, runtime epochs, registry and adapters | Shared readiness per epoch, exact-reference cache retirement and bounded resource drain | Grant inference, secret persistence, arbitrary process control or browser tools |', '| `browser-first/host/harness-boundary.mjs` | Authorized session identity and synchronous retirement | Registry authority, pending signals and host-bound runtime epochs | Abort signals, terminal events, exact-reference liveness and retirement notification | Runtime acquisition policy, credentials, transport or grants |']
output=[]
for line in lines:
 if line.startswith('| `browser-first/host/harness-credentials.mjs`'): output.extend(rows[:2])
 elif line.startswith('| `browser-first/host/harness-host-service.mjs`'): output.append(rows[2])
 elif line.startswith('| `browser-first/host/harness-boundary.mjs`'): output.append(rows[3])
 else: output.append(line)
p.write_text('\n'.join(output)+'\n')
PY
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-host.test.mjs browser-first/test/dsh-native-credentials.test.mjs browser-first/test/harness-host-service.test.mjs browser-first/test/harness-provider-dispatch.test.mjs`.
- [ ] **Red evidence:** remove native delta suppression and require the first published event to be `final` (the mutant publishes `delta`). Remove each assembled method wrapper separately and require the corresponding route result to omit the synthetic secret; remove final-frame sanitation and require `[redacted]`. Keep Task 10's split-history/token and signed-receipt test: transport sanitation of individual parts cannot mask the missing assembled-history wrapper. For four-field cache matching, drop each field from the comparison in turn and run the extracted production callback test with exactly that field different; unconditional clearing also fails it. The old-epoch host test alone is insufficient because boundary epoch filtering can prevent the callback from running at all. Remove pre-cache `isLive(created)` and require the cache-race test's next explicit chat to succeed: the mutant caches the dead reference and that next call fails.
- [ ] **Add targeted red cases before crediting the remaining host guards:** for `local per-call reference`, capture the 30-second timer callback during a held chat, retire its session (which clears the cache), invoke that captured callback with a spy replacing `boundary.cancel`, and assert the spy receives the original four-field reference and turn ID. Change only the timeout's `callSession` to `compatibilitySession`; it passes `undefined`, failing the reference assertion even though both chats reject. For shared readiness, hold the first authentication while two authorized acquisitions wait, cancel only the first, then release authentication; the second must reach Ready. Mutate readiness to reuse the first session's lease/transport instead of the shared capability; the second fails. For close-time drain, hold `nativeRuntime.close()` while resource disposal settles/expires; assert host close is still pending, then release the held stop and assert completion. Omit the native stop from the awaited set; the pending assertion fails. These cases need their own named assertions; a generic active-crash rejection does not prove any of them. Retain production composition coverage in Task 10.
- [ ] **Commit:**

```bash
git add browser-first/host/harness-host-service.mjs browser-first/host/harness-transport.mjs browser-first/test/dsh-native-host.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(harness): compose native readiness and retire cached chat sessions"
```

### Task 9: Give the bridge sole ownership of asynchronous signal shutdown

**Files:**
- Create: `browser-first/host/bridge-shutdown.mjs`
- Create/test: `browser-first/test/dsh-native-shutdown.test.mjs`
- Modify: `browser-first/host/opencode-client.mjs`, `browser-first/host/run-bridge-minimal.mjs`, `docs/architecture/MODULE-OWNERSHIP.md`

**Interfaces:**
- Consumes: `closeHarness() -> Promise<void>`, `closeOpenCode() -> Promise<void>`, `flushPrefs() -> Promise<void>`, `unsubscribe() -> void`, `closeServer() -> Promise<void>`.
- Produces: `createBridgeShutdown(options) -> () => Promise<void>`; `installBridgeSignals({processImpl = process, shutdown}) -> () => void`.
- Extends: `ensureOpencodeServer({fetchImpl,spawnImpl,command,hostname="127.0.0.1",port,cwd,env=process.env,sleep,maxWaitMs=12000,pollMs=300,processImpl=process,installSignalHandlers=true,pidRecord,pickEphemeralPort}) -> Promise<serverInfo>`; its synchronous `exit` hook remains registered regardless of that option. No DSH PID discovery is added to OpenCode.

- [ ] **Write the failing test:** create `browser-first/test/dsh-native-shutdown.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createBridgeShutdown, installBridgeSignals } from '../host/bridge-shutdown.mjs';
import { ensureOpencodeServer, resetOpencodeServerSingletonForTests } from '../host/opencode-client.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('repeated signals start native stop immediately and cannot exit before both owners settle', async () => {
  const native = deferred(), openCode = deferred(), calls = [], processImpl = new EventEmitter();
  processImpl.exit = code => calls.push(`exit:${code}`);
  const shutdown = createBridgeShutdown({
    closeHarness: () => { calls.push('native'); return native.promise; },
    closeOpenCode: () => { calls.push('opencode'); return openCode.promise; },
    flushPrefs: async () => { calls.push('prefs'); }, unsubscribe: () => calls.push('unsubscribe'),
    closeServer: async () => { calls.push('server'); },
  });
  const remove = installBridgeSignals({ processImpl, shutdown });
  processImpl.emit('SIGTERM'); processImpl.emit('SIGINT');
  assert.equal(calls.filter(x => x === 'native').length, 1);
  assert.equal(calls.filter(x => x === 'opencode').length, 1);
  assert.equal(calls.some(x => x.startsWith('exit:')), false);
  native.resolve(); await Promise.resolve(); assert.equal(calls.includes('server'), false);
  openCode.resolve(); await shutdown(); await Promise.resolve();
  assert.deepEqual(calls.filter(x => x.startsWith('exit:')), ['exit:0']);
  assert.equal(calls.filter(x => x === 'server').length, 1); remove();
});
test('failed cleanup still drains other owners and closes listener once', async () => {
  const wait = deferred(); let drained = false, closed = 0;
  const shutdown = createBridgeShutdown({ closeHarness: async () => { throw new Error('fixed test'); },
    closeOpenCode: async () => { await wait.promise; drained = true; }, flushPrefs: async () => {}, unsubscribe() {}, closeServer: async () => { closed++; } });
  const a = shutdown(), b = shutdown(); assert.equal(a, b); assert.equal(closed, 0);
  wait.resolve(); await a; assert.equal(drained, true); assert.equal(closed, 1);
});
for (const installSignalHandlers of [false, true, undefined]) test(`OpenCode signal ownership ${installSignalHandlers}`, async () => {
  resetOpencodeServerSingletonForTests();
  const processImpl = new EventEmitter(); processImpl.pid = process.pid; processImpl.exit = () => {};
  let killed = 0;
  const child = new EventEmitter(); child.pid = 42001; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { killed++; child.emit('exit', 0); };
  const info = await ensureOpencodeServer({ command: '/synthetic/opencode', cwd: '/synthetic', env: {}, processImpl,
    installSignalHandlers, pickEphemeralPort: async () => 45219,
    spawnImpl: () => { setImmediate(() => child.stdout.write('opencode server listening on http://127.0.0.1:45219\n')); return child; },
    fetchImpl: async (_url, options) => ({ status: options?.headers?.Authorization ? 200 : 401, ok: Boolean(options?.headers?.Authorization), text: async () => '{}' }),
    pidRecord: { read: async () => null, write: async () => {}, clear() {}, isAlive: () => false, commandOf: () => '', kill() {} },
  });
  assert.ok(info); assert.equal(processImpl.listenerCount('exit'), 1);
  assert.equal(processImpl.listenerCount('SIGTERM'), Number(installSignalHandlers !== false));
  assert.equal(processImpl.listenerCount('SIGINT'), Number(installSignalHandlers !== false));
  processImpl.emit('exit'); assert.equal(killed, 1);
  resetOpencodeServerSingletonForTests();
});
```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-shutdown.test.mjs`. After adding the module export shells, the behavioral red is premature exit or absent independent exit-hook registration. Record the failing assertions, not just a module import failure.
- [ ] **Minimal implementation:** create `browser-first/host/bridge-shutdown.mjs`:

```js
export function createBridgeShutdown({ closeHarness, closeOpenCode, flushPrefs, unsubscribe, closeServer }) {
  let closing;
  return function shutdown() {
    if (closing) return closing;
    let resolve;
    closing = new Promise(r => { resolve = r; });
    const invoke = fn => { try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); } };
    // Invoke the native fence synchronously at t0. No earlier await may defer it.
    const native = invoke(closeHarness);
    const openCode = invoke(closeOpenCode);
    const prefs = invoke(flushPrefs);
    const subscription = invoke(unsubscribe);
    void Promise.allSettled([native, openCode, prefs, subscription])
      .then(() => invoke(closeServer)).catch(() => {}).finally(resolve);
    return closing;
  };
}
export function installBridgeSignals({ processImpl = process, shutdown }) {
  let exiting;
  const handle = () => {
    if (!exiting) exiting = shutdown().finally(() => processImpl.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) processImpl.on(signal, handle);
  return () => { for (const signal of ['SIGINT', 'SIGTERM']) processImpl.removeListener(signal, handle); };
}
```

Apply the complete bridge and OpenCode edits:

```bash
python3 - <<'PY'
from pathlib import Path
p=Path('browser-first/host/opencode-client.mjs');s=p.read_text()
s=s.replace('let hooksInstalled = false;', 'let exitHooksInstalled = false;\nlet signalHooksInstalled = false;')
s=s.replace('  hooksInstalled = false;', '  exitHooksInstalled = false;\n  signalHooksInstalled = false;')
s=s.replace('  processImpl = process,\n  pidRecord', '  processImpl = process,\n  installSignalHandlers = true,\n  pidRecord')
s=s.replace('    processImpl,\n    pidRecord,', '    processImpl,\n    installSignalHandlers,\n    pidRecord,')
s=s.replace('  processImpl,\n  pidRecord,', '  processImpl,\n  installSignalHandlers,\n  pidRecord,')
s=s.replace('installShutdownHooks(processImpl);', 'installShutdownHooks(processImpl, installSignalHandlers);')
s=s.replace('function installShutdownHooks(processImpl) {\n  if (hooksInstalled) return;\n  hooksInstalled = true;', 'function installShutdownHooks(processImpl, installSignalHandlers) {')
s=s.replace('  processImpl.once?.("exit", killAll);\n  for (const sig', '  if (!exitHooksInstalled) { exitHooksInstalled = true; processImpl.once?.("exit", killAll); }\n  if (!installSignalHandlers || signalHooksInstalled) return;\n  signalHooksInstalled = true;\n  for (const sig')
assert 'hooksInstalled' not in s
p.write_text(s)
p=Path('browser-first/host/run-bridge-minimal.mjs');s=p.read_text()
s=s.replace("#!/usr/bin/env node\n", "#!/usr/bin/env node\nimport { createBridgeShutdown, installBridgeSignals } from './bridge-shutdown.mjs';\n", 1)
anchor='    command: resolveOpenCodeCommand(),';assert s.count(anchor)==1
s=s.replace(anchor,anchor+'\n    installSignalHandlers: false,')
start=s.index('const shutdown = async () => {')
s=s[:start]+'''const shutdown = createBridgeShutdown({
  closeHarness: () => harnessService.close(),
  closeOpenCode: () => openCodeBoundary.dispose(),
  flushPrefs: () => flushPendingExtensionPrefs(),
  unsubscribe: () => unsubscribeOpenCodeExecution(),
  closeServer: () => new Promise(resolve => bridgeInfo.server.close(resolve)),
});
installBridgeSignals({ shutdown });
'''
p.write_text(s)
p=Path('docs/architecture/MODULE-OWNERSHIP.md');s=p.read_text()
anchor='| `browser-first/host/dsh-runtime.mjs`';index=s.index(anchor)
s=s[:index]+'| `browser-first/host/bridge-shutdown.mjs` | Bridge signal and shutdown ordering | Explicit service-close callbacks | Idempotent concurrent drain | Process discovery, runtime policy, credentials or child escalation |\n'+s[index:]
p.write_text(s)
PY
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-shutdown.test.mjs browser-first/test/opencode-client.test.mjs browser-first/test/opencode-execution-revocation.test.mjs`.
- [ ] **Red evidence:** delay `closeHarness` until `closeOpenCode` resolves and require the first test's immediate native-call count to fail (zero instead of one). Remove `if (closing) return closing` from `createBridgeShutdown` and use the second test's direct `shutdown()` calls: `a === b` fails and both callbacks run twice; repeated signals alone would be masked by `exiting`. Separately remove the `if (!exiting)` condition in `installBridgeSignals` and require the first test's exactly-one-exit assertion to fail (two finally callbacks), while shutdown itself stays idempotent. Gate the exit hook with `installSignalHandlers` and require the false-mode `listenerCount('exit') === 1` assertion to fail. Restore each mutant before continuing.
- [ ] **Commit:**

```bash
git add browser-first/host/bridge-shutdown.mjs browser-first/host/opencode-client.mjs browser-first/host/run-bridge-minimal.mjs browser-first/test/dsh-native-shutdown.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "fix(bridge): drain native and OpenCode owners before signal exit"
```

### Task 10: Prove production composition with a real isolated fake executable

**Files:**
- Create: `browser-first/test/dsh-native-fake-child.mjs`
- Create/test: `browser-first/test/dsh-native-integration.test.mjs`
- Modify: no runtime file in this task; an assertion failure returns to its owning implementation task.

**Interfaces:**
- Consumes: the real `createHarnessHostService`, `createDshRuntime`, native example and `evaluateBridgeRequestForSelfTest(options)`; direct TCP HTTP/WebSocket traffic.
- Produces: a synthetic executable with the exact DSH launch arguments, boot announcement, cookie exchange, modelCatalog/create/page/prompt/cancel/selectModel RPCs and `session/follow` stream envelopes. It has no provider key or external network path. Test instrumentation wraps only `spawnImpl` to retain owned handles; authentication, transport, adapter, boundary and route checks are production implementations.

- [ ] **Write failing production tests:** create `browser-first/test/dsh-native-integration.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, access, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createPrivateKey, createPublicKey, verify } from 'node:crypto';
const fixtureSigningKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x46)]) });
import { canonicalReceipt, createHarnessHostService } from '../host/harness-host-service.mjs';
import { createDshRuntime } from '../host/dsh-runtime.mjs';
import { evaluateBridgeRequestForSelfTest } from '../host/bridge-server.mjs';
const waitFor = async predicate => { const end = Date.now() + 5000; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); assert.ok(predicate(), 'expected observation within five seconds'); };
async function setup(t, { occupied = false } = {}) {
  const root = await mkdtemp(join(homedir(), '.resonantos-dsh-test-'));
  const prefix = join(root, 'prefix'), dshHome = join(root, 'state');
  const packageDir = join(prefix, 'node_modules/@deepseek-ai/dsh');
  // Only chmod directories this fixture owns; never repair existing ancestors.
  await chmod(root, 0o700);
  for (const path of [prefix, join(prefix, 'node_modules'), join(prefix, 'node_modules/@deepseek-ai'), packageDir, join(packageDir, 'lib')]) {
    await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700);
  }
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', type: 'module' }), { mode: 0o600 });
  await copyFile(new URL('./dsh-native-fake-child.mjs', import.meta.url), join(packageDir, 'lib/bin.js'));
  await chmod(join(packageDir, 'package.json'), 0o600);
  await chmod(join(packageDir, 'lib/bin.js'), 0o600);
  let sentinelRequests = 0;
  const sentinel = createServer((request, response) => { sentinelRequests++; response.end('foreign'); });
  sentinel.listen(0, '127.0.0.1'); await once(sentinel, 'listening');
  const port = sentinel.address().port; assert.ok(port >= 1024 && port !== 19387);
  if (!occupied) await new Promise(r => sentinel.close(r));
  const manifest = JSON.parse(await readFile(new URL('../host/harness-examples/deepseek-harness-native.json', import.meta.url)));
  manifest.agentRuntime.endpoint = `http://127.0.0.1:${port}`;
  const binding = { name: 'dsh.native', addonId: manifest.id, adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: manifest.agentRuntime.endpoint, source: { managedDsh: true } };
  let promptCount = 0;
  const children = [], spawnOptions = [], receipts = [], privateTokens = [];
  const composition = { userRoot: join(root, 'user'), bindings: [binding], fixtureSigningKey,
    env: { RESONANTOS_DSH_PACKAGE_ROOT: prefix, RESONANTOS_DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY', NODE_OPTIONS: '--inspect', HTTP_PROXY: 'http://127.0.0.1:9', OPENAI_API_KEY: randomUUID() },
    onReceipt: value => receipts.push(value),
    nativeRuntimeFactory: options => createDshRuntime({ ...options, log() {}, spawnImpl(file, argv, options) {
      spawnOptions.push(options); const child = spawn(file, argv, options); children.push(child);
      let pending = ''; child.stdout.on('data', chunk => { pending += chunk.toString(); while (pending.includes('\n')) { const at = pending.indexOf('\n'), line = pending.slice(0, at); pending = pending.slice(at + 1); if (line === 'fixture-prompt') promptCount++; else if (line.startsWith('dsh web: ')) privateTokens.push(new URL(line.slice(9)).searchParams.get('token')); } });
      return child;
    } }),
  };
  let host = await createHarnessHostService(composition);
  t.after(async () => { await host.close(); if (sentinel.listening) await new Promise(r => sentinel.close(r)); await rm(root, { recursive: true, force: true }); });
  const bridgeToken = randomUUID(), capabilities = { 'addon-runtime-read': randomUUID(), 'addon-runtime-control': randomUUID() };
  const call = (url, body = {}, overrides = {}) => {
    const route = host.harnessRoutes.find(row => row.path === url.split('?')[0]);
    return evaluateBridgeRequestForSelfTest({ method: url.startsWith('/addons/registry') ? 'GET' : 'POST', url, body,
      routes: host.harnessRoutes, bridgeToken, bridgeCapabilityTokens: capabilities, listenerPort: 47773,
      headers: { host: '127.0.0.1:47773', 'x-resonantos-bridge-token': bridgeToken, 'x-resonantos-bridge-capability-token': capabilities[route?.requiredCapability] }, rawHeaders: ['Host', '127.0.0.1:47773'], ...overrides });
  };
  async function install() {
    assert.equal((await call('/addons/install', { manifest, enabled: true, expectedRevision: 0 })).status, 200);
  }
  async function grant(value, only) {
    assert.equal((await call('/addons/grants', { addonId: manifest.id, grants: manifest.requestedCapabilities.map(g => ({ ...g, granted: only ? (g.capability === only ? value : true) : value })), consent: true, expectedRevision: host.registry.snapshot().revision })).status, 200);
  }
  async function select() {
    assert.equal((await call('/addons/slots/assign', { slot: 'primary-agent', addonId: manifest.id, expectedGeneration: host.registry.snapshot().slots['primary-agent']?.generation ?? 0 })).status, 200);
  }
  return { root, dshHome, manifest, get host() { return host; }, children, spawnOptions, receipts, privateTokens,
    configure: async value => {
      const path = join(packageDir, 'lib/control.json');
      await writeFile(path, JSON.stringify(value), { mode: 0o600 }); await chmod(path, 0o600);
    },
    promptCount: () => promptCount, restart: async () => { await host.close(); host = await createHarnessHostService(composition); }, sentinel, sentinelRequests: () => sentinelRequests, call, install, grant, select };
}
test('route authority and grants precede process acquisition; two sessions share one child', async t => {
  const f = await setup(t), payload = { addonId: f.manifest.id };
  for (const headers of [{}, { 'x-resonantos-bridge-token': 'wrong' }]) assert.equal((await f.call('/agent/session', payload, { headers })).status, 401);
  await f.install(); assert.notEqual((await f.call('/agent/session', payload)).status, 200);
  assert.equal(f.children.length, 0);
  await f.grant(true); await f.select();
  const [a, b] = await Promise.all([f.call('/agent/session', payload), f.call('/agent/session', payload)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(f.children.length, 1);
  assert.notEqual(a.payload.session.sessionId, b.payload.session.sessionId);
  const childEnv = f.spawnOptions[0].env;
  assert.equal(childEnv.DSH_TELEMETRY_MODE, 'DISABLED');
  for (const key of ['NODE_OPTIONS', 'HTTP_PROXY', 'OPENAI_API_KEY']) assert.equal(childEnv[key], undefined);
  assert.ok(childEnv.HOME.startsWith(f.dshHome)); assert.equal(childEnv.DSH_HOME, f.dshHome);
  const input = { messages: [{ role: 'user', content: 'synthetic' }] };
  const readers = [a, b].map(r => f.host.boundary.events(r.payload.session));
  const turns = [a, b].map(r => f.host.boundary.invoke(r.payload.session, input));
  for (const reader of readers) {
    let final;
    for (let n = 0; n < 5; n++) { const { value } = await reader.next(); if (value.type === 'final') { final = value; break; } }
    assert.equal(final.data.text, 'synthetic answer'); await reader.return();
  }
  await Promise.all(turns.map(turn => turn.completion));
  assert.equal((await f.call('/agent/history', { session: a.payload.session })).status, 200);
  assert.equal((await f.call('/agent/select-model', { session: a.payload.session, model: { provider: 'synthetic', model: 'synthetic' } })).status, 200);
  await f.call('/agent/dispose', { session: a.payload.session }); assert.equal(f.children[0].exitCode, null);
  await f.grant(false); await waitFor(() => f.children[0].exitCode !== null || f.children[0].signalCode !== null);
  assert.notEqual((await f.call('/agent/session', payload)).status, 200); assert.equal(f.children.length, 1);
  await assert.rejects(access(join(f.dshHome, '.resonantos/lock')));
});
test('valid announcement plus stdout EOF can reach protocol Ready', async t => {
  const f = await setup(t); await f.configure({ closeStdoutAfterAnnouncement: true, catalogDelay: 100 });
  await f.install(); await f.grant(true); await f.select();
  const result = await f.call('/agent/session', { addonId: f.manifest.id });
  assert.equal(result.status, 200); assert.equal(f.children.length, 1);
  assert.equal(f.children[0].stdout.readableEnded, true); assert.equal(f.children[0].exitCode, null);
});
test('conflicting announcement during protocol probe prevents Ready', async t => {
  const f = await setup(t); await f.configure({ conflictingAnnouncement: true, catalogDelay: 100 });
  await f.install(); await f.grant(true); await f.select();
  const result = await f.call('/agent/session', { addonId: f.manifest.id });
  assert.notEqual(result.status, 200); assert.equal(f.children.length, 1);
  await waitFor(() => f.children[0].exitCode !== null || f.children[0].signalCode !== null);
});
test('foreign listener is never contacted or killed', async t => {
  const f = await setup(t, { occupied: true }); await f.install(); await f.grant(true); await f.select();
  const result = await f.call('/agent/session', { addonId: f.manifest.id });
  assert.notEqual(result.status, 200); assert.equal(f.children.length, 0);
  assert.equal(f.sentinelRequests(), 0); assert.equal(f.sentinel.listening, true);
});
test('idle compatibility crash starts a new epoch only for new explicit chat', async t => {
  const f = await setup(t); await f.install(); await f.grant(true); await f.select();
  const input = { messages: [{ role: 'user', content: 'synthetic' }] };
  const a = await f.host.executeBridgeChat(input), projection = f.host.registry.snapshot();
  const exit = once(f.children[0], 'exit'); f.children[0].kill('SIGTERM'); await exit;
  await new Promise(r => setTimeout(r, 30)); assert.equal(f.children.length, 1);
  const b = await f.host.executeBridgeChat(input);
  assert.equal(f.children.length, 2); assert.notEqual(a.harness.sessionId, b.harness.sessionId);
  assert.deepEqual(f.host.registry.snapshot(), projection);
  assert.ok(!JSON.stringify(f.receipts).includes('dsh-auth-'));
});
for (const capability of ['agent-runtime', 'network', 'filesystem', 'shell']) {
  test(`real pending and active sessions stop on ${capability} revocation`, async t => {
    const f = await setup(t); await f.configure({ startupDelay: 250, promptDelay: 250 });
    await f.install(); await f.grant(true); await f.select();
    const pending = f.call('/agent/session', { addonId: f.manifest.id });
    await waitFor(() => f.children.length === 1); await f.grant(false, capability);
    assert.notEqual((await pending).status, 200); assert.equal(f.promptCount(), 0);
    await waitFor(() => f.children[0].exitCode !== null || f.children[0].signalCode !== null);
    await f.grant(true);
    const created = await f.call('/agent/session', { addonId: f.manifest.id }); assert.equal(created.status, 200);
    const session = created.payload.session, reader = f.host.boundary.events(session);
    const turn = f.host.boundary.invoke(session, { messages: [{ role: 'user', content: 'slow synthetic' }] });
    await waitFor(() => f.promptCount() === 1); await f.grant(false, capability);
    const terminal = (await reader.next()).value; assert.equal(terminal.type, 'error');
    assert.equal((await reader.next()).done, true); await turn.completion;
    assert.equal(f.promptCount(), 1); assert.equal(f.host.boundary.isLive(session), false);
    await waitFor(() => f.children[1].exitCode !== null || f.children[1].signalCode !== null);
  });
}
test('clean restart persists governed consent but cannot reuse old sessions', async t => {
  const f = await setup(t); await f.install(); await f.grant(true); await f.select();
  const a = await f.call('/agent/session', { addonId: f.manifest.id }); assert.equal(a.status, 200);
  const before = f.host.registry.snapshot(); await f.restart(); const after = f.host.registry.snapshot();
  assert.notEqual(before.bootEpoch, after.bootEpoch); assert.deepEqual(before.slots, after.slots); assert.deepEqual(before.installations, after.installations);
  assert.notEqual((await f.call('/agent/turn', { session: a.payload.session, input: { messages: [{ role: 'user', content: 'stale' }] } })).status, 200);
  const b = await f.call('/agent/session', { addonId: f.manifest.id }); assert.equal(b.status, 200); assert.equal(f.children.length, 2);
  assert.notEqual(a.payload.session.bootEpoch, b.payload.session.bootEpoch);
  assert.ok(f.receipts.every(receipt => receipt.mode === 'fixture'));
});
test('crash during active chat fails once and never replays its prompt into replacement', async t => {
  const f = await setup(t); await f.configure({ promptDelay: 1000 }); await f.install(); await f.grant(true); await f.select();
  const input = { messages: [{ role: 'user', content: 'synthetic active crash' }] };
  const first = f.host.executeBridgeChat(input), failed = assert.rejects(first);
  await waitFor(() => f.promptCount() === 1);
  const exit = once(f.children[0], 'exit'); f.children[0].kill('SIGTERM'); await exit; await failed;
  assert.equal(f.children.length, 1); assert.equal(f.promptCount(), 1);
  await f.configure({}); await f.host.executeBridgeChat(input);
  assert.equal(f.children.length, 2); assert.equal(f.promptCount(), 2);
});

test('split token is sanitized after assembly in final history and valid signed receipts', async t => {
  const f = await setup(t); await f.configure({ splitSecret: true }); await f.install(); await f.grant(true); await f.select();
  const reply = await f.host.executeBridgeChat({ messages: [{ role: 'user', content: 'synthetic redaction' }] });
  const { turnId, ...session } = reply.harness;
  const history = await f.call('/agent/history', { session }); assert.equal(history.status, 200);
  assert.ok(f.privateTokens.length === 1);
  for (const token of f.privateTokens) {
    for (const value of [reply, history, f.receipts]) assert.equal(JSON.stringify(value).includes(token), false);
  }
  assert.ok(JSON.stringify(history).includes('[redacted]'));
  for (const receipt of f.receipts) {
    const { signature, ...body } = receipt;
    assert.equal(verify(null, Buffer.from(canonicalReceipt(body)), createPublicKey(fixtureSigningKey), Buffer.from(signature, 'base64')), true);
  }
});

```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-integration.test.mjs`. Before the fake executable exists, the copy fails. After creating it, remove only the runtime's port reservation temporarily and require the foreign-listener test's zero-child assertion to fail (the attempted child subsequently fails its bind). Prove the additional native grant floor in Task 1's isolated filesystem/shell cases; removing it alone does not bypass the first integration test's unassigned slot or existing agent-runtime/network requirements. Restore each guard before the green run. An absent fixture is not security evidence.
- [ ] **Minimal implementation:** create `browser-first/test/dsh-native-fake-child.mjs` with this complete executable. It uses only Node built-ins; the fixed WebSocket encoder handles the bounded synthetic messages used here, including masked client frames and ping/close frames.

```js
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const control = JSON.parse(await readFile(new URL('./control.json', import.meta.url), 'utf8').catch(() => '{}'));
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 5), ['--profile', 'web', '--no-open', '--host', '127.0.0.1']);
assert.equal(args[5], '--port');
const port = Number(args[6]); assert.ok(port >= 1024 && port <= 65535 && port !== 19387);
assert.equal(process.env.DSH_TELEMETRY_MODE, 'DISABLED');
const token = randomBytes(32).toString('base64url'), cookie = `dsh-auth-synthetic=${randomBytes(32).toString('base64url')}`;
const sessions = new Map(), sockets = new Set();
let exchanges = 0;
const catalog = { groups: [{ id: 'synthetic', models: [{ id: 'synthetic', name: 'Synthetic' }] }], default: { provider: 'synthetic', model: 'synthetic' } };
function frame(socket, value, opcode = 1) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = body.length < 126 ? Buffer.from([0x80 | opcode, body.length]) : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255]);
  socket.write(Buffer.concat([header, body]));
}
function emit(session, type, data) {
  const value = { type: 'event', event: { type, seq: ++session.seq, time: 1, data } };
  session.records.push(value);
  for (const socket of session.sockets) frame(socket, { type: 'item', streamId: 'augmentor', value });
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.origin, undefined); assert.equal(request.headers['x-augmentor-token'], undefined);
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/' && url.searchParams.get('token') === token) {
      exchanges++; assert.equal(exchanges, 1, 'initial concurrent sessions share exactly one exchange');
      response.writeHead(303, { location: '/', 'set-cookie': `${cookie}; HttpOnly; Path=/` }); response.end(); return;
    }
    if (request.headers.cookie !== cookie) { response.writeHead(401); response.end(); return; }
    assert.ok(url.pathname.startsWith('/api/session/'));
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks)); assert.equal(url.pathname, `/api/${rpc.method}`);
    const input = rpc.payload.args.request, method = rpc.method;
    let value = {}, state;
    if (method === 'session/modelCatalog') {
      if (control.conflictingAnnouncement) process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=conflict\n`);
      await new Promise(resolve => setTimeout(resolve, control.catalogDelay ?? 0));
      value = catalog;
    }
    else if (method === 'session/create') sessions.set(input.sessionId, { seq: 0, records: [], sockets: new Set() });
    else {
      state = sessions.get(input.sessionId ?? input.address?.sessionId); assert.ok(state);
      if (method === 'session/page') value = { records: state.records, hasMore: false };
      else if (method === 'session/prompt') {
        value = { accepted: true }; process.stdout.write('fixture-prompt\n');
        setTimeout(() => {
          emit(state, 'turn/start', {});
          emit(state, 'assistant/message', { message: { id: 'synthetic-message', content: control.splitSecret ? [{ type: 'text', text: 'synthetic answer ' }, { type: 'text', text: token.slice(0, 10) }, { type: 'text', text: token.slice(10) }] : [{ type: 'text', text: 'synthetic answer' }] } });
          emit(state, 'turn/end', {});
        }, control.promptDelay ?? 20);
      } else assert.ok(['session/cancel', 'session/selectModel'].includes(method));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } }));
  } catch { response.writeHead(500); response.end(); }
});
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/api/remote.mux' || request.headers.cookie !== cookie || request.headers.origin || request.headers['x-augmentor-token']) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket); let pending = Buffer.alloc(0), state;
  socket.on('error', () => {});
  socket.on('close', () => { sockets.delete(socket); state?.sockets.delete(socket); });
  function received(chunk) {
    pending = Buffer.concat([pending, chunk]);
    try {
      while (pending.length >= 2) {
        const opcode = pending[0] & 15, masked = (pending[1] & 128) !== 0; let length = pending[1] & 127, offset = 2;
        assert.ok(masked); assert.ok(pending[0] & 128); assert.notEqual(length, 127);
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
        if (pending.length < offset + 4 + length) return;
        const mask = pending.subarray(offset, offset + 4), body = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        pending = pending.subarray(offset + 4 + length);
        if (opcode === 8) { frame(socket, body, 8); socket.end(); return; }
        if (opcode === 9) { frame(socket, body, 10); continue; }
        assert.equal(opcode, 1);
        const open = JSON.parse(body); assert.equal(open.endpoint, 'session/follow'); assert.equal(open.streamId, 'augmentor');
        state = sessions.get(open.payload.args.request.address.sessionId); assert.ok(state); state.sockets.add(socket);
        frame(socket, { type: 'item', streamId: 'augmentor', value: { type: 'snapshot', cursor: state.seq, records: [], hasMore: false } });
      }
    } catch { socket.destroy(); }
  }
  socket.on('data', received); if (head.length) received(head);
});
setTimeout(() => server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=${token}\n`);
  if (control.closeStdoutAfterAnnouncement) process.stdout.end();
}), control.startupDelay ?? 0);
process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); });
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-integration.test.mjs` and `(umask 002; node --test browser-first/test/dsh-native-integration.test.mjs)`. Both must exercise the actual prefix walker before spawn. No skipped loopback, filesystem-permission or process tests count as a pass. A restricted runner must delegate this exact command to the conductor's permitted local environment.
- [ ] **Red evidence:** make the managed environment omit/override forced disabled telemetry and require the first test's successful session assertion to fail because the fake child's telemetry assertion aborts startup. Remove credential record reuse (`records.get(owned.epoch)`) so each acquired lease gets a fresh cookie record; the fake child's second exchange returns 500 and at least one session's `status === 200` fails. Make every runtime lease release call `stop(record)` and require the first-disposal assertion that the other session's child remains live to fail. Remove only port reservation: the sentinel test must fail `children.length === 0`, even though EADDRINUSE still refuses startup and zero sentinel traffic remains true. Remove `onRetired` cache clearing: the explicit post-crash chat rejects instead of returning a fresh session. Old-exit callback identity is proved by Task 3's direct captured-callback test, not by an OS child that emits exit only once. Grant-floor proof remains in Task 1, not a claim that this integration fixture kills it.
- [ ] **Announcement red evidence:** restore unconditional pre-Ready EOF rejection; `valid announcement plus stdout EOF can reach protocol Ready` must fail `result.status === 200`. For `conflicting announcement during protocol probe prevents Ready`, apply exactly the Task 2 persistent scanning mutant to `createDshAnnouncement`: add closure flag `captured`, test it at the start of **every** `write`, and set it plus return after the first `onToken(value)`. Reason through the trace: initial announcement captures token → authentication succeeds → catalog handler emits conflict in a later write → entry guard discards it → valid delayed catalog completes → `sharedLease.ready()` succeeds → session creation returns HTTP 200. Thus `assert.notEqual(result.status, 200)` must go red (actual 200); record that assertion, not a timeout or unrelated child-exit failure. A bare return after token capture affects only the current call and still parses this later conflict, so it is explicitly excluded from this proof. Kill that distinct bare-return mutant with Task 2's same-write test. Apply one specified mutant at a time, restore it and rerun this task's exact command before proceeding.
- [ ] **Commit:**

```bash
git add browser-first/test/dsh-native-fake-child.mjs browser-first/test/dsh-native-integration.test.mjs
git commit -m "test(harness): exercise native process through governed bridge composition"
```

### Task 11: Document separate native setup, recovery and live certification

**Files:**
- Create/test: `browser-first/test/dsh-native-docs.test.mjs`
- Modify: `docs/addons/harness-adapter-demo.md`, `browser-first/host/README.md`

**Interfaces:**
- Consumes: approved operator variables and fixed error/recovery vocabulary; Task 0 reviewed version observations.
- Produces: the `Native DSH authentication` section and its host README link. No installer, token input screen, default grants or automatic migration is introduced.

- [ ] **Write the failing test:** create `browser-first/test/dsh-native-docs.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('native operator documentation preserves isolation, consent and coexistence', async () => {
  const doc = await readFile(new URL('../../docs/addons/harness-adapter-demo.md', import.meta.url), 'utf8');
  const readme = await readFile(new URL('../host/README.md', import.meta.url), 'utf8');
  for (const text of ['## Native DSH authentication', 'RESONANTOS_DSH_PACKAGE_ROOT', 'RESONANTOS_DSH_HOME',
    'managedDsh', 'DSH_TELEMETRY_MODE=DISABLED', '50000', 'depth 64', '30 seconds', '3 seconds',
    'dsh-native-cookie', 'dsh-action-token', 'shell', 'filesystem', 'No automatic migration', 'No automatic restart',
    'DEEPSEEK_API_KEY', 'No provider key is required for protocol readiness', 'unconfirmed exit', 'local sink',
    '0.2.0-rc.2', '0.1.5-rc.1', '0.1.7-rc.2', 'anchor-missing', 'Runtime unavailable.']) assert.ok(doc.includes(text), text);
  assert.ok(readme.includes('../../docs/addons/harness-adapter-demo.md#native-dsh-authentication'));
});
```

- [ ] **Run red:** `node --test browser-first/test/dsh-native-docs.test.mjs`. Expected: missing native setup heading.
- [ ] **Minimal implementation:** append this complete Markdown section to `docs/addons/harness-adapter-demo.md`:

````markdown
## Native DSH authentication

Native DSH is an optional macOS/Linux harness using `dsh-native-cookie` and
`dsh-typert-v1`. The bridge owns a dedicated DSH web child; it captures the boot
login token from its private stdout pipe and exchanges it for a cookie in
memory. It does not use the Augmentor plugin. Windows native launch is refused.
Existing `dsh-action-token` plugin bindings keep working on their existing
platforms. No automatic migration or fallback occurs.

Use a dedicated, locally installed npm prefix containing
`node_modules/@deepseek-ai/dsh`, including its hoisted dependencies. Set
`RESONANTOS_DSH_PACKAGE_ROOT` to the absolute prefix, not `node_modules` or the
DSH package directory. Installation and updates are operator work; the bridge
never downloads or searches for DSH. Native mode currently admits only
`0.2.0-rc.2`. It was support-eligible in two of three conductor prerequisite runs; run 1's telemetry check was incomplete.
`0.1.5-rc.1` and `0.1.7-rc.2` are blocked because the observer found none of its
0.1.x source anchors (`anchor-missing`, probe line 352). All 0.1.x versions and
other unreviewed versions are refused for native use with `runtime-unavailable`:
`Runtime unavailable.` The fixed operator message is:
`Native DSH install prefix is unavailable or unsupported. Select a dedicated prefix with a supported local package and restart the bridge.`
The spec's 0.1.x/0.2.x ranges are candidate versions, not blanket launch
permission. Plugin mode's version behavior is unchanged. Production live
certification is still required for the exact eligible version and integrity.

The whole real prefix and every ancestor through `/` must be owned by the
current user or root and not writable by group/other. All regular files and
directories in the prefix must satisfy those rules. Symlinks are allowed only
when each hop stays inside the prefix, including npm `.bin` links. Dangling
links, cycles and special files are refused. Validation stops at 50000 entries,
depth 64, or the startup deadline. Do not use a temporary world-writable
ancestor, remove checks, or alter an existing install's permissions to force
acceptance. Select a dedicated compliant install.

Configure exactly one native binding per bridge. This is an example, not a
port default:

```json
{
  "name": "dsh.native",
  "addonId": "addon.deepseek-harness-native",
  "adapterId": "dsh-typert-v1",
  "authScheme": "dsh-native-cookie",
  "endpoint": "http://127.0.0.1:3081",
  "source": { "managedDsh": true }
}
```

Place that object in `RESONANTOS_HARNESS_BINDINGS`. Match its five public
identity fields to `browser-first/host/harness-examples/deepseek-harness-native.json`.
Choose an unused port from 1024 through 65535 and update both manifest and
binding together before restarting/reinstalling. The endpoint must have exactly
the illustrated form, without a trailing slash. No credentials, executable
paths or managed-home paths belong in the manifest.

`RESONANTOS_DSH_HOME` optionally selects an absolute dedicated home. Its default
is `<userRoot>/BrowserFirst/Harnesses/dsh-native`. The bridge refuses repository
paths, the OS home itself, `~/.dsh`, the Augmentor-managed DSH home and their
protected subtrees, symlinked managed paths, foreign content, mismatched markers
or an existing lock. Directories are created with mode 0700 and private marker
and lock files with mode 0600. The marker binds version, binding name and
canonical user root. It is not a credential. There is no automatic adoption,
permission repair or PID recovery. After an unconfirmed exit, inspect the
previously owned process and state manually; do not delete a lock merely
because a stored PID appears stale.

Without a native binding, neither native setting is read and no native child
starts. A configured native binding is not consent: explicitly install and
enable the native example, grant `agent-runtime`, `network`, `filesystem` and
`shell`, and assign `primary-agent` through existing governed add-on controls.
Missing or revoked floor capabilities deny execution before spawn. Demo mode
only offers the candidate when a native binding exists; it grants nothing.

Supply `DEEPSEEK_API_KEY` privately to the bridge process if model use requires
it. No provider key is required for protocol readiness. The native integration
does not read dotenv files, another app's credentials or Settings > Providers.
The child receives only LANG, LC_ALL, TZ and the optional DeepSeek key from the
parent, plus its isolated HOME, DSH_HOME, XDG paths, TMPDIR and fixed PATH.
Node options, proxies, desktop settings and unrelated provider keys are not
inherited. The bridge always forces `DSH_TELEMETRY_MODE=DISABLED`; there is no
telemetry opt-in setting for the managed child.

The child launches lazily after authorization. An occupied approved port is
never contacted or adopted. Startup, authentication and protocol validation
share 30 seconds. HTTP/socket opening uses a 10-second bound; follow readiness
uses 15 seconds. Direct turns use 120 seconds; browser chat retains its separate
30-second reply clock after startup and turn allocation. These are fixed bounds.

Sessions share one epoch cookie but have separate DSH sessions and transports.
The reviewed refresh map enables only `0.2.0-rc.2`: the conductor proved token
reuse, old-cookie/stream preservation and pre-dispatch 401. The blocked 0.1.x
versions are refused for native use, not offered as exchange-once fallbacks.
Unknown versions receive neither native admission nor refresh permission.
Lost responses, timeouts and uncertain accepted prompts are never replayed.
Native deltas are withheld; assembled replies and other outputs are sanitized
before events or signed receipts. Credentials and token-bearing output are
never logs, evidence files or browser projections.

No automatic restart occurs. A child exit retires old sessions; the next
explicit chat or session request may create a fresh child after confirmed
cleanup. Governance and grants persist; old session/turn references do not.
Last-lease release, revocation and bridge close fence authority immediately.
Cleanup has a total budget of 3 seconds: cancellation gets at most 1 second, TERM is
sent by 1 second, KILL by 2 seconds, and exit must be confirmed by 3 seconds.
Unconfirmed exit retains the lock and blocks reacquisition. Only the owned
child handle is signalled; desktop and plugin processes are untouched.

For migration, install the separate native identity alongside the plugin
identity and explicitly change `primary-agent` ownership. Switching back does
not kill the plugin service. The native child is stopped when its last lease
is released. Keep endpoint bindings and homes distinct.

Before calling an exact version certified, the conductor runs Task 0 in the
[native implementation plan](../planning/dsh-native-auth-plan.md), then the
production live lane in the [approved design](../planning/dsh-native-auth-design.md#live-lane).
The probe uses separate scratch HOME and DSH_HOME and never touches the user's
DSH home, desktop app or port 19387. It must exercise two overlapping sessions,
cookie reuse, pre-dispatch 401, no explicit Origin, missing/rejected provider
keys, a real reply, history, model selection, cancellation and in-memory secret
persistence checks. Feedback telemetry is tested with synthetic data: disabled
mode has zero exporter construction/export attempts/traffic; an enabled
positive control exports only to a local sink. An environment variable alone
is not telemetry evidence. Preserve sanitized version/integrity, counts and
human-visible browser proof outside the repository. A fixture is not live proof.
````

Append this complete paragraph to `browser-first/host/README.md`:

```markdown
### Optional native DSH

The opt-in `dsh-native-cookie` harness owns a dedicated local DSH web child on
macOS/Linux. Its operator-only `RESONANTOS_DSH_PACKAGE_ROOT` and optional
`RESONANTOS_DSH_HOME` settings are inspected only with a native binding.
Install/enable/grant/slot consent remains required; no child starts at bridge
startup. Follow [native setup, recovery and certification](../../docs/addons/harness-adapter-demo.md#native-dsh-authentication).
Plugin `dsh-action-token` bindings remain supported independently.
```

- [ ] **Run and pass:** `node --test browser-first/test/dsh-native-docs.test.mjs`, `npm run docs:check`, `npm run test:docs`.
- [ ] **Commit:**

```bash
git add docs/addons/harness-adapter-demo.md browser-first/host/README.md browser-first/test/dsh-native-docs.test.mjs
git commit -m "docs(harness): explain native isolation consent recovery and live gates"
```

### Task 12: Final deterministic checks and conductor live certification

**Files:**
- Create (conductor only): `/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/final-gate.json`
- Modify: no repository files.
- Test: `browser-first/test/dsh-native-policy.test.mjs`, `browser-first/test/dsh-native-runtime.test.mjs`, `browser-first/test/dsh-native-credentials.test.mjs`, `browser-first/test/dsh-native-transport.test.mjs`, `browser-first/test/dsh-native-readiness.test.mjs`, `browser-first/test/dsh-native-boundary.test.mjs`, `browser-first/test/dsh-native-host.test.mjs`, `browser-first/test/dsh-native-shutdown.test.mjs`, `browser-first/test/dsh-native-integration.test.mjs`, `browser-first/test/dsh-native-docs.test.mjs`.

**Interfaces:**
- Consumes: all prior green commits and their behavioral red records; Task 0 exact-package evidence; existing extension/browser surface and authenticated bridge routes.
- Produces: exact command outcomes and sanitized live proof outside the repository. No test-only success may be labelled live certification. No commit or PR may contain generated bridge config, scratch homes, credentials, transcripts or screenshots.

- [ ] **Write the failing completion assertion:** execute this complete assertion before collecting final evidence. A missing external result correctly fails:

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const gate = JSON.parse(await readFile('/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/final-gate.json', 'utf8').catch(() => '{}'));
const prerequisites = JSON.parse(await readFile('/path/to/2.0.0-alpha/.resonant-rig/dsh-native-task0/results.json', 'utf8'));
assert.equal(gate.deterministic, true);
assert.equal(gate.liveVersions?.length, 3);
for (const version of ['0.1.5-rc.1', '0.1.7-rc.2', '0.2.0-rc.2']) {
  const row = gate.liveVersions.find(row => row.version === version);
  assert.ok(row && ['certified', 'blocked'].includes(row.status));
  if (version !== '0.2.0-rc.2') assert.equal(row.status, 'blocked', '0.1.x cannot be certified under the recorded policy');
  if (row.status === 'blocked') { assert.ok(Array.isArray(row.blockedReasons) && row.blockedReasons.length); continue; }
  const prerequisite = prerequisites.find(r => r.version === version);
  assert.equal(prerequisite?.supportEligible, true, 'blocked prerequisite cannot be certified');
  for (const key of ['overlap', 'reply', 'history', 'modelSelection', 'cancel', 'revoke', 'crashRecovery', 'bridgeRestart', 'browserVisible', 'telemetry', 'noSecretPersistence', 'desktopUnaffected', 'pluginCoexistence']) assert.equal(row?.[key], true, `${version}: ${key}`);
}
JS
```

- [ ] **Run red:** the assertion above must fail before evidence exists. Do not author a pre-filled all-true file or treat a checkbox as an observation.
- [ ] **Minimal implementation:** no product code belongs in a certification task. Run these exact commands from the worktree, independently record each exit status, and return any failure to its owning task:

```bash
node --test browser-first/test/dsh-native-policy.test.mjs browser-first/test/dsh-native-runtime.test.mjs browser-first/test/dsh-native-credentials.test.mjs browser-first/test/dsh-native-transport.test.mjs browser-first/test/dsh-native-readiness.test.mjs browser-first/test/dsh-native-boundary.test.mjs browser-first/test/dsh-native-host.test.mjs browser-first/test/dsh-native-shutdown.test.mjs browser-first/test/dsh-native-integration.test.mjs browser-first/test/dsh-native-docs.test.mjs
npm run test:browser-first
npm run docs:check
npm run test:docs
node scripts/security-pipeline/run-check.mjs
npm test -- --run
npm run build
node --test --test-concurrency=1 scripts/module-ownership-doc.test.mjs
npm run verify:alpha
```

The shared TypeScript union and SDK validator change, so Vitest and build are mandatory. Run the existing plugin transport and OpenCode suites as part of `test:browser-first`; neither may be silently skipped.

- [ ] **Conductor-only live completion:** for the sole eligible Task 0 exact install, `0.2.0-rc.2`, use its isolated root and an unused approved port other than 19387 with the production bridge and native manifest. Perform the approved design's eight live-lane steps. Require a real attributed browser reply, two concurrent governed sessions under the selected cookie policy, history/model selection/cancel, active revocation, crash then fresh explicit session, clean bridge restart and old-reference rejection. Record prefix entry count/depth/walk time from a direct call to `validateDshPrefix(prefix, {deadline: Date.now()+30000})`; it returns no secrets. Observe the pre-existing desktop process only through the conductor's own app, keep it running and verify its companion before/after; never attach this integration to that process. Repeat plugin/native slot swaps on the separately pinned supported plugin setup. This plan's automated tests do not substitute for those human-visible observations. If any observation is unavailable, leave its boolean false and certification blocked.
- [ ] **Run and pass:** after the conductor writes actual sanitized observations to the external `final-gate.json`, rerun the assertion above and review the source commits plus red records. Retain `0.1.5-rc.1` and `0.1.7-rc.2` as `status: "blocked"` with the observer anchor blocker in `liveVersions`; neither may be certified or launched in native mode under this revision. Only `0.2.0-rc.2` may become `status: "certified"`, and only with every production observation true; otherwise record it as blocked too. Passing the accounting assertion is not an all-version support claim; report certified and blocked counts explicitly. The conductor must identify the governing issue before creating a PR into `dev`; issue 519 is a telemetry dependency, not automatically the governing native-auth issue.
- [ ] **Commit:** no extra commit is needed for an evidence-only task. Verify the branch and staged scope with these exact read-only commands; do not stage external evidence:

```bash
git branch --show-current
git status --short
git diff --check
git diff --cached --name-only
```

## Self-review

### Red-evidence audit for revision 2

This is a control-flow audit of every red-evidence step, not a claim that the
future implementation suites ran. Use the exact mutant/input/assertion pairs
in the tasks. A surviving single-line mutant with a second effective guard is
not evidence of a behavioral regression; grouped mutants are labelled as such.

| Step | Why the named observation goes red / qualification |
| --- | --- |
| Task 0 evidence accounting | Missing rows fail the three-version assertion. Existing conductor evidence has now been collected; that historical pre-observation failure is not to be reproduced by deleting evidence. Procedure unchanged. |
| Task 0 parser mutations | A restored handler-entry post-token return discards later chunks; the same-chunk case also kills a return inside capture. Removing conflict comparison leaves the failure latch unset; unconditional EOF rejection makes valid-token EOF fail. The existing named readiness/budget assertions distinguish these outcomes. Audited by reading only; this revision does not run Task 0. |
| Task 1 declarations/floor | Wrong adapter and loopback forms become valid without their native predicates. Additional filesystem/shell tests isolate the new floor from SDK dependencies, early install failures and hard-stop revocation; saved-load mutation enables the saved installation without resetting revision. |
| Task 2 config/prefix/home | Native settings Proxy detects an unauthorized read; valid malformed config cases reach each refusal. Existing outside targets remove ENOENT masking; link watchdog count and directory-cycle success distinguish cycle guards. Shared ownership/mode/type predicates, ancestor-only paths and exact limit boundaries isolate filesystem checks. Home tests assert protected paths, owner/marker modes, exclusive lock and confirmed-exit release; no separate home mutation claim was specified. |
| Task 2 parser/version | Persistent capture flag kills later-write conflict/budget; bare return kills same-write conflict. Origin reason distinguishes the remaining shape rejection. Exact-version refusal is independently tested; malformed semver needs the explicitly isolated policy seam. EOF and ordinary-banner bounds do not depend on token syntax. |
| Task 3 lifecycle | Shared `active` bypass lets a cancelled validation continuation spawn; final-release bypass stops a still-leased child. Captured old exit callback fences replacement. Unsafe unconfirmed-cleanup group permits a new acquisition; deleting only `blocked` checks is masked. Fake-clock assertions distinguish escalation timing. |
| Task 4 custody | Separate live lease isolates disposed access; overlapping/stale exchanges have exact counts. Epoch-loss `use` rejection kills the shared live-check bypass even though signal-aware wait still rejects. Exact full-string redaction distinguishes overlapping token/URL and cookie/value registrations. Binding mismatches and default refresh policy need their specified native inputs, not an injected always-true policy. |
| Task 5 transport | Two valid cookies isolate cardinality; 200 isolates status from connector redirect rejection. Oversized valid JSON isolates byte bounds. Explicit retry/diagnostic inputs distinguish counts and zero-diagnostic assertions. Separate HTTP/WS dispatcher mutants increment the observed proxy sink before assertion. |
| Task 6 readiness | Decoder bypass accepts malformed catalogs. An error envelope with a valid catalog value isolates `ok` rejection; absent value alone would still fail decoding. |
| Task 7 boundary | Grouped post-resolution checks permit an observable upstream create even when a later check still rejects; grouped final checks publish a revoked session. Operation-only denial isolates liveness from registry identity/fencing. Epoch filter and synchronous callback have direct replacement/reference assertions. |
| Task 8 composition | First delta and assembled output are directly inspected. Extracted callback inputs reach each cache comparator, bypassing unrelated epoch filtering. Cache-race follow-up distinguishes a stored dead reference. Targeted captured-timeout, two-waiter readiness and held-close tests are required to observe the remaining mutants; generic crash rejection is insufficient. |
| Task 9 shutdown | Held OpenCode close exposes delayed native stop. Direct repeated shutdown calls bypass signal deduplication; repeated signals expose duplicate exit callbacks separately. False-mode listener count isolates the independent exit hook. |
| Task 10 integration | Port mutant creates a child even though bind failure still rejects. Per-lease cookie records cause a second exchange rejected by the fake child. Early stop ends the other lease's child; omitted cache clear breaks explicit recovery. Persistent scanning mutant reaches HTTP 200 despite the later conflict; EOF mutant prevents HTTP 200. Floor and consumed exit-callback claims belong to Tasks 1/3. |
| Task 11 docs | Existing docs lack the native heading. Required policy/version/error literals also fail if omitted from the new section. This is a documentation content check, not runtime proof. |
| Task 12 final accounting | Missing gate yields `deterministic !== true`; no live evidence is invented. Additional version assertion prevents either blocked 0.1.x row being marked certified even with fabricated success flags. Accounting may pass with blocked rows; report exact certified/blocked counts. |

### Spec coverage

This is a plan coverage map, not a claim that implementation tests or live gates passed. Line references below refer to the approved design as read for this plan.

| Spec requirement | Implementation and verification task |
| --- | --- |
| Scope, optional Alpha add-on, native/plugin separation, macOS/Linux and no automatic detection/fallback (6–35) | Tasks 1, 2, 5, 8, 11; existing plugin suites in Tasks 5 and 12 |
| Exact native binding/source, one native binding, exact loopback endpoint, operator-only settings, lazy missing-package failure and ignored settings without native binding (87–139) | Tasks 1 and 2; configuration matrix and absent-binding Proxy guard |
| Dedicated real install prefix, ancestor ownership/mode through `/`, every hoisted entry, contained npm links, dangling/escaping/cyclic/special rejection (140–172) | Task 2 prefix walker and fake filesystem tests; Task 0 scratch inspection; Task 12 exact installed count/depth/time |
| Inclusive 50,000 entries, depth 64, proportional traversal and original startup clock (174–185) | Task 2 boundary tests; Task 3 pending-validation expiry; Task 0 refuses overflow |
| OS-home equality, protected DSH subtrees, valid dedicated default, shared-prefix sibling and repository exclusion (187–202) | Task 2 managed-home matrix |
| Private directory/marker identity, no adoption/chmod, exclusive PID/nonce lock, release only after confirmed owned exit, no PID recovery (204–239) | Tasks 2 and 3; lock collision, marker mismatch, mode, ownership, unconfirmed-exit tests |
| Synthetic HOME/XDG/TMPDIR/empty cwd, exact environment allowlist/PATH and forced disabled telemetry (224–254) | Task 2 environment/home tests; Task 10 actual spawn-options assertion; Task 0 feedback control; Task 11 operator policy |
| Lazy direct Node spawn, exact argv/shell/stdio, one child/shared launch/deadline, exclusive port reservation and no listener adoption (256–287) | Task 3 lifecycle tests; Task 10 real occupied sentinel; Task 0 isolated child procedure |
| Composition owns acquire/authenticate/validated probe/Ready, one readiness promise per epoch, provider separate, fixed 30s/10s/15s/120s clocks and browser reply clock placement (282–309) | Tasks 3–6 and 8; Task 8 held-session clock test; Task 12 live lane |
| Pending boundary cancellation before/after acquisition, last-live-waiter check before spawn, no queued revoked acquisition, one waiter cancellation preserves another (310–322) | Tasks 3, 4, 7 and 8; Task 10 each-floor startup revocation |
| Synchronous unexpected-exit fence, one terminal error, pending/active retirement, no replay/restart until explicit request and confirmed exit (324–345) | Tasks 3, 7 and 8; Task 10 idle/active crash tests |
| Four-field matching cache retirement, local call reference, post-await liveness, stale-notification isolation and unchanged governance (336–349) | Tasks 7 and 8; Task 10 recovery with unchanged projection |
| One stop clock: cancel ≤1s, TERM by1s, KILL by2s, confirmed exit by3s; retained lock and reacquisition refusal if unconfirmed; drain stops past adapter timeout (350–378) | Task 3 fake-clock test; Task 8 concurrent close; Task 9 bridge drain; Task 10 actual last-lease/revocation stop |
| Independent OpenCode exit/signal hooks, default preserved, bridge flag false, one idempotent asynchronous shutdown owner and no early parent exit (379–392) | Task 9, including true/false option tests and repeated signals; Task 12 conductor live check with both runtimes |
| Incremental complete LF/CRLF announcement, exact origin/path/query/token, banners discarded but counted, identical duplicate accepted, conflicting/malformed/truncated rejected, 16KiB line/1MiB pre-Ready total, silent post-Ready drain (394–430) | Tasks 2 and 3; chunk-by-byte, wrong authority, EOF and bound tests |
| Memory-only token/full URL/cookie/provider-key redaction; disposed leases cannot authenticate; usable secrets die with epoch but late-output patterns remain (432–449) | Task 4 lifecycle/redaction tests; Task 10 assembled-history and signed-receipt test; Task 0 in-memory persistence comparison |
| One shared cookie/generation/exchange; validated protocol readiness without mandatory provider key; exact unknown/structured outcome handling (450–472) | Task 0 provider/auth branches; Tasks 4, 6 and 8. Unknown provider structure blocks its version; no speculative text matcher. |
| Manual 303 login exchange, optional same-origin root Location, exactly one bounded live auth cookie, discard body and no SPA fetch (474–486) | Task 5 cookie/status/location tests; Task 0 actual exchange |
| Cookie-only native RPC/socket, no explicit Origin/action header/plugin route, fixed route allowlist, private proxy-free connectors for both modes (487–515) | Task 5 real HTTP/WebSocket proxy-sink test and route/header tests; Task 0 no-Origin observations; Task 10 executable refuses forbidden headers |
| Exact-version refresh gate; explicit pre-dispatch 401 only, shared single-flight, one retry/replacement, stale generation reuse, original deadline and no uncertain replay (517–539) | Task 0 positive/negative/unknown auth branches; Tasks 4 and 5; existing adapter replay tests |
| Suppress native deltas and sanitize assembled final/history/catalog/status/selection before publication/receipt; plugin output preserved (541–551) | Task 8 wrappers; Task 10 split-token final/history and valid signed receipts |
| Canonical SDK union and validator, native filesystem/shell floor joining agent-runtime/network, no inferred grants, saved/install/slot/operation denial and synchronous revoke (553–588) | Task 1 policy matrix; Task 7 fences; Task 10 route and each-floor revocation |
| Fixed public errors, safe operator recovery messages, no raw stderr/stdout/paths/tokens, port/home/package/deadline/exit/unconfirmed recovery (590–617) | Tasks 2–5 and 11; no raw error forwarding in proposed runtime/probe |
| 0.1.x/0.2.x strict semver including prereleases, three exact initial versions, metadata-only version discovery, separate manifest and opt-in demo/native-plugin coexistence (619–650) | Tasks 0, 1, 2, 8 and 11; Task 12 live version and plugin lane |
| Module ownership for new runtime and shifted existing responsibilities (653–680) | Runtime row in Task 2, custody/composition/boundary rows in Task 8; additional shutdown helper row in Task 9 |
| DSH-NATIVE-AUTH-1 and DSH-NATIVE-PROVIDER-1 before implementation; unknown facts are not assumed (682–726) | Task 0 conductor-only executable assertions and branch table; Tasks 4/6 cannot grant refresh/readiness support to the exact version with a blocked observation; other verified versions proceed |
| Deterministic unit guard evidence (730–803) | Tasks 1–9 contain focused red/green code and explicit one-guard-at-a-time fail-before-fix instructions |
| Production manager plus real HTTP/WS fake executable, real registry store, governed routes, overlap/revoke/crash/restart/sentinel, sanitized receipts (805–845) | Task 10; timing and shutdown unit cases in Tasks 3, 8 and 9; complete browser-first regression suite in Task 12 |
| Exact-package live protocol, browser visibility, feedback telemetry control, no persistence, desktop safety and plugin coexistence (847–882) | Task 0 for the prerequisite probes; Task 12 for production and human-visible certification; Task 11 instructions |
| Full deterministic command matrix, ownership and final cross-module Alpha certification (884–896) | Task 12 explicitly lists every new `.test.mjs`, browser-first, docs, security, Vitest, build, ownership and verify:alpha |

All review-1 accepted findings map to the rows above: G2/G9 and D2/D3/D6 → Tasks 2–3; G3/D1 → Tasks 0/4; G4 → Task 5; G5/D10 → Tasks 8/10; G6/D5 → Tasks 1–2; G7 → Tasks 0/6; G8/D4 → Tasks 0/5; G10/D8 → Tasks 3/8/9; D7 → Tasks 3/7; D9 → Task 8. The rejected cold-start claim is not implemented; the existing ordering is retained and tested. Review-2 home/prefix/cache/feedback/proxy findings map to Tasks 2, 8, 0 and 5 respectively. Review-3 whole-prefix finding maps to Tasks 0/2/3/12.

### Placeholder scan

The executable implementation blocks contain full functions or exact edits into named existing functions. Object spread/rest syntax is JavaScript, not omitted implementation. Spec metavariables such as `<port>` and `<userRoot>` are retained only as approved contract notation; runnable commands use concrete paths or declared variables. A blocked live outcome is an explicit stop branch, not a stand-in decoder.

Reproduce the planning scan without writing any additional file:

```bash
python3 - <<'PY'
from pathlib import Path
import re, ast, subprocess
text=Path('docs/planning/dsh-native-auth-plan.md').read_text()
body=text.split('## Self-review')[0]
for expression in [r'\bTODO\b',r'\bTBD\b',r'\bFIXME\b',r'similar to task',r'implementation goes here']:
 assert not re.search(expression,body,re.I), expression
for match in re.finditer(r'^```js\n(.*?)^```$',body,re.M|re.S):
 code=match.group(1)
 if code.lstrip().startswith(('async request(', 'async openStream(', 'readinessLease:')): code='const object = {\n'+code+'\n};'
 result=subprocess.run(['node','--check','--input-type=module'],input=code,text=True,capture_output=True)
 assert result.returncode==0, result.stderr
for match in re.finditer(r"python3 - <<'PY'\n(.*?)\nPY",body,re.S): ast.parse(match.group(1))
for task in re.split(r'^### Task \d+:',body,flags=re.M)[1:]:
 for field in ['**Files:**','**Interfaces:**','- [ ]','**Commit:**']: assert field in task, field
print('Plan syntax, task fields and omission-marker scan passed.')
PY
```

The syntax scan checks proposed snippets without loading runtime modules, launching DSH, executing the edit scripts, or modifying source files. The task-local green tests remain future execution requirements. In-memory comparison of edit anchors against current source is a planning check, not an implementation test.

### Name and signature consistency

| Producer | Consumer and checked contract |
| --- | --- |
| Task 1 native example | Tasks 2/4/8/10 use `addon.deepseek-harness-native`, `dsh.native`, `dsh-typert-v1`, `dsh-native-cookie`; public metadata is separated from `source: {managedDsh:true}`. |
| Task 2 `snapshotDshConfig`, `validateDshPrefix`, `prepareDshHome`, `createDshAnnouncement` | Task 3 uses `prefix`, `port`, `binding.endpoint`, `deadline`, `{entry,version}`, `{cwd,env,release}`, and `{write,end,ready}` exactly. |
| Task 3 `createDshRuntime` | Tasks 4/8 consume `acquire({signal})`, epoch `signal`, `deadline`, `version`, `use(callback)`, `ready()`, `fail(code)`, `release()` and `close()`. Failure callbacks are `{epoch,code}`. |
| Task 4 credential lease | Task 5 uses `use`, `authenticate(exchange,{signal,generation,refresh})`, `remember`, `sanitize` and `dispose`; Task 8's `readinessLease()` carries epoch access without a process reference. Exchange returns a validated cookie pair string. |
| Task 5 transport | Tasks 6/8 use `request`, `openStream`, `authenticate`, `sanitize`, `dispose`, `epoch`, `runtimeSignal`, `deadline`, and `readinessLease`; the latter is added by Task 8. `credentialLease` is the trusted optional constructor input for shared readiness. |
| Task 6 adapter | Task 8 calls `probe({native:true,signal})` and checks `protocolReady`; normal adapter session/method names remain unchanged. |
| Task 7 boundary | Task 8 passes `{signal,bindRuntime}` into resolution, receives `onRetired(ref)`, calls `retireRuntime(epoch,code)` and `isLive(ref)`. References are exactly `{addonId,sessionId,bootEpoch,generation}`. |
| Task 9 shutdown helper | Launcher supplies the five named cleanup callbacks. `installSignalHandlers` is passed through the public OpenCode function, private start helper, hook installation and bridge call site. |
| Task 10 fake executable | Runtime starts its copied `lib/bin.js` via the production argv. Its fixture-only control JSON is package-local synthetic data, not a production flag or a public route. Receipts use the existing deliberately public fixture signing seed. |

This second revision authors only this plan and `docs/planning/dsh-native-auth-plan-review-2.md`. The mutation audit is control-flow reasoning about proposed tests, with isolated syntax/parser checks reported in review-2; it is not an implementation or integration test run. Task 0's procedure remains unchanged and was not run by this reviser. The conductor's supplied outcome is recorded above: only `0.2.0-rc.2` is native-eligible, both reviewed 0.1.x versions are blocked, and production certification remains outstanding. No runtime implementation, package installation, browser interaction or commit is claimed.
