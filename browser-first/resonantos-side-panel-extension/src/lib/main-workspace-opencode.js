// Intent citation: docs/architecture/addon-skills/opencode/CODING_HANDOFF.md
// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

import { delegationGuidanceText } from "./delegation-guidance.js";
import { createOpenCodeSession } from "./main-workspace-opencode-session.js";
import { createOpenCodeBridgeSource } from "./opencode-bridge-source.js";
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

export function renderOpenCodeWorkspace({ container, bridgeRequest, getBridgeRequest, initialMission = "" }) {
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
  statusCard.append(statusTitle, statusBody, statusMeta, refreshButton, startSessionButton);

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

  const loadStatus = async () => {
    refreshButton.disabled = true;
    try {
      const status = await bridge()("/opencode/status", { method: "GET" });
      const executionEnabled = status.executionEnabled !== false;
      statusBody.textContent = status.detail;
      statusMeta.textContent = openCodeStatusMeta(status);
      statusCard.dataset.ready = status.installed ? "true" : "false";
      startSessionButton.hidden = !status.installed;
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

  // Live session: mount the streaming OpenCode workspace element. The bridge
  // starts (reuses) `opencode serve` and returns the session + its /event URL;
  // the element streams events directly from the server (host_permissions cover
  // 127.0.0.1) and routes prompts/permissions back through the bridge.
  const sessionArea = document.createElement("div");
  sessionArea.className = "opencode-session-area";
  section.append(sessionArea);
  let activeSession = null;

  async function startLiveSession() {
    startSessionButton.disabled = true;
    setStatus(taskStatus, "Starting OpenCode session…");
    try {
      const info = await bridge()("/opencode/session/start", { method: "POST", body: {} });
      if (!info?.sessionId) throw new Error("No session id returned.");
      header.hidden = true;
      boundaryCard.hidden = true;
      taskForm.hidden = true;
      activeSession?.destroy?.();
      sessionArea.replaceChildren();
      const source = createOpenCodeBridgeSource({
        // Idempotent: return the already-started session so subscribe + prompt share it.
        startSession: async () => ({ sessionId: info.sessionId, eventUrl: info.eventUrl }),
        openEventStream: (eventUrl) => fetch(eventUrl),
        postJson: (path, body) => bridge()(path, { method: "POST", body })
      });
      activeSession = createOpenCodeSession({
        document,
        container: sessionArea,
        scope: info.baseUrl ? "" : "",
        subscribe: source.subscribe,
        sendPrompt: source.sendPrompt,
        replyPermission: source.replyPermission,
        revert: async () => {}
      });
      setStatus(taskStatus, "");
    } catch (error) {
      setStatus(taskStatus, opencodeStatusMessage(error, "Could not start OpenCode session"), "error");
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
