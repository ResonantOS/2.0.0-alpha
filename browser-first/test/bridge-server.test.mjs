import assert from "node:assert/strict";
import test from "node:test";

import {
  createBridgeClient,
  createRawBridgeFetch,
  capabilityForBridgeRoute,
  initCapabilityTokens,
  isUnauthorizedBridgeError,
  resolveBridgeConfig,
} from "../resonantos-side-panel-extension/src/lib/bridge-client.js";
import { constantTimeEqual, evaluateBridgeRequestForSelfTest, startBridgeServer, summarizeBridgeAuthSelfTest } from "../host/bridge-server.mjs";

test("constant-time token comparison preserves exact-match and length checks", () => {
  assert.equal(constantTimeEqual("capability-token", "capability-token"), true);
  assert.equal(constantTimeEqual("capability-token", "capability-tokfn"), false);
  assert.equal(constantTimeEqual("capability-token", "capability-token-extra"), false);
  assert.equal(constantTimeEqual("", undefined), false);
  assert.equal(constantTimeEqual("", ""), false, "two empty tokens must never compare equal (fail closed)");
});

test("bridge capability behavior is deterministic without localhost binding", async () => {
  const bridgeToken = "general-test-token";
  const capabilityToken = "credential-write-test-token";
  const routes = [
    {
      method: "GET",
      path: "/public",
      requiredCapability: "bridge-diagnostics-read",
      handler: async () => ({ public: true }),
    },
    {
      method: "POST",
      path: "/providers/credentials",
      requiredCapability: "provider-credential-write",
      handler: async () => ({ saved: true }),
    },
  ];

  const publicResult = await evaluateBridgeRequestForSelfTest({
    method: "GET",
    url: "/public",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": capabilityToken,
    },
    bridgeToken,
    bridgeCapabilityTokens: {
      "bridge-diagnostics-read": capabilityToken,
      "provider-credential-write": capabilityToken,
    },
    routes,
  });
  assert.equal(publicResult.status, 200);
  assert.equal(publicResult.payload.public, true);

  const unauthorized = await evaluateBridgeRequestForSelfTest({
    method: "GET",
    url: "/public",
    headers: {},
    bridgeToken,
    bridgeCapabilityTokens: { "provider-credential-write": capabilityToken },
    routes,
  });
  assert.equal(unauthorized.status, 401);

  const missingCapability = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/providers/credentials",
    headers: { "X-ResonantOS-Bridge-Token": bridgeToken },
    body: { providerId: "shared-minimax", credential: "minimax-test-credential" },
    bridgeToken,
    bridgeCapabilityTokens: { "provider-credential-write": capabilityToken },
    routes,
  });
  assert.equal(missingCapability.status, 403);

  const wrongCapability = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": "wrong-token",
    },
    body: { providerId: "shared-minimax", credential: "minimax-test-credential" },
    bridgeToken,
    bridgeCapabilityTokens: { "provider-credential-write": capabilityToken },
    routes,
  });
  assert.equal(wrongCapability.status, 403);

  const saved = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": capabilityToken,
    },
    body: { providerId: "shared-minimax", credential: "minimax-test-credential" },
    bridgeToken,
    bridgeCapabilityTokens: { "provider-credential-write": capabilityToken },
    routes,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.saved, true);
});

