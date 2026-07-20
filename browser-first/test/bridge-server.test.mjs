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
import { evaluateBridgeRequestForSelfTest, startBridgeServer } from "../host/bridge-server.mjs";

test("bridge capability behavior is deterministic without localhost binding", async () => {
  const bridgeToken = "general-test-token";
  const capabilityToken = "credential-write-test-token";
  const routes = [
    { method: "GET", path: "/public", handler: async () => ({ public: true }) },
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
    headers: { "X-ResonantOS-Bridge-Token": bridgeToken },
    bridgeToken,
    bridgeCapabilityTokens: { "provider-credential-write": capabilityToken },
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
  let server;
  try {
    server = await startBridgeServer({
      port: 0,
      bridgeToken,
      bridgeCapabilityTokens: {
        "provider-credential-write": capabilityToken,
      },
      extensionOrigin: "chrome-extension://test",
      routes: [
        { method: "GET", path: "/public", handler: async () => ({ public: true }) },
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
      "provider-credential-write": capabilityToken,
    },
  });
  const clientWithoutCapability = createBridgeClient({
    bridgeUrl,
    bridgeToken,
    bridgeCapabilityTokens: {},
  });

  try {
    assert.equal((await client("/public", { method: "GET" })).public, true);

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
