import { approvalBoundaryForStep } from "./lib/approval-policy.js";
import { controlStepLabel } from "./lib/agent-control-planner.js";
import { createAgentControlRunner } from "./lib/agent-control-runner.js";
import { createAppCommandHandlers } from "./lib/app-command-handlers.js";
import { normalizeBrowserUrl } from "./lib/browser-command-parser.js";
import { activateBrowserJobPage } from "./lib/browser-job-activation.js";
import { createBrowserJobScheduler } from "./lib/browser-job-scheduler.js";
import { createBrowserJobStore } from "./lib/browser-job-store.js";
import { createBrowserPageActions } from "./lib/browser-page-actions.js";
import { createBridgeClient, detectLoopbackBridge, initCapabilityTokens, isUnauthorizedBridgeError, resolveBridgeConfig } from "./lib/bridge-client.js";
import { createPrefsSync } from "./lib/prefs-sync.js";
import { createChatSessionStore } from "./lib/chat-session-store.js";
import { createChatTurnController } from "./lib/chat-turn-controller.js";
import {
  createDictationController,
  hydrateProviderModelOptions,
} from "./lib/composer-runtime.js";
import { createComposerController } from "./lib/composer-controller.js";
import {
  shouldRequireControlPreflight
} from "./lib/control-preflight.js";
import { createControlPreflightDecisionSlot } from "./lib/control-preflight-decision-slot.js";
import { createControlPageObserver } from "./lib/control-page-observer.js";
import { createControlPlanningService } from "./lib/control-planning-service.js";
import { createControlReportingService } from "./lib/control-reporting-service.js";
import { createControlRunState } from "./lib/control-run-state.js";
import { createControlStepExecutor } from "./lib/control-step-executor.js";
import { createControlTabTargets } from "./lib/control-tab-targets.js";
import { createControlApprovalActions } from "./lib/control-approval-actions.js";
import { createDockTabs } from "./lib/dock-tabs.js";
import { createSidePanelChatsTree } from "./lib/side-panel-chats-tree.js";
import { isRailVisibleChatSession } from "./lib/main-workspace-rail.js";
import { shouldSyncChatChange } from "./lib/chat-sync.js";
import { createMainWorkspaceToggle } from "./lib/main-workspace-toggle.js";
import { createMessageActionController } from "./lib/message-action-controller.js";
import { createMonitorRenderers } from "./lib/monitor-renderers.js";
import { createSidePanelBrowserActionController } from "./lib/side-panel-browser-action-controller.js";
import { createBrowserActionLock } from "./lib/side-panel-browser-action-lock.js";
import { createSidePanelBrowserJobController } from "./lib/side-panel-browser-job-controller.js";
import { createSidePanelChatHydration } from "./lib/side-panel-chat-hydration.js";
import { createSidePanelCommandRouter } from "./lib/side-panel-command-router.js";
import { createSidePanelControlCommandController } from "./lib/side-panel-control-command-controller.js";
import { isControllableTabUrl } from "./lib/control-target-classification.js";
import { createSidePanelControlPreflightController } from "./lib/side-panel-control-preflight-controller.js";
import {
  getSidePanelElements,
  SIDE_PANEL_STORAGE_KEYS
} from "./lib/side-panel-dom.js";
import { createSidePanelLifecycleController } from "./lib/side-panel-lifecycle-controller.js";
import { createSidePanelMessageRouter } from "./lib/side-panel-message-router.js";
import { createSidePanelRenderers } from "./lib/side-panel-renderers.js";
import { createSidePanelScheduledBrowserJobRunner } from "./lib/side-panel-scheduled-browser-job-runner.js";
import { createSidePanelUiController } from "./lib/side-panel-ui-controller.js";
import { readPersonalizationSettings } from "./lib/personalization-settings.js";
import { createSitePermissionStore } from "./lib/site-permission-store.js";
import { createTabContextController } from "./lib/tab-context-controller.js";
import { createTaskConsentStore } from "./lib/task-consent-store.js";

const {
  activityDetail,
  activityLabel,
  activityPanel,
  approvalAllowOnceButton,
  approvalApproveButton,
  approvalCard,
  approvalDelegateButton,
  approvalDenyButton,
  approvalReason,
  approvalTitle,
  approvalTrustSiteButton,
  attachFileButton,
  attachmentStrip,
  commandForm,
  commandInput,
  composerNotice,
  connectionLine,
  contextDock,
  contextMeter,
  contextPopover,
  contextToggleButton,
  controlArtifacts,
  controlCurrentAction,
  controlMonitor,
  controlMonitorStatus,
  controlMonitorTitle,
  dockTabSite,
  dockTabControl,
  dockTabJobs,
  dockTabChats,
  dockTabPermissions,
  dockDotSite,
  dockDotControl,
  dockDotJobs,
  dockDotChats,
  dockDotPermissions,
  dockNewChat,
  chatsPanel,
  chatsTree,
  dockPopout,
  dockPopoutTitle,
  dockPopoutClose,
  dockPopoutBody,
  controlPreflightApproveButton,
  controlPreflightBody,
  controlPreflightCard,
  controlPreflightDenyButton,
  controlPreflightOnceButton,
  controlPreflightTitle,
  controlPreflightTrustButton,
  controlStepList,
  controlStopButton,
  controlSummaryCard,
  dictateButton,
  fileInput,
  jobList,
  jobMonitor,
  jobMonitorClear,
  jobMonitorTitle,
  jobMonitorToggle,
  modelSelect,
  permissionManagerList,
  permissionManagerPanel,
  permissionManagerTitle,
  readButton,
  workspaceToggle,
  regenerationModeSelect,
  saveIntakeButton,
  saveSelectionButton,
  sitePermissionHost,
  sitePermissionMode,
  sitePermissionNote,
  sitePermissionPanel,
  taskConsentList,
  taskConsentPanel,
  taskConsentTitle,
  thinkingDepthSelect,
  transcript
} = getSidePanelElements(document);

