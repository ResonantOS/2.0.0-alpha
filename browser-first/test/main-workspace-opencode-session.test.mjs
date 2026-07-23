import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createOpenCodeSession } from "../resonantos-side-panel-extension/src/lib/main-workspace-opencode-session.js";

const SESSION_ID = "session-owned";

function event(type, data = {}) {
  return { id: `${type}-event`, type, data };
}

function mount(overrides = {}) {
  const dom = new JSDOM(`<!doctype html><div id="host"></div>`);
  const d = dom.window.document;
  let emit = () => {};
  const calls = { prompts: [], replies: [], stops: 0 };
  const session = createOpenCodeSession({
    document: d,
    container: d.getElementById("host"),
    sessionId: SESSION_ID,
    scope: "~/proj/api/auth",
    subscribe: (handler) => { emit = handler; return () => { emit = () => {}; }; },
    sendPrompt: async (t) => calls.prompts.push(t),
    replyPermission: async (id, decision) => calls.replies.push([id, decision]),
    onStop: async () => { calls.stops += 1; },
    ...overrides
  });
  return { d, emit: (raw) => emit(raw), session, calls };
}

test("the session element streams events into the transcript and rolling diff pane", () => {
  const { d, emit } = mount();

  emit(event("session.updated", {
    sessionID: SESSION_ID,
    info: {
      id: SESSION_ID,
      title: "Refactor auth",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet" }
    }
  }));
  emit(event("session.status", {
    sessionID: SESSION_ID,
    status: { type: "busy" }
  }));
  emit(event("session.next.text.delta", {
    sessionID: SESSION_ID,
    assistantMessageID: "assistant-1",
    textID: "text-1",
    delta: "Adding JWT "
  }));
  emit(event("session.next.text.delta", {
    sessionID: SESSION_ID,
    assistantMessageID: "assistant-1",
    textID: "text-1",
    delta: "rotation."
  }));
  emit(event("session.next.tool.called", {
    sessionID: SESSION_ID,
    assistantMessageID: "assistant-1",
    callID: "call-1",
    tool: "edit",
    input: { file: "jwt.ts" },
    provider: { executed: false }
  }));
  emit(event("session.diff", {
    sessionID: SESSION_ID,
    diff: [{ file: "jwt.ts", additions: 42, deletions: 8, status: "modified" }]
  }));
  emit(event("session.next.tool.success", {
    sessionID: SESSION_ID,
    assistantMessageID: "assistant-1",
    callID: "call-1",
    structured: {},
    content: [],
    result: "ok",
    provider: { executed: true }
  }));

  assert.equal(d.querySelector(".oc-status-pill").dataset.status, "running");
  assert.equal(d.querySelector(".oc-model-pill").textContent, "anthropic/claude-sonnet");
  assert.equal(d.querySelector(".oc-thread .oc-msg").textContent, "Adding JWT rotation.");
  const tool = d.querySelector(".oc-thread .oc-tool");
  assert.equal(tool.dataset.state, "completed");
  // Rolling diff pane picked up the edit.
  assert.equal(d.querySelector(".oc-diff-title").textContent, "Changed files · 1");
  const row = d.querySelector(".oc-file-list .oc-file");
  assert.equal(row.dataset.path, "jwt.ts");
  assert.equal(row.dataset.touched, "true");
});

test("a permission event surfaces an approval card and gates the session", async () => {
  const { d, emit, calls } = mount();
  emit(event("permission.v2.asked", {
    id: "p1",
    sessionID: SESSION_ID,
    action: "shell",
    resources: ["npm test"]
  }));

  assert.equal(d.querySelector(".oc-status-pill").dataset.status, "waiting-approval");
  const card = d.querySelector(".oc-approvals .oc-approve");
  assert.equal(card.dataset.id, "p1");

  card.querySelector(".oc-go").dispatchEvent(new d.defaultView.Event("click"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.replies, [["p1", "once"]]);
  // Optimistically cleared.
  assert.equal(d.querySelector(".oc-approvals").hidden, true);
});

test("a failed permission reply preserves the pending approval and fails closed visibly", async () => {
  const { d, emit } = mount({
    replyPermission: async () => {
      throw new Error("private bridge failure");
    }
  });
  emit(event("permission.v2.asked", {
    id: "p-failed",
    sessionID: SESSION_ID,
    action: "shell",
    resources: ["npm test"]
  }));

  d.querySelector(".oc-approve .oc-go").dispatchEvent(new d.defaultView.Event("click"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(d.querySelector(".oc-approvals").hidden, false);
  assert.equal(d.querySelector(".oc-approve").dataset.id, "p-failed");
  assert.match(d.querySelector(".oc-session-notice").textContent, /permission reply failed/i);
  assert.doesNotMatch(d.querySelector(".oc-session-notice").textContent, /private bridge failure/i);
});

test("the composer sends a prompt and clears", () => {
  const { d, calls } = mount();
  const input = d.querySelector(".oc-composer textarea");
  input.value = "run the tests";
  d.querySelector(".oc-composer").dispatchEvent(new d.defaultView.Event("submit"));
  assert.deepEqual(calls.prompts, ["run the tests"]);
  assert.equal(input.value, "");
});

test("the session is visibly a governance preview and owns stop, gap, and termination states", async () => {
  const { d, session, calls } = mount();

  assert.match(d.querySelector(".oc-preview-label").textContent, /governance and evidence preview/i);

  session.showCursorGap();
  const notice = d.querySelector(".oc-session-notice");
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.tone, "warning");
  assert.match(notice.textContent, /earlier OpenCode events expired/i);

  session.showTerminated();
  assert.equal(notice.dataset.tone, "error");
  assert.match(notice.textContent, /session ended/i);
  assert.equal(d.querySelector(".oc-composer textarea").disabled, true);
  assert.equal(d.querySelector(".oc-composer button").disabled, true);

  d.querySelector(".oc-stop-session").dispatchEvent(new d.defaultView.Event("click"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.stops, 1);
});

test("destroy unsubscribes and removes the element", () => {
  const { d, emit, session } = mount();
  session.destroy();
  emit(event("session.diff", {
    sessionID: SESSION_ID,
    diff: [{ file: "late.ts", additions: 1, deletions: 0, status: "added" }]
  }));
  assert.equal(d.querySelector(".oc-session"), null, "element removed");
});
