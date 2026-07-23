import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createOpencodeSessionHandlers,
  createOpencodeSessionHostService,
} from "../host/opencode-session-host-service.mjs";

const PRIVATE_WORKSPACE = "/private/workspaces/resonantos";
const PUBLIC_WORKSPACE = "workspaces/resonantos";
const HOST_MODEL = "openai/gpt-5";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function createEventFeed() {
  const queued = [];
  const waiting = [];
  let ended = false;

  function settleNext(item) {
    const waiter = waiting.shift();
    if (waiter) {
      if (item.error) waiter.reject(item.error);
      else waiter.resolve(item.value);
      return;
    }
    queued.push(item);
  }

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        const item = queued.shift();
        if (item) {
          return item.error ? Promise.reject(item.error) : Promise.resolve(item.value);
        }
        if (ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => waiting.push({ reject, resolve }));
      },
      return() {
        ended = true;
        while (waiting.length) {
          waiting.shift().resolve({ done: true, value: undefined });
        }
        return Promise.resolve({ done: true, value: undefined });
      },
    },
    end() {
      if (ended) return;
      ended = true;
      while (waiting.length) {
        waiting.shift().resolve({ done: true, value: undefined });
      }
    },
    fail(error) {
      if (ended) return;
      settleNext({ error });
    },
    push(event) {
      if (ended) throw new Error("Cannot push to a closed event feed.");
      settleNext({ value: { done: false, value: event } });
    },
  };
}

function createProcessHandle(name) {
  const processHandle = new EventEmitter();
  processHandle.name = name;
  processHandle.killCount = 0;
  processHandle.kill = () => {
    processHandle.killCount += 1;
    return true;
  };
  return processHandle;
}

function createHarness(options = {}) {
  const calls = [];
  const feeds = [];
  const ownedProcesses = [];
  const foreignProcess = createProcessHandle("foreign");
  let nextSession = 1;
  let revoked = false;

  const workspaceFor = options.workspaceFor ?? ((payload) => (
    payload.workspacePath === "other"
      ? "/private/workspaces/other"
      : PRIVATE_WORKSPACE
  ));
  const publicWorkspaceFor = options.publicWorkspaceFor ?? ((workspace) => (
    workspace === PRIVATE_WORKSPACE ? PUBLIC_WORKSPACE : "workspaces/other"
  ));

  const preflight = options.preflight ?? (async (payload, context) => {
    calls.push(["preflight", payload, context]);
    if (revoked) {
      const error = new Error("OpenCode session preflight authorization was revoked.");
      error.code = "OPENCODE_PREFLIGHT_REVOKED";
      throw error;
    }
    return {
      workspace: workspaceFor(payload),
      model: HOST_MODEL,
      scopedEnvironment: { OPENAI_API_KEY: "host-only" },
    };
  });

  const startLifecycle = options.startLifecycle ?? (async (input) => {
    calls.push(["startLifecycle", input]);
    const process = createProcessHandle(`owned-${ownedProcesses.length + 1}`);
    ownedProcesses.push(process);
    return {
      process,
      baseUrl: "http://127.0.0.1:54321",
      authorization: "Basic private-credential",
      credentials: { username: "resonantos", password: "private-password" },
      foreignProcess,
    };
  });

  const stopLifecycle = options.stopLifecycle ?? (async (lifecycle, context) => {
    calls.push(["stopLifecycle", lifecycle, context]);
    if (context?.terminate !== false) lifecycle.process?.kill();
    if (lifecycle?.credentials) {
      lifecycle.credentials.username = "";
      lifecycle.credentials.password = "";
    }
  });

  const createClient = options.createClient ?? (async (input) => {
    calls.push(["createClient", input]);
    const feed = createEventFeed();
    feeds.push(feed);
    const client = {
      foreignProcess,
      async createSession(input) {
        calls.push(["createSession", input]);
        return { id: `session-${nextSession++}` };
      },
      async dispose() {
        calls.push(["disposeClient", client]);
      },
      async prompt(input) {
        calls.push(["prompt", input]);
      },
      async replyPermission(input) {
        calls.push(["replyPermission", input]);
        return options.replyPermission?.(input);
      },
      async subscribeEvents({ signal }) {
        calls.push(["subscribeEvents", { signal }]);
        signal.addEventListener("abort", () => feed.end(), { once: true });
        return feed.iterable;
      },
    };
    return client;
  });

  const handlers = createOpencodeSessionHandlers({
    createClient,
    preflight,
    redactWorkspace(workspace) {
      calls.push(["redactWorkspace", workspace]);
      return publicWorkspaceFor(workspace);
    },
    startLifecycle,
    stopLifecycle,
  });

  return {
    calls,
    feeds,
    foreignProcess,
    handlers,
    ownedProcesses,
    revoke() {
      revoked = true;
    },
  };
}