// `bridgeRequest` is `let` because the rebind chain below replaces it
// once loopback detection has settled. We use .then() chains (not
// top-level await) to keep MV3 SW registration happy.
let bridgeRequest = null;
let prefsSync = null;
let rebindInFlight = null;

function rebindBridge({ forceResolve = false, refreshGenerated = false } = {}) {
  if (rebindInFlight && !forceResolve) return rebindInFlight;
  rebindInFlight = resolveBridgeConfig({ refreshGenerated })
    .then((cfg) => detectLoopbackBridge(cfg))
    .then((cfg) => {
      bridgeRequest = createBridgeClient(cfg);
      if (!prefsSync) {
        prefsSync = createPrefsSync({ getBridgeRequest: () => bridgeRequest });
        prefsSync.install();
      }
      return initCapabilityTokens(cfg)
        .catch(() => undefined)
        .then(() => ({ cfg, bridgeRequest }));
    })
    .catch(() => null);
  return rebindInFlight;
}

function hydrateAfterRebind(options = {}) {
  return rebindBridge(options).then((result) => {
    if (!result) return null;
    void prefsSync.hydrate().catch(() => undefined);
    return result;
  });
}

async function currentBridgeRequest(route, options = {}) {
  const req = typeof bridgeRequest === "function"
    ? bridgeRequest
    : (await hydrateAfterRebind())?.bridgeRequest;
  if (typeof req !== "function") {
    throw new Error("Browser bridge is unavailable.");
  }
  try {
    return await req(route, options);
  } catch (error) {
    if (!isUnauthorizedBridgeError(error)) throw error;
    rebindInFlight = null;
    const rebound = await hydrateAfterRebind({ forceResolve: true, refreshGenerated: true });
    if (typeof rebound?.bridgeRequest !== "function") throw error;
    return rebound.bridgeRequest(route, options);
  }
}

const getBridgeRequest = () => currentBridgeRequest;

void hydrateAfterRebind();

chrome?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== "local") return;
  if (!changes?.bridgeTargetOverride) return;
  rebindInFlight = null;
  void hydrateAfterRebind();
});
const STORAGE_KEYS = SIDE_PANEL_STORAGE_KEYS;
let lastSnapshot = null;
let statusLabel = "Ready";
let turnBusy = false;
let currentControlRun = null;
let pendingApproval = null;
let pendingControlPreflight = null;
let controlledTabId = null;
let contextDockExpanded = false;
let personalizationSettings = null;
let messageActions = null;
let monitorRenderers = null;
let browserJobScheduler = null;

function normalizeRegenerationMode(value) {
  return value === "overwrite" ? "overwrite" : "branch";
}

async function hydrateRegenerationModePreference() {
  const settings = await chrome.storage?.local?.get?.([STORAGE_KEYS.regenerationMode]).catch(() => ({}));
  if (regenerationModeSelect) {
    regenerationModeSelect.value = normalizeRegenerationMode(settings?.[STORAGE_KEYS.regenerationMode]);
  }
}

async function setRegenerationModePreference(mode) {
  const normalized = normalizeRegenerationMode(mode);
  if (regenerationModeSelect) {
    regenerationModeSelect.value = normalized;
  }
  await chrome.storage?.local?.set?.({
    [STORAGE_KEYS.regenerationMode]: normalized
  }).catch(() => undefined);
}

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const { withBrowserActionLock } = createBrowserActionLock();
const mainWorkspaceToggle = createMainWorkspaceToggle();

// Top-of-sidecar tabs: relocate the Site / Agent Control / Jobs / Permissions
// panels into a full-size popout overlay, hidden until their link is clicked.
// Approval and consent panels stay in the inline context-dock so they
// auto-surface.
dockPopoutBody.append(sitePermissionPanel, controlMonitor, jobMonitor, permissionManagerPanel);
// chatsTreeRenderer is assigned after the chat store + renderers exist below;
// onOpen reads it lazily so the Chats tree refreshes each time the tab opens.
let chatsTreeRenderer = null;
const dockTabs = createDockTabs({
  tabs: [
    { name: "site", button: dockTabSite, dot: dockDotSite, panel: sitePermissionPanel },
    { name: "control", button: dockTabControl, dot: dockDotControl, panel: controlMonitor },
    { name: "jobs", button: dockTabJobs, dot: dockDotJobs, panel: jobMonitor },
    { name: "chats", button: dockTabChats, dot: dockDotChats, panel: chatsPanel },
    { name: "permissions", button: dockTabPermissions, dot: dockDotPermissions, panel: permissionManagerPanel }
  ],
  popout: dockPopout,
  popoutTitle: dockPopoutTitle,
  closeButton: dockPopoutClose,
  titles: { site: "Site", control: "Control", jobs: "Jobs", chats: "Chats", permissions: "Permissions" },
  onOpen: (name) => { if (name === "chats") chatsTreeRenderer?.render(); }
});
dockTabs.bind();
const composerController = createComposerController({
  commandForm,
  commandInput,
  forceClipboardFallback: true,
  navigator
});

const chatInstanceId = `sidecar-${Math.random().toString(36).slice(2, 10)}`;
const chatSessionStore = createChatSessionStore({
  storage: chrome.storage?.local,
  storageKeys: STORAGE_KEYS,
  instanceId: chatInstanceId,
  getModel: () => modelSelect.value,
  getThinkingDepth: () => thinkingDepthSelect.value,
  setModel: (model) => {
    modelSelect.value = model;
  },
  setThinkingDepth: (depth) => {
    thinkingDepthSelect.value = depth;
  },
  isAllowedModel: (model) => [...modelSelect.options].some((option) => option.value === model),
  isAllowedThinkingDepth: (depth) => [...thinkingDepthSelect.options].some((option) => option.value === depth)
});
const browserJobStore = createBrowserJobStore({
  storage: chrome.storage?.local,
  storageKeys: STORAGE_KEYS
});

