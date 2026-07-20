import { metricCard, noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";

function serviceStatus(result) {
  if (result.status === "rejected") {
    return { value: "Error", detail: safeErrorMessage(result.reason), tone: "warning" };
  }
  return { value: "Ready", detail: "host-mediated status endpoint responded", tone: "success" };
}

function browserLaunchStatus(result) {
  if (result.status === "rejected") {
    return { value: "Error", detail: safeErrorMessage(result.reason), tone: "warning" };
  }
  const value = result.value ?? {};
  if (value.status === "ready") {
    return { value: "Ready", detail: "extension bridge, menu, workspace, and add-on endpoints verified", tone: "success" };
  }
  return {
    value: "Check",
    detail: value.issues?.[0] || value.error || "latest launch log is incomplete or missing a required browser signal",
    tone: "warning"
  };
}

function diagnosticsRow({ label, value, detail = "" }) {
  const row = document.createElement("li");
  row.className = "settings-diagnostics-row";
  const heading = document.createElement("strong");
  heading.textContent = label;
  const valueNode = document.createElement("span");
  valueNode.textContent = value;
  const detailNode = document.createElement("small");
  detailNode.textContent = detail;
  row.append(heading, valueNode, detailNode);
  return row;
}

function diagnosticsDisclosure(title, body, children = []) {
  const details = document.createElement("details");
  details.className = "settings-diagnostics-advanced";
  const summary = document.createElement("summary");
  summary.textContent = title;
  const panel = document.createElement("div");
  panel.className = "settings-diagnostics-advanced-body";
  const copy = document.createElement("p");
  copy.textContent = body;
  panel.append(copy, ...children);
  details.append(summary, panel);
  return details;
}

export function renderDiagnosticsSection(container, { bridgeRequest, getBridgeRequest }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const statusNode = document.createElement("p");
  statusNode.className = "settings-status";
  statusNode.textContent = "Checking diagnostics endpoints...";
  const grid = document.createElement("div");
  grid.className = "settings-health-grid settings-diagnostics-health";
  grid.append(
    metricCard({ label: "Bridge", value: "Checking", detail: "loading system status" }),
    metricCard({ label: "Providers", value: "Checking", detail: "loading provider status" }),
    metricCard({ label: "Add-ons", value: "Checking", detail: "loading add-on status" }),
    metricCard({ label: "Memory", value: "Checking", detail: "loading memory status" })
  );

  const details = document.createElement("ol");
  details.className = "settings-diagnostics-list";

  const exportCard = noteCard({
    title: "Redacted support report",
    body: "Export a local diagnostics report for debugging. Provider credentials, bridge tokens, wallet secrets, private keys, and full home paths must not be included."
  });
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "settings-primary-action";
  exportButton.textContent = "Export Redacted Report";
  const exportStatus = document.createElement("p");
  exportStatus.className = "settings-status";
  exportStatus.textContent = "No report exported yet.";
  exportCard.append(exportButton, exportStatus);
  const endpointDetails = diagnosticsDisclosure(
    "Endpoint details",
    "Open this when you need exact status counts for bridge, providers, add-ons, memory, and extension health.",
    [details]
  );
  const exportDetails = diagnosticsDisclosure(
    "Support report",
    "Use this only when debugging or sharing a local report. The export path is local and the report is redacted before it is written.",
    [exportCard]
  );

  container.replaceChildren(
    settingsHeader({
      eyebrow: "Logs and diagnostics",
      title: "Diagnostics",
      body: "Check whether ResonantOS is healthy. Detailed endpoint data and redacted report export are available when needed."
    }),
    statusNode,
    grid,
    endpointDetails,
    exportDetails
  );

  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    setStatus(exportStatus, "Exporting redacted diagnostics report...");
    try {
      const result = await bridge()("/diagnostics/report", {
        method: "POST",
        capability: "diagnostics-report-export",
        body: { scope: "settings" }
      });
      setStatus(exportStatus, `Report exported: ${result.path}`, "success");
    } catch (error) {
      setStatus(exportStatus, `Report export failed: ${safeErrorMessage(error)}`, "error");
    } finally {
      exportButton.disabled = false;
    }
  });

  const load = async () => {
    const [statusResult, providerResult, addonResult, memoryResult] = await Promise.allSettled([
      bridge()("/status", { method: "GET" }),
      bridge()("/providers/status", { method: "GET" }),
      bridge()("/addons/status", { method: "GET" }),
      bridge()("/memory/status", { method: "GET" })
    ]);
    const [browserLaunchResult] = await Promise.allSettled([
      bridge()("/browser/launch-diagnostics", { method: "GET" })
    ]);
    const statusValue = serviceStatus(statusResult);
    const providerValue = serviceStatus(providerResult);
    const addonValue = serviceStatus(addonResult);
    const memoryValue = serviceStatus(memoryResult);
    const browserValue = browserLaunchStatus(browserLaunchResult);
    grid.replaceChildren(
      metricCard({ label: "Bridge", ...statusValue }),
      metricCard({ label: "Providers", ...providerValue }),
      metricCard({ label: "Add-ons", ...addonValue }),
      metricCard({ label: "Memory", ...memoryValue }),
      metricCard({ label: "Chromium", ...browserValue })
    );

    const providers = providerResult.status === "fulfilled" ? providerResult.value.providers ?? [] : [];
    const addons = addonResult.status === "fulfilled" ? addonResult.value.addons ?? [] : [];
    const memory = memoryResult.status === "fulfilled" ? memoryResult.value : null;
    const system = statusResult.status === "fulfilled" ? statusResult.value : null;
    const browserLaunch = browserLaunchResult.status === "fulfilled" ? browserLaunchResult.value : null;
    details.replaceChildren(
      diagnosticsRow({
        label: "Bridge",
        value: system?.bridge ?? "Unavailable",
        detail: statusResult.status === "fulfilled" ? "Core bridge responded." : safeErrorMessage(statusResult.reason)
      }),
      diagnosticsRow({
        label: "Providers",
        value: `${providers.filter((provider) => provider.configured).length}/${providers.length}`,
        detail: "configured provider profiles"
      }),
      diagnosticsRow({
        label: "Add-ons",
        value: `${addons.filter((addon) => addon.available || addon.enabled).length}/${addons.length}`,
        detail: "available add-ons"
      }),
      diagnosticsRow({
        label: "Memory",
        value: `${memory?.wiki?.pages ?? 0} pages`,
        detail: `${memory?.intake?.artifacts ?? 0} intake artifacts`
      }),
      diagnosticsRow({
        label: "Chromium host",
        value: browserLaunch?.status ?? "Unavailable",
        detail: browserLaunchResult.status === "fulfilled"
          ? [
              `launch=${browserLaunch.launchMode ?? "unknown"}`,
              `menu=${browserLaunch.appkitMenu ?? "unknown"}`,
              `bridge=${browserLaunch.bridge?.status ?? "unknown"}`,
              `Phantom=${browserLaunch.phantomLoaded ? "loaded" : "not verified"}`,
              browserLaunch.issues?.[0] ? `issue=${browserLaunch.issues[0]}` : ""
            ].filter(Boolean).join(" · ")
          : safeErrorMessage(browserLaunchResult.reason)
      })
    );
    const failed = [statusResult, providerResult, addonResult, memoryResult, browserLaunchResult]
      .filter((result) => result.status === "rejected").length;
    setStatus(statusNode, failed
      ? `Diagnostics loaded with ${failed} unavailable endpoint${failed === 1 ? "" : "s"}.`
      : "Diagnostics loaded from host-mediated status endpoints.",
      failed ? "warning" : "success"
    );
  };

  void load().catch((error) => {
    setStatus(statusNode, `Diagnostics unavailable: ${safeErrorMessage(error)}`, "error");
  });
}