function callsNamed(harness, name) {
  return harness.calls.filter(([callName]) => callName === name);
}

test("the service exposes the governed session routes with separate read and control capabilities", () => {
  const noop = () => ({});
  const { opencodeSessionRoutes } = createOpencodeSessionHostService({
    executeOpenCodeSessionEvents: noop,
    executeOpenCodeSessionPermission: noop,
    executeOpenCodeSessionPrompt: noop,
    executeOpenCodeSessionStart: noop,
    executeOpenCodeSessionStop: noop,
  });

  assert.deepEqual(
    opencodeSessionRoutes.map(({ method, path, requiredCapability }) => ({
      method,
      path,
      requiredCapability,
    })),
    [
      {
        method: "POST",
        path: "/opencode/session/start",
        requiredCapability: "addon-runtime-control",
      },
      {
        method: "POST",
        path: "/opencode/session/prompt",
        requiredCapability: "addon-runtime-control",
      },
      {
        method: "POST",
        path: "/opencode/session/permission",
        requiredCapability: "addon-runtime-control",
      },
      {
        method: "POST",
        path: "/opencode/session/events",
        requiredCapability: "addon-runtime-read",
      },
      {
        method: "POST",
        path: "/opencode/session/stop",
        requiredCapability: "addon-runtime-control",
      },
    ],
  );
});

test("the route service fails closed when any handler is missing", () => {
  assert.throws(
    () => createOpencodeSessionHostService({}),
    /missing handler: executeOpenCodeSessionStart/,
  );
  assert.throws(
    () => createOpencodeSessionHostService({
      executeOpenCodeSessionPermission() {},
      executeOpenCodeSessionPrompt() {},
      executeOpenCodeSessionStart() {},
      executeOpenCodeSessionStop() {},
    }),
    /missing handler: executeOpenCodeSessionEvents/,
  );
});

test("start runs preflight before lifecycle work and returns only a session id and redacted workspace", async () => {
  const harness = createHarness({
    startLifecycle: async (input) => {
      assert.equal(callsNamed(harness, "preflight").length, 1);
      harness.calls.push(["startLifecycle", input]);
      const process = createProcessHandle("owned");
      harness.ownedProcesses.push(process);
      return {
        process,
        baseUrl: "http://127.0.0.1:54321",
        authorization: "Basic private-credential",
        credentials: { username: "resonantos", password: "private-password" },
      };
    },
  });

  const result = await harness.handlers.executeOpenCodeSessionStart({
    workspacePath: ".",
    model: "attacker/selected-model",
  });

  assert.deepEqual(result, {
    sessionId: "session-1",
    workspace: PUBLIC_WORKSPACE,
  });
  assert.equal(JSON.stringify(result).includes("/private/"), false);
  assert.equal(JSON.stringify(result).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(result).includes("private-credential"), false);
  assert.deepEqual(callsNamed(harness, "preflight")[0][1], { workspacePath: "." });
  assert.deepEqual(callsNamed(harness, "createSession")[0][1], {
    directory: PRIVATE_WORKSPACE,
    model: HOST_MODEL,
  });
  assert.equal(callsNamed(harness, "subscribeEvents").length, 1);
  assert.ok(callsNamed(harness, "subscribeEvents")[0][1].signal instanceof AbortSignal);
});