test("bridge refuses undeclared routes by default while preserving declared capability and bootstrap routes", async () => {
  const bridgeToken = "default-deny-test-token";
  const capabilityBootstrapToken = "default-deny-bootstrap-token";
  const capabilityToken = "default-deny-capability-token";

  const undeclared = await evaluateBridgeRequestForSelfTest({
    method: "GET",
    url: "/default-deny",
    headers: { "X-ResonantOS-Bridge-Token": bridgeToken },
    bridgeToken,
    bridgeCapabilityTokens: { "bridge-diagnostics-read": capabilityToken },
    capabilityBootstrapToken,
    routes: [
      { method: "GET", path: "/default-deny", handler: async () => ({ reached: true }) },
    ],
  });
  assert.equal(undeclared.status, 403);
  assert.deepEqual(undeclared.payload, {
    ok: false,
    error: "Bridge route declares no capability; refused by default.",
  });

  const declared = await evaluateBridgeRequestForSelfTest({
    method: "GET",
    url: "/default-deny",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": capabilityToken,
    },
    bridgeToken,
    bridgeCapabilityTokens: { "bridge-diagnostics-read": capabilityToken },
    capabilityBootstrapToken,
    routes: [
      {
        method: "GET",
        path: "/default-deny",
        requiredCapability: "bridge-diagnostics-read",
        handler: async () => ({ reached: true }),
      },
    ],
  });
  assert.equal(declared.status, 200);
  assert.equal(declared.payload.reached, true);

  const bootstrapOnly = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/bootstrap-only",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Capability-Bootstrap-Token": capabilityBootstrapToken,
    },
    bridgeToken,
    bridgeCapabilityTokens: { "bridge-diagnostics-read": capabilityToken },
    capabilityBootstrapToken,
    routes: [
      {
        method: "POST",
        path: "/bootstrap-only",
        requiredCapabilityBootstrap: true,
        handler: async () => ({ bootstrapped: true }),
      },
    ],
  });
  assert.equal(bootstrapOnly.status, 200);
  assert.equal(bootstrapOnly.payload.bootstrapped, true);
});
// Kernel of M0 Test B (Local Files): two distinct callers, overlapping but
// distinct grants on the same capability, must be observably distinguishable
// to the bridge — both at the route handler and in the audit log.
test("bridge distinguishes two callers with overlapping grants (M0 Test B kernel)", async () => {
  const bridgeToken = "general-test-token";
  const alphaToken = "alpha-credential-token";
  const betaToken = "beta-credential-token";
  const routes = [
    {
      method: "POST",
      path: "/providers/credentials",
      requiredCapability: "provider-credential-write",
      handler: async () => ({ saved: true }),
    },
  ];
  const perCallerGrants = {
    "alpha-caller": { "provider-credential-write": alphaToken },
    "beta-caller": { "provider-credential-write": betaToken },
  };
  const auditRecords = [];
  const auditSink = (record) => { auditRecords.push(record); };

  // Beta caller requests write — they have the capability, but the audit log
  // must record their caller identity, not just the capability.
  const betaRequest = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": betaToken,
      "X-ResonantOS-Bridge-Caller-Id": "beta-caller",
    },
    body: { providerId: "shared-minimax" },
    bridgeToken,
    bridgeCapabilityTokens: {},
    perCallerGrants,
    auditSink,
    routes,
  });
  assert.equal(betaRequest.status, 200, "beta-caller has grant, must succeed");

  // Alpha caller requests write — different grant, different token.
  const alphaRequest = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": alphaToken,
      "X-ResonantOS-Bridge-Caller-Id": "alpha-caller",
    },
    body: { providerId: "shared-minimax" },
    bridgeToken,
    bridgeCapabilityTokens: {},
    perCallerGrants,
    auditSink,
    routes,
  });
  assert.equal(alphaRequest.status, 200, "alpha-caller has grant, must succeed");

  // A wrong-but-same-shape token for a caller with no grant must be rejected
  // — this is the kernel of M0 Test B's "denied unauthorized action".
  const unattributedRequest = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": "rogue-token",
    },
    body: { providerId: "shared-minimax" },
    bridgeToken,
    bridgeCapabilityTokens: {},
    perCallerGrants,
    auditSink,
    routes,
  });
  assert.equal(unattributedRequest.status, 403, "rogue token must be rejected");

  // Audit log must carry distinct callerId for each authorised request.
  const successful = auditRecords.filter((record) => record.status === 200);
  assert.equal(successful.length, 2, "two successful requests recorded");
  const callerIds = new Set(successful.map((record) => record.callerId));
  assert.equal(callerIds.size, 2, "callerIds must be distinguishable in audit");
  assert.ok(callerIds.has("alpha-caller"));
  assert.ok(callerIds.has("beta-caller"));
});