const isReadableBrowserTab = (tab) => isControllableTabUrl(tab?.url);
const sidePanelUi = createSidePanelUiController({
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
  getContextDockExpanded: () => contextDockExpanded,
  getLastSnapshot: () => lastSnapshot,
  getPendingControlPreflight: () => pendingControlPreflight,
  getStatusLabel: () => statusLabel,
  getTurnBusy: () => turnBusy,
  jobMonitor,
  modelSelect,
  permissionManagerPanel,
  setStatusLabel: (label) => {
    statusLabel = label;
  },
  setTurnBusyState: (busy) => {
    turnBusy = busy;
  },
  sitePermissionPanel,
  taskConsentPanel,
  thinkingDepthSelect,
  transcript,
  window,
});

const {
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
} = sidePanelUi;

const persistContextDockExpanded = async () => {
  await chrome.storage?.local?.set?.({
    [STORAGE_KEYS.contextDockExpanded]: contextDockExpanded
  }).catch(() => undefined);
};

const sitePermissionStore = createSitePermissionStore({
  storage: chrome.storage?.local,
  sitePermissionAuditStorageKey: STORAGE_KEYS.sitePermissionAudit,
  sitePermissionStorageKey: STORAGE_KEYS.sitePermissions
});
const permissionForUrl = sitePermissionStore.permissionForUrl;
const resetSitePermission = sitePermissionStore.resetSitePermission;
const setSitePermission = sitePermissionStore.setSitePermission;
const siteKeyForUrl = sitePermissionStore.siteKeyForUrl;
const sitePermissions = sitePermissionStore.sitePermissions;
const taskConsentStore = createTaskConsentStore({
  storage: chrome.storage?.local,
  taskConsentAuditStorageKey: STORAGE_KEYS.taskConsentAudit,
  taskConsentStorageKey: STORAGE_KEYS.taskConsents
});
const controlPreflightDecisionSlot = createControlPreflightDecisionSlot();

const controlPreflightController = createSidePanelControlPreflightController({
  addMessage: (...args) => addMessage(...args),
  controlPreflightStorageKey: STORAGE_KEYS.controlPreflight,
  getPendingControlPreflight: () => pendingControlPreflight,
  renderControlPreflightCard,
  renderPermissionManager: () => renderPermissionManager(),
  renderSitePermissionPanel: (tab) => renderSitePermissionPanel(tab),
  renderTaskConsentPanel: (tab) => renderTaskConsentPanel(tab),
  runControlCommand: (goal, options) => runControlCommand(goal, options),
  setActivity,
  setContextDockExpanded: async (expanded) => {
    contextDockExpanded = Boolean(expanded);
    await persistContextDockExpanded();
  },
  setNextControlPreflightDecision: (decision) => setNextControlPreflightDecision(decision),
  setPendingControlPreflight: (preflight) => {
    pendingControlPreflight = preflight;
  },
  setStatus,
  storage: chrome.storage?.local,
  taskConsentStore
});

const renderSitePermissionPanel = async (tab = null) => {
  await monitorRenderers.renderSitePermissionPanel(tab);
  await renderTaskConsentPanel(tab);
  await renderPermissionManager();
};

const renderTaskConsentPanel = async (tab = null) => {
  await monitorRenderers.renderTaskConsentPanel(tab);
};

const renderPermissionManager = () => monitorRenderers.renderPermissionManager();

const renderJobMonitor = () => {
  monitorRenderers.renderJobMonitor();
};

const browserJobController = createSidePanelBrowserJobController({
  activateJobTab: (job) => activateJobTab(job),
  addMessage: (...args) => addMessage(...args),
  browserJobStore,
  consumeNextControlPreflightDecision: () => consumeNextControlPreflightDecision(),
  getCurrentControlRun: () => currentControlRun,
  prepareBrowserJobPageLock: (request) => prepareBrowserJobPageLock(request),
  renderControlMonitor: () => renderControlMonitor(),
  renderJobMonitor,
  setCurrentControlRun: (run) => {
    currentControlRun = run;
  },
  setPendingApproval: (approval) => {
    pendingApproval = approval;
  }
});
const createBrowserJob = browserJobController.createBrowserJob;
const focusBrowserJobRun = browserJobController.focusBrowserJobRun;
const loadBrowserJobs = browserJobController.loadBrowserJobs;
const updateBrowserJob = browserJobController.updateBrowserJob;

const persistChatState = () => chatSessionStore.persist();

const {
  flashCopied,
  renderAttachments,
  renderMessages
} = createSidePanelRenderers({
  attachmentStrip,
  transcript,
  getAttachments: () => chatSessionStore.getAttachments(),
  getMessages: () => chatSessionStore.getMessages(),
  onRemoveAttachment: async (id) => {
    await chatSessionStore.removeAttachment(id);
    renderAttachments();
  },
  onCopyMessage: (id) => messageActions.copyMessage(id),
  onDeleteMessage: async (id) => {
    await messageActions.deleteMessage(id);
  },
  onEditMessage: (id) => messageActions.editMessage(id),
  onForkMessage: async (id) => {
    await messageActions.forkFromMessage(id);
  },
  onRegenerateMessage: async (id) => {
    await messageActions.regenerateFromMessage(id);
  },
  onSaveMessageToArchive: (id) => messageActions.saveMessageToArchive(id),
  onShowMessageStats: (id) => messageActions.showMessageStats(id),
  scrollTranscriptToBottom,
  window
});

