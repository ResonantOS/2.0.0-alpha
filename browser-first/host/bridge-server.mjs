import { writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

const bridgeTokenHeader = "x-resonantos-bridge-token";
const bridgeTokenHeaderName = "X-ResonantOS-Bridge-Token";
const bridgeCapabilityHeader = "x-resonantos-bridge-capability-token";
const bridgeCapabilityHeaderName = "X-ResonantOS-Bridge-Capability-Token";
const bridgeCapabilityBootstrapHeader = "x-resonantos-capability-bootstrap-token";
const bridgeCapabilityBootstrapHeaderName = "X-ResonantOS-Capability-Bootstrap-Token";

// ResonantOS bridge network configuration
// (read by startBridgeServer / writeBridgeConfig)
//
// RESONANTOS_BRIDGE_HOST   - bind address (default 127.0.0.1; use 0.0.0.0 to
//                            expose to LAN/Tailscale, or a specific IP)
// RESONANTOS_BRIDGE_PUBLIC_URL - URL written into the generated bridge config
//                            (default: "http://${RESONANTOS_BRIDGE_HOST}:port")
// RESONANTOS_BRIDGE_ALLOWED_ORIGINS - comma-separated list of allowed
//                            `Origin` headers (e.g. "chrome-extension://abc,
//                            chrome-extension://def"). Default: empty
//                            (extensionOrigin passed at startup only).
// RESONANTOS_BRIDGE_ALLOWED_IPS - comma-separated list of allowed client IPs
//                            (e.g. "192.168.0.0/16,100.100.0.0/16"). Default:
//                            empty (no IP gating).
// RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES - comma-separated list of URL
//                            path prefixes (e.g. "/hermes-dashboard")
//                            that do NOT require the bridge token to
//                            load. Useful when embedding the proxy as
//                            an <iframe src> — browsers can't set
//                            custom headers on iframe requests, so the
//                            SPA's first paint would 401 without this.
//                            Auth is still enforced via the IP allowlist
//                            (RESONANTOS_BRIDGE_ALLOWED_IPS) so only
//                            LAN/Tailscale clients can hit these paths.

function parseAllowedList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ipToBigInt(ip) {
  // IPv4 only — Tailscale and LAN are IPv4. IPv6 expansion out of scope.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  return ip.split(".").reduce((acc, octet) => {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    return (acc << 8n) + BigInt(n);
  }, 0n);
}

function ipv4InCidr(ip, cidr) {
  const [base, maskBits] = cidr.split("/");
  const bits = maskBits === undefined ? 32 : Number(maskBits);
  const ipInt = ipToBigInt(ip);
  const baseInt = ipToBigInt(base);
  if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffffn : (~((1n << (32n - BigInt(bits))) - 1n)) & 0xffffffffn;
  return (ipInt & mask) === (baseInt & mask);
}

function clientIpAllowed(remoteAddress, allowedCidrs) {
  if (!allowedCidrs || allowedCidrs.length === 0) return true;
  // Strip IPv6-mapped prefix (::ffff:127.0.0.1) for compatibility
  const raw = String(remoteAddress ?? "").replace(/^::ffff:/, "");
  return allowedCidrs.some((cidr) => ipv4InCidr(raw, cidr));
}

