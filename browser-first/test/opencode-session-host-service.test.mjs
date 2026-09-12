import assert from "node:assert/strict";
import test from "node:test";

import { OpenCodeBoundaryError } from "../host/opencode-boundary.mjs";
import {
  createOpenCodeWebUrlHandler,
  createOpencodeSessionHandlers,
  createOpencodeSessionHostService
} from "../host/opencode-session-host-service.mjs";

function fakeBoundary(calls = []) {
  return {
    run: async (operation, payload) => {
      calls.push(["run", operation, payload]);
      if (operation === "start") return { ok: true, sessionId: "s1" };
      if (operation === "list") return { ok: true, sessions: [{ id: "ses_1", title: "A", created: 5, updated: 9 }] };
      if (operation === "messages") {
        return { ok: true, sessionId: payload.sessionId, messages: [{ info: { id: "m1" }, parts: [], source: "external" }] };
      }
      if (operation === "diff") {
        return { ok: true, sessionId: payload.sessionId, diff: [{ path: "a.txt", hunks: [], source: "external" }] };
      }
      if (operation === "rename") return { ok: true, session: { id: payload.sessionId, title: payload.title } };
      if (operation === "delete") return { ok: true, deleted: true };
      if (operation === "archive") return { ok: true, session: { id: payload.sessionId, created: 0, updated: payload.archived } };
      if (operation === "agents") return { ok: true, agents: [{ name: "build" }] };
      if (operation === "web") return { url: "", requiresCredential: true };
      return { ok: true };
    },
    validateEvents: async (sessionId) => {
      calls.push(["validateEvents", sessionId]);
    },
    openEvents: async (sessionId) => {
      calls.push(["openEvents", sessionId]);
      return { sessionId, events: (async function* () {})(), close: async () => {}, closed: Promise.resolve(), terminalCode: null, queuedBytes: 0, attachTransport: () => () => {} };
    },
    revoke: async () => {},
    dispose: async () => {}
  };
}

const handlerNames = [
  "executeOpenCodeSessionStart",
  "executeOpenCodeSessionPrompt",
  "executeOpenCodeSessionPermission",
  "executeOpenCodeSessionStop",
  "executeOpenCodeSessionsList",
  "executeOpenCodeSessionMessages",
  "executeOpenCodeSessionAbort",
  "executeOpenCodeSessionDiff",
  "executeOpenCodeSessionRename",
  "executeOpenCodeSessionDelete",
  "executeOpenCodeSessionArchive",
  "executeOpenCodeAgentsList",
  "executeOpenCodeSessionEvents"
];

test("the service exposes the session routes with runtime-control capability", () => {
  const noop = () => ({ ok: true });
  const { opencodeSessionRoutes } = createOpencodeSessionHostService(Object.fromEntries(handlerNames.map((name) => [name, noop])));
  assert.deepEqual(
    opencodeSessionRoutes.map((r) => `${r.method} ${r.path}`),
    [
      "POST /opencode/session/start",
      "POST /opencode/session/prompt",
      "POST /opencode/session/permission",
      "POST /opencode/session/stop",
      "POST /opencode/sessions/list",
      "POST /opencode/session/messages",
      "POST /opencode/session/abort",
      "POST /opencode/session/diff",
      "POST /opencode/session/rename",
      "POST /opencode/session/delete",
      "POST /opencode/session/archive",
      "POST /opencode/agents/list",
      "GET /opencode/session/events"
    ]
  );
  const capabilities = new Map(opencodeSessionRoutes.map((r) => [`${r.method} ${r.path}`, r.requiredCapability]));
  assert.equal(capabilities.get("POST /opencode/session/start"), "addon-runtime-control");
  assert.equal(capabilities.get("POST /opencode/session/prompt"), "addon-runtime-control");
  assert.equal(capabilities.get("POST /opencode/session/permission"), "addon-runtime-control");
  assert.equal(capabilities.get("POST /opencode/session/stop"), "addon-runtime-control");
  assert.equal(capabilities.get("POST /opencode/session/abort"), "addon-runtime-control");
  assert.equal(capabilities.get("POST /opencode/session/rename"), "addon-runtime-control");
  assert.equal(capabilities.get("POST /opencode/session/delete"), "addon-runtime-control");
  assert.equal(capabilities.get("POST /opencode/session/archive"), "addon-runtime-control");
  assert.equal(capabilities.get("POST /opencode/sessions/list"), "addon-runtime-read");
  assert.equal(capabilities.get("POST /opencode/session/messages"), "addon-runtime-read");
  assert.equal(capabilities.get("POST /opencode/session/diff"), "addon-runtime-read");
  assert.equal(capabilities.get("POST /opencode/agents/list"), "addon-runtime-read");
  assert.equal(capabilities.get("GET /opencode/session/events"), "addon-runtime-read");
  const events = opencodeSessionRoutes.find((r) => r.path === "/opencode/session/events");
  assert.equal(events.responseType, "sse");
  assert.ok(opencodeSessionRoutes.every((r) => r.loopbackHostOnly === true));
});

