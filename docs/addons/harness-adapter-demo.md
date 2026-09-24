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

The final certification requires DSH and two independently configured
OpenAI-compatible endpoints. It invokes real models and may incur provider
charges. No tool callbacks are enabled by the harness adapter. Provider Chat
Demo remains an optional catalog candidate; it is not one of the three owners
in the final certification.

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
requires loopback sockets. Increment 2H extends the operator driver to both
compatible harnesses plus DSH, including fresh replies after a bridge restart.

## Final certification setup

Keep the DSH binding above and merge two bearer bindings into
`RESONANTOS_HARNESS_BINDINGS`. The first uses the example identity
`addon.openai-compatible-harness`; the second uses `addon.second-compatible`:

```json
{
  "name": "openai.second",
  "addonId": "addon.second-compatible",
  "adapterId": "openai-compatible-v1",
  "authScheme": "bearer",
  "endpoint": "http://127.0.0.1:8001",
  "source": { "env": "SECOND_COMPATIBLE_BEARER" }
}
```

The endpoints must differ. Supply both bearer values privately and select a
valid model at each endpoint, in first/second order:

```bash
export RESONANTOS_COMPATIBLE_MODELS='["first-endpoint-model", "second-endpoint-model"]'
```

Replace those model names with the actual configured models. The driver derives
the second manifest from the SDK-valid example in memory and takes endpoint and
binding names from the host-approved bindings. It adds an invocation-only
`providers` dependency with `degrade` behavior to the second manifest so that
history and status remain independent of that permission. The driver neither
edits the example nor adds public catalog entries or adapter code.

## Run and inspect evidence

Stop another development server using port 1430 first. Supply a **new absolute
directory outside the repository**, with an existing parent:

```bash
node scripts/harness-swap-demo.mjs /tmp/resonantos-harness-live --headed
node scripts/harness-swap-demo.mjs --verify /tmp/resonantos-harness-live/evidence.json
```

The operator driver composes the real bridge, persistent harness registry, and
React shell in `harness-demo` mode. It chooses **Choose Add-ons Manually** at
first run so recommended defaults do not occupy the certification slots. It
uses authenticated host transactions to
install, explicitly grant, and assign owners, including a separate DSH
`chat-interface` assignment. Each normal reply is sent through the browser chat
composer and matched against the signed host final and the displayed add-on ID.
Compatible model selection happens through the host session route before the
turn. No generated bridge credentials are written into the repository.

The certification sequence is:

1. Install DSH and both compatible manifests. Installation grants nothing;
   ungranted DSH assignment is refused.
2. Grant and swap through **DSH → first compatible → second compatible**, with
   a distinct attributed answer from each.
3. Restart the bridge against the same external user root, rotate the bridge
   credentials and signing key, and reload the browser. Check persisted owners
   and grants, a fresh boot epoch, rejection of the old session's turn, and
   rejection of its event subscription.
4. Obtain fresh sessions and distinct replies from **second compatible → DSH
   → first compatible**. Old signed events or session receipts cannot satisfy
   this part of certification.
5. Reinstall the now-unowned second compatible manifest with `replaceable:
   false`, explicitly regrant it, and assign it. An explicit replacement with
   the correct generation must fail while the incumbent remains unchanged.
6. Revoke the invocation-only `providers` grant with `degrade` during a running
   turn. Require a signed adapter dispatch, signed abort, cancellation event,
   denied dependent invocation, unchanged generation, and successful history
   and status on the same session with its event stream still open.
7. Regrant, start a new turn, and revoke `network` with `hard-stop`. Require
   signed abort and stream-closure receipts, an advanced generation, no late
   output, and rejection of the retired session. Removal of the current owner
   must also fail.

A policy run fails if a reply finishes before revocation. Adapter dispatch and
abort receipts establish host invocation and cancellation; the driver also
observes upstream acceptance. They do not establish that an independent remote
service has stopped every side effect.

`evidence.json` version 2 contains two boot records, their signed receipt ledgers,
references to the receipts for every step, and browser answer observations.
`reply-*.png` and `governance.png` capture browser state. The external `user/`
directory holds durable governance only. Keys are never persisted there.
Review model answers and screenshots for private content before sharing.
A failed run does not produce a successful evidence bundle.

## Host signatures and fingerprint comparison

At each boot the host generates an in-memory Ed25519 keypair and prints a
`harness.receipt_signer` record on stderr containing the boot epoch and fingerprint,
preserving stdout for machine-readable self-test results. The
fingerprint is the first 16 bytes of SHA-256 of the public key's SPKI DER,
represented by 32 hex characters. The private key is never printed or exported.

Each host receipt carries `signature` and `signer: { algorithm: "ed25519",
keyId }`. The signature covers canonical JSON of the complete receipt excluding
`signature`: object keys are sorted recursively, array order is preserved, and
there is no whitespace. The signed body includes the signer, mode, boot epoch,
receipt sequence, timestamp, and host outcome. The host emits these records
through its observation callback; the demo collects them without adding fields
to the existing SSE event schema. The bundle records the SPKI PEM public key
once per boot under `boots[].signer`.

`--verify` recomputes both fingerprints and checks **every** receipt, including
receipts not referenced by a named step. It refuses unsigned receipts, modified
signatures, mismatched key IDs, reused live signing keys across boots, stale
execution receipts, and inconsistent outcomes. To inspect the two fingerprints:

```bash
node --input-type=module -e 'import { readFile } from "node:fs/promises"; const b = JSON.parse(await readFile(process.argv[1], "utf8")); for (const boot of b.boots) console.log(boot.bootEpoch, boot.signer.fingerprint);' /tmp/resonantos-harness-live/evidence.json
```

Compare **both** values with the original boot output witnessed during the run,
then run `--verify`. Preserve that sanitized boot output separately from the
bundle. The signature proves every receipt was issued by the host instance
whose fingerprint the operator and witnesses saw printed at boot. It does not
attest the operator; a forged bundle can embed its own key. Comparing the
recorded fingerprint against the one printed by the real host is the operator's
step. Liveness is attested by the operator and witnesses, not proven by this
verifier. The verifier prints this limitation on success.

## Fixture certification

For the full browser fixture run:

```bash
node scripts/harness-swap-demo.mjs /tmp/resonantos-harness-fixture --fixture
node scripts/harness-swap-demo.mjs --verify /tmp/resonantos-harness-fixture/evidence.json --fixture
node --test browser-first/test/harness-swap-demo.test.mjs browser-first/test/harness-host-service.test.mjs
```

Fixture mode uses the real host, registry, policy, 2G compatible adapter, and
browser UI, with deterministic upstream responses. All receipts use a clearly
marked fixed public test keypair; its public descriptor is exported as
`FIXTURE_SIGNER`. The fixed key is intentionally reproducible from checked-in
test seed material, never an operator credential. Live verification rejects
that key even if every fixture label is changed to `live`.

The tests also run the same complete certification transaction sequence through
in-process host routes without sockets, then exercise the CLI verifier on the
result. Those receipts explicitly mark browser visibility false and are not
browser or live-service proof. Fixture responses wait for an acknowledged event
subscription before producing output; this avoids a timer-based subscription
race and does not alter the live adapters. The full browser fixture still requires loopback
sockets and Playwright Chromium.

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
| Evidence | Host Ed25519 signatures bind receipts to each boot key; fixed fixture keys cannot pass live verification. Witnesses must independently compare boot fingerprints. |
| Liveness | Evidence is internally consistent; liveness is attested by the operator who ran the demo and by its witnesses, not proven by this verifier |

## Current limitations

- Public keys embedded in an evidence bundle do not establish trust on their own; compare each fingerprint against witnessed host startup output.
- No live-DSH certification in CI — the first live run is the release gate on an
  operator's machine.
- DSH browser tools, the approval waterfall, and plugin save/unsave/state actions
  are unavailable. The management panel displays those limitations read-only.
- Sessions are ephemeral. Client disposal, ownership changes, and host shutdown
  retire them; restart never resumes old execution.
- A governed compatibility turn that ends cancelled serializes as HTTP **503**
  on the JSON `/augmentor/chat` route. Harness events retain their own protocol.
- The example manifests request `agent-runtime` for the primary slot, without a
  transitional `agent-delegation` request. Runtime execution requires independently
  approved `agent-runtime` consent; existing delegation consent does not grant it.
- The final live run is an operator gate. Deterministic fixture success does not
  certify DSH or either independently configured compatible endpoint.
- The run's revocation check observes the fenced stream and rejected stale
  operation; it does not claim that external tools have ceased all side effects.

## Evidence and serial-suite growth

Measured by the release owner on the build machine (macOS, Node 24.21.0), unsandboxed,
with `npm run -s test:browser-first` (its runner pins `--test-concurrency=1`), one
run per commit, wall time from process start to exit. Every run was green.

| Point | Commit | Tests | Wall time |
| --- | --- | --- | --- |
| Before 1A | `24356bb7` (dev, 2026-09-22) | 1,856 passed, 0 failed, 0 skipped | 142.1 s |
| After 1I | `6cc1e3d3` (dev, 2026-09-23) | 2,056 passed, 0 failed, 0 skipped | 144.7 s |
| After 2H | the certified 2H head | 2,164 passed, 0 failed, 0 skipped | 150.6 s |

Phase 1 added 200 tests for 2.6 s (1.8 %); Phase 2 added 108 more for 5.9 s (4.1 %).
The whole harness-adapter project therefore costs the serial suite about 8.5 s
(6 %) for 308 tests.

### Increment 2H verification record (2026-09-24)

- Deterministic gate on the certified head: full Vitest, `test:browser-first`
  (2,164/2,164), `tsc --noEmit`, and the security run-check — green. The first
  gate caught one real defect the executor's sandbox could not run: the
  per-boot signer announcement printed to stdout and broke eight in-process
  self-tests that parse the host's stdout as a single JSON document. The
  announcement now goes to stderr, and a subprocess test pins the stdout
  contract.
- Anti-false-green: three planned mutations (accepting stale-epoch receipts,
  accepting unsigned receipts, verifying against the wrong key) each turned a
  named test red and passed again after restoration.
- Cross-vendor review: three seats in two rounds; the second round certified
  the change.
- `npm run verify:alpha`: every runnable step green on the certified head; the
  `test:dev-bridge-config` step is blocked on the build machine by a stalled
  file-watcher daemon and is covered by CI on Linux.
- The live two-harness run is an operator gate and is recorded separately with
  its signed evidence bundle and the host fingerprint the witnesses saw.
