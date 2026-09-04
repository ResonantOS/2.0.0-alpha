import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenCodeWebUrlHandler,
  createOpencodeSessionHandlers,
  createOpencodeSessionHostService
} from "../host/opencode-session-host-service.mjs";

test("the service exposes the session routes with runtime-control capability", () => {
  const noop = () => ({ ok: true });
  const { opencodeSessionRoutes } = createOpencodeSessionHostService({
    executeOpenCodeSessionStart: noop,
    executeOpenCodeSessionPrompt: noop,
    executeOpenCodeSessionPermission: noop,
    executeOpenCodeSessionStop: noop,
    executeOpenCodeSessionsList: noop,
    executeOpenCodeSessionMessages: noop,
    executeOpenCodeSessionAbort: noop,
    executeOpenCodeSessionDiff: noop,
    executeOpenCodeSessionRename: noop,
    executeOpenCodeSessionDelete: noop,
    executeOpenCodeSessionArchive: noop,
    executeOpenCodeAgentsList: noop
  });
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
      "POST /opencode/agents/list"
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
});

test("the service throws if a handler is missing", () => {
  assert.throws(() => createOpencodeSessionHostService({}), /missing handler/);
});

function fakeClient(calls) {
  return {
    createSession: async () => { calls.push(["create"]); return { id: "s1" }; },
    prompt: async (id, text, opts) => calls.push(["prompt", id, text, opts]),
    replyPermission: async (id, pid, decision) => calls.push(["reply", id, pid, decision]),
    abort: async (id) => calls.push(["abort", id]),
    sessionDiff: async (id) => { calls.push(["diff", id]); return [{ path: "a.txt", hunks: [] }]; },
    rename: async (id, title) => { calls.push(["rename", id, title]); return { id, title }; },
    remove: async (id) => { calls.push(["delete", id]); return true; },
    archive: async (id, archived) => { calls.push(["archive", id, archived]); return { id, time: { archived } }; },
    listAgents: async () => { calls.push(["agents"]); return [{ name: "build" }]; },
    eventUrl: () => "http://127.0.0.1:4096/event"
  };
}

test("start ensures the server once, creates a session, and returns its id + event url", async () => {
  const calls = [];
  let ensured = 0;
  let clientOptions = null;
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => { ensured += 1; return { baseUrl: "http://127.0.0.1:4096", directory: "/repo/root" }; },
    createClient: (_baseUrl, options) => { clientOptions = options; return fakeClient(calls); }
  });

  const start = await handlers.executeOpenCodeSessionStart();
  assert.deepEqual(start, { ok: true, sessionId: "s1", eventUrl: "http://127.0.0.1:4096/event", baseUrl: "http://127.0.0.1:4096" });
  assert.deepEqual(clientOptions, { directory: "/repo/root" });

  // A second call reuses the memoized client — server ensured only once.
  await handlers.executeOpenCodeSessionPrompt({ body: { sessionId: "s1", text: "go", agent: "build" } });
  assert.equal(ensured, 1);
  assert.deepEqual(calls.at(-1), ["prompt", "s1", "go", { agent: "build", model: undefined }]);
});

test("start forwards the bridge-minted Authorization header to the client and returns eventAuthorization", async () => {
  const calls = [];
  let clientOptions = null;
  const authorization = "Basic b3BlbmNvZGU6cHc=";
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({
      baseUrl: "http://127.0.0.1:45123",
      directory: "/repo/root",
      auth: { username: "opencode", password: "pw", header: authorization }
    }),
    createClient: (_baseUrl, options) => {
      clientOptions = options;
      return fakeClient(calls);
    }
  });

  const start = await handlers.executeOpenCodeSessionStart();

  assert.equal(clientOptions?.headers?.Authorization, authorization);
  assert.equal(start.eventAuthorization, authorization);
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

test("abort, diff, rename, delete, archive, and agents list forward to the client", async () => {
  const calls = [];
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({ baseUrl: "http://x" }),
    createClient: () => fakeClient(calls)
  });

  assert.deepEqual(await handlers.executeOpenCodeSessionAbort({ body: { sessionId: "ses_1" } }), { ok: true });
  assert.deepEqual(await handlers.executeOpenCodeSessionDiff({ body: { sessionId: "ses_1" } }), { ok: true, diff: [{ path: "a.txt", hunks: [] }] });
  assert.deepEqual(await handlers.executeOpenCodeSessionRename({ body: { sessionId: "ses_1", title: "New title" } }), { ok: true, session: { id: "ses_1", title: "New title" } });
  assert.deepEqual(await handlers.executeOpenCodeSessionDelete({ body: { sessionId: "ses_1" } }), { ok: true, deleted: true });
  assert.deepEqual(await handlers.executeOpenCodeSessionArchive({ body: { sessionId: "ses_1", archived: 12345 } }), { ok: true, session: { id: "ses_1", time: { archived: 12345 } } });
  assert.deepEqual(await handlers.executeOpenCodeAgentsList(), { ok: true, agents: [{ name: "build" }] });

  assert.deepEqual(calls, [
    ["abort", "ses_1"],
    ["diff", "ses_1"],
    ["rename", "ses_1", "New title"],
    ["delete", "ses_1"],
    ["archive", "ses_1", 12345],
    ["agents"]
  ]);
});

