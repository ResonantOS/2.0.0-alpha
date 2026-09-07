import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAddonDelegationHostService } from "../host/addon-delegation-host-service.mjs";
import { createBrowserDiagnosticsHostService } from "../host/browser-diagnostics-host-service.mjs";
import { createExtensionPrefsHostService } from "../host/extension-prefs-host-service.mjs";
import { createMemoryHostService } from "../host/memory-host-service.mjs";
import { createProviderHostService } from "../host/provider-host-service.mjs";
import { bridgeServerPort, evaluateBridgeRequestForSelfTest, startBridgeServer } from "../host/bridge-server.mjs";

const bridgeToken = "bridge-token";
const bridgeDiagnosticsReadToken = "bridge-diagnostics-read-token";
const addonRuntimeReadToken = "addon-runtime-read-token";
const providerDiagnosticsReadToken = "provider-diagnostics-read-token";
const memoryReadToken = "memory-read-token";
const extensionPrefsReadToken = "extension-prefs-read-token";

const protectedGetRoutes = [
  { route: "/status", capability: "bridge-diagnostics-read", correctToken: bridgeDiagnosticsReadToken, wrongToken: addonRuntimeReadToken },
  { route: "/workspace/inspect", capability: "bridge-diagnostics-read", correctToken: bridgeDiagnosticsReadToken, wrongToken: addonRuntimeReadToken },
  { route: "/browser/downloads", capability: "bridge-diagnostics-read", correctToken: bridgeDiagnosticsReadToken, wrongToken: addonRuntimeReadToken },
  { route: "/browser/launch-diagnostics", capability: "bridge-diagnostics-read", correctToken: bridgeDiagnosticsReadToken, wrongToken: addonRuntimeReadToken },
  { route: "/addons/status", capability: "addon-runtime-read", correctToken: addonRuntimeReadToken, wrongToken: bridgeDiagnosticsReadToken },
  { route: "/addons/execution-settings", capability: "addon-runtime-read", correctToken: addonRuntimeReadToken, wrongToken: bridgeDiagnosticsReadToken },
  { route: "/opencode/status", capability: "addon-runtime-read", correctToken: addonRuntimeReadToken, wrongToken: bridgeDiagnosticsReadToken },
  { route: "/providers/status", capability: "provider-diagnostics-read", correctToken: providerDiagnosticsReadToken, wrongToken: bridgeDiagnosticsReadToken },
  { route: "/memory/status", capability: "memory-read", correctToken: memoryReadToken, wrongToken: bridgeDiagnosticsReadToken },
  { route: "/memory/settings", capability: "memory-read", correctToken: memoryReadToken, wrongToken: bridgeDiagnosticsReadToken },
  { route: "/memory/wiki/health", capability: "memory-read", correctToken: memoryReadToken, wrongToken: bridgeDiagnosticsReadToken },
  { route: "/settings/extension-prefs", capability: "extension-prefs-read", correctToken: extensionPrefsReadToken, wrongToken: bridgeDiagnosticsReadToken },
];

