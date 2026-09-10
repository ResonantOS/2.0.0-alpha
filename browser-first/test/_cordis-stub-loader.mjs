// Cordis stub loader for tests.
//
// The `examples/fixtures/cordis-stub.mjs` file is structured as a
// standalone script. For tests we want to: (a) start it on a random
// port, (b) get its URL back, (c) close it cleanly. This helper wraps
// that.
//
// We import the stub module's `cordisStubServer` export and have it
// `.listen(0)` for an ephemeral port. `cordis-stub.mjs` is a script
// that calls `server.listen(port, ...)` at module top-level; we
// re-implement the listener here so tests can control the port.

import http from "node:http";

export async function startCordisStub({ dir, port = 0, host = "127.0.0.1" } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (req.method === "GET" && url.pathname === "/health") {
      const payload = JSON.stringify({
        status: "ok",
        model: "stub-cordis-0.1.0-stub",
        endpoints: ["POST /api/v1/chat/completions"],
      });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += chunk;
      let body;
      try { body = JSON.parse(raw); } catch {
        const msg = JSON.stringify({ error: { message: "invalid JSON body" } });
        res.writeHead(400, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(msg) });
        res.end(msg);
        return;
      }
      const model = typeof body?.model === "string" ? body.model : "deepseek-chat";
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((m) => m?.role === "user");
      const echoed = lastUser?.content ?? "";
      const completion = {
        id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: `[stub] ${model}: ${echoed}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      const payload = JSON.stringify(completion);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    const msg = JSON.stringify({ error: { message: `not found: ${req.method} ${url.pathname}` } });
    res.writeHead(404, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(msg) });
    res.end(msg);
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => { server.off("listening", onListening); reject(err); };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    port: actualPort,
    host,
    get entrypoint() { return `http://${host}:${actualPort}`; },
    async close() {
      await new Promise((r) => server.close(() => r()));
    },
  };
}
