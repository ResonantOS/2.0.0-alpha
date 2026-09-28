import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createOpenCodeSession } from "../resonantos-side-panel-extension/src/lib/main-workspace-opencode-session.js";

const SESSION_ID = "ses_test";

function envelope(event, source = "governed") {
  return { version: 1, sessionId: SESSION_ID, source, event };
}

function mount(overrides = {}) {
  const dom = new JSDOM(`<!doctype html><div id="host"></div>`);
  const d = dom.window.document;
  let emit = () => {};
  const calls = { prompts: [], replies: [], reverts: [], aborts: 0 };
  const session = createOpenCodeSession({
    document: d,
    container: d.getElementById("host"),
    scope: "~/proj/api/auth",
    sessionId: SESSION_ID,
    subscribe: (handler) => { emit = handler; return () => { emit = () => {}; }; },
    sendPrompt: async (t) => calls.prompts.push(t),
    onAbort: async () => { calls.aborts += 1; },
    replyPermission: async (id, decision) => calls.replies.push([id, decision]),
    revert: async (p) => calls.reverts.push(p),
    ...overrides
  });
  return { d, emit: (raw) => emit(raw?.version === 1 ? raw : envelope(raw)), session, calls };
}

test("the session element streams events into the transcript and rolling diff pane", () => {
  const { d, emit } = mount();

  emit({ type: "session.updated", properties: { title: "Refactor auth", agent: "build", model: "claude-sonnet", status: "running" } });
  emit({ type: "text.delta", properties: { messageID: "m1", text: "Adding JWT " } });
  emit({ type: "text.delta", properties: { messageID: "m1", text: "rotation." } });
  emit({ type: "tool.called", properties: { callID: "c1", tool: "edit", input: "jwt.ts" } });
  emit({ type: "file.edited", properties: { path: "jwt.ts", added: 42, removed: 8 } });
  emit({ type: "tool.success", properties: { callID: "c1", output: "ok" } });

  assert.equal(d.querySelector(".oc-status-pill").dataset.status, "running");
  assert.equal(d.querySelector(".oc-model-pill").textContent, "claude-sonnet");
  assert.equal(d.querySelector(".oc-context-pill").hidden, true);
  assert.equal(d.querySelector(".oc-thread .oc-msg .oc-msg-content").textContent, "Adding JWT rotation.");
  const tool = d.querySelector(".oc-thread .oc-tool");
  assert.equal(tool.dataset.state, "completed");
  // Rolling diff pane picked up the edit.
  assert.equal(d.querySelector(".oc-diff-title").firstChild.textContent, "Changed files · 1");
  const row = d.querySelector(".oc-file-list .oc-file");
  assert.equal(row.dataset.path, "jwt.ts");
  assert.equal(row.dataset.touched, "true");
});

test("the session element shows context usage when events carry tokens and cost", () => {
  const { d, emit } = mount();
  emit({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_a",
        role: "assistant",
        tokens: { input: 1000, output: 200, reasoning: 30, cache: { read: 40, write: 5 } },
        cost: 0.019
      }
    }
  });

  const pill = d.querySelector(".oc-context-pill");
  assert.equal(pill.hidden, false);
  assert.equal(pill.textContent, "1,275 tokens · $0.0190");
});

test("a permission event surfaces an approval card and gates the session", () => {
  const { d, emit, calls } = mount();
  emit({ type: "permission.asked", properties: { id: "p1", tool: "shell", title: "Run npm test", detail: "npm test" } });

  assert.equal(d.querySelector(".oc-status-pill").dataset.status, "waiting-approval");
  const card = d.querySelector(".oc-approvals .oc-approve");
  assert.equal(card.dataset.id, "p1");

  card.querySelector(".oc-go").dispatchEvent(new d.defaultView.Event("click"));
  assert.deepEqual(calls.replies, [["p1", { approved: true }]]);
  // Optimistically cleared.
  assert.equal(d.querySelector(".oc-approvals").hidden, true);
});

test("the composer sends a prompt and clears", () => {
  const { d, calls } = mount();
  const input = d.querySelector(".oc-composer textarea");
  input.value = "run the tests";
  d.querySelector(".oc-composer").dispatchEvent(new d.defaultView.Event("submit"));
  assert.deepEqual(calls.prompts, ["run the tests"]);
  assert.equal(input.value, "");
});

test("Enter sends, Shift+Enter keeps a newline in the composer", () => {
  const { d, calls } = mount();
  const input = d.querySelector(".oc-composer textarea");

  input.value = "line one";
  input.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(calls.prompts, ["line one"]);
  assert.equal(input.value, "");

  input.value = "line two";
  input.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  assert.deepEqual(calls.prompts, ["line one"]);
  assert.equal(input.value, "line two");
});

test("Enter is ignored while an IME composition is active", () => {
  const { d, calls } = mount();
  const input = d.querySelector(".oc-composer textarea");

  input.value = "kanji";
  input.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  assert.deepEqual(calls.prompts, []);
  assert.equal(input.value, "kanji");

  input.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
  assert.deepEqual(calls.prompts, []);
  assert.equal(input.value, "kanji");
});

test("submitPrompt marks the session running immediately and blocks a fast double Enter", () => {
  const prompts = [];
  const { d } = mount({
    sendPrompt: async (text) => {
      prompts.push(text);
      await new Promise(() => {});
    }
  });
  const input = d.querySelector(".oc-composer textarea");

  input.value = "run once";
  input.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  input.value = "run twice";
  input.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  assert.deepEqual(prompts, ["run once"]);
  assert.equal(d.querySelector(".oc-status-pill").dataset.status, "running");
  assert.equal(d.querySelector(".oc-composer textarea").disabled, true);
});

test("submitPrompt restores the prior status when sending fails", async () => {
  const { d } = mount({
    sendPrompt: async () => {
      throw new Error("bridge down");
    }
  });
  const input = d.querySelector(".oc-composer textarea");

  input.value = "try once";
  d.querySelector(".oc-composer").dispatchEvent(new d.defaultView.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(d.querySelector(".oc-status-pill").dataset.status, "running");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(d.querySelector(".oc-status-pill").dataset.status, "idle");
  assert.equal(d.querySelector(".oc-composer textarea").disabled, false);
});

test("running sessions disable the composer and expose Stop", () => {
  const { d, emit, calls } = mount();
  emit({ type: "session.status", properties: { status: { type: "busy" } } });

  assert.equal(d.querySelector(".oc-composer textarea").disabled, true);
  assert.equal(d.querySelector(".oc-send").disabled, true);
  assert.equal(d.querySelector(".oc-busy-hint").hidden, false);
  const stop = d.querySelector(".oc-stop");
  assert.equal(stop.hidden, false);
  stop.dispatchEvent(new d.defaultView.Event("click"));
  assert.equal(calls.aborts, 1);
});

test("destroy unsubscribes and removes the element", () => {
  const { d, emit, session } = mount();
  session.destroy();
  emit({ type: "file.edited", properties: { path: "late.ts", added: 1, removed: 0 } });
  assert.equal(d.querySelector(".oc-session"), null, "element removed");
});