const memoryHandlerNames = [
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

function stubHandlers(names) {
  return Object.fromEntries(names.map((name) => [name, async () => ({ name })]));
}

function createRoutes(root) {
  const provider = createProviderHostService({
    redactDiagnosticText: String,
    extractJsonObject: JSON.parse,
  });
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
  const memory = createMemoryHostService(stubHandlers(memoryHandlerNames));
  const addon = createAddonDelegationHostService({
    executeAddonsStatus: async () => ({ addons: [] }),
    executeAddonExecutionSettingsGet: async () => ({
      settings: {
        hermes: { localCliExecution: false },
        opencode: { localCliExecution: false },
      },
    }),
    executeAddonExecutionSettingsUpdate: async () => ({ status: "updated" }),
    executeOpenCodeStatus: async () => ({ mode: "stub", executionEnabled: false }),
    executeHermesDashboardStatus: async () => ({}),
    executeHermesDashboardStart: async () => ({}),
    executeHermesDashboardStop: async () => ({}),
    executeHermesStatus: async () => ({}),
    executeHermesDelegationStart: async () => ({}),
    executeHermesDelegationStatus: async () => ({}),
    executeHermesDelegationArtifact: async () => ({}),
    executeHermesDelegationCancel: async () => ({}),
    executeOpenCodeDelegationStart: async () => ({}),
    executeOpenCodeDelegationStatus: async () => ({}),
    executeOpenCodeDelegationArtifact: async () => ({}),
    executeOpenCodeDelegationCancel: async () => ({}),
    executeOpenCodeWebUrl: async () => ({}),
    executeAddonDraftRecord: async () => ({}),
    executeAddonDraftList: async () => ({}),
    executeAddonDraftRead: async () => ({}),
    executeAddonDraftTransition: async () => ({}),
    executeAddonDraftProviderHandoff: async () => ({}),
    executeDelegationRecord: async () => ({}),
    executeDelegationList: async () => ({}),
    executeAddonUninstallAudit: async () => ({}),
    executeAddonRunningWork: async () => ({}),
    executeGoalRecord: async () => ({}),
  });
  const prefs = createExtensionPrefsHostService({ userRoot: () => root });
  return [
    ...diagnostics.browserDiagnosticsRoutes,
    ...provider.providerBridgeRoutes,
    ...memory.memoryBridgeRoutes,
    ...addon.addonDelegationRoutes,
    ...prefs.extensionPrefsRoutes,
  ];
}

test("twelve bridge GET routes require route-scoped capability tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-bridge-get-routes-"));
  const routes = createRoutes(root);
  const bridgeCapabilityTokens = {
    "bridge-diagnostics-read": bridgeDiagnosticsReadToken,
    "addon-runtime-read": addonRuntimeReadToken,
    "provider-diagnostics-read": providerDiagnosticsReadToken,
    "memory-read": memoryReadToken,
    "extension-prefs-read": extensionPrefsReadToken,
  };
  let server;
  let bridgeUrl = "";
  try {
    try {
      server = await startBridgeServer({
        port: 0,
        bridgeToken,
        bridgeCapabilityTokens,
        extensionOrigin: "chrome-extension://test",
        routes,
      });
    } catch (error) {
      if (error?.code === "EPERM" && error?.address === "127.0.0.1") {
        server = null;
      } else {
        throw error;
      }
    }
    bridgeUrl = server ? `http://127.0.0.1:${bridgeServerPort(server)}` : "";

    const requestRoute = async (route, headers = {}) => {
      if (server) {
        const response = await fetch(`${bridgeUrl}${route}`, { headers });
        return {
          status: response.status,
          payload: await response.json().catch(() => ({})),
        };
      }
      return evaluateBridgeRequestForSelfTest({
        method: "GET",
        url: route,
        headers,
        bridgeToken,
        bridgeCapabilityTokens,
        routes,
      });
    };

    for (const { route, capability, correctToken, wrongToken } of protectedGetRoutes) {
      const noBridgeToken = await requestRoute(route);
      assert.equal(noBridgeToken.status, 401, `${route} without bridge token`);

      const bridgeTokenOnly = await requestRoute(route, { "X-ResonantOS-Bridge-Token": bridgeToken });
      assert.equal(bridgeTokenOnly.status, 403, `${route} without ${capability}`);
      assert.match(bridgeTokenOnly.payload.error ?? "", new RegExp(`requires ${capability} capability`));

      const authorized = await requestRoute(route, {
        "X-ResonantOS-Bridge-Token": bridgeToken,
        "X-ResonantOS-Bridge-Capability-Token": correctToken,
      });
      assert.equal(authorized.status, 200, `${route} with ${capability}`);

      const wrongCapability = await requestRoute(route, {
        "X-ResonantOS-Bridge-Token": bridgeToken,
        "X-ResonantOS-Bridge-Capability-Token": wrongToken,
      });
      assert.equal(wrongCapability.status, 403, `${route} with wrong capability`);
    }
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
