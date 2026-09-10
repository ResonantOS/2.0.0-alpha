// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#4-wire-format
// Intent citation: docs/architecture/ADR-038-ref-extension-framework.md#8-phase-3-5-hardening
//
// External Agent Runtime Dispatcher
//
// The bridge-side dispatcher for external-agent-runtime addons
// (ADR-040 §4). Given:
//   - an addon manifest (loaded from examples/addons/*.json or
//     public/addons/*.json),
//   - a per-caller grant store (Phase 3.5 kernel,
//     `bridge-grants-store.mjs`),
//   - an audit ledger (Phase 3.5 hardening, `bridge-audit-ledger.mjs`),
//   - a tool name declared in the manifest,
//   - a payload,
// this module:
//   1. Looks up the addon by id.
//   2. Validates the caller holds the per-caller grant for every
//      capability the tool requires (`requiredCapabilities`).
//   3. Resolves the manifest's `service.entrypoint` and posts the
//      payload to Cordis' `/api/v1/chat/completions` (DeepSeek OpenAI-
//      compatible) endpoint.
//   4. Records the dispatch + outcome in the audit ledger.
//   5. Returns the result to the bridge caller.
//
// This module does NOT itself host the bridge. It is consumed by
// `addon-delegation-host-service.mjs`, which registers a route that
// delegates here. Test file:
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

/**
 * Find an addon manifest by id. Searches `examples/addons/*.json` then
 * `public/addons/*.json`. Returns the parsed manifest, or null if not
 * found. The caller decides what to do with `null`.
 */
export async function findAddonManifest(addonId, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const candidates = [
    resolvePath(repoRoot, "examples", "addons"),
    resolvePath(repoRoot, "public", "addons"),
  ];
  for (const dir of candidates) {
    const path = resolvePath(dir, `${addonId}.json`);
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
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
 * the tool requires. Pure: returns `{ ok, missing }` where `missing`
 * is the list of uncovered capabilities.
 */
export function checkToolGrants({ tool, perCallerGrants, callerId }) {
  const required = tool.requiredCapabilities ?? [];
  const missing = [];
  for (const capability of required) {
    // Phase 3.5 grant lookup. The exact shape of perCallerGrants is
    // documented in `bridge-grants-store.mjs`; we read it defensively
    // so a future schema change degrades to deny rather than allow.
    let granted = false;
    if (perCallerGrants && typeof perCallerGrants.get === "function") {
      const bucket = perCallerGrants.get(callerId);
      granted = Boolean(bucket?.capabilities?.get?.(capability));
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
 * The manifest's `delegation.taskTypes` and `providerRequirements`
 * constrain what model names are valid; we don't filter on those here
 * (the addon SDK's `validateAddOnManifest` already does at install
 * time). The dispatcher's job is to forward the request faithfully.
 */
export function buildChatCompletionsRequest({ model, messages, options }) {
  return {
    model: model ?? "deepseek-chat",
    messages: Array.isArray(messages) ? messages : [],
    ...(options && typeof options === "object" ? options : {}),
  };
}

/**
 * Effectful: POST to the Cordis endpoint. Returns `{ ok, status, body,
 * error }` where `body` is the parsed JSON response (or null on
 * network error) and `error` is set only on transport failure.
 *
 * `fetch` is used directly (Node 18+). Caller passes an `AbortSignal`
 * if they want timeout.
 */
export async function postToCordis({ entrypoint, request, signal, fetchImpl = globalThis.fetch }) {
  const url = `${entrypoint.replace(/\/$/, "")}/api/v1/chat/completions`;
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
 * Caller MUST pass `auditLedger.record(...)` (Phase 3.5 ledger). If
 * omitted, audit is silently skipped - but in production callers
 * always wire it.
 *
 * `repoRoot` (optional) overrides the manifest search root. Useful
 * for tests; production callers leave it unset.
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
  const manifest = await findAddonManifest(addonId, { repoRoot });
  if (!manifest) {
    return { outcome: "deny", reason: "addon-not-found", detail: `addon manifest ${addonId}.json not found` };
  }
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
  if (!entrypoint) {
    return {
      outcome: "deny",
      reason: "manifest-misconfigured",
      detail: `addon ${addonId} has no service.entrypoint`,
    };
  }
  const request = buildChatCompletionsRequest(payload ?? {});
  const response = await postToCordis({ entrypoint, request, fetchImpl });
  if (auditLedger?.record) {
    auditLedger.record({
      callerId,
      addonId,
      tool: toolName,
      entrypoint,
      request,
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
