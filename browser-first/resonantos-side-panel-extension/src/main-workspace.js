import { createBrowserPageActions } from "./lib/browser-page-actions.js";
import { normalizeBrowserUrl } from "./lib/browser-command-parser.js";
import { createBridgeClient, createRawBridgeFetch, detectLoopbackBridge, initCapabilityTokens, isUnauthorizedBridgeError, resolveBridgeConfig } from "./lib/bridge-client.js";
import { createPrefsSync } from "./lib/prefs-sync.js";
import { createChatSessionStore } from "./lib/chat-session-store.js";
import { createComposerController } from "./lib/composer-controller.js";
import {
  contextUsageSnapshot,
  createDictationController,
  hydrateProviderModelOptions,
  modelLabel,
  renderContextMemoryPopover,
  supportsThinkingDepth,
  updateContextMeterElement
} from "./lib/composer-runtime.js";
import { applyAppearancePreferences } from "./lib/settings/appearance-section.js";
import { renderAddOnsWorkspace } from "./lib/main-workspace-addons.js";
import { renderArtifactsWorkspace } from "./lib/main-workspace-artifacts.js";
import { createMainWorkspaceBrowserJobController } from "./lib/main-workspace-browser-job-controller.js";
import {
  mainBrowserJobSnapshot,
  renderMainBrowserJobStatus
} from "./lib/main-workspace-browser-jobs.js";
import { renderHermesDashboardWorkspace } from "./lib/main-workspace-hermes.js";
import { renderLivingArchiveWorkspace } from "./lib/main-workspace-memory.js";
import { renderOpenCodeWorkspace } from "./lib/main-workspace-opencode.js";
import { readPersonalizationSettings } from "./lib/personalization-settings.js";
import { runReviewableCapture } from "./lib/main-workspace-review-handoff.js";
import { createMainWorkspaceActionController } from "./lib/main-workspace-action-controller.js";
import { createMainWorkspaceRailController } from "./lib/main-workspace-rail-controller.js";
import { isRailVisibleChatSession, railSearchMatchesProject, railSearchMatchesSession } from "./lib/main-workspace-rail.js";
import { renderSettingsWorkspace } from "./lib/main-workspace-settings.js";
import { createMessageActionController } from "./lib/message-action-controller.js";
import { createSitePermissionStore } from "./lib/site-permission-store.js";
import { createSidePanelRenderers } from "./lib/side-panel-renderers.js";
import { createTaskConsentStore } from "./lib/task-consent-store.js";

const STORAGE_KEYS = {
  messages: "augmentorBrowserMessages",
  forks: "augmentorBrowserForks",
  sessions: "augmentorBrowserSessions",
  activeSessionId: "augmentorActiveBrowserSessionId",
  model: "augmentorModel",
  thinkingDepth: "augmentorThinkingDepth",
  attachments: "augmentorBrowserAttachments",
  projects: "augmentorBrowserProjects",
  pendingSidebarPrompt: "augmentorPendingSidebarPrompt",
  activeWorkspace: "augmentorMainWorkspace",
  augmentorConfig: "augmentorConfig",
  sitePermissions: "augmentorSitePermissions",
  sitePermissionAudit: "augmentorSitePermissionAudit",
  taskConsents: "augmentorTaskConsents",
  taskConsentAudit: "augmentorTaskConsentAudit",
  regenerationMode: "augmentorRegenerationMode",
  browserJobs: "augmentorBrowserJobs",
  activeBrowserJob: "augmentorActiveBrowserJob",
  appearance: "augmentorAppearancePreferences",
  starterPromptsHidden: "augmentorStarterPromptsHidden",
  userProfile: "augmentorUserProfile"
};

