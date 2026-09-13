# Browser-First Alpha Components

This directory owns the two active ResonantOS 2.0.0 Alpha runtime components:

- `resonantos-side-panel-extension/` is the Chrome Manifest V3 extension.
- `host/` is the authenticated local Node.js bridge.

Use the root [installation guide](../INSTALL.md) for the complete setup path and
the [Alpha runtime boundary](../docs/architecture/ALPHA_RUNTIME_BOUNDARY.md) for
security and scope rules.

## Run Locally

From the repository root:

```bash
npm install
npm run browser-first:bridge
```

The bridge binds to loopback by default and writes
`resonantos-side-panel-extension/src/bridge-config.generated.js`. That file
contains generated credentials, is ignored by Git, and must remain local.

Load `browser-first/resonantos-side-panel-extension` through **Load unpacked**
on `chrome://extensions`, then open the ResonantOS side panel. Keep the bridge
process running.

## Extension Boundary

The side panel communicates with the local bridge through authenticated,
capability-scoped routes. Browser Agent Control is mediated by typed extension
tools and visible browser state. Wallet approvals, signatures, payments,
credential entry, public submission, and destructive actions remain blocked or
human-only according to the capability contract.

Provider secrets and trusted memory writes are host-owned. Do not place secrets
in extension source, generated config, Chrome storage, fixtures, or diagnostics.

OpenCode session HTTP and events use capability-scoped bridge routes. The extension receives session identifiers, never the OpenCode server URL or Basic credential. Turning OpenCode local execution off revokes active requests and event streams. The existing session panel displays only its selected session's events with Governed or External source labels. The full cockpit remains disabled.

## Opt-in React Shell Development

The React shell served by Vite is an optional development surface. Bridge
configuration delivery is disabled by default and requires both an explicit
developer opt-in and an independently authenticated page. It does not change the
Chrome extension plus local bridge
[Alpha runtime boundary](../docs/architecture/ALPHA_RUNTIME_BOUNDARY.md).

### Prerequisites and Boundaries

- The generated bridgeUrl must be http or https on 127.0.0.1, the only host the
  page CSP allows it to connect to; HTTPS requires browser-trusted local TLS.
  Any other host, including localhost, [::1], or a non-loopback
  RESONANTOS_BRIDGE_PUBLIC_URL / RESONANTOS_BRIDGE_HOST, disables delivery and
  emits one value-free console diagnostic.
- Delivery is 127.0.0.1-only to bind the page gate to one exact origin and
  prevent host confusion; localhost and IP aliases are not authenticated
  delivery origins.
- POSIX permissions: the generated `bridge-config.generated.js` file is verified
  at request time for owning UID, regular-file status, and group- and world-unreadable (`0600`-style: any mode with no group/other bits, so `0400` or `0700` also pass)
  permissions.
- Run commands in private, non-recorded terminal sessions. No secret keys or
  credentials appear in URLs, terminal histories, HTML, or browser storage APIs.

### Why Nonce and Referrer Alone Are Insufficient

HTTP headers alone do not prove a legitimate browser page. The Referrer-Policy
is `no-referrer`, and headers can be forged by any local process. Publicly
issued or unauthenticated nonces would allow other local OS users on the
machine to fetch the page and obtain credentials. The independent page key
combined with the HTTP Basic challenge ensures only an authorized operator
receives the single-use, 60-second module nonce. HMR/WebSocket is not gated by
Basic (HTTP upgrade bypasses Connect middleware); instead, credential delivery
is isolated from Vite's transform graph so the reserved module never enters the
module graph or HMR messages.

### Operator Commands

1. In a private zsh terminal, generate a 43-character base64url key
   (approximately 256 random bits) in a password manager and start the
   development server:

```bash
read -r -s 'RESONANTOS_DEV_BRIDGE_PAGE_KEY?Developer page key: '
export RESONANTOS_DEV_BRIDGE_PAGE_KEY
RESONANTOS_DEV_BRIDGE_CONFIG=1 npm run dev
```

The server binds strictly to `127.0.0.1:1430`.

2. In the bridge terminal, start or restart the bridge with CORS allowed for the
   development origin:

```bash
RESONANTOS_BRIDGE_ALLOWED_ORIGINS=http://127.0.0.1:1430 npm run browser-first:bridge
```

3. Open `http://127.0.0.1:1430/` in the browser. When challenged by HTTP Basic
   authentication, enter:
   - **Username:** `dev`
   - **Password:** the exported `RESONANTOS_DEV_BRIDGE_PAGE_KEY`

### Missing Config and Credential Rotation

- If the bridge configuration is missing, unreadable, or invalid, Vite returns
  a 200 JS module that deletes `globalThis.__RESONANTOS_BRIDGE_CONFIG__` and
  dynamically imports `/src/main.tsx`. The web transport retains its standard
  "Browser-first bridge is not configured..." failure without leaking paths or
  details.
- Restarting the bridge rotates bridge credentials. A fresh browser page reload
  re-authenticates and receives the newly generated configuration.

### Clean Disable and Rollback

To disable delivery:

1. Stop the development server, unset `RESONANTOS_DEV_BRIDGE_CONFIG` and
   `RESONANTOS_DEV_BRIDGE_PAGE_KEY`, and restart `npm run dev`.
2. Unset `RESONANTOS_BRIDGE_ALLOWED_ORIGINS` and restart the bridge to restore
   default-deny CORS and rotate credentials.
3. Close authenticated browser contexts to clear in-memory credentials.

## Validate Changes

```bash
npm run test:browser-first
```

The [Agent Control certification fixtures](test/agent-control-certification/README.md)
prove safe click/type/scroll completion and hard-boundary denial against the
real content-mediation layer (fixture page:
[agent-control-certification-page.html](test/fixtures/agent-control-certification/agent-control-certification-page.html)).
The page-understanding fixtures ([article.html](test/fixtures/pages/article.html),
[pdf-like.html](test/fixtures/pages/pdf-like.html),
[media-only.html](test/fixtures/pages/media-only.html)) prove read_page
extraction through the real content-mediation layer in
`test/browser-page-actions.test.mjs` (#218).
The [HRR-033 deterministic certification gate](test/hrr033-certification/README.md)
documents the focused context and Resonator evidence workflow used for deeper
browser-first regression certification. Implementation notes for the Alpha
demo-hardening pass — the workspace toggle, new-tab handling, task monitor, and
the launchd-managed bridge — are recorded in
[Augmentor demo hardening](docs/2026-07-20-augmentor-demo-hardening.md).

Bridge or shared-package changes may also require:

```bash
npm run test:browser-host
npm test -- --run
npm run build
```

Read the [bridge README](host/README.md) for host-specific details and
[CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request into `dev`.
Current responsibility, verified status, and release workflow are routed by
[Module Ownership](../docs/architecture/MODULE-OWNERSHIP.md),
[Status](../docs/STATUS.md), and
[Project Governance](../docs/PROJECT_GOVERNANCE.md).
