import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOpenCodeEvent,
  changedFilesView,
  createOpenCodeSessionState,
  normalizeOpenCodeEvent,
} from "../resonantos-side-panel-extension/src/lib/opencode-session-model.js";

const SESSION_ID = "session-owned";

function event(type, data = {}) {
  return { id: `${type}-event`, type, data };
}

function run(events, state = createOpenCodeSessionState({ sessionId: SESSION_ID })) {
  return events.reduce(
    (current, raw) => applyOpenCodeEvent(current, normalizeOpenCodeEvent(raw)),
    state,
  );
}

test("normalizes exact OpenCode 1.18.4 text, reasoning, and message-part deltas", () => {
  const text = normalizeOpenCodeEvent(event("session.next.text.delta", {
    sessionID: SESSION_ID,
    assistantMessageID: "assistant-1",
    textID: "text-1",
    delta: "Hello",
  }));
  const reasoning = normalizeOpenCodeEvent(event("session.next.reasoning.delta", {
    sessionID: SESSION_ID,
    assistantMessageID: "assistant-1",
    reasoningID: "reasoning-1",
    delta: "Think",
  }));
  const part = normalizeOpenCodeEvent(event("message.part.delta", {
    sessionID: SESSION_ID,
    messageID: "message-2",
    partID: "part-2",
    field: "text",
    delta: " again",
  }));

  assert.deepEqual(text, {
    kind: "text-delta",
    sessionId: SESSION_ID,
    messageId: "text-1",
    text: "Hello",
  });
  assert.deepEqual(reasoning, {
    kind: "reasoning-delta",
    sessionId: SESSION_ID,
    messageId: "reasoning-1",
    text: "Think",
  });
  assert.deepEqual(part, {
    kind: "text-delta",
    sessionId: SESSION_ID,
    messageId: "part-2",
    text: " again",
  });
});

test("accumulates exact v2 deltas by their text or reasoning identifier", () => {
  const state = run([
    event("session.next.text.delta", {
      sessionID: SESSION_ID,
      assistantMessageID: "assistant-1",
      textID: "text-1",
      delta: "Refactor ",
    }),
    event("session.next.text.delta", {
      sessionID: SESSION_ID,
      assistantMessageID: "assistant-1",
      textID: "text-1",
      delta: "the bridge.",
    }),
    event("session.next.reasoning.delta", {
      sessionID: SESSION_ID,
      assistantMessageID: "assistant-1",
      reasoningID: "reasoning-1",
      delta: "Check ownership.",
    }),
  ]);

  assert.deepEqual(
    state.entries.map(({ type, id, text }) => ({ type, id, text })),
    [
      { type: "text", id: "text-1", text: "Refactor the bridge." },
      { type: "reasoning", id: "reasoning-1", text: "Check ownership." },
    ],
  );
});

test("fails closed on wrong or missing session IDs when state owns a session", () => {
  const base = createOpenCodeSessionState({ sessionId: SESSION_ID });
  const wrong = normalizeOpenCodeEvent(event("session.next.text.delta", {
    sessionID: "session-other",
    textID: "wrong",
    delta: "must not appear",
  }));
  const missing = normalizeOpenCodeEvent(event("session.next.text.delta", {
    textID: "missing",
    delta: "must not appear",
  }));

  assert.equal(applyOpenCodeEvent(base, wrong), base);
  assert.equal(applyOpenCodeEvent(base, missing), base);
  assert.equal(normalizeOpenCodeEvent(event("session.idle", {
    sessionID: "session-other",
  }), SESSION_ID), null);
  assert.equal(normalizeOpenCodeEvent(event("session.idle", {}), SESSION_ID), null);
});

test("ignores global file.edited because OpenCode 1.18.4 provides no session attribution", () => {
  const base = createOpenCodeSessionState({ sessionId: SESSION_ID });
  const normalized = normalizeOpenCodeEvent(event("file.edited", {
    file: "unsafe-global.js",
  }));

  assert.equal(normalized, null);
  assert.equal(applyOpenCodeEvent(base, normalized), base);
  assert.deepEqual(base.changedFiles, {});
});

test("session.diff consumes data.diff as authoritative attributable file evidence", () => {
  const state = run([
    event("session.diff", {
      sessionID: SESSION_ID,
      diff: [
        {
          file: "src/auth.js",
          additions: 7,
          deletions: 2,
          status: "modified",
        },
        {
          file: "src/auth.test.js",
          additions: 18,
          deletions: 0,
          status: "added",
        },
      ],
    }),
  ]);

  assert.deepEqual(state.changedFiles["src/auth.js"], {
    added: 7,
    removed: 2,
    status: "modified",
    touchedAt: 1,
  });
  assert.equal(state.changedFiles["src/auth.test.js"].added, 18);
  assert.deepEqual(
    changedFilesView(state).map(({ path }) => path),
    ["src/auth.js", "src/auth.test.js"],
  );
});

