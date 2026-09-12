import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOpenCodeEvent,
  changedFilesView,
  createOpenCodeSessionState,
  normalizeGovernedOpenCodeEvent,
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

test("repeated tool.called events upsert by id instead of duplicating cards", () => {
  const state = run([
    { type: "tool.called", properties: { callID: "t1", tool: "shell", input: "npm test" } },
    { type: "tool.called", properties: { callID: "t1", tool: "shell", input: "npm run test:browser-first" } }
  ]);

  const tools = state.entries.filter((e) => e.type === "tool" && e.id === "t1");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].input, "npm run test:browser-first");
  assert.equal(tools[0].state, "running");
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
  assert.deepEqual(state.changedFiles["jwt.ts"], { added: 45, removed: 8, status: "edited", touchedAt: state.changedFiles["jwt.ts"].touchedAt, source: "external" });

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
  assert.deepEqual(state.todos, [{ label: "Shorten TTL", state: "completed", source: "external" }, { label: "Add rotation", state: "in_progress", source: "external" }]);
});

test("the reducer never mutates the input state", () => {
  const base = createOpenCodeSessionState();
  const frozen = Object.freeze(base);
  const next = applyOpenCodeEvent(frozen, normalizeOpenCodeEvent({ type: "file.edited", properties: { path: "x.ts", added: 1, removed: 0 } }));
  assert.notEqual(next, frozen);
  assert.deepEqual(base.changedFiles, {}, "input unchanged");
});

// ---- OpenCode ≥1.18 event schema (captured live from opencode serve 1.18.4) ----

test("v1.18 schema: message.part.delta streams assistant text into the thread", () => {
  let s = createOpenCodeSessionState();
  s = applyOpenCodeEvent(s, normalizeOpenCodeEvent({ type: "message.updated", properties: { info: { id: "msg_a", role: "assistant" } } }));
  s = applyOpenCodeEvent(s, normalizeOpenCodeEvent({ type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "prt_1", field: "text", delta: "OPENCODE " } }));
  s = applyOpenCodeEvent(s, normalizeOpenCodeEvent({ type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "prt_1", field: "text", delta: "LIVE" } }));
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].type, "text");
  assert.equal(s.entries[0].text, "OPENCODE LIVE");
  assert.equal(s.status, "running");
});

test("v1.18 schema: message.updated captures assistant token and cost usage", () => {
  const s = applyOpenCodeEvent(createOpenCodeSessionState(), normalizeOpenCodeEvent({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_a",
        role: "assistant",
        tokens: { input: 1200, output: 300, reasoning: 50, cache: { read: 25, write: 5 } },
        cost: 0.0142
      }
    }
  }));

  assert.equal(s.roles.msg_a, "assistant");
  assert.deepEqual(s.context, { tokens: 1580, cost: 0.0142 });
});

test("v1.18 schema: session.updated captures session token and cost usage", () => {
  const s = applyOpenCodeEvent(createOpenCodeSessionState(), normalizeOpenCodeEvent({
    type: "session.updated",
    properties: {
      info: {
        title: "Usage proof",
        tokens: { input: 2, output: 3, reasoning: 5, cache: { read: 7, write: 11 } },
        cost: 0.123
      }
    }
  }));

  assert.equal(s.title, "Usage proof");
  assert.deepEqual(s.context, { tokens: 28, cost: 0.123 });
});

test("v1.18 schema: message.part.updated snapshot replaces (idempotent with deltas)", () => {
  let s = applyOpenCodeEvent(createOpenCodeSessionState(),
    normalizeOpenCodeEvent({ type: "message.part.delta", properties: { messageID: "msg_a", partID: "prt_1", field: "text", delta: "OPEN" } }));
  s = applyOpenCodeEvent(s, normalizeOpenCodeEvent({
    type: "message.part.updated",
    properties: { part: { type: "text", text: "OPENCODE LIVE PROOF", messageID: "msg_a", sessionID: "ses_1", id: "prt_1" }, time: 1787088674933 }
  }));
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].text, "OPENCODE LIVE PROOF");
});