test("preflight failure starts no lifecycle and an absolute public workspace is rejected", async () => {
  const denied = createHarness({
    preflight: async () => {
      throw new Error("OpenCode execution is disabled.");
    },
  });
  await assert.rejects(
    () => denied.handlers.executeOpenCodeSessionStart({ workspacePath: "." }),
    /execution is disabled/,
  );
  assert.equal(callsNamed(denied, "startLifecycle").length, 0);

  const unredacted = createHarness({
    publicWorkspaceFor: (workspace) => workspace,
  });
  await assert.rejects(
    () => unredacted.handlers.executeOpenCodeSessionStart({ workspacePath: "." }),
    /redacted workspace/,
  );
  assert.equal(callsNamed(unredacted, "startLifecycle").length, 0);
});

test("same-workspace starts are idempotent and a different workspace is rejected", async () => {
  const harness = createHarness();

  const first = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  const repeated = await harness.handlers.executeOpenCodeSessionStart({
    workspacePath: ".",
    model: "attacker/model",
  });
  assert.deepEqual(repeated, first);
  assert.equal(callsNamed(harness, "preflight").length, 2);
  assert.equal(callsNamed(harness, "startLifecycle").length, 1);
  assert.equal(callsNamed(harness, "createSession").length, 1);

  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionStart({ workspacePath: "other" }),
    /different workspace/,
  );
  assert.equal(callsNamed(harness, "startLifecycle").length, 1);

  await harness.handlers.executeOpenCodeSessionStop({ sessionId: first.sessionId });
});

test("concurrent starts for the same canonical workspace share one start attempt", async () => {
  const lifecycleReady = deferred();
  const harness = createHarness({
    startLifecycle: async (input) => {
      harness.calls.push(["startLifecycle", input]);
      return lifecycleReady.promise;
    },
  });

  const firstPromise = harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  const secondPromise = harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  await waitFor(() => callsNamed(harness, "startLifecycle").length === 1);

  const process = createProcessHandle("owned-concurrent");
  harness.ownedProcesses.push(process);
  lifecycleReady.resolve({ process, credentials: { password: "private" } });

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.deepEqual(second, first);
  assert.equal(callsNamed(harness, "startLifecycle").length, 1);
  assert.equal(callsNamed(harness, "createSession").length, 1);

  await harness.handlers.executeOpenCodeSessionStop({ sessionId: first.sessionId });
});

