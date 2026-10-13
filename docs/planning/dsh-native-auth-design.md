# DSH native authentication design

Status: proposed design. This document does not implement or certify support.
The project owner approved the goal. Implementation remains separate.

## Decision and scope

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

## Evidence and current boundaries

Repository authority comes from [AGENTS.md](../../AGENTS.md),
[README.md](../../README.md), [the harness guide](../addons/harness-adapter-demo.md),
and [module ownership](../architecture/MODULE-OWNERSHIP.md).
The following code establishes the current behavior:

- `browser-first/host/harness-host-service.mjs` composes credentials, registry,
  transport, adapters, routes, receipts, and shutdown.
- `harness-registry.mjs` compares binding name, add-on ID, adapter ID, auth
  scheme, and exact endpoint. Its store persists governance, not credentials.
- `harness-policy.mjs` supplies the adapter capability floor.
- `harness-credentials.mjs` reads private file or environment sources. Its
  leases keep secret redaction patterns after disposal for late output.
- `harness-transport.mjs` obtains a login token through
  `/api/augmentor/auth`, exchanges it at `/?token=...`, and sends the cookie
  plus an action header on the WebSocket handshake.
- `agent-adapters/dsh-typert.mjs` owns session RPCs and follow snapshots. It
  waits for a follow snapshot before sending a prompt. Its tests cover retry,
  cancellation, late output, history, model selection, and text-only context.
- `harness-boundary.mjs` authorizes operations and fences sessions and output.
  It does not own process discovery or authentication.

The OpenCode precedent is concrete. `run-bridge-minimal.mjs` injects
`ensureOpencodeServer` into `createOpenCodeBoundary`.
`opencode-runtime.mjs` resolves the executable. `opencode-client.mjs` starts
`serve` with an argv array, captures the announced port, checks authenticated
readiness, and tracks the child. OpenCode also has persisted PID recovery.
Reuse the ownership pattern, not its Basic auth, PID recovery, or port fallback.
[ADR-021](../architecture/ADR-021-opencode-addon-hosted-service.md) provides the
hosted add-on context; the executable bridge path is the current launch evidence.

The owner-supplied 2026-10-08 probe is local experiment data. The files are
`.resonant-rig/livepass-dsh02/native.sh` and `native.mjs` under the parent
checkout, outside this worktree. It used a scratch `0.2.0-rc.2` install with no
Augmentor plugin.
It established these facts:

1. DSH prints `dsh web: http://127.0.0.1:<port>/?token=<t>` at boot.
   The login token was not persisted in DSH_HOME.
2. The login GET returns 303 and a `dsh-auth-*` cookie.
3. That cookie alone permits `session/create`, `session/modelCatalog`,
   `session/prompt`, and `session/page`.
4. `/api/remote.mux` upgrades with 101 using the cookie alone.

The probe's temporary token file and boot log are not production patterns.
Neither is its provider-key lookup. Do not copy or execute those parts.
The probe does not certify follow snapshots, cancellation, bridge governance,
shutdown, or every 0.1.x release. The plugin's npm release refusing DSH 0.2
is the reason to remove it from the native path, not to bypass its guard.

## Operator configuration

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
| `RESONANTOS_DSH_PACKAGE_ROOT` | Required for native launch only. Absolute path to an operator-installed `@deepseek-ai/dsh` package directory. No search through PATH, npm execution, download, or desktop bundle discovery. |
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
| Bridge composition | Malformed binding; duplicate native bindings; wrong adapter, scheme, source, or endpoint; nonempty relative package/home path; native binding on a platform other than macOS or Linux | Refuse bridge startup with the fixed configuration error. Reject a second native binding even if its name or endpoint differs. |
| First authorized native acquisition | Unset or empty package root; absent path; unreadable metadata; wrong package name; invalid or unsupported version; unsafe package tree; missing or invalid entry | Return `runtime-unavailable` for native use. Keep the bridge and other modes available. |
| First authorized native acquisition | Unsafe home, lock conflict, busy port, spawn, announcement, cookie, or protocol failure | Use the matching runtime error below. Never install or adopt a process. |

Snapshotting a path does not resolve or inspect it. Package and home filesystem
checks are lazy and follow authorization. Restart the bridge after changing
any setting. An unset package root is a missing runtime dependency, not a
malformed binding.