test("the service throws if a handler is missing", () => {
  assert.throws(() => createOpencodeSessionHostService({}), /missing handler/);
});

test("start ensures the server once, creates a session, and returns its id + event url", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary(calls) });
  const start = await handlers.executeOpenCodeSessionStart();
  assert.deepEqual(start, { ok: true, sessionId: "s1" });
  await handlers.executeOpenCodeSessionPrompt({ body: { sessionId: "s1", text: "go", agent: "build" } });
  assert.deepEqual(calls[0], ["run", "start", {}]);
  assert.deepEqual(calls[1], ["run", "prompt", { sessionId: "s1", text: "go", agent: "build" }]);
});

test("start forwards the bridge-minted Authorization header to the client and returns eventAuthorization", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary(calls) });
  const start = await handlers.executeOpenCodeSessionStart();
  assert.equal("eventAuthorization" in start, false);
  assert.equal("baseUrl" in start, false);
  assert.equal("eventUrl" in start, false);
});

test("permission reply forwards the decision to the client", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary(calls) });
  await handlers.executeOpenCodeSessionPermission({ body: { sessionId: "s1", permissionId: "p1", decision: { approved: true } } });
  assert.deepEqual(calls.at(-1), ["run", "permission", { sessionId: "s1", permissionId: "p1", decision: { approved: true } }]);
});

test("prompt and permission validate their inputs", async () => {
  const handlers = createOpencodeSessionHandlers({
    boundary: {
      run: async () => { throw new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST"); },
      validateEvents: async () => {},
      openEvents: async () => ({})
    }
  });
  await assert.rejects(() => handlers.executeOpenCodeSessionPrompt({ body: { sessionId: "", text: "" } }), (error) => error.code === "OPENCODE_INVALID_REQUEST");
  await assert.rejects(() => handlers.executeOpenCodeSessionPermission({ body: { sessionId: "s1" } }), (error) => error.code === "OPENCODE_INVALID_REQUEST");
});

test("abort, diff, rename, delete, archive, and agents list forward to the client", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary(calls) });

  assert.deepEqual(await handlers.executeOpenCodeSessionAbort({ body: { sessionId: "ses_1" } }), { ok: true });
  assert.deepEqual(await handlers.executeOpenCodeSessionDiff({ body: { sessionId: "ses_1" } }), { ok: true, sessionId: "ses_1", diff: [{ path: "a.txt", hunks: [], source: "external" }] });
  assert.deepEqual(await handlers.executeOpenCodeSessionRename({ body: { sessionId: "ses_1", title: "New title" } }), { ok: true, session: { id: "ses_1", title: "New title" } });
  assert.deepEqual(await handlers.executeOpenCodeSessionDelete({ body: { sessionId: "ses_1" } }), { ok: true, deleted: true });
  assert.deepEqual(await handlers.executeOpenCodeSessionArchive({ body: { sessionId: "ses_1", archived: 12345 } }), { ok: true, session: { id: "ses_1", created: 0, updated: 12345 } });
  assert.deepEqual(await handlers.executeOpenCodeAgentsList(), { ok: true, agents: [{ name: "build" }] });

  assert.deepEqual(calls.map((entry) => entry[1]), ["abort", "diff", "rename", "delete", "archive", "agents"]);
});

