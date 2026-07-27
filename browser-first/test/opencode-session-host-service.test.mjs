import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpencodeSessionHandlers,
  createOpencodeSessionHostService
} from "../host/opencode-session-host-service.mjs";

test("the service exposes the session routes with runtime-control capability", () => {
  const noop = () => ({ ok: true });
  const { opencodeSessionRoutes } = createOpencodeSessionHostService({
    executeOpenCodeSessionStart: noop,
    executeOpenCodeSessionPrompt: noop,
    executeOpenCodeSessionPermission: noop,
    executeOpenCodeSessionStop: noop
  });
  assert.deepEqual(
    opencodeSessionRoutes.map((r) => `${r.method} ${r.path}`),
    ["POST /opencode/session/start", "POST /opencode/session/prompt", "POST /opencode/session/permission", "POST /opencode/session/stop"]
  );
  assert.ok(opencodeSessionRoutes.every((r) => r.requiredCapability === "addon-runtime-control"));
});

test("the service throws if a handler is missing", () => {
  assert.throws(() => createOpencodeSessionHostService({}), /missing handler/);
});

function fakeClient(calls) {
  return {
    createSession: async () => { calls.push(["create"]); return { id: "s1" }; },
    prompt: async (id, text, opts) => calls.push(["prompt", id, text, opts]),
    replyPermission: async (id, pid, decision) => calls.push(["reply", id, pid, decision]),
    eventUrl: () => "http://127.0.0.1:4096/event"
  };
}

test("start ensures the server once, creates a session, and returns its id + event url", async () => {
  const calls = [];
  let ensured = 0;
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => { ensured += 1; return { baseUrl: "http://127.0.0.1:4096" }; },
    createClient: () => fakeClient(calls)
  });

  const start = await handlers.executeOpenCodeSessionStart();
  assert.deepEqual(start, { ok: true, sessionId: "s1", eventUrl: "http://127.0.0.1:4096/event", baseUrl: "http://127.0.0.1:4096" });

  // A second call reuses the memoized client — server ensured only once.
  await handlers.executeOpenCodeSessionPrompt({ body: { sessionId: "s1", text: "go", agent: "build" } });
  assert.equal(ensured, 1);
  assert.deepEqual(calls.at(-1), ["prompt", "s1", "go", { agent: "build", model: undefined }]);
});

test("permission reply forwards the decision to the client", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({ baseUrl: "http://x" }),
    createClient: () => fakeClient(calls)
  });
  await handlers.executeOpenCodeSessionPermission({ body: { sessionId: "s1", permissionId: "p1", decision: { approved: true } } });
  assert.deepEqual(calls.at(-1), ["reply", "s1", "p1", { approved: true }]);
});

test("prompt and permission validate their inputs", async () => {
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({ baseUrl: "http://x" }),
    createClient: () => fakeClient([])
  });
  await assert.rejects(() => handlers.executeOpenCodeSessionPrompt({ body: { sessionId: "", text: "" } }), /requires sessionId and text/);
  await assert.rejects(() => handlers.executeOpenCodeSessionPermission({ body: { sessionId: "s1" } }), /requires sessionId and permissionId/);
});