test("repeated session.diff updates make the most recently changed file newest", () => {
  const state = run([
    event("session.diff", {
      sessionID: SESSION_ID,
      diff: [
        {
          file: "src/a.js",
          additions: 1,
          deletions: 0,
          status: "modified",
        },
      ],
    }),
    event("session.diff", {
      sessionID: SESSION_ID,
      diff: [
        {
          file: "src/b.js",
          additions: 2,
          deletions: 0,
          status: "modified",
        },
      ],
    }),
    event("session.diff", {
      sessionID: SESSION_ID,
      diff: [
        {
          file: "src/a.js",
          additions: 3,
          deletions: 1,
          status: "modified",
        },
      ],
    }),
  ]);

  assert.deepEqual(
    changedFilesView(state).map(({ path, added, removed, justTouched }) => ({
      path,
      added,
      removed,
      justTouched,
    })),
    [
      {
        path: "src/a.js",
        added: 3,
        removed: 1,
        justTouched: true,
      },
      {
        path: "src/b.js",
        added: 2,
        removed: 0,
        justTouched: false,
      },
    ],
  );
});

test("normalizes the v2 tool lifecycle without accepting legacy properties payloads", () => {
  let state = run([
    event("session.next.tool.called", {
      sessionID: SESSION_ID,
      assistantMessageID: "assistant-1",
      callID: "call-1",
      tool: "edit",
      input: { file: "src/auth.js" },
      provider: { executed: false },
    }),
  ]);
  let tool = state.entries.find((entry) => entry.type === "tool");
  assert.equal(tool.id, "call-1");
  assert.equal(tool.state, "running");

  state = applyOpenCodeEvent(
    state,
    normalizeOpenCodeEvent(event("session.next.tool.success", {
      sessionID: SESSION_ID,
      assistantMessageID: "assistant-1",
      callID: "call-1",
      structured: {},
      content: [],
      result: "updated",
      provider: { executed: true },
    })),
  );
  tool = state.entries.find((entry) => entry.type === "tool");
  assert.equal(tool.state, "completed");
  assert.equal(tool.output, "updated");

  assert.equal(normalizeOpenCodeEvent({
    type: "session.next.tool.called",
    properties: {
      sessionID: SESSION_ID,
      callID: "legacy",
      tool: "shell",
    },
  }), null);
});

test("maps permission.v2 request ids and clears only the matching approval", () => {
  let state = run([
    event("permission.v2.asked", {
      id: "permission-1",
      sessionID: SESSION_ID,
      action: "bash",
      resources: ["npm test", "src/**"],
    }),
    event("permission.v2.asked", {
      id: "permission-2",
      sessionID: SESSION_ID,
      action: "edit",
      resources: ["src/auth.js"],
    }),
  ]);

  assert.equal(state.status, "waiting-approval");
  assert.deepEqual(state.approvals[0], {
    id: "permission-1",
    tool: "bash",
    title: "bash",
    detail: "npm test\nsrc/**",
  });

  state = applyOpenCodeEvent(
    state,
    normalizeOpenCodeEvent(event("permission.v2.replied", {
      sessionID: SESSION_ID,
      requestID: "permission-1",
      reply: "once",
    })),
  );
  assert.deepEqual(state.approvals.map(({ id }) => id), ["permission-2"]);
  assert.equal(state.status, "waiting-approval");
});

test("session.updated reads data.info and does not trust top-level metadata aliases", () => {
  const state = run([
    event("session.updated", {
      sessionID: SESSION_ID,
      info: {
        id: SESSION_ID,
        title: "Governed task",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6" },
      },
    }),
  ]);

  assert.equal(state.title, "Governed task");
  assert.equal(state.agent, "build");
  assert.equal(state.model, "openai/gpt-5.6");
});

test("session.status and session.idle drive only the documented status states", () => {
  let state = run([
    event("session.status", {
      sessionID: SESSION_ID,
      status: { type: "busy" },
    }),
  ]);
  assert.equal(state.status, "running");

  state = applyOpenCodeEvent(
    state,
    normalizeOpenCodeEvent(event("session.status", {
      sessionID: SESSION_ID,
      status: {
        type: "retry",
        attempt: 2,
        message: "rate limited",
        next: 100,
      },
    })),
  );
  assert.equal(state.status, "running");

  state = applyOpenCodeEvent(
    state,
    normalizeOpenCodeEvent(event("session.idle", {
      sessionID: SESSION_ID,
    })),
  );
  assert.equal(state.status, "idle");
});

test("todo.updated consumes only data.todos from the owned session", () => {
  const state = run([
    event("todo.updated", {
      sessionID: SESSION_ID,
      todos: [
        { content: "Add regression", status: "completed", priority: "high" },
        { content: "Run browser tests", status: "in_progress", priority: "medium" },
      ],
    }),
  ]);

  assert.deepEqual(state.todos, [
    { label: "Add regression", state: "completed" },
    { label: "Run browser tests", state: "in_progress" },
  ]);
});

test("unknown events and malformed documented events remain non-fatal no-ops", () => {
  const base = createOpenCodeSessionState({ sessionId: SESSION_ID });

  assert.equal(normalizeOpenCodeEvent(event("server.connected", {
    sessionID: SESSION_ID,
  })), null);
  assert.equal(normalizeOpenCodeEvent(event("session.diff", {
    sessionID: SESSION_ID,
    diff: "not-an-array",
  })), null);
  assert.equal(applyOpenCodeEvent(base, null), base);
});

test("the reducer never mutates the input state", () => {
  const base = createOpenCodeSessionState({ sessionId: SESSION_ID });
  Object.freeze(base);

  const next = applyOpenCodeEvent(
    base,
    normalizeOpenCodeEvent(event("session.next.text.delta", {
      sessionID: SESSION_ID,
      assistantMessageID: "assistant-1",
      textID: "text-1",
      delta: "immutable",
    })),
  );

  assert.notEqual(next, base);
  assert.deepEqual(base.entries, []);
});
