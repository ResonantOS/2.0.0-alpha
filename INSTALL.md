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

Installation complete. Continue with the contribution workflow in
[CONTRIBUTING.md](CONTRIBUTING.md) or use the
[documentation router](docs/README.md) to find component-specific guidance.
