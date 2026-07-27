import assert from "node:assert/strict";
import test from "node:test";

import { createOpenCodeBridgeSource, createSSEParser } from "../resonantos-side-panel-extension/src/lib/opencode-bridge-source.js";

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
  // One complete frame + the start of the next, in the same chunk.
  feed('data: {"type":"a"}\n\ndata: {"type":"b"');
  feed("}\n\n");
  assert.deepEqual(events, [{ type: "a" }, { type: "b" }]);
});

test("createSSEParser ignores keepalive / non-JSON frames", () => {
  const events = [];
  const feed = createSSEParser((e) => events.push(e));
  feed(": keepalive\n\n");
  feed('data: not json\n\n');
  feed('data: {"type":"ok"}\n\n');
  assert.deepEqual(events, [{ type: "ok" }]);
});

test("bridge source starts a session, streams its events, and posts prompts/permissions", async () => {
  const posts = [];
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "s1", eventUrl: "http://127.0.0.1:4096/event" }),
    openEventStream: async () => ({
      body: {
        getReader() {
          const frames = [new TextEncoder().encode('data: {"type":"file.edited","properties":{"path":"a.ts","added":1,"removed":0}}\n\n')];
          let i = 0;
          return { read: async () => (i < frames.length ? { value: frames[i++], done: false } : { value: undefined, done: true }), cancel() {} };
        }
      }
    }),
    postJson: async (path, body) => posts.push([path, body])
  });

  const events = [];
  const stop = source.subscribe((e) => events.push(e));
  await new Promise((r) => setTimeout(r, 10)); // let the async reader drain
  stop();

  assert.deepEqual(events, [{ type: "file.edited", properties: { path: "a.ts", added: 1, removed: 0 } }]);

  await source.sendPrompt("run tests");
  await source.replyPermission("p1", { approved: true });
  assert.deepEqual(posts, [
    ["/opencode/session/prompt", { sessionId: "s1", text: "run tests" }],
    ["/opencode/session/permission", { sessionId: "s1", permissionId: "p1", decision: { approved: true } }]
  ]);
});
