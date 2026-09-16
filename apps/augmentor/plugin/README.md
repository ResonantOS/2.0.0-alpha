<!-- Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
     Copyright © 2026 Manolo Remiddi
     SPDX-License-Identifier: MIT
     License: MIT — see LICENSE at the repository root. -->

# dsh-augmentor (DSH plugin)

The DSH-side half of **Augmentor**: it mounts into a DeepSeek Harness web profile
and gives any DSH session the tools to drive the user's real Chromium-based
browser (page snapshot, click, type, tabs) through the Augmentor Chrome
extension, plus the chat-lifecycle surface (dedicated chat dir, save-to-workspace
sessions) the extension panel uses.

The package is a [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis)
bundle: `dsh plugin add` installs it into a profile and its `dsh.bundle.patch`
layer mounts the plugin automatically.

## Compatibility

Version 0.1.32 requires DSH 0.1.5-rc.1 and matching Augmentor native-host
and extension files. The tools SDK is a host-provided optional peer, not
an installed runtime dependency: a second copy in the DSH profile can
shadow the host registry and break tool scheduling. The exact SDK remains
pinned as a development dependency for builds.

Upgrade DSH, update the extension tree, rerun `install-native-host.sh`,
update this plugin, then restart DSH and reload the extension. Older
Augmentor releases do not support DSH's authenticated Typert API.

## Requirements

- Node.js ≥ 22.18 (the DSH host requirement)
- A DSH web profile (e.g. `web`)
- Chromium-based browser with the Augmentor extension installed (see the repo root README)

## Install

**From npm (recommended):**

```sh
dsh plugin --profile web add dsh-augmentor
```

**From git (no npm needed):**

```sh
git clone https://github.com/ManoloRemiddi/augmentor-dsh-extension-plugin.git
dsh plugin --profile web add /path/to/augmentor-dsh-extension-plugin/plugin
```

`dsh plugin` is a thin pnpm forwarder: it installs the package into the
profile's `node_modules`, sees the `dsh.bundle.patch` declaration, and adds the
package to `dsh.profile.bundles` — the next profile boot composes the plugin's
patch layer and mounts it.

> **Note on build scripts:** the `prepare` script rebuilds `dist/index.js`
> (the bundled entry) with esbuild. A pre-built `dist/` ships in the repo, so
> if pnpm's build-script policy blocks `prepare` (pnpm ≥ 10 default), the
> install still works — or allow the build in the profile's
> `pnpm-workspace.yaml` under `allowBuilds` and re-run.

## Configuration

Declared in the profile's `cordis.patch.yml` (the plugin's patch layer supplies
the entry; config rows can be added there):

| key | default | meaning |
| --- | --- | --- |
| `apiPath` | `/api/augmentor` | HTTP handshake route under the DSH app |
| `wsPath` | `/api/augmentor/ws` | WS upgrade route for the pipe channel |
| `commandTimeoutMs` | `30000` | per-action browser round-trip timeout |
| `wsToken` | *(empty)* | action-channel token; empty = per-machine secret file `~/.dsh/augmentor-ws-token` (created 0600 on first boot) |
| `chatDir` | `~/Augmentor` | dedicated directory Augmentor chats live in (`~` expands) |
| `agentPreset` | `augmentor` | agent preset for extension sessions (carries the browser-control persona) |
| `workspaceTitle` | `Augmentor` | workspace the Save button attaches sessions to |

## Wire protocol

The pipe (the extension's native-messaging host) connects to `wsPath`, gated by
the token (header `x-augmentor-token`, legacy `?token=` fallback on the plugin
side). Frames are JSON objects; the canonical vocabulary lives in
[`../wire.mjs`](../wire.mjs) (shared by pipe, plugin, and the extension
service worker):

- `welcome {name, protocol, version}` — plugin → pipe, once on connect
- `request {id, method, params}` / `reply {id, result | error}` — both
  directions; `browser/execute` goes to the active pipe only, and its reply
  must come from that same socket

## Tools exposed to the agent

`browser_tabs_list`, `browser_navigate`, `browser_snapshot`, `browser_click`,
`browser_type` — each one round trip through the active pipe to the extension.

## License

MIT — see the repository.
