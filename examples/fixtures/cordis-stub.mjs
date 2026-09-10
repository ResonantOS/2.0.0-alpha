// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#9-deepseek-harness-exemplar
//
// Minimal Cordis-kernel stub HTTP server.
//
// Real DeepSeek Harness runs in a Cordis kernel and exposes the OpenAI-
// compatible `/api/v1/chat/completions` endpoint at the addon's
// `service.entrypoint` (typically `http://127.0.0.1:3080`). The stub
// here implements just enough of that surface to let the bridge-side
// dispatcher round-trip end-to-end without requiring a real Cordis
// install or a real DEEPSEEK_API_KEY.
//
// Behavior:
//   - POST /api/v1/chat/completions with a body like
//       { "model": "deepseek-chat", "messages": [{ role, content }, ...] }
//     returns
//       { "id": "chatcmpl-<rand>",
//         "object": "chat.completion",
//         "model": "<echoed>",
//         "choices": [{ "index": 0,
//                       "message": { "role": "assistant",
//                                    "content": "<echoed last user msg>" },
//                       "finish_reason": "stop" }],
//         "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 } }
//   - GET  /health returns { status: "ok", model: "stub-cordis-<version>" }.
//
// This is a *stub*. It does not implement streaming, function calling,
// tool use, or any of the larger Cordis surface. Its sole purpose is to
// let the dispatcher work end-to-end so you can:
//
//   1. Validate the wire contract before installing real Cordis.
//   2. Run integration tests in CI without external dependencies.
//   3. Smoke-test the dispatcher by hand with `npm run
//      deepseek-harness:smoke` (see scripts/run-deepseek-smoke.mjs).
//
// Usage:
//   node examples/fixtures/cordis-stub.mjs [--port 3080]

import http from "node:http";

const args = process.argv.slice(2);
let port = 3080;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && i + 1 < args.length) {
    port = Number(args[i + 1]);
    i++;
  }
}

const STUB_VERSION = "0.1.0-stub";

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleChatCompletions(req, res, body) {
  const model = typeof body?.model === "string" ? body.model : "deepseek-chat";
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const echoed = lastUser?.content ?? "";
  const completion = {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `[cordis-stub ${STUB_VERSION}] echoed (${model}): ${echoed}`,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  jsonResponse(res, 200, completion);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/health") {
    jsonResponse(res, 200, {
      status: "ok",
      model: `stub-cordis-${STUB_VERSION}`,
      endpoints: ["POST /api/v1/chat/completions"],
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      jsonResponse(res, 400, { error: { message: "invalid JSON body" } });
      return;
    }
    handleChatCompletions(req, res, body);
    return;
  }
  jsonResponse(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
});

server.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`cordis-stub listening on http://127.0.0.1:${port}`);
});

const shutdown = (signal) => {
  // eslint-disable-next-line no-console
  console.log(`cordis-stub: ${signal} received, shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export { server as cordisStubServer };
