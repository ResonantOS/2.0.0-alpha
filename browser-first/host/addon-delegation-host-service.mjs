// Intent citation: docs/architecture/ADR-040-provider-fabric-boundary-external-agent-runtimes.md#4-wire-format
//
// Add-on delegation host service: bridge-side route registry.
//
// This module returns a flat list of `addonDelegationRoutes` consumed by
// `bridge-server.mjs`. Each route binds an HTTP method + path + a
// required capability to a handler function the caller supplies via
// `createAddonDelegationHostService(handlers)`.
//
// The newest route, `POST /external-agent-runtime/delegate`, is the
// bridge-side surface for ADR-040 §4 wire-format dispatch. It expects
// the request to include a per-caller grant in Phase 3.5's
// `X-ResonantOS-Bridge-Caller-Id` header (handled by `bridge-server.mjs`
// itself); the handler reads `callerId` from the request context and
// passes it to `dispatchExternalAgentRuntime` along with the audit
// ledger.

import { dispatchExternalAgentRuntime } from "./external-agent-runtime-dispatcher.mjs";

export function createAddonDelegationHostService(handlers = {}) {
  function required(name) {
    if (typeof handlers[name] !== "function") {
      throw new Error(`Add-on delegation host service missing handler: ${name}`);
    }
    return handlers[name];
  }

  return {
    addonDelegationRoutes: [
      {
        method: "GET",
        path: "/addons/status",
        requiredCapability: "addon-runtime-read",
        handler: required("executeAddonsStatus"),
      },
      {
        method: "GET",
        path: "/addons/execution-settings",
        requiredCapability: "addon-runtime-read",
        handler: required("executeAddonExecutionSettingsGet"),
      },
      {
        method: "POST",
        path: "/addons/execution-settings",
        requiredCapability: "addon-execution-settings-write",
        handler: required("executeAddonExecutionSettingsUpdate"),
      },
      {
        method: "GET",
        path: "/opencode/status",
        requiredCapability: "addon-runtime-read",
        handler: required("executeOpenCodeStatus"),
      },
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
        path: "/opencode/web/url",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeWebUrl"),
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
      // ADR-040 §4 wire-format dispatch (Phase 3.5-mediated). Caller
      // MUST send X-ResonantOS-Bridge-Caller-Id (handled by
      // bridge-server.mjs); the per-caller grant store is queried by
      // `dispatchExternalAgentRuntime`. Audit is recorded to whatever
      // ledger the host wires in.
      {
        method: "POST",
        path: "/external-agent-runtime/delegate",
        requiredCapability: "agent-delegation",
        handler: async ({ body, callerId, perCallerGrants, auditLedger, fetchImpl }) => {
          const addonId = body?.addonId;
          const toolName = body?.tool;
          const payload = body?.payload ?? {};
          if (typeof addonId !== "string" || typeof toolName !== "string") {
            return { status: 400, body: { error: { message: "addonId and tool are required" } } };
          }
          const result = await dispatchExternalAgentRuntime({
            addonId,
            toolName,
            payload,
            callerId,
            perCallerGrants,
            auditLedger,
            fetchImpl,
          });
          if (result.outcome === "deny") {
            const status = result.reason === "addon-not-found"
              || result.reason === "manifest-misconfigured"
              ? 404
              : result.reason === "unknown-tool"
                ? 404
                : 403;
            return {
              status,
              body: { error: { code: result.reason, message: result.detail } },
            };
          }
          return { status: 200, body: { response: result.response } };
        },
      },
    ],
  };
}
