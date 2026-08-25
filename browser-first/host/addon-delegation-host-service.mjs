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
        path: "/hermes/delegation/cancel",
        requiredCapability: "addon-runtime-control",
        handler: required("executeHermesDelegationCancel"),
      },
      {
        method: "POST",
        path: "/hermes/delegation/list",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesDelegationList"),
      },
      {
        method: "POST",
        path: "/hermes/agent/event",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesAgentEvent"),
      },
      {
        method: "POST",
        path: "/hermes/agent/decision",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesAgentDecision"),
      },
      {
        method: "POST",
        path: "/hermes/artifact/ingest",
        requiredCapability: "addon-runtime-write",
        handler: required("executeHermesArtifactIngest"),
      },
      {
        method: "POST",
        path: "/hermes/memory/capture",
        requiredCapability: "addon-runtime-write",
        handler: required("executeHermesMemoryCapture"),
      },
      {
        method: "POST",
        path: "/hermes/prompt-queue/enqueue",
        requiredCapability: "addon-runtime-write",
        handler: required("executeHermesPromptQueueEnqueue"),
      },
      {
        method: "POST",
        path: "/hermes/prompt-queue/dequeue",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesPromptQueueDequeue"),
      },
      {
        method: "POST",
        path: "/hermes/prompt-queue/inspect",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesPromptQueueInspect"),
      },
      {
        method: "POST",
        path: "/hermes/prompt-queue/ack",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesPromptQueueAck"),
      },
      {
        method: "POST",
        path: "/hermes/prompt-queue/nack",
        requiredCapability: "addon-runtime-read",
        handler: required("executeHermesPromptQueueNack"),
      },
      {
        method: "POST",
        path: "/hermes/prompt-queue/complete",
        requiredCapability: "addon-runtime-write",
        handler: required("executeHermesPromptQueueComplete"),
      },
      {
        method: "POST",
        path: "/hermes/prompt-queue/handoff",
        requiredCapability: "addon-runtime-write",
        handler: required("executeHermesPromptQueueHandoff"),
      },
      {
        method: "GET",
        path: "/addons/draft",
        handler: required("executeAddonDraftList"),
      },
      {
        method: "GET",
        path: "/addons/draft/get",
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
