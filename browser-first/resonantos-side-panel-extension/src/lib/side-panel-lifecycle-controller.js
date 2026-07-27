export function createSidePanelLifecycleController({
  activeTab = async () => null,
  addMessage = async () => undefined,
  allowControlPreflightOnceForTaskClass = async () => undefined,
  allowCurrentTaskOnceForSafeActions = async () => undefined,
  approvalAllowOnceButton = null,
  approvalApproveButton = null,
  approvalDelegateButton = null,
  approvalDenyButton = null,
  approvalTrustSiteButton = null,
  approveControlPreflight = async () => undefined,
  approvePendingControlStep = async () => undefined,
  attachFileButton = null,
  browserJobStore,
  clearActivitySoon = () => undefined,
  commandForm = null,
  commandInput = null,
  composerController,
  contextMeter = null,
  contextToggleButton = null,
  controlPreflightApproveButton = null,
  controlPreflightDenyButton = null,
  controlPreflightOnceButton = null,
  controlPreflightTrustButton = null,
  delegateControlIssue = async () => undefined,
  denyPendingControlStep = async () => undefined,
  denyControlPreflight = async () => undefined,
  dictateButton = null,
  dictationController,
  fileInput = null,
  getLastSnapshot = () => null,
  getPendingControlPreflight = () => null,
  getMainWorkspaceVisible = async () => false,
  getStatusLabel = () => "Ready",
  getTurnBusy = () => false,
  jobMonitorClear = null,
  jobMonitorToggle = null,
  toggleMainWorkspace = async () => false,
  workspaceToggle = null,
  messageActions,
  modelSelect = null,
  persistChatState = async () => undefined,
  persistContextDockExpanded = async () => undefined,
  readButton = null,
  readActivePage = async () => undefined,
  renderJobMonitor = () => undefined,
  renderSitePermissionPanel = async () => undefined,
  respondToCommand = async () => undefined,
  runBusyUiAction = async (task) => task(),
  saveIntake = async () => undefined,
  saveIntakeButton = null,
  saveSelectionButton = null,
  setActivity = () => undefined,
  setContextDockExpanded = () => undefined,
  setContextMeter = () => undefined,
  setSitePermission = async () => ({ key: "unknown-site", mode: "ask-before-action" }),
  setStatus = () => undefined,
  setTurnBusy = () => undefined,
  sitePermissionMode = null,
  stopChatTurn = () => undefined,
  storage = null,
  storageOnChanged = null,
  storageKeys = {},
  tabContextController,
  thinkingDepthSelect = null,
  toggleContextPopover = () => undefined,
  transcript = null,
  trustControlPreflightForSafeActions = async () => undefined,
  trustCurrentTaskForSafeActions = async () => undefined,
  updateConnectionLine = () => undefined,
  windowRef = globalThis
} = {}) {
  const pendingSidebarPromptKey = storageKeys.pendingSidebarPrompt ?? "augmentorPendingSidebarPrompt";

  const consumePendingSidebarPrompt = async () => {
    const payload = await storage?.get?.(pendingSidebarPromptKey).catch(() => ({}));
    const pending = payload?.[pendingSidebarPromptKey];
    const prompt = String(pending?.prompt ?? "").trim();
    if (!prompt) return false;
    if (getTurnBusy()) return false;
    await storage?.remove?.(pendingSidebarPromptKey).catch(() => undefined);
    setTurnBusy(true);
    try {
      await addMessage("user", prompt);
      await respondToCommand(prompt);
      return true;
    } finally {
      setTurnBusy(false);
    }
  };

  const bindListeners = () => {
    storageOnChanged?.addListener?.((changes, areaName) => {
      if (areaName !== "local" || !changes[pendingSidebarPromptKey]?.newValue) {
        return;
      }
      void consumePendingSidebarPrompt();
    });

    transcript?.addEventListener?.("resonantos:use-prompt", (event) => {
      commandInput.value = event.detail?.prompt ?? "";
      commandInput.dispatchEvent(new windowRef.Event("input", { bubbles: true }));
      commandInput.focus();
    });
    attachFileButton?.addEventListener?.("click", () => fileInput?.click?.());
    fileInput?.addEventListener?.("change", () => void messageActions.attachFiles(fileInput.files));
    readButton?.addEventListener?.("click", () => void readActivePage());
    saveIntakeButton?.addEventListener?.("click", () => void saveIntake("page"));
    saveSelectionButton?.addEventListener?.("click", () => void saveIntake("selection"));
    contextToggleButton?.addEventListener?.("click", () => {
      setContextDockExpanded((current) => !current);
      void persistContextDockExpanded();
      void renderSitePermissionPanel();
      renderJobMonitor();
    });
  contextMeter?.addEventListener?.("click", toggleContextPopover);
    approvalApproveButton?.addEventListener?.("click", () => void runBusyUiAction(approvePendingControlStep));
    approvalAllowOnceButton?.addEventListener?.("click", () => void runBusyUiAction(allowCurrentTaskOnceForSafeActions));
    approvalTrustSiteButton?.addEventListener?.("click", () => void runBusyUiAction(trustCurrentTaskForSafeActions));
    approvalDenyButton?.addEventListener?.("click", () => void denyPendingControlStep());
    approvalDelegateButton?.addEventListener?.("click", () => void runBusyUiAction(delegateControlIssue));
    controlPreflightApproveButton?.addEventListener?.("click", () => void runBusyUiAction(() => approveControlPreflight(getPendingControlPreflight()?.id ?? "")));
    controlPreflightOnceButton?.addEventListener?.("click", () => void runBusyUiAction(() => allowControlPreflightOnceForTaskClass(getPendingControlPreflight()?.id ?? "")));
    controlPreflightTrustButton?.addEventListener?.("click", () => void runBusyUiAction(() => trustControlPreflightForSafeActions(getPendingControlPreflight()?.id ?? "")));
    controlPreflightDenyButton?.addEventListener?.("click", () => void runBusyUiAction(() => denyControlPreflight(getPendingControlPreflight()?.id ?? "")));
    jobMonitorToggle?.addEventListener?.("click", async () => {
      await browserJobStore.toggleMonitorCollapsed();
      renderJobMonitor();
    });
    jobMonitorClear?.addEventListener?.("click", async () => {
      const removed = await browserJobStore.clearCompletedJobs();
      renderJobMonitor();
      setStatus(removed > 0 ? `Cleared ${removed} finished job${removed === 1 ? "" : "s"}` : "No finished jobs to clear");
    });
    const syncWorkspaceToggleState = async () => {
      if (!workspaceToggle) return;
      const visible = await getMainWorkspaceVisible().catch(() => false);
      workspaceToggle.setAttribute("aria-pressed", String(Boolean(visible)));
    };
    workspaceToggle?.addEventListener?.("click", async () => {
      const visible = await toggleMainWorkspace().catch(() => false);
      workspaceToggle.setAttribute("aria-pressed", String(Boolean(visible)));
    });
    // The workspace can also be opened/closed from the browser itself, so
    // re-sync the pressed state whenever the panel regains focus.
    windowRef?.addEventListener?.("visibilitychange", () => void syncWorkspaceToggleState());
    void syncWorkspaceToggleState();
    sitePermissionMode?.addEventListener?.("change", async () => {
      const tab = await activeTab();
      const result = await setSitePermission(tab?.url, sitePermissionMode.value, {
        reason: "Changed from current-site permission selector",
        source: "site-permission-panel"
      });
      await renderSitePermissionPanel(tab);
      setStatus(`Site permission: ${result.mode}`);
      setActivity("completed", "Site permission updated", `${result.key} · ${result.mode}`);
      clearActivitySoon(1600);
    });
    tabContextController?.bindBrowserListeners?.();
    modelSelect?.addEventListener?.("change", () => void persistChatState().then(() => {
      updateConnectionLine();
      setContextMeter(getLastSnapshot());
    }));
    thinkingDepthSelect?.addEventListener?.("change", () => void persistChatState());
    dictateButton?.addEventListener?.("click", () => dictationController.toggle());

    composerController?.bind?.();

    commandForm?.querySelector?.(".send-button")?.addEventListener?.("click", (event) => {
      if (!getTurnBusy()) return;
      event.preventDefault();
      stopChatTurn();
    });

    commandForm?.addEventListener?.("submit", async (event) => {
      event.preventDefault();
      if (getTurnBusy()) {
        return;
      }
      const value = commandInput.value.trim();
      if (!value) {
        return;
      }
      setTurnBusy(true);
      try {
        await addMessage("user", value);
        commandInput.value = "";
        composerController.resetUndoStack("");
        await respondToCommand(value);
      } finally {
        setTurnBusy(false);
        if (getStatusLabel() === "Ready") {
          clearActivitySoon();
        }
      }
    });
  };

  return {
    bindListeners,
    consumePendingSidebarPrompt
  };
}
