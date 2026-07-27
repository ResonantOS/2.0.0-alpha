// Renders the project → folder → chat tree inside the sidecar "Chats" popout,
// mirroring the main-workspace rail from the same shared store. It is a
// navigation view: expand/collapse (shared with the rail via the store's
// expanded flags) and click-to-open a chat. Filing/renaming stays in the rail.

import { buildChatTree } from "./main-workspace-rail.js";

const CARET_DOWN = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
const CARET_RIGHT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 7 5 5-5 5"/></svg>`;
const FOLDER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h6l2 2h8v10H4z"/></svg>`;

export function createSidePanelChatsTree({
  container,
  document,
  chatSessionStore,
  isVisibleSession = () => true,
  orderItems = (items) => [...items],
  onOpenSession = async () => {}
}) {
  function chatButton(session) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chats-tree-chat";
    button.dataset.sessionId = session.id;
    if (session.id === chatSessionStore.getActiveSessionId()) {
      button.classList.add("active");
      button.setAttribute("aria-current", "true");
    }
    button.textContent = session.title || "New chat";
    button.title = session.title || "New chat";
    button.addEventListener("click", () => void onOpenSession(session.id));
    return button;
  }

  function groupHeader(label, expanded, onToggle) {
    const header = document.createElement("button");
    header.type = "button";
    header.className = "chats-tree-group-header";
    header.setAttribute("aria-expanded", String(Boolean(expanded)));
    header.innerHTML = `<span class="chats-tree-caret">${expanded ? CARET_DOWN : CARET_RIGHT}</span>${FOLDER_ICON}<span class="chats-tree-label"></span>`;
    header.querySelector(".chats-tree-label").textContent = label; // textContent avoids HTML injection
    header.addEventListener("click", () => void onToggle());
    return header;
  }

  function renderFolderNode(folder, sessions) {
    const wrap = document.createElement("div");
    wrap.className = "chats-tree-folder";
    wrap.append(groupHeader(folder.name, folder.expanded, async () => {
      await chatSessionStore.setFolderExpanded(folder.id, !folder.expanded);
      render();
    }));
    if (folder.expanded) {
      const body = document.createElement("div");
      body.className = "chats-tree-group-body";
      if (!sessions.length) {
        const empty = document.createElement("p");
        empty.className = "chats-tree-empty";
        empty.textContent = "Empty folder.";
        body.append(empty);
      }
      for (const session of sessions) body.append(chatButton(session));
      wrap.append(body);
    }
    return wrap;
  }

  function renderProjectNode({ project, folderGroups, looseSessions }) {
    const wrap = document.createElement("div");
    wrap.className = "chats-tree-project";
    wrap.append(groupHeader(project.name, project.expanded, async () => {
      await chatSessionStore.setProjectExpanded(project.id, !project.expanded);
      render();
    }));
    if (project.expanded) {
      const body = document.createElement("div");
      body.className = "chats-tree-group-body";
      for (const group of folderGroups) body.append(renderFolderNode(group.folder, group.sessions));
      for (const session of looseSessions) body.append(chatButton(session));
      if (!folderGroups.length && !looseSessions.length) {
        const empty = document.createElement("p");
        empty.className = "chats-tree-empty";
        empty.textContent = "No chats in this project.";
        body.append(empty);
      }
      wrap.append(body);
    }
    return wrap;
  }

  function render() {
    const sessions = chatSessionStore.getSessions().filter((session) => isVisibleSession(session));
    const projects = chatSessionStore.getProjects().filter((project) => !project.archivedAt);
    const folders = chatSessionStore.getFolders().filter((folder) => !folder.archivedAt);
    const tree = buildChatTree(projects, folders, sessions, { orderItems });
    container.replaceChildren();
    if (!tree.projects.length && !tree.unfiledSessions.length) {
      const empty = document.createElement("p");
      empty.className = "chats-tree-empty";
      empty.textContent = "No chats yet. Start one in the composer.";
      container.append(empty);
      return;
    }
    for (const node of tree.projects) container.append(renderProjectNode(node));
    for (const session of tree.unfiledSessions) container.append(chatButton(session));
  }

  return { render };
}
