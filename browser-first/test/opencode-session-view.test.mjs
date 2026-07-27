import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  renderApprovals,
  renderChangedFiles,
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
  assert.equal(d.querySelector("#t").textContent, "Changed files · 2");
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

  assert.equal(d.querySelector("#t .oc-msg").textContent, "Refactoring auth.");
  const tools = [...d.querySelectorAll("#t .oc-tool")];
  assert.deepEqual(tools.map((c) => c.dataset.state), ["running", "completed"]);
  assert.equal(tools[0].querySelector(".oc-tool-name").textContent, "edit");
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
