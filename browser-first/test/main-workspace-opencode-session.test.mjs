import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createOpenCodeSession } from "../resonantos-side-panel-extension/src/lib/main-workspace-opencode-session.js";

function mount(overrides = {}) {
  const dom = new JSDOM(`<!doctype html><div id="host"></div>`);
  const d = dom.window.document;
  let emit = () => {};
  const calls = { prompts: [], replies: [], reverts: [] };
  const session = createOpenCodeSession({
    document: d,
    container: d.getElementById("host"),
    scope: "~/proj/api/auth",
    subscribe: (handler) => { emit = handler; return () => { emit = () => {}; }; },
    sendPrompt: async (t) => calls.prompts.push(t),
    replyPermission: async (id, decision) => calls.replies.push([id, decision]),
    revert: async (p) => calls.reverts.push(p),
    ...overrides
  });
  return { d, emit: (raw) => emit(raw), session, calls };
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
  assert.equal(d.querySelector(".oc-thread .oc-msg").textContent, "Adding JWT rotation.");
  const tool = d.querySelector(".oc-thread .oc-tool");
  assert.equal(tool.dataset.state, "completed");
  // Rolling diff pane picked up the edit.
  assert.equal(d.querySelector(".oc-diff-title").textContent, "Changed files · 1");
  const row = d.querySelector(".oc-file-list .oc-file");
  assert.equal(row.dataset.path, "jwt.ts");
  assert.equal(row.dataset.touched, "true");
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

test("destroy unsubscribes and removes the element", () => {
  const { d, emit, session } = mount();
  session.destroy();
  emit({ type: "file.edited", properties: { path: "late.ts", added: 1, removed: 0 } });
  assert.equal(d.querySelector(".oc-session"), null, "element removed");
});
