// Pure view-model reducer for a live OpenCode session (workspace Option A).
//
// OpenCode's `opencode serve` streams fine-grained events over its SSE bus
// (verified against the live OpenAPI /doc): text/reasoning deltas, a tool
// lifecycle (called -> progress -> success/failed), a dedicated file-edited
// event, a rolling session diff, permission prompts, and todo updates. This
// module turns that raw stream into an ordered transcript + a rolling
// changed-files map + pending approvals + a plan/todo checklist, all as plain
// immutable state so it's trivial to unit test and render.
//
// The exact wire `type` strings can drift between OpenCode versions, so the
// normalizer matches on the meaningful suffix (tool.called, text.delta,
// file.edited, …) rather than a brittle exact string — the precise names are
// pinned at integration time against the running server's /doc.

export function createOpenCodeSessionState() {
  return {
    title: "",
    agent: "build",
    model: "",
    status: "idle", // idle | running | waiting-approval | done | error
    seq: 0, // monotonic tick, used to mark the most-recently-touched file
    entries: [], // ordered transcript: { type: "text"|"reasoning"|"tool", id, ... }
    changedFiles: {}, // path -> { added, removed, status, touchedAt }
    approvals: [], // { id, tool, title, detail }
    todos: [], // { label, state }
    context: { tokens: 0, cost: 0 }
  };
}

const has = (type, needle) => String(type ?? "").toLowerCase().includes(needle);

// Map a raw OpenCode event to a normalized { kind, ... } this reducer handles,
// or null to ignore it. Tolerant of dot/dash/version variation in the type.
export function normalizeOpenCodeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.type ?? raw.kind ?? "";
  const p = raw.properties ?? raw.payload ?? raw;
  if (has(type, "text.delta") || has(type, "text-delta")) {
    return { kind: "text-delta", messageId: p.messageID ?? p.messageId ?? p.id ?? "", text: p.text ?? p.delta ?? "" };
  }
  if (has(type, "reasoning.delta") || has(type, "reasoning-delta")) {
    return { kind: "reasoning-delta", messageId: p.messageID ?? p.messageId ?? p.id ?? "", text: p.text ?? p.delta ?? "" };
  }
  if (has(type, "tool.called") || has(type, "tool-called") || has(type, "tool.input.ended")) {
    return { kind: "tool-called", id: p.callID ?? p.id ?? p.toolCallID ?? "", tool: p.tool ?? p.name ?? "tool", input: p.input ?? p.args ?? p.title ?? "" };
  }
  if (has(type, "tool.success") || has(type, "tool.completed") || has(type, "tool-completed")) {
    return { kind: "tool-completed", id: p.callID ?? p.id ?? p.toolCallID ?? "", ok: true, output: p.output ?? p.result ?? "" };
  }
  if (has(type, "tool.failed") || has(type, "tool.error")) {
    return { kind: "tool-completed", id: p.callID ?? p.id ?? p.toolCallID ?? "", ok: false, error: p.error ?? p.message ?? "failed" };
  }
  if (has(type, "file.edited") || has(type, "file-edited")) {
    return { kind: "file-edited", path: p.path ?? p.file ?? "", added: Number(p.added ?? p.additions ?? 0), removed: Number(p.removed ?? p.deletions ?? 0) };
  }
  if (has(type, "session.diff") || has(type, "session-diff")) {
    const files = Array.isArray(p.files) ? p.files : (Array.isArray(p) ? p : []);
    return { kind: "session-diff", files: files.map((f) => ({ path: f.path ?? f.file ?? "", added: Number(f.added ?? f.additions ?? 0), removed: Number(f.removed ?? f.deletions ?? 0) })) };
  }
  if (has(type, "permission") && (has(type, "asked") || has(type, "ask"))) {
    return { kind: "permission-asked", id: p.id ?? p.permissionID ?? "", tool: p.tool ?? p.type ?? "action", title: p.title ?? p.tool ?? "Approval needed", detail: p.detail ?? p.description ?? p.command ?? "" };
  }
  if (has(type, "permission") && (has(type, "replied") || has(type, "reply"))) {
    return { kind: "permission-replied", id: p.id ?? p.permissionID ?? "" };
  }
  if (has(type, "todo")) {
    const todos = Array.isArray(p.todos) ? p.todos : (Array.isArray(p) ? p : []);
    return { kind: "todos", todos: todos.map((t) => ({ label: t.content ?? t.text ?? t.label ?? "", state: t.status ?? t.state ?? "pending" })) };
  }
  if (has(type, "session.updated") || has(type, "session.status") || has(type, "session-meta")) {
    return { kind: "session-meta", title: p.title, agent: p.agent, model: p.model, status: p.status };
  }
  return null;
}

