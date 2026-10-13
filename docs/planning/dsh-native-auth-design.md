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
DSH support, embedded DSH UI, automatic session recovery, or provider-settings
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
binding, no DSH child starts and current behavior is unchanged.

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
| `RESONANTOS_DSH_PACKAGE_ROOT` | Required absolute path to an operator-installed `@deepseek-ai/dsh` package directory. No search through PATH, npm execution, download, or desktop bundle discovery. |
| `RESONANTOS_DSH_HOME` | Optional absolute path. Default is `<userRoot>/BrowserFirst/Harnesses/dsh-native`, outside the repository. This is the child's actual DSH_HOME. |
| `DEEPSEEK_API_KEY` | Optional bridge environment value forwarded only to the native child. Missing means no key is injected. Provider setup errors appear on model use. No lookup in another application's credentials. |
| `RESONANTOS_HARNESS_DEMO` | Existing default remains off. Enabling it offers the separate native example only when a native binding is configured. It grants nothing. |

These values are read once when composing the bridge. There are no new bridge
CLI flags, dotenv reads, settings persistence, hot reload, or arbitrary child
arguments. Invalid native configuration refuses bridge startup with a fixed
configuration error. An absent or incompatible package is a runtime failure
on the first authorized session request, not an install attempt.

Resolve the package root to a canonical absolute directory. Validate its
package name and semver version from `package.json`. Require `lib/bin.js` to
resolve inside that root and be a regular file. Reject a package tree whose
root or selected launch files are writable by other users. Permit root or the
current user as owner. The operator-approved package remains trusted code.
Never take a package path from a manifest or route payload.

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
the real user home, and any nonempty unmarked directory. On first use, create
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

Add one host-only `dsh-runtime.mjs` module. It manages at most one child per
native binding and bridge. Concurrent acquisitions share one startup promise.
Each child gets a fresh in-memory runtime epoch and lifetime abort signal.
That epoch is separate from the registry's boot epoch and slot generation.

| State | Transition |
| --- | --- |
| Stopped | An authorized session creation acquires the first runtime lease and starts a child. Registry reads, installation, grants, and slot assignment do not spawn. |
| Starting | Lock and port checks pass; spawn succeeds; wait for the exact boot announcement. |
| Announced | Token and endpoint are captured. The transport performs native authentication and the adapter probes modelCatalog. No session reference is returned yet. |
| Ready | Authenticated probe succeeds. Authorized sessions share this child, each with its own transport lease and DSH session. |
| Stopping | Last lease is released, all runtime authority is revoked, initial readiness fails, or the bridge closes. New acquisitions wait for cleanup. |
| Failed | Initial startup, child exit, or cleanup fails. Associated sessions are retired. No background restart occurs. |

Before spawn, try an exclusive TCP bind to the approved loopback port, then
close the reservation. If busy, do not make an HTTP request to that listener.
Report a port conflict. There is no available-port fallback. The bind-to-spawn
race is handled by child failure or an announcement mismatch, never by
adopting a listener. DSH must announce exactly the approved origin and port.
No health success without an owned, still-live child and its captured token
counts as readiness.

The startup deadline is 30 seconds from acquisition through token exchange
and modelCatalog validation. Each HTTP or WebSocket opening also retains the
existing 10-second transport bound, capped by the remaining startup deadline.
There is no startup retry loop. Follow readiness retains its 15-second bound
and turns retain their 120-second bound. These are constants, not new env flags.
Concurrent waiters share the first launch's deadline. Later transport leases
against a ready child authenticate within the existing 10-second request bound.
Their authentication failure retires only that lease's session. Failure of the
initial readiness probe fails the shared startup and stops that child.

Propagate the boundary's pending-session abort signal through adapter
resolution, runtime acquisition, and transport startup. Recheck registry
authorization before spawn, after acquisition, and before returning a session.
A revoked or timed-out pending session releases its lease even if startup
settles late. One cancelled waiter must not stop a child still needed by
another authorized waiter. No queued acquisition survives its authorization.

An unexpected child exit fences that runtime epoch synchronously. Composition
notifies the boundary to emit one fixed `runtime-unavailable` terminal error
on each active stream, then abort and retire all associated pending and active
sessions. It closes streams and suppresses late output. New calls using retired references
return `session-not-found`. A new explicit session request may start one new
child after confirmed cleanup, with a new runtime epoch, token, and cookies.
It cannot replay a prompt or reconnect an old session. The registry does not
silently change owners or grants to recover a process failure.

Releasing one session disposes its adapter and transport. The final lease
release stops the child, including after slot replacement, disablement, or
revocation that disables session creation. A turn-only cancellation uses
`session/cancel` and keeps the session's runtime lease. It does not kill other
sessions. Dependency-only revocation preserves the current policy semantics.