Resolve the package root with `realpath`. Check the canonical root and every
ancestor directory through filesystem root `/`, inclusive. Each must be owned
by root or the current user and satisfy `(mode & 0o022) === 0`. Do not stop at
the package's parent. A writable ancestor can permit replacement of the tree.
There is no sticky-directory exception. Scratch installs for this check must
use a private location with safe ancestors, not a shared temporary directory.

Walk every nested entry, including imported modules and dependencies. Use
`lstat` to distinguish links. Real directories and regular files must meet the
same ownership and mode rules. Reject special files. Allow npm's normal
symlinks, including entries in `node_modules/.bin`, only when every link hop
and the final resolved target stay inside the canonical package root. Use
path-component containment, not a string prefix. Reject escaping, dangling,
or unresolvable cyclic links. Check link ownership, but do not apply file mode
bits to the link itself. Symlink modes commonly include write bits and do not
control target access. Validate the target and its parent directories under
the same rules. Track visited canonical directories to avoid repeated walks
through aliases. Checking only `package.json` and `lib/bin.js` is insufficient.
Group or other read/execute permissions are allowed. The private credential-file
rule remains stricter and still rejects symlinks.

Validate package name and semver from `package.json`. Require `lib/bin.js` to
resolve inside the root. Complete validation before spawn. The operator must
keep the validated installation stable during use. This is a trust check, not
a sandbox against code or replacements by an already trusted owner. Never take
a package path from a manifest or route payload.

Use the bridge's absolute `process.execPath` to launch the validated entry:

```text
node <packageRoot>/lib/bin.js --profile web --no-open --host 127.0.0.1 --port <approvedPort>
```

This is a spawn argv array with `shell: false`, not a shell command string.
The program uses pipes for stdout and stderr and ignores stdin. It stays
attached to the bridge lifecycle. No login token or cookie appears in argv,
environment, a browser launch, or a health-check command.

## Isolated state and child environment

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

## Process lifecycle and endpoint ownership

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

## Token capture and credential lease

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

## Native transport protocol

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

## Registry, consent, and capability floor

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

## Errors and recovery

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
| Unset/empty package root, missing package, unsafe tree, bad entry, or unsupported version | `runtime-unavailable`: `Runtime unavailable.` | `Native DSH package is unavailable or unsupported. Select a supported local package and restart the bridge.` |
| Unsafe home or conflicting lock | `runtime-unavailable` | `Native DSH home is unavailable. Use a dedicated home and inspect any existing owner before retrying.` |
| Port busy or announcement endpoint mismatch | `runtime-unavailable` | `Native DSH could not use its approved port. Choose another port in both binding and manifest, then restart and reinstall the manifest.` |
| Missing announcement or readiness timeout | `deadline-exceeded`: `Runtime deadline exceeded.` | `Native DSH did not become ready within 30 seconds. Check the package and retry with a new session.` |
| Malformed announcement, child exit, failed cookie exchange, transport failure, or invalid protocol schema | `runtime-unavailable` | `Native DSH startup or authentication failed. Check the installed version and retry with a new session.` |
| Missing grants, binding mismatch, or forbidden operation | Existing `permission-denied` or `invalid-manifest` | `Native DSH requires its exact approved binding and explicit capability grants.` |
| Child exits during a session | Active stream terminates with `runtime-unavailable`; later references get `session-not-found`; the next user-submitted browser chat creates a fresh session after cleanup | `Native DSH stopped. Send a new chat request or create a new session. The previous turn was not retried.` |
| Recognized model/provider rejection | The probe records provider unavailability without failing protocol readiness. An affected public operation returns sanitized `runtime-unavailable`; no provider-triggered child stop. | `Native DSH could not complete the request. Check its model and provider configuration.` |
| Stop deadline exceeded | Local authority remains fenced | `Native DSH exit could not be confirmed. Inspect the owned process before reusing its home or port.` |

A route that loses ownership during startup keeps the existing
`ownership-conflict` result. Runtime failure emits the fixed terminal error
before closing the session's event bus. No subsequent output is accepted.
Do not add UI controls or a raw diagnostic download to explain these errors.

## Version handling and coexistence

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

For migration, configure the native binding and package, restart the bridge,
install the native example, explicitly grant its requests, and replace the
primary-agent slot using the existing generation check. Assign chat-interface
separately if wanted. Old plugin sessions retire through the current boundary.
The external plugin process is never stopped. It may continue serving the
desktop app. Switching back uses the same explicit slot transaction.

