import assert from "node:assert/strict";
import test from "node:test";

import { createOpenCodeBridgeSource, createSSEParser } from "../resonantos-side-panel-extension/src/lib/opencode-bridge-source.js";

const PUBLIC_ERROR = "OpenCode boundary request failed.";

function wait(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseHeaders(contentType = "text/event-stream") {
  return {
    get(name) {
      return String(name).toLowerCase() === "content-type" ? contentType : null;
    }
  };
}

function statusResponse(status, payload = {}) {
  return {
    ok: false,
    status,
    headers: { get: () => "application/json" },
    async json() {
      return payload;
    },
    clone() {
      return this;
    }
  };
}

function streamResponse(frames, { hang = true, contentType = "text/event-stream" } = {}) {
  const encoded = frames.map((frame) => (
    typeof frame === "string" ? new TextEncoder().encode(frame) : frame
  ));
  return {
    ok: true,
    status: 200,
    headers: sseHeaders(contentType),
    body: {
      getReader() {
        let index = 0;
        let release;
        const blocker = new Promise((resolve) => {
          release = resolve;
        });
        return {
          async read() {
            if (index < encoded.length) return { value: encoded[index++], done: false };
            if (!hang) return { value: undefined, done: true };
            await blocker;
            return { value: undefined, done: true };
          },
          cancel() {
            release?.();
          }
        };
      }
    }
  };
}

async function receivedError(buildSource) {
  let error;
  const source = buildSource((err) => {
    error = err;
  });
  source.subscribe(() => {});
  for (let i = 0; i < 40 && !error; i += 1) await wait(5);
  return error;
}

test("createSSEParser emits one JSON event per complete data frame", () => {
  const events = [];
  const feed = createSSEParser((e) => events.push(e));
  feed('data: {"type":"a","properties":{"x":1}}\n\n');
  feed('data: {"type":"b"}\n\n');
  assert.deepEqual(events, [{ type: "a", properties: { x: 1 } }, { type: "b" }]);
});

test("createSSEParser buffers frames split across chunk boundaries", () => {
  const events = [];
  const feed = createSSEParser((e) => events.push(e));
  feed('data: {"type":"spl');
  feed('it"}\n');
  feed("\n");
  assert.deepEqual(events, [{ type: "split" }]);
});

test("createSSEParser preserves a partial next frame that trails a completed one", () => {
  const events = [];
  const feed = createSSEParser((e) => events.push(e));
  feed('data: {"type":"a"}\n\ndata: {"type":"b"');
  feed("}\n\n");
  assert.deepEqual(events, [{ type: "a" }, { type: "b" }]);
});

test("createSSEParser ignores keepalive / non-JSON frames", () => {
  const events = [];
  const errors = [];
  const feed = createSSEParser((e) => events.push(e), (err) => errors.push(err));
  feed(": keepalive\n\n");
  feed("event: ping\n\n");
  feed('data: {"type":"ok"}\n\n');
  assert.deepEqual(events, [{ type: "ok" }]);
  assert.equal(errors.length, 0);
});

test("bridge source starts a session, streams its events, and posts prompts/permissions", async () => {
  const posts = [];
  const envelope = {
    version: 1,
    sessionId: "s1",
    source: "governed",
    event: { type: "file.edited", properties: { path: "a.ts", added: 1, removed: 0 } }
  };
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1" }),
    openEventStream: async () => streamResponse([`data: ${JSON.stringify(envelope)}\n\n`]),
    postJson: async (path, body) => posts.push([path, body])
  });

  const events = [];
  const stop = source.subscribe((e) => events.push(e));
  await wait();
  stop();

  assert.deepEqual(events, [envelope]);

  await source.sendPrompt("run tests");
  await source.replyPermission("p1", { approved: true });
  assert.deepEqual(posts, [
    ["/opencode/session/prompt", { sessionId: "s1", text: "run tests" }],
    ["/opencode/session/permission", { sessionId: "s1", permissionId: "p1", decision: { approved: true } }]
  ]);
});