// Hook-up A: the wired request handler (createBridgeRequestHandler) honours
// perCallerGrants and auditSink when supplied, and rejects/forwards correctly
// when they're absent. Production stays dormant until run-bridge-minimal (or
// any future launcher) passes these — see hook-up B.
test("createBridgeRequestHandler threads perCallerGrants and auditSink end-to-end", async () => {
  const { createBridgeRequestHandler } = await import("../host/bridge-server.mjs");
  const bridgeToken = "wired-bridge-token";
  const perCallerGrants = {
    "alpha-caller": { "provider-credential-write": "alpha-cred-token" },
    "beta-caller": { "provider-credential-write": "beta-cred-token" },
  };
  const auditRecords = [];
  const auditSink = (record) => { auditRecords.push(record); };
  const routes = [
    {
      method: "GET",
      path: "/providers/credentials/probe",
      requiredCapability: "provider-credential-write",
      handler: async () => ({ probed: true }),
    },
  ];
  const handler = createBridgeRequestHandler({
    bridgeToken,
    bridgeCapabilityTokens: {},
    perCallerGrants,
    auditSink,
    extensionOrigin: "chrome-extension://test",
    routes,
  });
  function makeRequest(headers, body) {
    return {
    method: "GET",
    url: "/providers/credentials/probe",
    headers,
    };
  }

  function makeResponse() {
    const headers = {};
    const response = {
      statusCode: 0,
      body: null,
      _headers: headers,
      writeHead(status, headerObj) {
        response.statusCode = status;
        Object.assign(headers, headerObj);
      },
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      getHeader(name) { return headers[name.toLowerCase()]; },
      end(payload) {
        response.body = payload ? JSON.parse(payload) : null;
      },
    };
    return response;
  }

  // alpha-caller with its token — must succeed.
  const alphaResponse = makeResponse();
  await handler(makeRequest({
    "X-ResonantOS-Bridge-Token": bridgeToken,
    "X-ResonantOS-Bridge-Capability-Token": "alpha-cred-token",
    "X-ResonantOS-Bridge-Caller-Id": "alpha-caller",
  }), alphaResponse);
  assert.equal(alphaResponse.statusCode, 200, "alpha-caller request must 200");
  assert.equal(alphaResponse.body.probed, true);

  // beta-caller with its token — must succeed and record distinct caller.
  const betaResponse = makeResponse();
  await handler(makeRequest({
    "X-ResonantOS-Bridge-Token": bridgeToken,
    "X-ResonantOS-Bridge-Capability-Token": "beta-cred-token",
    "X-ResonantOS-Bridge-Caller-Id": "beta-caller",
  }), betaResponse);
  assert.equal(betaResponse.statusCode, 200);

  // Wrong token, valid caller header — must be rejected.
  const wrongResponse = makeResponse();
  await handler(makeRequest({
    "X-ResonantOS-Bridge-Token": bridgeToken,
    "X-ResonantOS-Bridge-Capability-Token": "rogue-token",
    "X-ResonantOS-Bridge-Caller-Id": "alpha-caller",
  }), wrongResponse);
  assert.equal(wrongResponse.statusCode, 403);

  const successes = auditRecords.filter((record) => record.status === 200);
  assert.equal(successes.length, 2);
  const callerIds = new Set(successes.map((record) => record.callerId));
  assert.equal(callerIds.size, 2, "audit must record distinct callerIds");
  assert.ok(callerIds.has("alpha-caller"));
  assert.ok(callerIds.has("beta-caller"));
});

