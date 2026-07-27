// The live OpenCode session workspace element (Option A): a governed, streaming
// session view. It owns the reducer state and re-renders on each event. The live
// data source is injected as `subscribe` so the element is decoupled from the
// transport — at mount, the caller wires `subscribe` to the bridge-proxied
// `opencode serve` SSE stream, and `sendPrompt` / `replyPermission` / `revert`
// to the corresponding server calls.

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
  scope = "",
  subscribe = () => () => {},
  sendPrompt = async () => {},
  replyPermission = async () => {},
  revert = async () => {}
} = {}) {
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  if (!d || !container) return { destroy: () => {} };

  let state = createOpenCodeSessionState();

  const section = d.createElement("section");
  section.className = "oc-session";
  section.innerHTML = `
    <div class="oc-top">
      <span class="module-eyebrow">OpenCode</span>
      <span class="oc-status-pill" data-status="idle"></span>
      <span class="oc-agent-pill"></span>
      <span class="oc-model-pill"></span>
      <span class="oc-spacer"></span>
      <span class="oc-scope"></span>
    </div>
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
  const todoEl = el(".oc-todo");
  const approvalsEl = el(".oc-approvals");
  const threadEl = el(".oc-thread");
  const diffTitleEl = el(".oc-diff-title");
  const fileListEl = el(".oc-file-list");
  const form = el(".oc-composer");
  const input = el(".oc-composer textarea");

  scopeEl.textContent = scope ? `scope: ${scope}` : "";

  function render() {
    statusPill.dataset.status = state.status;
    statusPill.textContent = STATUS_TEXT[state.status] ?? state.status;
    agentPill.textContent = state.agent || "";
    modelPill.textContent = state.model || "";
    renderTodoChecklist(todoEl, state.todos, { document: d });
    renderApprovals(approvalsEl, state.approvals, {
      document: d,
      onReply: async (id, decision) => {
        // Optimistically clear so the UI stays responsive; the server's
        // permission.replied event confirms it.
        state = applyOpenCodeEvent(state, { kind: "permission-replied", id });
        render();
        await replyPermission(id, decision);
      }
    });
    renderTranscript(threadEl, state.entries, { document: d });
    renderChangedFiles(fileListEl, diffTitleEl, changedFilesView(state), {
      document: d,
      onRevert: (path) => void revert(path)
    });
  }

  const unsubscribe = subscribe((raw) => {
    state = applyOpenCodeEvent(state, normalizeOpenCodeEvent(raw));
    render();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    await sendPrompt(text);
  });

  render();

  return {
    destroy: () => {
      try { unsubscribe?.(); } catch { /* noop */ }
      section.remove();
    },
    // Exposed for tests / imperative feeding.
    getState: () => state
  };
}