// The sidecar "Chats" tab: a mirror of the main-workspace rail from the shared
// store. Opening a chat switches the shared active session and reveals its
// transcript (both surfaces stay in sync via the same storage keys).
chatsTreeRenderer = createSidePanelChatsTree({
  container: chatsTree,
  document,
  chatSessionStore,
  isVisibleSession: isRailVisibleChatSession,
  orderItems: (items) => [...items].sort((left, right) => (
    left.pinned !== right.pinned
      ? (left.pinned ? -1 : 1)
      : new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  )),
  onOpenSession: async (sessionId) => {
    await chatSessionStore.switchSession(sessionId);
    renderMessages();
    renderAttachments();
    chatsTreeRenderer.render();
    dockTabs.close();
  }
});

// New-chat "+" in the dock (mirrors the main panel): create a fresh session and
// reveal its empty transcript, ready to type.
dockNewChat?.addEventListener("click", async () => {
  await chatSessionStore.createSession({ workspaceId: "answer" });
  renderMessages();
  renderAttachments();
  chatsTreeRenderer.render();
  dockTabs.close();
  commandInput?.focus();
});

const addMessage = async (role, content, { persist = true, usage = null } = {}) => {
  const message = await chatSessionStore.addMessage(role, content, { persist, usage });
  if (!message) return null;
  renderMessages();
  chatsTreeRenderer.render();
  setContextMeter(lastSnapshot);
  return message;
};

// Live tandem sync: when the main workspace (or any other surface) changes the
// shared chats/folders/projects/active session, re-hydrate and re-render so the
// sidecar stays in lockstep. Our own writes carry our instanceId and are skipped.
const CHAT_SYNC_KEYS = [STORAGE_KEYS.sessions, STORAGE_KEYS.folders, STORAGE_KEYS.projects, STORAGE_KEYS.activeSessionId];
chrome?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== "local") return;
  if (!shouldSyncChatChange(changes, { keys: CHAT_SYNC_KEYS, writerKey: STORAGE_KEYS.writer, instanceId: chatInstanceId })) return;
  void chatSessionStore.hydrate().then(() => {
    renderMessages();
    renderAttachments();
    chatsTreeRenderer.render();
  });
});

const dictationController = createDictationController({
  addMessage,
  button: dictateButton,
  commandInput,
  navigatorRef: navigator,
  onTranscript: () => composerController.pushUndoSnapshot(),
  setNotice: setComposerNotice,
  setStatus,
  windowRef: window
});

messageActions = createMessageActionController({
  addMessage,
  bridgeRequest: currentBridgeRequest,
  getBridgeRequest,
  chatSessionStore,
  commandInput,
  composerController,
  fileInput,
  flashCopied,
  getLastSnapshot: () => lastSnapshot,
  getRegenerationMode: () => normalizeRegenerationMode(regenerationModeSelect?.value),
  getRespondToCommand: () => respondToCommand,
  navigator,
  renderAttachments,
  renderMessages,
  setStatus
});

const browserPageActions = createBrowserPageActions({
  addMessage,
  bridgeRequest: currentBridgeRequest,
  chrome,
  getControlledTabId: () => controlledTabId,
  getModel: () => modelSelect.value,
  getThinkingDepth: () => thinkingDepthSelect.value,
  getLastSnapshot: () => lastSnapshot,
  isReadableBrowserTab,
  normalizeBrowserUrl,
  permissionForUrl,
  renderSitePermissionPanel,
  setActivity,
  setContextMeter,
  setControlledTabId: (tabId) => {
    controlledTabId = tabId;
  },
  setLastSnapshot: (snapshot) => {
    lastSnapshot = snapshot;
  },
  setReadButtonTitle: (title) => {
    readButton.title = title;
  },
  setStatus,
  siteKeyForUrl,
  sleep
});

const {
  activeTab,
  clickActivePageText,
  detectActivePageForms,
  detectWalletState,
  openBrowserUrl,
  readActivePage,
  prepareDaoWorkflowGuidance,
  refreshTabContext,
  runResonatorCommand,
  scrollActivePage,
  saveCurrentPageToArchive,
  saveResearchTrailToArchive,
  saveSelectionToArchive,
  saveWalletDaoAuditToArchive,
  searchBrowser,
  sendContentAction,
  setPageControlOverlay,
  summarizeCurrentPageToArchive,
  summarizeSnapshot,
  typeIntoActivePage
} = browserPageActions;

const { currentReadableControlTab, ensureControlTabForUrl } = createControlTabTargets({
  chromeApi: chrome,
  clearPageSnapshot: () => {
    lastSnapshot = null;
    setContextMeter(null);
  },
  getControlledTabId: () => controlledTabId,
  isReadableBrowserTab,
  setControlledTabId: (tabId) => {
    controlledTabId = tabId;
  },
});

