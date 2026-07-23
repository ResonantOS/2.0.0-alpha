import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createOpenCodeBridgeSource } from "../resonantos-side-panel-extension/src/lib/opencode-bridge-source.js";

const SOURCE_PATH = new URL(
  "../resonantos-side-panel-extension/src/lib/opencode-bridge-source.js",
  import.meta.url,
);

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

function createControlledSleeper() {
  const pending = [];

  function settle(entry) {
    if (entry.settled) return;
    entry.settled = true;
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
    entry.resolve();
  }

  return {
    sleep({ signal } = {}) {
      const gate = deferred();
      const entry = {
        resolve: gate.resolve,
        settled: false,
      };
      pending.push(entry);
      if (signal?.aborted) settle(entry);
      else signal?.addEventListener("abort", () => settle(entry), { once: true });
      return gate.promise;
    },
    get pendingCount() {
      return pending.length;
    },
    releaseNext() {
      const entry = pending[0];
      assert.ok(entry, "expected a pending polling delay");
      settle(entry);
    },
  };
}

function pollResponse({
  cursor = 0,
  droppedBefore = 0,
  events = [],
} = {}) {
  return {
    droppedBefore,
    events,
    nextCursor: cursor,
  };
}

function event(id, sessionId = "session-1", type = "session.idle") {
  const data = sessionId === null ? {} : { sessionID: sessionId };
  return {
    id: `event-${id}`,
    type,
    data,
  };
}

test("source contains no direct fetch, raw event URL, SSE parser, or event-stream dependency", async () => {
  const sourceText = await readFile(SOURCE_PATH, "utf8");

  for (const forbidden of [
    "openEventStream",
    "eventUrl",
    "createSSEParser",
    "TextDecoder",
    "ReadableStream",
    "text/event-stream",
  ]) {
    assert.doesNotMatch(sourceText, new RegExp(forbidden, "i"), forbidden);
  }
  assert.doesNotMatch(sourceText, /\bfetch\s*\(/);
});

test("concurrent callers share exactly one session start", async () => {
  const startGate = deferred();
  const posts = [];
  let starts = 0;
  const source = createOpenCodeBridgeSource({
    startSession: async () => {
      starts += 1;
      return startGate.promise;
    },
    postJson: async (path, body) => {
      posts.push([path, body]);
      return {};
    },
    sleep: createControlledSleeper().sleep,
  });

  const first = source.start();
  const second = source.start();
  const prompt = source.sendPrompt("run focused tests");
  assert.equal(starts, 1);

  startGate.resolve({ sessionId: "session-1", workspace: "repo/task" });
  assert.deepEqual(await first, {
    sessionId: "session-1",
    workspace: "repo/task",
  });
  assert.deepEqual(await second, {
    sessionId: "session-1",
    workspace: "repo/task",
  });
  await prompt;

  assert.equal(starts, 1);
  assert.deepEqual(posts, [[
    "/opencode/session/prompt",
    { sessionId: "session-1", text: "run focused tests" },
  ]]);
});

test("one shared poll loop prevents duplicate or concurrent event requests", async () => {
  const pollGate = deferred();
  const pollCalls = [];
  const firstEvents = [];
  const secondEvents = [];
  const sleeper = createControlledSleeper();
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "session-1", workspace: "repo/task" }),
    postJson: async (path, body) => {
      if (path !== "/opencode/session/events") return {};
      pollCalls.push(body);
      return pollGate.promise;
    },
    sleep: sleeper.sleep,
  });

  const unsubscribeFirst = source.subscribe((eventValue) => firstEvents.push(eventValue));
  const unsubscribeSecond = source.subscribe((eventValue) => secondEvents.push(eventValue));
  await waitFor(() => pollCalls.length === 1, "first poll did not start");
  await Promise.resolve();
  assert.equal(pollCalls.length, 1, "a second subscriber must not start another poll");

  pollGate.resolve(pollResponse({
    cursor: 1,
    events: [event(1)],
  }));
  await waitFor(() => firstEvents.length === 1 && secondEvents.length === 1);
  assert.equal(sleeper.pendingCount, 1, "one loop owns one polling delay");

  unsubscribeFirst();
  unsubscribeSecond();
  await waitFor(() => sleeper.pendingCount === 0, "cancellation did not abort the delay");
  assert.equal(pollCalls.length, 1);
});

