import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderDockControl, renderDockPermissions } from "../resonantos-side-panel-extension/src/lib/main-workspace-dock-panels.js";

function dom(html) {
  const d = new JSDOM(`<!doctype html>${html}`).window.document;
  return d;
}

test("main-workspace.html exposes the top-bar dock and relocates Projects/Chats out of the rail", async () => {
  const html = await readFile(
    path.resolve(import.meta.dirname, "..", "resonantos-side-panel-extension", "src", "main-workspace.html"),
    "utf8"
  );
  const d = new JSDOM(html).window.document;
  const required = [
    "dock-tabs", "dock-tab-control", "dock-tab-jobs", "dock-tab-chats", "dock-tab-permissions",
    "dock-popout", "dock-popout-title", "dock-popout-close",
    "dock-control-panel", "dock-control-title", "dock-control-status", "dock-control-step-list",
    "main-browser-jobs", "chats-panel", "rail-project-list", "rail-chat-list", "rail-new-project",
    "permission-manager-panel", "permission-manager-list", "permission-manager-title"
  ];
  for (const id of required) {
    assert.ok(d.getElementById(id), `main-workspace.html is missing #${id}`);
  }
  // Projects/Chats now live inside the Chats tab, not the left rail.
  assert.equal(d.querySelector(".workspace-rail .rail-project-list"), null, "Projects list must not remain in the rail");
  assert.ok(d.querySelector("#chats-panel #rail-project-list"), "Projects list must live in the Chats panel");
  assert.ok(d.querySelector("#chats-panel #rail-chat-list"), "Chats list must live in the Chats panel");

  // The dead top header + Show-Augmentor-sidebar button are gone; new-chat "+"
  // lives in the dock to the right of the Chats tab; the rail has a resize handle.
  assert.equal(d.querySelector(".workspace-topbar"), null, "the dead top header must be removed");
  assert.equal(d.getElementById("open-sidebar"), null, "the Show Augmentor sidebar button must be removed");
  assert.ok(d.querySelector("#dock-tabs #new-chat"), "new-chat must live inside the dock");
  assert.ok(d.getElementById("rail-resize"), "the rail must have a resize handle");
  const dockButtons = [...d.querySelectorAll("#dock-tabs button")].map((b) => b.id);
  assert.deepEqual(dockButtons, [
    "dock-tab-control", "dock-tab-jobs", "dock-tab-permissions", "dock-tab-chats", "new-chat"
  ], "Site removed from the main panel; Chats rightmost with new-chat to its right");
  assert.equal(d.getElementById("dock-tab-site"), null, "the Site tab is removed from the main panel");
  assert.equal(d.getElementById("site-permission-panel"), null, "the orphaned Site panel is removed");
});

test("renderDockPermissions lists stored grants and drops the ask-before-action default", () => {
  const d = dom(`<strong id="t"></strong><ol id="l"></ol>`);
  const list = d.querySelector("#l");
  const title = d.querySelector("#t");
  const count = renderDockPermissions(list, title, {
    "nfl.com": "trusted-for-safe-actions",
    "example.com": "read-only",
    "skip.com": "ask-before-action"
  }, { document: d });

  assert.equal(count, 2, "ask-before-action is a default, not a stored grant");
  assert.equal(title.textContent, "2 browser grants");
  const rows = [...list.querySelectorAll("li")];
  assert.deepEqual(rows.map((r) => r.querySelector("strong").textContent), ["example.com", "nfl.com"]);
  assert.match(rows[1].querySelector("small").textContent, /trusted-for-safe-actions/);
});

test("renderDockPermissions fires onReset with the site key", () => {
  const d = dom(`<strong id="t"></strong><ol id="l"></ol>`);
  const resets = [];
  renderDockPermissions(d.querySelector("#l"), d.querySelector("#t"), { "nfl.com": "read-only" }, {
    document: d,
    onReset: (key) => resets.push(key)
  });
  d.querySelector("#l li button").dispatchEvent(new d.defaultView.Event("click"));
  assert.deepEqual(resets, ["nfl.com"]);
});

test("renderDockPermissions shows an empty state with no grants", () => {
  const d = dom(`<strong id="t"></strong><ol id="l"></ol>`);
  renderDockPermissions(d.querySelector("#l"), d.querySelector("#t"), {}, { document: d });
  assert.equal(d.querySelector("#t").textContent, "No stored browser grants");
  assert.equal(d.querySelectorAll("#l li").length, 0);
});

test("renderDockControl renders the current run's steps via the shared step-list", () => {
  const d = dom(`<strong id="ct"></strong><span id="cs"></span><div id="cl"></div>`);
  const els = { titleEl: d.querySelector("#ct"), statusEl: d.querySelector("#cs"), stepListEl: d.querySelector("#cl") };
  renderDockControl(els, {
    goal: "go to fifa.com and click on news",
    status: "running",
    steps: [
      { label: "Open fifa.com", state: "completed" },
      { label: "Click News", state: "active" }
    ]
  }, { document: d });

  assert.equal(d.querySelector("#ct").textContent, "go to fifa.com and click on news");
  assert.equal(d.querySelector("#cs").textContent, "running");
  assert.equal(d.querySelectorAll("#cl .step-list-item").length, 2);
  assert.equal(d.querySelector("#cl .step-list-pill-text").textContent, "1 of 2");
});

test("renderDockControl shows an idle state when there is no run", () => {
  const d = dom(`<strong id="ct"></strong><span id="cs"></span><div id="cl"></div>`);
  const els = { titleEl: d.querySelector("#ct"), statusEl: d.querySelector("#cs"), stepListEl: d.querySelector("#cl") };
  renderDockControl(els, null, { document: d });
  assert.equal(d.querySelector("#ct").textContent, "No active browser task");
  assert.equal(d.querySelector("#cs").textContent, "idle");
  assert.equal(d.querySelectorAll("#cl .step-list-item").length, 0);
});