test("prompt, permission, events, and stop require the active host-owned session", async () => {
  const harness = createHarness();
  const operations = [
    () => harness.handlers.executeOpenCodeSessionPrompt({ text: "go" }),
    () => harness.handlers.executeOpenCodeSessionPermission({ requestId: "p1", reply: "once" }),
    () => harness.handlers.executeOpenCodeSessionEvents({ after: 0 }),
    () => harness.handlers.executeOpenCodeSessionStop({}),
  ];
  for (const operation of operations) {
    await assert.rejects(operation, /active sessionId/);
  }

  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  const foreignOperations = [
    () => harness.handlers.executeOpenCodeSessionPrompt({ sessionId: "foreign", text: "go" }),
    () => harness.handlers.executeOpenCodeSessionPermission({
      sessionId: "foreign",
      requestId: "p1",
      reply: "once",
    }),
    () => harness.handlers.executeOpenCodeSessionEvents({ sessionId: "foreign", after: 0 }),
    () => harness.handlers.executeOpenCodeSessionStop({ sessionId: "foreign" }),
  ];
  for (const operation of foreignOperations) {
    await assert.rejects(operation, /not owned by this bridge/);
  }
  assert.equal(callsNamed(harness, "prompt").length, 0);
  assert.equal(callsNamed(harness, "replyPermission").length, 0);

  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("prompt validates text and ignores caller-selected model and agent fields", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });

  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionPrompt({ sessionId, text: "   " }),
    /non-empty text/,
  );
  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionPrompt({ sessionId, text: { unsafe: true } }),
    /text must be a string/,
  );

  await harness.handlers.executeOpenCodeSessionPrompt({
    sessionId,
    text: "  run the focused tests  ",
    model: "attacker/model",
    agent: "untrusted-agent",
    parts: [{ type: "file", path: "/private/secret" }],
  });
  assert.deepEqual(callsNamed(harness, "prompt")[0][1], {
    sessionID: sessionId,
    text: "run the focused tests",
  });
  assert.deepEqual(
    callsNamed(harness, "preflight").at(-1)[1],
    { workspacePath: PRIVATE_WORKSPACE },
  );

  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("permission replies allow only once or reject and use an attributed request id", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });

  harness.feeds[0].push({
    type: "permission.v2.asked",
    data: {
      id: "request-once",
      sessionID: sessionId,
      action: "bash",
      resources: ["npm test"],
    },
  });
  harness.feeds[0].push({
    type: "permission.v2.asked",
    data: {
      id: "request-reject",
      sessionID: sessionId,
      action: "edit",
      resources: ["src/index.js"],
    },
  });
  await waitFor(async () => {
    const result = await harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 0 });
    return result.events.length === 2;
  });

  await harness.handlers.executeOpenCodeSessionPermission({
    sessionId,
    requestId: "request-once",
    requestID: "caller-controlled",
    reply: "once",
  });
  await harness.handlers.executeOpenCodeSessionPermission({
    sessionId,
    requestId: "request-reject",
    reply: "reject",
  });
  assert.deepEqual(
    callsNamed(harness, "replyPermission").map(([, input]) => input),
    [
      { sessionID: sessionId, requestID: "request-once", reply: "once" },
      { sessionID: sessionId, requestID: "request-reject", reply: "reject" },
    ],
  );

  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionPermission({
      sessionId,
      requestId: "request-once",
      reply: "always",
    }),
    /once or reject/,
  );
  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionPermission({
      sessionId,
      requestId: "unknown",
      reply: "once",
    }),
    /active session permission request/,
  );

  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("an attributed permission request can have only one reply in flight", async () => {
  const replyFinished = deferred();
  let sdkReplyCount = 0;
  const harness = createHarness({
    replyPermission: () => {
      sdkReplyCount += 1;
      if (sdkReplyCount > 1) throw new Error("duplicate reply reached the SDK");
      return replyFinished.promise;
    },
  });
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  harness.feeds[0].push({
    type: "permission.v2.asked",
    data: {
      id: "request-single-flight",
      sessionID: sessionId,
      action: "bash",
      resources: ["npm test"],
    },
  });
  await waitFor(async () => {
    const result = await harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 0 });
    return result.events.length === 1;
  });

  const firstReply = harness.handlers.executeOpenCodeSessionPermission({
    sessionId,
    requestId: "request-single-flight",
    reply: "once",
  });
  await waitFor(() => callsNamed(harness, "replyPermission").length === 1);
  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionPermission({
      sessionId,
      requestId: "request-single-flight",
      reply: "once",
    }),
    /active session permission request/,
  );
  assert.equal(callsNamed(harness, "replyPermission").length, 1);

  replyFinished.resolve();
  await firstReply;
  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("the canonical bridge contract returns events and accepts requestId", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({
    workspacePath: ".",
  });
  harness.feeds[0].push({
    type: "permission.v2.asked",
    metadata: { private: "must-not-cross" },
    location: { directory: PRIVATE_WORKSPACE },
    data: {
      id: "request-canonical",
      sessionID: sessionId,
      action: "bash",
      resources: ["npm test"],
      metadata: { apiKey: "sk-must-not-cross" },
    },
  });

  await waitFor(async () => {
    const result = await harness.handlers.executeOpenCodeSessionEvents({
      sessionId,
      after: 0,
    });
    return result.nextCursor === 1;
  });

  const result = await harness.handlers.executeOpenCodeSessionEvents({
    sessionId,
    after: 0,
  });
  assert.equal(Object.hasOwn(result, "entries"), false);
  assert.deepEqual(result, {
    events: [{
      type: "permission.v2.asked",
      data: {
        id: "request-canonical",
        sessionID: sessionId,
        action: "bash",
        resources: ["npm test"],
      },
    }],
    nextCursor: 1,
    droppedBefore: 0,
  });

  await harness.handlers.executeOpenCodeSessionPermission({
    sessionId,
    requestId: "request-canonical",
    reply: "once",
  });
  assert.deepEqual(callsNamed(harness, "replyPermission").at(-1)[1], {
    sessionID: sessionId,
    requestID: "request-canonical",
    reply: "once",
  });
  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("the host drops unknown events and redacts known event payloads before buffering", async () => {
  const providerSecret = "QZ9K-host-selected-secret-value";
  const harness = createHarness({
    preflight: async (payload, context) => {
      harness.calls.push(["preflight", payload, context]);
      return {
        childEnvironment: {
          HOME: "/Users/test",
          OPENAI_API_KEY: providerSecret,
        },
        model: HOST_MODEL,
        workspace: PRIVATE_WORKSPACE,
      };
    },
  });
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({
    workspacePath: ".",
  });

  harness.feeds[0].push({
    type: "unknown.secret.dump",
    metadata: { credential: providerSecret },
    data: {
      sessionID: sessionId,
      credential: providerSecret,
      path: `${PRIVATE_WORKSPACE}/private.txt`,
    },
  });
  harness.feeds[0].push({
    type: "session.next.text.delta",
    metadata: { credential: providerSecret },
    location: { directory: PRIVATE_WORKSPACE },
    data: {
      sessionID: sessionId,
      assistantMessageID: "assistant-1",
      textID: "text-1",
      delta: `read ${PRIVATE_WORKSPACE}/src/index.js with ${providerSecret}`,
      extra: providerSecret,
    },
  });
  harness.feeds[0].push({
    type: "session.next.text.delta",
    data: {
      sessionID: sessionId,
      assistantMessageID: "assistant-2",
      textID: "text-2",
      delta: `${"x".repeat(8_188)}${providerSecret}`,
    },
  });

  await waitFor(async () => {
    const result = await harness.handlers.executeOpenCodeSessionEvents({
      sessionId,
      after: 0,
    });
    return result.nextCursor === 2;
  });
  const result = await harness.handlers.executeOpenCodeSessionEvents({
    sessionId,
    after: 0,
  });
  assert.equal(result.events.length, 2);
  assert.deepEqual(Object.keys(result.events[0]).sort(), ["data", "type"]);
  assert.deepEqual(
    Object.keys(result.events[0].data).sort(),
    ["assistantMessageID", "delta", "sessionID", "textID"],
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("unknown.secret.dump"), false);
  assert.equal(serialized.includes(providerSecret), false);
  assert.equal(serialized.includes("QZ9K"), false);
  assert.equal(serialized.includes(PRIVATE_WORKSPACE), false);
  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("the host redacts the lifecycle service credential from allowed tool results", async () => {
  const servicePassword = "generated-service-value";
  const processHandle = createProcessHandle("owned-service");
  const lifecycle = {
    process: processHandle,
    redactSensitiveText(value, replacement = "[redacted]") {
      return typeof value === "string"
        ? value.split(servicePassword).join(replacement)
        : value;
    },
  };
  const harness = createHarness({
    startLifecycle: async () => lifecycle,
  });
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({
    workspacePath: ".",
  });

  harness.feeds[0].push({
    type: "session.next.tool.success",
    data: {
      sessionID: sessionId,
      assistantMessageID: "assistant-service",
      callID: "call-service",
      result: `OPENCODE_SERVER_PASSWORD=${servicePassword}`,
    },
  });
  await waitFor(async () => (
    await harness.handlers.executeOpenCodeSessionEvents({
      sessionId,
      after: 0,
    })
  ).nextCursor === 1);

  const result = await harness.handlers.executeOpenCodeSessionEvents({
    sessionId,
    after: 0,
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(servicePassword), false);
  assert.match(serialized, /\[redacted\]/);
  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("the host bounds individual events and total buffered event bytes", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({
    workspacePath: ".",
  });
  const largeDelta = "x".repeat(20_000);
  for (let index = 0; index < 500; index += 1) {
    harness.feeds[0].push({
      type: "session.next.text.delta",
      data: {
        sessionID: sessionId,
        assistantMessageID: `assistant-${index}`,
        textID: `text-${index}`,
        delta: largeDelta,
      },
    });
  }

  await waitFor(async () => {
    const result = await harness.handlers.executeOpenCodeSessionEvents({
      sessionId,
      after: 0,
    });
    return result.nextCursor === 500;
  });
  const result = await harness.handlers.executeOpenCodeSessionEvents({
    sessionId,
    after: 0,
  });
  assert.ok(result.events.length < 500);
  assert.ok(result.droppedBefore > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 1_100_000);
  assert.ok(
    result.events.every((event) => (
      Buffer.byteLength(JSON.stringify(event), "utf8") <= 32_768
    )),
  );
  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("event attribution is enforced before buffering and polling returns no duplicates", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  const retained = {
    type: "message.part.delta",
    data: {
      sessionID: sessionId,
      messageID: "message-owned",
      partID: "part-owned",
      field: "text",
      delta: "owned",
    },
  };

  harness.feeds[0].push({
    type: "message.part.delta",
    data: {
      sessionID: "another-session",
      messageID: "message-foreign",
      partID: "part-foreign",
      field: "text",
      delta: "foreign",
    },
  });
  harness.feeds[0].push({
    type: "file.edited",
    data: { path: "/private/workspaces/resonantos/secret.txt" },
  });
  harness.feeds[0].push(retained);

  await waitFor(async () => {
    const result = await harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 0 });
    return result.nextCursor === 1;
  });

  const firstPoll = await harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 0 });
  assert.deepEqual(firstPoll, {
    events: [retained],
    nextCursor: 1,
    droppedBefore: 0,
  });
  assert.deepEqual(
    await harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: firstPoll.nextCursor }),
    {
      events: [],
      nextCursor: 1,
      droppedBefore: 0,
    },
  );

  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("the event buffer retains 500 events and reports a cursor gap after eviction", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });

  for (let index = 1; index <= 501; index += 1) {
    harness.feeds[0].push({
      type: "session.next.text.delta",
      data: {
        sessionID: sessionId,
        assistantMessageID: `assistant-${index}`,
        textID: `text-${index}`,
        delta: `chunk-${index}`,
      },
    });
  }
  await waitFor(async () => {
    const result = await harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 0 });
    return result.nextCursor === 501;
  });

  const result = await harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 0 });
  assert.equal(result.events.length, 500);
  assert.equal(result.events[0].data.textID, "text-2");
  assert.equal(result.events.at(-1).data.textID, "text-501");
  assert.equal(result.nextCursor, 501);
  assert.equal(result.droppedBefore, 1);
  assert.deepEqual(
    await harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 501 }),
    { events: [], nextCursor: 501, droppedBefore: 1 },
  );

  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("the event cursor must be a non-negative safe integer", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });

  for (const after of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => harness.handlers.executeOpenCodeSessionEvents({ sessionId, after }),
      /non-negative safe integer/,
    );
  }
  assert.deepEqual(
    await harness.handlers.executeOpenCodeSessionEvents({ sessionId }),
    { events: [], nextCursor: 0, droppedBefore: 0 },
  );

  await harness.handlers.executeOpenCodeSessionStop({ sessionId });
});

