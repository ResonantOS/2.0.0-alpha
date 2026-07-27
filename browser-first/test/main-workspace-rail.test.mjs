import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createMainWorkspaceRailController } from "../resonantos-side-panel-extension/src/lib/main-workspace-rail-controller.js";
import {
  buildChatTree,
  groupProjectSessionsByFolder,
  isRailVisibleChatSession,
  normalizedRailQuery,
  railSearchMatchesProject,
  railSearchMatchesSession
} from "../resonantos-side-panel-extension/src/lib/main-workspace-rail.js";

const session = {
  title: "DAO research",
  workspaceId: "answer",
  messages: [
    { role: "user", content: "Find governance links" },
    { role: "assistant", content: "ResonantDAO membership notes" }
  ]
};

test("main workspace rail normalizes search queries", () => {
  assert.equal(normalizedRailQuery("  DAO   Research  "), "dao research");
});

test("main workspace rail search matches session title, workspace, and message content", () => {
  assert.equal(railSearchMatchesSession(session, ""), true);
  assert.equal(railSearchMatchesSession(session, "dao research"), true);
  assert.equal(railSearchMatchesSession(session, "governance links"), true);
  assert.equal(railSearchMatchesSession(session, "opencode"), false);
});

test("main workspace rail search keeps projects visible when project name or child chat matches", () => {
  const project = { id: "project-cosmo", name: "Cosmodestiny" };
  assert.equal(railSearchMatchesProject(project, [], "cosmo"), true);
  assert.equal(railSearchMatchesProject(project, [session], "membership"), true);
  assert.equal(railSearchMatchesProject(project, [session], "unrelated"), false);
});

test("main workspace rail hides blank draft sessions from chat history", () => {
  assert.equal(isRailVisibleChatSession({ title: "New chat", messages: [] }), false);
  assert.equal(isRailVisibleChatSession({ title: "Settings", workspaceId: "settings", messages: [] }), false);
  assert.equal(isRailVisibleChatSession({ title: "Real chat", messages: [{ role: "user", content: "hello" }] }), true);
  assert.equal(isRailVisibleChatSession({ title: "Archived", archivedAt: "2026-06-02T00:00:00.000Z", messages: [{ role: "user", content: "hello" }] }), false);
});

test("main workspace rail controller renders from injected workspace state without global leakage", () => {
  const dom = new JSDOM(`
    <!doctype html>
    <button data-workspace="answer"></button>
    <button data-workspace="settings"></button>
    <button id="clear"></button>
    <ol id="projects"></ol>
    <ol id="chats"></ol>
  `);
  const document = dom.window.document;
  const sessions = [{
    id: "session-1",
    title: "Architecture review",
    workspaceId: "answer",
    projectId: "",
    pinned: false,
    unread: false,
    archivedAt: "",
    updatedAt: "2026-06-02T00:00:00.000Z",
    messages: [{ role: "user", content: "check the architecture" }]
  }];
  const projects = [{
    id: "project-1",
    name: "ResonantOS vNext",
    expanded: true,
    pinned: false,
    archivedAt: "",
    updatedAt: "2026-06-02T00:00:00.000Z"
  }];
  const controller = createMainWorkspaceRailController({
    allowedWorkspaces: new Set(["answer", "settings"]),
    chatSessionStore: {
      getActiveSessionId: () => "session-1",
      getProjects: () => projects,
      getSessions: () => sessions,
      getFolders: () => [],
      switchSession: async () => sessions[0],
    },
    document,
    getActiveWorkspace: () => "answer",
    getRailSearchQuery: () => "",
    isRailVisibleChatSession,
    persistActiveWorkspace: async () => {},
    railChatList: document.querySelector("#chats"),
    railClearSearch: document.querySelector("#clear"),
    railProjectList: document.querySelector("#projects"),
    railSearchMatchesProject,
    railSearchMatchesSession,
    renderAll: () => {},
    setActiveWorkspaceId: () => {},
    updateConnectionLine: () => {},
    window: dom.window,
    workspaceButtons: [...document.querySelectorAll("[data-workspace]")]
  });

  assert.doesNotThrow(() => controller.renderRailNavigation());
  assert.equal(document.querySelector("[data-workspace='answer']").classList.contains("active"), true);
  assert.match(document.querySelector("#chats").textContent, /Architecture review/);
  assert.match(document.querySelector("#projects").textContent, /ResonantOS vNext/);
});

test("main workspace rail groups project sessions into folders and loose chats", () => {
  const folders = [{ id: "f1" }, { id: "f2" }];
  const sessions = [
    { id: "s1", folderId: "f1" },
    { id: "s2", folderId: "f2" },
    { id: "s3", folderId: "" },
    { id: "s4", folderId: "missing" }
  ];

  const { folderGroups, looseSessions } = groupProjectSessionsByFolder(sessions, folders);

  assert.deepEqual(
    folderGroups.map((group) => [group.folder.id, group.sessions.map((session) => session.id)]),
    [["f1", ["s1"]], ["f2", ["s2"]]]
  );
  assert.deepEqual(looseSessions.map((session) => session.id), ["s3", "s4"]);
});