test("new parity handlers validate required inputs", async () => {
  const handlers = createOpencodeSessionHandlers({
    boundary: {
      run: async () => { throw new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST"); },
      validateEvents: async () => {},
      openEvents: async () => ({})
    }
  });
  await assert.rejects(() => handlers.executeOpenCodeSessionAbort({ body: {} }), (error) => error.code === "OPENCODE_INVALID_REQUEST");
  await assert.rejects(() => handlers.executeOpenCodeSessionDiff({ body: {} }), (error) => error.code === "OPENCODE_INVALID_REQUEST");
  await assert.rejects(() => handlers.executeOpenCodeSessionRename({ body: { sessionId: "ses_1", title: "" } }), (error) => error.code === "OPENCODE_INVALID_REQUEST");
  await assert.rejects(() => handlers.executeOpenCodeSessionDelete({ body: {} }), (error) => error.code === "OPENCODE_INVALID_REQUEST");
  await assert.rejects(() => handlers.executeOpenCodeSessionArchive({ body: {} }), (error) => error.code === "OPENCODE_INVALID_REQUEST");
});

test("sessions list returns normalized sessions plus server urls", async () => {
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary() });
  const result = await handlers.executeOpenCodeSessionsList();
  assert.equal(result.ok, true);
  assert.equal("baseUrl" in result, false);
  assert.equal("eventUrl" in result, false);
  assert.deepEqual(result.sessions, [{ id: "ses_1", title: "A", created: 5, updated: 9 }]);
});

test("sessions list returns eventAuthorization only when auth exists", async () => {
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary() });
  const list = await handlers.executeOpenCodeSessionsList();
  assert.equal("eventAuthorization" in list, false);
});

test("stop forgets the singleton entry", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary(calls) });
  await handlers.executeOpenCodeSessionStart();
  await handlers.executeOpenCodeSessionStop();
  await handlers.executeOpenCodeSessionStart();
  assert.deepEqual(calls.map((entry) => entry[1]), ["start", "stop", "start"]);
});

test("the password never appears in any response JSON", async () => {
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary() });
  const start = await handlers.executeOpenCodeSessionStart();
  const list = await handlers.executeOpenCodeSessionsList();
  assert.equal(JSON.stringify(start).includes("pw"), false);
  assert.equal(JSON.stringify(list).includes("pw"), false);
});

test("session messages requires an id and passes history through", async () => {
  const handlers = createOpencodeSessionHandlers({
    boundary: {
      run: async (operation, payload) => {
        if (!payload?.sessionId) throw new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST");
        return { ok: true, sessionId: payload.sessionId, messages: [{ info: { id: "m1" }, parts: [], source: "external" }] };
      },
      validateEvents: async () => {},
      openEvents: async () => ({})
    }
  });
  await assert.rejects(() => handlers.executeOpenCodeSessionMessages({ body: {} }), (error) => error.code === "OPENCODE_INVALID_REQUEST");
  const result = await handlers.executeOpenCodeSessionMessages({ body: { sessionId: "ses_9" } });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "ses_9");
  assert.equal(result.messages[0].source, "external");
});

function loopbackRequest(url, { selfTest = false, host = "127.0.0.1:47773", listenerPort = 47773 } = {}) {
  return {
    url,
    selfTest,
    headers: { host },
    rawHeaders: ["Host", host],
    socket: { localPort: listenerPort },
    openCodeTransport: { listenerPort, getPublicPort: () => undefined }
  };
}

test("events requires one sessionId and ignores GET payload", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary(calls) });
  const subscription = await handlers.executeOpenCodeSessionEvents({ sessionId: "ignored" }, loopbackRequest("/opencode/session/events?sessionId=A"));
  assert.equal(subscription.sessionId, "A");
  assert.deepEqual(calls, [["validateEvents", "A"], ["openEvents", "A"]]);
});

for (const [kind, url] of [
  ["none", "/opencode/session/events"],
  ["empty", "/opencode/session/events?sessionId="],
  ["duplicate", "/opencode/session/events?sessionId=A&sessionId=B"],
  ["extra-url", "/opencode/session/events?sessionId=A&url=http://example.invalid"]
]) {
  test(`events requires one sessionId: ${kind}`, async () => {
    const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary() });
    await assert.rejects(
      () => handlers.executeOpenCodeSessionEvents({}, loopbackRequest(url)),
      (error) => error.code === "OPENCODE_INVALID_REQUEST"
    );
  });
}

test("events self-test never subscribes", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary(calls) });
  const result = await handlers.executeOpenCodeSessionEvents({}, loopbackRequest("/opencode/session/events?sessionId=A", { selfTest: true }));
  assert.deepEqual(result, { stream: true });
  assert.deepEqual(calls, [["validateEvents", "A"]]);
});