const transcript = document.querySelector("#transcript");
const workspaceButtons = [...document.querySelectorAll("[data-workspace]")];
const newChatButton = document.querySelector("#new-chat");
const openSidebarButton = document.querySelector("#open-sidebar");
const mainBrowserJobs = document.querySelector("#main-browser-jobs");
const railNewChatButton = document.querySelector("#rail-new-chat");
const railSearchToggle = document.querySelector("#rail-search-toggle");
const railSearchBox = document.querySelector("#rail-search-box");
const railSearchInput = document.querySelector("#rail-search-input");
const railClearSearch = document.querySelector("#rail-clear-search");
const railChatList = document.querySelector("#rail-chat-list");
const railNewProjectButton = document.querySelector("#rail-new-project");
const railProjectList = document.querySelector("#rail-project-list");
const railAvatar = document.querySelector("#rail-avatar");
const railUserName = document.querySelector("#rail-user-name");
const railUserSubtitle = document.querySelector("#rail-user-subtitle");
const commandForm = document.querySelector("#command-form");
const commandInput = document.querySelector("#command-input");
const attachFileButton = document.querySelector("#attach-file");
const fileInput = document.querySelector("#file-input");
const attachmentStrip = document.querySelector("#attachment-strip");
const readPageButton = document.querySelector("#read-page");
const saveIntakeButton = document.querySelector("#save-intake");
const saveSelectionButton = document.querySelector("#save-selection");
const contextToggleButton = document.querySelector("#context-toggle");
const modelSelect = document.querySelector("#model-select");
const thinkingDepthSelect = document.querySelector("#thinking-depth");
const regenerationModeSelect = document.querySelector("#regeneration-mode");
const dictateButton = document.querySelector("#dictate-button");
const contextMeter = document.querySelector("#context-meter");
const contextPopover = document.querySelector("#context-popover");
const composerNotice = document.querySelector("#composer-notice");
const connectionLine = document.querySelector("#connection-line");
const sendButton = commandForm.querySelector(".send-button");
// `bridgeRequest` and `rawFetch` are `let` because the rebind chain
// below replaces them once loopback detection has settled. Anything
// that holds a reference to the current value (e.g. prefsSync's getter)
// will see the updated function on the next call.
//
// We deliberately use .then() chains (not top-level await) because
// some Chromium/Edge builds throw "Service worker registration
// failed" if the extension page's top-level evaluation awaits a
// fetch. The promise itself still resolves before any user interaction
// is possible, so message handlers that fire during the bootstrap
// window simply retry on the next event.
let bridgeRequest = null;
let rawFetch = null;
let prefsSync = null;
let rebindInFlight = null;

function rebindBridge({ forceResolve = false, refreshGenerated = false } = {}) {
  if (rebindInFlight && !forceResolve) return rebindInFlight;
  rebindInFlight = resolveBridgeConfig({ refreshGenerated })
    .then((cfg) => detectLoopbackBridge(cfg))
    .then((cfg) => {
      bridgeRequest = createBridgeClient(cfg);
      rawFetch = createRawBridgeFetch(cfg);
      if (!prefsSync) {
        prefsSync = createPrefsSync({ getBridgeRequest: () => bridgeRequest });
        prefsSync.install();
      }
      return initCapabilityTokens(cfg)
        .catch(() => undefined)
        .then(() => ({ cfg, bridgeRequest, rawFetch }));
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

async function currentRawFetch(route, options = {}) {
  const req = typeof rawFetch === "function"
    ? rawFetch
    : (await hydrateAfterRebind())?.rawFetch;
  if (typeof req !== "function") {
    throw new Error("Browser bridge raw fetch is unavailable.");
  }
  const response = await req(route, options);
  if (response?.status !== 401) return response;
  rebindInFlight = null;
  const rebound = await hydrateAfterRebind({ forceResolve: true, refreshGenerated: true });
  if (typeof rebound?.rawFetch !== "function") return response;
  return rebound.rawFetch(route, options);
}

const getBridgeRequest = () => currentBridgeRequest;

void hydrateAfterRebind();

chrome?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== "local") return;
  if (!changes?.bridgeTargetOverride) return;
  rebindInFlight = null;
  void hydrateAfterRebind();
});
let busy = false;
let activeWorkspace = "answer";
let pendingWorkspaceAction = null;
let controlledTabId = null;
let lastSnapshot = null;
let railSearchQuery = "";
let starterPromptsHidden = false;
let contextPopoverOpen = false;
let contextCompactNotice = "";
let personalizationSettings = null;
let initialSettingsSection = "overview";
let messageActions = null;
const allowedWorkspaces = new Set(["answer", "artifacts", "addons", "memory", "hermes", "opencode", "settings"]);

function normalizeRegenerationMode(value) {
  return value === "overwrite" ? "overwrite" : "branch";
}

function parseWorkspaceDeepLink(hash = window.location.hash) {
  const normalized = String(hash ?? "").replace(/^#/, "").trim();
  if (!normalized) return null;
  const [workspace, section] = normalized.split("/").map((part) => part.trim()).filter(Boolean);
  if (workspace === "settings") {
    return {
      workspace: "settings",
      settingsSection: section || "overview",
    };
  }
  if (allowedWorkspaces.has(workspace)) {
    return { workspace };
  }
  return null;
}

function updateWorkspaceDeepLink(workspaceId, { settingsSection = "" } = {}) {
  const nextHash = workspaceId === "settings"
    ? `#settings/${settingsSection || initialSettingsSection || "overview"}`
    : workspaceId === "answer"
      ? ""
      : `#${workspaceId}`;
  if (window.location.hash === nextHash) return;
  if (!nextHash) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return;
  }
  window.history.replaceState(null, "", nextHash);
}

