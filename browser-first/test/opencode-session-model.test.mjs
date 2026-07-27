import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOpenCodeEvent,
  changedFilesView,
  createOpenCodeSessionState,
  normalizeOpenCodeEvent
} from "../resonantos-side-panel-extension/src/lib/opencode-session-model.js";

// Feed a list of raw OpenCode events through normalize + reduce.
function run(events, state = createOpenCodeSessionState()) {
  return events.reduce((acc, raw) => applyOpenCodeEvent(acc, normalizeOpenCodeEvent(raw)), state);
}

test("normalizeOpenCodeEvent maps the live OpenCode event types (tolerant of suffixes)", () => {
  assert.equal(normalizeOpenCodeEvent({ type: "session.next.text.delta", properties: { text: "hi" } }).kind, "text-delta");
  assert.equal(normalizeOpenCodeEvent({ type: "session.next.tool.called", properties: { callID: "c1", tool: "edit" } }).kind, "tool-called");
  assert.equal(normalizeOpenCodeEvent({ type: "session.next.tool.success", properties: { callID: "c1" } }).kind, "tool-completed");
  assert.equal(normalizeOpenCodeEvent({ type: "file.edited", properties: { path: "a.ts", added: 3, removed: 1 } }).kind, "file-edited");
  assert.equal(normalizeOpenCodeEvent({ type: "session.diff", properties: { files: [] } }).kind, "session-diff");
  assert.equal(normalizeOpenCodeEvent({ type: "permission.asked", properties: { id: "p1" } }).kind, "permission-asked");
  assert.equal(normalizeOpenCodeEvent({ type: "permission.replied", properties: { id: "p1" } }).kind, "permission-replied");
  assert.equal(normalizeOpenCodeEvent({ type: "todo.updated", properties: { todos: [] } }).kind, "todos");
  assert.equal(normalizeOpenCodeEvent({ type: "server.connected" }), null, "unknown events are ignored");
});

test("text deltas stream into a single accumulating transcript entry", () => {
  const state = run([
    { type: "text.delta", properties: { messageID: "m1", text: "Refactor " } },
    { type: "text.delta", properties: { messageID: "m1", text: "the auth " } },
    { type: "text.delta", properties: { messageID: "m1", text: "module." } }
  ]);
  const texts = state.entries.filter((e) => e.type === "text");
  assert.equal(texts.length, 1, "same messageID accumulates, not one entry per delta");
  assert.equal(texts[0].text, "Refactor the auth module.");
});

test("a new messageID starts a new transcript entry", () => {
  const state = run([
    { type: "text.delta", properties: { messageID: "m1", text: "First." } },
    { type: "text.delta", properties: { messageID: "m2", text: "Second." } }
  ]);
  assert.deepEqual(state.entries.filter((e) => e.type === "text").map((e) => e.text), ["First.", "Second."]);
});

test("tool lifecycle: called -> running, then success -> completed on the same card", () => {
  let state = run([{ type: "tool.called", properties: { callID: "t1", tool: "edit", input: "jwt.ts" } }]);
  let tool = state.entries.find((e) => e.type === "tool" && e.id === "t1");
  assert.equal(tool.state, "running");
  assert.equal(state.status, "running");

  state = applyOpenCodeEvent(state, normalizeOpenCodeEvent({ type: "tool.success", properties: { callID: "t1", output: "ok" } }));
  tool = state.entries.find((e) => e.type === "tool" && e.id === "t1");
  assert.equal(tool.state, "completed");
  assert.equal(tool.output, "ok");
  assert.equal(state.entries.filter((e) => e.type === "tool").length, 1, "completion updates the card, not a new one");
});

test("tool failure marks the card errored", () => {
  const state = run([
    { type: "tool.called", properties: { callID: "t1", tool: "shell" } },
    { type: "tool.failed", properties: { callID: "t1", error: "exit 1" } }
  ]);
  const tool = state.entries.find((e) => e.type === "tool");
  assert.equal(tool.state, "error");
  assert.equal(tool.error, "exit 1");
});

test("file edits roll into the changed-files map, accumulate on re-edit, and highlight the newest", () => {
  const state = run([
    { type: "file.edited", properties: { path: "jwt.ts", added: 42, removed: 8 } },
    { type: "file.edited", properties: { path: "auth.ts", added: 5, removed: 2 } },
    { type: "file.edited", properties: { path: "jwt.ts", added: 3, removed: 0 } } // re-edit
  ]);
  assert.deepEqual(state.changedFiles["jwt.ts"], { added: 45, removed: 8, status: "edited", touchedAt: state.changedFiles["jwt.ts"].touchedAt });

  const view = changedFilesView(state);
  assert.equal(view.length, 2);
  assert.equal(view[0].path, "jwt.ts", "most-recently touched is first");
  assert.equal(view[0].justTouched, true);
  assert.equal(view[1].justTouched, false);
});

test("session.diff is authoritative and merges the cumulative file stats", () => {
  const state = run([
    { type: "file.edited", properties: { path: "jwt.ts", added: 1, removed: 0 } },
    { type: "session.diff", properties: { files: [{ path: "jwt.ts", added: 42, removed: 8 }, { path: "auth.test.ts", added: 30, removed: 0 }] } }
  ]);
  assert.equal(state.changedFiles["jwt.ts"].added, 42, "session.diff overwrites with the authoritative cumulative count");
  assert.equal(state.changedFiles["auth.test.ts"].added, 30);
});

test("permission asked adds an approval and blocks; replying clears it", () => {
  let state = run([{ type: "permission.asked", properties: { id: "p1", tool: "shell", title: "Run npm test", detail: "npm test" } }]);
  assert.equal(state.approvals.length, 1);
  assert.equal(state.status, "waiting-approval");

  state = applyOpenCodeEvent(state, normalizeOpenCodeEvent({ type: "permission.replied", properties: { id: "p1" } }));
  assert.equal(state.approvals.length, 0);
  assert.equal(state.status, "running");
});

test("todo updates replace the plan checklist", () => {
  const state = run([{ type: "todo.updated", properties: { todos: [{ content: "Shorten TTL", status: "completed" }, { content: "Add rotation", status: "in_progress" }] } }]);
  assert.deepEqual(state.todos, [{ label: "Shorten TTL", state: "completed" }, { label: "Add rotation", state: "in_progress" }]);
});

test("the reducer never mutates the input state", () => {
  const base = createOpenCodeSessionState();
  const frozen = Object.freeze(base);
  const next = applyOpenCodeEvent(frozen, normalizeOpenCodeEvent({ type: "file.edited", properties: { path: "x.ts", added: 1, removed: 0 } }));
  assert.notEqual(next, frozen);
  assert.deepEqual(base.changedFiles, {}, "input unchanged");
});
