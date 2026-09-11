// Intent citation: docs/architecture/ADR-056-provider-fabric-boundary-external-agent-runtimes.md#4-wire-format
// Intent citation: docs/architecture/ADR-055-resonant-extension-framework.md
//
// External Agent Runtime Dispatcher
//
// The bridge-side dispatcher for external-agent-runtime addons
// (ADR-056 §4). Given:
//   - an addon manifest (loaded from `examples/addons/*.json` or
//     `public/addons/*.json`),
//   - a per-caller grant store (shape below; the bridge supplies this,
//     typically from `bridge-grants-store.mjs`),
//   - an audit ledger (shape below; the bridge supplies this,
//     typically from `bridge-audit-ledger.mjs`),
//   - a tool name declared in the manifest,
//   - a payload (model + messages + explicit safe options),
// this module:
//   1. Looks up the addon by id (with a strict id validator).
//   2. Validates the caller holds the per-caller grant for every
//      capability the tool requires (`requiredCapabilities`),
//      honoring grant expiry.
//   3. Resolves the manifest's `service.entrypoint` and asserts the
//      URL points at a loopback address before posting to
//      `${entrypoint}/api/v1/chat/completions` (the DeepSeek
//      OpenAI-compatible interface).
//   4. Records the dispatch + outcome in the audit ledger, with the
//      request body recursively redacted of credentials before it
//      ever leaves this module.
//   5. Returns the result to the bridge caller.
//
// This module is a LIBRARY. It does not register a route itself; the
// bridge consumes it via `addon-delegation-host-service.mjs` (or any
// future route owner). Test file:
//   browser-first/test/external-agent-runtime-dispatcher.test.mjs

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import undici from "undici";

const moduleDir = dirname(fileURLToPath(import.meta.url));
// browser-first/host/external-agent-runtime-dispatcher.mjs -> repo root is
// two levels up (`browser-first/host` -> `browser-first` -> repo root).
// Manifests are looked up first in `examples/addons/` then
// `public/addons/`.
export const DEFAULT_REPO_ROOT = resolvePath(moduleDir, "..", "..");

// Strict addon id pattern: dot-separated lowercase segments, each 1-64
// characters of `[a-z0-9-]`, leading char of each segment is alphanumeric.
// Examples: `addon.deepseek-harness`, `addon.recursive-mas`.
const ADDON_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}(?:\.[a-z0-9][a-z0-9-]{0,63})*$/;

// Hosts the dispatcher will POST to. Only loopback: prevents a malicious
// manifest from turning the dispatcher into an arbitrary SSRF proxy.
// IPv6 appears with brackets when parsed by WHATWG URL (the host portion
// of `http://[::1]:3080` is the literal string "[::1]"); we accept both
// spellings so callers can use either.
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * Build an undici `Agent` whose outbound sockets bind to a loopback
 * address. The dispatcher uses this for every fetch it issues; a caller
 * that supplies a custom `fetchImpl` is responsible for its own bind.
 *
 * The bind itself is defense-in-depth, not the only loopback guarantee:
 * the hostname check (`LOOPBACK_HOSTS`) and the DNS resolution check
 * (`assertHostnameLoopback`) are the primary guards. The bind adds a
 * socket-level anchor on 127.0.0.1 so the kernel cannot pick an
 * external interface for the outbound connection.
 *
 * `fetch` is exposed as a property of the returned object for direct
 * use as `fetchImpl` in `postToCordis`.
 */
let _sharedLoopbackDispatcher = null;

/**
 * Get (or lazily create) a process-wide undici dispatcher bound to
 * 127.0.0.1. The dispatcher is shared across every `postToCordis` call
 * so we don't accumulate connection pools; close it on process exit.
 */
export function getSharedLoopbackDispatcher({ localAddress = "127.0.0.1", family = 4 } = {}) {
  if (_sharedLoopbackDispatcher === null) {
    _sharedLoopbackDispatcher = new undici.Agent({
      connect: { localAddress, family },
      bodyTimeout: 30_000,
      headersTimeout: 30_000,
      pipelining: 1,
    });
  }
  return _sharedLoopbackDispatcher;
}

