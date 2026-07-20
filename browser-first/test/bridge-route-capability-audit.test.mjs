import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAddonDelegationHostService } from "../host/addon-delegation-host-service.mjs";
import { createAgentControlHostService } from "../host/agent-control-host-service.mjs";
import { createExtensionPrefsHostService } from "../host/extension-prefs-host-service.mjs";
import { createMemoryHostService } from "../host/memory-host-service.mjs";
import { createProviderHostService } from "../host/provider-host-service.mjs";
import { capabilityForBridgeRoute } from "../resonantos-side-panel-extension/src/lib/bridge-client.js";

const memoryHandlers = [
  "executeMemoryStatus",
  "executeMemorySettings",
  "executeMemorySettingsSave",
  "executeMemorySourceBrowse",
  "executeMemorySourceScan",
  "executeMemorySourceAction",
  "executeMemorySourceMovePreflight",
  "executeMemorySourceMoveExecute",
  "executeMemorySourceMoveRollback",
  "executeMemorySourceReview",
  "executeMemorySourceIntake",
  "executeMemorySourceFileIntake",
  "executeMemorySourceSync",
  "executeMemorySearch",
  "executeMemoryWikiHealth",
  "executeMemoryWikiPageRead",
  "executeMemoryWikiLint",
  "executeMemorySourceVersions",
  "executeMemorySourceVersionsRepair",
  "executeMemorySourceDiff",
  "executeArchiveIntake",
  "executeArchiveIntakeList",
  "executeArchiveIntakeRead",
  "executeArchiveReviewRequest",
  "executeArchiveReviewList",
  "executeArchiveReviewTransition",
  "executeArchiveReviewDraft",
  "executeArchiveReviewArtifactRead",
  "executeArchiveReviewArtifactVerify",
  "executeArchiveVerificationRead",
  "executeArchiveReviewArtifactRevise",
  "executeArchiveReviewArtifactPromote",
  "executeArchivePromotionList",
  "executeArchivePromotionRestore",
];

const addonHandlers = [
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

function handlers(names) {
  return Object.fromEntries(names.map((name) => [name, async () => ({ name })]));
}

test("extension bridge client capability map matches gated host routes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-route-capability-audit-"));
  try {
    const provider = createProviderHostService({
      redactDiagnosticText: (value) => String(value ?? ""),
      extractJsonObject: (value) => JSON.parse(String(value ?? "{}")),
    });
    const agent = createAgentControlHostService({
      extractAssistantContent: () => "{}",
      extractJsonObject: JSON.parse,
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }),
      openAiReasoningEffort: () => "none",
      providerRouteForModel: () => ({
        apiBaseUrl: "https://api.example.com/v1",
        label: "Provider",
        providerId: "provider",
        providerType: "openai",
        wireModel: "model",
      }),
      readProviderSecrets: async () => ({ provider: "secret-value" }),
      sanitizeAssistantContent: (_type, content) => content,
    });
    const memory = createMemoryHostService(handlers(memoryHandlers));
    const addon = createAddonDelegationHostService(handlers(addonHandlers));
    const prefs = createExtensionPrefsHostService({ userRoot: () => root });
    const routes = [
      ...provider.providerBridgeRoutes,
      ...agent.agentControlRoutes,
      ...memory.memoryBridgeRoutes,
      ...addon.addonDelegationRoutes,
      ...prefs.extensionPrefsRoutes,
    ];

    for (const route of routes.filter((entry) => entry.requiredCapability)) {
      assert.equal(
        capabilityForBridgeRoute(route.path, route.method),
        route.requiredCapability,
        `${route.method} ${route.path}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