function applyUserProfile(profile) {
  if (!profile) return;
  const name = profile.displayName || "ResonantOS User";
  if (railAvatar) railAvatar.textContent = name.trim().charAt(0).toUpperCase() || "R";
  if (railUserName) railUserName.textContent = name;
  if (railUserSubtitle) railUserSubtitle.textContent = profile.subtitle || "Local sovereign profile";
}

async function hydratePersonalizationSettings() {
  personalizationSettings = await readPersonalizationSettings(chrome.storage?.local, STORAGE_KEYS);
  applyUserProfile(personalizationSettings.profile);
  return personalizationSettings;
}

function setComposerBusy(next) {
  busy = Boolean(next);
  commandInput.disabled = busy;
  sendButton.classList.toggle("is-stop", busy);
  sendButton.setAttribute("aria-label", busy ? "Stop response" : "Send");
  sendButton.title = busy ? "Stop response" : "Send";
  sendButton.innerHTML = busy
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="8" height="8" rx="1.8"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
}

const composerController = createComposerController({
  commandForm,
  commandInput,
  forceClipboardFallback: true,
  navigator
});
const chatSessionStore = createChatSessionStore({
  storage: chrome.storage?.local,
  storageKeys: STORAGE_KEYS,
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
const sitePermissionStore = createSitePermissionStore({
  storage: chrome.storage?.local,
  sitePermissionAuditStorageKey: STORAGE_KEYS.sitePermissionAudit,
  sitePermissionStorageKey: STORAGE_KEYS.sitePermissions
});
const taskConsentStore = createTaskConsentStore({
  storage: chrome.storage?.local,
  taskConsentAuditStorageKey: STORAGE_KEYS.taskConsentAudit,
  taskConsentStorageKey: STORAGE_KEYS.taskConsents
});

const isReadableBrowserTab = (tab) => typeof tab?.url === "string" && /^https?:\/\//i.test(tab.url);
const setMainActivity = (_phase, label, detail = "") => {
  updateConnectionLine(detail ? `${label}: ${detail}` : label);
};
const browserPageActions = createBrowserPageActions({
  addMessage,
  bridgeRequest: currentBridgeRequest,
  getBridgeRequest,
  chrome,
  getControlledTabId: () => controlledTabId,
  getLastSnapshot: () => lastSnapshot,
  getModel: () => modelSelect.value,
  getThinkingDepth: () => thinkingDepthSelect.value,
  isReadableBrowserTab,
  normalizeBrowserUrl,
  permissionForUrl: sitePermissionStore.permissionForUrl,
  renderSitePermissionPanel: async () => undefined,
  setActivity: setMainActivity,
  setContextMeter: () => updateContextMeter(),
  setControlledTabId: (tabId) => {
    controlledTabId = tabId;
  },
  setLastSnapshot: (snapshot) => {
    lastSnapshot = snapshot;
  },
  setReadButtonTitle: (title) => {
    readPageButton.title = title;
  },
  setStatus: updateConnectionLine,
  siteKeyForUrl: sitePermissionStore.siteKeyForUrl,
  sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
});

const mainWorkspaceActions = createMainWorkspaceActionController({
  addMessage,
  bridgeRequest: currentBridgeRequest,
  getBridgeRequest,
  browserPageActions,
  chatSessionStore,
  chromeApi: chrome,
  commandInput,
  composerController,
  composerNotice,
  getBusy: () => busy,
  getLastSnapshot: () => lastSnapshot,
  getModel: () => modelSelect.value,
  getPersonalizationSettings: () => personalizationSettings,
  getThinkingDepth: () => thinkingDepthSelect.value,
  openMemoryReviewQueue,
  openSidebar,
  persistActiveWorkspace,
  renderAll,
  setActiveWorkspace,
  setComposerBusy,
  setPendingWorkspaceAction: (action) => {
    pendingWorkspaceAction = action;
  },
  updateConnectionLine
});

const mainBrowserJobController = createMainWorkspaceBrowserJobController({
  addSystemMessage: (content) => addMessage("system", content),
  afterChange: () => renderMainBrowserJobStatusFromStorage(),
  openSidebar: () => openSidebar(),
  storage: chrome.storage?.local,
  storageKeys: STORAGE_KEYS
});

async function renderMainBrowserJobStatusFromStorage() {
  if (activeWorkspace !== "answer") {
    if (mainBrowserJobs) mainBrowserJobs.hidden = true;
    return mainBrowserJobSnapshot();
  }
  const snapshot = await mainBrowserJobController.readJobs();
  return renderMainBrowserJobStatus({
    ...snapshot,
    container: mainBrowserJobs,
    maxConcurrent: 2,
    onCancelFocused: mainBrowserJobController.cancelJob,
    onContinueFocused: mainBrowserJobController.continueJob,
    onFocusJob: mainBrowserJobController.focusJob,
    onOpenMonitor: mainBrowserJobController.openMonitor,
    onPauseFocused: mainBrowserJobController.pauseJob
  });
}

const chatRenderers = createSidePanelRenderers({
  attachmentStrip,
  transcript,
  getAttachments: () => chatSessionStore.getAttachments(),
  getMessages: () => chatSessionStore.getMessages(),
  onRemoveAttachment: async (id) => {
    await chatSessionStore.removeAttachment(id);
    renderAttachments();
    updateConnectionLine("Attachment removed");
  },
  onCopyMessage: (id) => void messageActions?.copyMessage(id),
  onDeleteMessage: (id) => void messageActions?.deleteMessage(id),
  onEditMessage: (id) => messageActions?.editMessage(id),
  onForkMessage: (id) => void forkFromMessage(id),
  onRegenerateMessage: (id) => void messageActions?.regenerateFromMessage(id),
  onSaveMessageToArchive: (id) => void messageActions?.saveMessageToArchive(id),
  onShowMessageStats: (id) => void messageActions?.showMessageStats(id),
  renderEmptyState: (container) => {
    container.append(emptyHero());
  },
  scrollTranscriptToBottom: () => {
    requestAnimationFrame(() => {
      transcript.scrollTop = transcript.scrollHeight;
    });
  },
  window
});

messageActions = createMessageActionController({
  addMessage,
  bridgeRequest: currentBridgeRequest,
  getBridgeRequest,
  chatSessionStore,
  commandInput,
  composerController,
  fileInput,
  flashCopied: (id) => chatRenderers.flashCopied(id),
  getLastSnapshot: () => lastSnapshot,
  getRegenerationMode: () => normalizeRegenerationMode(regenerationModeSelect?.value),
  getRespondToCommand: () => mainWorkspaceActions.regenerate,
  navigator,
  renderAttachments,
  renderMessages,
  setStatus: updateConnectionLine
});

function updateConnectionLine(status = "Ready") {
  const model = modelLabel(modelSelect.value);
  thinkingDepthSelect.hidden = !supportsThinkingDepth(modelSelect.value);
  connectionLine.title = `Connected to ${model} · ${status}`;
  connectionLine.setAttribute("aria-label", connectionLine.title);
  connectionLine.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h4l2-7 4 14 2-7h4"/></svg>
  `;
}

function setComposerNotice(message = "") {
  if (!composerNotice) return;
  delete composerNotice.dataset.kind;
  composerNotice.textContent = message;
  composerNotice.hidden = !message;
}

function openMemoryReviewQueue(handoff = {}) {
  pendingWorkspaceAction = {
    workspace: "memory",
    reviewRequestPath: handoff.reviewRequestPath || handoff.path || "",
    artifactPath: handoff.path || handoff.artifactPath || "",
    promotedPage: handoff.promotedPage || handoff.pagePath || ""
  };
  setActiveWorkspace("memory", { persist: true });
  renderAll();
}

function updateContextMeter() {
  const usage = contextUsageSnapshot({
    attachments: chatSessionStore.getAttachments(),
    messages: chatSessionStore.getMessages(),
    model: modelSelect.value,
    pageSnapshot: lastSnapshot
  });
  updateContextMeterElement(contextMeter, usage);
  if (contextPopoverOpen) {
    renderContextPopover(usage);
  }
}

function compactContextLocally() {
  const messages = chatSessionStore.getMessages();
  const recent = messages.slice(-8);
  contextCompactNotice = `Compact memory refreshed locally. ${recent.length}/${messages.length} recent turns are preserved for continuity; raw transcript remains intact.`;
  renderContextPopover();
}

function renderContextPopover(snapshot = contextUsageSnapshot({
  attachments: chatSessionStore.getAttachments(),
  messages: chatSessionStore.getMessages(),
  model: modelSelect.value,
  pageSnapshot: lastSnapshot
})) {
  renderContextMemoryPopover(contextPopover, snapshot, {
    notice: contextCompactNotice,
    onClose: () => {
      contextPopoverOpen = false;
      contextPopover.hidden = true;
      contextMeter.setAttribute("aria-expanded", "false");
    },
    onCompact: compactContextLocally
  });
}

function toggleContextPopover() {
  contextPopoverOpen = !contextPopoverOpen;
  contextPopover.hidden = !contextPopoverOpen;
  contextMeter.setAttribute("aria-expanded", contextPopoverOpen ? "true" : "false");
  if (contextPopoverOpen) {
    contextCompactNotice = "";
    renderContextPopover();
  }
}

const railController = createMainWorkspaceRailController({
  allowedWorkspaces,
  chatSessionStore,
  document,
  getActiveWorkspace: () => activeWorkspace,
  getRailSearchQuery: () => railSearchQuery,
  persistActiveWorkspace,
  railChatList,
  railClearSearch,
  railProjectList,
  railSearchMatchesProject,
  railSearchMatchesSession,
  isRailVisibleChatSession,
  renderAll,
  setActiveWorkspaceId: (workspaceId) => {
    activeWorkspace = workspaceId;
  },
  updateConnectionLine,
  window,
  workspaceButtons,
});

const {
  assignSessionProject,
  createProjectFromRail,
  renderRailNavigation,
  switchToSession,
} = railController;

function setActiveWorkspace(workspaceId, { bindSession = false, persist = false } = {}) {
  activeWorkspace = allowedWorkspaces.has(workspaceId) ? workspaceId : "answer";
  document.body.dataset.workspace = activeWorkspace;
  commandForm.hidden = activeWorkspace !== "answer";
  if (persist) {
    void persistActiveWorkspace();
    if (bindSession) {
      void chatSessionStore.setActiveSessionWorkspace(activeWorkspace);
    }
  }
}

async function persistActiveWorkspace() {
  await chrome.storage?.local?.set?.({
    [STORAGE_KEYS.activeWorkspace]: activeWorkspace
  }).catch(() => undefined);
}

async function hydrateActiveWorkspace() {
  const deepLink = parseWorkspaceDeepLink();
  if (deepLink?.workspace) {
    activeWorkspace = deepLink.workspace;
    if (deepLink.settingsSection) {
      initialSettingsSection = deepLink.settingsSection;
    }
    return;
  }
  const settings = await chrome.storage?.local?.get?.([STORAGE_KEYS.activeWorkspace]).catch(() => ({}));
  activeWorkspace = allowedWorkspaces.has(settings?.[STORAGE_KEYS.activeWorkspace])
    ? settings[STORAGE_KEYS.activeWorkspace]
    : "answer";
}

async function hydrateAppearancePreferences() {
  const settings = await chrome.storage?.local?.get?.([STORAGE_KEYS.appearance]).catch(() => ({}));
  applyAppearancePreferences(settings?.[STORAGE_KEYS.appearance]);
}

async function hydrateStarterPromptPreference() {
  const settings = await chrome.storage?.local?.get?.([STORAGE_KEYS.starterPromptsHidden]).catch(() => ({}));
  starterPromptsHidden = Boolean(settings?.[STORAGE_KEYS.starterPromptsHidden]);
}

async function setStarterPromptPreference(hidden) {
  starterPromptsHidden = Boolean(hidden);
  await chrome.storage?.local?.set?.({
    [STORAGE_KEYS.starterPromptsHidden]: starterPromptsHidden
  }).catch(() => undefined);
  renderMessages();
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

function renderAttachments() {
  chatRenderers.renderAttachments();
}

const starterPrompts = [
  {
    eyebrow: "Strategy",
    title: "Plan the next move",
    prompt: "Help me think through the best next step for this project."
  },
  {
    eyebrow: "Web",
    title: "Research current context",
    prompt: "Search the web for the latest useful context about "
  },
  {
    eyebrow: "Page",
    title: "Read this page",
    prompt: "Read the current page and summarize what matters."
  },
  {
    eyebrow: "Risk",
    title: "Find blind spots",
    prompt: "Find the risks, blind spots, and next actions for this plan: "
  },
  {
    eyebrow: "Memory",
    title: "Search AI memory",
    prompt: "/memory "
  },
  {
    eyebrow: "Delegate",
    title: "Send to Hermes",
    prompt: "/hermes Research this and return sources, risks, and next actions: "
  }
];

function emptyHero() {
  const hero = document.createElement("section");
  hero.className = "empty-hero";
  hero.innerHTML = `
    <div class="empty-hero-copy">
      <span class="hero-kicker">AI browser workspace</span>
      <h1>Ask, browse, remember, delegate.</h1>
      <p>Start in full-screen Augmentor. If a task needs the web, memory, Hermes, or OpenCode, ResonantOS routes it through the governed command layer.</p>
    </div>
  `;

  const controls = document.createElement("div");
  controls.className = "starter-prompt-controls";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = starterPromptsHidden ? "Show suggestions" : "Hide suggestions";
  toggle.addEventListener("click", () => void setStarterPromptPreference(!starterPromptsHidden));
  controls.append(toggle);
  hero.append(controls);

  if (!starterPromptsHidden) {
    const grid = document.createElement("div");
    grid.className = "starter-prompt-grid";
    grid.setAttribute("aria-label", "Augmentor prompt suggestions");
    for (const item of starterPrompts.slice(0, 6)) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.prompt = item.prompt;
      button.innerHTML = `
        <span></span>
        <strong></strong>
      `;
      button.querySelector("span").textContent = item.eyebrow;
      button.querySelector("strong").textContent = item.title;
      button.addEventListener("click", () => {
        commandInput.value = button.dataset.prompt;
        composerController.resetUndoStack(commandInput.value);
        commandInput.focus();
        commandInput.setSelectionRange?.(commandInput.value.length, commandInput.value.length);
      });
      grid.append(button);
    }
    hero.append(grid);
  }
  return hero;
}

function renderMessages() {
  transcript.replaceChildren();
  if (activeWorkspace === "hermes") {
    renderHermesWorkspace();
    return;
  }
  if (activeWorkspace === "memory") {
    const initialQuery = pendingWorkspaceAction?.workspace === "memory" ? pendingWorkspaceAction.query : "";
    const initialReviewPath = pendingWorkspaceAction?.workspace === "memory" ? pendingWorkspaceAction.reviewRequestPath : "";
    const initialArtifactPath = pendingWorkspaceAction?.workspace === "memory" ? pendingWorkspaceAction.artifactPath : "";
    const initialPromotedPage = pendingWorkspaceAction?.workspace === "memory" ? pendingWorkspaceAction.promotedPage : "";
    pendingWorkspaceAction = null;
    renderLivingArchiveWorkspace({ container: transcript, bridgeRequest: currentBridgeRequest, getBridgeRequest, initialQuery, initialReviewPath, initialArtifactPath, initialPromotedPage });
    return;
  }
  if (activeWorkspace === "artifacts") {
    renderArtifactsWorkspace({
      container: transcript,
      bridgeRequest: currentBridgeRequest,
      getBridgeRequest,
      onContinueArtifact: continueFromArtifact,
      onOpenReviewQueue: openMemoryReviewQueue
    });
    return;
  }
  if (activeWorkspace === "addons") {
    renderAddOnsWorkspace({
      container: transcript,
      bridgeRequest: currentBridgeRequest,
      getBridgeRequest,
      onOpenProviderHandoff: async (handoff) => {
        if (!handoff?.url) return;
        await chrome.tabs.create({ url: handoff.url }).catch(() => undefined);
        await addMessage("system", `Opened ${handoff.provider} draft for human review. ResonantOS did not send or schedule anything.`);
      },
      onOpenWorkspace: async (workspaceId) => {
        setActiveWorkspace(workspaceId, { persist: true });
        renderAll();
      }
    });
    return;
  }
  if (activeWorkspace === "opencode") {
    const initialMission = pendingWorkspaceAction?.workspace === "opencode" ? pendingWorkspaceAction.mission : "";
    pendingWorkspaceAction = null;
    renderOpenCodeWorkspace({ container: transcript, bridgeRequest: currentBridgeRequest, getBridgeRequest, initialMission });
    return;
  }
  if (activeWorkspace === "settings") {
    renderSettingsWorkspace({
      container: transcript,
      bridgeRequest: currentBridgeRequest,
      getBridgeRequest,
      chatSessionStore,
      onOpenSession: async (sessionId) => {
        await switchToSession(sessionId);
      },
      onProfileUpdated: (next) => {
        personalizationSettings = next;
        applyUserProfile(next.profile);
      },
      onOpenWorkspace: async (workspaceId) => {
        setActiveWorkspace(workspaceId, { persist: true });
        renderAll();
      },
      onRestore: renderAll,
      chromeApi: chrome,
      sitePermissionStore,
      storage: chrome.storage?.local,
      storageKeys: STORAGE_KEYS,
      taskConsentStore,
      prefsSync,
      initialSection: initialSettingsSection
    });
    return;
  }
  chatRenderers.renderMessages();
}

async function forkFromMessage(messageId) {
  await messageActions?.forkFromMessage(messageId);
  activeWorkspace = "answer";
  await persistActiveWorkspace();
  renderAll();
}

function renderAll() {
  setActiveWorkspace(activeWorkspace);
  renderMessages();
  renderAttachments();
  renderRailNavigation();
  void renderMainBrowserJobStatusFromStorage();
  updateContextMeter();
  updateConnectionLine();
}

function workspaceShell({ eyebrow, title, body }) {
  const section = document.createElement("section");
  section.className = "module-workspace";
  const copy = document.createElement("div");
  copy.className = "module-copy";
  const eyebrowNode = document.createElement("span");
  eyebrowNode.className = "module-eyebrow";
  eyebrowNode.textContent = eyebrow;
  const titleNode = document.createElement("h1");
  titleNode.textContent = title;
  const bodyNode = document.createElement("p");
  bodyNode.textContent = body;
  copy.append(eyebrowNode, titleNode, bodyNode);
  section.append(copy);
  return section;
}

async function statusForAddon(addonId) {
  const result = await currentBridgeRequest("/addons/status", { method: "GET" });
  return result?.addons?.find((addon) => addon.id === addonId) ?? null;
}

function renderStatusWorkspace({ eyebrow, title, body, addonId }) {
  const section = workspaceShell({ eyebrow, title, body });
  const status = document.createElement("div");
  status.className = "module-card";
  status.textContent = "Checking add-on status...";
  section.append(status);
  transcript.append(section);
  void statusForAddon(addonId).then((addon) => {
    status.textContent = addon
      ? `${addon.name}: ${addon.available ? "available" : "not available"} · ${addon.mode} · ${addon.trust}`
      : "This add-on is not registered yet.";
  }).catch((error) => {
    status.textContent = `Status unavailable: ${error instanceof Error ? error.message : String(error)}`;
  });
}

async function renderHermesWorkspace() {
  // Resolve the bridge URL fresh on each render so the override flow works.
  // We await the loopback-detected config so the iframe and the JSON
  // endpoints both hit the same URL (no LAN-URL-first-then-rebind race).
  const cfg = await resolveBridgeConfig()
    .then((c) => detectLoopbackBridge(c))
    .catch(() => null);
  const effective = cfg ?? (globalThis.__RESONANTOS_BRIDGE_CONFIG__ ?? {});
  renderHermesDashboardWorkspace({
    container: transcript,
    bridgeRequest: currentBridgeRequest,
    getBridgeRequest,
    rawFetch: currentRawFetch,
    bridgeUrl: effective.bridgeUrl ?? "http://127.0.0.1:47773",
    bridgeToken: effective.bridgeToken ?? "",
    statusForAddon,
  });
}

async function addMessage(role, content, options = {}) {
  const message = await chatSessionStore.addMessage(role, content, options);
  if (message) renderAll();
  updateContextMeter();
  return message;
}

const dictationController = createDictationController({
  addMessage,
  button: dictateButton,
  commandInput,
  navigatorRef: navigator,
  onTranscript: () => composerController.pushUndoSnapshot(),
  setNotice: setComposerNotice,
  setStatus: updateConnectionLine,
  windowRef: window
});

async function openSidebar() {
  await chrome.runtime.sendMessage({
    channel: "resonantos.browser_first",
    type: "open_side_panel",
    force: true
  }).catch(() => undefined);
}

async function continueFromArtifact(artifact) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.pendingSidebarPrompt]: {
      prompt: `/control continue from artifact ${artifact.path}`,
      createdAt: new Date().toISOString(),
      artifactPath: artifact.path,
      artifactTitle: artifact.title ?? ""
    }
  });
  await addMessage("system", `Sent artifact to Augmentor sidebar for continuation: ${artifact.path}`);
  await openSidebar();
}

commandForm.addEventListener("submit", mainWorkspaceActions.handleSubmit);

composerController.bind();

async function createNewChat() {
  activeWorkspace = "answer";
  await persistActiveWorkspace();
  await chatSessionStore.createSession({ workspaceId: "answer" });
  commandInput.value = "";
  composerController.resetUndoStack("");
  renderAll();
  commandInput.focus();
}

newChatButton?.addEventListener("click", createNewChat);
openSidebarButton?.addEventListener("click", () => void openSidebar());
railNewChatButton?.addEventListener("click", createNewChat);
railSearchToggle?.addEventListener("click", () => {
  railSearchBox.hidden = !railSearchBox.hidden;
  if (!railSearchBox.hidden) {
    railSearchInput.focus();
    railSearchInput.select();
  }
});
railSearchInput?.addEventListener("input", () => {
  railSearchQuery = railSearchInput.value.trim();
  renderRailNavigation();
});
railClearSearch?.addEventListener("click", () => {
  railSearchQuery = "";
  railSearchInput.value = "";
  renderRailNavigation();
  railSearchInput.focus();
});
railNewProjectButton?.addEventListener("click", () => void createProjectFromRail());

document.querySelectorAll(".rail-recents[data-project-id]").forEach((target) => {
  target.addEventListener("dragover", (event) => {
    event.preventDefault();
    target.classList.add("drag-over");
    event.dataTransfer.dropEffect = "move";
  });
  target.addEventListener("dragleave", () => {
    target.classList.remove("drag-over");
  });
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    target.classList.remove("drag-over");
    const sessionId = event.dataTransfer.getData("text/plain");
    void assignSessionProject(sessionId, target.dataset.projectId ?? "");
  });
});

readPageButton?.addEventListener("click", () => void browserPageActions.readActivePage());
saveIntakeButton?.addEventListener("click", () => void runReviewableCapture(
  () => browserPageActions.saveCurrentPageToArchive(),
  { noticeContainer: composerNotice, onOpenReviewQueue: openMemoryReviewQueue }
));
saveSelectionButton?.addEventListener("click", () => void runReviewableCapture(
  () => browserPageActions.saveSelectionToArchive(),
  { noticeContainer: composerNotice, onOpenReviewQueue: openMemoryReviewQueue }
));
contextToggleButton?.addEventListener("click", () => void browserPageActions.summarizeSnapshot());
contextMeter?.addEventListener("click", toggleContextPopover);
workspaceButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.workspace === "settings") {
      initialSettingsSection = button.dataset.settingsSection || "overview";
    }
    setActiveWorkspace(button.dataset.workspace, { persist: true });
    updateWorkspaceDeepLink(activeWorkspace, { settingsSection: initialSettingsSection });
    renderAll();
    if (button.dataset.prompt) {
      commandInput.value = button.dataset.prompt;
      composerController.resetUndoStack(commandInput.value);
      if (button.dataset.workspace === "answer") {
        commandInput.focus();
      }
    }
  });
});
attachFileButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  await messageActions?.attachFiles(fileInput.files);
  renderAttachments();
});
modelSelect.addEventListener("change", () => void chatSessionStore.persist().then(() => {
  updateConnectionLine();
  updateContextMeter();
}));
thinkingDepthSelect.addEventListener("change", () => void chatSessionStore.persist());
regenerationModeSelect?.addEventListener("change", () => void setRegenerationModePreference(regenerationModeSelect.value));
dictateButton.addEventListener("click", () => {
  dictationController.toggle();
});
sendButton.addEventListener("click", (event) => {
  if (!busy) return;
  event.preventDefault();
  mainWorkspaceActions.abortActiveChat();
});
chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE_KEYS.browserJobs] || changes[STORAGE_KEYS.activeBrowserJob]) {
    void renderMainBrowserJobStatusFromStorage();
  }
});
window.addEventListener("hashchange", () => {
  const deepLink = parseWorkspaceDeepLink();
  if (!deepLink?.workspace) return;
  activeWorkspace = deepLink.workspace;
  if (deepLink.settingsSection) {
    initialSettingsSection = deepLink.settingsSection;
  }
  renderAll();
});

await hydrateProviderModelOptions({
  bridgeRequest: currentBridgeRequest,
  getBridgeRequest,
  getPreferredModel: () => modelSelect.value,
  modelSelect,
  setStatus: updateConnectionLine
});
await Promise.all([
  hydratePersonalizationSettings(),
  chatSessionStore.hydrate(),
  hydrateAppearancePreferences(),
  hydrateStarterPromptPreference(),
  hydrateRegenerationModePreference(),
  hydrateActiveWorkspace()
]);
const requestedDeepLink = parseWorkspaceDeepLink();
if (!requestedDeepLink) {
  await chatSessionStore.ensureFreshSession({ workspaceId: "answer" });
  activeWorkspace = "answer";
}
await persistActiveWorkspace();
renderAll();
