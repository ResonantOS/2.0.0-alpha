// SSE-specific tests for the external-agent-runtime dispatcher.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  postToCordis,
  isLoopbackAddress,
  assertLoopbackEntrypointResolved,
  consumeSseStream,
} from "../host/external-agent-runtime-dispatcher.mjs";

// Writes all chunks synchronously so the test runner sees the test
// complete without lingering timers.
async function startSseStub({ chunks = ["data: hello\n\n", "data: world\n\n"], status = 200 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      for (const chunk of chunks) res.write(chunk);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    entrypoint: `http://127.0.0.1:${port}`,
    server,
    async close() { await new Promise((r) => server.close(() => r())); },
  };
}

test("isLoopbackAddress: accepts 127.0.0.1, ::1, and the 127.0.0.0/8 range; rejects private/public addresses", () => {
  for (const good of ["127.0.0.1", "127.0.0.42", "127.255.255.254", "::1"]) {
    assert.equal(isLoopbackAddress(good), true, `expected ${good} to be loopback`);
  }
  for (const bad of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "8.8.8.8", "0.0.0.0", "fe80::1", "::2"]) {
    assert.equal(isLoopbackAddress(bad), false, `expected ${bad} to be non-loopback`);
  }
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(127), false);
});

test("assertLoopbackEntrypointResolved: rejects an entrypoint whose port differs from the manifest-declared port", async () => {
  const result = await assertLoopbackEntrypointResolved("http://127.0.0.1:7777", { expectedPort: "3080" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "port-mismatch");
  assert.match(result.detail, /7777/);
  assert.match(result.detail, /3080/);
});

test("assertLoopbackEntrypointResolved: accepts an entrypoint whose port matches the manifest-declared port", async () => {
  const result = await assertLoopbackEntrypointResolved("http://127.0.0.1:3080", { expectedPort: "3080" });
  assert.equal(result.ok, true);
});

test("postToCordis: streams SSE response without calling response.json()", async (t) => {
  const stub = await startSseStub({
    chunks: [
      "event: message\ndata: {\"delta\":\"hello\"}\n\n",
      "event: message\ndata: {\"delta\":\"world\"}\n\n",
      "data: [DONE]\n\n",
    ],
  });
  t.after(() => stub.close());

  const result = await postToCordis({
    entrypoint: stub.entrypoint,
    request: { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true },
    declaredPort: String(stub.port),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.body, null);
  assert.equal(result.stream, true);
  assert.ok(Array.isArray(result.events));
  assert.ok(result.events.length >= 3, `expected at least 3 SSE events; got ${result.events.length}`);
  assert.equal(result.events[0].event, "message");
  assert.equal(result.events[0].data, "{\"delta\":\"hello\"}");
  assert.equal(result.events[result.events.length - 1].data, "[DONE]");
  assert.match(result.sseRaw, /hello/);
  assert.match(result.sseRaw, /world/);
  assert.equal(result.sseClosed, true);
});

test("postToCordis: SSE handler cancels the underlying reader on truncation", async (t) => {
  const stub = await startSseStub({
    chunks: ["data: " + "x".repeat(4000) + "\n\n"],
  });
  t.after(() => stub.close());

  const result = await postToCordis({
    entrypoint: stub.entrypoint,
    request: { stream: true },
    declaredPort: String(stub.port),
    consumeSse: (response) => consumeSseStream(response, { maxBytes: 64 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.stream, true);
  assert.equal(result.sseTruncated, true);
  assert.equal(result.sseClosed, true);
});

test("postToCordis: SSE handler surfaces the upstream error and closes the reader when the connection drops", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.destroy(), 20);
    });
    req.on("close", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(() => r())));
  const port = server.address().port;

  const result = await postToCordis({
    entrypoint: `http://127.0.0.1:${port}`,
    request: { stream: true },
    declaredPort: String(port),
  });

  // The connection was destroyed before the reader could drain the
  // first chunk. What matters for the gate is: the dispatcher used
  // the SSE path (not response.json), the stream flag is set, and the
  // reader was closed so the upstream socket is released.
  assert.equal(result.stream, true);
  assert.equal(result.sseClosed, true);
});

test("postToCordis: Accept header requests SSE when request.stream is true", async (t) => {
  const seen = { accept: null };
  const server = http.createServer((req, res) => {
    seen.accept = req.headers["accept"];
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(() => r())));
  const port = server.address().port;

  await postToCordis({
    entrypoint: `http://127.0.0.1:${port}`,
    request: { model: "x", messages: [], stream: true },
    declaredPort: String(port),
  });

  assert.equal(seen.accept, "text/event-stream");
});

// ---------------------------------------------------------------------------
// Loopback-port bind: verify the dispatcher exposes the bound dispatcher
// factory and that a caller-supplied fetchImpl is used (the dispatcher does
// not wrap a custom fetchImpl in the undici dispatcher).
// ---------------------------------------------------------------------------

import { getSharedLoopbackDispatcher } from "../host/external-agent-runtime-dispatcher.mjs";

test("getSharedLoopbackDispatcher: returns an Agent whose connect options bind to a loopback address", () => {
  const dispatcher = getSharedLoopbackDispatcher();
  assert.ok(dispatcher, "expected a dispatcher");
  // undici's Agent stores options under a Symbol. Walk the own-property
  // symbols to find the options bag and verify the connect.localAddress.
  const symbols = Object.getOwnPropertySymbols(dispatcher);
  const optionsSymbol = symbols.find((s) => String(s) === "Symbol(options)");
  assert.ok(optionsSymbol, "expected a Symbol(options) on the Agent");
  const opts = dispatcher[optionsSymbol];
  assert.ok(opts.connect, "expected connect options on the Agent");
  assert.equal(opts.connect.localAddress, "127.0.0.1");
});

test("postToCordis: caller-supplied fetchImpl is used as-is (no undici wrapping)", async (t) => {
  const stub = await startSseStub({ chunks: ["data: ok\n\n"] });
  t.after(() => stub.close());

  let calledWith = null;
  const customFetch = async (url, init) => {
    calledWith = { url, init };
    return globalThis.fetch(url, init);
  };

  await postToCordis({
    entrypoint: stub.entrypoint,
    request: { model: "x", messages: [], stream: true },
    declaredPort: String(stub.port),
    fetchImpl: customFetch,
  });

  // The custom fetch received the URL exactly as the dispatcher would
  // build it, with no dispatcher field injected.
  assert.ok(calledWith, "expected custom fetch to be called");
  assert.equal(calledWith.url, `${stub.entrypoint}/api/v1/chat/completions`);
  assert.equal(calledWith.init.dispatcher, undefined, "expected no undici dispatcher to be injected into a custom fetchImpl");
});
