// ResonantOS bridge client.
//
// Resolves the bridge configuration in this order:
//   1. A user-set override in chrome.storage.local (key: "bridgeTargetOverride"),
//      set via the Bridge Target settings section so the same extension can
//      point at a different bridge host on every machine.
//   2. The generated config written by the bridge at startup
//      (globalThis.__RESONANTOS_BRIDGE_CONFIG__), which points at the bridge
//      the extension was installed alongside.
//   3. A last-resort loopback default of http://127.0.0.1:47773 so the
//      extension at least mounts on a clean install with no generated config.
//
// createBridgeClient(config) builds a request function. The config can be
// passed in directly (e.g. from a test) or omitted to use the
// generated/default. Most callers should use `await resolveBridgeConfig()`
// and pass the result, so the chrome.storage override is honored.

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:47773";
const STORAGE_OVERRIDE_KEY = "bridgeTargetOverride";
const GENERATED_CONFIG_PATH = "src/bridge-config.generated.js";
const GENERATED_CONFIG_PREFIX = "globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze(";
const GENERATED_CONFIG_SUFFIX = ");";
const UNAUTHORIZED_BRIDGE_ERROR = "Unauthorized browser-first bridge request.";
const BRIDGE_ROUTE_CAPABILITIES = Object.freeze({
  "POST /providers/health": "provider-diagnostics-read",
  "POST /providers/connectivity-test": "provider-diagnostics-read",
  "GET /providers/diagnostics-history": "provider-diagnostics-read",
  "GET /providers/routing-strategies": "provider-diagnostics-read",
  "POST /providers/credentials": "provider-credential-write",
  "POST /providers/accounts": "provider-credential-write",
  "POST /providers/accounts/remove": "provider-credential-write",
  "POST /providers/routing-strategies": "provider-routing-write",
  "POST /providers/model-preferences": "provider-routing-write",
  "POST /augmentor/chat": "provider-model-invoke",
  "POST /augmentor/inline": "provider-model-invoke",
  "POST /augmentor/control-plan": "agent-control-plan",
  "POST /augmentor/next-action": "agent-control-plan",
  "POST /web/news": "agent-control-plan",
  "POST /memory/settings": "memory-settings-write",
  "POST /memory/source/browse": "memory-source-browse",
  "POST /memory/source/scan": "memory-source-scan",
  "POST /memory/source/action": "memory-source-manage",
  "POST /memory/source/move-preflight": "memory-source-move",
  "POST /memory/source/move-execute": "memory-source-move",
  "POST /memory/source/move-rollback": "memory-source-move",
  "POST /memory/source/review": "memory-source-review",
  "POST /memory/source/intake": "memory-source-intake",
  "POST /memory/source/file-intake": "memory-source-file-intake",
  "POST /memory/source/sync": "memory-source-file-intake",
  "POST /memory/search": "archive-read",
  "POST /memory/wiki/page/read": "archive-read",
  "POST /memory/wiki/lint": "memory-source-review",
  "POST /memory/source/versions": "memory-source-review",
  "POST /memory/source/versions/repair": "memory-source-manage",
  "POST /memory/source/diff": "memory-source-review",
  "POST /archive/intake": "archive-write",
  "POST /archive/intake/list": "archive-read",
  "POST /archive/intake/read": "archive-read",
  "POST /archive/review/request": "archive-write",
  "POST /archive/review/list": "archive-read",
  "POST /archive/review/transition": "archive-write",
  "POST /archive/review/draft": "archive-write",
  "POST /archive/review/artifact/read": "archive-read",
  "POST /archive/review/artifact/verify": "archive-write",
  "POST /archive/review/verification/read": "archive-read",
  "POST /archive/review/artifact/revise": "archive-write",
  "POST /archive/review/artifact/promote": "archive-write",
  "POST /archive/review/promotions/list": "archive-read",
  "POST /archive/review/promotions/restore": "archive-write",
  "POST /browser/downloads/action": "browser-download-action",
  "POST /diagnostics/report": "diagnostics-report-export",
  "POST /addons/execution-settings": "addon-execution-settings-write",
  "POST /hermes/dashboard/status": "addon-runtime-read",
  "POST /hermes/dashboard/start": "addon-runtime-control",
  "POST /hermes/dashboard/stop": "addon-runtime-control",
  "POST /hermes/status": "addon-runtime-read",
  "POST /hermes/delegation/start": "addon-runtime-control",
  "POST /hermes/delegation/status": "addon-runtime-read",
  "POST /hermes/delegation/artifact": "addon-runtime-read",
  "POST /hermes/delegation/cancel": "addon-runtime-control",
  "POST /opencode/delegation/start": "addon-runtime-control",
  "POST /opencode/delegation/status": "addon-runtime-read",
  "POST /opencode/delegation/artifact": "addon-runtime-read",
  "POST /opencode/delegation/cancel": "addon-runtime-control",
  "POST /addons/draft": "addon-record-write",
  "POST /addons/draft/list": "addon-record-read",
  "POST /addons/draft/read": "addon-record-read",
  "POST /addons/draft/transition": "addon-record-write",
  "POST /addons/draft/handoff": "addon-record-write",
  "POST /addons/delegate": "addon-record-write",
  "POST /addons/delegate/list": "addon-record-read",
  "POST /goals": "addon-record-write",
  "POST /settings/extension-prefs": "extension-prefs-write",
});
export const RUNTIME_CAPABILITY_ALLOWLIST = Object.freeze([...new Set(Object.values(BRIDGE_ROUTE_CAPABILITIES))]);

