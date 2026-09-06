import { metricCard, noteCard, safeErrorMessage, setStatus, settingsHeader } from "./settings-common.js";

const DIAGNOSTICS_TIMEOUT_MS = 10_000;

function serviceStatus(result) {
  if (result.status === "pending") return { value: "Checking", detail: "waiting for status endpoint", tone: "" };
  if (result.status === "rejected") {
    return { value: "Error", detail: safeErrorMessage(result.reason), tone: "warning" };
  }
  return { value: "Ready", detail: "host-mediated status endpoint responded", tone: "success" };
}

function browserLaunchStatus(result) {
  if (result.status === "pending") return { value: "Checking", detail: "waiting for browser diagnostics", tone: "" };
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
  statusNode.setAttribute("role", "status");
  statusNode.textContent = "Checking diagnostics endpoints...";
  const grid = document.createElement("div");
  grid.className = "settings-health-grid settings-diagnostics-health";
  grid.append(
    metricCard({ label: "Bridge", value: "Checking", detail: "loading system status" }),
    metricCard({ label: "Providers", value: "Checking", detail: "loading provider status" }),
    metricCard({ label: "Add-ons", value: "Checking", detail: "loading add-on status" }),
    metricCard({ label: "Memory", value: "Checking", detail: "loading memory status" }),
    metricCard({ label: "Chromium", value: "Checking", detail: "loading browser diagnostics" })
  );
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry unavailable checks";
  retry.hidden = true;

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
    retry,
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

  const routes = ["/status", "/providers/status", "/addons/status", "/memory/status", "/browser/launch-diagnostics"];
  const results = routes.map(() => ({ status: "pending" }));

  async function probe(route) {
    const controller = new AbortController();
    let timer;
    // Bound each endpoint separately, including transports that ignore AbortSignal.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Status request timed out after 10 seconds."));
        controller.abort();
      }, DIAGNOSTICS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([bridge()(route, { method: "GET", signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function renderResults() {
    const [statusResult, providerResult, addonResult, memoryResult, browserLaunchResult] = results;
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
        value: statusResult.status === "pending" ? "Checking" : system?.bridge ?? "Unavailable",
        detail: statusResult.status === "pending" ? "Waiting for bridge status." : statusResult.status === "fulfilled" ? "Core bridge responded." : safeErrorMessage(statusResult.reason)
      }),
      diagnosticsRow({
        label: "Providers",
        value: providerResult.status === "pending" ? "Checking" : `${providers.filter((provider) => provider.configured).length}/${providers.length}`,
        detail: "configured provider profiles"
      }),
      diagnosticsRow({
        label: "Add-ons",
        value: addonResult.status === "pending" ? "Checking" : `${addons.filter((addon) => addon.available || addon.enabled).length}/${addons.length}`,
        detail: "available add-ons"
      }),
      diagnosticsRow({
        label: "Memory",
        value: memoryResult.status === "pending" ? "Checking" : `${memory?.wiki?.pages ?? 0} pages`,
        detail: memoryResult.status === "pending" ? "Waiting for memory status." : `${memory?.intake?.artifacts ?? 0} intake artifacts`
      }),
      diagnosticsRow({
        label: "Chromium host",
        value: browserLaunchResult.status === "pending" ? "Checking" : browserLaunch?.status ?? "Unavailable",
        detail: browserLaunchResult.status === "pending" ? "Waiting for browser diagnostics." : browserLaunchResult.status === "fulfilled"
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
    const failed = results.filter((result) => result.status === "rejected").length;
    const pending = results.filter((result) => result.status === "pending").length;
    retry.hidden = failed === 0;
    setStatus(statusNode, pending
      ? `Checking ${pending} diagnostics endpoint${pending === 1 ? "" : "s"}; ${failed} unavailable.`
      : failed
      ? `Diagnostics loaded with ${failed} unavailable endpoint${failed === 1 ? "" : "s"}.`
      : "Diagnostics loaded from host-mediated status endpoints.",
      failed ? "warning" : pending ? "" : "success"
    );
  }

  function startCheck(index) {
    results[index] = { status: "pending" };
    void probe(routes[index]).then(
      (value) => { results[index] = { status: "fulfilled", value }; renderResults(); },
      (reason) => { results[index] = { status: "rejected", reason }; renderResults(); }
    );
  }

  retry.addEventListener("click", () => {
    results.forEach((result, index) => { if (result.status === "rejected") startCheck(index); });
    renderResults();
  });
  routes.forEach((_, index) => startCheck(index));
}
