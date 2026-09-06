import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAddonDelegationHostService } from "../host/addon-delegation-host-service.mjs";
import { createAgentControlHostService } from "../host/agent-control-host-service.mjs";
import { BRIDGE_CAPABILITIES } from "../host/bridge-capability-tokens.mjs";
import { createBrowserDiagnosticsHostService } from "../host/browser-diagnostics-host-service.mjs";
import { createExtensionPrefsHostService } from "../host/extension-prefs-host-service.mjs";
import { createMemoryHostService } from "../host/memory-host-service.mjs";
import { createOpencodeSessionHostService } from "../host/opencode-session-host-service.mjs";
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
  "executeOpenCodeWebUrl",
  "executeAddonDraftRecord",
  "executeAddonDraftList",
  "executeAddonDraftRead",
  "executeAddonDraftTransition",
  "executeAddonDraftProviderHandoff",
  "executeDelegationRecord",
  "executeDelegationList",
  "executeGoalRecord",
];

const opencodeSessionHandlers = [
  "executeOpenCodeSessionStart",
  "executeOpenCodeSessionPrompt",
  "executeOpenCodeSessionPermission",
  "executeOpenCodeSessionStop",
  "executeOpenCodeSessionsList",
  "executeOpenCodeSessionMessages",
  "executeOpenCodeSessionAbort",
  "executeOpenCodeSessionDiff",
  "executeOpenCodeSessionRename",
  "executeOpenCodeSessionDelete",
  "executeOpenCodeSessionArchive",
  "executeOpenCodeAgentsList",
];

function handlers(names) {
  return Object.fromEntries(names.map((name) => [name, async () => ({ name })]));
}

// Every entry must be ["METHOD /path", "written rationale"].
const UNGATED_ROUTE_ALLOWLIST = new Map([]);

async function withBridgeRoutes(callback) {
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
    const opencodeSession = createOpencodeSessionHostService(handlers(opencodeSessionHandlers));
    const prefs = createExtensionPrefsHostService({ userRoot: () => root });
    const diagnostics = createBrowserDiagnosticsHostService({
      repoRoot: root,
      resonantExtension: path.join(root, "extension"),
      userRoot: () => path.join(root, "user"),
      browserFirstRoot: () => path.join(root, "BrowserFirst"),
      memoryRoot: () => path.join(root, "Memory"),
      profileDir: path.join(root, "profile"),
      readProviderSecrets: async () => ({}),
      executeProviderStatus: async () => ({ providers: [] }),
      executeAddonsStatus: async () => ({ addons: [] }),
      executeMemoryStatus: async () => ({}),
      countFiles: async () => 0,
      redactPathForDiagnostics: (value) => String(value ?? ""),
      redactDiagnosticText: (value) => String(value ?? ""),
    });
    const routes = [
      ...diagnostics.browserDiagnosticsRoutes,
      ...provider.providerBridgeRoutes,
      ...agent.agentControlRoutes,
      ...memory.memoryBridgeRoutes,
      ...addon.addonDelegationRoutes,
      ...opencodeSession.opencodeSessionRoutes,
      ...prefs.extensionPrefsRoutes,
    ];

    await callback(routes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function bridgeRouteKey(route) {
  return `${route.method} ${route.path}`;
}

test("extension bridge client capability map matches gated host routes", async () => {
  await withBridgeRoutes(async (routes) => {
    for (const route of routes.filter((entry) => entry.requiredCapability)) {
      assert.equal(
        capabilityForBridgeRoute(route.path, route.method),
        route.requiredCapability,
        bridgeRouteKey(route),
      );
    }
  });
});

test("every bridge route declares a capability or is allowlisted with a rationale", async () => {
  await withBridgeRoutes(async (routes) => {
    const routeKeys = new Set(routes.map(bridgeRouteKey));
    for (const route of routes) {
      const key = bridgeRouteKey(route);
      assert.ok(
        route.requiredCapability || UNGATED_ROUTE_ALLOWLIST.has(key),
        `${key} must declare requiredCapability or be allowlisted with a rationale`,
      );
    }
    for (const [key, rationale] of UNGATED_ROUTE_ALLOWLIST) {
      assert.ok(routeKeys.has(key), `${key} is allowlisted but no route exists`);
      assert.equal(typeof rationale, "string", `${key} allowlist rationale must be a string`);
      assert.ok(rationale.trim(), `${key} allowlist rationale must not be empty`);
    }
  });
});

test("every route capability exists in the launcher catalog", async () => {
  await withBridgeRoutes(async (routes) => {
    for (const route of routes.filter((entry) => entry.requiredCapability)) {
      assert.ok(
        BRIDGE_CAPABILITIES.includes(route.requiredCapability),
        `${bridgeRouteKey(route)} requires unknown capability ${route.requiredCapability}`,
      );
    }
  });
});

test("audit covers every route array composed by run-bridge-minimal", async () => {
  const source = await readFile(
    new URL("../host/run-bridge-minimal.mjs", import.meta.url),
    "utf8",
  );
  const bridgeRoutesInitializer = /const\s+bridgeRoutes\s*=\s*\[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const composedRouteArrays = [...bridgeRoutesInitializer.matchAll(/\.\.\.(\w+)/g)].map((match) => match[1]);
  const auditedRouteArrays = [
    "browserDiagnosticsRoutes",
    "providerBridgeRoutes",
    "agentControlRoutes",
    "memoryBridgeRoutes",
    "addonDelegationRoutes",
    "opencodeSessionRoutes",
    "extensionPrefsRoutes",
  ];

  assert.deepEqual(
    composedRouteArrays.filter((name) => !auditedRouteArrays.includes(name)),
    [],
    "run-bridge-minimal composes route arrays that bridge-route-capability-audit does not construct",
  );
});