test("main workspace rail renders folders under a project and moves a loose chat via the menu", async () => {
  const dom = new JSDOM(`<!doctype html>
    <button data-workspace="answer"></button>
    <button id="clear"></button>
    <ol id="projects"></ol>
    <ol id="chats"></ol>`);
  const document = dom.window.document;
  const folders = [{ id: "folder-1", projectId: "project-1", name: "Specs", expanded: true, archivedAt: "", updatedAt: "2026-06-02T00:00:00.000Z" }];
  const sessions = [
    { id: "s-filed", title: "Filed chat", workspaceId: "answer", projectId: "project-1", folderId: "folder-1", updatedAt: "2026-06-02T00:00:00.000Z", messages: [{ role: "user", content: "x" }] },
    { id: "s-loose", title: "Loose chat", workspaceId: "answer", projectId: "project-1", folderId: "", updatedAt: "2026-06-02T00:00:00.000Z", messages: [{ role: "user", content: "y" }] }
  ];
  const projects = [{ id: "project-1", name: "Alpha", expanded: true, pinned: false, archivedAt: "", updatedAt: "2026-06-02T00:00:00.000Z" }];
  const setFolderCalls = [];
  const controller = createMainWorkspaceRailController({
    allowedWorkspaces: new Set(["answer"]),
    chatSessionStore: {
      getActiveSessionId: () => "s-loose",
      getProjects: () => projects,
      getSessions: () => sessions,
      getFolders: () => folders,
      switchSession: async () => sessions[0],
      setSessionFolder: async (id, folderId) => { setFolderCalls.push([id, folderId]); return sessions[0]; }
    },
    document,
    getActiveWorkspace: () => "answer",
    getRailSearchQuery: () => "",
    isRailVisibleChatSession,
    persistActiveWorkspace: async () => {},
    railChatList: document.querySelector("#chats"),
    railClearSearch: document.querySelector("#clear"),
    railProjectList: document.querySelector("#projects"),
    railSearchMatchesProject,
    railSearchMatchesSession,
    renderAll: () => {},
    setActiveWorkspaceId: () => {},
    updateConnectionLine: () => {},
    window: dom.window,
    workspaceButtons: [...document.querySelectorAll("[data-workspace]")]
  });

  controller.renderRailNavigation();

  const projectsEl = document.querySelector("#projects");
  assert.match(projectsEl.textContent, /Specs/, "folder name renders");
  assert.match(projectsEl.textContent, /Filed chat/);
  assert.match(projectsEl.textContent, /Loose chat/);
  assert.ok(projectsEl.querySelector(".rail-folder[data-folder-id='folder-1']"), "folder row renders");
  assert.ok(projectsEl.querySelector(".rail-folder-chat-list .rail-chat-button[data-session-id='s-filed']"), "filed chat nests inside the folder");

  const looseButton = [...projectsEl.querySelectorAll(".rail-chat-button")].find((button) => button.dataset.sessionId === "s-loose");
  const moveButton = looseButton.querySelector(".rail-chat-action[data-action='move']");
  moveButton.click();

  const menu = document.querySelector(".rail-move-menu");
  assert.ok(menu, "the move menu opens");
  const item = [...menu.querySelectorAll(".rail-move-item")].find((entry) => entry.textContent === "Specs");
  assert.ok(item, "the menu lists the project's folder");
  item.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(setFolderCalls, [["s-loose", "folder-1"]]);
});

test("main workspace rail builds a project -> folder -> chat tree with unfiled chats", () => {
  const projects = [{ id: "p1", name: "Alpha" }];
  const folders = [{ id: "f1", projectId: "p1", name: "Specs" }];
  const sessions = [
    { id: "s1", projectId: "p1", folderId: "f1" },
    { id: "s2", projectId: "p1", folderId: "" },
    { id: "s3", projectId: "", folderId: "" },
    { id: "s4", projectId: "gone", folderId: "" }
  ];

  const tree = buildChatTree(projects, folders, sessions);

  assert.equal(tree.projects.length, 1);
  assert.deepEqual(
    tree.projects[0].folderGroups.map((group) => [group.folder.id, group.sessions.map((s) => s.id)]),
    [["f1", ["s1"]]]
  );
  assert.deepEqual(tree.projects[0].looseSessions.map((s) => s.id), ["s2"]);
  assert.deepEqual(tree.unfiledSessions.map((s) => s.id), ["s3", "s4"], "no-project and orphaned-project chats are unfiled");
});