test("new parity handlers validate required inputs", async () => {
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({ baseUrl: "http://x" }),
    createClient: () => fakeClient([])
  });
  await assert.rejects(() => handlers.executeOpenCodeSessionAbort({ body: {} }), /abort requires sessionId/);
  await assert.rejects(() => handlers.executeOpenCodeSessionDiff({ body: {} }), /diff requires sessionId/);
  await assert.rejects(() => handlers.executeOpenCodeSessionRename({ body: { sessionId: "ses_1", title: "" } }), /rename requires sessionId and title/);
  await assert.rejects(() => handlers.executeOpenCodeSessionDelete({ body: {} }), /delete requires sessionId/);
  await assert.rejects(() => handlers.executeOpenCodeSessionArchive({ body: {} }), /archive requires sessionId/);
});

test("sessions list returns normalized sessions plus server urls", async () => {
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({ baseUrl: "http://127.0.0.1:9999" }),
    createClient: () => ({
      listSessions: async () => [
        { id: "ses_1", title: "A", time: { created: 5, updated: 9 } },
        { sessionID: "", title: "dropped" }
      ],
      eventUrl: () => "http://127.0.0.1:9999/event"
    })
  });
  const result = await handlers.executeOpenCodeSessionsList();
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, "http://127.0.0.1:9999");
  assert.equal(result.eventUrl, "http://127.0.0.1:9999/event");
  assert.deepEqual(result.sessions, [{ id: "ses_1", title: "A", created: 5, updated: 9 }]);
});

test("sessions list returns eventAuthorization only when auth exists", async () => {
  const authorization = "Basic b3BlbmNvZGU6cHc=";
  const createListClient = () => ({
    listSessions: async () => [{ id: "ses_1", title: "A", time: { created: 5 } }],
    eventUrl: () => "http://127.0.0.1:45123/event"
  });
  const authedHandlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({
      baseUrl: "http://127.0.0.1:45123",
      directory: "/repo/root",
      auth: { username: "opencode", password: "pw", header: authorization }
    }),
    createClient: () => createListClient()
  });
  const unauthenticatedHandlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({ baseUrl: "http://127.0.0.1:45124", directory: "/repo/root" }),
    createClient: () => createListClient()
  });

  const authedList = await authedHandlers.executeOpenCodeSessionsList();
  const unauthenticatedList = await unauthenticatedHandlers.executeOpenCodeSessionsList();

  assert.equal("eventAuthorization" in authedList, true);
  assert.equal(authedList.eventAuthorization, authorization);
  assert.equal("eventAuthorization" in unauthenticatedList, false);
});

test("stop forgets the singleton entry", async () => {
  const calls = [];
  const forgotten = [];
  let ensured = 0;
  const serverInfo = { baseUrl: "http://127.0.0.1:45123", directory: "/repo/root" };
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => {
      ensured += 1;
      return serverInfo;
    },
    createClient: () => fakeClient(calls),
    forgetOpencodeServer: (info) => forgotten.push(info)
  });

  await handlers.executeOpenCodeSessionStart();
  await handlers.executeOpenCodeSessionStop();
  await handlers.executeOpenCodeSessionStart();

  assert.deepEqual(forgotten, [serverInfo]);
  assert.equal(ensured, 2);
});

test("the password never appears in any response JSON", async () => {
  const authorization = "Basic b3BlbmNvZGU6cHc=";
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({
      baseUrl: "http://127.0.0.1:45123",
      directory: "/repo/root",
      auth: { username: "opencode", password: "pw", header: authorization }
    }),
    createClient: () => ({
      createSession: async () => ({ id: "s1" }),
      listSessions: async () => [{ id: "s1", title: "A", time: { created: 5 } }],
      eventUrl: () => "http://127.0.0.1:45123/event"
    })
  });

  const start = await handlers.executeOpenCodeSessionStart();
  const list = await handlers.executeOpenCodeSessionsList();

  assert.equal(JSON.stringify(start).includes("pw"), false);
  assert.equal(JSON.stringify(list).includes("pw"), false);
});

test("session messages requires an id and passes history through", async () => {
  const handlers = createOpencodeSessionHandlers({
    ensureServer: async () => ({ baseUrl: "http://x" }),
    createClient: () => ({ messages: async (id) => [{ info: { id: "m1" }, forSession: id }] })
  });
  await assert.rejects(() => handlers.executeOpenCodeSessionMessages({ body: {} }), /requires sessionId/);
  const result = await handlers.executeOpenCodeSessionMessages({ body: { sessionId: "ses_9" } });
  assert.equal(result.ok, true);
  assert.equal(result.messages[0].forSession, "ses_9");
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
      assert.equal(error.code, "opencode_web_url_execution_disabled");
      assert.match(error.message, /explicit OpenCode execution/);
      return true;
    },
  );
  assert.equal(ensured, 0);
  assert.equal(audited, 0);
});

test("web url handler ensures serve, returns a 127.0.0.1 root url, and appends an intent audit entry", async () => {
  const audit = [];
  const executeOpenCodeWebUrl = createOpenCodeWebUrlHandler({
    executionEnabled: async () => true,
    ensureServer: async () => ({ baseUrl: "http://127.0.0.1:4231/session" }),
    appendAuditEntry: async (entry) => audit.push(entry),
  });

  const result = await executeOpenCodeWebUrl({ body: { enableOpenCodeExecution: true } });

  assert.deepEqual(result, { url: "http://127.0.0.1:4231/" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].addonId, "opencode");
  assert.equal(audit[0].event, "webCockpitUrlIssued");
  assert.equal(audit[0].url, "http://127.0.0.1:4231/");
  assert.doesNotThrow(() => new Date(audit[0].at).toISOString());
});
