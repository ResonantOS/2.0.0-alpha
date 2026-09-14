<!-- Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
     Copyright © 2026 Manolo Remiddi
     SPDX-License-Identifier: MIT
     License: MIT — see LICENSE at the repository root. -->

# Augmentor, powered by DSH

**Augmentor** turns any DeepSeek Harness (DSH) web session into a browser
operator: a Chrome side panel chats with your DSH app, and the agent drives
your *real* browser — live accessibility snapshot, click, type, tab switching —
with the user watching every action pulse on the actual page. Chats are real
DSH sessions in a dedicated directory, and **Save** attaches the current chat
to a DSH workspace.

```
┌─ Chromium (MV3 extension) ─────────────────┐   ┌─ Your machine ─────────────────────────────────────────────┐
│ side panel: chat UI (real DSH sessions)    │   │ pipe.mjs — native messaging host (Node, loopback)          │
│ sw.js: native port + browser executor +    │   │  ├─[POST /api/<namespace>/<method>]──────────────▶ running DSH app      │
│  work-tab injection (page veil, overlays)  │   │  ├─[WS /api/remote.mux]◀───────── downlink frames      │
└──────────────┬─────────────────────────────┘   │  └─[WS <wsPath, from handshake>]──────▶ dsh-augmentor plugin│
               │ native messaging (token-gated)  │        /api handshake + pipe channel + browser tools +     │
               └────────────────────────────────▶│        chat lifecycle (save-to-workspace)                 │
                                                 └────────────────────────────────────────────────────────────┘
```

No sidecar runtime, no second DSH process: the extension talks to the **running**
DSH app over its stock `/api` surface (the pipe is the browser's loopback
stand-in client, because the extension's Origin is refused by the DSH trust
fence — by design).

## Components

| path | what it is |
| --- | --- |
| `extension/` | MV3 Chrome extension: side panel chat, service worker (native port + browser executor), page veil, work-tab overlays, theme tokens |
| `pipe.mjs` | native messaging host: loopback bridge to the DSH app's `/api` surface, downlinks, plugin channel |
| `plugin/` | the `dsh-augmentor` DSH plugin (npm package + git bundle): `/api/augmentor` handshake, pipe WS channel, `browser_*` tools, chat lifecycle |
| `wire.mjs` | the shared wire primitives (frame codec + pending table) used by all three runtimes — one implementation, three consumers |
| `install-native-host.sh` | installs the Chromium native-messaging-host manifest + the per-machine channel token |
| `test/` | e2e suites (m3, sw, panel, chrome, m2, tools) + `install-proof.mjs` (deterministic fresh-user install proof) + `plugin/tests/boot/` |
| `PROPOSAL-plugin-architecture.md` | the architecture record: milestones M1–M4, audit findings S/D/F, decisions |

## DSH compatibility

Augmentor 0.1.32 targets **DSH 0.1.5-rc.1** and its authenticated Typert API.
Upgrade the plugin, native host and extension together. Augmentor 0.1.31
and earlier do not work with this DSH release: their SDK dependency,
HTTP method names, authentication and event streams predate the new API.

To update an existing installation after installing this release:

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.1
./install-native-host.sh <extension-id>
dsh plugin --profile web add <absolute-path-to-this-repo>/plugin
```

Restart DSH and reload Augmentor at `chrome://extensions`. For the npm
plugin path, use `dsh plugin --profile web add dsh-augmentor@0.1.32` from npm. The installer reconciles dependencies, installs
the Augmentor preset when missing, and backs up a legacy preset before
renaming its persona `text` setting to `prefix`. A custom `DSH_HOME` must
be the same for DSH, the installer and the browser/native host.

The bridge exchanges DSH's launch token through a local endpoint protected
by Augmentor's existing action-channel secret. Its session cookie remains
inside the native host. No extension cookie permission or disabled DSH
authentication is required.

## Install

Tested on **Linux with Chromium**, Node.js 22.19+ or 24+, and DSH 0.1.5-rc.1.