test("bridge source passes model and agent selections through prompt bodies and exposes abort/diff", async () => {
  const posts = [];
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1" }),
    openEventStream: async () => streamResponse([]),
    postJson: async (path, body) => {
      posts.push([path, body]);
      if (path === "/opencode/session/diff") return { ok: true, diff: [{ path: "a.ts", patch: "+new" }] };
      return { ok: true };
    }
  });

  await source.start();
  await source.sendPrompt("ship it", { model: "openai/gpt-5.4-mini", agent: "plan" });
  await source.abort();
  const diff = await source.diff();

  assert.deepEqual(posts, [
    ["/opencode/session/prompt", { sessionId: "s1", text: "ship it", model: "openai/gpt-5.4-mini", agent: "plan" }],
    ["/opencode/session/abort", { sessionId: "s1" }],
    ["/opencode/session/diff", { sessionId: "s1" }]
  ]);
  assert.deepEqual(diff, [{ path: "a.ts", patch: "+new" }]);
});

const SSE_STATUS_CASES = [
  ["401", 401, "OPENCODE_BRIDGE_UNAUTHORIZED"],
  ["403", 403, "OPENCODE_CAPABILITY_REQUIRED"],
  ["404", 404, "OPENCODE_SESSION_UNKNOWN"],
  ["502", 502, "OPENCODE_UPSTREAM_FAILED"],
  ["503", 503, "OPENCODE_UNAVAILABLE"],
  ["504", 504, "OPENCODE_TIMEOUT"]
];

for (const [label, status, expected] of SSE_STATUS_CASES) {
  test(`SSE errors reach caller: ${label}`, async () => {
    const error = await receivedError((onError) => createOpenCodeBridgeSource({
      startSession: async () => ({ sessionId: "s1" }),
      openEventStream: async () => statusResponse(status),
      onError
    }));
    assert.equal(error?.code, expected);
  });
}

test("SSE errors reach caller: missing-body", async () => {
  const error = await receivedError((onError) => createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1" }),
    openEventStream: async () => ({
      ok: true,
      status: 200,
      headers: sseHeaders(),
      body: null
    }),
    onError
  }));
  assert.equal(error?.code, "OPENCODE_PROTOCOL_ERROR");
});

test("SSE errors reach caller: bad-frame", async () => {
  const error = await receivedError((onError) => createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1" }),
    openEventStream: async () => streamResponse(["data: { bad json \n\n"]),
    onError
  }));
  assert.equal(error?.code, "OPENCODE_PROTOCOL_ERROR");
});

test("SSE errors reach caller: EOF", async () => {
  const error = await receivedError((onError) => createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1" }),
    openEventStream: async () => streamResponse([], { hang: false }),
    onError
  }));
  assert.equal(error?.code, "OPENCODE_STREAM_DISCONNECTED");
});

test("missing session id is a typed source error", async () => {
  const error = await receivedError((onError) => createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "" }),
    openEventStream: async () => streamResponse([]),
    onError
  }));
  assert.equal(error?.code, "OPENCODE_SESSION_UNKNOWN");
});

test("unsubscribe aborts pending fetch", async () => {
  let abortedBeforeReader = false;
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1" }),
    openEventStream: async (_id, options = {}) => {
      options.signal.addEventListener("abort", () => {
        abortedBeforeReader = true;
      });
      return new Promise(() => {});
    }
  });
  const unsubscribe = source.subscribe(() => {});
  await wait();
  unsubscribe();
  await wait();
  assert.equal(abortedBeforeReader, true);
});

test("source rejects foreign or untagged envelope: foreign", async () => {
  let count = 0;
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1" }),
    openEventStream: async () => streamResponse([
      'data: {"version":1,"sessionId":"foreign","source":"governed","event":{"type":"ok"}}\n\n'
    ])
  });
  source.subscribe(() => {
    count += 1;
  });
  await wait();
  assert.equal(count, 0);
});

test("source rejects foreign or untagged envelope: untagged", async () => {
  let count = 0;
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1" }),
    openEventStream: async () => streamResponse([
      'data: {"sessionId":"s1","event":{"type":"ok"}}\n\n'
    ])
  });
  source.subscribe(() => {
    count += 1;
  });
  await wait();
  assert.equal(count, 0);
});

test("source callback retains full envelope", async () => {
  const envelope = {
    version: 1,
    sessionId: "s1",
    source: "external",
    event: { type: "text.delta", properties: { messageID: "m1", text: "hi" } }
  };
  let received;
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1" }),
    openEventStream: async () => streamResponse([`data: ${JSON.stringify(envelope)}\n\n`])
  });
  source.subscribe((value) => {
    received = value;
  });
  await wait();
  assert.deepEqual(received, envelope);
});