Changing an existing native manifest's endpoint requires vacating its slots
and reinstalling it. Reinstallation resets its grants, as today. There is no
silent rewrite of manifests, consent, endpoints, or stored owners. Neither mode
imports the other's sessions, cookies, home, or transcripts. Removing plugin
support requires a separate decision.

## Ownership rows for the implementation

Update [module ownership](../architecture/MODULE-OWNERSHIP.md) in the future
implementation PR. This spec-only change does not edit that map.

| Owner | Reads | May mutate | Must not own |
| --- | --- | --- | --- |
| New `browser-first/host/dsh-runtime.mjs` | Validated operator config, package metadata, boundary authorization signal, owned child pipes | Dedicated home and lock, child handle, bounded boot parser, runtime epoch, captured token lifetime | Grants, registry persistence, HTTP auth, RPC semantics, desktop discovery, or foreign process cleanup |
| `harness-credentials.mjs` | Exact approved binding and injected runtime source | Shared epoch credential record, cookie generation, single-flight exchange coordination, lease access, retained redaction patterns, runtime lease release | Process configuration, slot ownership, public secret projection |
| `harness-transport.mjs` | Credential lease and pinned endpoint | Native or plugin exchange I/O, HTTP/WebSocket requests, bounded retry policy, narrow sanitation method | Spawning, grants, arbitrary RPCs, or manifest authority |
| `agent-runtime-endpoint.mjs` | Approved endpoint and connection inputs | Direct proxy-disabled connections, guarded sockets, internal handshake status, manual redirect responses | Token extraction, cookie semantics, process ownership |
| `agent-adapters/dsh-typert.mjs` | Authenticated transport and authorized chat input | Existing Typert sessions, follow state, model and history projections | Auth selection, credentials, process lifecycle, tools or approval authority |
| `harness-host-service.mjs` | Operator config, registry authorization, runtime failure and session retirement notifications | Shared readiness orchestration, compatibility-session cache invalidation, per-call chat identity, adapter resources, native delta suppression and assembled-result sanitation, bounded shutdown | Parsing child output, implementing login exchange, or granting consent |
| `harness-boundary.mjs` | Registry authorization and injected lifetime notifications | Pending-session cancellation, epoch-associated retirement, synchronous retirement notifications, host-only session liveness check, output fences | Concrete DSH process handling or credentials |
| `harness-policy.mjs` | Reviewed adapter and auth scheme, declarations and grants | Pure scheme-specific floor and revocation decisions | Config, processes, credentials, or persistence |
| `harness-registry.mjs` and `harness-registry-store.mjs` | Validated manifests, binding metadata, durable governance | Existing consent, slots, revisions, generations, atomic records | Child handles, login tokens, cookies, runtime health or home paths |
| `src/core/contracts.ts` and canonical SDK validation | Declarative runtime fields | Auth scheme vocabulary and validation | Runtime authority or executable configuration |
| `run-bridge-minimal.mjs` | Process environment and service factories | Pass config and await service shutdown | New DSH domain behavior or new routes |
| `opencode-client.mjs` | Host-only signal-registration option from bridge composition | Preserve owned-child exit cleanup while leaving final bridge exit to the launcher | DSH behavior or changes to OpenCode auth and streams |
| `browser-first/test/` | Fake children, fixed protocols, isolated test configuration | Test-local state and explicit live evidence outside the repo | Product authority or fixture-as-live claims |

The new privileged crossings are owned process launch, isolated filesystem
state, and login-token capture. Existing `/agent/session` remains protected by
bridge auth, loopback Host/origin checks, and `addon-runtime-control` before
runtime grants are evaluated. Existing read/control route capabilities stay
unchanged. No SDK manifest gains an executable or filesystem path field.
The implementation also updates the harness guide and component instructions
to distinguish both modes. It does not change the Alpha runtime boundary.

## Required verification before implementation

These gates are pending. Run them before implementing the affected native auth
or readiness policy. Use isolated scratch packages and in-memory credentials.
Keep only sanitized results, exact versions, and package integrity hashes in
external evidence. The historical probe and this checkout do not establish
the following DSH server behavior. Do not infer it from plugin client code.

### DSH-NATIVE-AUTH-1: shared cookie and token reuse