monitorRenderers = createMonitorRenderers({
  activeTab,
  approvalBoundaryForStep,
  controlStepLabel,
  elements: {
    approvalAllowOnceButton,
    approvalApproveButton,
    approvalCard,
    approvalReason,
    approvalTitle,
    approvalTrustSiteButton,
    controlArtifacts,
    controlCurrentAction,
    controlMonitor,
    controlSummaryCard,
    controlMonitorStatus,
    controlMonitorTitle,
    controlStopButton,
    controlStepList,
    jobList,
    jobMonitor,
    jobMonitorTitle,
    jobMonitorToggle,
    permissionManagerList,
    permissionManagerPanel,
    permissionManagerTitle,
    sitePermissionHost,
    sitePermissionMode,
    sitePermissionNote,
    sitePermissionPanel,
    taskConsentList,
    taskConsentPanel,
    taskConsentTitle
  },
  getActiveBrowserJobId: () => browserJobStore.getActiveJobId(),
  getBrowserJobSchedulerState: () => browserJobStore.getSchedulerState({ maxConcurrent: 2 }),
  getBrowserJobs: () => browserJobStore.getJobs(),
  getContextDockExpanded: () => contextDockExpanded,
  getCurrentControlRun: () => currentControlRun,
  getJobMonitorCollapsed: () => browserJobStore.getMonitorCollapsed(),
  getPendingApproval: () => pendingApproval ?? browserJobStore.currentJob()?.pendingApproval ?? null,
  getSitePermissionAudit: () => sitePermissionStore.sitePermissionAudit(),
  getSitePermissions: () => sitePermissions(),
  getTaskConsentAudit: () => taskConsentStore.taskConsentAudit(),
  getTaskConsents: () => taskConsentStore.taskConsents(),
  isReadableBrowserTab,
  onContinueBrowserJob: (job) => {
    void continueBrowserJob(job.id);
  },
  onApproveBrowserJob: (job) => {
    void runBusyUiAction(async () => {
      await focusBrowserJobRun(job.id);
      await approvePendingControlStep();
    });
  },
  onCancelBrowserJob: (job) => {
    void runBusyUiAction(() => cancelBrowserJob(job.id));
  },
  onDenyBrowserJob: (job) => {
    void runBusyUiAction(async () => {
      await focusBrowserJobRun(job.id);
      await denyPendingControlStep();
    });
  },
  onPauseBrowserJob: (job) => {
    void runBusyUiAction(() => pauseBrowserJob(job.id));
  },
  onActivateBrowserJob: async (job) => {
    await focusBrowserJobRun(job.id);
    await addMessage("system", `Focused browser job ${job.id}: ${job.goal}`);
  },
  onSaveBrowserJobReport: async (job) => {
    const result = await saveBrowserJobReportToArchive(job);
    if (result?.error) {
      await addMessage("system", `Browser job report failed: ${result.error}`);
      return;
    }
    const artifacts = [...(job.artifacts ?? []), { type: "archive-intake", path: result.path }];
    await updateBrowserJob(job.id, { artifacts });
    await addMessage("system", `Saved browser job report to Living Archive intake: ${result.path}`);
  },
  onRevokeTaskConsent: async (consent) => {
    await taskConsentStore.revokeTaskConsent({
      siteKey: consent.siteKey,
      taskClass: consent.taskClass,
      reason: "Revoked from permission manager",
      source: "permission-manager"
    });
    await addMessage("system", `Revoked safe-action consent for ${consent.siteKey} · ${consent.taskClass}.`);
    await renderTaskConsentPanel();
    await renderPermissionManager();
  },
  onResetSitePermission: async (siteKey) => {
    await resetSitePermission(siteKey, {
      reason: "Reset from permission manager",
      source: "permission-manager"
    });
    await addMessage("system", `Reset site permission for ${siteKey} to ask-before-action.`);
    await renderSitePermissionPanel();
    await renderPermissionManager();
  },
  permissionForUrl,
  siteKeyForUrl,
  updateContextDockVisibility
});

const renderControlMonitor = () => {
  monitorRenderers.renderControlMonitor();
};

const tabContextController = createTabContextController({
  addMessage,
  chrome,
  getControlledTabId: () => controlledTabId,
  isReadableBrowserTab,
  refreshTabContext,
  renderSitePermissionPanel,
  setContextMeter,
  setControlledTabId: (tabId) => {
    controlledTabId = tabId;
  },
  setLastSnapshot: (snapshot) => {
    lastSnapshot = snapshot;
  },
  sitePermissionStorageKey: STORAGE_KEYS.sitePermissions
});
const bindMentionedTab = tabContextController.bindMentionedTab;

const controlPlanningService = createControlPlanningService({
  bridgeRequest: currentBridgeRequest,
  getBridgeRequest,
  getLastSnapshot: () => lastSnapshot,
  getModel: () => modelSelect.value,
  getSystemPrompt: () => personalizationSettings?.augmentor?.systemPrompt ?? "",
  getThinkingDepth: () => thinkingDepthSelect.value,
  readActivePage
});
const requestNextControlAction = controlPlanningService.requestNextControlAction;

const controlStepExecutor = createControlStepExecutor({
  addMessage,
  chrome,
  clickActivePageText,
  detectActivePageForms,
  getControlledTabId: () => controlledTabId,
  isReadableBrowserTab,
  openBrowserUrl,
  scrollActivePage,
  searchBrowser,
  setActivity,
  setContextMeter,
  setControlledTabId: (tabId) => {
    controlledTabId = tabId;
  },
  setLastSnapshot: (snapshot) => {
    lastSnapshot = snapshot;
  },
  sleep,
  summarizeSnapshot,
  typeIntoActivePage
});
const executeControlStep = controlStepExecutor.executeControlStep;

const controlReportingService = createControlReportingService({
  addMessage,
  bridgeRequest: currentBridgeRequest,
  getBridgeRequest,
  controlStepLabel,
  getCurrentControlRun: () => currentControlRun,
  getLastSnapshot: () => lastSnapshot,
  getPendingApproval: () => pendingApproval ?? browserJobStore.currentJob()?.pendingApproval ?? null
});
const delegateControlIssue = controlReportingService.delegateControlIssue;
const saveBrowserJobReportToArchive = controlReportingService.saveBrowserJobReportToArchive;
const saveControlReportToArchive = controlReportingService.saveControlReportToArchive;

