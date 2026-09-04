// Intent citation: docs/architecture/addon-skills/opencode/CODING_HANDOFF.md
// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

import { delegationGuidanceText } from "./delegation-guidance.js";
import { createOpenCodeSession } from "./main-workspace-opencode-session.js";
import { createOpenCodeBridgeSource } from "./opencode-bridge-source.js";
import { createOpenCodeSessionBrowser, seedEventsFromMessages } from "./opencode-session-browser.js";
import { renderDiffContent } from "./opencode-session-view.js";
import { opencodeStatusMessage } from "./runtime-error-messages.js";

function setStatus(node, text, tone = "neutral") {
  node.textContent = text;
  node.dataset.tone = tone;
}

function boundaryItem(text) {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}

function openCodeRuntimeSetupText(status = {}) {
  const lines = [];
  if (status.installHint) {
    lines.push(`Setup: ${status.installHint}`);
  }
  if (status.installCommand) {
    lines.push(`Primary command: ${status.installCommand}`);
  }
  if (Array.isArray(status.alternativeInstallCommands) && status.alternativeInstallCommands.length) {
    lines.push(`Alternatives: ${status.alternativeInstallCommands.join(" | ")}`);
  }
  if (status.configureCommand) {
    lines.push(`Existing install override: ${status.configureCommand}`);
  }
  if (status.overrideConfigured && !status.overrideFound) {
    lines.push(`Configured override was not found: ${status.overridePath || "OPENCODE_COMMAND"}`);
  }
  if (Array.isArray(status.searchedCommands) && status.searchedCommands.length) {
    lines.push(`Command names checked: ${status.searchedCommands.join(", ")}`);
  }
  if (Array.isArray(status.searchedPaths) && status.searchedPaths.length) {
    const suffix = status.searchedPathOmitted > 0 ? ` (+${status.searchedPathOmitted} more)` : "";
    lines.push(`Searched paths${suffix}:`);
    lines.push(...status.searchedPaths.slice(0, 12).map((candidate) => `- ${candidate}`));
  }
  return lines.join("\n");
}

function openCodeStatusMeta(status = {}) {
  const command = status.command || status.installCommand || "OpenCode command not detected";
  return [command, status.model ? `model ${status.model}` : ""].filter(Boolean).join(" · ");
}

function uniqueValues(values = []) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function modelValue(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  return entry.model ?? entry.id ?? entry.name ?? entry.label ?? "";
}

function modelsFromStatus(status = {}) {
  const raw = [
    status.model,
    ...(Array.isArray(status.models) ? status.models.map(modelValue) : []),
    ...(Array.isArray(status.catalog?.models) ? status.catalog.models.map(modelValue) : []),
    ...(Array.isArray(status.modelCatalog) ? status.modelCatalog.map(modelValue) : []),
    ...(Array.isArray(status.catalog) ? status.catalog.map(modelValue) : [])
  ];
  return uniqueValues(raw);
}

function agentValue(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  return entry.name ?? entry.id ?? entry.agent ?? entry.label ?? "";
}

function agentsFromPayload(payload = {}) {
  return uniqueValues((Array.isArray(payload.agents) ? payload.agents : []).map(agentValue));
}

function eventSessionId(raw) {
  const p = raw?.properties ?? raw?.payload ?? raw ?? {};
  return p.sessionID ?? p.sessionId ?? p.session?.id ?? raw?.sessionID ?? raw?.sessionId ?? "";
}

function eventTriggersDiff(raw, mountedSessionId = "") {
  const eventId = eventSessionId(raw);
  if (eventId && mountedSessionId && eventId !== mountedSessionId) return false;
  const type = String(raw?.type ?? raw?.kind ?? "").toLowerCase();
  return type.includes("file.edited") || type.includes("file-edited") || type.includes("session.diff") || type.includes("session-diff");
}

