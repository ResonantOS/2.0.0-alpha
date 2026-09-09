# Browser-First Local Bridge

This directory implements the authenticated local Node.js bridge used by the
Chrome Manifest V3 extension. It owns host-mediated provider routing, Living
Archive services, add-on delegation, extension preferences, diagnostics, and
browser-control routes for the Alpha.

The bridge is the only active Alpha host. It does not launch a desktop shell or
native browser bundle.

## Run The Bridge

From the repository root:

```bash
npm run browser-first:bridge
```

The root launcher delegates to `browser-first/host/run-bridge-minimal.mjs`.
The bridge binds to `127.0.0.1` by default, generates a bridge token and scoped
capability credentials, and writes the active connection config to
`browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js`
with user-only permissions.

Keep the generated config, `ResonantOS_User/`, provider secrets, browser state,
and diagnostics containing local paths out of Git.

## Process Environment

The launcher reads `process.env`; it does not load dotenv files. Export optional
values in the terminal that starts the bridge. For example:

```bash
export OPENAI_API_KEY="replace-with-your-key"
npm run browser-first:bridge
```

Common bridge settings include `RESONANTOS_BROWSER_FIRST_BRIDGE_PORT` for the
requested port and `RESONANTOS_BROWSER_FIRST_USER_ROOT` for local user state.
Keep the default loopback host for normal Alpha development. Network exposure
changes the security boundary and requires explicit allowlists, threat review,
and dedicated validation.

## Dev-only external-agent-runtimes panel

The bridge can serve an opt-in development panel that enumerates
`examples/addons/*.json` and renders one status card per manifest, flagging
manifests that request the external-agent-runtime trigger capabilities
(`providers` + `agent-delegation`). It answers "what do the add-on manifests
look like to the running bridge?" while working on the add-on SDK. It is not a
user-facing or production surface: the routes exist only when the bridge is
started with the explicit `--dev-panel` flag, and no environment variable
enables them implicitly.

```bash
npm run browser-first:bridge -- --dev-panel
```

Without the flag the routes are absent and the `/dev/` path fails closed to
the bridge's default-deny 404.

Two routes are registered:

- `GET /dev/external-agent-runtimes` returns the manifest listing as JSON.
- `GET /dev/external-agent-runtimes/` serves the
  [panel page](../dev/external-agent-runtimes-panel.html) with the same
  listing injected as inert JSON data.

Both routes keep the bridge's normal authentication: the generated bridge
token plus a caller-bound `addon-runtime-read` capability token, sent as the
`X-ResonantOS-Bridge-Token` and `X-ResonantOS-Bridge-Capability-Token`
headers. Loopback or private-network source addresses do not bypass
authentication, so direct unauthenticated browser navigation is not supported;
use an HTTP client that sets the same headers the extension bridge client
uses. Never place tokens in the URL or copy them into notes, issues, or pull
requests.

The panel is observational. It displays only whitelisted manifest fields —
`id`, `name`, `version`, `runtimeType`, `service.entrypoint`, tool names, and
the trigger-capability flag. Unknown or extension manifest fields (including
credentials, prompts, and paths) never pass through, and the panel does not
launch providers, mint grants, or write files.

Ownership is recorded in
[Module Ownership](../../docs/architecture/MODULE-OWNERSHIP.md). Behavior is
pinned by
[dev-external-agent-runtimes-panel.test.mjs](../test/dev-external-agent-runtimes-panel.test.mjs)
and
[dev-external-agent-runtimes-panel-http.test.mjs](../test/dev-external-agent-runtimes-panel-http.test.mjs).

## Security Contract

- Every protected route requires the generated bridge token.
- Capability-protected routes also require a scoped capability token.
- Raw route capability tokens are not written to generated extension config.
- Provider credentials remain in session-only host memory or the bridge process
  environment; the Alpha host does not persist credentials entered in Settings.
- Generated config is local credential material, not a distributable asset.
- Wallet approvals, signatures, transactions, payments, credential entry, and
  other privileged browser actions remain human-only.
- Diagnostics must redact provider values, credentials, and full private paths.

Read [Module Ownership](../../docs/architecture/MODULE-OWNERSHIP.md) and the
[Alpha runtime boundary](../../docs/architecture/ALPHA_RUNTIME_BOUNDARY.md)
before adding a route or moving responsibility across services.

## Validate Changes

```bash
npm run test:browser-first
```

Run the security pipeline for authentication, capability, secret, path, or
subprocess changes:

```bash
node scripts/security-pipeline/run-check.mjs
```

Use the root [installation guide](../../INSTALL.md) for end-to-end setup and
[CONTRIBUTING.md](../../CONTRIBUTING.md) for pull requests into `dev`. Current
delivery state and Project 2 rules live in [Status](../../docs/STATUS.md) and
[Project Governance](../../docs/PROJECT_GOVERNANCE.md).

## First-time bridge deployment

Deploying the bridge on a host and pointing a remote Chrome at it crosses
several independent failure modes (proxy `/auth` mirror, Caddy TLS ALPN,
capability-token map coverage, WebSocket upgrades). Follow the
[bridge first-time-setup runbook](../../docs/browser-first-bridge-setup-runbook.md),
and use the checked-in [`caddy-bridge-h1.json`](caddy-bridge-h1.json) to pin
Caddy's TLS ALPN to `http/1.1` (required for the dashboard WebSockets).
