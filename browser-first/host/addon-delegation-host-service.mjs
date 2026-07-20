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
      { method: "GET", path: "/addons/execution-settings", handler: required("executeAddonExecutionSettingsGet") },
      {
        method: "POST",
        path: "/addons/execution-settings",
        requiredCapability: "addon-execution-settings-write",
        handler: required("executeAddonExecutionSettingsUpdate"),
      },
      { method: "GET", path: "/opencode/status", handler: required("executeOpenCodeStatus") },
      {
        method: "POST",
        path: "/hermes/dashboard/status",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesDashboardStatus"),
      },
      {
        method: "POST",
        path: "/hermes/dashboard/start",
        requiredCapability: "addon-runtime-control",
        handler: required("executeHermesDashboardStart"),
      },
      {
        method: "POST",
        path: "/hermes/dashboard/stop",
        requiredCapability: "addon-runtime-control",
        handler: required("executeHermesDashboardStop"),
      },
      {
        method: "POST",
        path: "/hermes/status",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesStatus"),
      },
      {
        method: "POST",
        path: "/hermes/delegation/start",
        requiredCapability: "addon-runtime-control",
        handler: required("executeHermesDelegationStart"),
      },
      {
        method: "POST",
        path: "/hermes/delegation/status",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesDelegationStatus"),
      },
      {
        method: "POST",
        path: "/hermes/delegation/artifact",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesDelegationArtifact"),
      },
      {
        method: "POST",
        path: "/hermes/delegation/cancel",
        requiredCapability: "addon-runtime-control",
        handler: required("executeHermesDelegationCancel"),
      },
      {
        method: "POST",
        path: "/opencode/delegation/start",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeDelegationStart"),
      },
      {
        method: "POST",
        path: "/opencode/delegation/status",
        requiredCapability: "addon-runtime-read",
        handler: required("executeOpenCodeDelegationStatus"),
      },
      {
        method: "POST",
        path: "/opencode/delegation/artifact",
        requiredCapability: "addon-runtime-read",
        handler: required("executeOpenCodeDelegationArtifact"),
      },
      {
        method: "POST",
        path: "/opencode/delegation/cancel",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeDelegationCancel"),
      },
      {
        method: "POST",
        path: "/addons/draft",
        requiredCapability: "addon-record-write",
        handler: required("executeAddonDraftRecord"),
      },
      {
        method: "POST",
        path: "/addons/draft/list",
        requiredCapability: "addon-record-read",
        handler: required("executeAddonDraftList"),
      },
      {
        method: "POST",
        path: "/addons/draft/read",
        requiredCapability: "addon-record-read",
        handler: required("executeAddonDraftRead"),
      },
      {
        method: "POST",
        path: "/addons/draft/transition",
        requiredCapability: "addon-record-write",
        handler: required("executeAddonDraftTransition"),
      },
      {
        method: "POST",
        path: "/addons/draft/handoff",
        requiredCapability: "addon-record-write",
        handler: required("executeAddonDraftProviderHandoff"),
      },
      {
        method: "POST",
        path: "/addons/delegate",
        requiredCapability: "addon-record-write",
        handler: required("executeDelegationRecord"),
      },
      {
        method: "POST",
        path: "/addons/delegate/list",
        requiredCapability: "addon-record-read",
        handler: required("executeDelegationList"),
      },
      {
        method: "POST",
        path: "/goals",
        requiredCapability: "addon-record-write",
        handler: required("executeGoalRecord"),
      },
    ],
  };
}