const controlRunState = createControlRunState({
  browserJobStore,
  getCurrentControlRun: () => currentControlRun,
  renderControlMonitor,
  setCurrentControlRun: (run) => {
    currentControlRun = run;
  },
  setPageControlOverlay,
  setPendingApproval: (approval) => {
    pendingApproval = approval;
    void updateBrowserJob(browserJobStore.getActiveJobId(), { pendingApproval: approval });
  },
  updateBrowserJob
});
const appendControlStep = controlRunState.appendControlStep;
const finishControlRun = controlRunState.finishControlRun;
const startControlRun = controlRunState.startControlRun;
const updateControlRunArtifacts = controlRunState.updateControlRunArtifacts;
const updateControlStep = controlRunState.updateControlStep;

const controlPageObserver = createControlPageObserver({
  browserJobStore,
  chrome,
  getControlledTabId: () => controlledTabId,
  getCurrentControlRun: () => currentControlRun,
  getLastSnapshot: () => lastSnapshot,
  isReadableBrowserTab,
  readActivePage,
  setActivity
});
const observeControlPage = controlPageObserver.observeControlPage;

const agentControlRunner = createAgentControlRunner({
  addMessage,
  appendControlStep,
  approvalBoundaryForStep,
  controlStepLabel,
  createBrowserJob,
  executeControlStep,
  finishControlRun,
  getActiveJobId: () => browserJobStore.getActiveJobId(),
  getCurrentControlRun: () => currentControlRun,
  getLastSnapshot: () => lastSnapshot,
  observeControlPage,
  renderControlMonitor,
  requestNextControlAction,
  saveControlReportToArchive,
  setActivity,
  setPageControlOverlay,
  setPendingApproval: (approval) => {
    pendingApproval = approval;
    void updateBrowserJob(browserJobStore.getActiveJobId(), { pendingApproval: approval });
  },
  setStatus,
  sleep,
  startControlRun,
  taskConsentForStep: async ({ goal }) => {
    const tab = await activeTab();
    const consent = await taskConsentStore.consentFor({
      siteKey: siteKeyForUrl(tab?.url),
      goal
    });
    if (consent?.mode === "allow-once") {
      await taskConsentStore.consumeTaskConsent?.({
        siteKey: consent.siteKey,
        taskClass: consent.taskClass,
        reason: `Consumed by safe approval retry for: ${goal}`,
        source: "agent-control-runner"
      });
    }
    return consent;
  },
  updateBrowserJob,
  updateControlRunArtifacts,
  updateControlStep
});

const continueControlLoop = agentControlRunner.continueControlLoop;
const startControlCommand = agentControlRunner.runControlCommand;

const activateJobTab = async (job) => {
  const latestJob = browserJobStore.findJob(job?.id);
  if (latestJob?.status === "cancelled") {
    throw new Error(`Browser job ${job.id} is ${latestJob.status}; scheduler stopped browser actions.`);
  }
  return activateBrowserJobPage({
    activeTab,
    chromeApi: chrome,
    isReadableBrowserTab,
    job,
    setControlledTabId: (tabId) => {
      controlledTabId = tabId;
    }
  });
};

const scheduledBrowserJobRunner = createSidePanelScheduledBrowserJobRunner({
  activateJobTab: (job) => activateJobTab(job),
  addMessage: (...args) => addMessage(...args),
  approvalBoundaryForStep,
  browserJobStore,
  chromeApi: chrome,
  controlStepLabel,
  executeControlStep: (step) => executeControlStep(step),
  getControlledTabId: () => controlledTabId,
  getCurrentControlRun: () => currentControlRun,
  getLastSnapshot: () => lastSnapshot,
  isReadableBrowserTab,
  readActivePage: (options) => readActivePage(options),
  renderControlMonitor: () => renderControlMonitor(),
  renderJobMonitor,
  requestNextControlAction: (request) => requestNextControlAction(request),
  saveBrowserJobReportToArchive: (job) => saveBrowserJobReportToArchive(job),
  setActivity,
  setControlledTabId: (tabId) => {
    controlledTabId = tabId;
  },
  setCurrentControlRun: (run) => {
    currentControlRun = run;
  },
  setLastSnapshot: (snapshot) => {
    lastSnapshot = snapshot;
  },
  setPageControlOverlay: (active, label, phase) => setPageControlOverlay(active, label, phase),
  setPendingApproval: (approval) => {
    pendingApproval = approval;
  },
  setStatus,
  sleep,
  taskConsentStore,
  updateBrowserJob: (jobId, patch) => updateBrowserJob(jobId, patch),
  windowRef: window,
  withBrowserActionLock
});
const runScheduledBrowserJob = scheduledBrowserJobRunner.runScheduledBrowserJob;

const hydrateControlPreflight = controlPreflightController.hydrateControlPreflight;

const setNextControlPreflightDecision = (decision) => controlPreflightDecisionSlot.set(decision);
const consumeNextControlPreflightDecision = () => controlPreflightDecisionSlot.consume();

const controlCommandController = createSidePanelControlCommandController({
  activeTab,
  addMessage,
  browserJobStore,
  clearControlPreflight: () => controlPreflightController.clearControlPreflight(),
  createBrowserJob,
  currentReadableControlTab,
  ensureControlTabForUrl,
  getBrowserJobScheduler: () => browserJobScheduler,
  getCurrentControlRun: () => currentControlRun,
  getRawActiveTab: async () => (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0] ?? null,
  permissionForUrl,
  persistContextDockExpanded,
  renderControlMonitor: () => renderControlMonitor(),
  renderJobMonitor,
  requestControlPreflight: (request) => controlPreflightController.requestControlPreflight(request),
  setActivity,
  setContextDockExpanded: (expanded) => {
    contextDockExpanded = Boolean(expanded);
  },
  setCurrentControlRun: (run) => {
    currentControlRun = run;
  },
  setNextControlPreflightDecision: (decision) => setNextControlPreflightDecision(decision),
  setPendingApproval: (approval) => {
    pendingApproval = approval;
  },
  setStatus,
  shouldRequireControlPreflight,
  siteKeyForUrl,
  taskConsentStore,
  updateBrowserJob
});
const prepareBrowserJobPageLock = controlCommandController.prepareBrowserJobPageLock;
const runControlCommand = controlCommandController.runControlCommand;