test("v1.18 schema: user-message parts never enter the thread", () => {
  let s = createOpenCodeSessionState();
  s = applyOpenCodeEvent(s, normalizeOpenCodeEvent({ type: "message.updated", properties: { info: { id: "msg_u", role: "user" } } }));
  s = applyOpenCodeEvent(s, normalizeOpenCodeEvent({ type: "message.part.updated", properties: { part: { type: "text", text: "Say: ping", messageID: "msg_u", id: "prt_u" } } }));
  s = applyOpenCodeEvent(s, normalizeOpenCodeEvent({ type: "message.part.delta", properties: { messageID: "msg_u", partID: "prt_u", field: "text", delta: "more" } }));
  assert.equal(s.entries.length, 0);
});

test("v1.18 schema: session.status busy object maps to string status, idle ends it", () => {
  let s = applyOpenCodeEvent(createOpenCodeSessionState(),
    normalizeOpenCodeEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }));
  assert.equal(s.status, "running");
  s = applyOpenCodeEvent(s, normalizeOpenCodeEvent({ type: "session.idle", properties: { sessionID: "ses_1" } }));
  assert.equal(s.status, "idle");
});

test("v1.18 schema: tool part transitions map to tool entries", () => {
  let s = applyOpenCodeEvent(createOpenCodeSessionState(),
    normalizeOpenCodeEvent({ type: "message.part.updated", properties: { part: { type: "tool", callID: "call_1", tool: "read", state: { status: "running", title: "reading file" } } } }));
  assert.equal(s.entries[0].type, "tool");
  assert.equal(s.entries[0].state, "running");
  s = applyOpenCodeEvent(s, normalizeOpenCodeEvent({ type: "message.part.updated", properties: { part: { type: "tool", callID: "call_1", tool: "read", state: { status: "completed", title: "read done" } } } }));
  assert.equal(s.entries[0].state, "completed");
});

function envelope(sessionId, source, event) {
  return { version: 1, sessionId, source, event };
}

test("normalizeGovernedOpenCodeEvent rejects absent mismatched or invalid source envelopes", () => {
  const event = { type: "text.delta", properties: { messageID: "m1", text: "x" } };
  assert.equal(normalizeGovernedOpenCodeEvent({ version: 1, source: "governed", event }, "s1"), null);
  assert.equal(normalizeGovernedOpenCodeEvent(envelope("other", "governed", event), "s1"), null);
  assert.equal(normalizeGovernedOpenCodeEvent(envelope("s1", "forged", event), "s1"), null);
});

test("mixed-source file records stay external rather than merging as governed", () => {
  let state = createOpenCodeSessionState({ sessionId: "s1" });
  state = applyOpenCodeEvent(state, normalizeGovernedOpenCodeEvent(envelope("s1", "governed", { type: "file.edited", properties: { path: "a.txt", added: 1, removed: 0 } }), "s1"));
  state = applyOpenCodeEvent(state, normalizeGovernedOpenCodeEvent(envelope("s1", "external", { type: "file.edited", properties: { path: "a.txt", added: 2, removed: 0 } }), "s1"));
  assert.equal(state.changedFiles["a.txt"].source, "external");
});

test("different-source transcript entries are not merged", () => {
  let state = createOpenCodeSessionState({ sessionId: "s1" });
  state = applyOpenCodeEvent(state, normalizeGovernedOpenCodeEvent(envelope("s1", "governed", { type: "text.delta", properties: { messageID: "m1", text: "A" } }), "s1"));
  state = applyOpenCodeEvent(state, normalizeGovernedOpenCodeEvent(envelope("s1", "external", { type: "text.delta", properties: { messageID: "m1", text: "B" } }), "s1"));
  assert.deepEqual(state.entries.map((entry) => [entry.text, entry.source]), [["A", "governed"], ["B", "external"]]);
});

test("bridge.closed becomes terminal transport state", () => {
  const state = applyOpenCodeEvent(
    createOpenCodeSessionState({ sessionId: "s1" }),
    normalizeGovernedOpenCodeEvent(envelope("s1", "governed", { type: "bridge.closed", properties: { code: "OPENCODE_REVOKED", error: "OpenCode boundary request failed." } }), "s1")
  );
  assert.deepEqual([state.status, state.transportError?.code], ["error", "OPENCODE_REVOKED"]);
});
