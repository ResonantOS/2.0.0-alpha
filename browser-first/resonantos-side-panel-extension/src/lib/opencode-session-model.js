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

export function createOpenCodeSessionState({ sessionId } = {}) {
  return {
    sessionId: typeof sessionId === "string" ? sessionId : "",
    transportError: null,
    metadataSource: "",
    title: "",
    agent: "build",
    model: "",
    status: "idle", // idle | running | waiting-approval | done | error
    seq: 0, // monotonic tick, used to mark the most-recently-touched file
    entries: [], // ordered transcript: { type: "text"|"reasoning"|"tool", id, ... }
    changedFiles: {}, // [path, source] -> { path, added, removed, status, touchedAt, source }
    approvals: [], // { id, tool, title, detail, source }
    todos: [], // { label, state, source }
    context: { tokens: 0, cost: 0 },
    roles: {} // messageId -> "user" | "assistant" (from message.updated; filters user echo)
  };
}

function provenanceSource(value) {
  return value === "governed" ? "governed" : "external";
}

const has = (type, needle) => String(type ?? "").toLowerCase().includes(needle);
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function tokenTotal(tokens) {
  if (Number.isFinite(Number(tokens))) return Number(tokens);
  if (!tokens || typeof tokens !== "object") return 0;
  if (Number.isFinite(Number(tokens.total))) return Number(tokens.total);
  return num(tokens.input)
    + num(tokens.output)
    + num(tokens.reasoning)
    + num(tokens.cache?.read)
    + num(tokens.cache?.write);
}

function usageFrom(info) {
  const tokens = tokenTotal(info?.tokens ?? info?.usage?.tokens);
  const cost = num(info?.cost ?? info?.usage?.cost);
  return tokens || cost ? { tokens, cost } : null;
}

function modelLabel(model) {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  return model.id ?? model.modelID ?? model.name ?? undefined;
}

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
    const files = Array.isArray(p.files) ? p.files : (Array.isArray(p.diff) ? p.diff : (Array.isArray(p) ? p : []));
    return { kind: "session-diff", files: files.map((f) => ({ path: f.path ?? f.file ?? "", added: Number(f.added ?? f.additions ?? 0), removed: Number(f.removed ?? f.deletions ?? 0), source: f.source })) };
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
  // OpenCode ≥1.18 event schema: message metadata arrives via message.updated,
  // and part content streams as message.part.delta (field + delta) with
  // authoritative message.part.updated snapshots. Handled here in addition to
  // the older names above so both server generations render.
  if (has(type, "message.updated") || has(type, "message-updated")) {
    const info = p.info ?? p;
    if (info?.id && info?.role) return { kind: "message-info", id: info.id, role: info.role, context: usageFrom(info) };
    return null;
  }
  if (has(type, "part.delta")) {
    const kind = (p.field ?? "text") === "reasoning" ? "reasoning-delta" : "text-delta";
    if (p.field && p.field !== "text" && p.field !== "reasoning") return null;
    return { kind, messageId: p.messageID ?? p.messageId ?? "", text: p.delta ?? p.text ?? "" };
  }
  if (has(type, "part.updated")) {
    const part = p.part ?? {};
    if (part.type === "text" || part.type === "reasoning") {
      return {
        kind: part.type === "reasoning" ? "reasoning-set" : "text-set",
        messageId: part.messageID ?? part.messageId ?? "",
        partId: part.id ?? "",
        text: part.text ?? ""
      };
    }
    if (part.type === "tool") {
      const st = part.state ?? {};
      if (st.status === "completed") return { kind: "tool-completed", id: part.callID ?? part.id ?? "", ok: true, output: st.output ?? st.title ?? "" };
      if (st.status === "error") return { kind: "tool-completed", id: part.callID ?? part.id ?? "", ok: false, error: st.error ?? "failed" };
      return { kind: "tool-called", id: part.callID ?? part.id ?? "", tool: part.tool ?? "tool", input: st.title ?? st.raw ?? st.input ?? "" };
    }
    return null; // step-start / step-finish / snapshot parts carry no transcript content
  }
  if (has(type, "session.idle")) {
    return { kind: "session-meta", status: "idle" };
  }
  if (has(type, "session.updated") || has(type, "session.status") || has(type, "session-meta")) {
    // status may be a string (old servers) or an object like { type: "busy" }.
    const raw = p.status;
    const status = typeof raw === "string" ? raw : (raw && typeof raw === "object" ? (raw.type === "busy" ? "running" : raw.type) : undefined);
    const info = p.info ?? {};
    return {
      kind: "session-meta",
      title: p.title ?? info.title,
      agent: p.agent ?? info.agent,
      model: modelLabel(p.model ?? info.model ?? info.modelID),
      status,
      context: usageFrom(p) ?? usageFrom(info)
    };
  }
  return null;
}