For each exact target version, exchange the boot token once. Create two
sessions using that one cookie and overlap real turns. Exchange the same token
again while a follow stream is active. Check the original and replacement
cookies with read-only RPC and fresh socket openings. Observe existing streams
and count upstream prompt dispatches. Separately induce an auth 401 before
RPC dispatch and during follow opening. Check the replacement-cookie path.
Record only pass/fail facts, never token URLs, cookies, or prompt content.

| Observed answer | Required design behavior |
| --- | --- |
| Token is reusable; old cookies and active streams remain valid; an explicit 401 rejects before RPC dispatch | Permit the bounded shared refresh described above. Both sessions must finish with one prompt dispatch each. |
| Re-exchange rejects, invalidates an older cookie, or interrupts an active stream | Exchange only once per epoch. Disable in-place refresh for that verified package. On a confirmed 401, fence the epoch and require a new explicit session after cleanup. Never replay a prompt. |
| An explicit 401 can follow RPC dispatch | Disable refresh and replay even if token reuse works. Fence the epoch on confirmed 401. Require a new explicit session after cleanup. Never resend the uncertain prompt. |
| The answer is unknown or the required observations cannot be made | Block implementation of refresh and any support claim for that package until the gate resolves. Do not assume the optimistic branch. |

Record the selected behavior in the implementation's reviewed package evidence
and tests. This is not runtime auth auto-detection, a plugin fallback, or an
operator flag. Two sessions still share one cookie in every branch.

### DSH-NATIVE-PROVIDER-1: readiness without provider configuration

For each target version, start with no provider key and then with a rejected
key. Observe authenticated modelCatalog, session creation, and model use.
Validate response structure in memory. Determine whether provider rejection
has a stable machine-readable shape distinct from auth and schema failures.

| Observed answer | Required design behavior |
| --- | --- |
| Catalog succeeds, including an empty groups array | Mark Ready after catalog validation. Report any later model/provider rejection on that operation. |
| Catalog returns a distinct valid provider/model rejection | Validate that exact structured shape in the adapter. Mark protocol Ready with provider availability false. Keep the child and report the fixed provider error when the operation requires it. |
| Rejection is indistinguishable from auth or malformed protocol | Do not guess or mark Ready. Treat readiness as unproven and block native support for that package pending a separate design decision. Do not silently require a key or bypass schema validation. |

Also confirm cookie-only WebSocket opening with no explicit Origin for each
version. If rejected, block that version's native lane. Do not add an invented
Origin or change plugin headers without a separate verified protocol decision.

## Test and acceptance plan

### Unit tests with a fake DSH child

Inject spawn, filesystem, clock, and connector dependencies into the host
owners. A fake child emits split stdout chunks and tracks argv, environment,
signals, and exit. Generate test secrets at runtime. Never store real probe
logs or credentials in fixtures.

- Verify exact argv, `shell: false`, isolated paths, minimal environment, and
  forced telemetry disablement even when the parent requests telemetry.
- Verify no spawn on registry reads, install, grant, or slot selection. Verify
  concurrent authorized sessions share one child and failed callers release it.
- Exercise split UTF-8, CRLF, repeated announcements, malformed URLs, foreign
  hosts, wrong ports, duplicate queries, missing tokens, overflow, early exit,
  missing stdout, and each deadline. Include banners before and between valid
  announcements. Capture all logs and search for secrets.
- Deny unsafe homes, managed-path symlinks, nonempty unmarked directories, foreign markers,
  concurrent locks, busy ports, invalid packages, and unsupported platforms.
  A foreign listener must receive zero HTTP requests and zero signals.
- Reject the OS home itself. Accept an empty dedicated descendant, including
  the documented default. Reject both `~/.dsh` and the documented desktop DSH
  home, plus an empty descendant of each. Test component containment with a
  sibling whose name merely shares the protected path's prefix.
- Accept an npm-style internal `.bin` symlink and an internal directory alias.
  Reject an escaping link, an escaping intermediate hop, a dangling link, and
  a link-resolution cycle. Reject a group-writable imported module or link
  target, a writable nested directory, and a foreign owner. Test a safe package
  under a writable immediate parent and under a writable higher ancestor.
  Both must fail before spawn. Test group and other write bits separately.
  Verify the walk reaches `/` and terminates for repeated directory aliases.
- Verify SIGTERM, escalation, confirmed exit, stuck stop, bridge shutdown, and
  a late old-child exit after replacement. No orphaned startup promise may
  publish a usable lease after cancellation.