test("polls the authenticated bridge with a monotonic after cursor", async () => {
  const calls = [];
  const delivered = [];
  const sleeper = createControlledSleeper();
  const responses = [
    pollResponse({ cursor: 1, events: [event(1)] }),
    pollResponse({ cursor: 3, events: [event(2), event(3)] }),
  ];
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "session-1", workspace: "repo/task" }),
    postJson: async (path, body) => {
      assert.equal(path, "/opencode/session/events");
      calls.push(body);
      return responses[calls.length - 1];
    },
    sleep: sleeper.sleep,
  });

  const unsubscribe = source.subscribe((eventValue) => delivered.push(eventValue));
  await waitFor(() => delivered.length === 1 && sleeper.pendingCount === 1);
  sleeper.releaseNext();
  await waitFor(() => delivered.length === 3 && sleeper.pendingCount === 1);

  assert.deepEqual(calls, [
    { sessionId: "session-1", after: 0 },
    { sessionId: "session-1", after: 1 },
  ]);
  assert.deepEqual(delivered.map(({ id }) => id), ["event-1", "event-2", "event-3"]);
  unsubscribe();
});

test("fails closed when nextCursor moves behind the requested after cursor", async () => {
  const delivered = [];
  const errors = [];
  const sleeper = createControlledSleeper();
  let polls = 0;
  const source = createOpenCodeBridgeSource({
    onPollingError: (error) => errors.push(error),
    startSession: async () => ({ sessionId: "session-1" }),
    postJson: async () => {
      polls += 1;
      if (polls === 1) {
        return pollResponse({ cursor: 1, events: [event(1)] });
      }
      return pollResponse({ cursor: 0 });
    },
    sleep: sleeper.sleep,
  });

  const unsubscribe = source.subscribe((eventValue) => delivered.push(eventValue));
  await waitFor(() => delivered.length === 1 && sleeper.pendingCount === 1);
  sleeper.releaseNext();
  await waitFor(() => errors.length === 1, "backward cursor was not rejected");

  assert.deepEqual(delivered.map(({ id }) => id), ["event-1"]);
  assert.equal(polls, 2);
  assert.match(errors[0].message, /cursor/i);
  unsubscribe();
});

test("unsubscribe cancels polling without implicitly stopping the bridge session", async () => {
  const posts = [];
  const sleeper = createControlledSleeper();
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "session-1" }),
    postJson: async (path, body) => {
      posts.push([path, body]);
      return pollResponse();
    },
    sleep: sleeper.sleep,
  });

  const unsubscribe = source.subscribe(() => {});
  await waitFor(() => sleeper.pendingCount === 1);
  unsubscribe();
  await waitFor(() => sleeper.pendingCount === 0);
  await Promise.resolve();

  assert.deepEqual(posts, [[
    "/opencode/session/events",
    { sessionId: "session-1", after: 0 },
  ]]);
});

test("an immediate resubscribe restarts polling after the cancelled loop unwinds", async () => {
  const posts = [];
  const sleeper = createControlledSleeper();
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "session-1" }),
    postJson: async (path, body) => {
      posts.push([path, body]);
      return pollResponse();
    },
    sleep: sleeper.sleep,
  });

  const unsubscribeFirst = source.subscribe(() => {});
  await waitFor(() => sleeper.pendingCount === 1);
  unsubscribeFirst();
  const unsubscribeSecond = source.subscribe(() => {});

  await waitFor(
    () => posts.length === 2,
    "replacement subscriber did not restart the cancelled polling loop",
  );
  assert.deepEqual(posts.map(([, body]) => body.after), [0, 0]);
  unsubscribeSecond();
});

test("stop cancels polling and explicitly stops the owned bridge session", async () => {
  const posts = [];
  const sleeper = createControlledSleeper();
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "session-1" }),
    postJson: async (path, body) => {
      posts.push([path, body]);
      if (path === "/opencode/session/events") return pollResponse();
      return { stopped: true };
    },
    sleep: sleeper.sleep,
  });

  source.subscribe(() => {});
  await waitFor(() => sleeper.pendingCount === 1);
  assert.deepEqual(await source.stop(), { stopped: true });
  await waitFor(() => sleeper.pendingCount === 0);

  assert.deepEqual(posts.at(-1), [
    "/opencode/session/stop",
    { sessionId: "session-1" },
  ]);
});