/**
 * Build an undici `Agent` whose outbound sockets bind to a loopback
 * address. The dispatcher uses this for every fetch it issues; a caller
 * that supplies a custom `fetchImpl` is responsible for its own bind.
 *
 * The bind itself is defense-in-depth, not the only loopback guarantee:
 * the hostname check (`LOOPBACK_HOSTS`) and the DNS resolution check
 * (`assertHostnameLoopback`) are the primary guards. The bind adds a
 * socket-level anchor on 127.0.0.1 so the kernel cannot pick an
 * external interface for the outbound connection.
 *
 * `fetch` is exposed as a property of the returned object for direct
 * use as `fetchImpl` in `postToCordis`.
 */
export function createLoopbackBoundFetch({ localAddress = "127.0.0.1", family = 4 } = {}) {
  return {
    dispatcher: getSharedLoopbackDispatcher({ localAddress, family }),
    fetch: undici.fetch,
    localAddress,
  };
}

// Field names treated as credential-shaped at any depth during audit
// redaction. Match is case-insensitive, substring against the lowercased
// key. Applied at LEAF level only — an object value (e.g. `credentials`
// holding the actual `{ authorization: "..." }`) is walked into so the
// inner value is the thing replaced, not the whole object.
const REDACTED_KEY_SUBSTRINGS = ["api-key", "api_key", "apikey", "token", "secret", "password"];

// The only `options` keys the dispatcher will forward to the upstream.
// Any other key in `options` is dropped silently. This closes the hole
// where a caller could use `options.model` / `options.messages` to
// override the explicit `model` / `messages` arguments.
const SAFE_OPTION_KEYS = new Set(["temperature", "top_p", "max_tokens", "stream", "stop"]);

/**
 * Validate an addon id. Returns the validity verdict; rejection carries
 * a `reason` so the dispatcher can map it to a deny reason without
 * throwing.
 */
export function validateAddonId(addonId) {
  if (typeof addonId !== "string" || addonId.length === 0) {
    return { ok: false, reason: "addon-id-empty" };
  }
  if (addonId.length > 64) {
    return { ok: false, reason: "addon-id-too-long" };
  }
  if (!ADDON_ID_PATTERN.test(addonId)) {
    return { ok: false, reason: "addon-id-malformed" };
  }
  return { ok: true };
}

/**
 * Find an addon manifest by id. Searches `examples/addons/*.json` then
 * `public/addons/*.json`. Returns `{ ok: true, manifest, path }` or
 * `{ ok: false, reason, detail }` so the caller can deny without ever
 * letting a traversal character reach the filesystem.
 */