test("bridge client sends scoped capability headers without localhost binding", async () => {
  const bridgeToken = "general-test-token";
  const capabilityToken = "credential-write-test-token";
  const routes = [
    {
      method: "POST",
      path: "/providers/credentials",
      requiredCapability: "provider-credential-write",
      handler: async (payload) => ({ saved: payload.providerId === "shared-minimax" }),
    },
  ];
  const client = createBridgeClient({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken,
    bridgeCapabilityTokens: {
      "provider-credential-write": capabilityToken,
    },
    fetchImpl: async (url, options = {}) => {
      const result = await evaluateBridgeRequestForSelfTest({
        method: options.method,
        url: new URL(url).pathname,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : {},
        bridgeToken,
        bridgeCapabilityTokens: {
          "provider-credential-write": capabilityToken,
        },
        routes,
      });
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.payload,
      };
    },
  });

  assert.equal(capabilityForBridgeRoute("/providers/credentials", "POST"), "provider-credential-write");

  const clientWithoutCapability = createBridgeClient({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken,
    bridgeCapabilityTokens: {},
    fetchImpl: async (url, options = {}) => {
      const result = await evaluateBridgeRequestForSelfTest({
        method: options.method,
        url: new URL(url).pathname,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : {},
        bridgeToken,
        bridgeCapabilityTokens: {
          "provider-credential-write": capabilityToken,
        },
        routes,
      });
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.payload,
      };
    },
  });

  await assert.rejects(
    () => clientWithoutCapability("/providers/credentials", {
      method: "POST",
      body: { providerId: "shared-minimax", credential: "minimax-test-credential" },
    }),
    /requires provider-credential-write capability/,
  );

  const saved = await client("/providers/credentials", {
    method: "POST",
    body: { providerId: "shared-minimax", credential: "minimax-test-credential" },
  });
  assert.equal(saved.saved, true);
});

test("bridge client waits for pending capability bootstrap before scoped GET", async () => {
  const bridgeClientModule = await import("../resonantos-side-panel-extension/src/lib/bridge-client.js");
  assert.equal(typeof bridgeClientModule.__resetCapabilityTokensForTests, "function");
  bridgeClientModule.__resetCapabilityTokensForTests();

  const bridgeToken = "runtime-general-test-token";
  const capabilityBootstrapToken = "runtime-bootstrap-test-token";
  const capabilityToken = "runtime-bridge-diagnostics-read-token";
  let resolveBootstrapFetch;
  const bootstrapFetchStarted = new Promise((resolve) => {
    resolveBootstrapFetch = resolve;
  });
  let statusHeaders = null;

  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/capability-tokens") {
      return await new Promise((resolve) => {
        bootstrapFetchStarted.then(() => resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            capabilityTokens: { "bridge-diagnostics-read": capabilityToken },
          }),
        }));
      });
    }
    statusHeaders = options.headers ?? {};
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, service: "resonantos-bridge" }),
    };
  };

  const bootstrap = initCapabilityTokens({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken,
    capabilityBootstrapToken,
    fetchImpl,
  });
  const client = createBridgeClient({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken,
    bridgeCapabilityTokens: {},
    fetchImpl,
  });

  const request = client("/status", { method: "GET" });
  resolveBootstrapFetch();
  await Promise.all([bootstrap, request]);

  assert.equal(
    statusHeaders?.["X-ResonantOS-Bridge-Capability-Token"],
    capabilityToken,
  );
});

test("bridge client does not wait when no capability bootstrap is in flight", async () => {
  const bridgeClientModule = await import("../resonantos-side-panel-extension/src/lib/bridge-client.js");
  assert.equal(typeof bridgeClientModule.__resetCapabilityTokensForTests, "function");
  bridgeClientModule.__resetCapabilityTokensForTests();

  let requestCount = 0;
  let statusHeaders = null;
  const client = createBridgeClient({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken: "general-test-token",
    bridgeCapabilityTokens: {},
    fetchImpl: async (_url, options = {}) => {
      requestCount += 1;
      statusHeaders = options.headers ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, service: "resonantos-bridge" }),
      };
    },
  });

  await client("/status", { method: "GET" });

  assert.equal(requestCount, 1);
  assert.equal(statusHeaders?.["X-ResonantOS-Bridge-Capability-Token"], undefined);
});

