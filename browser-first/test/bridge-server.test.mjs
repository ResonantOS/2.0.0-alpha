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
import { getBridgeAllowedOrigins, constantTimeEqual, evaluateBridgeRequestForSelfTest, startBridgeServer, summarizeBridgeAuthSelfTest } from "../host/bridge-server.mjs";

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

// C1: synchronous and serialized so no other case observes a changed environment.
test("bridge CORS defaults to no allowed origins", { concurrency: false }, () => {
  const previous = process.env.RESONANTOS_BRIDGE_ALLOWED_ORIGINS;
  try {
    delete process.env.RESONANTOS_BRIDGE_ALLOWED_ORIGINS;
    assert.deepEqual(getBridgeAllowedOrigins(), []);
  } finally {
    if (previous === undefined) delete process.env.RESONANTOS_BRIDGE_ALLOWED_ORIGINS;
    else process.env.RESONANTOS_BRIDGE_ALLOWED_ORIGINS = previous;
  }
});

for (const loopbackHostOnly of [false,true]) test(`Host transport guard opt-in: ${loopbackHostOnly}`,async()=>{
  const { randomBytes } = await import('node:crypto');
  const bridgeToken=randomBytes(32).toString('hex'), token=randomBytes(32).toString('hex');
  const result=await evaluateBridgeRequestForSelfTest({method:'POST',url:'/transport-fixture',headers:{host:'evil.example:12345','x-resonantos-bridge-token':bridgeToken,'x-resonantos-bridge-capability-token':token},rawHeaders:['Host','evil.example:12345'],listenerPort:12345,bridgeToken,bridgeCapabilityTokens:{read:token},routes:[{method:'POST',path:'/transport-fixture',requiredCapability:'read',loopbackHostOnly,handler:async()=>({})}]});
  assert.deepEqual([result.status,result.payload.code??null],loopbackHostOnly?[403,'OPENCODE_HOST_REJECTED']:[200,null]);
});

