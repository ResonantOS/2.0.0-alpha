import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createSidePanelChatsTree } from "../resonantos-side-panel-extension/src/lib/side-panel-chats-tree.js";

function setup() {
  const dom = new JSDOM(`<!doctype html><div id="tree"></div>`);
  const document = dom.window.document;
  const projects = [{ id: "p1", name: "Alpha", expanded: true, archivedAt: "" }];
  const folders = [{ id: "f1", projectId: "p1", name: "Specs", expanded: true, archivedAt: "" }];
  const sessions = [
    { id: "s-filed", title: "Filed chat", projectId: "p1", folderId: "f1", archivedAt: "", messages: [{ role: "user", content: "x" }] },
    { id: "s-loose", title: "Project loose chat", projectId: "p1", folderId: "", archivedAt: "", messages: [{ role: "user", content: "y" }] },
    { id: "s-unfiled", title: "Unfiled chat", projectId: "", folderId: "", archivedAt: "", messages: [{ role: "user", content: "z" }] }
  ];
  const opened = [];
  const expandCalls = [];
  const chatSessionStore = {
    getActiveSessionId: () => "s-unfiled",
    getProjects: () => projects,
    getFolders: () => folders,
    getSessions: () => sessions,
    setProjectExpanded: async (id, expanded) => { expandCalls.push(["project", id, expanded]); const p = projects.find((x) => x.id === id); if (p) p.expanded = expanded; },
    setFolderExpanded: async (id, expanded) => { expandCalls.push(["folder", id, expanded]); const f = folders.find((x) => x.id === id); if (f) f.expanded = expanded; }
  };
  const tree = createSidePanelChatsTree({
    container: document.getElementById("tree"),
    document,
    chatSessionStore,
    isVisibleSession: (s) => Array.isArray(s.messages) && s.messages.length > 0 && !s.archivedAt,
    onOpenSession: async (id) => opened.push(id)
  });
  return { dom, document, tree, opened, expandCalls, container: document.getElementById("tree") };
}

test("sidecar chats tree mirrors the project -> folder -> chat structure", () => {
  const { tree, container } = setup();
  tree.render();

  assert.match(container.textContent, /Alpha/, "project renders");
  assert.match(container.textContent, /Specs/, "folder renders");
  assert.ok(container.querySelector(".chats-tree-folder .chats-tree-chat[data-session-id='s-filed']"), "filed chat nests in its folder");
  assert.ok(container.querySelector(".chats-tree-chat[data-session-id='s-loose']"), "project-loose chat renders");
  assert.ok(container.querySelector(".chats-tree-chat[data-session-id='s-unfiled']"), "unfiled chat renders at top level");
});

test("sidecar chats tree marks the active chat and opens on click", () => {
  const { tree, container, opened } = setup();
  tree.render();

  const active = container.querySelector(".chats-tree-chat.active");
  assert.equal(active.dataset.sessionId, "s-unfiled");

  container.querySelector(".chats-tree-chat[data-session-id='s-filed']").click();
  assert.deepEqual(opened, ["s-filed"], "clicking a chat opens it");
});

test("sidecar chats tree collapses a project via its header (shared expand state)", async () => {
  const { tree, container, expandCalls } = setup();
  tree.render();

  container.querySelector(".chats-tree-project > .chats-tree-group-header").click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(expandCalls[0], ["project", "p1", false]);
  assert.equal(container.querySelector(".chats-tree-chat[data-session-id='s-filed']"), null, "collapsed project hides its chats");
});

test("sidecar chats tree shows an empty state when there are no visible chats", () => {
  const dom = new JSDOM(`<!doctype html><div id="tree"></div>`);
  const document = dom.window.document;
  const tree = createSidePanelChatsTree({
    container: document.getElementById("tree"),
    document,
    chatSessionStore: {
      getActiveSessionId: () => "",
      getProjects: () => [],
      getFolders: () => [],
      getSessions: () => []
    },
    isVisibleSession: () => true
  });
  tree.render();
  assert.match(document.getElementById("tree").textContent, /No chats yet/);
});
