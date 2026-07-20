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

## See also

- `browser-first/test/bridge-first-run-smoke.test.mjs` — CI smoke test for the in-repo bug classes (1 and 4).
- Issues #199–#204 — the original diagnoses.
