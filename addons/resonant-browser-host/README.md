# Resonant Browser Host Package

`@resonantos/resonant-browser-host` is a separate, controlled Chromium
automation package. It provides a deterministic add-on boundary for audited
browser actions; it is not the active Chrome extension UI or local bridge in the
2.0.0 Alpha runtime.

The package implements:

- Playwright Chromium startup in headless mode by default;
- `http` and `https` navigation only;
- title, URL, page-text, and link reads;
- selector or coordinate clicks and selector-based typing;
- screenshot evidence constrained to the configured artifacts directory;
- append-only audit events with bounded recent output; and
- newline-delimited JSON request/response messages over standard input/output.

The package does not share a live session with the ResonantOS side-panel
extension. Do not describe standalone package behavior as integrated Alpha
behavior unless the bridge and extension code establish that integration.

## Install And Test

Install root dependencies, then install the Playwright Chromium browser if it is
not already available:

```bash
npm install
npx playwright install chromium
npm run test:browser-host
```

Tests start a controlled local HTTP fixture and cover navigation, reads, input,
screenshots, path containment, audit output, rejected non-web URLs, launch
configuration, and the standard-input/output protocol.

## Run Standalone

From this package directory:

```bash
npm start
```

The process reads one JSON request per line from standard input and writes one
JSON response per line to standard output. Set an installed browser explicitly
by exporting `RESONANTOS_BROWSER_HOST_CHANNEL` or
`RESONANTOS_BROWSER_HOST_EXECUTABLE_PATH` before startup:

```bash
export RESONANTOS_BROWSER_HOST_CHANNEL="chrome"
npm start
```

The launcher reads the process environment and does not load dotenv files.
Never pass provider secrets, wallet material, browser profiles, or private user
data through this protocol or commit generated screenshots.

See [ADR-017](../../docs/architecture/ADR-017-resonant-browser-addon.md),
[Module Ownership](../../docs/architecture/MODULE-OWNERSHIP.md), and the root
[contribution workflow](../../CONTRIBUTING.md) before changing the package.
Use [Status](../../docs/STATUS.md) and
[Project Governance](../../docs/PROJECT_GOVERNANCE.md) rather than this
component README for release claims.