function routeCapabilityKey(method, route) {
  const pathname = new URL(route ?? "/", DEFAULT_BRIDGE_URL).pathname;
  return `${String(method ?? "GET").toUpperCase()} ${pathname}`;
}

export function capabilityForBridgeRoute(route, method = "GET") {
  return BRIDGE_ROUTE_CAPABILITIES[routeCapabilityKey(method, route)] ?? "";
}

function normalizeBridgeTarget(value) {
  if (!value || typeof value !== "object") return null;
  const url = typeof value.bridgeUrl === "string" ? value.bridgeUrl.trim() : "";
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  const token = typeof value.bridgeToken === "string" && value.bridgeToken.trim()
    ? value.bridgeToken.trim()
    : null;
  const capabilityTokens = value.bridgeCapabilityTokens && typeof value.bridgeCapabilityTokens === "object"
    ? value.bridgeCapabilityTokens
    : null;
  const capabilityBootstrapToken = typeof value.capabilityBootstrapToken === "string" && value.capabilityBootstrapToken.trim()
    ? value.capabilityBootstrapToken.trim()
    : null;
  return { url, token, capabilityTokens, capabilityBootstrapToken };
}

async function readOverrideFromStorage() {
  try {
    if (typeof chrome === "undefined" || !chrome?.storage?.local?.get) return null;
    const result = await chrome.storage.local.get([STORAGE_OVERRIDE_KEY]);
    return normalizeBridgeTarget(result?.[STORAGE_OVERRIDE_KEY]);
  } catch {
    return null;
  }
}

function normalizeGeneratedConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const url = typeof cfg.bridgeUrl === "string" && cfg.bridgeUrl.trim()
    ? cfg.bridgeUrl.trim()
    : null;
  if (!url) return null;
  return {
    url,
    token: typeof cfg.bridgeToken === "string" ? cfg.bridgeToken : null,
    capabilityBootstrapToken: typeof cfg.capabilityBootstrapToken === "string" ? cfg.capabilityBootstrapToken : null,
    capabilityTokens: cfg.bridgeCapabilityTokens && typeof cfg.bridgeCapabilityTokens === "object"
      ? cfg.bridgeCapabilityTokens
      : null,
  };
}

function generatedConfig() {
  return normalizeGeneratedConfig(globalThis.__RESONANTOS_BRIDGE_CONFIG__);
}

function generatedConfigUrl() {
  if (typeof chrome !== "undefined" && chrome?.runtime?.getURL) {
    return chrome.runtime.getURL(GENERATED_CONFIG_PATH);
  }
  try {
    return new URL("../bridge-config.generated.js", import.meta.url).href;
  } catch {
    return "";
  }
}