export function createBridgeToken() {
  return randomBytes(32).toString("base64url");
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorizedBridgeRequest(request, bridgeToken) {
  return constantTimeEqual(request.headers[bridgeTokenHeader], bridgeToken);
}

function dashboardProxyPathPrefix() {
  // The extension iframe lives on a chrome-extension:// page (treated as a
  // secure origin by Chrome). Embedding http://<pi>:9119/... directly in an
  // iframe is blocked as mixed content. Solution: the bridge reverse-proxies
  // the Hermes dashboard under this prefix, so the iframe loads a same-origin
  // URL on the bridge and Chrome is happy.
  return "/hermes-dashboard";
}

// The proxy mirrors a set of bridge paths to the upstream's own URL space.
// The SPA lives at /hermes-dashboard/, but it also fetches
// /api/..., /assets/..., /fonts-terminal/..., /dashboard-plugins/..., and
// /favicon.ico with absolute paths (in the HTML, CSS, and JS bundle
// literals — paths that bypass any <base> tag). Mirroring each of those at
// the bridge root means the SPA's hardcoded absolute paths hit the proxy
// without any HTML/CSS/JS rewriting — the proxy just forwards them to the
// upstream as-is.
//
// Each entry is { bridge, upstream }. The bridge handler matches the
// request path against each entry's `bridge` prefix (longest match wins),
// strips it, and prefixes the upstream prefix to get the final upstream
// path. See createDashboardProxyHandler for the full set of rules.
export const DASHBOARD_PROXY_MIRROR_PATHS = Object.freeze([
  Object.freeze({ bridge: "/hermes-dashboard", upstream: "" }),
  Object.freeze({ bridge: "/auth", upstream: "/auth" }),
  Object.freeze({ bridge: "/api", upstream: "/api" }),
  Object.freeze({ bridge: "/assets", upstream: "/assets" }),
  Object.freeze({ bridge: "/fonts-terminal", upstream: "/fonts-terminal" }),
  Object.freeze({ bridge: "/dashboard-plugins", upstream: "/dashboard-plugins" }),
  Object.freeze({ bridge: "/favicon.ico", upstream: "/favicon.ico" }),
]);

function dashboardProxyPathMatches(pathPart) {
  return matchMirrorPath(pathPart, DASHBOARD_PROXY_MIRROR_PATHS) !== null;
}

export function getDashboardProxyPathPrefix() {
  return dashboardProxyPathPrefix();
}

export function dashboardProxyUrl({ publicUrl, port }) {
  if (publicUrl) {
    // Strip any trailing slashes so we always get exactly one "/" before the
    // path prefix.
    const base = publicUrl.replace(/\/+$/, "");
    return `${base}${dashboardProxyPathPrefix()}/`;
  }
  if (Number.isInteger(Number(port))) {
    const explicit = getBridgePublicUrl(Number(port));
    const base = explicit.replace(/\/+$/, "");
    return `${base}${dashboardProxyPathPrefix()}/`;
  }
  // No public URL and no port — caller hasn't started the bridge yet, or
  // the launcher doesn't care about the proxy URL. Return null so callers
  // can fall back to the direct URL.
  return null;
}

function dashboardProxyPort() {
  const explicit = process.env.RESONANTOS_HERMES_DASHBOARD_PORT;
  if (explicit) {
    const n = Number(explicit);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return 9119;
}

// The proxy needs to talk to the dashboard process over loopback (or whatever
// local interface the bridge itself is on). If the bridge binds to a specific
// IP, the dashboard should also be on that IP (per the start command in
// addon-delegation-service.mjs), so we use the same host. If the bridge binds
// to 0.0.0.0 / :: (any), we use loopback — which is always reachable.
function dashboardProxyHostname() {
  const host = getBridgeHost();
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

// Hop-by-hop and request-shape headers that must not be forwarded when
// proxying. The browser-to-bridge and bridge-to-upstream connections are
// independent; copying these would either confuse the upstream or leak
// connection identity.
//
// Note: `content-length` and `content-encoding` are deliberately NOT
// in this set. We forward them so clients can know the full response
// size without parsing chunked transfer encoding, and so gzip-encoded
// responses survive the proxy hop intact.
//
// We also strip the bridge-token and capability-token headers so the
// upstream (e.g. Hermes on 127.0.0.1) never sees them — the upstream
// is local and uses its own session cookie.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  bridgeTokenHeader,
  bridgeCapabilityHeader,
  bridgeCapabilityBootstrapHeader,
]);

function pickAllowedOrigin(requestHeaders, extensionOrigin, allowedOrigins) {
  const requestOrigin = requestHeaders?.origin;
  if (requestOrigin && extensionOrigin && requestOrigin === extensionOrigin) {
    return requestOrigin;
  }
  if (requestOrigin && allowedOrigins && allowedOrigins.length > 0) {
    // Exact match first.
    if (allowedOrigins.includes(requestOrigin)) {
      return requestOrigin;
    }
    // Wildcard match: any entry ending in "*" is a prefix match. We
    // support this because the same extension zip is meant to install
    // unchanged on multiple machines — the extension ID is derived
    // from the manifest's "key" field and may not be known in advance
    // when the bridge's allowed-origins env var is set.
    for (const allowed of allowedOrigins) {
      if (allowed.endsWith("*") && requestOrigin.startsWith(allowed.slice(0, -1))) {
        return requestOrigin;
      }
    }
    return null;
  }
  // Default behaviour: echo the configured extensionOrigin (or `*` for any
  // request that didn't send an Origin header, e.g. self-tests).
  if (!requestOrigin) {
    return extensionOrigin ?? "*";
  }
  return extensionOrigin;
}

function shouldDropUpstreamResponseHeader(headerName) {
  const lower = String(headerName).toLowerCase();
  return HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith("access-control-") || lower === "vary";
}

function writeJson(response, status, payload, extensionOrigin, requestHeaders, allowedOrigins) {
  const allowOrigin = pickAllowedOrigin(requestHeaders, extensionOrigin, allowedOrigins);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": `Content-Type, ${bridgeTokenHeaderName}, ${bridgeCapabilityHeaderName}, ${bridgeCapabilityBootstrapHeaderName}`,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Vary": "Origin",
  };
  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

// Streaming reverse proxy for the Hermes dashboard. The browser-side iframe
// is on a chrome-extension:// origin (treated as secure by Chrome), so
// embedding http://<bridge-host>:9119/... is blocked as mixed content. By
// serving the dashboard at <bridge-origin><proxyPrefix>/... the iframe
// becomes same-origin to the bridge and loads without mixed-content
// complaints. The bridge-token header is required; the upstream (Hermes on
// 127.0.0.1:<dashboardProxyPort()>) has its own session-based auth.
function createDashboardProxyHandler({
  bridgeToken,
  extensionOrigin,
  allowedOrigins,
  openPathPrefixes = [],
}) {
  return createAddonProxyHandler({
    bridgeToken,
    extensionOrigin,
    allowedOrigins,
    openPathPrefixes,
    // The upstream lives on the bridge host.
    upstreamHostname: dashboardProxyHostname,
    upstreamPort: dashboardProxyPort,
    addonId: "hermes",
    addonLabel: "Hermes dashboard",
    notRunningHint: (port) =>
      `Hermes dashboard is not running on 127.0.0.1:${port}. ` +
      `Use the Bridge Target settings to start it, then refresh.`,
    // The proxy mirrors a set of bridge paths to the upstream's own URL
    // space. The SPA lives at /hermes-dashboard/, but it also fetches
    // /api/..., /assets/..., /fonts-terminal/..., /dashboard-plugins/...,
    // and /favicon.ico with absolute paths that bypass any <base> tag.
    // Mirroring each of those at the bridge root means the SPA's
    // hardcoded absolute paths hit the proxy without any HTML/CSS/JS
    // rewriting — the proxy just forwards them to the upstream as-is.
    //
    // Each entry is { bridge, upstream }. The bridge handler matches
    // the request path against each entry's `bridge` prefix (longest
    // match wins), strips it, and prefixes the upstream prefix to get
    // the final upstream path.
    //
    //   /hermes-dashboard/      -> /            (strip primary prefix)
    //   /hermes-dashboard/api/x -> /api/x
    //   /api/x                  -> /api/x       (mirror at root, no change)
    //   /assets/x               -> /assets/x
    //   /fonts-terminal/x       -> /fonts-terminal/x
    //   /dashboard-plugins/x    -> /dashboard-plugins/x
    //   /favicon.ico            -> /favicon.ico
    mirrorPaths: DASHBOARD_PROXY_MIRROR_PATHS,
  });
}

// WebSocket upgrade handler. Node's http server emits "upgrade" (not
// "request") for WebSocket handshakes, so this lives on a separate
// code path from the request handler. We perform IP allowlist + token
// checks identical to the request handler, then forward the upgrade
// to the upstream and pipe bytes both directions. The browser's
// WebSocket client can't set custom headers, so the openPathPrefixes
// exemption is what makes iframe WebSockets work (the IP allowlist
// is still enforced).
function createDashboardProxyUpgradeHandler({
  bridgeToken,
  allowedCidrs = [],
  upstreamHostname,
  upstreamPort,
  addonId = "hermes",
  addonLabel = "Hermes dashboard",
  notRunningHint = (port) => `${addonLabel} is not running on port ${port}.`,
  openPathPrefixes = [],
  mirrorPaths = DASHBOARD_PROXY_MIRROR_PATHS,
}) {
  return function handleProxyUpgrade(request, clientSocket, head) {
    const remoteAddress = clientSocket?.remoteAddress;
    const pathPart = (request.url ?? "/").split("?")[0] ?? "/";
    if (allowedCidrs.length > 0 && !clientIpAllowed(remoteAddress, allowedCidrs)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    if (!isAuthorizedBridgeRequest(request, bridgeToken)) {
      const isOpenPath = openPathPrefixes.some(
        (openPrefix) => pathPart === openPrefix || pathPart.startsWith(`${openPrefix}/`),
      );
      if (!isOpenPath) {
        clientSocket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        clientSocket.destroy();
        return;
      }
    }
    const matched = matchMirrorPath(pathPart, mirrorPaths);
    if (!matched) {
      clientSocket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    let upstreamPath = `${matched.entry.upstream}${matched.remainder}`;
    if (!upstreamPath.startsWith("/")) upstreamPath = `/${upstreamPath}`;
    if (upstreamPath === "") upstreamPath = "/";
    const queryIndex = request.url.indexOf("?");
    const upstreamQuery = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    const finalUpstreamPath = `${upstreamPath}${upstreamQuery}`;
    const upstreamPortValue = typeof upstreamPort === "function" ? upstreamPort() : upstreamPort;
    const upstreamHostnameValue = typeof upstreamHostname === "function" ? upstreamHostname() : upstreamHostname;
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
      const lower = String(key).toLowerCase();
      // For a regular HTTP forward, hop-by-hop headers (Connection,
      // Upgrade, etc.) are dropped — they're meaningful only between
      // adjacent hops. For a WebSocket upgrade, however, the
      // upstream needs to see them so it knows to respond with 101.
      // Re-inject them here.
      if (HOP_BY_HOP_HEADERS.has(lower) && lower !== "connection" && lower !== "upgrade") continue;
      headers[lower] = value;
    }
    // Ensure Connection/Upgrade are present so the upstream treats
    // this as a real upgrade. Browsers always send these, but other
    // WebSocket clients (e.g. `ws`, websocket-as-library) might not.
    headers["connection"] = "Upgrade";
    headers["upgrade"] = "websocket";

    // We use a raw net.Socket to the upstream (not http.request)
    // because http.request's upgrade event semantics in Node 22 are
    // surprising: the response bytes are still buffered in the socket
    // after the upgrade event fires, so a naive pipe() to the client
    // duplicates the 101 response, which the client then misparses as
    // a WebSocket frame with stray RSV1 bits set. Using net.Socket we
    // get clean control: we parse the response headers ourselves,
    // forward them to the client, then pipe raw bytes both ways.

    const upstreamSocket = net.connect(upstreamPortValue, upstreamHostnameValue, () => {
      const headerLines = [`${request.method} ${finalUpstreamPath} HTTP/1.1`];
      headerLines.push(`Host: ${upstreamHostnameValue}:${upstreamPortValue}`);
      for (const [k, v] of Object.entries(headers)) {
        if (k === "host") continue;
        headerLines.push(`${k}: ${v}`);
      }
      upstreamSocket.write(headerLines.join("\r\n") + "\r\n\r\n");
      if (head && head.length > 0) upstreamSocket.write(head);
    });

    let clientToUpstreamPiped = false;
    let queuedClientData = [];
    const setupBidirectionalPipe = () => {
      if (clientToUpstreamPiped) return;
      clientToUpstreamPiped = true;
      // Forward any data the client sent during the upgrade handshake
      // (we held it back so it wouldn't be double-sent with the request
      // we wrote in the connect callback).
      for (const chunk of queuedClientData) upstreamSocket.write(chunk);
      queuedClientData = [];
      clientSocket.pipe(upstreamSocket);
    };
    // Hold the client's WebSocket data back until the upgrade
    // handshake is complete. The connect callback already wrote the
    // HTTP request + the initial `head` (bytes after the client's own
    // request line + headers). Forwarding the same `head` via pipe
    // would double-send it to the upstream.
    clientSocket.on("data", (chunk) => {
      if (clientToUpstreamPiped) return;
      queuedClientData.push(chunk);
    });
    upstreamSocket.on("close", () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
    clientSocket.on("close", () => {
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    });

    let responseHeadersDone = false;
    let responseBuffer = Buffer.alloc(0);
    upstreamSocket.on("data", (chunk) => {
      if (responseHeadersDone) {
        clientSocket.write(chunk);
        return;
      }
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const end = responseBuffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      // Parse the status line + headers from the response.
      const responseText = responseBuffer.slice(0, end).toString("ascii");
      const responseLines = responseText.split("\r\n");
      const statusLineParts = (responseLines[0] || "").match(/^HTTP\/\S+\s+(\d+)\s*(.*)$/);
      const statusCode = statusLineParts ? Number(statusLineParts[1]) : 101;
      const statusMessage = statusLineParts ? statusLineParts[2] : "Switching Protocols";
      const upstreamHeaderMap = {};
      for (const line of responseLines.slice(1)) {
        const idx = line.indexOf(":");
        if (idx > 0) {
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
          upstreamHeaderMap[k] = v;
        }
      }
      // Re-inject the canonical Connection/Upgrade headers (we just
      // filtered them above) so the client sees a real 101 response.
      const responseOut = [
        `HTTP/1.1 ${statusCode} ${statusMessage}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        ...Object.entries(upstreamHeaderMap).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ].join("\r\n");
      clientSocket.write(responseOut);
      // Any data past the response headers is the first WebSocket
      // frame(s) from the upstream. Forward as-is.
      const remainder = responseBuffer.slice(end + 4);
      if (remainder.length > 0) clientSocket.write(remainder);
      responseHeadersDone = true;
      responseBuffer = null;
      // Now that the upgrade handshake is complete, start forwarding
      // any client data the client sent during the handshake
      // (queuedClientData) and pipe client→upstream for new data.
      setupBidirectionalPipe();
    });

    upstreamSocket.on("error", (err) => {
      const message = err?.code === "ECONNREFUSED"
        ? notRunningHint(upstreamPortValue)
        : `${addonLabel} proxy upstream error: ${err?.message ?? String(err)}`;
      const body = Buffer.from(JSON.stringify({ ok: false, error: message, addon: addonId }), "utf8");
      if (!clientSocket.destroyed) {
        clientSocket.write(
          "HTTP/1.1 502 Bad Gateway\r\n" +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${body.length}\r\n` +
          "Connection: close\r\n\r\n",
        );
        clientSocket.write(body);
        clientSocket.destroy();
      }
    });
  };
}

// Find the longest matching mirror-path entry for `pathPart`. Returns
// the entry and the remainder (the path minus the matched bridge
// prefix). Returns null if no entry matches.
//
// Matches "exact" (pathPart === bridge) and "prefix" (pathPart starts
// with `${bridge}/`) so that /api doesn't accidentally swallow /apiary
// or /apis.
function matchMirrorPath(pathPart, mirrorPaths) {
  let best = null;
  for (const entry of mirrorPaths) {
    const b = entry.bridge;
    if (
      pathPart === b ||
      pathPart.startsWith(b.endsWith("/") ? b : `${b}/`)
    ) {
      if (!best || b.length > best.bridge.length) {
        const remainder = pathPart.slice(b.length);
        best = { entry, remainder };
      }
    }
  }
  return best;
}

// Generic, addon-agnostic byte-forwarder. The bridge exposes
// <prefix>/* which the extension hits (either as a same-origin <iframe src>
// when same-origin to the bridge, or — for chrome-extension:// — the
// extension fetches each path via bridgeRequest() and inlines the HTML/
// CSS/JS into a sandboxed <iframe srcdoc> on its own secure page. That's
// how the iframe embed survives Chrome's mixed-content rule for any addon,
// no per-machine TLS or cert install required).
//
// The handler is intentionally minimal:
//   - same header hop-by-hop filtering as the dashboard proxy
//   - same bridge-token auth
//   - same CORS echoing for the iframe path
//   - upstream host/port are pluggable (read fresh on each request so a
//     launcher that brings the upstream up/down at runtime is observed)
function createAddonProxyHandler({
  bridgeToken,
  extensionOrigin,
  allowedOrigins,
  upstreamHostname,
  upstreamPort,
  addonId,
  addonLabel,
  notRunningHint = (port) => `${addonLabel} is not running on port ${port}.`,
  // List of path prefixes that are exempt from the bridge-token
  // requirement. Useful when embedding the proxy as an <iframe src>:
  // browsers can't set custom headers on iframe requests, so the SPA
  // would 401 on the first paint without this. Auth is still enforced
  // by the IP allowlist (RESONANTOS_BRIDGE_ALLOWED_IPS) so only LAN/
  // Tailscale clients can hit these paths.
  openPathPrefixes = [],
  // List of { bridge, upstream } mirror-path entries. The proxy
  // matches the request path against each `bridge` prefix and
  // forwards to the upstream with the `upstream` prefix in place of
  // the matched `bridge` prefix. Longest match wins. See
  // createDashboardProxyHandler for the rationale.
  mirrorPaths = [],
}) {
  return function handleAddonProxy(request, response) {
    if (request.method === "OPTIONS") {
      writeJson(response, 204, {}, extensionOrigin, request.headers, allowedOrigins);
      return;
    }
    if (!isAuthorizedBridgeRequest(request, bridgeToken)) {
      // Some paths (e.g. /hermes-dashboard/* served as an iframe src)
      // can't carry the bridge token because browsers don't allow
      // custom headers on iframe requests. For those prefixes, we
      // rely on the IP allowlist alone. Anything not on the open
      // list still requires the token.
      const pathPart = request.url.split("?")[0] ?? "/";
      const isOpenPath = openPathPrefixes.some(
        (openPrefix) => pathPart === openPrefix || pathPart.startsWith(`${openPrefix}/`),
      );
      if (!isOpenPath) {
        writeJson(
          response,
          401,
          { ok: false, error: "Unauthorized browser-first bridge request." },
          extensionOrigin,
          request.headers,
          allowedOrigins,
        );
        return;
      }
    }

    const pathPart = request.url.split("?")[0] ?? "/";
    const matched = matchMirrorPath(pathPart, mirrorPaths);
    if (!matched) {
      writeJson(
        response,
        404,
        { ok: false, error: `${addonLabel} proxy path not under any mirror prefix.` },
        extensionOrigin,
        request.headers,
        allowedOrigins,
      );
      return;
    }
    // The remainder starts with "" (for exact match) or "/" (for
    // prefix match). The upstream prefix is "..." (typically empty or
    // "/api"). Concat them and ensure a leading "/" on the result.
    let upstreamPath = `${matched.entry.upstream}${matched.remainder}`;
    if (!upstreamPath.startsWith("/")) upstreamPath = `/${upstreamPath}`;
    if (upstreamPath === "") upstreamPath = "/";
    const queryIndex = request.url.indexOf("?");
    const upstreamQuery = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    const finalUpstreamPath = `${upstreamPath}${upstreamQuery}`;

    const upstreamPortValue = typeof upstreamPort === "function" ? upstreamPort() : upstreamPort;
    const upstreamHostnameValue = typeof upstreamHostname === "function" ? upstreamHostname() : upstreamHostname;
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
      const lower = String(key).toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      headers[lower] = value;
    }

    const upstreamReq = http.request(
      {
        hostname: upstreamHostnameValue,
        port: upstreamPortValue,
        method: request.method,
        path: finalUpstreamPath,
        headers,
      },
      (upstreamRes) => {
        const responseHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const lower = String(key).toLowerCase();
          if (shouldDropUpstreamResponseHeader(lower)) continue;
          responseHeaders[key] = value;
        }
        const allowOrigin = pickAllowedOrigin(
          request.headers,
          extensionOrigin,
          allowedOrigins,
        );
        if (allowOrigin) {
          responseHeaders["Access-Control-Allow-Origin"] = allowOrigin;
        }
        responseHeaders["Access-Control-Allow-Credentials"] = "true";
        responseHeaders["Vary"] = "Origin";

        // Special-case the iframe SPA's bootstrap auth calls when the
        // upstream Hermes is in loopback (no-auth) mode. The dashboard
        // SPA calls /api/auth/me on first mount to learn "who am I";
        // when running loopback the upstream returns 401 because the
        // gated_auth_middleware is a no-op yet the route still
        // demands request.state.session. Stub it with a fixed local
        // user so the SPA's React tree mounts and subsequent calls
        // (which DO use the inlined X-Hermes-Session-Token header
        // and DO succeed) flow normally.
        const pathLower = finalUpstreamPath.toLowerCase();
        const isAuthMe = pathLower === "/api/auth/me" || pathLower === "/api/auth/me/";
        const isWsTicket = pathLower === "/api/auth/ws-ticket";
        const isAuthBootstrap = isAuthMe || isWsTicket;
        if (
          isAuthBootstrap &&
          (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403)
        ) {
          const stubUser = {
            user_id: "local-loopback",
            email: "local@hermes.dashboard",
            display_name: "Local user",
            org_id: "local",
            provider: "loopback",
            expires_at: null,
          };
          const payload = isWsTicket ? { ticket: "loopback" } : stubUser;
          const out = Buffer.from(JSON.stringify(payload), "utf8");
          for (const k of Object.keys(responseHeaders)) {
            if (["content-length", "content-type"].includes(k.toLowerCase())) {
              delete responseHeaders[k];
            }
          }
          responseHeaders["Content-Type"] = "application/json";
          responseHeaders["Content-Length"] = Buffer.byteLength(out);
          response.writeHead(200, responseHeaders);
          response.end(out);
          return;
        }

        // If the upstream returned the dashboard root HTML, the SPA
        // needs a small bootstrap fix: the upstream ships
        //   window.__HERMES_BASE_PATH__ = ""
        // and uses it to build absolute fetch() paths. We rewrite it
        // to the proxy prefix so the SPA's runtime API calls land on
        // the /hermes-dashboard mirror (which forwards to the
        // upstream). The hardcoded paths in the HTML
        // (<script src="/assets/...">), CSS (url(/assets/...)), and
        // JS bundle literals (e.g. /assets/filler-bg0-X.webp) are
        // served directly by the bridge's /api, /assets,
        // /fonts-terminal, /dashboard-plugins, /favicon.ico mirror
        // entries — no rewriting needed.
        const contentType = String(upstreamRes.headers["content-type"] ?? "").toLowerCase();
        const isHtml = contentType.includes("text/html");
        const isDashboardRoot =
          isHtml &&
          (finalUpstreamPath === "/" || finalUpstreamPath === "");
        if (isDashboardRoot) {
          // Drop the upstream's content-length (case-insensitive) so we
          // don't end up with two Content-Length headers in the final
          // response — HTTP/2 (Caddy) rejects duplicate Content-Length.
          for (const k of Object.keys(responseHeaders)) {
            if (k.toLowerCase() === "content-length") delete responseHeaders[k];
          }
          const chunks = [];
          upstreamRes.on("data", (chunk) => chunks.push(chunk));
          upstreamRes.on("end", () => {
            const full = Buffer.concat(chunks);
            const html = full.toString("utf8");
            // The SPA constructs fetch() paths from
            //   ${__HERMES_BASE_PATH__}/api/...
            // We point the constant at the primary mirror prefix so
            // the constructed paths hit /hermes-dashboard/* and the
            // proxy strips the prefix on the way to upstream. This
            // also makes WebSocket URLs (which use the same constant)
            // go through the same prefix.
            const PREFIX = "/hermes-dashboard";
            const rewritten = html.replace(
              /__HERMES_BASE_PATH__\s*=\s*(['"])([^'"]*)\1/,
              `__HERMES_BASE_PATH__=$1${PREFIX}$1`,
            );
            const out = Buffer.from(rewritten, "utf8");
            responseHeaders["Content-Length"] = Buffer.byteLength(out);
            response.writeHead(upstreamRes.statusCode || 502, responseHeaders);
            response.end(out);
          });
          upstreamRes.on("error", (err) => response.destroy(err));
        } else {
          response.writeHead(upstreamRes.statusCode || 502, responseHeaders);
          upstreamRes.pipe(response);
          upstreamRes.on("error", (err) => {
            response.destroy(err);
          });
        }
      },
    );

    upstreamReq.on("error", (err) => {
      const message =
        err && err.code === "ECONNREFUSED"
          ? notRunningHint(upstreamPortValue)
          : `${addonLabel} proxy upstream error: ${err?.message ?? String(err)}`;
      if (!response.headersSent) {
        writeJson(
          response,
          502,
          { ok: false, error: message, addon: addonId },
          extensionOrigin,
          request.headers,
          allowedOrigins,
        );
      } else {
        response.destroy(err);
      }
    });

    request.pipe(upstreamReq);
    request.on("error", (err) => {
      upstreamReq.destroy(err);
    });
  };
}

// Read the full body of an upstream HTTP response into a Buffer. Used by
// the extension's "inline-in-srcdoc" path: the extension hits the JSON
// route /addon-proxy/<addon-id>?path=<path> on the bridge (which calls
// bufferAddonProxyResponse internally), receives { status, headers, body }
// with body as a base64 string, then inlines the bytes into a sandboxed
// <iframe srcdoc> on its own secure page. This avoids the mixed-content
// problem entirely (the iframe is in a chrome-extension:// origin, the
// srcdoc content is just text), and it works for ANY addon without certs.
// Other consumers (devtools, the bridge self-test, the dashboard-proxy
// streaming path) can still hit the prefix-based proxy directly.
function bufferAddonProxyResponse({
  bridgeToken,
  upstreamHostname,
  upstreamPort,
  prefix,
  addonId,
  addonLabel,
  requestMethod,
  requestPath,
  requestHeaders,
  requestBody,
  notRunningHint,
  readBody,
  clientIpAllowedFn,
  remoteAddress,
  allowedCidrs,
}) {
  // Auth: bridge-token, like the streaming proxy.
  if (!isAuthorizedBridgeRequest({ headers: requestHeaders ?? {} }, bridgeToken)) {
    const err = new Error("Unauthorized browser-first bridge request.");
    err.statusCode = 401;
    return Promise.reject(err);
  }
  // IP allowlist.
  if (clientIpAllowedFn && !clientIpAllowedFn(remoteAddress, allowedCidrs ?? [])) {
    const err = new Error("Client IP not allowlisted for browser-first bridge.");
    err.statusCode = 403;
    return Promise.reject(err);
  }
  const pathPart = (requestPath || "/").split("?")[0] ?? "/";
  let upstreamPath;
  if (pathPart === prefix || pathPart === `${prefix}/`) {
    upstreamPath = "/";
  } else if (pathPart.startsWith(`${prefix}/`)) {
    upstreamPath = pathPart.slice(prefix.length) || "/";
  } else {
    return Promise.reject(new Error(`${addonLabel} proxy path not under expected prefix.`));
  }
  const queryIndex = (requestPath || "/").indexOf("?");
  const upstreamQuery = queryIndex >= 0 ? (requestPath || "/").slice(queryIndex) : "";
  const finalUpstreamPath = `${upstreamPath}${upstreamQuery}`;
  const hostname = typeof upstreamHostname === "function" ? upstreamHostname() : upstreamHostname;
  const port = typeof upstreamPort === "function" ? upstreamPort() : upstreamPort;
  const headers = {};
  if (requestHeaders) {
    for (const [key, value] of Object.entries(requestHeaders)) {
      const lower = String(key).toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      // Don't leak the bridge token to the upstream.
      if (lower === "x-resonantos-bridge-token" || lower === "x-resonantos-bridge-capability-token") continue;
      headers[lower] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const upstreamReq = http.request(
      {
        hostname,
        port,
        method: requestMethod || "GET",
        path: finalUpstreamPath,
        headers,
      },
      (upstreamRes) => {
        const responseHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const lower = String(key).toLowerCase();
          if (shouldDropUpstreamResponseHeader(lower)) continue;
          responseHeaders[key] = value;
        }
        const chunks = [];
        upstreamRes.on("data", (c) => chunks.push(c));
        upstreamRes.on("end", () => {
          resolve({
            status: upstreamRes.statusCode || 502,
            headers: responseHeaders,
            body: Buffer.concat(chunks),
            addon: addonId,
          });
        });
        upstreamRes.on("error", (err) => reject(err));
      },
    );
    upstreamReq.on("error", (err) => {
      if (err && err.code === "ECONNREFUSED") {
        const e = new Error(notRunningHint(port));
        e.code = "ECONNREFUSED";
        e.addon = addonId;
        reject(e);
      } else {
        reject(err);
      }
    });
    if (requestBody && (requestMethod === "POST" || requestMethod === "PUT" || requestMethod === "PATCH")) {
      upstreamReq.end(requestBody);
    } else {
      upstreamReq.end();
    }
  });
}

function routeKey(method, requestUrl) {
  const pathname = new URL(requestUrl ?? "/", "http://127.0.0.1").pathname;
  return `${method ?? "GET"} ${pathname}`;
}

function compileRoutes(routes) {
  return new Map(routes.map((route) => [
    routeKey(route.method, route.path),
    route,
  ]));
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value])
  );
}

