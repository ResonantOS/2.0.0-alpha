# Bridge target override and credential contract

The Settings bridge-target override persists exactly `bridgeUrl`, `bridgeToken`,
and `capabilityBootstrapToken` in local Chrome extension storage. The two tokens
are operational credentials: existing outer input whitespace trimming applies,
then their values are preserved verbatim, including strings matched by the
shared redactor. They are never recursively redacted as an override object.
This is the narrow local credential exception in the
[Alpha runtime boundary](../../docs/architecture/ALPHA_RUNTIME_BOUNDARY.md).

`src/lib/bridge-client.js` under the extension directory owns the reusable URL
policy. Settings applies it when parsing the form and again immediately before
the save projection. Test connection and both stored-override readers use the
same policy. It accepts absolute HTTP(S) addresses after outer whitespace
trimming, with no userinfo, query, or fragment (including empty delimiters).
The shared text redactor must return the URL unchanged; that returned value is
persisted without URL normalization. Ordinary hosts, ports, paths, and trailing
slashes remain intact.

Secret detection is deliberately conservative: a benign host or path resembling
a token can be rejected. Settings help and the fixed validation error explain
this limitation without echoing the endpoint. Choose a different host/path or
use the generated configuration.

An invalid legacy override is retained on disk until the user saves a valid
replacement or selects **Use generated**. It is never probed or loaded into the
form. Resolution uses generated/default configuration without any credentials
from the rejected record. Settings displays the fixed **Saved override needs
correction** warning, including after fallback probes, and does not echo the
rejected URL in health or status text. This prevents reuse; it does not erase
historical secrets from disk automatically.

## Bounded credential consumer audit

The audit covers references to `bridgeTargetOverride`, `resolveBridgeConfig`,
`bridgeToken`, and `capabilityBootstrapToken` in
`browser-first/resonantos-side-panel-extension/src/` and their immediate
consumers. It establishes the following paths, not repository-wide secrecy.

| Consumer | Operational use or exclusion |
| --- | --- |
| `lib/settings/bridge-target-section.js` | Explicit local credential inputs/storage, masked settings displays, and bridge-token health probes. Invalid legacy credentials do not populate inputs or probes. |
| `lib/bridge-client.js` | Reads configuration; bridge-token headers for JSON/raw requests and loopback detection; both authentication headers for capability bootstrap. Bootstrap body contains capability names only. |
| `background.js`, `side-panel.js`, `main-workspace.js` | Resolve/rebind clients and bootstrap capabilities; override storage listeners trigger rebinds. All three preference-sync constructors use the default key allowlist. |
| `main-workspace.js` → `lib/main-workspace-hermes.js` → `lib/addon-iframe.js` | Existing operational bridge-token plumbing for the add-on proxy; the srcdoc fetch/XHR preamble embeds that token for authentication. This is not a descriptive export and is not changed by this increment. The bootstrap credential is not passed to the iframe. |
| `lib/prefs-sync.js` | Default sync includes only user profile, augmentor config, model, and thinking depth. It does not project the override or either credential property into the preference document. |
| `lib/settings/diagnostics-section.js` | Status requests send no body. Export sends exactly `{ "scope": "settings" }`, without the override or either credential. Bridge authentication remains in headers. |

No direct override/configuration consumer found in that search forwards the
record into chat, context, summaries, traces, or descriptive exports. This does
not certify arbitrary preference content, caller-supplied sync key lists,
server-generated diagnostics, add-on isolation, or every possible indirect flow.
The shared redactor alone cannot guarantee credential exclusion: compound
credential property names and opaque values are not necessarily matched.

## Deterministic coverage

`browser-first/test/bridge-target-section.test.mjs` exercises the real rendered
Settings buttons with captured Chrome storage writes and fetch requests. It
checks exact three-field payloads, trimming, credential preservation, saved
configuration authentication, rejected URLs, legacy retention, fallback
credential isolation, repair, and explicit clearing.

`browser-first/test/prefs-sync-storage.test.mjs` captures the actual serialized
preference POST body through the real bridge client.
`browser-first/test/settings-diagnostics-recovery.test.mjs` captures all five
status requests and the exact serialized diagnostics export body. These tests
use synthetic credentials and expected payloads independent of the redactor.