function parseGeneratedConfigScript(source) {
  const text = String(source ?? "").trim();
  if (!text.startsWith(GENERATED_CONFIG_PREFIX) || !text.endsWith(GENERATED_CONFIG_SUFFIX)) return null;
  const json = text.slice(GENERATED_CONFIG_PREFIX.length, -GENERATED_CONFIG_SUFFIX.length);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function refreshGeneratedBridgeConfig({ fetchImpl, resourceUrl, now } = {}) {
  const fetchFn = fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
  const url = resourceUrl ?? generatedConfigUrl();
  if (!fetchFn || !url) return null;
  const reloadUrl = new URL(url);
  reloadUrl.searchParams.set("resonantosConfigReload", String(now ?? Date.now()));
  const response = await fetchFn(reloadUrl.toString(), { cache: "no-store" });
  if (!response?.ok) return null;
  const parsed = parseGeneratedConfigScript(await response.text());
  const normalized = normalizeGeneratedConfig(parsed);
  if (!normalized) return null;
  globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze(parsed);
  return normalized;
}

function toResolvedBridgeConfig(config, source) {
  return {
    bridgeUrl: config.url,
    bridgeToken: config.token ?? "",
    capabilityBootstrapToken: config.capabilityBootstrapToken ?? "",
    bridgeCapabilityTokens: config.capabilityTokens ?? {},
    source,
  };
}

export async function resolveBridgeConfig(options = {}) {
  const override = await readOverrideFromStorage();
  const generated = options.refreshGenerated
    ? (await refreshGeneratedBridgeConfig(options).catch(() => null)) ?? generatedConfig()
    : generatedConfig();
  if (override) {
    return toResolvedBridgeConfig({
      ...override,
      token: override.token ?? generated?.token ?? null,
      capabilityBootstrapToken: override.capabilityBootstrapToken ?? generated?.capabilityBootstrapToken ?? null,
      capabilityTokens: override.capabilityTokens ?? generated?.capabilityTokens ?? null,
    }, "override");
  }
  if (generated) {
    return toResolvedBridgeConfig(generated, options.refreshGenerated ? "generated:refreshed" : "generated");
  }
  return {
    bridgeUrl: DEFAULT_BRIDGE_URL,
    bridgeToken: "",
    capabilityBootstrapToken: "",
    bridgeCapabilityTokens: {},
    source: "default",
  };
}

export const BRIDGE_STORAGE_OVERRIDE_KEY = STORAGE_OVERRIDE_KEY;

function bridgeNetworkError(target, error) {
  const reason = error instanceof Error && error.message
    ? error.message
    : String(error || "network request failed");
  return new Error(
    `Bridge is unreachable for ${target}: ${reason}. ` +
      "Start the ResonantOS browser-first bridge or update Settings > Bridge Target."
  );
}

function isAbortError(error) {
  return error && typeof error === "object" && error.name === "AbortError";
}

function bridgeResponseError(payload, status) {
  const error = new Error(payload?.error ?? `Bridge request failed with HTTP ${status}.`);
  error.bridgeStatus = status;
  error.bridgePayload = payload;
  return error;
}

export function isUnauthorizedBridgeError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.bridgeStatus === 401) return true;
  return typeof error.message === "string" && error.message.includes(UNAUTHORIZED_BRIDGE_ERROR);
}