On stop, first fence authority and abort network work. Attempt bounded adapter
cancellation. Send SIGTERM to the exact live child handle, wait up to one
second, then SIGKILL if it is still live, and wait one more second. Cleanup is
idempotent. Track the stop promise separately from the existing one-second
adapter cleanup race. `harnessService.close()` must drain runtime stop promises
before the launcher exits. Its total native-runtime drain budget is three
seconds. A synchronous exit hook may only best-effort signal owned live handles.

The bridge must own the final exit on SIGINT and SIGTERM. Today OpenCode can
register another signal handler that calls `process.exit()` immediately.
Add a host-only `installSignalHandlers` option to `ensureOpencodeServer`,
defaulting to true for existing callers. Bridge composition passes false at
its `ensureServer` injection into the OpenCode boundary. Retain OpenCode's synchronous
exit cleanup hook. The bridge's one idempotent shutdown promise drains both
services before exiting. This is a lifecycle integration change only; OpenCode
authentication, session behavior, and streams stay unchanged.

Never signal a process found by port, name, desktop configuration, or a saved
PID. Never signal an already-exited handle to clean up guessed descendants.
If exit cannot be confirmed, retain the lock and refuse another launch.
SIGKILL of the bridge and detached descendants cannot be guaranteed clean.
Report that limit; do not add process discovery or a daemon supervisor here.
Late callbacks must check the runtime epoch so an old exit cannot clear a
replacement child or its secrets.

## Token capture and credential lease

Decode stdout incrementally as UTF-8. Accept only a complete line beginning
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
Only the transport receives these values. Add a private cookie setter that
validates, remembers, and replaces the cookie. Native runtime leases retain
the captured login token for reauthentication while the child lives. Each
transport keeps its cookie in its own credential lease. Cookie refresh is
single-flight within that transport, not global across unrelated sessions.

Register the login token, full login URL, cookie pair, cookie value, and their
supported encoded forms with the existing recursive sanitizer before any
response can escape. Include the injected provider key in native output
redaction. The adapter receives methods, never credentials. Neither receipts,
public errors, event streams, diagnostics, manifests, registry files, generated
bridge config, nor browser storage may contain them.

Native mode publishes status and final replies, with `supportsStreaming: false`
as in the current DSH example. Its host wrapper suppresses public delta frames
and sanitizes the assembled final frame again through the transport's narrow
sanitizer method. This prevents a credential split across upstream text chunks
from escaping through deltas or signed receipts. History and model responses
remain sanitized before returning. Plugin output behavior stays unchanged.

Disposal clears usable token and cookie references and releases the runtime
lease. Retain redaction patterns while late callbacks can still run, as today.
Drop those objects once cleanup completes. JavaScript cannot promise physical
erasure of immutable strings. No application-level secret persistence, debug
dump, or heap snapshot is part of this design.

## Native transport protocol

Keep authentication in `harness-transport.mjs`. Use the existing endpoint guard
for every connection. Native authentication runs before the first session RPC:

1. GET `/?token=<encoded login token>` with manual redirects and no cookie.
2. Require status 303. An optional Location must resolve to `/` on the same
   approved origin. Inspect it; never follow it.
3. Require exactly one valid `dsh-auth-*` cookie pair, using the current
   name/value grammar and an 8192-byte pair limit. Reject missing, duplicate,
   expired, or conflicting authentication cookies. Ignore unrelated cookies.
   Never create a general cookie jar or persist response headers.
4. Store only `name=value` in the lease. Cancel the response body without
   reading the SPA. Make a read-only modelCatalog probe through the adapter
   and require its response validation to pass. The current `probe()` checks
   only the RPC envelope. Extend it to reuse the catalog decoder from
   `modelCatalog()` without needing a created session. An empty valid catalog
   proves protocol readiness, not provider readiness. This shared validation
   also applies to plugin probes and confers no new authority.

Session RPCs send only the cookie and normal JSON content headers. The native
`/api/remote.mux` handshake sends the cookie and the exact approved Origin.
It sends neither a token query nor `x-augmentor-token`. No plugin route appears
in the native request allowlist. Keep the current plugin branch, including its
auth exchange and WebSocket action header, intact.

