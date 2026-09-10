# Browser-first bridge — first-time setup runbook

Deploying the browser-first bridge on a host and pointing the side-panel
extension at it from a remote Chrome (e.g. a Pi5 bridge on Tailscale/LAN, with
the extension on Windows 11 Chrome) crosses **five independent failure modes**
that each leave the dashboard iframe dead. This runbook walks the full stack so
you don't have to rediscover them. It is the in-repo companion to the CI smoke
test (`browser-first/test/bridge-first-run-smoke.test.mjs`).

## Architecture at a glance

```
Chrome (extension side panel)  --HTTPS/h1-->  Caddy :19443  --HTTP-->  bridge :47773
                                                                          |
                                                     reverse-proxies /hermes-dashboard/*
                                                                          v
                                                             Hermes dashboard :9119
```

- **Bridge HTTP** listens on `127.0.0.1:47773` (`RESONANTOS_BROWSER_FIRST_BRIDGE_PORT`).
- **Caddy** terminates TLS on `:19443` and reverse-proxies to the bridge.
- **Hermes dashboard** runs on `:9119` (`RESONANTOS_HERMES_DASHBOARD_PORT`); the
  bridge mirror-proxies it under `/hermes-dashboard/*` so the iframe loads a
  same-origin URL (avoids mixed-content blocking).
- The bridge can bind to `0.0.0.0` for LAN/Tailscale (`RESONANTOS_BRIDGE_HOST`);
  gate clients with `RESONANTOS_BRIDGE_ALLOWED_IPS` (e.g. `192.168.0.0/16,100.64.0.0/10`).

## Dev server hardening (#429)

The dev server refuses to serve `bridge-config.generated.js` and anything under `ResonantOS_User/`.
The exposure only existed while `npm run dev` was running.

## The five first-run bug classes

