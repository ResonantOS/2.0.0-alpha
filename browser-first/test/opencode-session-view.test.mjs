import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  renderApprovals,
  renderChangedFiles,
  renderDiffContent,
  renderTodoChecklist,
  renderTranscript
} from "../resonantos-side-panel-extension/src/lib/opencode-session-view.js";

function dom(html = "") {
  return new JSDOM(`<!doctype html>${html}`).window.document;
}

test("renderChangedFiles rows carry path, counts, and highlight the newest edit", () => {
  const d = dom(`<strong id="t"></strong><ol id="l"></ol>`);
  const n = renderChangedFiles(d.querySelector("#l"), d.querySelector("#t"), [
    { path: "jwt.ts", added: 45, removed: 8, justTouched: true },
    { path: "auth.ts", added: 5, removed: 2, justTouched: false }
  ], { document: d });

  assert.equal(n, 2);
  assert.equal(d.querySelector("#t").firstChild.textContent, "Changed files · 2");
  const rows = [...d.querySelectorAll("#l .oc-file")];
  assert.equal(rows[0].dataset.path, "jwt.ts");
  assert.equal(rows[0].dataset.touched, "true", "the newest edit is highlighted");
  assert.equal(rows[1].dataset.touched, undefined);
  assert.equal(rows[0].querySelector(".oc-add").textContent, "+45");
  assert.equal(rows[0].querySelector(".oc-del").textContent, "−8");
});

test("renderChangedFiles revert button fires onRevert with the path", () => {
  const d = dom(`<strong id="t"></strong><ol id="l"></ol>`);
  const reverted = [];
  renderChangedFiles(d.querySelector("#l"), d.querySelector("#t"), [{ path: "jwt.ts", added: 1, removed: 0 }], {
    document: d,
    onRevert: (p) => reverted.push(p)
  });
  d.querySelector("#l .oc-revert").dispatchEvent(new d.defaultView.Event("click"));
  assert.deepEqual(reverted, ["jwt.ts"]);
});

test("renderApprovals renders a card per approval and routes the decision", () => {
  const d = dom(`<div id="a"></div>`);
  const replies = [];
  renderApprovals(d.querySelector("#a"), [{ id: "p1", tool: "shell", title: "Run npm test", detail: "npm test" }], {
    document: d,
    onReply: (id, decision) => replies.push([id, decision])
  });
  const card = d.querySelector("#a .oc-approve");
  assert.equal(card.dataset.id, "p1");
  assert.match(card.querySelector("code").textContent, /npm test/);
  card.querySelector(".oc-go").dispatchEvent(new d.defaultView.Event("click"));
  card.querySelector(".oc-no").dispatchEvent(new d.defaultView.Event("click"));
  assert.deepEqual(replies, [["p1", { approved: true }], ["p1", { approved: false }]]);
});

test("renderApprovals hides the container when there is nothing to approve", () => {
  const d = dom(`<div id="a"></div>`);
  renderApprovals(d.querySelector("#a"), [], { document: d });
  assert.equal(d.querySelector("#a").hidden, true);
});

test("renderTranscript renders prose blocks and tool cards with live state", () => {
  const d = dom(`<div id="t"></div>`);
  renderTranscript(d.querySelector("#t"), [
    { type: "text", id: "m1", text: "Refactoring auth." },
    { type: "tool", id: "c1", tool: "edit", input: "jwt.ts", state: "running" },
    { type: "tool", id: "c2", tool: "shell", input: "npm test", state: "completed" }
  ], { document: d });

  assert.equal(d.querySelector("#t .oc-msg .oc-msg-content").textContent, "Refactoring auth.");
  assert.equal(d.querySelector("#t .oc-msg .oc-badge").textContent, "External");
  assert.equal(d.querySelector("#t .oc-msg .oc-badge").dataset.source, "external");
  const tools = [...d.querySelectorAll("#t .oc-tool")];
  assert.deepEqual(tools.map((c) => c.dataset.state), ["running", "completed"]);
  assert.equal(tools[0].querySelector(".oc-tool-name").textContent, "edit");
});

test("renderTranscript renders assistant markdown fences as pre/code DOM nodes", () => {
  const d = dom(`<div id="t"></div>`);
  renderTranscript(d.querySelector("#t"), [
    { type: "text", id: "m1", text: "# Patch\n\nUse `npm test`.\n\n```js\nconst ok = true;\n```\n\n[docs](https://example.test/docs)" }
  ], { document: d });

  const message = d.querySelector("#t .oc-msg");
  assert.equal(message.querySelector("h1").textContent, "Patch");
  assert.equal(message.querySelector("p code").textContent, "npm test");
  assert.equal(message.querySelector("pre code").textContent, "const ok = true;");
  assert.equal(message.querySelector("a"), null, "agent links are rendered as text, not clickable anchors");
  assert.match(message.textContent, /docs \(https:\/\/example\.test\/docs\)/);
});