1. Install/update DSH: `npm install -g @deepseek-ai/dsh@0.1.5-rc.1`.
2. [Download Augmentor 0.1.32 ZIP](https://github.com/ManoloRemiddi/augmentor-dsh-extension-plugin/releases/download/v0.1.32/augmentor-0.1.32-dist.zip) and extract the entire
   `augmentor-0.1.32` folder to a permanent location. It includes the plugin,
   extension, native host and preset. Keep all the files together.
   Source alternative: `git clone --branch v0.1.32 https://github.com/ManoloRemiddi/augmentor-dsh-extension-plugin.git`.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
   select `extension/` in the extracted folder and copy the extension ID.
4. From the extracted folder, run `sh install-native-host.sh EXTENSION_ID "$HOME/.config/chromium"`
   with that ID. The second argument is the browser user-data root, not `Default`.
   Other Linux defaults: Chrome `~/.config/google-chrome`, Edge `~/.config/microsoft-edge`,
   Brave `~/.config/BraveSoftware/Brave-Browser`. Other platforms are not verified;
   these shell commands are not a Windows installer.
5. In the same folder, run `dsh plugin --profile web add "$PWD/plugin"`.
   Alternatively install `dsh plugin --profile web add dsh-augmentor@0.1.32`.
   Choose one method and use your app's actual profile if different from `web`.
   Pinning the npm version avoids an older release being selected by release-age filtering.
6. Restart the existing DSH process/service, or start a new instance with `dsh web`.
   Open the **complete local URL printed by DSH**, including the authentication token.
   A bare `http://127.0.0.1:3080/` may show “dsh web authentication required”.
   This authenticates the browser to DSH on your own PC; it does not require a
   DeepSeek account or approval. Restart Chromium, open the side panel and test
   a prompt with a configured model. `/api/augmentor` should report `0.1.32` and `pipes: 1`.

For upgrades from 0.1.31 or earlier, use these manual steps if the old panel
cannot connect. Back up the old folder, update all three components and rerun
the installer. Update an existing linked plugin directory instead of adding
a duplicate. Keep any custom `DSH_HOME` consistent between DSH, the installer
and browser/native host. The installer preserves custom presets and backs up
legacy settings before migration.

DSH and a configured local model can work offline once installed. Cloud models
require their provider's credentials and internet. Accessing online pages also
requires internet.

### Optional: Model Picker Augmented

[Model Picker Augmented 1.1.2](https://github.com/ManoloRemiddi/dsh-model-picker-augmented/releases/tag/v1.1.2)
supports DSH 0.1.5-rc.1 and fixes the undefined `settings` loader error. It adds
search, pinning and visibility controls; Augmentor shares its model curation.
Install the GitHub package (this companion is not published on npm):

```sh
dsh plugin --profile web add https://github.com/ManoloRemiddi/dsh-model-picker-augmented/releases/download/v1.1.2/dsh-model-picker-augmented-1.1.2.tgz
```

Restart DSH and reload its page. For an existing linked Git checkout, update
that checkout to tag `v1.1.2` instead of adding another plugin entry.

## Security posture

- **The DSH trust fence is why the pipe exists — it is not bypassed.** The
  DSH app's `/api` refuses requests from foreign browser origins (the
  extension's `chrome-extension://` origin included, by design). `pipe.mjs`
  is a loopback stand-in client: it runs locally as the user and talks to
  the app over `127.0.0.1`, which is exactly what the fence permits.
- **No new remote surface.** Every hop is loopback (extension ↔ pipe via
  native messaging, pipe ↔ app via `127.0.0.1`); nothing this stack adds is
  reachable from other hosts. The trust boundary is the local OS user:
  anything that can already read your home directory is not blocked by this
  stack (and could already do the same things directly against the app).
- **The action channel is secret-gated.** The `browser_*` commands flow over
  a WS channel the plugin authenticates with a per-machine token
  (`$DSH_HOME/augmentor-ws-token`, 0600, created by the installer or first
  boot; a configured `actionToken` wins). The pipe presents it in the WS
  handshake header and the plugin compares it in constant time; a local
  process without that file cannot drive your browser.
- **The in-panel "Trust-fence probe"** (≣ Sessions → *Probe*) is a diagnostic
  that shows the fence working as designed (extension-origin requests
  refused, loopback requests accepted). It probes; it does not bypass.

## Development

```sh
# full e2e battery (six suites) — run from the repo root:
cd test && node m3-e2e.mjs && node sw-e2e.mjs && node panel-e2e.mjs \
  && node chrome-e2e.mjs && node m2-e2e.mjs && node tools-e2e.mjs

# plugin boot test:
sh plugin/tests/boot/run.sh
```

The suites are hermetic: each creates its own marker session (and archives it
on cleanup), never touches user sessions, and the live-browser suites (m3,
chrome, m2) run against the real local DSH app + a real Chrome profile.

# deterministic install proof — the documented journey, end to end, on a fresh
# DSH home + fresh Chromium profile (never touches your real ~/.dsh):
node test/install-proof.mjs                 # clone → boot → plugin → ext → NMH → pipes:1
PROOF_LLM=1 node test/install-proof.mjs     # + a real agent drives the headless browser
PROOF_SOURCE=npm PROOF_LLM=1 node test/install-proof.mjs   # npm plugin path (once published)
# knobs: PROOF_REPO, CHROME_BIN, PROOF_PORT, PROOF_KEEP=1 — see the script header.

## License

MIT.

## Shared prompt library (local development update)

The Settings gear opens DSH. Choose **Settings → Prompt library** to create, edit, rename or delete reusable prompts. Type `/` in the composer to filter by shortcut name. Arrow keys select, Enter/Tab inserts into the draft, and Escape dismisses. Insertion never sends automatically.

Install the independent `dsh-prompt-library` plugin in the DSH web profile. The native pipe's `augmentor/prompts` method reads only its `prompt-library` settings namespace through the existing DSH API. Both Augmentor interfaces use that catalog; DSH owns the local storage and editor. The plugin imports the previous local JSON library once, if present. The extension no longer uses a separate Python prompt store. Reload the unpacked extension once after this development update.
