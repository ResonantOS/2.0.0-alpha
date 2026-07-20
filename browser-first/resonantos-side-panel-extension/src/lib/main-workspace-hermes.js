import { delegationGuidanceText } from "./delegation-guidance.js";
import { createAddonIframe } from "./addon-iframe.js";
import { hermesStatusMessage } from "./runtime-error-messages.js";

function runtimeLine(hermesStatus = {}) {
  const cli = hermesStatus.available ? "CLI detected" : "CLI not detected";
  const execution = hermesStatus.executionEnabled ? "execution enabled" : "execution disabled";
  const mode = hermesStatus.mode ? ` · ${hermesStatus.mode}` : "";
  return `${cli} · ${execution}${mode}`;
}

function taskCountsLine(taskCounts = {}) {
  const entries = Object.entries(taskCounts)
    .filter(([, count]) => Number(count) > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length
    ? entries.map(([status, count]) => `${status}: ${count}`).join(", ")
    : "no recorded tasks";
}

function dashboardLine(dashboard = {}) {
  return dashboard.running
    ? `Dashboard running · ${dashboard.url}`
    : `${dashboard.rawStatus || "Hermes dashboard stopped"} · ${dashboard.detail || "Start it to embed the dashboard in this workspace."}`;
}

function renderStatusText({ addon, dashboard, hermesStatus }) {
  const lines = [
    dashboardLine(dashboard),
    runtimeLine(hermesStatus),
    `Tasks: ${taskCountsLine(hermesStatus?.taskCounts)}`,
  ];
  if (addon?.available && !addon?.execution?.runtimeAvailable) {
    lines.push("Hermes add-on contract is installed, but the local Hermes CLI runtime was not detected.");
  } else if (!addon?.available) {
    lines.push("Hermes add-on contract is not registered in this build.");
  }
  if (hermesStatus?.boundary) {
    lines.push(`Boundary: ${hermesStatus.boundary}`);
  }
  if (!hermesStatus?.available || !hermesStatus?.executionEnabled || !addon?.execution?.runtimeAvailable) {
    lines.push(delegationGuidanceText({
      blockedReason: hermesStatus?.blockedReason || "",
      executionEnabled: Boolean(hermesStatus?.executionEnabled),
      runtimeAvailable: Boolean(addon?.execution?.runtimeAvailable && hermesStatus?.available),
      target: "hermes"
    }));
  }
  return lines.filter(Boolean).join("\n");
}

export function renderHermesDashboardWorkspace({ container, bridgeRequest, getBridgeRequest, rawFetch, bridgeUrl, bridgeToken, statusForAddon }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const section = document.createElement("section");
  section.className = "hermes-dashboard-workspace";
  section.setAttribute("aria-label", "Hermes dashboard workspace");
  const status = document.createElement("div");
  status.className = "dashboard-status";
  status.textContent = "Checking Hermes status...";
  // The Hermes dashboard lives at http://127.0.0.1:9119 on the bridge
  // host. The extension's newtab is a chrome-extension:// (secure) origin,
  // so embedding http:// directly is blocked by Chrome as mixed content.
  //
  // The bridge proxies <addon-proxy>/<path> to the dashboard's actual
  // port. The extension fetches through the bridge and inlines the
  // dashboard HTML into a sandboxed <iframe srcdoc> on the secure
  // extension page. This works for ANY addon (Hermes, OpenCode,
  // OpenClaw, ...) without per-machine TLS, cert installs, or admin
  // rights.
  const renderIframe = createAddonIframe({
    addonId: "hermes",
    proxyPath: "/hermes-dashboard/",
    addonLabel: "Hermes dashboard",
    apiBasePath: "/api",
    rawFetch,
    bridgeUrl,
    bridgeToken,
    // src mode: the Hermes bundle lives on a different origin
    // (https://localhost:19443) than the extension page. MV3 forbids
    // loosening the extension CSP via meta-CSP in srcdoc, so the only
    // way to load the React bundle is to give the iframe its own
    // origin by pointing src directly at the bridge proxy.
    mode: "src",
  });
  const { reload: reloadIframe } = renderIframe({ container: section });
  const actionsCard = document.createElement("section");
  actionsCard.className = "dashboard-actions-card";
  const placeholder = document.createElement("div");
  placeholder.className = "dashboard-placeholder";
  const placeholderTitle = document.createElement("strong");
  placeholderTitle.textContent = "Hermes dashboard is not running";
  const placeholderBody = document.createElement("p");
  placeholderBody.textContent = "Start the Hermes dashboard to embed it in this workspace. Delegation remains available from Augmentor chat with /hermes.";
  const actions = document.createElement("div");
  actions.className = "module-action-row";
  const start = document.createElement("button");
  start.type = "button";
  start.textContent = "Start Dashboard";
  const stop = document.createElement("button");
  stop.type = "button";
  stop.textContent = "Stop";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh";
  actions.append(start, stop, refresh);
  placeholder.append(placeholderTitle, placeholderBody, actions);
  actionsCard.append(placeholder);
  section.append(status, actionsCard);
  container.append(section);

  const setDashboardState = ({ addon, dashboard, hermesStatus }) => {
    const running = Boolean(dashboard?.running);
    placeholder.hidden = running;
    status.textContent = renderStatusText({ addon, dashboard, hermesStatus });
  };
  const loadStatus = async () => {
    const [addon, dashboard, hermesStatus] = await Promise.all([
      statusForAddon("addon.hermes"),
      bridge()("/hermes/dashboard/status", { method: "POST", body: { port: 9119 } }),
      bridge()("/hermes/status", { method: "POST", body: {} }),
    ]);
    setDashboardState({ addon, dashboard, hermesStatus });
    return { dashboard, hermesStatus };
  };
  const startDashboard = async () => {
    start.disabled = true;
    status.textContent = "Starting Hermes dashboard...";
    try {
      const dashboard = await bridge()("/hermes/dashboard/start", {
        method: "POST",
        body: { host: "127.0.0.1", port: 9119, includeTui: true }
      });
      const [addon, hermesStatus] = await Promise.all([
        statusForAddon("addon.hermes"),
        bridge()("/hermes/status", { method: "POST", body: {} }),
      ]);
      setDashboardState({ addon, dashboard, hermesStatus });
      reloadIframe();
    } catch (error) {
      status.textContent = hermesStatusMessage(error, "Hermes dashboard failed to start");
    } finally {
      start.disabled = false;
    }
  };
  start.addEventListener("click", async () => {
    await startDashboard();
  });
  stop.addEventListener("click", async () => {
    stop.disabled = true;
    status.textContent = "Stopping Hermes dashboard...";
    try {
      const dashboard = await bridge()("/hermes/dashboard/stop", { method: "POST", body: { port: 9119 } });
      const [addon, hermesStatus] = await Promise.all([
        statusForAddon("addon.hermes"),
        bridge()("/hermes/status", { method: "POST", body: {} }),
      ]);
      setDashboardState({ addon, dashboard, hermesStatus });
    } catch (error) {
      status.textContent = hermesStatusMessage(error, "Hermes dashboard failed to stop");
    } finally {
      stop.disabled = false;
    }
  });
  refresh.addEventListener("click", () => void Promise.all([loadStatus(), reloadIframe()]).catch((error) => {
    status.textContent = hermesStatusMessage(error);
  }));
  void loadStatus()
    .then(({ dashboard, hermesStatus }) => {
      if (!dashboard?.running && hermesStatus?.available) {
        return startDashboard();
      }
      reloadIframe();
    })
    .catch((error) => {
      status.textContent = hermesStatusMessage(error);
    });
}
