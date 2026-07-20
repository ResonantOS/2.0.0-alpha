import { bridgeSetupMessage, isBridgeNetworkError, redactSensitiveErrorMessage } from "./runtime-error-messages.js";

function statusCountLine(taskCounts = {}) {
  const entries = Object.entries(taskCounts)
    .filter(([, count]) => Number(count) > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length
    ? entries.map(([status, count]) => `${status}: ${count}`).join(", ")
    : "no recorded tasks";
}

function hermesNextAction(status) {
  if (!status?.available) {
    return "Install or configure the Hermes CLI before starting real Hermes execution. Delegation packets can still be created for later review.";
  }
  if (!status?.executionEnabled) {
    return "Enable Hermes local execution in Settings > Add-ons when you want ResonantOS to run Hermes through the host boundary.";
  }
  if (!status?.dashboard?.running) {
    return "Use the Hermes workspace to start the dashboard, or delegate from chat with `/hermes <mission>`.";
  }
  return "Hermes is ready for governed delegation. Use `/hermes <mission>` to create and start a task packet.";
}

export function formatHermesRuntimeStatus(status = {}) {
  const dashboard = status.dashboard ?? {};
  return [
    "Hermes runtime status",
    `- CLI: ${status.available ? "detected" : "not detected"}`,
    status.command ? `- Command: ${status.command}` : "",
    `- Execution: ${status.executionEnabled ? "enabled" : "disabled"}`,
    `- Mode: ${status.mode ?? "unknown"}`,
    `- Dashboard: ${dashboard.running ? "running" : "stopped"}${dashboard.url ? ` · ${dashboard.url}` : ""}`,
    `- Tasks: ${statusCountLine(status.taskCounts)}`,
    status.boundary ? `- Boundary: ${status.boundary}` : "",
    `Next action: ${hermesNextAction(status)}`
  ].filter(Boolean).join("\n");
}

export async function buildHermesRuntimeStatusMessage({ bridgeRequest, getBridgeRequest }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const bridgeFn = bridge();
  if (typeof bridgeFn !== "function") {
    return "Hermes status is unavailable because the ResonantOS bridge is not connected.";
  }
  try {
    const status = await bridgeFn("/hermes/status", { method: "POST", body: {} });
    return formatHermesRuntimeStatus(status);
  } catch (error) {
    const reason = isBridgeNetworkError(error)
      ? bridgeSetupMessage()
      : redactSensitiveErrorMessage(error);
    return [
      "Hermes runtime status",
      "- CLI: unknown",
      "- Execution: unavailable",
      `Reason: ${reason}`,
      "Next action: open Settings > Add-ons or the Hermes workspace to inspect the runtime configuration."
    ].join("\n");
  }
}
