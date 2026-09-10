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

const moduleDir = dirname(fileURLToPath(import.meta.url));
// browser-first/host/external-agent-runtime-dispatcher.mjs -> repo root is
// three levels up. Manifests are looked up first in `examples/addons/` then
// `public/addons/`.
export const DEFAULT_REPO_ROOT = resolvePath(moduleDir, "..", "..", "..");

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
export function checkToolGrants({ tool, perCallerGrants, callerId, now = () => Date.now() }) {
  const required = tool?.requiredCapabilities ?? [];
  const missing = [];
  if (required.length === 0) return { ok: true, missing };
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
  return { ok: missing.length === 0, missing };
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
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const out = {};
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
export async function postToCordis({ entrypoint, request, signal, fetchImpl = globalThis.fetch }) {
  const loopback = assertLoopbackEntrypoint(entrypoint);
  if (!loopback.ok) {
    return { ok: false, status: 0, body: null, reason: loopback.reason, detail: loopback.detail };
  }
  const url = `${loopback.url.href.replace(/\/$/, "")}/api/v1/chat/completions`;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(request),
  };
  if (signal) init.signal = signal;
  try {
    const response = await fetchImpl(url, init);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error) };
  }
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
  const grant = checkToolGrants({ tool, perCallerGrants, callerId });
  if (!grant.ok) {
    return {
      outcome: "deny",
      reason: "capability-denied",
      detail: `caller ${callerId} missing per-caller grants for: ${grant.missing.join(", ")}`,
    };
  }
  const entrypoint = manifest.service?.entrypoint;
  const entrypointCheck = assertLoopbackEntrypoint(entrypoint);
  if (!entrypointCheck.ok) {
    return {
      outcome: "deny",
      reason: entrypointCheck.reason,
      detail: `addon ${addonId}: ${entrypointCheck.detail}`,
    };
  }
  const request = buildChatCompletionsRequest(payload ?? {});
  const response = await postToCordis({ entrypoint, request, fetchImpl });
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
