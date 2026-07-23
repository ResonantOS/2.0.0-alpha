// Pure extension-side view model for the pinned OpenCode 1.18.4 v2 event
// contract. Events are normalized from documented { type, data } payloads only.

export function createOpenCodeSessionState({ sessionId = "" } = {}) {
  return {
    sessionId: stringValue(sessionId),
    title: "",
    agent: "build",
    model: "",
    status: "idle",
    seq: 0,
    entries: [],
    changedFiles: {},
    approvals: [],
    todos: [],
    context: { tokens: 0, cost: 0 },
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function requiredString(value) {
  const text = stringValue(value);
  return text ? text : null;
}

function sessionMatches(data, activeSessionId) {
  const sessionId = requiredString(data?.sessionID);
  if (!sessionId) return null;
  if (activeSessionId && sessionId !== activeSessionId) return null;
  return sessionId;
}

function displayValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeModel(model) {
  const value = objectValue(model);
  const providerID = requiredString(value?.providerID);
  const id = requiredString(value?.id);
  return providerID && id ? `${providerID}/${id}` : "";
}

function normalizeDiff(data, sessionId) {
  if (!Array.isArray(data.diff)) return null;
  const files = [];
  for (const candidate of data.diff) {
    const file = objectValue(candidate);
    const path = requiredString(file?.file);
    if (
      !path
      || !Number.isFinite(file.additions)
      || !Number.isFinite(file.deletions)
    ) {
      return null;
    }
    files.push({
      path,
      added: file.additions,
      removed: file.deletions,
      status: stringValue(file.status) || "modified",
    });
  }
  return { kind: "session-diff", sessionId, files };
}

function normalizeToolEvent(type, data, sessionId) {
  const id = requiredString(data.callID);
  if (!id) return null;
  if (type === "session.next.tool.called") {
    const tool = requiredString(data.tool);
    if (!tool || !objectValue(data.input)) return null;
    return {
      kind: "tool-called",
      sessionId,
      id,
      tool,
      input: displayValue(data.input),
    };
  }
  if (type === "session.next.tool.success") {
    return {
      kind: "tool-completed",
      sessionId,
      id,
      ok: true,
      output: displayValue(data.result ?? data.content),
    };
  }
  return {
    kind: "tool-completed",
    sessionId,
    id,
    ok: false,
    error: displayValue(data.error) || "failed",
  };
}

function normalizeSessionStatus(data, sessionId) {
  const status = objectValue(data.status);
  if (status?.type === "busy") {
    return { kind: "session-status", sessionId, status: "running" };
  }
  if (status?.type === "idle") {
    return { kind: "session-status", sessionId, status: "idle" };
  }
  if (status?.type === "retry") {
    return { kind: "session-status", sessionId, status: "running" };
  }
  return null;
}

// Normalize a documented OpenCode v2 event. Passing activeSessionId adds an
// early ownership check; the reducer performs the same check from state.
export function normalizeOpenCodeEvent(raw, activeSessionId = "") {
  const event = objectValue(raw);
  const type = requiredString(event?.type);
  if (!type || type === "file.edited") return null;

  const data = objectValue(event.data);
  if (!data) return null;
  const sessionId = sessionMatches(data, stringValue(activeSessionId));
  if (!sessionId) return null;

  switch (type) {
    case "session.next.text.delta": {
      const messageId = requiredString(data.textID);
      if (!messageId || typeof data.delta !== "string") return null;
      return {
        kind: "text-delta",
        sessionId,
        messageId,
        text: data.delta,
      };
    }
    case "session.next.reasoning.delta": {
      const messageId = requiredString(data.reasoningID);
      if (!messageId || typeof data.delta !== "string") return null;
      return {
        kind: "reasoning-delta",
        sessionId,
        messageId,
        text: data.delta,
      };
    }
    case "message.part.delta": {
      const messageId = requiredString(data.partID);
      if (!messageId || typeof data.delta !== "string") return null;
      if (data.field !== "text" && data.field !== "reasoning") return null;
      return {
        kind: data.field === "reasoning" ? "reasoning-delta" : "text-delta",
        sessionId,
        messageId,
        text: data.delta,
      };
    }
    case "session.next.tool.called":
    case "session.next.tool.success":
    case "session.next.tool.failed":
      return normalizeToolEvent(type, data, sessionId);
    case "session.diff":
      return normalizeDiff(data, sessionId);
    case "permission.v2.asked": {
      const id = requiredString(data.id);
      const action = requiredString(data.action);
      if (
        !id
        || !action
        || !Array.isArray(data.resources)
        || data.resources.some((resource) => typeof resource !== "string")
      ) {
        return null;
      }
      return {
        kind: "permission-asked",
        sessionId,
        id,
        tool: action,
        title: action,
        detail: data.resources.join("\n"),
      };
    }
    case "permission.v2.replied": {
      const id = requiredString(data.requestID);
      if (!id) return null;
      return { kind: "permission-replied", sessionId, id };
    }
    case "todo.updated": {
      if (!Array.isArray(data.todos)) return null;
      const todos = [];
      for (const candidate of data.todos) {
        const todo = objectValue(candidate);
        const label = requiredString(todo?.content);
        const state = requiredString(todo?.status);
        if (!label || !state) return null;
        todos.push({ label, state });
      }
      return { kind: "todos", sessionId, todos };
    }
    case "session.updated": {
      const info = objectValue(data.info);
      if (!info || requiredString(info.id) !== sessionId) return null;
      return {
        kind: "session-meta",
        sessionId,
        title: stringValue(info.title),
        agent: stringValue(info.agent),
        model: normalizeModel(info.model),
      };
    }
    case "session.status":
      return normalizeSessionStatus(data, sessionId);
    case "session.idle":
      return { kind: "session-status", sessionId, status: "idle" };
    default:
      return null;
  }
}

function lastEntryOfType(entries, type, messageId) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === type && entry.id === messageId) return entry;
  }
  return null;
}