test("events Host mismatch is refused before subscribe", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({ boundary: fakeBoundary(calls) });
  await assert.rejects(
    () => handlers.executeOpenCodeSessionEvents({}, loopbackRequest("/opencode/session/events?sessionId=A", { host: "evil.example:47773" })),
    (error) => error.code === "OPENCODE_HOST_REJECTED"
  );
  assert.deepEqual(calls, []);
});

test("web url handler refuses before ensuring the OpenCode serve process when execution is disabled", async () => {
  let ensured = 0;
  let audited = 0;
  const executeOpenCodeWebUrl = createOpenCodeWebUrlHandler({
    executionEnabled: async () => false,
    ensureServer: async () => {
      ensured += 1;
      return { baseUrl: "http://127.0.0.1:4231" };
    },
    appendAuditEntry: async () => {
      audited += 1;
    }
  });

  await assert.rejects(
    () => executeOpenCodeWebUrl({ body: {} }),
    (error) => {
      assert.equal(error.code, "OPENCODE_EXECUTION_DISABLED");
      assert.equal(error.message, "OpenCode boundary request failed.");
      return true;
    },
  );
  assert.equal(ensured, 0);
  assert.equal(audited, 0);
});

test("web url handler ensures serve, returns a 127.0.0.1 root url, and appends an intent audit entry", async () => {
  const audit = [];
  let ensured = 0;
  const executeOpenCodeWebUrl = createOpenCodeWebUrlHandler({
    executionEnabled: async () => true,
    ensureServer: async () => {
      ensured += 1;
      return { baseUrl: "http://127.0.0.1:4231/session" };
    },
    appendAuditEntry: async (entry) => audit.push(entry),
  });

  const result = await executeOpenCodeWebUrl({ body: { enableOpenCodeExecution: true } });

  assert.deepEqual(result, { url: "", requiresCredential: true });
  assert.equal(ensured, 0);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].addonId, "opencode");
  assert.equal(audit[0].event, "webCockpitUrlIssued");
  assert.equal(audit[0].url, "");
  assert.doesNotThrow(() => new Date(audit[0].at).toISOString());
});

test("web url handler returns requiresCredential and never leaks the credential", async () => {
  const audit = [];
  const executeOpenCodeWebUrl = createOpenCodeWebUrlHandler({
    executionEnabled: async () => true,
    ensureServer: async () => ({
      baseUrl: "http://127.0.0.1:45123",
      auth: { username: "opencode", password: "s3cret", header: "Basic x" }
    }),
    appendAuditEntry: async (entry) => audit.push(entry),
  });

  const result = await executeOpenCodeWebUrl({ body: { enableOpenCodeExecution: true } });

  assert.deepEqual(result, { url: "", requiresCredential: true });
  assert.equal(JSON.stringify(audit).includes("s3cret"), false);
  assert.equal(JSON.stringify(audit).includes("Basic x"), false);
  assert.equal(audit[0].url, "");
});

test("web url handler peeks for a registered server and refuses without spawning when none is registered", async () => {
  let ensured = 0;
  const refuseAudit = [];
  const refuseHandler = createOpenCodeWebUrlHandler({
    executionEnabled: async () => true,
    ensureServer: async () => { ensured += 1; return { baseUrl: "http://127.0.0.1:4231" }; },
    appendAuditEntry: async (entry) => refuseAudit.push(entry),
    peekServer: async () => null
  });
  const refused = await refuseHandler({ body: { enableOpenCodeExecution: true } });
  assert.deepEqual(refused, { url: "", requiresCredential: true });
  assert.equal(ensured, 0);
  assert.equal(refuseAudit.length, 1);
  assert.equal(refuseAudit[0].event, "webCockpitUrlIssued");
  assert.equal(refuseAudit[0].url, "");

  const registeredAudit = [];
  const registeredHandler = createOpenCodeWebUrlHandler({
    executionEnabled: async () => true,
    ensureServer: async () => ({ baseUrl: "http://127.0.0.1:45123/session", auth: { username: "opencode", password: "s3cret", header: "Basic x" } }),
    appendAuditEntry: async (entry) => registeredAudit.push(entry),
    peekServer: async () => ({ baseUrl: "http://127.0.0.1:45123" })
  });
  const issued = await registeredHandler({ body: { enableOpenCodeExecution: true } });
  assert.deepEqual(issued, { url: "", requiresCredential: true });
  assert.equal(registeredAudit[0].url, "");
  assert.equal(JSON.stringify(registeredAudit).includes("s3cret"), false);
});