test("explicit stop aborts the pump, disposes the client, and stops only the owned lifecycle", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  const signal = callsNamed(harness, "subscribeEvents")[0][1].signal;

  assert.deepEqual(
    await harness.handlers.executeOpenCodeSessionStop({ sessionId }),
    { stopped: true },
  );
  assert.equal(signal.aborted, true);
  assert.equal(callsNamed(harness, "disposeClient").length, 1);
  assert.equal(callsNamed(harness, "stopLifecycle").length, 1);
  assert.equal(callsNamed(harness, "stopLifecycle")[0][2].terminate, true);
  assert.equal(harness.ownedProcesses[0].killCount, 1);
  assert.equal(harness.foreignProcess.killCount, 0);
  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 0 }),
    /no active OpenCode session/,
  );
});

test("cleanup accepts an opaque frozen lifecycle handle", async () => {
  const harness = createHarness({
    startLifecycle: async (input) => {
      harness.calls.push(["startLifecycle", input]);
      const process = createProcessHandle("owned-frozen");
      harness.ownedProcesses.push(process);
      return Object.freeze({
        credentials: Object.freeze({ password: "private" }),
        process,
      });
    },
    stopLifecycle: async (lifecycle, context) => {
      harness.calls.push(["stopLifecycle", lifecycle, context]);
      lifecycle.process.kill();
    },
  });
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });

  assert.deepEqual(
    await harness.handlers.executeOpenCodeSessionStop({ sessionId }),
    { stopped: true },
  );
  assert.equal(harness.ownedProcesses[0].killCount, 1);
});