test("bridge client reports unreachable bridge fetches with settings guidance", async () => {
  const client = createBridgeClient({
    bridgeUrl: "http://127.0.0.1:47773",
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });

  await assert.rejects(
    () => client("/addons/status", { method: "GET" }),
    /Bridge is unreachable for \/addons\/status: Failed to fetch.*Settings > Bridge Target/,
  );
});

test("bridge client marks 401 token mismatch errors as bridge authorization failures", async () => {
  const client = createBridgeClient({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken: "stale-token",
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: "Unauthorized browser-first bridge request." }),
    }),
  });

  await assert.rejects(
    () => client("/status", { method: "GET" }),
    (error) => {
      assert.equal(isUnauthorizedBridgeError(error), true);
      assert.equal(error.bridgeStatus, 401);
      return true;
    },
  );
});

test("bridge config resolver can refresh a generated config resource without eval", async () => {
  const previousBridgeConfig = globalThis.__RESONANTOS_BRIDGE_CONFIG__;
  globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken: "stale-token",
    capabilityBootstrapToken: "stale-bootstrap",
  });
  const script = 'globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze({"bridgeUrl":"http://127.0.0.1:47773","bridgeToken":"fresh-token","capabilityBootstrapToken":"fresh-bootstrap"});\n';
  try {
    const cfg = await resolveBridgeConfig({
      refreshGenerated: true,
      now: 12345,
      resourceUrl: "chrome-extension://test/src/bridge-config.generated.js",
      fetchImpl: async (url, options = {}) => {
        assert.equal(new URL(url).searchParams.get("resonantosConfigReload"), "12345");
        assert.equal(options.cache, "no-store");
        return new Response(script, {
          status: 200,
          headers: { "Content-Type": "application/javascript" },
        });
      },
    });

    assert.equal(cfg.bridgeToken, "fresh-token");
    assert.equal(cfg.capabilityBootstrapToken, "fresh-bootstrap");
    assert.equal(cfg.source, "generated:refreshed");
    assert.equal(globalThis.__RESONANTOS_BRIDGE_CONFIG__.bridgeToken, "fresh-token");
  } finally {
    if (previousBridgeConfig === undefined) {
      delete globalThis.__RESONANTOS_BRIDGE_CONFIG__;
    } else {
      globalThis.__RESONANTOS_BRIDGE_CONFIG__ = previousBridgeConfig;
    }
  }
});

test("bridge config resolver lets tokenless overrides inherit generated credentials", async () => {
  const previousBridgeConfig = globalThis.__RESONANTOS_BRIDGE_CONFIG__;
  const previousChrome = globalThis.chrome;
  globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken: "generated-token",
    capabilityBootstrapToken: "generated-bootstrap",
    bridgeCapabilityTokens: { "addon-runtime-read": "runtime-token" },
  });
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          bridgeTargetOverride: {
            bridgeUrl: "http://127.0.0.1:48773",
            bridgeToken: "",
            capabilityBootstrapToken: "",
          },
        }),
      },
    },
  };

  try {
    const cfg = await resolveBridgeConfig();
    assert.equal(cfg.source, "override");
    assert.equal(cfg.bridgeUrl, "http://127.0.0.1:48773");
    assert.equal(cfg.bridgeToken, "generated-token");
    assert.equal(cfg.capabilityBootstrapToken, "generated-bootstrap");
    assert.equal(cfg.bridgeCapabilityTokens["addon-runtime-read"], "runtime-token");
  } finally {
    if (previousBridgeConfig === undefined) {
      delete globalThis.__RESONANTOS_BRIDGE_CONFIG__;
    } else {
      globalThis.__RESONANTOS_BRIDGE_CONFIG__ = previousBridgeConfig;
    }
    if (previousChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
  }
});