export function createBridgeClient(config = globalThis.__RESONANTOS_BRIDGE_CONFIG__ ?? {}) {
  const bridgeUrl = config.bridgeUrl ?? DEFAULT_BRIDGE_URL;
  const bridgeToken = config.bridgeToken ?? "";
  const bridgeCapabilityTokens = config.bridgeCapabilityTokens ?? {};
  const fetchImpl = config.fetchImpl ?? fetch;

  return async function bridgeRequest(route, options = {}) {
    const method = options.method ?? "GET";
    const headers = options.body ? { "Content-Type": "application/json" } : {};
    if (bridgeToken) {
      headers["X-ResonantOS-Bridge-Token"] = bridgeToken;
    }
    const capability = options.capability || capabilityForBridgeRoute(route, method);
    const effectiveCapabilityTokens = { ..._capabilityTokens, ...bridgeCapabilityTokens };
    if (capability && effectiveCapabilityTokens[capability]) {
      headers["X-ResonantOS-Bridge-Capability-Token"] = effectiveCapabilityTokens[capability];
    }
    let response;
    try {
      response = await fetchImpl(`${bridgeUrl}${route}`, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw bridgeNetworkError(route, error);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw bridgeResponseError(payload, response.status);
    }
    return payload;
  };
}

// Raw byte/HTML fetch. The bridge's addon proxy endpoints (e.g.
// /hermes-dashboard/*) return non-JSON (the upstream's actual content
// type) — the extension needs the raw response to inline it into an
// <iframe srcdoc>. Same auth as bridgeRequest. Use this for any route
// the bridge forwards to a non-JSON upstream.
export function createRawBridgeFetch(config = globalThis.__RESONANTOS_BRIDGE_CONFIG__ ?? {}) {
  const bridgeUrl = config.bridgeUrl ?? DEFAULT_BRIDGE_URL;
  const bridgeToken = config.bridgeToken ?? "";
  const bridgeCapabilityTokens = config.bridgeCapabilityTokens ?? {};
  const fetchImpl = config.fetchImpl ?? fetch;

  return async function rawFetch(path, options = {}) {
    const method = options.method ?? "GET";
    const headers = { ...(options.headers ?? {}) };
    if (bridgeToken) {
      headers["X-ResonantOS-Bridge-Token"] = bridgeToken;
    }
    const capability = options.capability || capabilityForBridgeRoute(path, method);
    const effectiveCapabilityTokens = { ..._capabilityTokens, ...bridgeCapabilityTokens };
    if (capability && effectiveCapabilityTokens[capability]) {
      headers["X-ResonantOS-Bridge-Capability-Token"] = effectiveCapabilityTokens[capability];
    }
    try {
      return await fetchImpl(`${bridgeUrl}${path}`, {
        method,
        headers,
        body: options.body,
        signal: options.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw bridgeNetworkError(path, error);
    }
  };
}

// Loopback detection.
//
// The extension ships with the bridge's LAN address baked into the
// generated config (e.g. "http://192.168.1.100:47773"). On the Pi5 itself
// that's a wasted hop — we can talk to the bridge over 127.0.0.1
// directly, which is faster and avoids LAN routing bugs.
//
// We probe localhost:19443 (Caddy HTTPS front) and localhost:47773
// (the bridge's direct HTTP port) for a /status response. We PREFER
// HTTPS — even though the HTTP probe responds faster, the iframe
// inside the extension runs in a secure context (chrome-extension://)
// and an http:// subresource triggers Chrome's mixed-content block,
// which silently leaves the React app unable to mount.
//
// We deliberately do NOT probe IPv6 (e.g. [::1]). The bridge only
// binds 0.0.0.0 / 127.0.0.1, and the manifest's CSP doesn't list
// https://[::1]:19443. Probing it would produce a confusing dead
// result and trigger a CSP error in the extension page.
const LOOPBACK_CANDIDATES = [
  // [host, port, scheme] — checked in this order, first one whose
  // /status returns ok=true wins.
  ["localhost", 19443, "https"],
  ["localhost", 47773, "http"],
];
const PROBE_TIMEOUT_MS = 1500;

function configuredLoopbackOrigin(config) {
  const origin = (config.bridgeUrl || "").trim().replace(/\/+$/, "");
  if (!origin) return "";
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return origin;
  } catch {
    return "";
  }
  return "";
}

function buildLoopbackCandidates(config) {
  const out = [];
  const seen = new Set();
  const configuredLoopback = configuredLoopbackOrigin(config);
  const defaultCandidates = new Set(LOOPBACK_CANDIDATES.map(([host, port, scheme]) => `${scheme}://${host}:${port}`));
  if (configuredLoopback && !defaultCandidates.has(configuredLoopback)) {
    seen.add(configuredLoopback);
    out.push(configuredLoopback);
  }
  // Use "localhost" (not 127.0.0.1) as the host for the loopback probe
  // because Chrome's MV3 CSP rejects "https://127.0.0.1:*" as an
  // "insecure CSP value" in script-src, even though 127.0.0.1 is a
  // secure context per W3C. localhost is treated as a normal DNS host
  // and is accepted.
  for (const [host, port, scheme] of LOOPBACK_CANDIDATES) {
    const candidate = `${scheme}://${host}:${port}`;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  // Always include the original URL as a final fallback so a remote
  // machine (where loopback is meaningless) still resolves to its
  // configured target.
  const origin = (config.bridgeUrl || "").trim().replace(/\/+$/, "");
  if (origin && !seen.has(origin)) {
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

export async function detectLoopbackBridge(config, { fetchImpl: fetchOverride } = {}) {
  if (!config) return config;
  const fetchFn = fetchOverride ?? (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) return config;
  const candidates = buildLoopbackCandidates(config);
  const headers = config.bridgeToken
    ? { "X-ResonantOS-Bridge-Token": config.bridgeToken }
    : {};
  // Probe candidates SEQUENTIALLY (not via Promise.any) so HTTPS
  // gets a fair shot even if HTTP responds first. We return the
  // first candidate whose /status returns ok=true. Sequential probing
  // is fast enough — the bridge is on the same host, and we time
  // out each probe at 1.5s.
  for (const candidate of candidates) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${candidate}/status`, {
        method: "GET",
        headers,
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      let body = null;
      try { body = await res.json(); } catch { continue; }
      if (body?.ok === true && (body?.service === "resonantos-bridge" || body?.bridge)) {
        return {
          ...config,
          bridgeUrl: candidate,
          source: config.source ? `loopback:${config.source}` : "loopback",
        };
      }
    } catch {
      clearTimeout(timer);
      // Try next candidate.
    }
  }
  return config;
}

// SECURITY: Capability tokens issued at runtime by the bridge's authenticated
// /api/capability-tokens endpoint populate this module-level map on
// service-worker startup. Config-supplied tokens (bridgeCapabilityTokens in
// the createBridgeClient config, or globalThis.__RESONANTOS_BRIDGE_CONFIG__)
// take precedence — they are typically the higher-privilege tokens baked
// into the build. The runtime-fetched tokens are an additional layer for
// tokens that should NOT appear in the generated config file.
const _capabilityTokens = {};

/**
 * Fetches capability tokens from the bridge server's authenticated endpoint
 * and merges them into the shared _capabilityTokens map. Must be called
 * once on service-worker startup so that subsequent bridgeRequest() calls
 * can attach the right capability headers.
 *
 * The endpoint requires both a valid X-ResonantOS-Bridge-Token header and the
 * generated capability-bootstrap token; raw capability tokens are never written
 * to the generated config file.
 */
export async function initCapabilityTokens(config) {
  const cfg = config ?? globalThis.__RESONANTOS_BRIDGE_CONFIG__ ?? {};
  const bridgeUrl = cfg.bridgeUrl ?? DEFAULT_BRIDGE_URL;
  const bridgeToken = cfg.bridgeToken ?? "";
  const capabilityBootstrapToken = cfg.capabilityBootstrapToken ?? "";
  const fetchImpl = cfg.fetchImpl ?? fetch;
  if (!bridgeToken || !capabilityBootstrapToken) return;
  try {
    const response = await fetchImpl(`${bridgeUrl}/api/capability-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ResonantOS-Bridge-Token": bridgeToken,
        "X-ResonantOS-Capability-Bootstrap-Token": capabilityBootstrapToken,
      },
      body: JSON.stringify({ capabilities: RUNTIME_CAPABILITY_ALLOWLIST }),
    });
    if (response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (payload?.ok && payload?.capabilityTokens && typeof payload.capabilityTokens === "object") {
        Object.assign(_capabilityTokens, payload.capabilityTokens);
      }
    }
  } catch {
    // Bridge may not be reachable yet (e.g. host not started). Capability
    // requests will fall back to config-supplied tokens until the bridge
    // is up.
  }
}