test("owned child exit clears session, client, credentials, and buffered event state without killing a foreign process", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  harness.feeds[0].push({
    type: "message.part.delta",
    data: {
      sessionID: sessionId,
      messageID: "message-before-exit",
      partID: "part-before-exit",
      field: "text",
      delta: "before exit",
    },
  });
  await waitFor(async () => {
    const result = await harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 0 });
    return result.events.length === 1;
  });

  harness.ownedProcesses[0].emit("exit", 1, null);
  await waitFor(() => callsNamed(harness, "stopLifecycle").length === 1);

  assert.equal(callsNamed(harness, "stopLifecycle")[0][2].terminate, false);
  assert.equal(harness.ownedProcesses[0].killCount, 0);
  assert.equal(harness.foreignProcess.killCount, 0);
  assert.equal(callsNamed(harness, "disposeClient").length, 1);
  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionPrompt({ sessionId, text: "after exit" }),
    /no active OpenCode session/,
  );

  const restarted = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  assert.equal(restarted.sessionId, "session-2");
  assert.deepEqual(
    await harness.handlers.executeOpenCodeSessionEvents({
      sessionId: restarted.sessionId,
      after: 0,
    }),
    { events: [], nextCursor: 0, droppedBefore: 0 },
  );
  await harness.handlers.executeOpenCodeSessionStop({ sessionId: restarted.sessionId });
});

