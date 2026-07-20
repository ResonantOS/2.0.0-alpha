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
