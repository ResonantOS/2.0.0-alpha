import assert from "node:assert/strict";
import test from "node:test";

import { detectLoopbackBridge } from "../resonantos-side-panel-extension/src/lib/bridge-client.js";

test("detectLoopbackBridge probes generated fallback loopback port before defaults", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "http://127.0.0.1:48773/status") {
      return new Response(JSON.stringify({ ok: true, service: "resonantos-bridge" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }
    throw new Error(`unexpected probe ${url}`);
  };

  const result = await detectLoopbackBridge(
    { bridgeToken: "token", bridgeUrl: "http://127.0.0.1:48773", source: "generated" },
    { fetchImpl },
  );

  assert.equal(result.bridgeUrl, "http://127.0.0.1:48773");
  assert.equal(result.source, "loopback:generated");
  assert.deepEqual(calls, ["http://127.0.0.1:48773/status"]);
});

test("detectLoopbackBridge accepts a capability-scoped 403 from /status as an authenticated bridge (#346)", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "http://127.0.0.1:48773/status") {
      return new Response(JSON.stringify({ ok: false, error: "Bridge route requires bridge-diagnostics-read capability." }), {
        headers: { "Content-Type": "application/json" },
        status: 403,
      });
    }
    throw new Error(`unexpected probe ${url}`);
  };

  const result = await detectLoopbackBridge(
    { bridgeToken: "token", bridgeUrl: "http://127.0.0.1:48773", source: "generated" },
    { fetchImpl },
  );

  assert.equal(result.bridgeUrl, "http://127.0.0.1:48773");
  assert.equal(result.source, "loopback:generated");
  assert.deepEqual(calls, ["http://127.0.0.1:48773/status"]);
});

test("detectLoopbackBridge still skips 401 (bridge token rejected) and IP-allowlist 403 candidates", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "http://127.0.0.1:48773/status") {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized browser-first bridge request." }), { status: 401 });
    }
    if (url === "http://localhost:47773/status") {
      return new Response(JSON.stringify({ ok: false, error: "Forbidden: client IP is not allowlisted." }), { status: 403 });
    }
    if (url === "http://bridge.lan:47773/status") {
      return new Response(JSON.stringify({ ok: true, service: "resonantos-bridge" }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };

  const result = await detectLoopbackBridge(
    { bridgeToken: "token", bridgeUrl: "http://bridge.lan:47773", source: "generated" },
    { fetchImpl },
  );

  assert.equal(result.bridgeUrl, "http://bridge.lan:47773", "falls through to the configured origin");
  assert.ok(calls.at(-1) === "http://bridge.lan:47773/status");
});

test("isCapabilityScopedBridgeReply recognizes only the capability-scoped 403 shape", async () => {
  const { isCapabilityScopedBridgeReply } = await import("../resonantos-side-panel-extension/src/lib/bridge-client.js");
  assert.equal(isCapabilityScopedBridgeReply(403, { ok: false, error: "Bridge route requires memory-read capability." }), true);
  assert.equal(isCapabilityScopedBridgeReply(403, { ok: false, error: "Forbidden: client IP is not allowlisted." }), false);
  assert.equal(isCapabilityScopedBridgeReply(401, { ok: false, error: "Bridge route requires memory-read capability." }), false);
  assert.equal(isCapabilityScopedBridgeReply(200, { ok: true }), false);
  assert.equal(isCapabilityScopedBridgeReply(403, null), false);
});