const allowControlPreflightOnceForTaskClass = controlPreflightController.allowControlPreflightOnceForTaskClass;
const approveControlPreflight = controlPreflightController.approveControlPreflight;
const denyControlPreflight = controlPreflightController.denyControlPreflight;
const trustControlPreflightForSafeActions = controlPreflightController.trustControlPreflightForSafeActions;

const {
  allowCurrentTaskOnceForSafeActions,
  approvePendingControlStep,
  denyPendingControlStep,
  trustCurrentTaskForSafeActions,
} = createControlApprovalActions({
  activeTab,
  addMessage,
  agentControlRunner,
  approvalBoundaryForStep,
  controlStepLabel,
  getCurrentControlRun: () => currentControlRun,
  getPendingApproval: () => pendingApproval,
  renderControlMonitor,
  renderTaskConsentPanel,
  siteKeyForUrl,
  taskConsentStore,
});

const browserActionController = createSidePanelBrowserActionController({
  addMessage,
  clickActivePageText,
  detectActivePageForms,
  getLastSnapshot: () => lastSnapshot,
  openBrowserUrl,
  readActivePage,
  saveCurrentPageToArchive,
  saveResearchTrailToArchive,
  saveSelectionToArchive,
  scrollActivePage,
  searchBrowser,
  setActivity,
  setStatus,
  summarizeCurrentPageToArchive,
  summarizeSnapshot,
  typeIntoActivePage
});
const explainStructuredPageEditBoundary = browserActionController.explainStructuredPageEditBoundary;
const handleWalletBoundary = browserActionController.handleWalletBoundary;
const runBrowserCommand = browserActionController.runBrowserCommand;
const saveIntake = browserActionController.saveIntake;

const chatTurnController = createChatTurnController({
  addMessage,
  bridgeRequest: currentBridgeRequest,
  getBridgeRequest,
  chatSessionStore,
  clearActivitySoon,
  clearAttachments: () => messageActions.clearAttachments(),
  getLastSnapshot: () => lastSnapshot,
  getModel: () => modelSelect.value,
  getThinkingDepth: () => thinkingDepthSelect.value,
  setActivity,
  setStatus,
  setTurnBusy
});

const runChatTurn = chatTurnController.runChatTurn;
const stopChatTurn = chatTurnController.stopChatTurn;

const tickBrowserJobScheduler = async () => {
  if (!browserJobScheduler) {
    return { activeJobIds: [], schedulerState: browserJobStore.getSchedulerState({ maxConcurrent: 2 }), startedJobs: [] };
  }
  const result = await browserJobScheduler.tick();
  renderJobMonitor();
  return result;
};

const {
  cancelBrowserJob,
  continueBrowserJob,
  pauseBrowserJob,
  resumeBrowserJob,
  runCapabilitiesCommand,
  runDelegateCommand,
  runGoalCommand,
  runHermesStatusCommand,
  runHistorySearchCommand,
  runJobsCommand,
  runMemorySearchCommand,
  runNaturalDelegationCommand,
  reportBrowserJob,
  runSitePermissionCommand,
  runStatusCommand,
  runWalletStatusCommand
} = createAppCommandHandlers({
  activeTab,
  addMessage,
  bridgeRequest: currentBridgeRequest,
  getBridgeRequest,
  browserJobStore,
  chrome,
  detectWalletState,
  finishControlRun,
  focusBrowserJob: focusBrowserJobRun,
  getCurrentControlRun: () => currentControlRun,
  permissionForUrl,
  renderJobMonitor,
  renderSitePermissionPanel,
  restartBrowserJob: (job) => runControlCommand(job.goal, { resumedFromJob: job }),
  saveBrowserJobReportToArchive,
  setActivity,
  setSitePermission,
  setStatus,
  siteKeyForUrl,
  tickBrowserJobScheduler,
  updateBrowserJob
});

browserJobScheduler = createBrowserJobScheduler({
  browserJobStore,
  maxConcurrent: 2,
  onJobFailed: async (jobId, error) => {
    renderJobMonitor();
    await addMessage("system", `Browser job ${jobId} failed in scheduler: ${error instanceof Error ? error.message : String(error)}`);
    setStatus("Control failed");
  },
  onJobFinished: async () => {
    renderJobMonitor();
    setStatus("Ready");
  },
  onJobStarted: async (job) => {
    setActivity("browser-control", "Starting queued browser job", `${job.id} · ${job.goal}`);
    renderJobMonitor();
    setStatus(`Running ${job.id}`);
  },
  runJob: runScheduledBrowserJob
});
browserJobScheduler.start();

const showBrowserJobsCommand = async (body) => {
  contextDockExpanded = true;
  await persistContextDockExpanded();
  await browserJobStore.setMonitorCollapsed(false);
  renderJobMonitor();
  return runJobsCommand(body);
};

controlStopButton.addEventListener("click", () => {
  void cancelBrowserJob(currentControlRun?.id ?? browserJobStore.getActiveJobId() ?? "");
});

// A bare "summarize"/"tldr"/"recap" means "summarize the page I'm looking at":
// read it silently to populate the snapshot, then let the chat turn summarize
// with that page context (runChatTurn already injects pageContextForSnapshot).
// This yields an LLM summary that matches the inline floating-panel Summarize,
// without requiring /control.
const summarizeActivePage = async () => {
  await readActivePage({ announce: false });
  return runChatTurn();
};

