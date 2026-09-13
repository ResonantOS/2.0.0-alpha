// The live OpenCode session workspace element (Option A): a governed, streaming
// session view. It owns the reducer state and re-renders on each event. The live
// data source is injected as `subscribe` so the element is decoupled from the
// transport — at mount, the caller wires `subscribe` to the bridge-proxied
// session event stream, and `sendPrompt` / `replyPermission` / `revert`
// to the corresponding server calls.

import {
  applyOpenCodeEvent,
  changedFilesView,
  createOpenCodeSessionState,
  normalizeGovernedOpenCodeEvent
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
const PUBLIC_OPENCODE_ERROR = "OpenCode boundary request failed.";

export function createOpenCodeSession({
  document: doc,
  container,
  scope = "",
  sessionId = "",
  subscribe = () => () => {},
  sendPrompt = async () => {},
  onAbort = async () => {},
  replyPermission = async () => {},
  revert = async () => {}
} = {}) {
  const d = doc ?? (typeof document !== "undefined" ? document : null);
  if (!d || !container) return { destroy: () => {}, setTransportError: () => {} };

  let destroyed = false;
  let state = createOpenCodeSessionState({ sessionId });

  const section = d.createElement("section");
  section.className = "oc-session";
  section.innerHTML = `
    <div class="oc-top">
      <span class="module-eyebrow">OpenCode</span>
      <span class="oc-status-pill" data-status="idle"></span>
      <span class="oc-context-pill" hidden></span>
      <span class="oc-agent-pill"></span>
      <span class="oc-model-pill"></span>
      <span class="oc-source-pill" hidden></span>
      <span class="oc-transport-error" hidden></span>
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
      <span class="oc-busy-hint" hidden>OpenCode is working</span>
      <button type="button" class="oc-stop" hidden>Stop</button>
      <button type="submit" class="oc-send">Send</button>
    </form>`;
  container.append(section);

  const el = (sel) => section.querySelector(sel);
  const statusPill = el(".oc-status-pill");
  const contextPill = el(".oc-context-pill");
  const agentPill = el(".oc-agent-pill");
  const modelPill = el(".oc-model-pill");
  const sourcePill = el(".oc-source-pill");
  const errorEl = el(".oc-transport-error");
  const scopeEl = el(".oc-scope");
  const todoEl = el(".oc-todo");
  const approvalsEl = el(".oc-approvals");
  const threadEl = el(".oc-thread");
  const diffTitleEl = el(".oc-diff-title");
  const fileListEl = el(".oc-file-list");
  const form = el(".oc-composer");
  const input = el(".oc-composer textarea");
  const busyHint = el(".oc-busy-hint");
  const stopButton = el(".oc-stop");
  const sendButton = el(".oc-send");

  scopeEl.textContent = scope ? `scope: ${scope}` : "";

  function formatContext(context) {
    const tokens = Number(context?.tokens ?? 0);
    const cost = Number(context?.cost ?? 0);
    if (!tokens && !cost) return "";
    const parts = [];
    if (tokens) parts.push(`${tokens.toLocaleString("en-US")} tokens`);
    if (cost) parts.push(`$${cost.toFixed(4)}`);
    return parts.join(" · ");
  }

  function isTerminal() {
    return Boolean(state.transportError) || state.status === "error";
  }

  function render() {
    const running = state.status === "running";
    const disabled = running || isTerminal();
    statusPill.dataset.status = state.status;
    statusPill.textContent = STATUS_TEXT[state.status] ?? state.status;
    const contextText = formatContext(state.context);
    contextPill.hidden = !contextText;
    contextPill.textContent = contextText;
    agentPill.textContent = state.agent || "";
    modelPill.textContent = state.model || "";
    const metadataSource = state.metadataSource === "governed" ? "governed" : state.metadataSource === "external" ? "external" : "";
    sourcePill.hidden = !metadataSource;
    if (metadataSource) {
      sourcePill.dataset.source = metadataSource;
      sourcePill.textContent = metadataSource === "governed" ? "Governed" : "External";
    } else {
      sourcePill.textContent = "";
      delete sourcePill.dataset.source;
    }
    const errorText = state.transportError ? (state.transportError.error || PUBLIC_OPENCODE_ERROR) : "";
    errorEl.hidden = !errorText;
    errorEl.textContent = errorText;
    if (state.transportError?.code) errorEl.dataset.code = state.transportError.code;
    input.disabled = disabled;
    sendButton.disabled = disabled;
    stopButton.hidden = !running || isTerminal();
    busyHint.hidden = !running || isTerminal();
    renderTodoChecklist(todoEl, state.todos, { document: d });
    renderApprovals(approvalsEl, state.approvals, {
      document: d,
      disabled,
      onReply: async (id, decision) => {
        if (destroyed || isTerminal()) return;
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

  const unsubscribe = subscribe((envelope) => {
    if (destroyed) return;
    state = applyOpenCodeEvent(state, normalizeGovernedOpenCodeEvent(envelope, sessionId || state.sessionId));
    render();
  });

  async function submitPrompt() {
    const text = input.value.trim();
    if (!text || state.status === "running" || isTerminal()) return;
    const priorStatus = state.status;
    input.value = "";
    state = { ...state, status: "running" };
    render();
    try {
      await sendPrompt(text);
    } catch (error) {
      if (destroyed || isTerminal()) return;
      state = { ...state, status: priorStatus };
      render();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPrompt();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submitPrompt();
  });

  stopButton.addEventListener("click", () => {
    if (destroyed || isTerminal()) return;
    void onAbort();
  });

  render();

  return {
    destroy: () => {
      destroyed = true;
      try { unsubscribe?.(); } catch { /* noop */ }
      section.remove();
    },
    setTransportError: ({ code, error } = {}) => {
      if (destroyed) return;
      state = {
        ...state,
        status: "error",
        transportError: {
          code: code || "OPENCODE_STREAM_DISCONNECTED",
          error: error || PUBLIC_OPENCODE_ERROR
        }
      };
      render();
    },
    getState: () => state
  };
}