An explicit RPC 401 permits one cookie refresh using the captured token and
one replay, provided that the same child epoch is still live and authorized.
Discard the rejected cookie before refresh. A second 401 retires the affected
session with `runtime-unavailable`. There is no mode switch or new child inside
that retry. Timeouts, disconnects, redirects, parsing errors, and 5xx responses
never cause a replay. A failed WebSocket opening fails that attempt; a later
explicit operation may open a fresh follow stream under existing adapter rules.
It does not resend an uncertain prompt.

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
| Invalid host configuration | Bridge startup refused | `Invalid native DSH configuration. Check the native binding and DSH settings, then restart the bridge.` |
| Missing package, bad entry, unsupported version or platform | `runtime-unavailable`: `Runtime unavailable.` | `Native DSH package is unavailable or unsupported. Select a supported local package and restart the bridge.` |
| Unsafe home or conflicting lock | `runtime-unavailable` | `Native DSH home is unavailable. Use a dedicated home and inspect any existing owner before retrying.` |
| Port busy or announcement endpoint mismatch | `runtime-unavailable` | `Native DSH could not use its approved port. Choose another port in both binding and manifest, then restart and reinstall the manifest.` |
| Missing announcement or readiness timeout | `deadline-exceeded`: `Runtime deadline exceeded.` | `Native DSH did not become ready within 30 seconds. Check the package and retry with a new session.` |
| Malformed announcement, child exit, failed cookie exchange or protocol probe | `runtime-unavailable` | `Native DSH startup or authentication failed. Check the installed version and retry with a new session.` |
| Missing grants, binding mismatch, or forbidden operation | Existing `permission-denied` or `invalid-manifest` | `Native DSH requires its exact approved binding and explicit capability grants.` |
| Child exits during a session | Active stream terminates with `runtime-unavailable`; later references get `session-not-found` | `Native DSH stopped. Create a new session. The previous turn was not retried.` |
| Model or provider rejection | Existing sanitized `runtime-unavailable` | `Native DSH could not complete the request. Check its model and provider configuration.` |
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
| `harness-credentials.mjs` | Exact approved binding and injected runtime source | Host-only token/cookie leases, redaction patterns, runtime lease release | Process configuration, slot ownership, public secret projection |
| `harness-transport.mjs` | Credential lease and pinned endpoint | Native or plugin auth exchange, HTTP/WebSocket requests, cookie refresh, bounded sanitation | Spawning, grants, arbitrary RPCs, or manifest authority |
| `agent-runtime-endpoint.mjs` | Approved endpoint and connection inputs | Guarded sockets and manual redirect responses | Token extraction, cookie semantics, process ownership |
| `agent-adapters/dsh-typert.mjs` | Authenticated transport and authorized chat input | Existing Typert sessions, follow state, model and history projections | Auth selection, credentials, process lifecycle, tools or approval authority |
| `harness-host-service.mjs` | Operator config, registry authorization, runtime failure notifications | Runtime composition, adapter resources, native final-output sanitation, bounded shutdown | Parsing child output, implementing login exchange, or granting consent |
| `harness-boundary.mjs` | Registry authorization and injected lifetime notifications | Pending-session cancellation, epoch-associated retirement, output fences | Concrete DSH process handling or credentials |
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
  missing stdout, and each deadline. Capture all logs and search for secrets.
- Deny unsafe homes, symlinks, nonempty unmarked directories, foreign markers,
  concurrent locks, busy ports, invalid packages, and unsupported platforms.
  A foreign listener must receive zero HTTP requests and zero signals.
- Verify SIGTERM, escalation, confirmed exit, stuck stop, bridge shutdown, and
  a late old-child exit after replacement. No orphaned startup promise may
  publish a usable lease after cancellation.
- Verify native 303 exchange, cookie validation, exact Origin, cookie-only RPC
  and WebSocket headers, and absence of all plugin calls and action headers.
- Keep plugin token-file ownership, symlink, environment source, exchange,
  action-header, DNS, redirect, and response-bound tests unchanged and passing.
- Verify only one replay after explicit 401. Test simultaneous refresh callers,
  second 401, lost prompt response, 5xx, redirect, timeout, and child replacement
  during refresh. An uncertain accepted prompt must execute at most once.
- Try token and cookie echoes in errors, headers, nested JSON, model names,
  history, encoded forms, and split assistant chunks. Scan public replies,
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
two sessions so disposing one cannot kill the other's child.

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

1. The production bridge captures stdout in memory and exchanges the token.
   No helper file transports the token. Confirm cookie-only RPC and 101 upgrade.
2. Observe a real follow snapshot, prompt acceptance, attributed assistant reply,
   history, model selection, and cancellation. A 101 upgrade alone is insufficient.
3. Exercise revocation, child termination, fresh session after a crash, and
   clean bridge restart. Verify old references and output cannot be reused.
4. Observe a reply in the existing browser surface. Preserve sanitized evidence
   and exact versions outside the repository. Fixture receipts cannot pass live.
5. Confirm telemetry is disabled in the effective child configuration and by
   observing outbound traffic during startup and a real turn. Provider traffic
   is expected; product analytics and OTel export traffic is not. Inability to
   observe the setting or traffic leaves the telemetry gate unproven.
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
checks and verification that only this file changed.

## Self-review

- Placeholder scan: No unresolved design placeholders or missing decisions.
  Angle-bracket values in protocol and argv examples identify runtime inputs.
- Internal consistency: Fixed endpoint approval matches manifest validation,
  port selection, startup capture, and transport pinning. Runtime epochs retire
  sessions without changing persisted consent. Both secrets stay host-only.
- Scope check: One native authentication mode, one owned child manager, shared
  Typert behavior, and retained plugin mode. No installer, generic supervisor,
  new UI, new route, plugin removal, or implementation is included.
- Ambiguity check: Configuration, defaults, platform limits, deadlines, retries,
  last-lease shutdown, crash recovery, grant requirements, and certification
  claims are explicit. Local probe facts are separate from repository authority
  and from the live gates still required.
