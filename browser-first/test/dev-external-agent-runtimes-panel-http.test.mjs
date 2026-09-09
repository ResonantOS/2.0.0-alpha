// Real-HTTP security proof for the dev-only external-agent-runtimes panel.
//
// The direct service tests in dev-external-agent-runtimes-panel.test.mjs
// exercise the route handlers in isolation; that is not sufficient. This file
// drives both panel routes through the actual bridge request evaluator/server
// (`startBridgeServer` on an ephemeral loopback port) and proves the dev's
// #346 security invariants hold on the wire:
//
//   1. Missing bridge token is denied (401).
//   2. Missing capability token is denied (403).
//   3. Wrong capability is denied (403).
//   4. Valid caller-bound `addon-runtime-read` token succeeds (200).
//   5. Caller mismatch (token bound to a different caller) is denied (403).
//   6. Revoked token is denied even though its HMAC still checks out (403).
//   7. A raw X-ResonantOS-Bridge-Caller-Id header cannot authenticate.
//   8. A loopback / RFC1918 source address does not bypass authentication.
//   9. A path suffix does not match the exact route keys (404).
//  10. A disallowed origin receives no Access-Control-Allow-Origin header
//      (never a wildcard `*`).
//  11. The HTML response contains no token or sensitive field.
//  12. Malicious add-on fields cannot break out of the serialized data block.
//  13. The routes are development-only: absent unless registered, and fail
//      closed (404 default-deny) when not.
//
// All fixtures are in-process and deterministic: no external credentials, no
// network services, ephemeral ports only.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startBridgeServer } from "../host/bridge-server.mjs";
import { createBridgeGrantsStore } from "../host/bridge-grants-store.mjs";
import { createBridgeTokenKey } from "../host/bridge-token-key.mjs";
import { createDevExternalAgentRuntimesPanelService } from "../host/dev-external-agent-runtimes-panel.mjs";

const BRIDGE_TOKEN = "panel-http-bridge-token";
const JSON_PATH = "/dev/external-agent-runtimes";
const HTML_PATH = "/dev/external-agent-runtimes/";

const HEADER_BRIDGE = "X-ResonantOS-Bridge-Token";
const HEADER_CAPABILITY = "X-ResonantOS-Bridge-Capability-Token";
const HEADER_CALLER = "X-ResonantOS-Bridge-Caller-Id";

// A manifest exercising benign fields plus a hostile name that would break out
// of the injected data block if the serializer did not escape it.
const GOOD_MANIFEST = {
  id: "addon.deepseek-harness",
  name: "DeepSeek Harness",
  version: "0.1.0",
  runtimeType: "agent-addon",
  service: { entrypoint: "http://127.0.0.1:3080" },
  requestedCapabilities: [{ capability: "providers" }, { capability: "agent-delegation" }],
  tools: [{ name: "deepseek_harness.status" }],
};
const EVIL_MANIFEST = {
  id: "evil</script><script>window.__pwned = true</script>",
  // Name carries U+2028/U+2029 separators: legal JSON string characters that
  // must survive the inert application/json block unchanged as data.
  name: "evil\u2028name\u2029",
  runtimeType: "agent-addon",
};

async function makeRepoRoot() {
  const root = await mkdtemp(join(tmpdir(), "panel-http-"));
  await mkdir(join(root, "examples", "addons"), { recursive: true });
  await writeFile(join(root, "examples", "addons", "addon.deepseek-harness.json"), JSON.stringify(GOOD_MANIFEST));
  await writeFile(join(root, "examples", "addons", "evil.json"), JSON.stringify(EVIL_MANIFEST));
  return root;
}

// Start a bridge exactly as run-bridge-minimal.mjs does: a grants store whose
// verifyCallerGrant is the live revocation-aware verifier (no boot-snapshot
// fallback), plus the dev panel routes spread into the registry.
async function startPanelBridge({ routes } = {}) {
  const repoRoot = await makeRepoRoot();
  const tokenKey = createBridgeTokenKey();
  const grantsStore = createBridgeGrantsStore({ tokenKey });
  grantsStore.mintGrant("caller.dev", "addon-runtime-read");
  const devToken = grantsStore.lookupToken("caller.dev", "addon-runtime-read");

  const bridgeAudit = [];
  const server = await startBridgeServer({
    port: 0,
    bridgeToken: BRIDGE_TOKEN,
    // A static token so the legacy/static capability path is also exercised.
    bridgeCapabilityTokens: { "addon-runtime-read": "panel-static-runtime-read-token" },
    perCallerGrants: grantsStore.snapshot(),
    tokenKey,
    callerGrantVerifier: grantsStore.verifyCallerGrant.bind(grantsStore),
    auditSink: (record) => bridgeAudit.push(record),
    capabilityBootstrapToken: "panel-bootstrap-token",
    routes,
    extensionOrigin: "chrome-extension://panel-test",
    host: "127.0.0.1",
  });
  return {
    server,
    repoRoot,
    grantsStore,
    devToken,
    bridgeAudit,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

async function get(ctx, path, headers = {}) {
  const res = await fetch(`${ctx.base}${path}`, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML or empty */ }
  return { status: res.status, headers: res.headers, text, json };
}

async function close(ctx) {
  await new Promise((resolve) => ctx.server.close(resolve));
  await rm(ctx.repoRoot, { recursive: true, force: true });
}

function withPanelRoutes(ctx) {
  return { ...ctx };
}

// ---------------------------------------------------------------------------
// Auth: bridge token + capability enforcement (cases 1–5)
// ---------------------------------------------------------------------------

test("missing bridge token is denied (401)", async () => {
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot: await makeRepoRoot() }).devPanelRoutes,
  });
  try {
    const res = await get(ctx, JSON_PATH);
    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
  } finally {
    await close(ctx);
  }
});

