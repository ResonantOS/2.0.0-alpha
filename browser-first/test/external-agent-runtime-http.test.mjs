// HTTP-path integration test for the external-agent-runtime dispatcher route.
//
// Proves the registered bridge route `POST /external-agent-runtime/delegate`
// actually dispatches through the real bridge server (not just the direct
// dispatchExternalAgentRuntime core), and that verified caller identity —
// never the raw X-ResonantOS-Bridge-Caller-Id header — reaches the handler.
//
// The external provider is an in-process Cordis stub (no network, no
// credentials). `fetchImpl` is wrapped so the test can prove the stub is NOT
// called on denied requests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startBridgeServer } from "../host/bridge-server.mjs";
import { createBridgeGrantsStore } from "../host/bridge-grants-store.mjs";
import { createBridgeTokenKey } from "../host/bridge-token-key.mjs";
import { createAddonDelegationHostService } from "../host/addon-delegation-host-service.mjs";
import { startCordisStub } from "./_cordis-stub-loader.mjs";

const BRIDGE_TOKEN = "http-test-bridge-token";
const ADDON_ID = "addon.deepseek-harness";
const TOOL_NAME = "deepseek_harness.run_task";

function makeManifest(entrypoint) {
  return {
    id: ADDON_ID,
    name: "DeepSeek Harness",
    version: "0.1.0",
    runtimeType: "agent-addon",
    service: {
      protocol: "http-json",
      entrypoint,
      healthCommand: "deepseek_harness_status",
      shutdownCommand: "deepseek_harness_stop_service",
    },
    tools: [
      {
        name: TOOL_NAME,
        description: "run",
        requiredCapabilities: ["network", "providers", "agent-delegation"],
        inputSchema: {},
        outputSchema: {},
        audit: { logRequest: true, logResult: true, artifactTypes: ["summary"] },
        requiresHumanApproval: true,
      },
    ],
  };
}

async function setup() {
  const stub = await startCordisStub({});
  const repoRoot = await mkdtemp(join(tmpdir(), "dispatcher-http-"));
  await mkdir(join(repoRoot, "examples", "addons"), { recursive: true });
  await writeFile(
    join(repoRoot, "examples", "addons", `${ADDON_ID}.json`),
    JSON.stringify(makeManifest(stub.entrypoint), null, 2),
  );

  const tokenKey = createBridgeTokenKey();
  const grantsStore = createBridgeGrantsStore({ tokenKey });

  // caller.full: route capability + the tool's addon capabilities.
  grantsStore.mintGrant("caller.full", "agent-delegation");
  grantsStore.mintGrant("caller.full", "network");
  grantsStore.mintGrant("caller.full", "providers");
  const fullToken = grantsStore.lookupToken("caller.full", "agent-delegation");

  // caller.agent-only: route capability but NOT the tool's addon capabilities.
  grantsStore.mintGrant("caller.agent-only", "agent-delegation");
  const agentOnlyToken = grantsStore.lookupToken("caller.agent-only", "agent-delegation");

  // Track upstream fetches so deny paths can prove the provider was not hit.
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return globalThis.fetch(url, init);
  };

  const dispatcherAudit = [];
  const stubHandlers = new Proxy({}, { get: () => async () => ({ ok: true }) });
  const { addonDelegationRoutes } = createAddonDelegationHostService(stubHandlers, {
    grantsStore,
    auditLedger: { record: (record) => dispatcherAudit.push(record) },
    fetchImpl,
    repoRoot,
  });

  const bridgeAudit = [];
  const staticAgentToken = "static-agent-delegation-token";
  const server = await startBridgeServer({
    port: 0,
    bridgeToken: BRIDGE_TOKEN,
    bridgeCapabilityTokens: { "agent-delegation": staticAgentToken },
    perCallerGrants: grantsStore.snapshot(),
    tokenKey,
    callerGrantVerifier: grantsStore.verifyCallerGrant.bind(grantsStore),
    auditSink: (record) => bridgeAudit.push(record),
    capabilityBootstrapToken: "http-test-bootstrap-token",
    routes: addonDelegationRoutes,
    extensionOrigin: "chrome-extension://test",
    host: "127.0.0.1",
  });
  const port = server.address().port;

  return {
    base: `http://127.0.0.1:${port}`,
    server,
    stub,
    repoRoot,
    fullToken,
    agentOnlyToken,
    staticAgentToken,
    fetchCalls,
    bridgeAudit,
    dispatcherAudit,
  };
}

