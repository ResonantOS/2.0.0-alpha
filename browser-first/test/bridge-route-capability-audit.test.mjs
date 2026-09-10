import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAddonDelegationHostService } from "../host/addon-delegation-host-service.mjs";
import { createAgentControlHostService } from "../host/agent-control-host-service.mjs";
import { BRIDGE_CAPABILITIES } from "../host/bridge-capability-tokens.mjs";
import { createBrowserDiagnosticsHostService } from "../host/browser-diagnostics-host-service.mjs";
import { createDevExternalAgentRuntimesPanelService } from "../host/dev-external-agent-runtimes-panel.mjs";
import { createExtensionPrefsHostService } from "../host/extension-prefs-host-service.mjs";
import { createMemoryHostService } from "../host/memory-host-service.mjs";
import { createOpencodeSessionHostService } from "../host/opencode-session-host-service.mjs";
import { createProviderHostService } from "../host/provider-host-service.mjs";
import { parseArgs } from "../host/browser-first-host-utils.mjs";
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
  "executeAddonUninstallAudit",
  "executeAddonRunningWork",
  "executeAddonUserDataList",
  "executeAddonUserDataDelete",
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
    const devPanel = createDevExternalAgentRuntimesPanelService({ repoRoot: root });
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
    // Keyed by the exact identifier run-bridge-minimal.mjs spreads into `bridgeRoutes`, so the
    // composition guard below can prove each composed array is actually CONSTRUCTED here — not
    // merely named in a list.
    const routeArrays = {
      browserDiagnosticsRoutes: diagnostics.browserDiagnosticsRoutes,
      providerBridgeRoutes: provider.providerBridgeRoutes,
      agentControlRoutes: agent.agentControlRoutes,
      memoryBridgeRoutes: memory.memoryBridgeRoutes,
      addonDelegationRoutes: addon.addonDelegationRoutes,
      opencodeSessionRoutes: opencodeSession.opencodeSessionRoutes,
      extensionPrefsRoutes: prefs.extensionPrefsRoutes,
      // Mirrors run-bridge-minimal: the launcher spreads `activeDevPanelRoutes`,
      // which equals devPanelRoutes when the --dev-panel flag is on (the dev
      // configuration this audit covers) and [] in production. The routes are
      // still constructed here so their capability declarations are audited.
      activeDevPanelRoutes: devPanel.devPanelRoutes,
    };
    const routes = Object.values(routeArrays).flat();

    await callback(routes, routeArrays);
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

test("dev panel routes are registered only behind the explicit --dev-panel flag", async () => {
  const source = await readFile(
    new URL("../host/run-bridge-minimal.mjs", import.meta.url),
    "utf8",
  );
  // The gate is exactly the dev-panel launch arg compared to "true" — no
  // environment variable may enable the panel implicitly.
  const gateLine = source.split("\n").find((line) => line.includes("devPanelEnabled ="));
  assert.ok(gateLine, "run-bridge-minimal must compute devPanelEnabled");
  assert.match(gateLine, /args\.get\("dev-panel"\) === "true"/);
  assert.ok(!gateLine.includes("process.env"), "the panel must not be enabled via environment");
  // Disabled yields an empty array (no base route changes); enabled yields
  // exactly devPanelRoutes (whose two-route shape the service test pins).
  const selectLine = source.split("\n").find((line) => line.includes("activeDevPanelRoutes ="));
  assert.ok(selectLine, "run-bridge-minimal must select activeDevPanelRoutes");
  assert.match(selectLine, /devPanelEnabled \? devPanelRoutes : \[\]/);

  // Executable proof of the flag semantics the gate relies on (parseArgs):
  // bare --dev-panel and --dev-panel=true enable; =false and absent do not.
  const gate = (argv) => parseArgs(argv).get("dev-panel") === "true";
  assert.equal(gate(["--dev-panel"]), true, "bare --dev-panel enables");
  assert.equal(gate(["--dev-panel=true"]), true, "--dev-panel=true enables");
  assert.equal(gate(["--dev-panel=false"]), false, "--dev-panel=false disables");
  assert.equal(gate([]), false, "absent flag disables (default off)");
});

test("audit covers every route array composed by run-bridge-minimal", async () => {
  const source = await readFile(
    new URL("../host/run-bridge-minimal.mjs", import.meta.url),
    "utf8",
  );
  const bridgeRoutesInitializer = /const\s+bridgeRoutes\s*=\s*\[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const composedRouteArrays = [...bridgeRoutesInitializer.matchAll(/\.\.\.(\w+)/g)].map((match) => match[1]);
  assert.ok(composedRouteArrays.length >= 7, "expected run-bridge-minimal to compose at least seven route arrays");

  await withBridgeRoutes(async (_routes, routeArrays) => {
    for (const name of composedRouteArrays) {
      assert.ok(
        Array.isArray(routeArrays[name]) && routeArrays[name].length > 0,
        `${name} is composed by run-bridge-minimal but this audit does not construct it (add the service to withBridgeRoutes)`,
      );
    }
  });
});
