import assert from "node:assert/strict";
import test from "node:test";
import { createAddonDelegationHostService } from "../host/addon-delegation-host-service.mjs";

const requiredHandlers = [
  "executeAddonsStatus",
  "executeAddonExecutionSettingsGet",
  "executeAddonExecutionSettingsUpdate",
  "executeOpenCodeStatus",
  "executeHermesDashboardStatus",
  "executeHermesDashboardStart",
  "executeHermesDashboardStop",
  "executeHermesStatus",
  "executeHermesDelegationStart",
  "executeHermesDelegationStatus",
  "executeHermesDelegationArtifact",
  "executeHermesDelegationCancel",
  "executeOpenCodeDelegationStart",
  "executeOpenCodeDelegationStatus",
  "executeOpenCodeDelegationArtifact",
  "executeOpenCodeDelegationCancel",
  "executeAddonDraftRecord",
  "executeAddonDraftList",
  "executeAddonDraftRead",
  "executeAddonDraftTransition",
  "executeAddonDraftProviderHandoff",
  "executeDelegationRecord",
  "executeDelegationList",
  "executeGoalRecord",
];

function handlers() {
  return Object.fromEntries(requiredHandlers.map((name) => [name, async () => ({ name })]));
}

test("add-on delegation host service owns add-on, delegation, draft, and goal routes", () => {
  const { addonDelegationRoutes } = createAddonDelegationHostService(handlers());
  const routes = new Map(addonDelegationRoutes.map((route) => [`${route.method} ${route.path}`, route]));

  assert.deepEqual([...routes.keys()], [
    "GET /addons/status",
    "GET /addons/execution-settings",
    "POST /addons/execution-settings",
    "GET /opencode/status",
    "POST /hermes/dashboard/status",
    "POST /hermes/dashboard/start",
    "POST /hermes/dashboard/stop",
    "POST /hermes/status",
    "POST /hermes/delegation/start",
    "POST /hermes/delegation/status",
    "POST /hermes/delegation/artifact",
    "POST /hermes/delegation/cancel",
    "POST /opencode/delegation/start",
    "POST /opencode/delegation/status",
    "POST /opencode/delegation/artifact",
    "POST /opencode/delegation/cancel",
    "POST /addons/draft",
    "POST /addons/draft/list",
    "POST /addons/draft/read",
    "POST /addons/draft/transition",
    "POST /addons/draft/handoff",
    "POST /addons/delegate",
    "POST /addons/delegate/list",
    "POST /goals",
  ]);
  assert.equal(routes.get("POST /addons/execution-settings").requiredCapability, "addon-execution-settings-write");
  assert.equal(routes.get("POST /hermes/dashboard/status").requiredCapability, "addon-runtime-read");
  assert.equal(routes.get("POST /hermes/dashboard/start").requiredCapability, "addon-runtime-control");
  assert.equal(routes.get("POST /hermes/dashboard/stop").requiredCapability, "addon-runtime-control");
  assert.equal(routes.get("POST /hermes/status").requiredCapability, "addon-runtime-read");
  assert.equal(routes.get("POST /hermes/delegation/start").requiredCapability, "addon-runtime-control");
  assert.equal(routes.get("POST /hermes/delegation/status").requiredCapability, "addon-runtime-read");
  assert.equal(routes.get("POST /hermes/delegation/artifact").requiredCapability, "addon-runtime-read");
  assert.equal(routes.get("POST /hermes/delegation/cancel").requiredCapability, "addon-runtime-control");
  assert.equal(routes.get("POST /opencode/delegation/start").requiredCapability, "addon-runtime-control");
  assert.equal(routes.get("POST /opencode/delegation/status").requiredCapability, "addon-runtime-read");
  assert.equal(routes.get("POST /opencode/delegation/artifact").requiredCapability, "addon-runtime-read");
  assert.equal(routes.get("POST /opencode/delegation/cancel").requiredCapability, "addon-runtime-control");
  assert.equal(routes.get("POST /addons/draft").requiredCapability, "addon-record-write");
  assert.equal(routes.get("POST /addons/draft/list").requiredCapability, "addon-record-read");
  assert.equal(routes.get("POST /addons/draft/read").requiredCapability, "addon-record-read");
  assert.equal(routes.get("POST /addons/draft/transition").requiredCapability, "addon-record-write");
  assert.equal(routes.get("POST /addons/draft/handoff").requiredCapability, "addon-record-write");
  assert.equal(routes.get("POST /addons/delegate").requiredCapability, "addon-record-write");
  assert.equal(routes.get("POST /addons/delegate/list").requiredCapability, "addon-record-read");
  assert.equal(routes.get("POST /goals").requiredCapability, "addon-record-write");
});

test("add-on delegation host service fails fast when a handler is missing", () => {
  const incomplete = handlers();
  delete incomplete.executeHermesDelegationStart;

  assert.throws(
    () => createAddonDelegationHostService(incomplete),
    /Add-on delegation host service missing handler: executeHermesDelegationStart/,
  );
});