test("renderTranscript closes code fences only with a fence at least as long as the opener", () => {
  const d = dom(`<div id="t"></div>`);
  renderTranscript(d.querySelector("#t"), [
    { type: "text", id: "m1", text: "````\nconst inner = `ok`;\n```\nstill code\n````\n\nafter" }
  ], { document: d });

  const message = d.querySelector("#t .oc-msg");
  assert.equal(message.querySelector("pre code").textContent, "const inner = `ok`;\n```\nstill code");
  assert.equal(message.querySelector("p").textContent, "after");
});

test("renderTranscript keeps snake_case identifiers literal while allowing delimited underscore emphasis", () => {
  const d = dom(`<div id="t"></div>`);
  renderTranscript(d.querySelector("#t"), [
    { type: "text", id: "m1", text: "Keep snake_case_identifier literal, but _emphasize this_ here." }
  ], { document: d });

  const message = d.querySelector("#t .oc-msg-content");
  assert.equal(message.textContent, "Keep snake_case_identifier literal, but emphasize this here.");
  assert.deepEqual([...message.querySelectorAll("em")].map((node) => node.textContent), ["emphasize this"]);
});

test("renderTranscript renders bold italic lists and raw html as safe text", () => {
  const d = dom(`<div id="t"></div>`);
  renderTranscript(d.querySelector("#t"), [
    { type: "text", id: "m1", text: "## Plan\n\n- **Build** UI\n- *Test* output\n\n1. Ship\n2. Watch <img src=x onerror=alert(1)>" }
  ], { document: d });

  const message = d.querySelector("#t .oc-msg");
  assert.equal(message.querySelector("h2").textContent, "Plan");
  assert.equal(message.querySelector("ul strong").textContent, "Build");
  assert.equal(message.querySelector("ul em").textContent, "Test");
  assert.deepEqual([...message.querySelectorAll("ol li")].map((li) => li.textContent), ["Ship", "Watch <img src=x onerror=alert(1)>"]);
  assert.equal(message.querySelector("img"), null, "raw html is never parsed as DOM");
});

test("renderTranscript keeps tool output collapsed until expanded", () => {
  const d = dom(`<div id="t"></div>`);
  renderTranscript(d.querySelector("#t"), [
    { type: "tool", id: "c1", tool: "shell", input: "npm test", state: "completed", output: "all tests passed" }
  ], { document: d });

  const details = d.querySelector("#t .oc-tool-output");
  assert.equal(details.open, false);
  assert.equal(details.querySelector("summary").textContent, "Show output");
  assert.equal(details.querySelector("pre").textContent, "all tests passed");
});

test("renderTranscript expands tool errors and truncates long output", () => {
  const d = dom(`<div id="t"></div>`);
  renderTranscript(d.querySelector("#t"), [
    { type: "tool", id: "c1", tool: "shell", input: "npm test", state: "error", error: "x".repeat(4010) }
  ], { document: d });

  const details = d.querySelector("#t .oc-tool-output");
  assert.equal(details.open, true);
  assert.equal(details.dataset.kind, "error");
  assert.equal(details.querySelector("pre").textContent.length, 4012);
  assert.match(details.querySelector("pre").textContent, /\n\[truncated\]$/);
});

test("renderTranscript adds a copy button for each assistant text block", async () => {
  const d = dom(`<div id="t"></div>`);
  const copied = [];
  renderTranscript(d.querySelector("#t"), [
    { type: "text", id: "m1", text: "Copy this raw **markdown**." }
  ], {
    document: d,
    clipboard: { writeText: async (value) => copied.push(value) }
  });

  d.querySelector(".oc-msg-copy").dispatchEvent(new d.defaultView.Event("click"));
  await Promise.resolve();
  assert.deepEqual(copied, ["Copy this raw **markdown**."]);
});

test("renderDiffContent renders collapsible unified patches with line classes", () => {
  const d = dom(`<div id="diff"></div>`);
  renderDiffContent(d.querySelector("#diff"), [
    { path: "src/app.js", patch: "@@ -1,2 +1,2 @@\n-old\n+new\n context" },
    { file: "README.md", hunks: [{ lines: ["-before", "+after"] }] }
  ], { document: d });

  const files = [...d.querySelectorAll(".oc-patch-file")];
  assert.equal(files.length, 2);
  assert.equal(files[0].querySelector("summary").textContent, "src/app.js");
  assert.deepEqual([...files[0].querySelectorAll(".oc-patch-line")].map((line) => line.dataset.kind), ["meta", "remove", "add", "context"]);
  assert.equal(files[1].querySelector(".oc-patch-add").textContent, "+after");
});

test("renderTodoChecklist maps OpenCode statuses to the shared step-list", () => {
  const d = dom(`<div id="td"></div>`);
  renderTodoChecklist(d.querySelector("#td"), [
    { label: "Shorten TTL", state: "completed" },
    { label: "Add rotation", state: "in_progress" },
    { label: "Update tests", state: "pending" }
  ], { document: d });

  const items = [...d.querySelectorAll("#td .step-list-item")];
  assert.deepEqual(items.map((i) => i.dataset.state), ["completed", "active", "pending"]);
  assert.equal(d.querySelector("#td").hidden, false);
});
