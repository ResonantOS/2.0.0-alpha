import { metricCard, noteCard, safeCount, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";

function providerSummary(providers) {
  const total = safeCount(providers);
  const configured = providers.filter((provider) => provider.configured).length;
  return {
    value: total ? `${configured}/${total}` : "0",
    detail: total ? "provider profiles configured" : "no provider profiles registered",
    tone: total && configured === total ? "success" : "warning"
  };
}

function addOnSummary(status) {
  const addons = status?.addons ?? [];
  const available = addons.filter((addon) => addon.available || addon.enabled).length;
  return {
    value: addons.length ? `${available}/${addons.length}` : "Unknown",
    detail: addons.length ? "add-ons available or enabled" : "add-on registry status pending",
    tone: addons.length ? "success" : "warning"
  };
}

function memorySummary(status) {
  const memory = status?.memory;
  if (!memory) {
    return { value: "Unknown", detail: "memory-system status pending", tone: "warning" };
  }
  const wikiPages = memory?.wiki?.pages ?? 0;
  const intakeArtifacts = memory?.intake?.artifacts ?? 0;
  return {
    value: `${wikiPages}`,
    detail: `wiki pages · ${intakeArtifacts} intake artifacts`,
    tone: "success"
  };
}

function setupCard({ label, title, body, action, onClick }) {
  const card = document.createElement("article");
  card.className = "settings-setup-card";
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const titleNode = document.createElement("strong");
  titleNode.textContent = title;
  const bodyNode = document.createElement("p");
  bodyNode.textContent = body;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = action;
  button.addEventListener("click", onClick);
  card.append(labelNode, titleNode, bodyNode, button);
  return card;
}

export function renderOverviewSection(container, { bridgeRequest, getBridgeRequest, onSelectSection }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const statusNode = document.createElement("p");
  statusNode.className = "settings-status";
  statusNode.textContent = "Checking ResonantOS health...";
  const grid = document.createElement("div");
  grid.className = "settings-health-grid";
  grid.append(
    metricCard({ label: "Providers", value: "Checking", detail: "loading provider profiles" }),
    metricCard({ label: "Add-ons", value: "Checking", detail: "loading add-on registry" }),
    metricCard({ label: "Memory", value: "Checking", detail: "loading memory-system state" }),
    metricCard({ label: "Browser bridge", value: "Ready", detail: "extension workspace is active", tone: "success" })
  );

  const setupGrid = document.createElement("div");
  setupGrid.className = "settings-setup-grid";
  setupGrid.append(
    setupCard({
      label: "1",
      title: "Profile",
      body: "Set who the system is serving and how Augmentor should speak.",
      action: "Edit profile",
      onClick: () => onSelectSection?.("profile")
    }),
    setupCard({
      label: "2",
      title: "AI provider",
      body: "Add model access, choose defaults, and keep fallback clear.",
      action: "Set models",
      onClick: () => onSelectSection?.("providers")
    }),
    setupCard({
      label: "3",
      title: "Memory",
      body: "Connect the memory system and source folders Augmentor can use.",
      action: "Open memory",
      onClick: () => onSelectSection?.("memory")
    })
  );

  const actionCard = noteCard({
    title: "Advanced recovery",
    body: "Use this only when something looks missing or broken. Recovery creates a governed Resonant Engineer task packet; it does not grant raw shell, wallet, provider, or memory-write authority."
  });
  actionCard.classList.add("settings-overview-actions");
  const actionDetails = document.createElement("details");
  actionDetails.className = "settings-advanced-disclosure";
  const actionSummary = document.createElement("summary");
  actionSummary.textContent = "Diagnostics and recovery";
  const actionButtons = document.createElement("div");
  actionButtons.className = "settings-overview-action-buttons";
  const openDiagnostics = document.createElement("button");
  openDiagnostics.type = "button";
  openDiagnostics.className = "settings-primary-action";
  openDiagnostics.textContent = "Open Diagnostics";
  openDiagnostics.addEventListener("click", () => onSelectSection?.("diagnostics"));
  const exportReport = document.createElement("button");
  exportReport.type = "button";
  exportReport.textContent = "Export Report";
  const startRecovery = document.createElement("button");
  startRecovery.type = "button";
  startRecovery.textContent = "Start Recovery Handoff";
  const actionStatus = document.createElement("p");
  actionStatus.className = "settings-status";
  actionStatus.textContent = "No action has been started.";
  actionButtons.append(openDiagnostics, exportReport, startRecovery);
  actionDetails.append(actionSummary, actionButtons, actionStatus);
  actionCard.append(actionDetails);

  container.replaceChildren(
    settingsHeader({
      eyebrow: "System settings",
      title: "Start Here",
      body: "Set the essentials first: who you are, which AI models to use, and where memory lives."
    }),
    setupGrid,
    statusNode,
    grid,
    actionCard
  );

  exportReport.addEventListener("click", async () => {
    exportReport.disabled = true;
    setStatus(actionStatus, "Exporting redacted diagnostics report...");
    try {
      const result = await bridge()("/diagnostics/report", {
        method: "POST",
        capability: "diagnostics-report-export",
        body: { scope: "overview" }
      });
      setStatus(actionStatus, `Report exported: ${result.path}`, "success");
    } catch (error) {
      setStatus(actionStatus, `Report export failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      exportReport.disabled = false;
    }
  });

  startRecovery.addEventListener("click", async () => {
    startRecovery.disabled = true;
    setStatus(actionStatus, "Creating Resonant Engineer recovery handoff...");
    try {
      const result = await bridge()("/addons/delegate", {
        method: "POST",
        body: {
          target: "engineer",
          mission: "Run a ResonantOS health diagnosis from Settings Overview, identify unavailable providers/add-ons/memory routes, and return a recovery report with every proposed change listed before action."
        }
      });
      setStatus(actionStatus, `Recovery handoff queued: ${result.id}`, "success");
    } catch (error) {
      setStatus(actionStatus, `Recovery handoff failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      startRecovery.disabled = false;
    }
  });

  const load = async () => {
    const [providerResult, statusResult] = await Promise.allSettled([
      bridge()("/providers/status", { method: "GET" }),
      bridge()("/status", { method: "GET" })
    ]);
    const providers = providerResult.status === "fulfilled" ? providerResult.value.providers ?? [] : [];
    const status = statusResult.status === "fulfilled" ? statusResult.value : null;
    const provider = providerSummary(providers);
    const addons = addOnSummary(status);
    const memory = memorySummary(status);
    grid.replaceChildren(
      metricCard({ label: "Providers", ...provider }),
      metricCard({ label: "Add-ons", ...addons }),
      metricCard({ label: "Memory", ...memory }),
      metricCard({ label: "Browser bridge", value: "Ready", detail: "extension workspace is active", tone: "success" })
    );
    const failed = [providerResult, statusResult].filter((result) => result.status === "rejected").length;
    setStatus(statusNode, failed
      ? "Overview loaded with partial host status. Open Diagnostics when available for deeper checks."
      : "Overview loaded from host-mediated health state.",
      failed ? "warning" : "success"
    );
  };

  void load().catch((error) => {
    setStatus(statusNode, `Health check unavailable: ${safeErrorMessage(error)}`, "error");
  });
}