function lastEntryOfType(entries, type, messageId) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type === type && (!messageId || entry.id === messageId)) return entry;
  }
  return null;
}

// Apply a normalized event, returning a new state (never mutates the input).
export function applyOpenCodeEvent(state, event) {
  if (!event) return state;
  const next = { ...state, seq: state.seq + 1 };

  switch (event.kind) {
    case "text-delta":
    case "reasoning-delta": {
      const type = event.kind === "reasoning-delta" ? "reasoning" : "text";
      const entries = [...state.entries];
      const current = lastEntryOfType(entries, type, event.messageId);
      if (current && (!event.messageId || current.id === event.messageId)) {
        const idx = entries.lastIndexOf(current);
        entries[idx] = { ...current, text: (current.text ?? "") + (event.text ?? "") };
      } else {
        entries.push({ type, id: event.messageId || `msg-${next.seq}`, text: event.text ?? "" });
      }
      next.entries = entries;
      next.status = state.approvals.length ? "waiting-approval" : "running";
      return next;
    }
    case "tool-called": {
      next.entries = [...state.entries, { type: "tool", id: event.id || `tool-${next.seq}`, tool: event.tool, input: event.input, state: "running" }];
      next.status = state.approvals.length ? "waiting-approval" : "running";
      return next;
    }
    case "tool-completed": {
      next.entries = state.entries.map((entry) =>
        entry.type === "tool" && entry.id === event.id
          ? { ...entry, state: event.ok ? "completed" : "error", output: event.output ?? "", error: event.error ?? "" }
          : entry
      );
      return next;
    }
    case "file-edited": {
      if (!event.path) return next;
      const prev = state.changedFiles[event.path];
      next.changedFiles = {
        ...state.changedFiles,
        [event.path]: {
          added: (prev?.added ?? 0) + event.added,
          removed: (prev?.removed ?? 0) + event.removed,
          status: "edited",
          touchedAt: next.seq
        }
      };
      return next;
    }
    case "session-diff": {
      const changedFiles = { ...state.changedFiles };
      for (const file of event.files) {
        if (!file.path) continue;
        changedFiles[file.path] = {
          added: file.added,
          removed: file.removed,
          status: "edited",
          touchedAt: changedFiles[file.path]?.touchedAt ?? next.seq
        };
      }
      next.changedFiles = changedFiles;
      return next;
    }
    case "permission-asked": {
      if (state.approvals.some((a) => a.id === event.id)) return next;
      next.approvals = [...state.approvals, { id: event.id, tool: event.tool, title: event.title, detail: event.detail }];
      next.status = "waiting-approval";
      return next;
    }
    case "permission-replied": {
      next.approvals = state.approvals.filter((a) => a.id !== event.id);
      next.status = next.approvals.length ? "waiting-approval" : "running";
      return next;
    }
    case "todos": {
      next.todos = event.todos;
      return next;
    }
    case "session-meta": {
      if (event.title !== undefined) next.title = event.title;
      if (event.agent !== undefined) next.agent = event.agent;
      if (event.model !== undefined) next.model = event.model;
      if (event.status !== undefined) next.status = event.status;
      return next;
    }
    default:
      return next;
  }
}

// Convenience: the changed files as a sorted array, most-recently-touched first,
// with a `justTouched` flag on the single most-recent file (for a highlight pulse).
export function changedFilesView(state) {
  const entries = Object.entries(state.changedFiles ?? {});
  if (!entries.length) return [];
  const newestTouch = Math.max(...entries.map(([, f]) => f.touchedAt ?? 0));
  return entries
    .map(([path, f]) => ({ path, ...f, justTouched: (f.touchedAt ?? 0) === newestTouch }))
    .sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0));
}