test("raw bridge fetch reports unreachable proxy fetches with settings guidance", async () => {
  const rawFetch = createRawBridgeFetch({
    bridgeUrl: "http://127.0.0.1:47773",
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });

  await assert.rejects(
    () => rawFetch("/hermes-dashboard/", { method: "GET" }),
    /Bridge is unreachable for \/hermes-dashboard\/: Failed to fetch.*Settings > Bridge Target/,
  );
});

test("bridge fetch helpers preserve AbortError cancellation", async () => {
  const abortError = new Error("The operation was aborted.");
  abortError.name = "AbortError";
  const fetchImpl = async () => {
    throw abortError;
  };
  const client = createBridgeClient({
    bridgeUrl: "http://127.0.0.1:47773",
    fetchImpl,
  });
  const rawFetch = createRawBridgeFetch({
    bridgeUrl: "http://127.0.0.1:47773",
    fetchImpl,
  });
  const isSameAbort = (error) => error === abortError;

  await assert.rejects(() => client("/addons/status", { method: "GET" }), isSameAbort);
  await assert.rejects(() => rawFetch("/hermes-dashboard/", { method: "GET" }), isSameAbort);
});

test("capability-token bootstrap stays quiet when the bridge is unreachable", async () => {
  await initCapabilityTokens({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken: "general-test-token",
    capabilityBootstrapToken: "bootstrap-test-token",
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
});

test("bridge capability-token bootstrap is scoped and separate from the bridge token", async (t) => {
  const bridgeToken = "general-test-token";
  const capabilityBootstrapToken = "bootstrap-token";
  const credentialToken = "credential-write-test-token";
  const routingToken = "routing-write-test-token";
  let server;
  try {
    server = await startBridgeServer({
      port: 0,
      bridgeToken,
      capabilityBootstrapToken,
      bridgeCapabilityTokens: {
        "provider-credential-write": credentialToken,
        "provider-routing-write": routingToken,
      },
      extensionOrigin: "chrome-extension://test",
      routes: [{ method: "GET", path: "/public", handler: async () => ({ public: true }) }],
    });
  } catch (error) {
    if (error?.code === "EPERM" && error?.address === "127.0.0.1") {
      t.skip("localhost bind is denied in this sandbox; bridge bootstrap behavior must be verified outside sandboxed CI.");
      return;
    }
    throw error;
  }
  const address = server.address();
  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  try {
    const oldGet = await fetch(`${bridgeUrl}/api/capability-tokens`, {
      headers: { "X-ResonantOS-Bridge-Token": bridgeToken },
    });
    assert.equal(oldGet.status, 404);

    const noBootstrap = await fetch(`${bridgeUrl}/api/capability-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ResonantOS-Bridge-Token": bridgeToken,
      },
      body: JSON.stringify({ capabilities: ["provider-credential-write"] }),
    });
    assert.equal(noBootstrap.status, 403);

    const scoped = await fetch(`${bridgeUrl}/api/capability-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ResonantOS-Bridge-Token": bridgeToken,
        "X-ResonantOS-Capability-Bootstrap-Token": capabilityBootstrapToken,
      },
      body: JSON.stringify({ capabilities: ["provider-credential-write"] }),
    });
    assert.equal(scoped.status, 200);
    const payload = await scoped.json();
    assert.deepEqual(payload.capabilityTokens, { "provider-credential-write": credentialToken });
    assert.equal(payload.capabilityTokens["provider-routing-write"], undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("bridge privileged routes require a route-scoped capability token", async (t) => {
  const bridgeToken = "general-test-token";
  const capabilityToken = "credential-write-test-token";
  const diagnosticsToken = "diagnostics-read-test-token";
  let server;
  try {
    server = await startBridgeServer({
      port: 0,
      bridgeToken,
      bridgeCapabilityTokens: {
        "bridge-diagnostics-read": diagnosticsToken,
        "provider-credential-write": capabilityToken,
      },
      extensionOrigin: "chrome-extension://test",
      routes: [
        {
          method: "GET",
          path: "/status",
          requiredCapability: "bridge-diagnostics-read",
          handler: async () => ({ service: "resonantos-bridge" }),
        },
        {
          method: "POST",
          path: "/providers/credentials",
          requiredCapability: "provider-credential-write",
          handler: async () => ({ saved: true }),
        },
      ],
    });
  } catch (error) {
    if (error?.code === "EPERM" && error?.address === "127.0.0.1") {
      t.skip("localhost bind is denied in this sandbox; bridge capability behavior must be verified outside sandboxed CI.");
      return;
    }
    throw error;
  }
  const address = server.address();
  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  const client = createBridgeClient({
    bridgeUrl,
    bridgeToken,
    bridgeCapabilityTokens: {
      "bridge-diagnostics-read": diagnosticsToken,
      "provider-credential-write": capabilityToken,
    },
  });
  const clientWithoutCapability = createBridgeClient({
    bridgeUrl,
    bridgeToken,
    bridgeCapabilityTokens: {},
  });

  try {
    assert.equal((await client("/status", { method: "GET" })).service, "resonantos-bridge");

    await assert.rejects(
      () => clientWithoutCapability("/providers/credentials", {
        method: "POST",
        body: { providerId: "shared-minimax", credential: "minimax-test-credential" },
      }),
      /requires provider-credential-write capability/,
    );

    const wrongCapability = await fetch(`${bridgeUrl}/providers/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ResonantOS-Bridge-Token": bridgeToken,
        "X-ResonantOS-Bridge-Capability-Token": "wrong-token",
      },
      body: JSON.stringify({ providerId: "shared-minimax", credential: "minimax-test-credential" }),
    });
    assert.equal(wrongCapability.status, 403);

    const saved = await client("/providers/credentials", {
      method: "POST",
      body: { providerId: "shared-minimax", credential: "minimax-test-credential" },
    });
    assert.equal(saved.saved, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("bridge client uses runtime-scoped capability tokens after bootstrap", async () => {
  const bridgeToken = "runtime-general-test-token";
  const capabilityBootstrapToken = "runtime-bootstrap-test-token";
  const capabilityToken = "runtime-credential-write-token";
  const routes = [
    {
      method: "POST",
      path: "/providers/credentials",
      requiredCapability: "provider-credential-write",
      handler: async () => ({ saved: true }),
    },
  ];
  const fetchImpl = async (url, options = {}) => {
    const result = await evaluateBridgeRequestForSelfTest({
      method: options.method,
      url: new URL(url).pathname,
      headers: options.headers,
      body: options.body ? JSON.parse(options.body) : {},
      bridgeToken,
      capabilityBootstrapToken,
      bridgeCapabilityTokens: { "provider-credential-write": capabilityToken },
      routes: [
        {
          method: "POST",
          path: "/api/capability-tokens",
          requiredCapabilityBootstrap: true,
          handler: async (payload) => ({
            capabilityTokens: Object.fromEntries(
              (payload.capabilities ?? [])
                .filter((capability) => capability === "provider-credential-write")
                .map((capability) => [capability, capabilityToken]),
            ),
          }),
        },
        ...routes,
      ],
    });
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.payload,
    };
  };

  await initCapabilityTokens({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken,
    capabilityBootstrapToken,
    fetchImpl,
  });
  const client = createBridgeClient({
    bridgeUrl: "http://127.0.0.1:47773",
    bridgeToken,
    bridgeCapabilityTokens: {},
    fetchImpl,
  });
  const saved = await client("/providers/credentials", {
    method: "POST",
    body: { providerId: "shared-minimax", credential: "minimax-test-credential" },
  });
  assert.equal(saved.saved, true);
});

test("runBridgeAuthSelfTest proves token auth and default-deny on a real socket", async () => {
  const { runBridgeAuthSelfTest } = await import("../host/bridge-server.mjs");
  const result = await runBridgeAuthSelfTest({
    port: 0,
    bridgeToken: "self-test-bridge-token",
    extensionOrigin: "chrome-extension://test",
  });
  assert.equal(result.unauthorizedStatus, 401);
  assert.equal(result.wrongTokenStatus, 401);
  assert.equal(result.missingCapabilityStatus, 403, "a valid bridge token without the capability header must be refused");
  assert.equal(result.authorizedStatus, 200);
  assert.equal(result.ok, true);
});

test("bridge auth self-test summary only reports ok when default-deny held", () => {
  const healthy = summarizeBridgeAuthSelfTest({ unauthorizedStatus: 401, wrongTokenStatus: 401, missingCapabilityStatus: 403, authorizedStatus: 200 });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.bridgeTokenOnlyStatus, 403, "the in-process self-test's field name is mirrored for operators");
  const denyRegressed = summarizeBridgeAuthSelfTest({ unauthorizedStatus: 401, wrongTokenStatus: 401, missingCapabilityStatus: 200, authorizedStatus: 200 });
  assert.equal(denyRegressed.ok, false, "a bridge-token-only 200 means an undeclared or unguarded route was served; the self-test must fail");
  const tokenRegressed = summarizeBridgeAuthSelfTest({ unauthorizedStatus: 200, wrongTokenStatus: 401, missingCapabilityStatus: 403, authorizedStatus: 200 });
  assert.equal(tokenRegressed.ok, false);
});

test("raw caller-id header for a known caller cannot be paired with a foreign caller's token", async () => {
  const bridgeToken = "spoof-auth-token";
  const perCallerGrants = {
    "alpha-caller": { "provider-credential-write": "alpha-grant-token" },
    "beta-caller": { "provider-credential-write": "beta-grant-token" },
  };
  const result = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": "beta-grant-token",
      "X-ResonantOS-Bridge-Caller-Id": "alpha-caller",
    },
    body: { providerId: "shared-minimax" },
    bridgeToken,
    bridgeCapabilityTokens: {},
    perCallerGrants,
    routes: [
      {
        method: "POST",
        path: "/providers/credentials",
        requiredCapability: "provider-credential-write",
        handler: async () => ({ saved: true }),
      },
    ],
  });
  assert.equal(result.status, 403, "a caller-id header must not re-bind a foreign token to another caller");
});

test("raw caller-id header for an unknown caller cannot spoof audit attribution", async () => {
  const bridgeToken = "spoof-audit-token";
  const staticToken = "spoof-static-token";
  const perCallerGrants = {
    "alpha-caller": { "provider-credential-write": "alpha-grant-token" },
  };
  const records = [];
  const result = await evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/providers/credentials",
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": staticToken,
      "X-ResonantOS-Bridge-Caller-Id": "rogue-caller",
    },
    body: { providerId: "shared-minimax" },
    bridgeToken,
    bridgeCapabilityTokens: { "provider-credential-write": staticToken },
    perCallerGrants,
    auditSink: (record) => records.push(record),
    routes: [
      {
        method: "POST",
        path: "/providers/credentials",
        requiredCapability: "provider-credential-write",
        handler: async () => ({ saved: true }),
      },
    ],
  });
  assert.equal(result.status, 200, "a valid static capability token must authorize");
  assert.equal(records.length, 1);
  assert.equal(records[0].reason, "authorized");
  assert.equal(records[0].callerId, "__extension__", "an unverified caller-id header must not be written to the audit ledger");
});