export function getBridgeHost() {
  return process.env.RESONANTOS_BRIDGE_HOST ?? "127.0.0.1";
}

export function getBridgePort() {
  const raw = process.env.RESONANTOS_BROWSER_FIRST_BRIDGE_PORT;
  if (raw && Number.isInteger(Number(raw))) return Number(raw);
  return 47773;
}

export function getBridgeHttpsPort() {
  const raw = process.env.RESONANTOS_BRIDGE_HTTPS_PORT;
  if (raw && Number.isInteger(Number(raw))) return Number(raw);
  return 47774;
}

export function getBridgePublicUrl(port) {
  const explicit = process.env.RESONANTOS_BRIDGE_PUBLIC_URL;
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  const host = getBridgeHost();
  // Don't embed a literal IPv6 into a URL without brackets.
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostPart}:${port}`;
}

// HTTPS counterpart of getBridgePublicUrl. Reads RESONANTOS_BRIDGE_PUBLIC_URL
// and forces the scheme to https, port to the HTTPS port. If the user set
// RESONANTOS_BRIDGE_PUBLIC_URL_HTTPS, that's preferred.
export function getBridgeHttpsUrl(port) {
  const explicit = process.env.RESONANTOS_BRIDGE_PUBLIC_URL_HTTPS;
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  const http = getBridgePublicUrl(port);
  // Swap http://...:47773 → https://...:47774. The host portion is shared;
  // the port comes from getBridgeHttpsPort() (default 47774).
  const httpsPort = getBridgeHttpsPort();
  try {
    const u = new URL(http);
    u.protocol = "https:";
    u.port = String(httpsPort);
    return u.toString().replace(/\/$/, "");
  } catch {
    return `https://${getBridgeHost()}:${httpsPort}`;
  }
}