export async function findAddonManifest(addonId, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const idCheck = validateAddonId(addonId);
  if (!idCheck.ok) {
    return { ok: false, reason: "addon-id-invalid", detail: `addonId ${JSON.stringify(addonId)} rejected: ${idCheck.reason}` };
  }
  const candidates = [
    resolvePath(repoRoot, "examples", "addons"),
    resolvePath(repoRoot, "public", "addons"),
  ];
  for (const dir of candidates) {
    const path = resolvePath(dir, `${addonId}.json`);
    try {
      const raw = await readFile(path, "utf8");
      return { ok: true, manifest: JSON.parse(raw), path };
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
  }
  return { ok: false, reason: "addon-not-found", detail: `addon manifest ${addonId}.json not found` };
}

/**
 * Look up a tool by name on a manifest. Returns the tool descriptor or
 * null. Caller decides what to do with `null`.
 */
export function findTool(manifest, toolName) {
  return (manifest?.tools ?? []).find((t) => t.name === toolName) ?? null;
}

/**
 * Decide whether the caller's per-caller grants cover every capability
 * the tool requires AND every covering grant is still in force (not
 * expired). Pure: returns `{ ok, missing }` where `missing` is the list
 * of uncovered capabilities.
 *
 * `perCallerGrants` is a bridge-supplied accessor with the shape:
 *   { get(callerId): { capabilities: Map<string, true>, expiresAt?: Map<string, number | null> } | undefined }
 * The dispatcher never invents expiry data; if `expiresAt` is absent,
 * every covering grant is treated as non-expiring (the bridge is the
 * source of truth for grant TTL).
 */
export function checkToolGrants({ tool, perCallerGrants, callerId, now = () => Date.now(), approval } = {}) {
  const required = tool?.requiredCapabilities ?? [];
  // Fail closed when the tool does not declare its required capabilities.
  // The original `if (required.length === 0) return ok:true` short-circuit
  // let any caller dispatch a tool that has no policy authority attached.
  // The bridge is the source of truth for capability grants; a manifest
  // that omits `requiredCapabilities` cannot be safely invoked.
  if (!Array.isArray(required) || required.length === 0) {
    return { ok: false, missing: [], reason: "capability-undetermined" };
  }
  // Enforce human-approval gate when the tool declares
  // `requiresHumanApproval: true`. The caller must present a non-empty
  // `approval` token supplied by the host's approval surface.
  if (tool.requiresHumanApproval === true) {
    if (typeof approval !== "string" || approval.length === 0) {
      return { ok: false, missing: [], reason: "approval-required" };
    }
  }
  const missing = [];
  const bucket = perCallerGrants?.get ? perCallerGrants.get(callerId) : undefined;
  const caps = bucket?.capabilities;
  const expiresAt = bucket?.expiresAt;
  for (const capability of required) {
    let granted = false;
    if (caps && typeof caps.get === "function") {
      granted = Boolean(caps.get(capability));
      if (granted && expiresAt && typeof expiresAt.get === "function") {
        const expiry = expiresAt.get(capability);
        if (typeof expiry === "number" && expiry <= now()) {
          granted = false;
        }
      }
    }
    if (!granted) missing.push(capability);
  }
  if (missing.length > 0) return { ok: false, missing, reason: "capability-denied" };
  return { ok: true, missing: [] };
}

/**
 * Wire-protocol: convert a delegation request payload into a Cordis
 * /api/v1/chat/completions POST body. Cordis exposes the DeepSeek
 * OpenAI-compatible interface at `${entrypoint}/api/v1/chat/completions`.
 *
 * Only explicit fields are forwarded: `model`, `messages`, and a safe
 * allowlist of `options`. The caller CANNOT override `model` or
 * `messages` via the `options` argument — those keys are stripped from
 * `options` before it is merged, so a caller passing `{ options: { model:
 * "evil" } }` is ignored.
 */
export function buildChatCompletionsRequest({ model, messages, options } = {}) {
  const safeOptions = {};
  if (options && typeof options === "object" && !Array.isArray(options)) {
    for (const key of SAFE_OPTION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        safeOptions[key] = options[key];
      }
    }
  }
  return {
    model: typeof model === "string" && model.length > 0 ? model : "deepseek-chat",
    messages: Array.isArray(messages) ? messages : [],
    ...safeOptions,
  };
}

/**
 * Assert that an entrypoint URL is loopback-only. The dispatcher will
 * never POST to a non-loopback host — that closes the SSRF path where
 * a malicious manifest could point `service.entrypoint` at an external
 * host and have the bridge do the egress on its behalf.
 *
 * Returns `{ ok: true, url }` or `{ ok: false, reason, detail }`.
 */
/**
 * Test whether an IP literal is in a loopback range. IPv4: 127.0.0.0/8
 * (RFC 1123). IPv6: ::1/128 (RFC 4291). Anything else (private RFC 1918,
 * link-local, public) is rejected.
 */
export function isLoopbackAddress(ip) {
  if (typeof ip !== "string") return false;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("127.")) {
    // 127.0.0.0/8 — any 127.x.y.z is loopback.
    const octets = ip.split(".");
    if (octets.length !== 4) return false;
    return octets.every((o) => /^(0|[0-9]{1,3})$/.test(o) && Number(o) >= 0 && Number(o) <= 255);
  }
  return false;
}