// Apply a normalized event without mutating state. An owned state accepts only
// events carrying that exact session identifier.
export function applyOpenCodeEvent(state, event) {
  if (!event || typeof event !== "object") return state;
  if (state.sessionId && event.sessionId !== state.sessionId) return state;

  switch (event.kind) {
    case "text-delta":
    case "reasoning-delta": {
      const type = event.kind === "reasoning-delta" ? "reasoning" : "text";
      const next = { ...state, seq: state.seq + 1 };
      const entries = [...state.entries];
      const current = lastEntryOfType(entries, type, event.messageId);
      if (current) {
        const index = entries.lastIndexOf(current);
        entries[index] = {
          ...current,
          text: `${current.text ?? ""}${event.text ?? ""}`,
        };
      } else {
        entries.push({
          type,
          id: event.messageId,
          text: event.text ?? "",
        });
      }
      next.entries = entries;
      next.status = state.approvals.length ? "waiting-approval" : "running";
      return next;
    }
    case "tool-called":
      return {
        ...state,
        seq: state.seq + 1,
        entries: [
          ...state.entries,
          {
            type: "tool",
            id: event.id,
            tool: event.tool,
            input: event.input,
            state: "running",
          },
        ],
        status: state.approvals.length ? "waiting-approval" : "running",
      };
    case "tool-completed":
      return {
        ...state,
        seq: state.seq + 1,
        entries: state.entries.map((entry) => (
          entry.type === "tool" && entry.id === event.id
            ? {
                ...entry,
                state: event.ok ? "completed" : "error",
                output: event.output ?? "",
                error: event.error ?? "",
              }
            : entry
        )),
      };
    case "session-diff": {
      const seq = state.seq + 1;
      const changedFiles = { ...state.changedFiles };
      for (const file of event.files) {
        changedFiles[file.path] = {
          added: file.added,
          removed: file.removed,
          status: file.status,
          touchedAt: seq,
        };
      }
      return { ...state, seq, changedFiles };
    }
    case "permission-asked":
      if (state.approvals.some(({ id }) => id === event.id)) return state;
      return {
        ...state,
        seq: state.seq + 1,
        approvals: [
          ...state.approvals,
          {
            id: event.id,
            tool: event.tool,
            title: event.title,
            detail: event.detail,
          },
        ],
        status: "waiting-approval",
      };
    case "permission-replied": {
      const approvals = state.approvals.filter(({ id }) => id !== event.id);
      return {
        ...state,
        seq: state.seq + 1,
        approvals,
        status: approvals.length ? "waiting-approval" : "running",
      };
    }
    case "todos":
      return {
        ...state,
        seq: state.seq + 1,
        todos: event.todos,
      };
    case "session-meta":
      return {
        ...state,
        seq: state.seq + 1,
        title: event.title || state.title,
        agent: event.agent || state.agent,
        model: event.model || state.model,
      };
    case "session-status":
      return {
        ...state,
        seq: state.seq + 1,
        status: event.status,
      };
    default:
      return state;
  }
}

export function changedFilesView(state) {
  const entries = Object.entries(state.changedFiles ?? {});
  if (!entries.length) return [];
  const newestTouch = Math.max(...entries.map(([, file]) => file.touchedAt ?? 0));
  return entries
    .map(([path, file]) => ({
      path,
      ...file,
      justTouched: (file.touchedAt ?? 0) === newestTouch,
    }))
    .sort((left, right) => (right.touchedAt ?? 0) - (left.touchedAt ?? 0));
}