test("missing capability token is denied (403)", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    const res = await get(ctx, JSON_PATH, { [HEADER_BRIDGE]: BRIDGE_TOKEN });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /requires addon-runtime-read capability/);
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("wrong capability is denied (403)", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    const res = await get(ctx, JSON_PATH, {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: "panel-static-runtime-read-token-but-wrong-route",
      [HEADER_CALLER]: "caller.dev",
    });
    // caller.dev is caller-bound; the static token is not bound to it, so the
    // verifier path denies. (Also proves a wrong token value fails.)
    assert.equal(res.status, 403);
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("valid caller-bound addon-runtime-read token succeeds (200) for JSON and HTML", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    const headers = {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: ctx.devToken,
      [HEADER_CALLER]: "caller.dev",
    };
    const jsonRes = await get(ctx, JSON_PATH, headers);
    assert.equal(jsonRes.status, 200);
    assert.equal(jsonRes.json.ok, true);
    assert.ok(Array.isArray(jsonRes.json.addons));

    const htmlRes = await get(ctx, HTML_PATH, headers);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type") ?? "", /text\/html/);
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("caller mismatch (token bound to a different caller) is denied (403)", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    // devToken is HMAC-bound to caller.dev; presenting it as another caller fails.
    const res = await get(ctx, JSON_PATH, {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: ctx.devToken,
      [HEADER_CALLER]: "caller.other",
    });
    assert.equal(res.status, 403);
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Revocation fails closed — store-first, no boot-snapshot fallback (case 6)
// ---------------------------------------------------------------------------

test("revoked token is denied even though its HMAC still checks out (403)", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    const headers = {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: ctx.devToken,
      [HEADER_CALLER]: "caller.dev",
    };
    // Sanity: authorized before revocation.
    assert.equal((await get(ctx, JSON_PATH, headers)).status, 200);

    // Revoke in the live store. The HMAC of devToken is unchanged and still
    // verifies cryptographically; the store-first verifier must deny anyway.
    ctx.grantsStore.revoke("caller.dev", "addon-runtime-read");
    const res = await get(ctx, JSON_PATH, headers);
    assert.equal(res.status, 403, "a revoked grant must not fall back to the boot-time snapshot");

    const denied = ctx.bridgeAudit.filter((r) => r.reason === "capability-denied");
    assert.ok(denied.length >= 1, "the revoked attempt must be audited as capability-denied");
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Caller identity: raw header cannot authenticate (case 7)
// ---------------------------------------------------------------------------

test("raw X-ResonantOS-Bridge-Caller-Id header does not authenticate", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    // No capability token at all, only a raw caller-id header for a caller
    // that DOES hold a grant. The header alone must never satisfy the route.
    const res = await get(ctx, JSON_PATH, {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CALLER]: "caller.dev",
    });
    assert.equal(res.status, 403);

    // Audit must never attribute the denial to the raw header as authorized.
    const authorized = ctx.bridgeAudit.filter((r) => r.reason === "authorized");
    assert.ok(authorized.every((r) => r.callerId !== "caller.dev" || r.capability !== "addon-runtime-read"),
      "no request may be authorized on the strength of the raw caller-id header");
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Network address is not an auth factor (case 8)
// ---------------------------------------------------------------------------

test("loopback / RFC1918 source address does not bypass authentication", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    // The request arrives over loopback (127.0.0.1) — the only interface an
    // ephemeral test server can bind. With no bridge token it must still 401;
    // there is no address-based trust anywhere in the evaluator.
    const res = await get(ctx, JSON_PATH);
    assert.equal(res.status, 401, "loopback origin must not bypass the bridge token");
    // With a bridge token but no capability token it must still 403.
    const res2 = await get(ctx, JSON_PATH, { [HEADER_BRIDGE]: BRIDGE_TOKEN });
    assert.equal(res2.status, 403, "loopback origin must not bypass the capability token");
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Exact-path matching: suffix / traversal / encoded variants rejected (case 9)
// ---------------------------------------------------------------------------

test("path suffixes and variants do not match the exact route keys", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    const headers = {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: ctx.devToken,
      [HEADER_CALLER]: "caller.dev",
    };
    const mustBe404 = [
      "/dev/external-agent-runtimes-anything",
      "/dev/external-agent-runtimes/extra",
      "/dev/external-agent-runtimes/../addons/status",
      "/dev/external-agent-runtimes%2f..%2faddons%2fstatus",
    ];
    for (const p of mustBe404) {
      const res = await get(ctx, p, headers);
      assert.equal(res.status, 404, `${p} must not match (startsWith is forbidden)`);
    }
    // The two canonical paths resolve; trailing slash distinguishes them.
    assert.equal((await get(ctx, JSON_PATH, headers)).status, 200);
    assert.equal((await get(ctx, HTML_PATH, headers)).status, 200);
    // Query strings are stripped by routeKey (new URL().pathname) and do not
    // affect matching — and must never carry tokens.
    assert.equal((await get(ctx, `${JSON_PATH}?x=1`, headers)).status, 200);
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CORS: no wildcard fallback (case 10)
// ---------------------------------------------------------------------------

test("disallowed origin receives no Access-Control-Allow-Origin (never a wildcard)", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    const headers = {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: ctx.devToken,
      [HEADER_CALLER]: "caller.dev",
      Origin: "https://attacker.example",
    };
    const res = await get(ctx, HTML_PATH, headers);
    assert.equal(res.status, 200, "the request is authorized; CORS is orthogonal to auth");
    const acao = res.headers.get("access-control-allow-origin");
    assert.notEqual(acao, "*", "never emit a wildcard origin");
    assert.notEqual(acao, "https://attacker.example", "never echo a disallowed origin");
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTML body hygiene (cases 11–12)
// ---------------------------------------------------------------------------

test("HTML response contains no token or sensitive field and enforces a CSP", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    const headers = {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: ctx.devToken,
      [HEADER_CALLER]: "caller.dev",
    };
    const res = await get(ctx, HTML_PATH, headers);
    assert.equal(res.status, 200);

    // No credential is reflected into the served document.
    for (const secret of [BRIDGE_TOKEN, ctx.devToken, "panel-bootstrap-token", "panel-static-runtime-read-token"]) {
      assert.ok(!res.text.includes(secret), `HTML must not contain a token (${secret.slice(0, 12)}…)`);
    }
    // Only manifest-derived fields appear; nothing reads env or the filesystem
    // beyond examples/addons.
    assert.ok(!res.text.includes("process.env"), "HTML must not reference process.env");

    // The document is locked to its own inline script/style only.
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /\*/, "CSP must not contain a wildcard source");
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("malicious add-on fields cannot break out of the serialized data block", async () => {
  const repoRoot = await makeRepoRoot();
  const ctx = await startPanelBridge({
    routes: createDevExternalAgentRuntimesPanelService({ repoRoot }).devPanelRoutes,
  });
  try {
    const headers = {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: ctx.devToken,
      [HEADER_CALLER]: "caller.dev",
    };
    const res = await get(ctx, HTML_PATH, headers);
    assert.equal(res.status, 200);

    // The evil manifest's raw closing tag must never reach the client: the only
    // escaping required for an inert application/json block is `<` -> <.
    assert.ok(!res.text.includes("evil</script>"), "raw </script> from a manifest must be escaped");
    // The data lives in an inert application/json block (never executed), so it
    // must be present and parse as JSON — not as JavaScript. U+2028/U+2029 are
    // legal JSON string characters here and need no escaping.
    const m = res.text.match(/<script type="application\/json" id="panel-data">([\s\S]*?)<\/script>/);
    assert.ok(m, "the inert application/json data block must be present");
    const parsed = JSON.parse(m[1]);
    const evil = parsed.addons.find((addon) => addon.fileName === "evil.json");
    assert.ok(evil, "the evil manifest must be enumerated");
    assert.match(evil.id, /evil/, "the manifest id is carried through as data");
  } finally {
    await close(ctx);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Development-only: routes fail closed when not registered (case 13)
// ---------------------------------------------------------------------------

test("panel routes fail closed (404) when not registered — production has no dev route", async () => {
  // A bridge started WITHOUT the dev panel routes (the production shape: the
  // production launcher does not spread devPanelRoutes). Even a fully
  // authorized caller must get default-deny 404 for the dev path.
  const ctx = await startPanelBridge({ routes: [] });
  try {
    const res = await get(ctx, JSON_PATH, {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: ctx.devToken,
      [HEADER_CALLER]: "caller.dev",
    });
    assert.equal(res.status, 404, "an unregistered dev route must fall through to default-deny 404");
    assert.equal((await get(ctx, HTML_PATH, {
      [HEADER_BRIDGE]: BRIDGE_TOKEN,
      [HEADER_CAPABILITY]: ctx.devToken,
      [HEADER_CALLER]: "caller.dev",
    })).status, 404);
  } finally {
    await close(ctx);
  }
});