/**
 * Resolve a hostname to its addresses. If every returned address is a
 * loopback literal, the name is safe to use. Otherwise the host is
 * treated as non-loopback.
 */
async function assertHostnameLoopback(hostname) {
  // IP literals (no DNS needed): IPv4 and bracketed/bracketless IPv6.
  const bracketed = hostname.startsWith("[") && hostname.endsWith("]");
  const candidate = bracketed ? hostname.slice(1, -1) : hostname;
  if (isLoopbackAddress(candidate)) return { ok: true };
  // Anything that LOOKS like an IP literal but isn't loopback is rejected
  // without a DNS lookup. Avoids the resolver's tendency to be permissive
  // about malformed inputs.
  const looksLikeIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(candidate);
  const looksLikeIpv6 = candidate.includes(":");
  if (looksLikeIpv4 || looksLikeIpv6) {
    return { ok: false, reason: "entrypoint-not-allowed", detail: `host ${hostname} is not a loopback address` };
  }
  // Hostname: resolve and verify every returned address is loopback.
  let addresses;
  try {
    const result = await dnsLookup(hostname, { all: true });
    addresses = result.map((r) => r.address);
  } catch (err) {
    return { ok: false, reason: "entrypoint-not-allowed", detail: `DNS lookup of ${hostname} failed: ${String(err && err.message || err)}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "entrypoint-not-allowed", detail: `DNS lookup of ${hostname} returned no addresses` };
  }
  for (const addr of addresses) {
    if (!isLoopbackAddress(addr)) {
      return { ok: false, reason: "entrypoint-not-allowed", detail: `host ${hostname} resolves to ${addr}, which is not a loopback address` };
    }
  }
  return { ok: true };
}

/**
 * Assert that an entrypoint URL is loopback-only. The dispatcher will
 * never POST to a non-loopback host — that closes the SSRF path where
 * a malicious manifest could point `service.entrypoint` at an external
 * host and have the bridge do the egress on its behalf.
 *
 * Returns `{ ok: true, url }` synchronously, OR `{ ok: false, reason,
 * detail }` for static failures. To also enforce loopback DNS for
 * non-IP hostnames (`localhost`, custom names), call the async
 * `assertLoopbackEntrypointResolved` below.
 */
export function assertLoopbackEntrypoint(entrypoint) {
  if (typeof entrypoint !== "string" || entrypoint.length === 0) {
    return { ok: false, reason: "entrypoint-invalid", detail: "service.entrypoint is not a non-empty string" };
  }
  let url;
  try {
    url = new URL(entrypoint);
  } catch {
    return { ok: false, reason: "entrypoint-invalid", detail: `service.entrypoint is not a valid URL: ${entrypoint}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "entrypoint-not-allowed", detail: `protocol ${url.protocol} is not allowed (http/https only)` };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: "entrypoint-not-allowed", detail: `host ${url.hostname} is not loopback; only 127.0.0.1, ::1, [::1], localhost are allowed` };
  }
  if (url.port === "0") {
    return { ok: false, reason: "entrypoint-not-allowed", detail: "port 0 is not allowed (would resolve to a kernel-chosen port)" };
  }
  // Reject userinfo (`http://u:p@host`) — the raw entrypoint could otherwise
  // smuggle credentials into the URL handed to fetch, and the audit ledger
  // would record them in the `entrypoint` field.
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "entrypoint-not-allowed", detail: "userinfo (user:password@host) is not allowed in service.entrypoint" };
  }
  // Reject query and fragment: the dispatcher appends `/api/v1/chat/completions`
  // to the URL, and an entrypoint like `http://host?x=y` would otherwise put
  // the path in the query string.
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "entrypoint-not-allowed", detail: "query string and fragment are not allowed in service.entrypoint (dispatcher appends a fixed path)" };
  }
  return { ok: true, url };
}

