# Harness adapter demonstration

A harness add-on supplies an agent runtime behind a reviewed host adapter. The
React shell requests installation, consent and primary-agent ownership through
the authenticated local bridge; the host registry decides whether a turn may
execute. Installing a manifest grants nothing. This opt-in development demo does
not change the [Alpha runtime boundary](../architecture/ALPHA_RUNTIME_BOUNDARY.md):
the supported Alpha remains the Chrome extension plus the local Node.js bridge.

## Manifest and host binding

The private demonstration catalog contains
[DeepSeek Harness](../../browser-first/host/harness-examples/deepseek-harness.json)
and [Provider Chat Demo](../../browser-first/host/harness-examples/provider-chat-demo.json).
They are exposed only when the host is composed with `RESONANTOS_HARNESS_DEMO=1`;
they are not public catalog entries.

The `agentRuntime` contract identifies `invocationTool`, `chatAuthorLabel`,
`displayNameSource`, `supportsStreaming`, `supportsCancellation`,
`supportsModelSelection`, `outputFiltering` and `requiredCapabilities`. Its
adapter extension specifies `adapterVersion`, `adapterId`, `authScheme`,
`supportedOperations`, `contextRoleFidelity` and `toolCallbacks`. Network-backed
runtimes additionally propose an `endpoint` and a `credentialBinding` **name**.
`modelSelection` describes the runtime audit field and model-selection consent.
The canonical SDK validator checks these against the declared tools,
`requestedCapabilities` and `systemSlots`.

The operator approves a credential binding by NAME on the host. A matching name
alone is insufficient: the approved add-on ID, adapter ID, auth scheme and exact
endpoint must also match. Secret values and token-file paths never belong in a
manifest or browser storage. Host configuration uses `RESONANTOS_HARNESS_BINDINGS`;
`source` selects exactly one private absolute `file` path or environment variable
name (`env`). The registry receives binding metadata; credential custody stays
inside the host transport.

## DSH setup

Use Node.js 24.21.0 and the repository's installed dependencies, including
Playwright and its Chromium browser. Run a separately installed, authenticated
DSH service on `http://127.0.0.1:3080` with its Augmentor action endpoint enabled.
Set `DSH_HOME` to the same external directory used by that service. The action
channel token is in `$DSH_HOME/augmentor-ws-token` (the usual DSH home is
`~/.dsh`). The token file must be a regular, owner-only file owned by the current
user; symlinks are refused. Never copy its contents into the repository.

Approve the example's binding in the private operator terminal:

```bash
export DSH_HOME="$HOME/.dsh"
export RESONANTOS_HARNESS_BINDINGS="$(node --input-type=module -e '
import path from "node:path";
console.log(JSON.stringify([{
  name: "dsh.main",
  addonId: "addon.deepseek-harness",
  adapterId: "dsh-typert-v1",
  authScheme: "dsh-action-token",
  endpoint: "http://127.0.0.1:3080",
  source: { file: path.join(process.env.DSH_HOME, "augmentor-ws-token") }
}]));
')"
```

