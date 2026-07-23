// The live OpenCode session workspace element (Option A): a governed, streaming
// session view. It owns the reducer state and re-renders on each event. The live
// data source is injected as `subscribe` so the element is decoupled from the
// transport. The caller wires every operation to authenticated, session-bound
// bridge routes; the extension never receives raw OpenCode service authority.

import {
  applyOpenCodeEvent,
  changedFilesView,
  createOpenCodeSessionState,
  normalizeOpenCodeEvent
} from "./opencode-session-model.js";
import {
  renderApprovals,
  renderChangedFiles,
  renderTodoChecklist,
  renderTranscript
} from "./opencode-session-view.js";

const STATUS_TEXT = {
  idle: "Idle",
  running: "Working…",
  "waiting-approval": "Needs approval",
  done: "Done",
  error: "Error"
};

export function createOpenCodeSession({
  document: doc,
  container,
  sessionId = "",
  scope = "",
  subscribe = () => () => {},
  sendPrompt = async () => {},
  replyPermission = async () => {},
  onStop = async () => {}
} = {}) {
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  if (!d || !container) return { destroy: () => {} };

  let state = createOpenCodeSessionState({ sessionId });
  let destroyed = false;
  let stopping = false;
  const pendingPermissionReplies = new Set();

  const section = d.createElement("section");
  section.className = "oc-session";
  section.innerHTML = `
    <div class="oc-top">
      <span class="module-eyebrow">OpenCode</span>
      <span class="oc-preview-label">Governance and evidence preview</span>
      <span class="oc-status-pill" data-status="idle"></span>
      <span class="oc-agent-pill"></span>
      <span class="oc-model-pill"></span>
      <span class="oc-spacer"></span>
      <span class="oc-scope"></span>
      <button class="oc-stop-session" type="button">Stop session</button>
    </div>
    <p class="oc-session-notice" role="status" aria-live="polite" hidden></p>
    <div class="oc-todo" hidden></div>
    <div class="oc-approvals" hidden></div>
    <div class="oc-body">
      <div class="oc-thread" role="log" aria-live="polite"></div>
      <aside class="oc-diffpane">
        <strong class="oc-diff-title">No changes yet</strong>
        <ol class="oc-file-list"></ol>
      </aside>
    </div>
    <form class="oc-composer">
      <textarea rows="2" placeholder="Message OpenCode — refine the task or ask for a diff…"></textarea>
      <button type="submit">Send</button>
    </form>`;
  container.append(section);

  const el = (sel) => section.querySelector(sel);
  const statusPill = el(".oc-status-pill");
  const agentPill = el(".oc-agent-pill");
  const modelPill = el(".oc-model-pill");
  const scopeEl = el(".oc-scope");
  const stopButton = el(".oc-stop-session");
  const noticeEl = el(".oc-session-notice");
  const todoEl = el(".oc-todo");
  const approvalsEl = el(".oc-approvals");
  const threadEl = el(".oc-thread");
  const diffTitleEl = el(".oc-diff-title");
  const fileListEl = el(".oc-file-list");
  const form = el(".oc-composer");
  const input = el(".oc-composer textarea");
  const sendButton = el(".oc-composer button");

  scopeEl.textContent = scope ? `scope: ${scope}` : "";

  function showNotice(text, tone = "neutral") {
    if (destroyed) return;
    const message = typeof text === "string" ? text.trim() : "";
    noticeEl.textContent = message;
    noticeEl.dataset.tone = tone;
    noticeEl.hidden = !message;
  }

  function showTerminated(
    message = "OpenCode session ended. Stop this preview, then start a new governed session.",
  ) {
    showNotice(message, "error");
    input.disabled = true;
    sendButton.disabled = true;
  }

  function render() {
    statusPill.dataset.status = state.status;
    statusPill.textContent = STATUS_TEXT[state.status] ?? state.status;
    agentPill.textContent = state.agent || "";
    modelPill.textContent = state.model || "";
    renderTodoChecklist(todoEl, state.todos, { document: d });
    renderApprovals(approvalsEl, state.approvals, {
      document: d,
      onReply: async (id, decision) => {
        if (pendingPermissionReplies.has(id)) return;
        pendingPermissionReplies.add(id);
        try {
          await replyPermission(id, decision);
          state = applyOpenCodeEvent(state, {
            kind: "permission-replied",
            id,
            sessionId
          });
          render();
        } catch {
          showNotice(
            "Permission reply failed. The request remains pending; stop the session if bridge health is uncertain.",
            "error",
          );
        } finally {
          pendingPermissionReplies.delete(id);
        }
      }
    });
    renderTranscript(threadEl, state.entries, { document: d });
    renderChangedFiles(fileListEl, diffTitleEl, changedFilesView(state), { document: d });
  }

  const unsubscribe = subscribe((raw) => {
    state = applyOpenCodeEvent(state, normalizeOpenCodeEvent(raw, sessionId));
    render();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      await sendPrompt(text);
    } catch {
      showTerminated();
    }
  });

  stopButton.addEventListener("click", async () => {
    if (stopping || destroyed) return;
    stopping = true;
    stopButton.disabled = true;
    showNotice("Stopping governed OpenCode session…");
    try {
      await onStop();
    } catch {
      showNotice(
        "OpenCode session cleanup could not be confirmed. Check runtime status before starting another session.",
        "error",
      );
    } finally {
      stopping = false;
      if (!destroyed) stopButton.disabled = false;
    }
  });

  render();

  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      try { unsubscribe?.(); } catch { /* noop */ }
      section.remove();
    },
    showCursorGap: () => showNotice(
      "Some earlier OpenCode events expired from the bounded bridge buffer. Showing retained session evidence.",
      "warning",
    ),
    showTerminated,
    // Exposed for tests / imperative feeding.
    getState: () => state
  };
}
