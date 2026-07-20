export function delegationTargetLabel(target) {
  if (target === "opencode") return "OpenCode";
  if (target === "hermes") return "Hermes";
  if (target === "engineer") return "Resonant Engineer";
  return String(target ?? "delegation");
}

function delegationBlockedGuidance(target, blockedReason = "") {
  const label = delegationTargetLabel(target);
  return [
    blockedReason || `${label} is not available from the current host configuration.`,
    `Next action: configure ${label}, open Add-ons > ${label}, or ask Augmentor to retry when the runtime is available.`,
    `Boundary: ${label} remains an add-on worker; ResonantOS mediates shell, filesystem, provider, wallet, and Living Archive access.`
  ].filter(Boolean).join("\n");
}

function conciseArtifactSummary(started) {
  const summary = String(started?.artifact?.finalSummary ?? "").trim();
  if (!summary) return "";
  return summary.length > 500 ? `${summary.slice(0, 497).trimEnd()}...` : summary;
}

export async function startDelegationLifecycle(result, { bridgeRequest, getBridgeRequest }) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const bridgeFn = bridge();
  if (!["hermes", "opencode"].includes(result?.target) || !result?.path || typeof bridgeFn !== "function") {
    return "";
  }
  const label = delegationTargetLabel(result.target);
  let started;
  try {
    started = await bridgeFn(`/${result.target}/delegation/start`, {
      method: "POST",
      body: { path: result.path }
    });
  } catch (error) {
    return [
      "",
      `${label} packet was created, but the execution handoff failed.`,
      error instanceof Error ? error.message : String(error),
      `Next action: open Add-ons > ${label} to inspect or retry the task.`
    ].join("\n");
  }
  if (!started || typeof started !== "object") {
    return [
      "",
      `${label} packet was created, but execution did not return a status.`,
      `Next action: open Add-ons > ${label} to inspect the task lifecycle or retry when the runtime reports health.`
    ].join("\n");
  }
  if (started.status === "completed") {
    let summary = conciseArtifactSummary(started);
    if (!summary && started.resultArtifactPath) {
      try {
        const artifact = await bridgeFn(`/${result.target}/delegation/artifact`, {
          method: "POST",
          body: { path: result.path }
        });
        summary = conciseArtifactSummary({ artifact });
      } catch {
        summary = "";
      }
    }
    return [
      "",
      `${label} execution completed and returned a reviewable artifact.`,
      summary ? `Result: ${summary}` : "",
      started.resultArtifactPath ? `Artifact: ${started.resultArtifactPath}` : ""
    ].filter(Boolean).join("\n");
  }
  if (started.status === "blocked") {
    return [
      "",
      `${label} packet was created, but execution is blocked.`,
      delegationBlockedGuidance(result.target, started.blockedReason)
    ].filter(Boolean).join("\n");
  }
  return [
    "",
    `${label} execution status: ${started.status || "queued"}.`,
    `Open Add-ons > ${label} to inspect the task lifecycle and returned artifacts.`
  ].join("\n");
}