test("event pump failure clears every owned resource and rejects later operations", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });

  harness.feeds[0].fail(new Error("event pump failed"));
  await waitFor(() => callsNamed(harness, "stopLifecycle").length === 1);

  assert.equal(callsNamed(harness, "disposeClient").length, 1);
  assert.equal(harness.ownedProcesses[0].killCount, 1);
  assert.equal(harness.foreignProcess.killCount, 0);
  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionEvents({ sessionId, after: 0 }),
    /no active OpenCode session/,
  );
});

test("a restart waits for asynchronous owned lifecycle cleanup to finish", async () => {
  const cleanupReleased = deferred();
  let stopCount = 0;
  const harness = createHarness({
    stopLifecycle: async (lifecycle, context) => {
      harness.calls.push(["stopLifecycle", lifecycle, context]);
      stopCount += 1;
      if (stopCount === 1) await cleanupReleased.promise;
      if (context?.terminate !== false) lifecycle.process?.kill();
    },
  });
  const first = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });

  harness.feeds[0].fail(new Error("event pump failed"));
  await waitFor(() => callsNamed(harness, "stopLifecycle").length === 1);
  const restartPromise = harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    callsNamed(harness, "startLifecycle").length,
    1,
    "a second child must not start while the first lifecycle is still cleaning up",
  );

  cleanupReleased.resolve();
  const restarted = await restartPromise;
  assert.notEqual(restarted.sessionId, first.sessionId);
  assert.equal(callsNamed(harness, "startLifecycle").length, 2);
  await harness.handlers.executeOpenCodeSessionStop({ sessionId: restarted.sessionId });
});

test("failed owned lifecycle cleanup blocks every later start fail-closed", async () => {
  const harness = createHarness({
    stopLifecycle: async (lifecycle, context) => {
      harness.calls.push(["stopLifecycle", lifecycle, context]);
      throw new Error("owned lifecycle cleanup failed");
    },
  });
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });

  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionStop({ sessionId }),
    /owned lifecycle cleanup failed/,
  );
  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." }),
    /cleanup failed.*restart the bridge/i,
  );
  assert.equal(callsNamed(harness, "preflight").length, 3);
  assert.equal(callsNamed(harness, "startLifecycle").length, 1);
});

