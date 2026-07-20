const defaultNow = () => new Date().toISOString();
const defaultId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const cloneStoredValue = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall through to JSON cloning for storage-shaped values.
    }
  }
  return JSON.parse(JSON.stringify(value));
};

export function createChatSessionStore({
  storage,
  storageKeys,
  getModel,
  getThinkingDepth,
  setModel,
  setThinkingDepth,
  isAllowedModel,
  isAllowedThinkingDepth,
  now = defaultNow,
  createId = defaultId
}) {
  let messages = [];
  let forks = [];
  let attachments = [];
  let sessions = [];
  let projects = [];
  let activeSessionId = "";

  const validMessage = (message) =>
    message &&
    ["user", "assistant", "system"].includes(message.role) &&
    typeof message.content === "string";

  const sessionTitleFromMessages = (items = []) => {
    const firstUser = items.find((message) => message.role === "user");
    const title = String(firstUser?.content ?? "New chat").replace(/\s+/g, " ").trim();
    return title.length > 46 ? `${title.slice(0, 43)}...` : title;
  };

  const normalizeCompactState = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const cloned = cloneStoredValue(value);
    return cloned && typeof cloned === "object" && !Array.isArray(cloned) ? cloned : null;
  };

  const normalizeSourceReferences = (value) => Array.isArray(value)
    ? cloneStoredValue(value)
    : [];

  const compactMetadataFromSession = (session) => {
    const compactState = normalizeCompactState(session?.compactState);
    const sourceReferences = normalizeSourceReferences(session?.sourceReferences);
    return {
      ...(compactState ? { compactState } : {}),
      ...(sourceReferences.length ? { sourceReferences } : {})
    };
  };

  const compactStateForMessages = (compactState, retainedMessages = []) => {
    if (!compactState || typeof compactState !== "object") return undefined;
    const nextCompactState = cloneStoredValue(compactState);
    if (!nextCompactState || typeof nextCompactState !== "object") return undefined;
    const retainedIds = new Set(retainedMessages.map((message) => message.id));
    const firstMessageId = retainedMessages[0]?.id ?? "";
    const lastMessageId = retainedMessages.at(-1)?.id ?? "";

    if (Array.isArray(nextCompactState.preservedRecentMessageIds)) {
      nextCompactState.preservedRecentMessageIds = nextCompactState.preservedRecentMessageIds
        .filter((id) => retainedIds.has(id));
    }

    if (nextCompactState.sourceRange && typeof nextCompactState.sourceRange === "object") {
      const range = nextCompactState.sourceRange;
      if (range.fromMessageId && !retainedIds.has(range.fromMessageId) && firstMessageId) {
        range.fromMessageId = firstMessageId;
      }
      if (range.toMessageId && !retainedIds.has(range.toMessageId) && lastMessageId) {
        range.toMessageId = lastMessageId;
      }
    }

    return nextCompactState;
  };

  const sourceReferencesForMessages = (sourceReferences, retainedMessages = []) => {
    if (!sourceReferences || typeof sourceReferences !== "object") return undefined;
    const retainedIds = new Set(retainedMessages.map((message) => message.id));
    const nextSourceReferences = cloneStoredValue(sourceReferences);
    if (!Array.isArray(nextSourceReferences)) return nextSourceReferences;
    return nextSourceReferences.filter((reference) =>
      !reference?.messageId || retainedIds.has(reference.messageId)
    );
  };

  const normalizeSession = (session) => {
    const normalizedMessages = Array.isArray(session?.messages) ? session.messages.filter(validMessage) : [];
    const titleEdited = Boolean(session?.titleEdited);
    const normalized = {
      id: String(session?.id || `session-${createId()}`),
      title: String(session?.title || sessionTitleFromMessages(normalizedMessages)).trim() || "New chat",
      titleEdited,
      workspaceId: typeof session?.workspaceId === "string" ? session.workspaceId : "answer",
      projectId: typeof session?.projectId === "string" ? session.projectId : "",
      pinned: Boolean(session?.pinned),
      unread: Boolean(session?.unread),
      archivedAt: typeof session?.archivedAt === "string" ? session.archivedAt : "",
      createdAt: session?.createdAt || now(),
      lastOpenedAt: session?.lastOpenedAt || session?.updatedAt || session?.createdAt || now(),
      updatedAt: session?.updatedAt || session?.createdAt || now(),
      messages: normalizedMessages
    };
    const compactState = compactStateForMessages(session?.compactState, normalizedMessages);
    const sourceReferences = sourceReferencesForMessages(session?.sourceReferences, normalizedMessages);
    if (compactState) normalized.compactState = compactState;
    if (sourceReferences) normalized.sourceReferences = sourceReferences;
    return normalized;
  };

  const normalizeProject = (project) => ({
    id: String(project?.id || `project-${createId()}`),
    name: String(project?.name ?? "New project").replace(/\s+/g, " ").trim().slice(0, 80) || "New project",
    pinned: Boolean(project?.pinned),
    expanded: project?.expanded !== false,
    archivedAt: typeof project?.archivedAt === "string" ? project.archivedAt : "",
    createdAt: project?.createdAt || now(),
    updatedAt: project?.updatedAt || project?.createdAt || now()
  });

  const ensureSession = () => {
    if (!sessions.some((session) => !session.archivedAt)) {
      sessions = [normalizeSession({
        id: `session-${createId()}`,
        title: "New chat",
        messages: [],
        createdAt: now(),
        updatedAt: now()
      }), ...sessions];
    }
    if (!activeSessionId || !sessions.some((session) => session.id === activeSessionId && !session.archivedAt)) {
      activeSessionId = sessions.find((session) => !session.archivedAt)?.id || sessions[0].id;
    }
    const active = sessions.find((session) => session.id === activeSessionId && !session.archivedAt)
      ?? sessions.find((session) => !session.archivedAt)
      ?? sessions[0];
    activeSessionId = active.id;
    messages = active.messages.map((message) => ({ ...message }));
  };

  const writeActiveSession = () => {
    if (!sessions.length) {
      sessions = [normalizeSession({
        id: activeSessionId || `session-${createId()}`,
        title: sessionTitleFromMessages(messages),
        messages,
        createdAt: messages[0]?.createdAt || now(),
        updatedAt: messages.at(-1)?.createdAt || now()
      })];
      activeSessionId = sessions[0].id;
    }
    if (!activeSessionId || !sessions.some((session) => session.id === activeSessionId)) {
      activeSessionId = sessions[0].id;
    }
    sessions = sessions.map((session) => session.id === activeSessionId
      ? {
          ...session,
          title: session.titleEdited ? session.title : sessionTitleFromMessages(messages),
          updatedAt: now(),
          messages: messages.map((message) => ({ ...message }))
        }
      : session);
  };

  async function persist() {
    writeActiveSession();
    const payload = {
      [storageKeys.messages]: messages,
      [storageKeys.forks]: forks,
      [storageKeys.sessions]: sessions,
      [storageKeys.projects]: projects,
      [storageKeys.activeSessionId]: activeSessionId,
      [storageKeys.model]: getModel(),
      [storageKeys.thinkingDepth]: getThinkingDepth(),
      [storageKeys.attachments]: attachments
    };
    await storage?.set?.(Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "undefined")
    )).catch(() => undefined);
  }

  async function hydrate() {
    const keys = [
      storageKeys.messages,
      storageKeys.forks,
      storageKeys.sessions,
      storageKeys.projects,
      storageKeys.activeSessionId,
      storageKeys.model,
      storageKeys.thinkingDepth,
      storageKeys.attachments
    ].filter((key) => typeof key === "string" && key.length > 0);
    const settings = await storage?.get?.(keys).catch(() => ({}));
    if (settings?.[storageKeys.model] && isAllowedModel(settings[storageKeys.model])) {
      setModel(settings[storageKeys.model]);
    }
    if (settings?.[storageKeys.thinkingDepth] && isAllowedThinkingDepth(settings[storageKeys.thinkingDepth])) {
      setThinkingDepth(settings[storageKeys.thinkingDepth]);
    }
    const legacyMessages = Array.isArray(settings?.[storageKeys.messages]) ? settings[storageKeys.messages].filter(validMessage) : [];
    sessions = Array.isArray(settings?.[storageKeys.sessions])
      ? settings[storageKeys.sessions].map(normalizeSession)
      : [];
    if (!sessions.length && legacyMessages.length) {
      sessions = [normalizeSession({
        title: sessionTitleFromMessages(legacyMessages),
        messages: legacyMessages,
        createdAt: legacyMessages[0]?.createdAt || now(),
        updatedAt: legacyMessages.at(-1)?.createdAt || now()
      })];
    }
    activeSessionId = String(settings?.[storageKeys.activeSessionId] || sessions[0]?.id || "");
    ensureSession();
    forks = Array.isArray(settings?.[storageKeys.forks]) ? settings[storageKeys.forks] : [];
    projects = Array.isArray(settings?.[storageKeys.projects])
      ? settings[storageKeys.projects].map(normalizeProject)
      : [];
    const activeProjectIds = new Set(projects.filter((project) => !project.archivedAt).map((project) => project.id));
    sessions = sessions.map((session) => session.projectId && !activeProjectIds.has(session.projectId)
      ? { ...session, projectId: "", updatedAt: now() }
      : session);
    attachments = Array.isArray(settings?.[storageKeys.attachments]) ? settings[storageKeys.attachments] : [];
    return snapshot();
  }

  function snapshot() {
    return {
      messages,
      sessions,
      projects,
      activeSessionId,
      forks,
      attachments
    };
  }

  function getMessages() {
    return messages;
  }

  function getForks() {
    return forks;
  }

  function getAttachments() {
    return attachments;
  }

  function getSessions() {
    return sessions;
  }

  function getProjects() {
    return projects;
  }

  function getActiveSessionId() {
    return activeSessionId;
  }

  function getActiveSession() {
    return sessions.find((session) => session.id === activeSessionId) ?? null;
  }

  function findMessage(id) {
    return messages.find((message) => message.id === id) ?? null;
  }

  async function addMessage(role, content, { persist: shouldPersist = true, usage = null } = {}) {
    const text = String(content ?? "").trim();
    if (!text) return null;
    const message = {
      id: createId(),
      role,
      content: text,
      usage,
      createdAt: now()
    };
    messages = [...messages, message];
    writeActiveSession();
    if (shouldPersist) {
      await persist();
    }
    return message;
  }

  async function createSession({ workspaceId = "answer" } = {}) {
    writeActiveSession();
    const session = normalizeSession({
      title: "New chat",
      workspaceId,
      messages: [],
      createdAt: now(),
      updatedAt: now()
    });
    sessions = [session, ...sessions];
    activeSessionId = session.id;
    messages = [];
    attachments = [];
    await persist();
    return session;
  }

  async function ensureFreshSession({ workspaceId = "answer" } = {}) {
    ensureSession();
    const active = getActiveSession();
    const activeIsBlank = active && active.messages.length === 0 && active.title === "New chat";
    if (activeIsBlank) {
      return active;
    }
    return createSession({ workspaceId });
  }

  async function switchSession(id) {
    writeActiveSession();
    const session = sessions.find((item) => item.id === id && !item.archivedAt);
    if (!session) return null;
    activeSessionId = session.id;
    messages = session.messages.map((message) => ({ ...message }));
    sessions = sessions.map((item) => item.id === id
      ? { ...item, unread: false, lastOpenedAt: now() }
      : item);
    attachments = [];
    await persist();
    return session;
  }

  async function renameSession(id, title) {
    const nextTitle = String(title ?? "").replace(/\s+/g, " ").trim();
    if (!nextTitle) return null;
    let renamed = null;
    sessions = sessions.map((session) => {
      if (session.id !== id) return session;
      renamed = {
        ...session,
        title: nextTitle.length > 60 ? `${nextTitle.slice(0, 57)}...` : nextTitle,
        titleEdited: true,
        updatedAt: now()
      };
      return renamed;
    });
    if (!renamed) return null;
    await persist();
    return renamed;
  }

  async function setSessionPinned(id, pinned) {
    let updated = null;
    sessions = sessions.map((session) => {
      if (session.id !== id) return session;
      updated = {
        ...session,
        pinned: Boolean(pinned),
        updatedAt: now()
      };
      return updated;
    });
    if (!updated) return null;
    await persist();
    return updated;
  }

  async function setSessionUnread(id, unread) {
    let updated = null;
    sessions = sessions.map((session) => {
      if (session.id !== id) return session;
      updated = {
        ...session,
        unread: Boolean(unread),
        updatedAt: now()
      };
      return updated;
    });
    if (!updated) return null;
    await persist();
    return updated;
  }

  async function setSessionArchived(id, archived) {
    let updated = null;
    const archivedAt = archived ? now() : "";
    sessions = sessions.map((session) => {
      if (session.id !== id) return session;
      updated = {
        ...session,
        archivedAt,
        unread: false,
        updatedAt: now()
      };
      return updated;
    });
    if (!updated) return null;
    if (archived && activeSessionId === id) {
      const replacement = sessions.find((session) => !session.archivedAt && session.id !== id);
      if (replacement) {
        activeSessionId = replacement.id;
        messages = replacement.messages.map((message) => ({ ...message }));
      } else {
        const session = normalizeSession({
          title: "New chat",
          messages: [],
          createdAt: now(),
          updatedAt: now()
        });
        sessions = [session, ...sessions];
        activeSessionId = session.id;
        messages = [];
      }
    }
    await persist();
    return updated;
  }

  async function setSessionProject(id, projectId = "") {
    const normalizedProjectId = String(projectId ?? "").trim();
    if (normalizedProjectId && !projects.some((project) => project.id === normalizedProjectId && !project.archivedAt)) {
      return null;
    }
    let updated = null;
    sessions = sessions.map((session) => {
      if (session.id !== id) return session;
      updated = {
        ...session,
        projectId: normalizedProjectId,
        updatedAt: now()
      };
      return updated;
    });
    if (!updated) return null;
    await persist();
    return updated;
  }

  async function createProject(name) {
    const project = normalizeProject({
      name,
      createdAt: now(),
      updatedAt: now()
    });
    projects = [project, ...projects];
    await persist();
    return project;
  }

  async function renameProject(id, name) {
    const nextName = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!nextName) return null;
    let updated = null;
    projects = projects.map((project) => {
      if (project.id !== id) return project;
      updated = {
        ...project,
        name: nextName,
        updatedAt: now()
      };
      return updated;
    });
    if (!updated) return null;
    await persist();
    return updated;
  }

  async function setProjectPinned(id, pinned) {
    let updated = null;
    projects = projects.map((project) => {
      if (project.id !== id) return project;
      updated = {
        ...project,
        pinned: Boolean(pinned),
        updatedAt: now()
      };
      return updated;
    });
    if (!updated) return null;
    await persist();
    return updated;
  }

  async function setProjectExpanded(id, expanded) {
    let updated = null;
    projects = projects.map((project) => {
      if (project.id !== id) return project;
      updated = {
        ...project,
        expanded: Boolean(expanded),
        updatedAt: now()
      };
      return updated;
    });
    if (!updated) return null;
    await persist();
    return updated;
  }

  async function setProjectArchived(id, archived) {
    let updated = null;
    const archivedAt = archived ? now() : "";
    projects = projects.map((project) => {
      if (project.id !== id) return project;
      updated = {
        ...project,
        archivedAt,
        updatedAt: now()
      };
      return updated;
    });
    if (!updated) return null;
    await persist();
    return updated;
  }

  async function deleteProject(id) {
    if (!projects.some((project) => project.id === id)) {
      return false;
    }
    projects = projects.filter((project) => project.id !== id);
    sessions = sessions.map((session) => session.projectId === id
      ? { ...session, projectId: "", updatedAt: now() }
      : session);
    await persist();
    return true;
  }

  async function deleteSession(id) {
    if (!sessions.some((session) => session.id === id)) {
      return false;
    }
    sessions = sessions.filter((session) => session.id !== id);
    if (!sessions.length) {
      const session = normalizeSession({
        title: "New chat",
        messages: [],
        createdAt: now(),
        updatedAt: now()
      });
      sessions = [session];
      activeSessionId = session.id;
      messages = [];
    } else if (activeSessionId === id) {
      activeSessionId = sessions[0].id;
      messages = sessions[0].messages.map((message) => ({ ...message }));
    }
    attachments = [];
    await persist();
    return true;
  }

  async function setActiveSessionWorkspace(workspaceId) {
    const normalized = String(workspaceId || "answer");
    sessions = sessions.map((session) => session.id === activeSessionId
      ? { ...session, workspaceId: normalized, updatedAt: now() }
      : session);
    await persist();
    return getActiveSession();
  }

  async function forkFromMessage(id) {
    const index = messages.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const source = getActiveSession();
    const fork = {
      id: `fork-${Date.now()}`,
      sourceMessageId: id,
      createdAt: now(),
      messages: messages.slice(0, index + 1)
    };
    const compactState = compactStateForMessages(source?.compactState, fork.messages);
    const sourceReferences = sourceReferencesForMessages(source?.sourceReferences, fork.messages);
    if (compactState) fork.compactState = compactState;
    if (sourceReferences) fork.sourceReferences = sourceReferences;
    forks = [...forks, fork];
    messages = fork.messages.map((message) => ({ ...message }));
    const session = normalizeSession({
      id: fork.id,
      title: `Fork: ${sessionTitleFromMessages(messages)}`,
      messages,
      createdAt: fork.createdAt,
      updatedAt: fork.createdAt,
      compactState,
      sourceReferences
    });
    sessions = [session, ...sessions];
    activeSessionId = session.id;
    await persist();
    return fork;
  }

  async function forkSession(id = activeSessionId) {
    writeActiveSession();
    const source = sessions.find((session) => session.id === id);
    if (!source) return null;
    const fork = {
      id: `fork-${Date.now()}`,
      sourceSessionId: source.id,
      createdAt: now(),
      messages: source.messages.map((message) => ({ ...message }))
    };
    forks = [...forks, fork];
    const session = normalizeSession({
      id: fork.id,
      title: `Fork: ${source.title || sessionTitleFromMessages(source.messages)}`,
      titleEdited: true,
      workspaceId: source.workspaceId,
      projectId: source.projectId,
      pinned: false,
      messages: fork.messages,
      createdAt: fork.createdAt,
      updatedAt: fork.createdAt,
      ...compactMetadataFromSession(source)
    });
    sessions = [session, ...sessions];
    activeSessionId = session.id;
    messages = session.messages.map((message) => ({ ...message }));
    attachments = [];
    await persist();
    return fork;
  }

  async function deleteMessage(id) {
    const before = messages.length;
    messages = messages.filter((message) => message.id !== id);
    if (messages.length === before) return false;
    writeActiveSession();
    await persist();
    return true;
  }

  async function trimToPreviousUserMessage(id) {
    const index = messages.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const userIndex = messages.slice(0, index).findLastIndex((message) => message.role === "user");
    if (userIndex < 0) return null;
    const userMessage = messages[userIndex];
    messages = messages.slice(0, userIndex + 1);
    writeActiveSession();
    await persist();
    return userMessage;
  }

  async function prepareRegenerationFromMessage(id, { mode = "branch" } = {}) {
    const normalizedMode = mode === "overwrite" ? "overwrite" : "branch";
    const index = messages.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const userIndex = messages.slice(0, index).findLastIndex((message) => message.role === "user");
    if (userIndex < 0) return null;
    const userMessage = { ...messages[userIndex] };

    if (normalizedMode === "overwrite") {
      messages = messages.slice(0, userIndex + 1).map((message) => ({ ...message }));
      writeActiveSession();
      await persist();
      return { mode: normalizedMode, userMessage };
    }

    writeActiveSession();
    const source = getActiveSession();
    const retainedMessages = messages.slice(0, userIndex + 1).map((message) => ({ ...message }));
    const forkId = `fork-${Date.now()}`;
    const createdAt = now();
    const compactState = compactStateForMessages(source?.compactState, retainedMessages);
    const sourceReferences = sourceReferencesForMessages(source?.sourceReferences, retainedMessages);
    const fork = {
      id: forkId,
      sourceSessionId: source?.id ?? activeSessionId,
      sourceMessageId: id,
      regeneratedFromMessageId: id,
      createdAt,
      messages: retainedMessages
    };
    if (compactState) fork.compactState = compactState;
    if (sourceReferences) fork.sourceReferences = sourceReferences;
    forks = [...forks, fork];

    const session = normalizeSession({
      id: fork.id,
      title: `Regenerate: ${sessionTitleFromMessages([userMessage])}`,
      titleEdited: true,
      workspaceId: source?.workspaceId,
      projectId: source?.projectId,
      pinned: false,
      messages: retainedMessages,
      compactState,
      sourceReferences,
      createdAt,
      updatedAt: createdAt
    });
    sessions = [session, ...sessions];
    activeSessionId = session.id;
    messages = session.messages.map((message) => ({ ...message }));
    attachments = [];
    await persist();
    return { mode: normalizedMode, userMessage, fork, session };
  }

  async function addAttachments(nextAttachments) {
    attachments = [...attachments, ...nextAttachments];
    await persist();
    return attachments;
  }

  async function removeAttachment(id) {
    attachments = attachments.filter((attachment) => attachment.id !== id);
    await persist();
    return attachments;
  }

  async function clearAttachments() {
    attachments = [];
    await persist();
    return attachments;
  }

  return {
    addAttachments,
    addMessage,
    clearAttachments,
    createSession,
    createProject,
    deleteMessage,
    deleteProject,
    deleteSession,
    ensureFreshSession,
    findMessage,
    forkFromMessage,
    forkSession,
    getActiveSession,
    getActiveSessionId,
    getAttachments,
    getForks,
    getMessages,
    getProjects,
    getSessions,
    hydrate,
    persist,
    prepareRegenerationFromMessage,
    renameProject,
    renameSession,
    removeAttachment,
    setActiveSessionWorkspace,
    setProjectArchived,
    setProjectExpanded,
    setProjectPinned,
    setSessionArchived,
    setSessionPinned,
    setSessionProject,
    setSessionUnread,
    snapshot,
    switchSession,
    trimToPreviousUserMessage
  };
}
