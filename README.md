# ResonantOS 2.0.0 Alpha

ResonantOS 2.0.0 Alpha is a browser-first system composed of a Chrome Manifest
V3 side-panel extension and an authenticated local Node.js bridge. The bridge
provides host-mediated provider, memory, add-on, diagnostics, and browser-control
services while privileged browser actions remain under explicit human control.

Desktop shells, native browser bundles, terminal add-ons, and Audio2TOL are not
part of this Alpha runtime.

## Five-Minute Quick Start

Prerequisites: Node.js 22.13.0 or newer and Google Chrome 116 or newer.

```bash
npm install
npm run browser-first:bridge
```

Keep the bridge terminal open. In Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `browser-first/resonantos-side-panel-extension`.
5. Open a new tab for the main workspace or open the ResonantOS side panel.

At startup, the bridge writes its loopback URL and generated credentials to
`browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js`.
The file is ignored by Git and must remain local.

For provider credentials, browser requirements, troubleshooting, and a clean
shutdown path, continue to [Installation](INSTALL.md).

## Alpha Source Layout

| Path | Responsibility |
| --- | --- |
| `browser-first/resonantos-side-panel-extension/` | Chrome MV3 extension and side-panel UI |
| `browser-first/host/` | Authenticated local Node.js bridge and host services |
| `addons/resonant-browser-host/` | Separate controlled Chromium host package; not the active Alpha UI runtime |
| `src/` | Shared TypeScript and React implementation used by development surfaces |
| `scripts/` | Deterministic tests, security checks, and release validation |

Component instructions live in the
[browser-first README](browser-first/README.md),
[bridge README](browser-first/host/README.md), and
[controlled browser-host README](addons/resonant-browser-host/README.md).

## Project Authority

- [Current Alpha status](docs/STATUS.md) records verified current facts.
- [Documentation index](docs/README.md) routes work by task.
- [Module ownership](docs/architecture/MODULE-OWNERSHIP.md) defines code and
  service responsibility.
- [Project governance](docs/PROJECT_GOVERNANCE.md) defines issue and Project 2
  workflow.
- [Project 2](https://github.com/orgs/ResonantOS/projects/2) is the
  release-planning authority.

## Contributing And Security

Start with [CONTRIBUTING.md](CONTRIBUTING.md), branch from `dev`, and open pull
requests into `dev`. Report vulnerabilities through [SECURITY.md](SECURITY.md);
never place credentials, private data, or unredacted security details in a
public issue.

ResonantOS is licensed under the [MIT License](LICENSE.txt).