/**
 * Async loopback assertion. Same as `assertLoopbackEntrypoint` plus a
 * DNS-resolution check: if the hostname is a name (not an IP literal),
 * every resolved address MUST be in 127.0.0.0/8 or ::1/128. This closes
 * the gap where `/etc/hosts` or a malicious DNS resolver could redirect
 * `localhost` to an external IP.
 *
 * `expectedPort`: when provided, the URL's port MUST equal this value
 * (the manifest-declared port). Any other port — even a loopback one —
 * is rejected: the bridge, the OpenCode server, the Hermes dashboard
 * and any other local service must not be reachable through a
 * different addon's entrypoint.
 */
export async function assertLoopbackEntrypointResolved(entrypoint, { expectedPort } = {}) {
  const staticCheck = assertLoopbackEntrypoint(entrypoint);
  if (!staticCheck.ok) return staticCheck;
  const { url } = staticCheck;
  // Strip IPv6 brackets if present (hostname has them for the URL; we
  // want the bare literal for the IP classifier).
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const dnsCheck = await assertHostnameLoopback(hostname);
  if (!dnsCheck.ok) return dnsCheck;
  if (expectedPort !== undefined && expectedPort !== null) {
    if (url.port !== String(expectedPort)) {
      return {
        ok: false,
        reason: "port-mismatch",
        detail: `entrypoint port ${url.port || "(default)"} does not match the manifest-declared port ${expectedPort}`,
      };
    }
  }
  return { ok: true, url };
}

/**
 * Recursive redact of credential-shaped values from an object. Walks
 * plain objects and arrays, returning a deep clone with every matching
 * LEAF value replaced by the literal `[REDACTED]`. A credential-shaped
 * key whose value is itself an object is recursed into, so a structure
 * like `{ credentials: { authorization: "..." } }` redacts the inner
 * authorization rather than collapsing the whole credentials object.
 */