const commandRouter = createSidePanelCommandRouter({
  allowControlPreflightOnceForTaskClass,
  bindMentionedTab,
  clickActivePageText,
  detectActivePageForms,
  explainStructuredPageEditBoundary,
  handleWalletBoundary,
  openBrowserUrl,
  pauseBrowserJob,
  prepareDaoWorkflowGuidance,
  resumeBrowserJob,
  cancelBrowserJob,
  approveControlPreflight,
  continueBrowserJob,
  // A bare "try again"/"continue" only continues a run when one exists to
  // continue; otherwise it stays a normal chat turn.
  hasResumableControlRun: () => browserJobStore.getJobs().length > 0,
  denyControlPreflight,
  runBrowserCommand,
  runCapabilitiesCommand,
  runChatTurn,
  runControlCommand,
  runDelegateCommand,
  runGoalCommand,
  runHermesStatusCommand,
  runHistorySearchCommand,
  runJobsCommand: showBrowserJobsCommand,
  runMemorySearchCommand,
  runNaturalDelegationCommand,
  runResonatorCommand,
  reportBrowserJob,
  runSitePermissionCommand,
  runStatusCommand,
  runWalletStatusCommand,
  saveWalletDaoAuditToArchive,
  saveIntake,
  scrollActivePage,
  searchBrowser,
  summarizeActivePage,
  summarizeSnapshot,
  typeIntoActivePage
});

const respondToCommand = commandRouter.respondToCommand;

chrome.runtime?.onMessage?.addListener?.(createSidePanelMessageRouter({
  cancelBrowserJob,
  getActiveBrowserJobId: () => currentControlRun?.id ?? browserJobStore.getActiveJobId() ?? ""
}));

const chatHydration = createSidePanelChatHydration({
  chatSessionStore,
  hydrateControlPreflight,
  hydrateProviderModelOptions: () => hydrateProviderModelOptions({
    bridgeRequest: currentBridgeRequest,
    getBridgeRequest,
    getPreferredModel: () => modelSelect.value,
    modelSelect,
    setStatus
  }),
  readPersonalizationSettings,
  renderAttachments,
  renderMessages,
  setContextDockExpanded: (expanded) => {
    contextDockExpanded = Boolean(expanded);
  },
  setContextMeter: () => setContextMeter(lastSnapshot),
  setPersonalizationSettings: (settings) => {
    personalizationSettings = settings;
  },
  storage: chrome.storage?.local,
  storageKeys: STORAGE_KEYS,
  updateConnectionLine
});
const hydrateChatSettings = chatHydration.hydrateChatSettings;

const lifecycleController = createSidePanelLifecycleController({
  activeTab,
  addMessage,
  allowControlPreflightOnceForTaskClass,
  allowCurrentTaskOnceForSafeActions,
  approvalAllowOnceButton,
  approvalApproveButton,
  approvalDelegateButton,
  approvalDenyButton,
  approvalTrustSiteButton,
  approveControlPreflight,
  approvePendingControlStep,
  attachFileButton,
  browserJobStore,
  clearActivitySoon,
  commandForm,
  commandInput,
  composerController,
  contextMeter,
  contextToggleButton,
  controlPreflightApproveButton,
  controlPreflightDenyButton,
  controlPreflightOnceButton,
  controlPreflightTrustButton,
  delegateControlIssue,
  denyControlPreflight,
  denyPendingControlStep,
  dictateButton,
  dictationController,
  fileInput,
  getLastSnapshot: () => lastSnapshot,
  getPendingControlPreflight: () => pendingControlPreflight,
  getStatusLabel: () => statusLabel,
  getTurnBusy: () => turnBusy,
  jobMonitorClear,
  jobMonitorToggle,
  workspaceToggle,
  toggleMainWorkspace: () => mainWorkspaceToggle.toggle(),
  getMainWorkspaceVisible: () => mainWorkspaceToggle.isVisible(),
  messageActions,
  modelSelect,
  persistChatState,
  persistContextDockExpanded,
  readActivePage,
  readButton,
  renderJobMonitor,
  renderSitePermissionPanel,
  respondToCommand,
  runBusyUiAction,
  saveIntake,
  saveIntakeButton,
  saveSelectionButton,
  setActivity,
  setContextDockExpanded: (valueOrUpdater) => {
    contextDockExpanded = typeof valueOrUpdater === "function"
      ? Boolean(valueOrUpdater(contextDockExpanded))
      : Boolean(valueOrUpdater);
  },
  setContextMeter,
  setSitePermission,
  setStatus,
  setTurnBusy,
  sitePermissionMode,
  stopChatTurn,
  storage: chrome.storage?.local,
  storageOnChanged: chrome.storage?.onChanged,
  storageKeys: STORAGE_KEYS,
  tabContextController,
  thinkingDepthSelect,
  toggleContextPopover,
  transcript,
  trustControlPreflightForSafeActions,
  trustCurrentTaskForSafeActions,
  updateConnectionLine,
  windowRef: window
});
const consumePendingSidebarPrompt = lifecycleController.consumePendingSidebarPrompt;
window.__resonantosSidePanelReady = false;
try {
  lifecycleController.bindListeners();
  regenerationModeSelect?.addEventListener("change", () => void setRegenerationModePreference(regenerationModeSelect.value));
  window.__resonantosSidePanelReady = true;
} catch (error) {
  window.__resonantosSidePanelReadyError = error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: String(error) };
  throw error;
}

hydrateChatSettings().then(async () => {
  await hydrateRegenerationModePreference();
  chatsTreeRenderer.render();
  await loadBrowserJobs();
  await tabContextController.hydrateInitialContext();
  await consumePendingSidebarPrompt();
}).catch((error) => {
  setStatus("Context failed");
  setComposerNotice(`Current page context unavailable: ${String(error)}`);
});