export function getBridgeAllowedOrigins() {
  return parseAllowedList(process.env.RESONANTOS_BRIDGE_ALLOWED_ORIGINS);
}

export function getBridgeAllowedCidrs() {
  return parseAllowedList(process.env.RESONANTOS_BRIDGE_ALLOWED_IPS);
}

function isLoopbackBridgeHost(host) {
  const value = String(host ?? "").trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

export function getBridgeOpenProxyPrefixes({ host = getBridgeHost(), allowedCidrs = getBridgeAllowedCidrs() } = {}) {
  const configured = parseAllowedList(process.env.RESONANTOS_BRIDGE_OPEN_PROXY_PREFIXES);
  if (configured.length > 0) return configured;
  if (isLoopbackBridgeHost(host) || allowedCidrs.length > 0) {
    return DASHBOARD_PROXY_MIRROR_PATHS.map((entry) => entry.bridge);
  }
  return [];
}

export async function writeBridgeConfig({
  extensionRoot,
  bridgePort,
  bridgeToken,
  capabilityBootstrapToken,
  publicUrl,
  httpsPublicUrl,
}) {
  const configPath = path.join(extensionRoot, "src", "bridge-config.generated.js");
  const httpUrl = publicUrl ?? getBridgePublicUrl(bridgePort);
  const httpsUrl = httpsPublicUrl ?? getBridgeHttpsUrl(bridgePort);
  // SECURITY: Raw route capability tokens are never written to generated config.
  // The extension receives a separate bootstrap secret and must request only
  // the capabilities it needs at runtime.
  const config = {
    bridgeUrl: httpUrl,
    // HTTPS counterpart. The extension prefers this when present so the
    // chrome-extension:// (secure) context can embed addon dashboards
    // (Hermes, etc.) without Chrome's mixed-content block. The user
    // installs the bridge's self-signed CA on each client machine once.
    httpsBridgeUrl: httpsUrl,
    bridgeToken,
    capabilityBootstrapToken,
  };
  await writeFile(
    configPath,
    `globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze(${JSON.stringify(config)});\n`,
    { mode: 0o600 },
  );
  return configPath;
}

function isAuthorizedCapabilityRequest(request, bridgeCapabilityTokens, requiredCapability) {
  if (!requiredCapability) {
    return true;
  }
  const expectedToken = bridgeCapabilityTokens?.[requiredCapability];
  return Boolean(expectedToken) && constantTimeEqual(request.headers[bridgeCapabilityHeader], expectedToken);
}

function isAuthorizedCapabilityBootstrapRequest(request, capabilityBootstrapToken) {
  if (!capabilityBootstrapToken) return false;
  return constantTimeEqual(request.headers[bridgeCapabilityBootstrapHeader], capabilityBootstrapToken);
}

export function scopedCapabilityTokenPayload(requestedCapabilities, bridgeCapabilityTokens) {
  const requested = Array.isArray(requestedCapabilities)
    ? requestedCapabilities
    : String(requestedCapabilities ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  const uniqueRequested = [...new Set(requested.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
  if (uniqueRequested.length > 80) {
    throw new Error("Too many capability tokens requested.");
  }
  const capabilityTokens = {};
  for (const capability of uniqueRequested) {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(capability)) {
      throw new Error(`Invalid capability requested: ${capability}`);
    }
    if (!bridgeCapabilityTokens?.[capability]) {
      throw new Error(`Unknown bridge capability requested: ${capability}`);
    }
    capabilityTokens[capability] = bridgeCapabilityTokens[capability];
  }
  return capabilityTokens;
}

export async function evaluateBridgeRequestForSelfTest({
  method = "GET",
  url = "/",
  headers = {},
  body = {},
  bridgeToken,
  bridgeCapabilityTokens = {},
  capabilityBootstrapToken,
  routes = [],
} = {}) {
  try {
    const request = {
      method,
      url,
      headers: normalizeHeaders(headers),
    };
    if (method === "OPTIONS") {
      return { status: 204, payload: {} };
    }
    if (!isAuthorizedBridgeRequest(request, bridgeToken)) {
      return { status: 401, payload: { ok: false, error: "Unauthorized browser-first bridge request." } };
    }
    const route = compileRoutes(routes).get(routeKey(method, url));
    if (!route) {
      return { status: 404, payload: { ok: false, error: "Unknown browser-first bridge route." } };
    }
    if (route.requiredCapabilityBootstrap && !isAuthorizedCapabilityBootstrapRequest(request, capabilityBootstrapToken)) {
      return { status: 403, payload: { ok: false, error: "Bridge route requires capability bootstrap authorization." } };
    }
    if (!isAuthorizedCapabilityRequest(request, bridgeCapabilityTokens, route.requiredCapability)) {
      return { status: 403, payload: { ok: false, error: `Bridge route requires ${route.requiredCapability} capability.` } };
    }
    const payload = method === "POST" ? body : {};
    const result = await route.handler(payload, request);
    return { status: 200, payload: { ok: true, ...result } };
  } catch (error) {
    return { status: 500, payload: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

// Build the bridge's request handler. Used by both the HTTP and HTTPS
// listeners — they share the same routing, IP allowlist, dashboard proxy,
// token auth, and CORS logic.
export function createBridgeRequestHandler({
  bridgeToken,
  bridgeCapabilityTokens = {},
  capabilityBootstrapToken,
  extensionOrigin,
  routes,
  allowedOrigins = getBridgeAllowedOrigins(),
  allowedCidrs = getBridgeAllowedCidrs(),
  dashboardProxyHandler = null,
  openPathPrefixes = getBridgeOpenProxyPrefixes({ allowedCidrs }),
} = {}) {
  // SECURITY: /api/capability-tokens is a built-in internal route. It requires
  // both the bridge token and a separate capability-bootstrap token, and returns
  // only the capability names requested by the extension.
  const internalRoutes = [
    {
      method: "POST",
      path: "/api/capability-tokens",
      requiredCapabilityBootstrap: true,
      handler: async (payload = {}) => ({
        capabilityTokens: scopedCapabilityTokenPayload(payload.capabilities, bridgeCapabilityTokens),
      }),
    },
    ...routes,
  ];
  const reservedInternalPaths = new Set(internalRoutes.map((route) => route.path));
  const proxyHandler =
    dashboardProxyHandler ??
    createDashboardProxyHandler({
      bridgeToken,
      extensionOrigin,
      allowedOrigins,
      // The /hermes-dashboard/* path serves the SPA via <iframe src>;
      // browsers don't allow custom headers on iframe requests, so
      // exempt this prefix from the bridge-token requirement. The IP
      // allowlist (RESONANTOS_BRIDGE_ALLOWED_IPS) is still enforced
      // upstream of this check.
      openPathPrefixes,
    });
  return async function handleBridgeRequest(request, response) {
    try {
      // IP allowlist (in addition to bridge-token auth). Returns 403 early
      // so a probe from a non-allowlisted network never sees a real response.
      if (!clientIpAllowed(request.socket?.remoteAddress, allowedCidrs)) {
        writeJson(
          response,
          403,
          { ok: false, error: "Client IP not allowlisted for browser-first bridge." },
          extensionOrigin,
          request.headers,
          allowedOrigins,
        );
        return;
      }
      // Streaming reverse-proxy for embedded addons (e.g. Hermes dashboard
      // iframe). The proxy handler is responsible for token auth, so we hand
      // off the request before the JSON route evaluator. We dispatch to the
      // proxy for any path that matches one of the dashboard proxy's mirror
      // entries (e.g. /hermes-dashboard/*, /api/*, /assets/*, etc.).
      const proxyPath = (request.url ?? "/").split("?")[0] ?? "/";
      if (proxyHandler && !reservedInternalPaths.has(proxyPath) && dashboardProxyPathMatches(proxyPath)) {
        proxyHandler(request, response);
        return;
      }
      const body = request.method === "POST" ? await readJsonBody(request) : {};
      const result = await evaluateBridgeRequestForSelfTest({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        bridgeToken,
        bridgeCapabilityTokens,
        capabilityBootstrapToken,
        routes: internalRoutes,
      });
      writeJson(response, result.status, result.payload, extensionOrigin, request.headers, allowedOrigins);
    } catch (error) {
      writeJson(
        response,
        500,
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        extensionOrigin,
        request.headers,
        allowedOrigins,
      );
    }
  };
}

export async function startBridgeServer({
  port,
  bridgeToken,
  bridgeCapabilityTokens = {},
  capabilityBootstrapToken,
  extensionOrigin,
  routes,
  host,
  allowedOrigins = getBridgeAllowedOrigins(),
  allowedCidrs = getBridgeAllowedCidrs(),
  dashboardProxyHandler = null,
  openPathPrefixes,
}) {
  const bindHost = host ?? getBridgeHost();
  const effectiveOpenPathPrefixes = openPathPrefixes ?? getBridgeOpenProxyPrefixes({ host: bindHost, allowedCidrs });
  const effectiveProxyHandler =
    dashboardProxyHandler ??
    createDashboardProxyHandler({
      bridgeToken,
      extensionOrigin,
      allowedOrigins,
      openPathPrefixes: effectiveOpenPathPrefixes,
    });
  const handle = createBridgeRequestHandler({
    bridgeToken,
    bridgeCapabilityTokens,
    capabilityBootstrapToken,
    extensionOrigin,
    routes,
    allowedOrigins,
    allowedCidrs,
    dashboardProxyHandler: effectiveProxyHandler,
    openPathPrefixes: effectiveOpenPathPrefixes,
  });
  const server = http.createServer(handle);
  // WebSocket upgrade support. Node's http server emits "upgrade"
  // (not "request") for WebSocket handshakes, so the request
  // handler above is bypassed for those. Register a parallel
  // upgrade handler that performs the same IP allowlist + token
  // check, then forwards the upgrade to the upstream and pipes
  // bytes both directions. Without this, the dashboard iframe's
  // chat / event WebSockets fail to connect (close code 1006).
  const upgradeHandler = createDashboardProxyUpgradeHandler({
    bridgeToken,
    allowedCidrs,
    upstreamHostname: dashboardProxyHostname,
    upstreamPort: dashboardProxyPort,
    openPathPrefixes: effectiveOpenPathPrefixes,
  });
  server.on("upgrade", (req, socket, head) => {
    const pathPart = (req.url ?? "/").split("?")[0] ?? "/";
    if (!dashboardProxyPathMatches(pathPart)) {
      // Non-proxy upgrade (none today, but defensively) — drop
      // the socket cleanly. The dashboard iframe is the only
      // known WebSocket consumer.
      socket.destroy();
      return;
    }
    upgradeHandler(req, socket, head);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindHost);
  });
  return server;
}

// Start both HTTP and HTTPS listeners with the same routing/CORS/auth
// logic. Returns { httpServer, httpsServer, httpPort, httpsPort, tls }.
// If `tls` is null (cert not present / not yet generated), only the HTTP
// server starts. Used by the bridge launchers to expose the HTTPS port
// required for chrome-extension:// (secure) contexts to embed addon
// dashboards without mixed-content blocking.
export async function startBridgeServersWithTls({
  httpPort,
  httpsPort,
  tls = null,
  bridgeToken,
  bridgeCapabilityTokens = {},
  capabilityBootstrapToken,
  extensionOrigin,
  routes,
  host,
  allowedOrigins,
  allowedCidrs,
  dashboardProxyHandler = null,
  openPathPrefixes,
}) {
  const bindHost = host ?? getBridgeHost();
  const effectiveAllowedCidrs = allowedCidrs ?? getBridgeAllowedCidrs();
  const effectiveOpenPathPrefixes = openPathPrefixes ?? getBridgeOpenProxyPrefixes({ host: bindHost, allowedCidrs: effectiveAllowedCidrs });
  const handle = createBridgeRequestHandler({
    bridgeToken,
    bridgeCapabilityTokens,
    capabilityBootstrapToken,
    extensionOrigin,
    routes,
    allowedOrigins,
    allowedCidrs: effectiveAllowedCidrs,
    dashboardProxyHandler,
    openPathPrefixes: effectiveOpenPathPrefixes,
  });
  const httpServer = http.createServer(handle);
  await new Promise((resolve, reject) => {
    const onError = (error) => { httpServer.off("listening", onListening); reject(error); };
    const onListening = () => { httpServer.off("error", onError); resolve(); };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(httpPort, bindHost);
  });
  const httpActualPort = httpServer.address().port;
  let httpsServer = null;
  let httpsActualPort = null;
  if (tls && tls.key && tls.cert) {
    httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, handle);
    await new Promise((resolve, reject) => {
      const onError = (error) => { httpsServer.off("listening", onListening); reject(error); };
      const onListening = () => { httpsServer.off("error", onError); resolve(); };
      httpsServer.once("error", onError);
      httpsServer.once("listening", onListening);
      httpsServer.listen(httpsPort, bindHost);
    });
    httpsActualPort = httpsServer.address().port;
  }
  // WebSocket upgrade support — always register, not just when
  // dashboardProxyHandler is passed. The dashboard proxy is wired
  // into the request handler in createBridgeRequestHandler; the
  // upgrade path is separate (Node's http server emits "upgrade"
  // instead of "request" for WebSocket handshakes) and was
  // previously skipped in this code path, causing the dashboard
  // iframe's chat / event WebSockets to fail (close code 1006).
  const upgradeHandler = createDashboardProxyUpgradeHandler({
    bridgeToken,
    allowedCidrs: effectiveAllowedCidrs,
    upstreamHostname: dashboardProxyHostname,
    upstreamPort: dashboardProxyPort,
    openPathPrefixes: effectiveOpenPathPrefixes,
  });
  const onUpgrade = (req, socket, head) => {
    const pathPart = (req.url ?? "/").split("?")[0] ?? "/";
    if (!dashboardProxyPathMatches(pathPart)) {
      // Non-proxy upgrade (none today, but defensively) — drop the
      // socket cleanly. The dashboard iframe is the only known
      // WebSocket consumer.
      socket.destroy();
      return;
    }
    upgradeHandler(req, socket, head);
  };
  httpServer.on("upgrade", onUpgrade);
  if (httpsServer) httpsServer.on("upgrade", onUpgrade);
  return {
    httpServer,
    httpsServer,
    httpPort: httpActualPort,
    httpsPort: httpsActualPort,
    tls: httpsServer ? tls : null,
  };
}

export function bridgeServerPort(server, fallbackPort = 0) {
  const address = server.address();
  return typeof address === "object" && address ? address.port : fallbackPort;
}

export async function startBridgeServerWithFallback({
  port,
  bridgeToken,
  bridgeCapabilityTokens = {},
  capabilityBootstrapToken,
  extensionOrigin,
  routes,
  host,
  allowedOrigins = getBridgeAllowedOrigins(),
  allowedCidrs = getBridgeAllowedCidrs(),
  tls = null,
  httpsPort,
  fallbackPorts = [0],
  openPathPrefixes,
}) {
  const attempts = [port, ...fallbackPorts].filter((candidate, index, list) =>
    Number.isInteger(Number(candidate)) && list.indexOf(candidate) === index
  );
  let lastError = null;
  for (const candidate of attempts) {
    try {
      const httpsPortAttempts = tls
        ? [httpsPort, ...fallbackPorts].filter((p, i, list) =>
            p !== undefined && Number.isInteger(Number(p)) && list.indexOf(p) === i
          )
        : [];
      const result = await startBridgeServersWithTls({
        httpPort: Number(candidate),
        httpsPort: httpsPortAttempts[0] ?? httpsPort ?? 0,
        tls,
        bridgeToken,
        bridgeCapabilityTokens,
        capabilityBootstrapToken,
        extensionOrigin,
        routes,
        host,
        allowedOrigins,
        allowedCidrs,
        openPathPrefixes,
      });
      return {
        server: result.httpServer,
        httpServer: result.httpServer,
        httpsServer: result.httpsServer,
        httpPort: result.httpPort,
        httpsPort: result.httpsPort,
        tls: result.tls,
        requestedPort: Number(port),
        attemptedPort: Number(candidate),
        actualPort: result.httpPort,
        recovered: Number(candidate) !== Number(port),
      };
    } catch (error) {
      lastError = error;
      if (error?.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("Failed to start browser-first bridge.");
}

export async function runBridgeAuthSelfTest({ port, bridgeToken, extensionOrigin }) {
  const server = await startBridgeServer({
    port,
    bridgeToken,
    extensionOrigin,
    routes: [{ method: "GET", path: "/status", handler: async () => ({ bridge: "self-test" }) }],
  });
  const actualPort = bridgeServerPort(server, port);
  const unauthorized = await fetch(`http://127.0.0.1:${actualPort}/status`);
  const wrongToken = await fetch(`http://127.0.0.1:${actualPort}/status`, {
    headers: { [bridgeTokenHeaderName]: "wrong-token" },
  });
  const authorized = await fetch(`http://127.0.0.1:${actualPort}/status`, {
    headers: { [bridgeTokenHeaderName]: bridgeToken },
  });
  server.close();
  return {
    ok: unauthorized.status === 401 && wrongToken.status === 401 && authorized.ok,
    unauthorizedStatus: unauthorized.status,
    wrongTokenStatus: wrongToken.status,
    authorizedStatus: authorized.status,
  };
}