test('harness SSE uses sanitized harness terminal events', async t => {
  const { createHarnessEventBus } = await import('../host/harness-event-bus.mjs');
  const { createHarnessBoundary } = await import('../host/harness-boundary.mjs');
  const identity = { addonId: 'addon.test', sessionId: 'session', bootEpoch: 'boot', generation: 1 };
  const bus = createHarnessEventBus({ provenance: identity, isCurrent: () => true });
  // 1F translates the frozen harness iterator to the existing bridge transport seam.
  const module = await import('../host/harness-host-service.mjs').catch(() => ({}));
  assert.equal(typeof module.createHarnessStreamSubscription, 'function', 'harness stream composition must exist');
  let server;
  server = await startBridgeServer({ port: 0, host: '127.0.0.1', bridgeToken: 'bridge',
    bridgeCapabilityTokens: { 'addon-runtime-read': 'read' }, extensionOrigin: 'chrome-extension://test',
    routes: [{ method: 'GET', path: '/agent/events', loopbackHostOnly: true, errorFamily: 'harness', terminalEventFamily: 'harness', requiredCapability: 'addon-runtime-read', responseType: 'sse',
      handler: () => module.createHarnessStreamSubscription(bus.subscribe()) }],
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/agent/events?sessionId=session`, { headers: { 'X-ResonantOS-Bridge-Token': 'bridge', 'X-ResonantOS-Bridge-Capability-Token': 'read' } });
  bus.publish({ turnId: 'turn', type: 'delta', data: { text: 'partial' } });
  bus.close('ownership-conflict');
  const text = await response.text();
  assert.match(text, /event: harness.close/);
  assert.match(text, /"code":"ownership-conflict"/);
  assert.doesNotMatch(text, /opencode|OPENCODE/);

  const auth = { addonId: 'addon.test', slot: 'primary-agent', bootEpoch: 'boot', generation: 1, runtime: { supportedOperations: ['createSession', 'invoke'] } };
  const boundary = createHarnessBoundary({ registry: { authorize: () => auth, isCurrent: () => true, onFence: () => () => {} },
    resolveAdapter: () => ({ createSession: async () => ({}), dispose: async () => {}, invoke: async function* () { throw Object.assign(new Error('upstream-private-canary'), { code: 'invalid-event', credential: 'upstream-private-canary' }); } }) });
  t.after(() => boundary.close());
  const session = await boundary.createSession({ addonId: auth.addonId });
  const stream = module.createHarnessStreamSubscription(boundary.events(session));
  // A second actual HTTP stream exercises the upstream error path.
  const second = await startBridgeServer({ port: 0, host: '127.0.0.1', bridgeToken: 'bridge', bridgeCapabilityTokens: { 'addon-runtime-read': 'read' },
    routes: [{ method: 'GET', path: '/agent/events', loopbackHostOnly: true, errorFamily: 'harness', terminalEventFamily: 'harness', requiredCapability: 'addon-runtime-read', responseType: 'sse', handler: () => stream }] });
  t.after(() => new Promise(resolve => second.close(resolve)));
  const reply = await fetch(`http://127.0.0.1:${second.address().port}/agent/events?sessionId=${session.sessionId}`, { headers: { 'X-ResonantOS-Bridge-Token': 'bridge', 'X-ResonantOS-Bridge-Capability-Token': 'read' } });
  await boundary.invoke(session, { messages: [] }).completion;
  const errorText = await reply.text();
  assert.match(errorText, /"code":"invalid-event"/);
  assert.match(errorText, /event: harness.close/);
  assert.doesNotMatch(errorText, /upstream-private-canary|opencode|OPENCODE|credential/);
});

test('harness HTTP rejects origin, malformed and oversized bodies before side effects', async t => {
  let calls = 0;
  const routes = [{ method: 'POST', path: '/agent/session', loopbackHostOnly: true, errorFamily: 'harness', requiredCapability: 'addon-runtime-control', handler: () => { calls++; return {}; } }];
  const server = await startBridgeServer({ port: 0, host: '127.0.0.1', bridgeToken: 'bridge', bridgeCapabilityTokens: { 'addon-runtime-control': 'control' }, extensionOrigin: 'chrome-extension://test', routes });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/agent/session`;
  const headers = { 'X-ResonantOS-Bridge-Token': 'bridge', 'X-ResonantOS-Bridge-Capability-Token': 'control', 'Content-Type': 'application/json' };
  for (const [body, extra, status, code] of [['{', {}, 400, 'invalid-event'], ['"' + 'x'.repeat(1048576) + '"', {}, 400, 'invalid-event'], ['{}', { Origin: 'https://evil.test' }, 403, 'permission-denied']]) {
    const result = await fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body });
    assert.equal(result.status, status);
    assert.equal((await result.json()).code, code);
  }
  assert.equal(calls, 0);
  const allowed = await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'chrome-extension://test' }, body: '{}' });
  assert.equal(allowed.status, 200);
  assert.equal(calls, 1);
});

test('host-selected harness serializer closes safely and preserves exact OpenCode default bytes', async () => {
  const { Writable } = await import('node:stream');
  const { writeBridgeEventStream } = await import('../host/bridge-server.mjs');
  const { createHarnessStreamSubscription } = await import('../host/harness-host-service.mjs');
  for (const family of ['harness', undefined]) {
    let text = '';
    const response = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
    response.writeHead = () => { response.headersSent = true; };
    response.flushHeaders = () => {};
    const reader = (async function* () { yield { type: 'error', data: { code: 'ownership-conflict', message: 'private-upstream-canary', token: 'private-upstream-canary' } }; })();
    const sub = createHarnessStreamSubscription(reader);
    if (family === undefined) await sub.close('runtime-unavailable');
    await writeBridgeEventStream(response, { url: '/agent/events?sessionId=session', headers: {} }, sub, { terminalEventFamily: family });
    if (family === 'harness') {
      assert.match(text, /event: harness.close/);
      assert.match(text, /"code":"ownership-conflict"/);
      assert.doesNotMatch(text, /private-upstream-canary|token|OPENCODE|opencode/);
    } else {
      assert.equal(text, 'event: opencode.close\ndata: {"version":1,"sessionId":"session","source":"governed","event":{"type":"bridge.closed","properties":{"code":"OPENCODE_INTERNAL","error":"OpenCode boundary request failed."}}}\n\n');
    }
  }
});

test('harness origin denial and malformed HTTP bodies are side-effect free without sockets', async () => {
  const { Writable, Readable } = await import('node:stream');
  const { createBridgeRequestHandler } = await import('../host/bridge-server.mjs');
  let calls = 0;
  const handler = createBridgeRequestHandler({ bridgeToken: 'bridge', bridgeCapabilityTokens: { 'addon-runtime-control': 'control' }, extensionOrigin: 'chrome-extension://test',
    routes: [{ method: 'POST', path: '/agent/session', loopbackHostOnly: true, errorFamily: 'harness', requiredCapability: 'addon-runtime-control', handler: () => { calls++; return {}; } }] });
  for (const [body, origin, expectedStatus, code] of [['{', undefined, 400, 'invalid-event'], ['"' + 'x'.repeat(1048576) + '"', undefined, 400, 'invalid-event'], ['{}', 'https://evil.test', 403, 'permission-denied'], ['{}', 'chrome-extension://test', 200, undefined]]) {
    const request = Readable.from([body]);
    Object.assign(request, { method: 'POST', url: '/agent/session', socket: { localPort: 47773 }, rawHeaders: ['Host', '127.0.0.1:47773'], headers: { host: '127.0.0.1:47773', origin, 'x-resonantos-bridge-token': 'bridge', 'x-resonantos-bridge-capability-token': 'control' } });
    let text = '', status;
    const response = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
    response.writeHead = value => { status = value; response.headersSent = true; };
    await handler(request, response);
    assert.equal(status, expectedStatus);
    assert.equal(JSON.parse(text).code, code);
  }
  assert.equal(calls, 1);
});

test('harness GET bodies are rejected before registry or stream side effects', async () => {
  const { Writable, Readable } = await import('node:stream');
  const { createBridgeRequestHandler } = await import('../host/bridge-server.mjs');
  let calls = 0;
  const handler = createBridgeRequestHandler({ bridgeToken: 'bridge', bridgeCapabilityTokens: { 'addon-runtime-read': 'read' },
    routes: ['/addons/registry', '/agent/events'].map(path => ({ method: 'GET', path, loopbackHostOnly: true, errorFamily: 'harness', requiredCapability: 'addon-runtime-read', handler: () => { calls++; return {}; } })) });
  for (const url of ['/addons/registry', '/agent/events']) {
    for (const framing of [{ 'content-length': '2' }, { 'transfer-encoding': 'chunked' }]) {
      const request = Readable.from(['{}']);
      Object.assign(request, { method: 'GET', url, socket: { localPort: 47773 }, rawHeaders: ['Host', '127.0.0.1:47773'], headers: { ...framing, host: '127.0.0.1:47773', 'x-resonantos-bridge-token': 'bridge', 'x-resonantos-bridge-capability-token': 'read' } });
      let status, text = '';
      const response = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
      response.writeHead = value => { status = value; };
      await handler(request, response);
      assert.equal(status, 400, `${url} must refuse GET bodies`);
      assert.equal(JSON.parse(text).code, 'invalid-event');
    }
  }
  assert.equal(calls, 0);
});