| # | Symptom | Root cause | Fix / status |
|---|---|---|---|
| 1 | iframe hangs blank; no DevTools error (cross-origin) | dashboard proxy didn't mirror `/auth`; the Hermes SPA's `/auth/login` redirect hit the 404 catch-all | `/auth` added to `DASHBOARD_PROXY_MIRROR_PATHS` (PR #199/#258). Smoke-tested. |
| 2 | login page 500s | Hermes upstream `auth_login` raises `NotImplementedError` on BasicAuthProvider | upstream hermes-agent issue — configure a working auth provider |
| 3 | chat panel `[session ended (code 1006)]`; WS won't connect | Caddy advertises `h2` via TLS ALPN; the bridge WS upgrade handler is RFC 6455 (HTTP/1.1) only, not RFC 8441 Extended CONNECT | **pin ALPN to `http/1.1`** — see [Caddy config](#caddy-config) below (issue #201) |
| 4 | every capability route 403s; bootstrap 500 `Unknown bridge capability requested` | the launcher's capability-token mint map drifted from the extension's allowlist | canonical `bridge-capability-tokens.mjs` + CI drift guard (PR #256). See [audit](#capability-token-audit). |
| 5 | WS upgrades rejected | WS auth middleware rejecting upgrades for missing ticket/token | ensure `/api/auth/ws-ticket` is reachable and the IP allowlist admits the client |

## Pre-flight checklist

1. **Bridge bound and reachable.** Start the bridge; confirm `GET http://127.0.0.1:47773/` responds. For remote access set `RESONANTOS_BRIDGE_HOST=0.0.0.0` and an allow-list: `RESONANTOS_BRIDGE_ALLOWED_IPS=192.168.0.0/16,100.64.0.0/10`.
2. **Dashboard up.** Confirm the Hermes dashboard answers on `:9119`.
3. **Caddy ALPN pinned to h1** (see below) — the single most common silent failure.
4. **Capability-token map covers the extension** — run the audit below; CI enforces it.
5. **Extension bridge target set.** In the side panel → *Settings › Bridge Target*, point at `https://<bridge-host>:19443` (or leave blank on the bridge host itself — loopback is auto-detected).

## Caddy config

Use the checked-in [`browser-first/host/caddy-bridge-h1.json`](../browser-first/host/caddy-bridge-h1.json). Replace the certificate/key paths, then:

```bash
sudo caddy reload --config /etc/caddy/caddy-bridge-h1.json --address 127.0.0.1:2019
```

**Why JSON, not a Caddyfile:** the Caddyfile `servers { protocols h1 }` directive controls only plaintext HTTP protocol selection — it does **not** change the TLS ALPN advertisement, which still offers `h2`. Only the JSON field `apps.http.servers.srv0.tls_connection_policies[].alpn: ["http/1.1"]` pins ALPN. This has caused two separate production incidents; there is no Caddyfile directive for it.

**Verify the pin took:**

```bash
echo | openssl s_client -connect <bridge-host>:19443 -alpn h2,http/1.1 2>/dev/null | grep "ALPN protocol"
# MUST report:  ALPN protocol: http/1.1     (never "h2")
```

> Long-term, the bridge's WebSocket upgrade handler should implement RFC 8441
> Extended CONNECT so HTTP/2 works directly; until then, pinning ALPN to h1 is
> the supported configuration (issue #201).

## Capability-token audit

The extension requests a fixed set of capabilities (`RUNTIME_CAPABILITY_ALLOWLIST`,
derived from `BRIDGE_ROUTE_CAPABILITIES` in the extension's `bridge-client.js`).
The bridge launcher must mint a token for each, or bootstrap 500s. Both are now
derived from a single canonical source, `browser-first/host/bridge-capability-tokens.mjs`.
Every bridge route now requires a per-route capability token in addition to the
bridge token, and `bridge-route-capability-audit` fails when a route is ungated.
Routes that declare neither `requiredCapability` nor `requiredCapabilityBootstrap`
are refused by default as defense in depth; the audit test remains the readable
gate for route capability coverage.
Read-only bridge status, memory, and extension preference routes are protected
by `bridge-diagnostics-read`, `memory-read`, and `extension-prefs-read`.

```bash
# CI-equivalent drift check — must pass before any deploy:
node --test browser-first/test/bridge-capability-token-consistency.test.mjs
```

If a deploy predates the canonical source, diff the two by hand: every value in
the extension's `RUNTIME_CAPABILITY_ALLOWLIST` must be a key in the launcher's
`bridgeCapabilityTokens`. A missing key is the exact name in the bootstrap 500's
`Unknown bridge capability requested: <name>` message.

## Decision-tree diagnostic

The iframe is broken. Work top-down:

1. **Blank iframe, nothing in DevTools?** → likely Bug 1. `curl -sk https://<host>:19443/auth/login` — a 404 with `Unknown browser-first bridge route` means `/auth` isn't mirrored.
2. **Login page 500?** → Bug 2 (upstream Hermes auth). Check the dashboard logs.
3. **`[session ended (code 1006)]` in chat?** → Bug 3. Run the `openssl … ALPN protocol` check; if it says `h2`, the ALPN pin didn't take.
4. **Routes 403 / bootstrap 500?** → Bug 4. `curl -sk -X POST https://<host>:19443/api/capability-tokens …` — a body of `Unknown bridge capability requested: <name>` means the launcher map is missing `<name>`; run the audit.
5. **WS rejected before 101?** → Bug 5. Confirm the client IP is in `RESONANTOS_BRIDGE_ALLOWED_IPS` and `/api/auth/ws-ticket` is reachable.

## OpenCode server binding

- **Default:** the bridge picks a free loopback port itself (never 4096 or 4231 — note that `opencode serve --port 0` would otherwise reuse 4096 whenever it is free), spawns `opencode serve --hostname 127.0.0.1 --port <picked>`, and confirms the port against the `opencode server listening on http://127.0.0.1:<port>` line; the OpenCode server binds to an ephemeral loopback port and the bridge mints a random Basic-auth credential for it. The chosen port is recorded in `~/ResonantOS_User/BrowserFirst/opencode-server.json` once the server is ready (and is visible via `lsof -nP -iTCP -sTCP:LISTEN | grep opencode`). Nothing listens on the old fixed port 4231.
- **Override:** `RESONANTOS_OPENCODE_PORT=<port>` pins the port for debugging; the credential is still required. If the bridge environment already sets `OPENCODE_SERVER_PASSWORD`, that operator-set password is respected instead of a minted one.
- **How to confirm:**
  ```bash
  lsof -nP -iTCP:4231 -sTCP:LISTEN   # prints nothing
  curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/doc   # -> 401
  ```
- **Residual exposure (documented, not fixed here):** the password is present in the `opencode serve` child environment (readable by other processes of the same user, and inherited by any subprocess OpenCode itself spawns) — env is the only secret channel the binary supports. A bridge killed with `SIGKILL` can leave an authenticated orphan on a random port until the next bridge start reaps it via the PID record. The extension's `/event` fetch relies on MV3 `host_permissions` to send the header cross-origin. These are tracked under #326 and #321.
- **Recovery:** if the bridge reports "did not announce a listening port", check the opencode binary version (`opencode --version`, expected ≥ 1.18) and confirm `opencode serve --hostname 127.0.0.1 --port <any free port>` prints the listening line.

## Delegation confinement

OpenCode and Hermes CLI delegations are isolated at the host process boundary
before the bridge spawns the local runtime. On macOS, the bridge wraps each
delegation in `/usr/bin/sandbox-exec` with a per-run profile that denies writes
outside explicit runtime, prompt, temporary, and workspace roots, and denies
reads of well-known secret stores plus the generated bridge config. If
`sandbox-exec` is unavailable on macOS, delegation fails closed unless the
operator sets `RESONANTOS_DELEGATION_ISOLATION=contract-only`; that override is
recorded in the add-on governance audit.

On Linux and Windows, delegation currently runs in `contract-only` mode: the
bridge records the requested isolation mode and a bounded change manifest, but
there is no OS confinement primitive. Each run appends a governance audit entry
with the add-on id, task id, isolation mode, denial count when available, change
counts, and outcome; audit entries do not include prompt text, file paths, or
credential values.

Residuals:

- The CLI's own config may hold provider keys and stays readable.
- Network access is unrestricted.
- `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` reach the unconfined OpenCode server over loopback.
- `mach-lookup` is open, so `open`, `osascript`, `launchctl`, and `ssh localhost` can have work done outside the sandbox.
- Hard links inside the workspace can alias outside inodes.
- Unix sockets such as `/var/run/docker.sock` are readable.
- The change manifest sees only the snapshotted roots.
- The Hermes dashboard server and OpenCode server are not confined.
- Cross-platform isolation is a separate ADR.

## Web-mode shell transport (#374)

The shell transport (`src/core/web-transport.ts`) requests only
`provider-diagnostics-read` and `provider-model-invoke` from
`POST /api/capability-tokens`, using the bridge token and capability-bootstrap
token in `globalThis.__RESONANTOS_BRIDGE_CONFIG__`. It memoizes the scoped tokens,
shares an in-flight bootstrap between concurrent calls, and attaches the token
required by each route. Failed bootstraps are not cached.

A capability-missing 403 triggers exactly one re-bootstrap and route retry.
This recovers from capability-token rotation while the bridge and bootstrap
tokens remain valid. After a full bridge restart, the caller must refresh
`globalThis.__RESONANTOS_BRIDGE_CONFIG__` from the regenerated config; the
transport reads it on every call and a changed URL or either credential triggers
a fresh bootstrap. Other 403s and 401s do not trigger retries. Tokens never appear
in transport-generated error messages.

Nothing delivers `__RESONANTOS_BRIDGE_CONFIG__` to a browser page yet. Browser
use also requires the operator's CORS opt-in at the bridge through
`RESONANTOS_BRIDGE_ALLOWED_ORIGINS`. Config delivery and browser-origin setup
are tracked in #429, together with the dev-server exposure warning: while
`npm run dev` runs, the generated config file is served to local processes.

## Live SDK lane

`npm run test:browser-first:live-sdk` proves the browser-first bridge and SDK-facing add-on routes work together in an isolated live run: capability bootstrap covers the extension allowlist, OpenCode serve uses a credentialed ephemeral loopback port, execution settings gate local CLI execution, public add-on manifests remain structurally valid, and the Settings Overview cards call capability-mapped bridge routes without 403s.

The lane stages a temporary copy of the extension and passes it to both the bridge (`RESONANTOS_EXTENSION_ROOT`) and Chrome, so it is safe to run from the same checkout that serves a deployed bridge; the checkout's `src/bridge-config.generated.js` mtime and hash are checked for drift.

Run the local provider-backed lane with:

```bash
RESONANTOS_LIVE_SDK_MODEL=<provider/model> npm run test:browser-first:live-sdk
```

Without `RESONANTOS_LIVE_SDK_MODEL`, CI mode records terminal OpenCode CLI evidence without requiring a real provider credential. With `RESONANTOS_LIVE_SDK_MODEL`, local mode expects the real OpenCode delegation to complete and return a non-empty artifact. Evidence lands in `RESONANTOS_LIVE_ARTIFACT_DIR` when set, otherwise under the system temp directory at `resonantos-live-sdk/<timestamp>`. The OpenCode drift detector reads the pinned version from [`../browser-first/host/opencode-version.json`](../browser-first/host/opencode-version.json).

If an older lane rewrote the deployed checkout config, restart the launchd-managed bridge to regenerate it:

```bash
launchctl kickstart -k gui/$(id -u)/resonantos.browser-first.bridge
```

During shutdown, the bridge now clears OpenCode PID records written by the current bridge process before exiting and the live lane waits for the child process to die before evaluating teardown evidence.

## See also

- `browser-first/test/bridge-first-run-smoke.test.mjs` — CI smoke test for the in-repo bug classes (1 and 4).
- Issues #199–#204 — the original diagnoses.

Deep manifest validation (the SDK's `validateAddOnManifest`) is not part of the lane yet: the validator is TypeScript and the Node lane has no loader. The lane validates every public manifest structurally; deep validation stays a follow-up.
