import { delegationTargetLabel } from "./delegation-lifecycle.js";

const supportedTargets = ["hermes", "opencode", "engineer"];

export function delegationTargetsForFilter(filter = "") {
  const normalized = String(filter ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized || normalized === "all" || normalized === "recent") return supportedTargets;
  if (normalized === "open-code") return ["opencode"];
  return supportedTargets.includes(normalized) ? [normalized] : [];
}

function delegationLine(delegation) {
  const label = delegationTargetLabel(delegation.target);
  const mission = String(delegation.mission ?? "Untitled delegation").replace(/\s+/g, " ").slice(0, 120);
  const result = String(delegation.resultExcerpt ?? "").replace(/\s+/g, " ").slice(0, 160);
  return [
    `- ${label} · ${delegation.status ?? "unknown"} · ${mission}`,
    result ? `  Result: ${result}` : "",
    delegation.resultArtifactPath ? `  Artifact: ${delegation.resultArtifactPath}` : "",
    delegation.path ? `  Packet: ${delegation.path}` : ""
  ].filter(Boolean).join("\n");
}

export async function buildDelegationStatusMessage({ bridgeRequest, getBridgeRequest, filter = "", limit = 6 }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const targets = delegationTargetsForFilter(filter);
  if (!targets.length) {
    return "Use `/delegations` or `/delegations <hermes|opencode|engineer>`.";
  }
  const responses = await Promise.allSettled(targets.map((target) => bridge()("/addons/delegate/list", {
    method: "POST",
    body: { target, limit }
  })));
  const failures = responses
    .map((response, index) => response.status === "rejected" ? delegationTargetLabel(targets[index]) : "")
    .filter(Boolean);
  const delegations = responses
    .flatMap((response) => response.status === "fulfilled" && Array.isArray(response.value?.delegations) ? response.value.delegations : [])
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, limit);
  if (!delegations.length) {
    return [
      `No recent ${targets.length === 1 ? delegationTargetLabel(targets[0]) : "add-on"} delegations found.`,
      failures.length ? `Unavailable targets: ${failures.join(", ")}` : ""
    ].filter(Boolean).join("\n");
  }
  return [
    "Recent delegated work",
    delegations.map(delegationLine).join("\n"),
    failures.length ? `Unavailable targets: ${failures.join(", ")}` : ""
  ].join("\n");
}