Configure a real provider supported by the provider fabric as described in
[Installation](../../INSTALL.md#configure-provider-credentials). The DSH turn
itself needs no provider-fabric key, but the second, independently routed answer
does. This demo invokes real models and may incur provider charges. No tool
callbacks are enabled by the harness adapter.

## OpenAI-compatible endpoint and bearer binding

The SDK-valid [OpenAI-compatible example](../../examples/addons/openai-compatible-harness.json)
selects the reviewed `openai-compatible-v1` adapter. Import the JSON through the
harness management surface, explicitly grant its requested capabilities, and
assign the primary-agent slot. It is not enrolled in either public catalog or
the private DSH/provider demonstration catalog.

Its `http://127.0.0.1:8000` endpoint is a **proposal**, not network authorization.
The host operator must approve the exact origin and port with `authScheme:
"bearer"` and the `credentialBinding` **name** `openai.compatible`. For example,
merge this entry into `RESONANTOS_HARNESS_BINDINGS` (preserving other bindings):

```json
{
  "name": "openai.compatible",
  "addonId": "addon.openai-compatible-harness",
  "adapterId": "openai-compatible-v1",
  "authScheme": "bearer",
  "endpoint": "http://127.0.0.1:8000",
  "source": { "env": "LOCAL_COMPATIBLE_BEARER" }
}
```

Supply `LOCAL_COMPATIBLE_BEARER` privately to the bridge process, or use the
existing owner-only secret-file binding. No token value belongs in the manifest.
The transport resolves the binding by name and checks its add-on, adapter,
auth scheme and endpoint before attaching the bearer header. The SSE decoder
receives an authorized transport and never receives the credential. DSH and this
adapter use the same loopback-only endpoint guard: DNS is checked afresh for
each request, the approved port is pinned, and redirects are refused.

The bridge uses `/v1/chat/completions`. Host compositions can configure another
origin-relative path through the adapter factory's `completionsPath` option;
the manifest schema does not accept paths or arbitrary headers. Select the
endpoint's model through `/agent/select-model` before the first turn, or supply
the model on a turn. The adapter forwards structured messages using the shared
untrusted-context framing and enables no tool callbacks.

The host session wrapper owns bounded in-memory history and model selection;
the wire decoder has no transcript authority. Only completed replies enter that
history. Cancellation aborts the request and releases the body reader, and
failed or cancelled output cannot enter a later turn. History expires with the
host session. SSE is decoded across UTF-8 and event boundaries with a 64 KiB
frame/text limit, a 1 MiB wire limit and a two-minute default deadline. Public
output is one final reply after `[DONE]`, not incremental deltas, allowing
credential redaction across event boundaries. Errors use the fixed harness
vocabulary.

The deterministic swap test uses two manifests, bindings, endpoints and models
through the same adapter and compares its source hash before and after both
turns. Its receipt shape contains the adapter source hash, dispatch endpoint and
model, owner, boot epoch, generation, session/turn IDs and attributed final
reply. These are explicitly **fixture** receipts. The real-server variant
requires loopback sockets; the actual two-harness live run and restart
certification remain increment 2H.

## Run and inspect evidence

Stop another development server using port 1430 first. Supply a **new absolute
directory outside the repository**, with an existing parent:

```bash
node scripts/harness-swap-demo.mjs /tmp/resonantos-harness-live --headed
node scripts/harness-swap-demo.mjs --verify /tmp/resonantos-harness-live/evidence.json
```

The script composes the actual bridge and harness host service with
`RESONANTOS_HARNESS_DEMO=1`, an isolated external user root, and the actual React
app served in `harness-demo` mode. It reuses the authenticated development-page
plugin with an ephemeral page key. It does not write generated bridge credentials
into the repository. The first-run selection retains the existing chat surface;
harness grants and primary ownership are separate host transactions.

The browser installs DSH, proves ungranted activation is denied without an
upstream dispatch, grants the requested capabilities, and obtains a real reply.
It then installs and selects `addon.provider-chat-demo`, obtains a distinct
reply, swaps back to DSH, and obtains another reply. It restarts the bridge and
reloads React, checks durable grants/ownership and a fresh boot epoch, revokes
consent during an accepted DSH turn, then refuses removal while DSH owns the slot.
There is no revoke button in the current management panel: that step uses the
operator's authenticated `/addons/grants` transaction and refreshes the React
projection. It requires a cancellation attempt, closed event stream, no late
answer events, and rejection of another turn on the stale session. If the reply
finishes before revocation, the run fails rather than claiming race coverage.

`evidence.json` records mode, timestamps, ordered owner/generation/session/turn
receipts, upstream acceptance, host-provenance final events, visible attributed
answers, and governance outcomes. `governance.png` captures the final browser
state. The external `user/` directory contains the isolated durable registry.
Caches are removed on shutdown; services and browser contexts are closed. Failed
runs never produce a successful evidence bundle. Do not commit these artifacts.
Review answers and screenshots for private content before sharing them.

The verifier checks internal consistency; it is not a signature or proof that
someone did not forge a JSON file. Preserve the original run provenance. A model
calling itself “DeepSeek” is not dispatch evidence.

For deterministic CI, use the explicit fixture mode:

```bash
node scripts/harness-swap-demo.mjs /tmp/resonantos-harness-fixture --fixture
node scripts/harness-swap-demo.mjs --verify /tmp/resonantos-harness-fixture/evidence.json --fixture
node --test browser-first/test/harness-swap-demo.test.mjs scripts/browser-first-release-scope-audit.test.mjs
```

Fixture mode uses the same React app, bridge, durable registry and boundary, with
fixture upstream adapters. Every receipt is marked `mode: fixture`; the default
live verifier rejects it, including a fixture receipt inside a live-labeled
bundle. Fixture adapters deliberately offer late output after revocation. CI
provides no live-DSH certification. Both modes require loopback sockets and a
working Playwright browser.

## Security properties

| Boundary | Enforced property and limit |
| --- | --- |
| Installation and consent | Manifest requests confer no grants. Host acknowledgements establish effective consent. |
| Binding custody | Operator approval binds name, add-on, adapter, auth scheme and endpoint; tokens/cookies remain host-only and are redacted. |
| Network destination | DSH and OpenAI-compatible transports use an approved loopback origin and port, checked DNS answers, pinned connection destination, and refused redirects. |
| Bridge routes | Bridge authentication, scoped read/control capabilities, loopback Host/origin checks and strict payload validation precede execution. |
| Runtime identity | Host-issued boot epoch, owner generation, session and turn IDs attribute output; model self-identification confers no authority. |
| Ownership and persistence | Durable compare-and-swap governs replacement. An active slot owner cannot be removed. Reload preserves consent/owner, not old session authority. |
| Revocation | Authority and output are fenced synchronously; cancellation and resource cleanup are attempted. Independently running DSH side effects may continue. |
| Context and tools | Encoded untrusted context remains text-only in DSH; it does not establish system-role enforcement. Browser and other human-only actions gain no new authority. |
| Evidence | External storage, explicit fixture labeling, and validation prevent accidental use of fixture receipts as live proof; files are not cryptographically attested. |
| Liveness | Evidence is internally consistent; liveness is attested by the operator who ran the demo and by its witnesses, not proven by this verifier |

## Current limitations

- The verifier cannot distinguish a consistently relabeled fixture bundle from live evidence; host-signed receipts (a per-boot key printed by the host and checked by the verifier) are Phase 2.
- No live-DSH certification in CI — the first live run is the release gate on an
  operator's machine.
- DSH browser tools, the approval waterfall, and plugin save/unsave/state actions
  are unavailable. The management panel displays those limitations read-only.
- There is no client-initiated session-dispose operation yet. An orphaned host
  session is fenced by the ownership generation and cleaned on removal/shutdown;
  Phase 2 adds dispose.
- A governed compatibility turn that ends cancelled serializes as HTTP **503**
  on the JSON `/augmentor/chat` route. Harness events retain their own protocol.
- The example manifests request `agent-runtime` for the primary slot, without a
  transitional `agent-delegation` request. Runtime execution requires independently
  approved `agent-runtime` consent; existing delegation consent does not grant it.
- This Phase 1 run demonstrates DSH and the provider-fabric adapter. Certification
  with two independent OpenAI-compatible harnesses is Phase 2 work.
- The run's revocation check observes the fenced stream and rejected stale
  operation; it does not claim that external tools have ceased all side effects.

## Evidence and serial-suite growth

Measurements use Node 24.21.0 and `npm run -s test:browser-first`, whose runner
preserves `--test-concurrency=1`. The pre-Phase-1 measurement reconstructs commit
`24356bb7` (before 1A) from Git with the current installed dependencies. These are
sandbox observations, not successful release certification: loopback listeners
are denied with `EPERM`. The baseline includes additional pre-existing failures;
the conductor must repeat the full gate unsandboxed.

- Before 1A: **1,856 tests**, 1,786 passed, 65 failed, 5 skipped;
  **52.531 seconds wall time** (Node runner: 52.359 seconds).
- After 1I: **2,049 tests**, 1,972 passed, 72 failed, 5 skipped;
  **54.338 seconds wall time** (Node runner: 54.219 seconds).
- Growth: **193 tests (10.4%)**, **1.807 seconds (3.4%)** in this sandbox.
  All seven additional failing tests require loopback listeners denied by the
  sandbox. Baseline failures also include Hermes/OpenCode artifact smoke tests
  and live-SDK fault-injection checks; these results do not establish their
  unsandboxed status.

The 1I targeted gate passed **39/39 tests**. The demo-verifier bypass, removed
exact scope exception, and widened adjacent-doc approval mutations each failed
their tests, then passed after restoration. Documentation validation and
**289/289 documentation tests**, TypeScript checking, and the security check
runner passed. The actual fixture UI run was blocked at the bridge listener by
`EPERM`; no live evidence was produced. The default Vitest command was blocked
while writing its bundled-config cache under the read-only `node_modules`.
The cache-free alternate command
`npm run -s test -- --configLoader runner --cache=false` passed **657/657 tests**
in **48 files**. `npm run verify:alpha` passed hygiene and docs, then stopped
at the same config-cache `EPERM` during `npm run build`.

Exact release-scope exceptions include this document and the linked OpenAI-compatible
example. Unrelated neighboring examples remain `review`. An adjacent unapproved
`docs/addons/` document remains `review`; the strict integration fixture checks
the approved paths. Required checks also include `npm run docs:check`,
`npm run test:docs`, `npx tsc --noEmit -p tsconfig.json`, `npm run -s test`,
`node scripts/security-pipeline/run-check.mjs`, and the full
`npm run verify:alpha` release gate when the environment permits it.
