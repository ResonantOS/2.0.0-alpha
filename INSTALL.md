# Install ResonantOS 2.0.0 Alpha

This is the complete supported installation path for the Alpha: one Chrome
Manifest V3 extension connected to one authenticated local Node.js bridge.

## Prerequisites

- Node.js 22.13.0 or newer. The repository pin is in `.nvmrc`.
- npm, supplied with Node.js.
- Google Chrome 116 or newer.
- A terminal kept open while the bridge is running.

Confirm the local toolchain:

```bash
node --version
npm --version
```

If you use nvm, the repository's `.nvmrc` will pin the right version
automatically when you `cd` into the directory:

```bash
nvm use    # reads .nvmrc -> 22.13.0
```

## Install Dependencies

For a fresh clone, start from the active development branch:

```bash
git clone --branch dev https://github.com/ResonantOS/2.0.0-alpha.git
cd 2.0.0-alpha
```

Then install dependencies from the repository root:

```bash
npm install
```

## Configure Provider Credentials

The preferred path is **Settings -> Providers** after loading the extension.
Credentials entered there remain in bridge-process memory for the session and
must be entered again after restarting the bridge.

The core provider bridge also accepts `MINIMAX_API_KEY`, `OPENAI_API_KEY`, and
one of `ZAI_API_KEY`, `GLM_API_KEY`, or `ZHIPUAI_API_KEY`. Export only the
variable required by the selected provider before launching the bridge:

```bash
export OPENAI_API_KEY="replace-with-your-key"
npm run browser-first:bridge
```

Do not put credentials in a committed file. The bridge launcher reads the
process environment; it does not load dotenv files.

## Start The Bridge

If the bridge is not already running from the provider example, start it from
the repository root:

```bash
npm run browser-first:bridge
```

The default listener is loopback-only on preferred port `47773`, with an
available-port fallback. Local state defaults to `~/ResonantOS_User`, outside
the repository. Startup writes
`browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js`
with the active URL, a generated bridge token, and a capability-bootstrap
token. The file is created with user-only permissions, ignored by Git, and
regenerated on startup. Never share or commit it.

Keep this process running while using ResonantOS. Stop it with `Ctrl-C`.

Never commit `ResonantOS_User`, provider or wallet credentials, browser
profiles, cookies, login databases, screenshots, or unredacted diagnostics.
Other local secret material belongs under `ResonantOS_User/Secrets/`; the Alpha
host does not persist provider credentials entered through Settings there.

## Load The Extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `browser-first/resonantos-side-panel-extension` from this repository.
5. Open the ResonantOS side panel from Chrome's toolbar or side-panel menu.

After changing extension files, use the reload control on
`chrome://extensions`. After restarting the bridge, reload the extension so it
uses the newly generated credentials.

## Verify The Installation

```bash
npm run test:browser-first
npm run test:browser-host
```

For a basic manual check, confirm that the bridge terminal reports
`browser.first.bridge_started` and that the side panel opens without a bridge
connection error. Do not paste the generated config or full diagnostics into a
public issue.

## Test The DeepSeek Harness Addon (addon SDK testing)

The `addon.deepseek-harness` addon (ADR-040 §9) is the canonical
external-agent-runtime exemplar. You can exercise its full boundary contract
**without installing Cordis or setting any provider key** by using the
in-repo Cordis stub. Four scripts cover this:

| Script | What it proves |
| --- | --- |
| `npm run deepseek-harness:smoke` | The manifest is conformant to the SDK boundary contract (F1-F10 all pass against the mock host). |
| `npm run test:external-agent-runtime` | The bridge-side dispatcher resolves the manifest, validates per-caller grants via Phase 3.5, builds an OpenAI-compatible request, posts to a Cordis endpoint, and records the audit ledger. |
| `npm run test:phase35` | The Phase 3.5 kernel (caller-attributed grants, HMAC tokens, audit ledger, denied audit) works as expected. |
| `npm run cordis-stub:start` | Boots the in-repo Cordis stub HTTP server at `http://127.0.0.1:3080`. |

Run them in order:

```bash
# 1. Verify the manifest conforms to the SDK boundary contract
npm run deepseek-harness:smoke

# 2. Verify the dispatcher round-trips through a Cordis endpoint
#    (boots the stub on a random port for each test; no manual setup needed)
npm run test:external-agent-runtime

# 3. Verify the Phase 3.5 kernel
npm run test:phase35

# 4. Optionally, boot the stub standalone to poke it by hand
npm run cordis-stub:start &
sleep 1
curl -s http://127.0.0.1:3080/health
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hello"}]}' \
  http://127.0.0.1:3080/api/v1/chat/completions
kill %1
```

### Talking to real DeepSeek (optional, requires Cordis)

The above proves the boundary contract end-to-end against a stub. To
exercise a **real** DeepSeek Harness via the dispatcher:

1. Install the Cordis-kernel runtime and bind it to `127.0.0.1:3080`
   (the manifest's `service.entrypoint`). Cordis is not packaged by
   this repo; install instructions live with Cordis upstream.
2. Export `DEEPSEEK_API_KEY` in the shell that runs Cordis. The
   dispatcher does **not** read this key directly; Cordis does. See
   `.env.example` for the full list of optional env vars.
3. Boot the bridge with Phase 3.5 enabled:
   ```bash
   npm run browser-first:bridge
   ```
4. Send a delegated reasoning request through the dispatcher. The
   request shape is documented in ADR-040 §4 and exercised by
   `browser-first/test/external-agent-runtime-dispatcher.test.mjs`.

If you do not yet have Cordis installed, the dispatcher still
round-trips, but it talks to the in-repo stub at `127.0.0.1:3080`,
not real DeepSeek. That is the "tests pass on a fresh clone" baseline.

## Troubleshooting

- **The extension cannot reach the bridge:** confirm the bridge is still
  running, restart it, then reload the unpacked extension.
- **The extension will not load:** confirm you selected the directory that
  contains `manifest.json`, not the repository root.
- **A provider is unavailable:** configure the provider in Settings or export
  the required provider variable in the same terminal that starts the bridge.
- **A port is already in use:** read the startup event for the actual fallback
  port; the generated extension config is updated automatically.
- **Credentials appeared in Git output:** stop, remove them from the working
  tree without publishing them, rotate exposed credentials, and follow
  [SECURITY.md](SECURITY.md).
- **`deepseek-harness:smoke` reports "F10: FAIL (code=fixture-mismatch)":**
  this is expected when the manifest declares
  `providerRequirements.allowExperimentalAuth: true`. The smoke script
  treats F10 as N/A in that case. If you see F10 fail on a manifest
  that does NOT declare experimental auth, that is a real failure —
  the manifest is misconfigured for that scenario.
- **`test:external-agent-runtime` reports "upstream-unreachable":**
  the stub has shut down before the dispatcher could reach it. The
  test boots its own ephemeral stub; if you see this in CI, check
  that `node:http.createServer().listen(0)` is permitted by your
  network policy.

Installation complete. Continue with the contribution workflow in
[CONTRIBUTING.md](CONTRIBUTING.md) or use the
[documentation router](docs/README.md) to find component-specific guidance.