test("prompt and valid once/reject permission replies carry the owned session id", async () => {
  const posts = [];
  const source = createOpenCodeBridgeSource({
    startSession: async () => ({ sessionId: "session-1" }),
    postJson: async (path, body) => {
      posts.push([path, body]);
      return {};
    },
    sleep: createControlledSleeper().sleep,
  });

  await source.sendPrompt("inspect the diff");
  await source.replyPermission("permission-1", "once");
  await source.replyPermission("permission-2", "reject");
  await assert.rejects(
    source.replyPermission("permission-3", "always"),
    /once or reject/i,
  );
  await assert.rejects(
    source.replyPermission("permission-4", { approved: true }),
    /once or reject/i,
  );

  assert.deepEqual(posts, [
    [
      "/opencode/session/prompt",
      { sessionId: "session-1", text: "inspect the diff" },
    ],
    [
      "/opencode/session/permission",
      { sessionId: "session-1", requestId: "permission-1", reply: "once" },
    ],
    [
      "/opencode/session/permission",
      { sessionId: "session-1", requestId: "permission-2", reply: "reject" },
    ],
  ]);
});

test("discloses a cursor gap before delivering the remaining attributable events once", async () => {
  const gaps = [];
  const delivered = [];
  const sleeper = createControlledSleeper();
  const source = createOpenCodeBridgeSource({
    onCursorGap: (gap) => gaps.push(gap),
    startSession: async () => ({ sessionId: "session-1" }),
    postJson: async () => pollResponse({
      cursor: 5,
      droppedBefore: 3,
      events: [event(4), event(5)],
    }),
    sleep: sleeper.sleep,
  });

  const unsubscribe = source.subscribe((eventValue) => delivered.push(eventValue));
  await waitFor(() => delivered.length === 2);

  assert.deepEqual(gaps, [{
    droppedBefore: 3,
    requestedAfter: 0,
    sessionId: "session-1",
  }]);
  assert.deepEqual(delivered.map(({ id }) => id), ["event-4", "event-5"]);
  unsubscribe();
});

test("malformed cursor responses fail closed without delivery, retry, or replay", async () => {
  const malformedResponses = [
    null,
    [],
    { events: [], nextCursor: 0 },
    { events: {}, nextCursor: 0, droppedBefore: 0 },
    { events: [], nextCursor: -1, droppedBefore: 0 },
    { events: [], nextCursor: 0, droppedBefore: -1 },
    { events: [], nextCursor: 1, droppedBefore: 2 },
    { events: [event(1)], nextCursor: 0, droppedBefore: 0 },
    { events: [], nextCursor: 1, droppedBefore: 0 },
    { events: [event(1), event(2)], nextCursor: 1, droppedBefore: 0 },
  ];

  for (const malformedResponse of malformedResponses) {
    const delivered = [];
    const errors = [];
    const posts = [];
    const sleeper = createControlledSleeper();
    const source = createOpenCodeBridgeSource({
      onPollingError: (error) => errors.push(error),
      startSession: async () => ({ sessionId: "session-1" }),
      postJson: async (path, body) => {
        posts.push([path, body]);
        return malformedResponse;
      },
      sleep: sleeper.sleep,
    });

    const unsubscribe = source.subscribe((eventValue) => delivered.push(eventValue));
    await waitFor(() => errors.length === 1, "malformed response was not rejected");
    await Promise.resolve();

    assert.deepEqual(delivered, []);
    assert.equal(posts.length, 1);
    assert.equal(sleeper.pendingCount, 0, "failed polling must not schedule a retry");
    assert.match(errors[0].message, /cursor|response/i);
    unsubscribe();
  }
});

test("wrong-session or missing-session bridge events fail closed", async () => {
  for (const sessionId of ["session-other", null]) {
    const delivered = [];
    const errors = [];
    const source = createOpenCodeBridgeSource({
      onPollingError: (error) => errors.push(error),
      startSession: async () => ({ sessionId: "session-1" }),
      postJson: async () => pollResponse({
        cursor: 1,
        events: [event(1, sessionId)],
      }),
      sleep: createControlledSleeper().sleep,
    });

    const unsubscribe = source.subscribe((eventValue) => delivered.push(eventValue));
    await waitFor(() => errors.length === 1);
    assert.deepEqual(delivered, []);
    assert.match(errors[0].message, /session/i);
    unsubscribe();
  }
});
