export function normalizedRailQuery(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function railSearchMatchesSession(session, query) {
  const normalized = normalizedRailQuery(query);
  if (!normalized) return true;
  const haystack = [
    session?.title,
    session?.workspaceId,
    ...(Array.isArray(session?.messages) ? session.messages.map((message) => message.content) : [])
  ].join(" ").toLowerCase();
  return haystack.includes(normalized);
}

export function isRailVisibleChatSession(session) {
  // Intent citation: docs/architecture/ADR-037-browser-first-chromium-resonantos.md
  // The rail is chat history, not a navigation log. A blank draft exists so the
  // composer has a target, but it should not appear as a real chat until the
  // human or an AI agent has actually written into it.
  return Boolean(session) &&
    !session.archivedAt &&
    Array.isArray(session.messages) &&
    session.messages.length > 0;
}

export function railSearchMatchesProject(project, projectSessions = [], query = "") {
  const normalized = normalizedRailQuery(query);
  if (!normalized) return true;
  const projectHaystack = [project?.name, project?.id].join(" ").toLowerCase();
  return projectHaystack.includes(normalized) || projectSessions.some((session) => railSearchMatchesSession(session, normalized));
}

// Split a project's chats into its folders and the loose (unfiled) chats. A chat
// whose folderId points at a folder not in this project falls back to loose, so
// the tree never renders a chat under a folder it does not belong to.
export function groupProjectSessionsByFolder(projectSessions = [], projectFolders = []) {
  const byFolder = new Map(projectFolders.map((folder) => [folder.id, []]));
  const looseSessions = [];
  for (const session of projectSessions) {
    const bucket = session?.folderId ? byFolder.get(session.folderId) : null;
    if (bucket) bucket.push(session);
    else looseSessions.push(session);
  }
  const folderGroups = projectFolders.map((folder) => ({ folder, sessions: byFolder.get(folder.id) ?? [] }));
  return { folderGroups, looseSessions };
}

// Build the full project → folder → chat tree shared by the main rail and the
// sidecar Chats tab, so both surfaces render the same structure from the same
// store. Sessions should already be filtered to the visible set; `orderItems`
// applies the caller's sort (pinned-first, recency) to projects and folders.
export function buildChatTree(projects = [], folders = [], sessions = [], { orderItems = (items) => [...items] } = {}) {
  const projectIds = new Set(projects.map((project) => project.id));
  const projectNodes = orderItems(projects).map((project) => {
    const projectSessions = sessions.filter((session) => session.projectId === project.id);
    const projectFolders = orderItems(folders.filter((folder) => folder.projectId === project.id));
    const { folderGroups, looseSessions } = groupProjectSessionsByFolder(projectSessions, projectFolders);
    return { project, folderGroups, looseSessions };
  });
  const unfiledSessions = sessions.filter((session) => !session.projectId || !projectIds.has(session.projectId));
  return { projects: projectNodes, unfiledSessions };
}