export function renderOpenCodeWorkspace({ container, bridgeRequest, getBridgeRequest, initialMission = "", confirmSessionDelete } = {}) {
  // Resolve at call time. The module-level `bridgeRequest` may be
  // null at construction (rebind still in flight); the getter lets
  // us re-read the current value on every call.
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const section = document.createElement("section");
  section.className = "opencode-main-workspace";
  section.setAttribute("aria-label", "OpenCode workspace");

  const header = document.createElement("header");
  header.className = "opencode-hero";
  const eyebrow = document.createElement("span");
  eyebrow.className = "module-eyebrow";
  eyebrow.textContent = "OpenCode";
  const title = document.createElement("h1");
  title.textContent = "Scoped coding work, delegated as an add-on task.";
  const body = document.createElement("p");
  body.textContent = "Create a governed coding handoff for OpenCode. ResonantOS records the task packet, attempts a host-mediated lifecycle start, and keeps local coding execution explicit until the runtime is enabled.";
  header.append(eyebrow, title, body);

  const statusCard = document.createElement("section");
  statusCard.className = "opencode-card opencode-status-card";
  const statusTitle = document.createElement("strong");
  statusTitle.textContent = "Runtime status";
  const statusBody = document.createElement("p");
  statusBody.textContent = "Checking OpenCode…";
  const statusMeta = document.createElement("code");
  statusMeta.textContent = "";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.textContent = "Refresh";
  const startSessionButton = document.createElement("button");
  startSessionButton.type = "button";
  startSessionButton.className = "opencode-start-session";
  startSessionButton.textContent = "Start live session";
  startSessionButton.hidden = true;
  const cockpitButton = document.createElement("button");
  cockpitButton.type = "button";
  cockpitButton.className = "opencode-cockpit-button";
  cockpitButton.textContent = "Open full cockpit (external, ungoverned)";
  cockpitButton.hidden = true;
  const cockpitConfirm = document.createElement("div");
  cockpitConfirm.className = "opencode-cockpit-confirm";
  cockpitConfirm.hidden = true;
  const cockpitWarningTitle = document.createElement("strong");
  cockpitWarningTitle.textContent = "OpenCode cockpit handoff";
  const cockpitWarning = document.createElement("p");
  cockpitWarning.textContent = "This opens the full OpenCode cockpit in a separate browser tab. It is LOCAL and UNGOVERNED: actions there bypass ResonantOS approvals, redaction, and audit, and that tab carries no ResonantOS banner.";
  const cockpitActions = document.createElement("div");
  cockpitActions.className = "opencode-cockpit-actions";
  const cockpitCancel = document.createElement("button");
  cockpitCancel.type = "button";
  cockpitCancel.textContent = "Cancel";
  const cockpitOpen = document.createElement("button");
  cockpitOpen.type = "button";
  cockpitOpen.textContent = "Open in browser tab";
  const cockpitStatus = document.createElement("p");
  cockpitStatus.className = "opencode-cockpit-status";
  cockpitActions.append(cockpitCancel, cockpitOpen);
  cockpitConfirm.append(cockpitWarningTitle, cockpitWarning, cockpitActions, cockpitStatus);
  statusCard.append(statusTitle, statusBody, statusMeta, refreshButton, startSessionButton, cockpitButton, cockpitConfirm);

  const boundaryCard = document.createElement("section");
  boundaryCard.className = "opencode-card";
  const boundaryTitle = document.createElement("strong");
  boundaryTitle.textContent = "Governance boundary";
  const boundaries = document.createElement("ul");
  boundaries.append(
    boundaryItem("OpenCode is an add-on agent, not a trusted core Strategist."),
    boundaryItem("Filesystem and shell access must stay scoped to an approved workspace."),
    boundaryItem("Changed files, commands run, tests, and residual risks must come back as artifacts."),
    boundaryItem("Provider secrets, wallet actions, and trusted Living Archive writes stay host-mediated.")
  );
  boundaryCard.append(boundaryTitle, boundaries);

  const taskForm = document.createElement("form");
  taskForm.className = "opencode-card opencode-task-form";
  const taskLabel = document.createElement("label");
  taskLabel.textContent = "Create OpenCode Delegation";
  const missionInput = document.createElement("textarea");
  missionInput.rows = 6;
  missionInput.placeholder = "Describe a bounded coding task. Include files/folders in scope, expected verification, and what OpenCode must return.";
  const taskButton = document.createElement("button");
  taskButton.type = "submit";
  taskButton.textContent = "Create Delegation Packet";
  const taskStatus = document.createElement("p");
  taskStatus.className = "opencode-workspace-status";
  taskForm.append(taskLabel, missionInput, taskButton, taskStatus);

  section.append(header, statusCard, boundaryCard, taskForm);
  container.append(section);
  let latestStatus = {};

  const loadStatus = async () => {
    refreshButton.disabled = true;
    try {
      const status = await bridge()("/opencode/status", { method: "GET" });
      latestStatus = status;
      const executionEnabled = status.executionEnabled !== false;
      statusBody.textContent = status.detail;
      statusMeta.textContent = openCodeStatusMeta(status);
      statusCard.dataset.ready = status.installed ? "true" : "false";
      startSessionButton.hidden = !status.installed;
      cockpitButton.hidden = status.executionEnabled !== true;
      if (cockpitButton.hidden) cockpitConfirm.hidden = true;
      if (!status.installed || !executionEnabled) {
        const guidance = statusCard.querySelector(".delegation-guidance") ?? document.createElement("pre");
        guidance.className = "delegation-guidance";
        guidance.textContent = [
          delegationGuidanceText({
            blockedReason: status.blockedReason || status.detail,
            executionEnabled,
            runtimeAvailable: Boolean(status.installed),
            target: "opencode"
          }),
          !status.installed ? openCodeRuntimeSetupText(status) : ""
        ].filter(Boolean).join("\n\n");
        statusCard.append(guidance);
      } else {
        statusCard.querySelector(".delegation-guidance")?.remove();
      }
    } catch (error) {
      statusBody.textContent = opencodeStatusMessage(error);
      statusMeta.textContent = "Status unavailable";
      statusCard.dataset.ready = "false";
      cockpitButton.hidden = true;
      cockpitConfirm.hidden = true;
      const guidance = statusCard.querySelector(".delegation-guidance") ?? document.createElement("pre");
      guidance.className = "delegation-guidance";
      guidance.textContent = delegationGuidanceText({
        blockedReason: statusBody.textContent,
        executionEnabled: false,
        runtimeAvailable: false,
        target: "opencode"
      });
      statusCard.append(guidance);
    } finally {
      refreshButton.disabled = false;
    }
  };

  refreshButton.addEventListener("click", () => void loadStatus());
  cockpitButton.addEventListener("click", () => {
    cockpitStatus.textContent = "";
    cockpitConfirm.hidden = false;
  });
  cockpitCancel.addEventListener("click", () => {
    cockpitStatus.textContent = "";
    cockpitConfirm.hidden = true;
  });
  cockpitOpen.addEventListener("click", async () => {
    cockpitOpen.disabled = true;
    cockpitStatus.textContent = "Issuing local OpenCode cockpit URL…";
    try {
      const result = await bridge()("/opencode/web/url", { method: "POST", body: {} });
      const url = String(result?.url ?? "");
      window.open(url, "_blank", "noopener,noreferrer");
      cockpitConfirm.hidden = true;
      cockpitStatus.textContent = "";
    } catch (error) {
      cockpitStatus.textContent = opencodeStatusMessage(error, "OpenCode cockpit URL unavailable");
    } finally {
      cockpitOpen.disabled = false;
    }
  });

  taskForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mission = missionInput.value.trim();
    if (mission.length < 8) {
      setStatus(taskStatus, "Describe a concrete OpenCode mission before creating a delegation.", "warning");
      return;
    }
    taskButton.disabled = true;
    setStatus(taskStatus, "Creating governed OpenCode delegation packet…");
    try {
      const result = await bridge()("/addons/delegate", {
        method: "POST",
        body: { target: "opencode", mission }
      });
      const started = await bridge()("/opencode/delegation/start", {
        method: "POST",
        body: { path: result.path }
      });
      const lifecycle = started.status === "completed"
        ? `Completed · ${started.resultArtifactPath || "result artifact ready"}`
        : started.status === "blocked"
          ? [
              delegationGuidanceText({
                blockedReason: started.blockedReason || "OpenCode runtime unavailable",
                executionEnabled: false,
                runtimeAvailable: false,
                target: "opencode"
              }),
              openCodeRuntimeSetupText(started)
            ].filter(Boolean).join("\n\n")
          : `Status ${started.status || "queued"}`;
      setStatus(taskStatus, `Delegation queued: ${result.id} · ${result.path}\n${lifecycle}`, started.status === "blocked" ? "warning" : "success");
      missionInput.value = "";
      await loadStatus();
    } catch (error) {
      setStatus(taskStatus, opencodeStatusMessage(error, "OpenCode delegation failed"), "error");
    } finally {
      taskButton.disabled = false;
    }
  });

  // Live workspace: a desktop-app-style two-pane shell — session browser rail
  // (search, Today/Older groups, resume-on-click, New session) on the left,
  // the streaming session element on the right. The bridge starts (reuses)
  // `opencode serve`; the element streams events directly from the server
  // (host_permissions cover 127.0.0.1) and routes prompts/permissions back
  // through the bridge. Resume replays history through the SAME event path the
  // live stream uses, so both render identically.
  const ide = document.createElement("div");
  ide.className = "opencode-ide";
  ide.hidden = true;
  const railMount = document.createElement("div");
  railMount.className = "opencode-ide-rail";
  const sessionArea = document.createElement("div");
  sessionArea.className = "opencode-session-area";
  ide.append(railMount, sessionArea);
  section.append(ide);
  let activeSession = null;
  let browserRail = null;
  const sessionSelections = new Map();
  let pickerOptions = { agents: [], models: [] };

  async function loadPickerOptions() {
    const models = modelsFromStatus(latestStatus);
    let agents = [];
    try {
      agents = agentsFromPayload(await bridge()("/opencode/agents/list", { method: "POST", body: {} }));
    } catch {
      agents = [];
    }
    pickerOptions = {
      agents: agents.length ? agents : ["build"],
      models: models.length ? models : [latestStatus.model].filter(Boolean)
    };
    return pickerOptions;
  }

  function selectionFor(sessionId) {
    const current = sessionSelections.get(sessionId) ?? {};
    const next = {
      agent: current.agent || pickerOptions.agents[0] || "build",
      model: current.model || pickerOptions.models[0] || ""
    };
    sessionSelections.set(sessionId, next);
    return next;
  }

  function rememberSelection(sessionId, patch) {
    sessionSelections.set(sessionId, { ...selectionFor(sessionId), ...patch });
  }

  function attachPickers(sessionId) {
    const composer = sessionArea.querySelector(".oc-composer");
    if (!composer || composer.querySelector(".oc-picker-strip")) return;
    const selected = selectionFor(sessionId);
    const strip = document.createElement("div");
    strip.className = "oc-picker-strip";

    const agent = document.createElement("select");
    agent.className = "oc-agent-picker";
    agent.setAttribute("aria-label", "OpenCode agent");
    for (const value of pickerOptions.agents) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      agent.append(option);
    }
    agent.value = selected.agent;
    agent.addEventListener("change", () => rememberSelection(sessionId, { agent: agent.value }));

    const modelId = `oc-model-options-${sessionId.replace(/[^a-z0-9_-]/gi, "-")}`;
    const model = document.createElement("input");
    model.className = "oc-model-picker";
    model.setAttribute("aria-label", "OpenCode model");
    model.setAttribute("list", modelId);
    model.placeholder = "model";
    model.value = selected.model;
    model.addEventListener("input", () => rememberSelection(sessionId, { model: model.value.trim() }));
    const modelList = document.createElement("datalist");
    modelList.id = modelId;
    for (const value of pickerOptions.models) {
      const option = document.createElement("option");
      option.value = value;
      modelList.append(option);
    }
    strip.append(agent, model, modelList);
    composer.prepend(strip);
  }

  function clearActiveSession(sessionId = "") {
    activeSession?.destroy?.();
    activeSession = null;
    sessionArea.replaceChildren();
    if (sessionId) browserRail?.setActive?.("");
  }

  function mountSession(info, seedMessages = [], { loadDiffOnMount = false } = {}) {
    activeSession?.destroy?.();
    sessionArea.replaceChildren();
    const sessionId = info.sessionId;
    const source = createOpenCodeBridgeSource({
      // Idempotent: return the already-known session so subscribe + prompt share it.
      startSession: async () => ({ sessionId, eventUrl: info.eventUrl, eventAuthorization: info.eventAuthorization }),
      openEventStream: (eventUrl) => fetch(eventUrl, info.eventAuthorization ? { headers: { Authorization: info.eventAuthorization } } : undefined),
      postJson: (path, body) => bridge()(path, { method: "POST", body })
    });
    const seeds = seedEventsFromMessages(seedMessages);
    let patchMount = null;
    let diffTimer = null;
    const refreshDiff = async () => {
      const target = patchMount;
      if (!target?.isConnected) return;
      try {
        const diff = await source.diff();
        if (patchMount === target && target.isConnected) renderDiffContent(target, diff, { document });
      } catch {
        if (patchMount === target && target.isConnected) renderDiffContent(target, [], { document });
      }
    };
    const scheduleDiff = () => {
      if (diffTimer) clearTimeout(diffTimer);
      diffTimer = setTimeout(() => void refreshDiff(), 1000);
    };
    const subscribe = (onEvent) => {
      for (const event of seeds) {
        onEvent(event);
        if (eventTriggersDiff(event, sessionId)) scheduleDiff();
      }
      return source.subscribe((event) => {
        onEvent(event);
        if (eventTriggersDiff(event, sessionId)) scheduleDiff();
      });
    };
    const session = createOpenCodeSession({
      document,
      container: sessionArea,
      scope: "",
      subscribe,
      sendPrompt: (text) => source.sendPrompt(text, selectionFor(sessionId)),
      onAbort: () => source.abort(),
      replyPermission: source.replyPermission,
      revert: async () => {}
    });
    activeSession = {
      ...session,
      destroy: () => {
        if (diffTimer) clearTimeout(diffTimer);
        diffTimer = null;
        patchMount = null;
        session.destroy?.();
      }
    };
    attachPickers(sessionId);
    const diffPane = sessionArea.querySelector(".oc-diffpane");
    if (diffPane) {
      patchMount = document.createElement("div");
      patchMount.className = "oc-patch-list";
      diffPane.append(patchMount);
    }
    if (loadDiffOnMount) void refreshDiff();
    browserRail?.setActive?.(sessionId);
  }

  function openWorkspaceShell() {
    header.hidden = true;
    boundaryCard.hidden = true;
    taskForm.hidden = true;
    ide.hidden = false;
    if (!browserRail) {
      browserRail = createOpenCodeSessionBrowser({
        document,
        container: railMount,
        projectName: "2.0.0-alpha",
        listSessions: () => bridge()("/opencode/sessions/list", { method: "POST", body: {} }),
        renameSession: (sessionId, title) => bridge()("/opencode/session/rename", { method: "POST", body: { sessionId, title } }),
        deleteSession: (sessionId) => bridge()("/opencode/session/delete", { method: "POST", body: { sessionId } }),
        archiveSession: (sessionId) => bridge()("/opencode/session/archive", { method: "POST", body: { sessionId, archived: Date.now() } }),
        confirmDelete: confirmSessionDelete,
        onActiveDeleted: (sessionId) => clearActiveSession(sessionId),
        onNewSession: () => void newSession(),
        onOpenSession: (sessionId) => void resumeSession(sessionId)
      });
    }
    void browserRail.refresh();
  }

  async function newSession() {
    setStatus(taskStatus, "Starting OpenCode session…");
    try {
      const info = await bridge()("/opencode/session/start", { method: "POST", body: {} });
      if (!info?.sessionId) throw new Error("No session id returned.");
      openWorkspaceShell();
      await loadPickerOptions();
      mountSession(info, []);
      await browserRail.refresh();
      browserRail.setActive(info.sessionId);
      setStatus(taskStatus, "");
    } catch (error) {
      setStatus(taskStatus, opencodeStatusMessage(error, "Could not start OpenCode session"), "error");
    }
  }

  async function resumeSession(sessionId) {
    setStatus(taskStatus, "Resuming session…");
    try {
      const list = await bridge()("/opencode/sessions/list", { method: "POST", body: {} });
      const history = await bridge()("/opencode/session/messages", { method: "POST", body: { sessionId } });
      await loadPickerOptions();
      mountSession({ sessionId, eventUrl: list.eventUrl, baseUrl: list.baseUrl, eventAuthorization: list.eventAuthorization }, history.messages ?? [], { loadDiffOnMount: true });
      setStatus(taskStatus, "");
    } catch (error) {
      setStatus(taskStatus, opencodeStatusMessage(error, "Could not resume OpenCode session"), "error");
    }
  }

  async function startLiveSession() {
    startSessionButton.disabled = true;
    try {
      await newSession();
    } finally {
      startSessionButton.disabled = false;
    }
  }
  startSessionButton.addEventListener("click", () => void startLiveSession());

  void loadStatus();
  if (initialMission.trim()) {
    missionInput.value = initialMission.trim();
    queueMicrotask(() => {
      taskForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }
}
