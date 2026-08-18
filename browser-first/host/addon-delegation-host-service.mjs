export function createAddonDelegationHostService(handlers = {}) {
  function required(name) {
    if (typeof handlers[name] !== "function") {
      throw new Error(`Add-on delegation host service missing handler: ${name}`);
    }
    return handlers[name];
  }

  return {
    addonDelegationRoutes: [
      { method: "GET", path: "/addons/status", handler: required("executeAddonsStatus") },
      { method: "GET", path: "/addons/agent-handoff-kit/hot-rod-rig-test", handler: required("executeAgentHandoffHotRodRigTest") },
      { method: "GET", path: "/addons/execution-settings", handler: required("executeAddonExecutionSettingsGet") },
      {
        method: "POST",
        path: "/addons/execution-settings",
        requiredCapability: "addon-execution-settings-write",
        handler: required("executeAddonExecutionSettingsUpdate"),
      },
      { method: "GET", path: "/opencode/status", handler: required("executeOpenCodeStatus") },
      { method: "POST", path: "/hermes/dashboard/status", handler: required("executeHermesDashboardStatus") },
      { method: "POST", path: "/hermes/dashboard/start", handler: required("executeHermesDashboardStart") },
      { method: "POST", path: "/hermes/dashboard/stop", handler: required("executeHermesDashboardStop") },
      { method: "POST", path: "/hermes/status", handler: required("executeHermesStatus") },
      { method: "POST", path: "/hermes/delegation/start", handler: required("executeHermesDelegationStart") },
      { method: "POST", path: "/hermes/delegation/status", handler: required("executeHermesDelegationStatus") },
      { method: "POST", path: "/hermes/delegation/artifact", handler: required("executeHermesDelegationArtifact") },
      { method: "POST", path: "/hermes/delegation/cancel", handler: required("executeHermesDelegationCancel") },
      { method: "POST", path: "/opencode/delegation/start", handler: required("executeOpenCodeDelegationStart") },
      { method: "POST", path: "/opencode/delegation/status", handler: required("executeOpenCodeDelegationStatus") },
      { method: "POST", path: "/opencode/delegation/artifact", handler: required("executeOpenCodeDelegationArtifact") },
      { method: "POST", path: "/opencode/delegation/cancel", handler: required("executeOpenCodeDelegationCancel") },
      { method: "POST", path: "/addons/draft", handler: required("executeAddonDraftRecord") },
      { method: "POST", path: "/addons/draft/list", handler: required("executeAddonDraftList") },
      { method: "POST", path: "/addons/draft/read", handler: required("executeAddonDraftRead") },
      { method: "POST", path: "/addons/draft/transition", handler: required("executeAddonDraftTransition") },
      { method: "POST", path: "/addons/draft/handoff", handler: required("executeAddonDraftProviderHandoff") },
      { method: "POST", path: "/addons/delegate", handler: required("executeDelegationRecord") },
      { method: "POST", path: "/addons/delegate/list", handler: required("executeDelegationList") },
      { method: "POST", path: "/goals", handler: required("executeGoalRecord") },
    ],
  };
}