export function redactRequestForLog(value, depth = 0) {
  if (depth > 8) return "[REDACTED:depth-limit]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactRequestForLog(v, depth + 1));
  }
  if (typeof value === "object") {
    // Walk into plain objects AND null-prototype objects (e.g.
    // `Object.create(null)`). The previous check returned any non-Object-
    // prototype value untouched, which left null-prototype credential
    // carriers unredacted.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = proto === null ? Object.create(null) : {};
    for (const key of Object.keys(value)) {
      const lower = key.toLowerCase();
      const child = value[key];
      const isAuth = lower === "authorization";
      const childIsLeaf = child === null || typeof child !== "object";
      const isCredentialLeaf = childIsLeaf && REDACTED_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
      if (isAuth || isCredentialLeaf) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactRequestForLog(child, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Effectful: POST to the Cordis endpoint. Returns `{ ok, status, body,
 * error }` where `body` is the parsed JSON response (or null on
 * network error) and `error` is set only on transport failure.
 *
 * The loopback assertion runs first; a non-loopback entrypoint is
 * short-circuited to `{ ok: false, status: 0, body: null, reason:
 * "entrypoint-not-allowed" }` without any network call.
 *
 * `fetch` is used directly (Node 18+). Caller passes an `AbortSignal`
 * if they want timeout.
 */
/**
 * Drain an SSE response body. Parses each `event:` / `data:` block as a
 * single SSE event. The stream is fully consumed on every path; if the
 * caller stops reading, the underlying reader is cancelled so the
 * socket is released and the upstream connection is closed.
 *
 * `textDecoder` is exposed for tests; production callers leave it unset.
 */
export async function consumeSseStream(response, { maxBytes = 8 * 1024 * 1024, textDecoder = new TextDecoder("utf-8") } = {}) {
  if (!response || !response.body) {
    return { events: [], raw: "", truncated: false, closed: true };
  }
  const reader = response.body.getReader();
  const events = [];
  let raw = "";
  let buffer = "";
  let truncated = false;
  let currentEvent = null;
  let currentData = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = textDecoder.decode(value, { stream: true });
      raw += chunk;
      if (raw.length > maxBytes) {
        truncated = true;
        break;
      }
      buffer += chunk;
      // SSE messages are separated by a blank line (`\n\n`). Split on
      // either \r\n\r\n or \n\n; the buffer is split line-by-line
      // and re-buffered when a message isn't complete yet.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        // A single block can contain multiple lines (event:, data:, id:, retry:).
        let eventName;
        const dataLines = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          // ignore other fields (id:, retry:, comments starting with `:`)
        }
        if (eventName !== undefined || dataLines.length > 0) {
          events.push({ event: eventName, data: dataLines.join("\n"), raw: block });
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Always cancel the reader so the upstream socket is closed. Even on
    // a normal end-of-stream we issue cancel() to release the connection
    // back to the pool — fetch() does not release a streaming body until
    // the reader is explicitly closed or the response is fully drained.
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return { events, raw, truncated, closed: true };
}

export async function postToCordis({
  entrypoint,
  request,
  signal,
  fetchImpl,
  declaredPort,
  consumeSse = consumeSseStream,
  loopbackBind = true,
}) {
  // Static + DNS loopback assertion. The static check rejects malformed
  // URLs, non-loopback hosts, port 0, userinfo, query and fragment. The
  // DNS check rejects name-based hosts that resolve to a non-loopback
  // address. `declaredPort` is the manifest-declared port; when supplied
  // the entrypoint's port must match it exactly.
  const loopback = await assertLoopbackEntrypointResolved(entrypoint, { expectedPort: declaredPort });
  if (!loopback.ok) {
    return { ok: false, status: 0, body: null, reason: loopback.reason, detail: loopback.detail };
  }
  // Build the URL from `origin` (scheme + host + port). The previous
  // implementation appended the path to `href`, which put the path into
  // the query string for entrypoints like `http://host?x=y`.
  const url = `${loopback.url.origin}/api/v1/chat/completions`;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: request?.stream === true ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(request),
    // A loopback service answering 3xx must not be allowed to redirect
    // the POST to another host. The dispatcher's contract is loopback-only;
    // a redirect is by definition an attempt to leave that boundary.
    redirect: "error",
  };
  if (signal) init.signal = signal;
  // Build the outbound fetch. When `loopbackBind` is true (default), the
  // dispatcher uses an undici Agent whose sockets bind to 127.0.0.1 —
  // the loopback interface — so the kernel cannot pick an external
  // interface for the outbound connection. A caller can opt out by
  // passing `loopbackBind: false`, or supply a custom `fetchImpl` (in
  // which case the caller is responsible for its own bind).
  let activeFetch = fetchImpl;
  let dispatcherToClose = null;
  if (activeFetch === undefined) {
    if (loopbackBind) {
      // Reuse a module-level dispatcher so we don't spawn a new
      // undici Agent (and its keep-alive connection pool) on every
      // call. The dispatcher is closed when the process exits; for
      // tests, callers can pass `loopbackBind: false` or supply a
      // custom `fetchImpl` to avoid sharing state.
      dispatcherToClose = getSharedLoopbackDispatcher();
      activeFetch = (u, i) => undici.fetch(u, { ...i, dispatcher: dispatcherToClose });
    } else {
      activeFetch = globalThis.fetch;
    }
  }
  let response;
  try {
    response = await activeFetch(url, init);
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error) };
  }
  const isSse = request?.stream === true
    || (typeof response.headers?.get === "function"
        && (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream"));
  if (isSse) {
    // Drain the SSE stream fully. `consumeSseStream` cancels the reader
    // in a `finally` block so the socket is closed on every path — normal
    // end, truncation, or upstream error. We never call `response.json()`
    // on a streaming response: doing so would return `{ outcome: "allow",
    // response: null }` (the body is not JSON-serialised while streaming)
    // and leave the socket open.
    try {
      const sse = await consumeSse(response);
      return {
        ok: response.ok,
        status: response.status,
        body: null,
        stream: true,
        events: sse.events,
        sseRaw: sse.raw,
        sseTruncated: sse.truncated,
        sseClosed: sse.closed,
      };
    } catch (error) {
      // Even on parse failure, the stream was drained (see consumeSseStream's
      // finally block). Return a deny-shaped result so the bridge can record
      // the upstream as errored.
      return { ok: false, status: response.status, body: null, stream: true, events: [], sseClosed: true, error: String(error) };
    }
  }
  // Non-streaming: JSON response, body read once.
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * The single callable entry point for the bridge. Returns one of:
 *   - `{ outcome: "allow", response: <upstream body> }`
 *   - `{ outcome: "deny", reason: <deny code>, detail: <string> }`
 *
 * Caller MUST pass `auditLedger.record(...)`. If omitted, audit is
 * silently skipped — but in production callers always wire it.
 *
 * `repoRoot` (optional) overrides the manifest search root. Useful for
 * tests; production callers leave it unset.
 */
export async function dispatchExternalAgentRuntime({
  addonId,
  toolName,
  payload,
  callerId,
  perCallerGrants,
  auditLedger,
  fetchImpl,
  repoRoot,
  approval,
}) {
  const lookup = await findAddonManifest(addonId, { repoRoot });
  if (!lookup.ok) {
    return { outcome: "deny", reason: lookup.reason, detail: lookup.detail };
  }
  const manifest = lookup.manifest;
  const tool = findTool(manifest, toolName);
  if (!tool) {
    return {
      outcome: "deny",
      reason: "unknown-tool",
      detail: `tool ${toolName} not declared in addon ${addonId}`,
    };
  }
  const grant = checkToolGrants({ tool, perCallerGrants, callerId, approval });
  if (!grant.ok) {
    const detail = grant.reason === "approval-required"
      ? `tool ${toolName} requires human approval; no approval token supplied`
      : grant.reason === "capability-undetermined"
        ? `tool ${toolName} declares no requiredCapabilities; cannot be dispatched without explicit policy`
        : `caller ${callerId} missing per-caller grants for: ${grant.missing.join(", ")}`;
    return {
      outcome: "deny",
      reason: grant.reason ?? "capability-denied",
      detail,
    };
  }
  const entrypoint = manifest.service?.entrypoint;
  // Extract the manifest-declared port so the dispatcher can refuse any
  // entrypoint that targets a different loopback port. The bridge, the
  // OpenCode server, the Hermes dashboard and any other local service
  // must not be reachable through a different addon's entrypoint.
  let declaredPort;
  if (typeof entrypoint === "string" && entrypoint.length > 0) {
    try {
      const tmp = new URL(entrypoint);
      declaredPort = tmp.port || (tmp.protocol === "https:" ? "443" : "80");
    } catch { /* invalid entrypoint — postToCordis will reject it */ }
  }
  const request = buildChatCompletionsRequest(payload ?? {});
  const response = await postToCordis({ entrypoint, request, fetchImpl, declaredPort });
  // Surface entrypoint-level deny reasons (loopback assertion, port
  // mismatch, DNS check) WITHOUT writing to the audit ledger: the
  // dispatcher never made an upstream call, so there is nothing to
  // audit. The caller still receives a structured deny with the
  // specific reason (entrypoint-invalid, entrypoint-not-allowed,
  // port-mismatch).
  if (response.reason && response.status === 0) {
    return { outcome: "deny", reason: response.reason, detail: response.detail };
  }
  const redactedRequest = redactRequestForLog(request);
  if (auditLedger?.record) {
    auditLedger.record({
      callerId,
      addonId,
      tool: toolName,
      entrypoint,
      request: redactedRequest,
      upstreamStatus: response.status,
      upstreamOk: response.ok,
      denyReason: response.ok ? null : response.status === 0 ? "upstream-unreachable" : "upstream-error",
    });
  }
  if (!response.ok) {
    return {
      outcome: "deny",
      reason: response.status === 0 ? "upstream-unreachable" : "upstream-error",
      detail: response.error ?? `upstream status ${response.status}`,
      upstreamStatus: response.status,
      upstreamBody: response.body,
    };
  }
  return { outcome: "allow", response: response.body };
}