test("revocation during start releases the late owned lifecycle before any restart", async () => {
  const firstLifecycleReady = deferred();
  let preflightRevoked = false;
  let lifecycleStarts = 0;
  const harness = createHarness({
    preflight: async (payload, context) => {
      harness.calls.push(["preflight", payload, context]);
      if (preflightRevoked) {
        const error = new Error("OpenCode session preflight authorization was revoked.");
        error.code = "OPENCODE_PREFLIGHT_REVOKED";
        throw error;
      }
      return { workspace: PRIVATE_WORKSPACE, model: HOST_MODEL };
    },
    startLifecycle: async (input) => {
      harness.calls.push(["startLifecycle", input]);
      lifecycleStarts += 1;
      if (lifecycleStarts === 1) return firstLifecycleReady.promise;
      const process = createProcessHandle("owned-restart");
      harness.ownedProcesses.push(process);
      return { process };
    },
  });

  const cancelledStart = harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  await waitFor(() => callsNamed(harness, "startLifecycle").length === 1);
  preflightRevoked = true;
  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." }),
    /authorization was revoked/,
  );

  preflightRevoked = false;
  const restart = harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    callsNamed(harness, "startLifecycle").length,
    1,
    "restart must wait for the cancelled lifecycle promise to settle",
  );

  const lateProcess = createProcessHandle("owned-late");
  harness.ownedProcesses.push(lateProcess);
  firstLifecycleReady.resolve({ process: lateProcess });
  await assert.rejects(cancelledStart, /start was cancelled/);
  const restarted = await restart;

  assert.equal(callsNamed(harness, "startLifecycle").length, 2);
  assert.equal(callsNamed(harness, "stopLifecycle").length, 1);
  assert.equal(lateProcess.killCount, 1);
  await harness.handlers.executeOpenCodeSessionStop({ sessionId: restarted.sessionId });
});

test("preflight revocation on an owned operation tears down the active session", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  harness.revoke();

  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionPrompt({ sessionId, text: "must not run" }),
    /authorization was revoked/,
  );
  assert.equal(callsNamed(harness, "prompt").length, 0);
  assert.equal(callsNamed(harness, "stopLifecycle").length, 1);
  assert.equal(callsNamed(harness, "disposeClient").length, 1);
  assert.equal(harness.ownedProcesses[0].killCount, 1);
});

test("start failure cleans partial resources and permits a later clean restart", async () => {
  let failCreate = true;
  const harness = createHarness({
    createClient: async (input) => {
      harness.calls.push(["createClient", input]);
      const feed = createEventFeed();
      harness.feeds.push(feed);
      const client = {
        async createSession(args) {
          harness.calls.push(["createSession", args]);
          if (failCreate) throw new Error("session creation failed");
          return { id: "session-recovered" };
        },
        async dispose() {
          harness.calls.push(["disposeClient", client]);
        },
        async prompt(args) {
          harness.calls.push(["prompt", args]);
        },
        async replyPermission(args) {
          harness.calls.push(["replyPermission", args]);
        },
        async subscribeEvents({ signal }) {
          harness.calls.push(["subscribeEvents", { signal }]);
          signal.addEventListener("abort", () => feed.end(), { once: true });
          return feed.iterable;
        },
      };
      return client;
    },
  });

  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." }),
    /session creation failed/,
  );
  assert.equal(callsNamed(harness, "disposeClient").length, 1);
  assert.equal(callsNamed(harness, "stopLifecycle").length, 1);
  assert.equal(harness.ownedProcesses[0].killCount, 1);

  failCreate = false;
  const restarted = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });
  assert.equal(restarted.sessionId, "session-recovered");
  assert.equal(callsNamed(harness, "startLifecycle").length, 2);
  await harness.handlers.executeOpenCodeSessionStop({ sessionId: restarted.sessionId });
});

test("host shutdown has a private cleanup path that does not weaken route ownership", async () => {
  const harness = createHarness();
  const { sessionId } = await harness.handlers.executeOpenCodeSessionStart({ workspacePath: "." });

  assert.equal(await harness.handlers.shutdownOpenCodeSession(), undefined);
  assert.equal(callsNamed(harness, "stopLifecycle").length, 1);
  assert.equal(harness.ownedProcesses[0].killCount, 1);
  await assert.rejects(
    () => harness.handlers.executeOpenCodeSessionStop({ sessionId }),
    /no active OpenCode session/,
  );
});