async function delegate(base, { token, callerId, addonId = ADDON_ID, tool = TOOL_NAME, payload = {} } = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-ResonantOS-Bridge-Token": BRIDGE_TOKEN,
  };
  if (callerId !== undefined) headers["X-ResonantOS-Bridge-Caller-Id"] = callerId;
  if (token !== undefined) headers["X-ResonantOS-Bridge-Capability-Token"] = token;
  const res = await fetch(`${base}/external-agent-runtime/delegate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ addonId, tool, payload }),
  });
  return { status: res.status, body: await res.json() };
}

async function teardown(ctx) {
  await ctx.stub.close();
  await new Promise((resolve) => ctx.server.close(resolve));
  await rm(ctx.repoRoot, { recursive: true, force: true });
}

test("dispatcher route dispatches a caller-bound request through the real bridge", async () => {
  const ctx = await setup();
  try {
    const res = await delegate(ctx.base, {
      token: ctx.fullToken,
      callerId: "caller.full",
      payload: { model: "deepseek-chat", messages: [{ role: "user", content: "hello" }] },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.dispatched, true);
    assert.ok(Array.isArray(res.body.response?.choices), "upstream completion body must be returned");

    // Verified caller identity reached the dispatcher and the provider round-tripped.
    assert.equal(ctx.fetchCalls.length, 1, "the stub provider must be called exactly once");
    assert.equal(ctx.dispatcherAudit.length, 1, "the dispatcher must record an audit entry");
    assert.equal(ctx.dispatcherAudit[0].callerId, "caller.full");
  } finally {
    await teardown(ctx);
  }
});

test("missing agent-delegation capability is denied before dispatch", async () => {
  const ctx = await setup();
  try {
    // No capability token at all: route gate denies before the handler runs.
    const res = await delegate(ctx.base, { callerId: "caller.full", token: undefined });
    assert.equal(res.status, 403);
    assert.equal(ctx.fetchCalls.length, 0, "the provider must not be called");
  } finally {
    await teardown(ctx);
  }
});

test("caller mismatch (token bound to a different caller) is denied", async () => {
  const ctx = await setup();
  try {
    // fullToken is HMAC-bound to caller.full; presenting it as caller.agent-only fails.
    const res = await delegate(ctx.base, { token: ctx.fullToken, callerId: "caller.agent-only" });
    assert.equal(res.status, 403);
    assert.equal(ctx.fetchCalls.length, 0, "the provider must not be called");
  } finally {
    await teardown(ctx);
  }
});

test("missing per-caller tool grants fail closed at the dispatcher", async () => {
  const ctx = await setup();
  try {
    // caller.agent-only passes the agent-delegation route gate but lacks the
    // tool's network/providers grants; the dispatcher must deny without dispatch.
    const res = await delegate(ctx.base, { token: ctx.agentOnlyToken, callerId: "caller.agent-only" });
    assert.equal(res.status, 200, "route gate passed");
    assert.equal(res.body.dispatched, false);
    assert.equal(res.body.reason, "capability-denied");
    assert.equal(ctx.fetchCalls.length, 0, "the provider must not be called");
  } finally {
    await teardown(ctx);
  }
});

test("raw caller-id header cannot create a trusted identity", async () => {
  const ctx = await setup();
  try {
    // Static capability token + a raw (unregistered) caller-id header. The
    // bridge authorizes the static token but attributes the request to the
    // safe fallback, not the raw header.
    const res = await delegate(ctx.base, { token: ctx.staticAgentToken, callerId: "rogue" });
    assert.equal(res.status, 200, "static token authorizes the route gate");
    assert.equal(res.body.dispatched, false);
    assert.equal(res.body.reason, "caller-unverified");
    assert.equal(ctx.fetchCalls.length, 0, "the provider must not be called");

    // The bridge audit records the safe fallback, never the raw header.
    const authorized = ctx.bridgeAudit.filter((r) => r.reason === "authorized");
    assert.ok(authorized.length >= 1, "an authorized audit record must exist");
    assert.ok(
      authorized.every((r) => r.callerId !== "rogue"),
      "the raw caller-id header must never appear as a verified identity",
    );
    assert.ok(
      authorized.some((r) => r.callerId === "__extension__"),
      "unattributed requests must fall back to __extension__",
    );
  } finally {
    await teardown(ctx);
  }
});