export function normalizeGovernedOpenCodeEvent(envelope, sessionId) {
  if (!envelope || typeof envelope !== "object") return null;
  if (envelope.version !== 1) return null;
  if (typeof envelope.sessionId !== "string" || !envelope.sessionId || envelope.sessionId !== sessionId) return null;
  if (envelope.source !== "governed" && envelope.source !== "external") return null;
  const event = envelope.event;
  if (!event || typeof event !== "object") return null;
  const type = String(event.type ?? event.kind ?? "");
  const properties = event.properties ?? event.payload ?? event;
  if (type === "bridge.closed") {
    return {
      kind: "transport-error",
      source: envelope.source,
      code: typeof properties.code === "string" ? properties.code : "OPENCODE_STREAM_DISCONNECTED",
      error: typeof properties.error === "string" && properties.error
        ? properties.error
        : "OpenCode boundary request failed."
    };
  }
  if (type === "bridge.ready" || type === "bridge.operation") {
    return {
      kind: "session-meta",
      source: envelope.source,
      operation: type === "bridge.operation" ? properties.operation : undefined,
      ready: type === "bridge.ready"
    };
  }
  const normalized = normalizeOpenCodeEvent(event);
  if (!normalized) return null;
  return { ...normalized, source: envelope.source };
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
  const source = provenanceSource(event.source);

  switch (event.kind) {
    case "transport-error": {
      next.transportError = { code: event.code, error: event.error };
      next.status = "error";
      if (event.source) next.metadataSource = provenanceSource(event.source);
      return next;
    }
    case "message-info": {
      next.roles = { ...state.roles, [event.id]: event.role };
      if (event.context) next.context = event.context;
      return next;
    }
    case "text-delta":
    case "reasoning-delta": {
      // The new schema streams parts for BOTH roles; the composer already shows
      // the human's prompt, so user-message parts are excluded from the thread.
      if (event.messageId && state.roles?.[event.messageId] === "user") return next;
      const type = event.kind === "reasoning-delta" ? "reasoning" : "text";
      const entries = [...state.entries];
      const current = lastEntryOfType(entries, type, event.messageId);
      if (current && (!event.messageId || current.id === event.messageId) && provenanceSource(current.source) === source) {
        const idx = entries.lastIndexOf(current);
        entries[idx] = { ...current, text: (current.text ?? "") + (event.text ?? ""), source };
      } else {
        entries.push({ type, id: event.messageId || `msg-${next.seq}`, text: event.text ?? "", source });
      }
      next.entries = entries;
      next.status = state.approvals.length ? "waiting-approval" : "running";
      return next;
    }
    case "text-set":
    case "reasoning-set": {
      if (event.messageId && state.roles?.[event.messageId] === "user") return next;
      const type = event.kind === "reasoning-set" ? "reasoning" : "text";
      const entries = [...state.entries];
      // Snapshots are authoritative: replace the matching entry's text (matched
      // by part id when known, else by message id), never append — this keeps
      // mixed delta+snapshot streams idempotent.
      const idx = entries.findIndex((entry) => entry.type === type
        && provenanceSource(entry.source) === source
        && ((event.partId && entry.partId === event.partId) || (!entry.partId && entry.id === event.messageId)));
      if (idx >= 0) {
        entries[idx] = { ...entries[idx], partId: event.partId || entries[idx].partId, text: event.text ?? "", source };
      } else {
        entries.push({ type, id: event.messageId || `msg-${next.seq}`, partId: event.partId, text: event.text ?? "", source });
      }
      next.entries = entries;
      next.status = state.approvals.length ? "waiting-approval" : "running";
      return next;
    }
    case "tool-called": {
      const id = event.id || `tool-${next.seq}`;
      const idx = state.entries.findIndex((entry) => entry.type === "tool" && entry.id === id && provenanceSource(entry.source) === source);
      if (idx >= 0) {
        next.entries = state.entries.map((entry, entryIdx) =>
          entryIdx === idx
            ? { ...entry, tool: event.tool, input: event.input, state: "running", output: "", error: "", source }
            : entry
        );
      } else {
        next.entries = [...state.entries, { type: "tool", id, tool: event.tool, input: event.input, state: "running", source }];
      }
      next.status = state.approvals.length ? "waiting-approval" : "running";
      return next;
    }
    case "tool-completed": {
      next.entries = state.entries.map((entry) =>
        entry.type === "tool" && entry.id === event.id && provenanceSource(entry.source) === source
          ? { ...entry, state: event.ok ? "completed" : "error", output: event.output ?? "", error: event.error ?? "", source }
          : entry
      );
      return next;
    }
    case "file-edited": {
      if (!event.path) return next;
      const key = JSON.stringify([event.path, source]);
      const prev = state.changedFiles[key];
      next.changedFiles = {
        ...state.changedFiles,
        [key]: {
          path: event.path,
          added: (prev?.added ?? 0) + event.added,
          removed: (prev?.removed ?? 0) + event.removed,
          status: "edited",
          touchedAt: next.seq,
          source
        }
      };
      return next;
    }
    case "session-diff": {
      const changedFiles = { ...state.changedFiles };
      for (const file of event.files) {
        if (!file.path) continue;
        const fileSource = provenanceSource(file.source ?? event.source);
        const key = JSON.stringify([file.path, fileSource]);
        const prev = changedFiles[key];
        changedFiles[key] = {
          path: file.path,
          added: file.added,
          removed: file.removed,
          status: "edited",
          touchedAt: prev?.touchedAt ?? next.seq,
          source: fileSource
        };
      }
      next.changedFiles = changedFiles;
      return next;
    }
    case "permission-asked": {
      if (state.approvals.some((a) => a.id === event.id)) return next;
      next.approvals = [...state.approvals, { id: event.id, tool: event.tool, title: event.title, detail: event.detail, source }];
      next.status = "waiting-approval";
      return next;
    }
    case "permission-replied": {
      next.approvals = state.approvals.filter((a) => a.id !== event.id);
      next.status = next.approvals.length ? "waiting-approval" : "running";
      return next;
    }
    case "todos": {
      next.todos = (event.todos ?? []).map((todo) => ({
        ...todo,
        source: provenanceSource(todo.source ?? event.source)
      }));
      return next;
    }
    case "session-meta": {
      if (event.title !== undefined) next.title = event.title;
      if (event.agent !== undefined) next.agent = event.agent;
      if (event.model !== undefined) next.model = event.model;
      if (event.status !== undefined) next.status = event.status;
      if (event.context) next.context = event.context;
      if (event.source) next.metadataSource = provenanceSource(event.source);
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