- Verify native 303 exchange, cookie validation, absent Origin, cookie-only RPC
  and WebSocket headers, and absence of all plugin calls and action headers.
- Keep plugin token-file ownership, symlink, environment source, exchange,
  action-header, DNS, redirect, and response-bound tests unchanged and passing.
- Verify the selected DSH-NATIVE-AUTH-1 branch. Test simultaneous refresh from
  two sessions, stale-generation 401, handshake 401, generic socket failure,
  second 401, lost prompt response, 5xx, redirect, timeout, and epoch change
  during refresh. Assert one exchange per epoch when refresh is disabled.
  An uncertain accepted prompt must execute at most once.
- Run both DSH transport modes with bridge `NODE_USE_ENV_PROXY=1`, `HTTP_PROXY`,
  `HTTPS_PROXY`, and `ALL_PROXY` pointed at a test sink, with `NO_PROXY` unset.
  Also inject a hostile global dispatcher. The sink must receive zero traffic.
  The direct loopback server must still receive auth, RPC, and socket requests.
- Test no native binding with missing or invalid native settings, then one and
  two native bindings. Test each row of the configuration/runtime failure split.
- Test an empty valid catalog, a verified provider rejection, an unknown error,
  a malformed catalog, and an auth failure as separate readiness outcomes.
- Try token and cookie echoes in errors, headers, nested JSON, model names,
  history split across two parts, encoded forms, and split assistant chunks.
  Assert assembled history and its signed receipt redact the split secret.
  Scan public replies,
  events, receipts, terminal output, and test-owned persisted files. Verify
  disposed leases still sanitize late output and never authenticate again.
- Run existing DSH adapter and stream cases in both modes. Retain follow
  snapshot ordering, cancellation barriers, no stale replay, bounded text,
  ignored reasoning, model selection, and unavailable tool callbacks.
- Test the native capability floor at install, saved-registry load, slot
  eligibility, and every operation. Removing any required request or grant
  must prevent launch. Plugin floor behavior must remain unchanged.

### Composition through the bridge

Use a small fake DSH executable with real loopback HTTP and WebSocket endpoints.
Launch it through the production runtime manager. Compose the real bridge,
registry store, credentials, transport, Typert adapter, and boundary. Do not
replace the native auth layer with an already-authenticated mock adapter.

Drive authenticated routes to install, grant, assign, create, prompt, read
history/status, select a model, cancel, and dispose. Test absent bridge auth,
wrong Host/origin, missing route capability, binding mismatch, missing native
floor grants, and stale references. Assert denials precede spawn and dispatch.

Revoke each native floor capability during startup and during a turn. Check
the synchronous fence, rejected late output, closed streams, and termination
of the owned child after its final lease is released. Replace the primary
owner, disable it, and close the bridge while startup is pending. Exercise
two overlapping sessions. Disposing one must not kill the other's child or
clear its cookie. Apply the selected refresh policy and count prompt dispatches.
Exercise a slow cold startup followed by a prompt through `/augmentor/chat`.
Verify the reply timer starts after session creation and turn allocation.
Startup expiry sends no prompt. Reply expiry cancels only the allocated turn.

After a successful `/augmentor/chat`, exit the native child while keeping the
add-on ID, slot generation, and grants unchanged. The next user-submitted chat
must create a new session and child after cleanup and return a fresh reply.
Repeat with exit during an active chat. That call must fail once; its prompt
must never reach the replacement child. Old references still fail. Verify
late retirement cannot clear the new cache, and retirement between session
creation and cache assignment cannot leave a stale reference. Check timeout
cancellation uses the call's local reference after cache invalidation. Repeat
with revoked grants and unconfirmed cleanup; both must prevent a new child.

Restart against the same registry and managed home after clean shutdown.
Consent and owners persist. Child epoch, login token, cookies, bridge boot
epoch, and session references do not. Old requests fail. A new session gets a
fresh reply. Assert no token or cookie in governance, generated bridge config,
home files, receipts, or captured logs. Keep an unrelated sentinel DSH listener
and home running throughout; both must remain unchanged.
Also run with the existing OpenCode child active. Send SIGINT and SIGTERM to
the bridge in separate cases. Verify neither runtime forces an early parent
exit, both owned children receive cleanup, and the DSH stop deadline is honored.

### Live lane

Run the three exact versions above from separate scratch package installs and
managed homes outside the repository. Install no Manolo/Augmentor plugin.
Supply provider credentials privately through the permitted environment.
Require all of these checks for each version:

1. Complete DSH-NATIVE-AUTH-1 and DSH-NATIVE-PROVIDER-1 first. Then verify the
   production bridge captures stdout in memory and exchanges the token.
   No helper file transports the token. Confirm cookie-only RPC and 101 upgrade
   without explicit Origin. Repeat the selected shared-cookie policy with two
   overlapping sessions through the governed bridge.
2. Observe a real follow snapshot, prompt acceptance, attributed assistant reply,
   history, model selection, and cancellation. A 101 upgrade alone is insufficient.
3. Exercise revocation, child termination, fresh session after a crash, and
   clean bridge restart. Verify old references and output cannot be reused.
4. Observe a reply in the existing browser surface. Preserve sanitized evidence
   and exact versions outside the repository. Fixture receipts cannot pass live.
5. Confirm telemetry is disabled in the effective child configuration. Inspect
   the exact installed web profile to verify DISABLED constructs no OTel
   exporter and excludes desktop product analytics. Startup and a real turn
   alone do not exercise the documented FEEDBACK_ONLY export path. Exercise
   rating/comment feedback with synthetic session data in the isolated live
   harness. Observe exporter construction and export attempts as well as direct
   outbound traffic. Verify the observation mechanism with a separate enabled
   control whose exports terminate at a local test sink. Never send the control
   data to the public collector. The managed child always uses DISABLED and
   must make zero telemetry export attempts. Provider traffic is expected.
   Missing source or feedback-path observations leave the gate unproven.
6. Check the dedicated state for accidental login-token or cookie persistence
   using in-memory comparisons. Emit only pass/fail, never matches or secrets.
7. Keep the user's desktop DSH running on its own port and home. Confirm its
   process, home, and companion still work after native start, stop, and failure.
8. Re-run the existing plugin lane on its pinned supported 0.1.x setup and
   switch owners between modes. Verify no plugin process is killed.

Do not rerun the historical shell probe as the production certification lane.
Its result informs the design, while this lane proves the governed composition.

For the future implementation, run `npm run test:browser-first`,
`npm test -- --run`, `npm run build`,
`node scripts/security-pipeline/run-check.mjs`, `npm run docs:check`,
`npm run test:docs`, and the ownership check
`node --test --test-concurrency=1 scripts/module-ownership-doc.test.mjs`.
Run `npm run verify:alpha` for final cross-module certification.
Record exact commands and blockers. None of those future runtime checks is
claimed by this design document. This spec-only task requires the two docs
checks and verification that only this spec and its review-2 record changed.

## Self-review

- Review coverage: Both round-2 reviews were read in full. The final revision
  [review-2 adjudication](dsh-native-auth-design-review-2.md) accepts all three
  new Important findings and both new Minor findings. Rejected: 0. Deferred: 0.
  The [review-1 adjudication](dsh-native-auth-design-review-1.md) remains the
  historical record of 19 accepted findings and one rejected startup-race
  claim. Its rejection still matches `harness-host-service.mjs:351` through `:373`.
- Internal consistency: One native binding owns one child and one epoch cookie.
  Composition owns readiness. Credentials own shared secret state. The boundary
  owns authorization. Startup and browser reply clocks remain separate.
  Retirement clears the matching browser cache without changing governance.
  A later user request creates a fresh session. Failed prompts are never replayed.
- Ambiguity check: OS-home equality and DSH-home subtree bans are separate.
  Package checks permit contained npm links and validate ancestors through `/`.
  Tests cover protected homes and descendants, writable ancestors, link escape,
  child-exit chat recovery, and stale cache notifications. Plugin compatibility
  includes the stated proxy-bypass hardening. Telemetry proof exercises feedback.
- Evidence limits: DSH-NATIVE-AUTH-1 and DSH-NATIVE-PROVIDER-1 remain mandatory
  before implementation of their affected policies. Each has outcome rules.
  This revision claims no live token-reuse, provider-error, Origin, or telemetry
  result. No support claim can substitute a fixture for the live lane.
- Scope check: Plugin-free native mode, a bridge-owned child, memory-only token
  and cookie custody, disabled telemetry, and working plugin mode remain fixed.
  No runtime code, installer, supervisor, UI, route, or embed design is added.
  The referenced embed decisions file is absent from this worktree. No embed
  decision is inferred or changed.
