import {
  contextUsageSnapshot,
  modelLabel,
  renderContextMemoryPopover,
  supportsThinkingDepth,
  updateContextMeterElement
} from "./composer-runtime.js";

export function createSidePanelUiController(dependencies) {
  const {
    activityDetail,
    activityLabel,
    activityPanel,
    chatSessionStore,
    commandForm,
    commandInput,
    composerNotice,
    connectionLine,
    contextDock,
    contextMeter,
    contextPopover,
    contextToggleButton,
    controlMonitor,
    controlPreflightBody,
    controlPreflightCard,
    controlPreflightTitle,
    getContextDockExpanded,
    getLastSnapshot,
    getPendingControlPreflight,
    getStatusLabel,
    getTurnBusy,
    jobMonitor,
    modelSelect,
    permissionManagerPanel,
    setStatusLabel,
    setTurnBusyState,
    sitePermissionPanel,
    taskConsentPanel,
    thinkingDepthSelect,
    transcript,
    window,
  } = dependencies;

  let activityTimer = null;
  let contextPopoverOpen = false;
  let contextCompactNotice = "";

  const scrollTranscriptToBottom = () => {
    window.requestAnimationFrame(() => {
      transcript.scrollTop = transcript.scrollHeight;
    });
  };

  const updateContextDockVisibility = () => {
    const hasVisiblePanel = [
      activityPanel,
      sitePermissionPanel,
      taskConsentPanel,
      permissionManagerPanel,
      controlPreflightCard,
      jobMonitor,
      controlMonitor
    ].some((panel) => !panel.hidden);
    contextDock.hidden = !hasVisiblePanel;
    contextToggleButton.title = getContextDockExpanded()
      ? "Hide context usage and browser status"
      : "Show context usage and browser status";
    contextToggleButton.setAttribute("aria-label", contextToggleButton.title);
    contextToggleButton.setAttribute("aria-expanded", getContextDockExpanded() ? "true" : "false");
    scrollTranscriptToBottom();
  };

  const setActivity = (phase, label, detail = "") => {
    if (activityTimer) {
      window.clearTimeout(activityTimer);
      activityTimer = null;
    }
    activityPanel.hidden = false;
    activityPanel.dataset.phase = phase;
    activityLabel.textContent = label;
    activityDetail.textContent = detail;
    updateContextDockVisibility();
  };

  const clearActivity = () => {
    activityPanel.hidden = true;
    activityPanel.dataset.phase = "idle";
    activityLabel.textContent = "Ready";
    activityDetail.textContent = "";
    updateContextDockVisibility();
  };

  const clearActivitySoon = (delay = 2200) => {
    if (activityTimer) {
      window.clearTimeout(activityTimer);
    }
    activityTimer = window.setTimeout(clearActivity, delay);
  };

  const renderControlPreflightCard = () => {
    const pendingControlPreflight = getPendingControlPreflight();
    if (!pendingControlPreflight) {
      controlPreflightCard.hidden = true;
      updateContextDockVisibility();
      return;
    }
    controlPreflightCard.hidden = false;
    controlPreflightTitle.textContent = `${pendingControlPreflight.taskClass} control on ${pendingControlPreflight.siteKey}`;
    controlPreflightBody.textContent = `${pendingControlPreflight.goal} · ${pendingControlPreflight.mode}. Approve once, allow this task class for one execution, or trust safe actions for this site. Augmentor may read, scroll, click safe controls, and type into editable fields. Wallet, login, credential, payment, signing, transfer, destructive, and public-submit boundaries remain human-gated.`;
    updateContextDockVisibility();
  };

  const setTurnBusy = (busy) => {
    setTurnBusyState(Boolean(busy));
    commandInput.disabled = Boolean(busy);
    const sendButton = commandForm.querySelector(".send-button");
    sendButton.disabled = false;
    sendButton.classList.toggle("is-stop", Boolean(busy));
    sendButton.setAttribute("aria-label", busy ? "Stop response" : "Send message");
    sendButton.title = busy ? "Stop response" : "Send message";
    sendButton.innerHTML = busy
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="8" height="8" rx="1.8"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
  };

  const runBusyUiAction = async (action) => {
    if (getTurnBusy()) return;
    setTurnBusy(true);
    try {
      await action();
    } finally {
      setTurnBusy(false);
      if (getStatusLabel() === "Ready") {
        clearActivitySoon();
      }
    }
  };

  const updateConnectionLine = () => {
    const model = modelLabel(modelSelect.value);
    thinkingDepthSelect.hidden = !supportsThinkingDepth(modelSelect.value);
    connectionLine.title = `Connected to ${model} · ${getStatusLabel()}`;
    connectionLine.setAttribute("aria-label", connectionLine.title);
    connectionLine.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h4l2-7 4 14 2-7h4"/></svg>
    `;
  };

  const setStatus = (label) => {
    setStatusLabel(label);
    updateConnectionLine();
  };

  const setComposerNotice = (message = "") => {
    if (!composerNotice) return;
    composerNotice.textContent = message;
    composerNotice.hidden = !message;
  };

  const renderContextPopover = (snapshot = contextUsageSnapshot({
    attachments: chatSessionStore.getAttachments(),
    messages: chatSessionStore.getMessages(),
    model: modelSelect.value,
    pageSnapshot: getLastSnapshot()
  })) => {
    renderContextMemoryPopover(contextPopover, snapshot, {
      notice: contextCompactNotice,
      onClose: () => {
        contextPopoverOpen = false;
        contextPopover.hidden = true;
        contextMeter.setAttribute("aria-expanded", "false");
      },
      onCompact: compactContextLocally
    });
  };

  const setContextMeter = (snapshot) => {
    const usage = contextUsageSnapshot({
      attachments: chatSessionStore.getAttachments(),
      messages: chatSessionStore.getMessages(),
      model: modelSelect.value,
      pageSnapshot: snapshot ?? getLastSnapshot()
    });
    updateContextMeterElement(contextMeter, usage);
    if (contextPopoverOpen) {
      renderContextPopover(usage);
    }
  };

  function compactContextLocally() {
    const messages = chatSessionStore.getMessages();
    const recent = messages.slice(-8);
    contextCompactNotice = `Compact memory refreshed locally. ${recent.length}/${messages.length} recent turns are preserved for continuity; raw transcript remains intact.`;
    renderContextPopover();
  }

  const toggleContextPopover = () => {
    contextPopoverOpen = !contextPopoverOpen;
    contextPopover.hidden = !contextPopoverOpen;
    contextMeter.setAttribute("aria-expanded", contextPopoverOpen ? "true" : "false");
    if (contextPopoverOpen) {
      contextCompactNotice = "";
      renderContextPopover();
    }
  };

  return {
    clearActivitySoon,
    renderControlPreflightCard,
    runBusyUiAction,
    scrollTranscriptToBottom,
    setActivity,
    setComposerNotice,
    setContextMeter,
    setStatus,
    setTurnBusy,
    toggleContextPopover,
    updateConnectionLine,
    updateContextDockVisibility,
  };
}
