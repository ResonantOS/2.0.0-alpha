#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  createBridgeToken,
  getBridgeHost,
  getBridgePublicUrl,
  startBridgeServerWithFallback,
  writeBridgeConfig,
} from "./bridge-server.mjs";
import {
  countFiles,
  dashboardTarget,
  execFileStdout,
  expandUserPath,
  firstExistingExecutable,
  isInsidePath,
  listFilesRecursive,
  parseArgs,
  pathSummary,
  redactDiagnosticText,
  redactPathForDiagnostics,
  safeFileSlug,
  socketOpen,
  stableMemorySourceId,
  uniqueRuntimeId,
} from "./browser-first-host-utils.mjs";
import { runBrowserFirstSelfTest } from "./browser-first-self-test-service.mjs";
import { createAgentControlHostService } from "./agent-control-host-service.mjs";
import { buildBridgeCapabilityTokens } from "./bridge-capability-tokens.mjs";
import { createAddonDelegationHostService } from "./addon-delegation-host-service.mjs";
import { createAddonDelegationService } from "./addon-delegation-service.mjs";
import { createArchiveReviewHostService } from "./archive-review-host-service.mjs";
import { createBrowserDiagnosticsHostService } from "./browser-diagnostics-host-service.mjs";
import { createExtensionPrefsHostService } from "./extension-prefs-host-service.mjs";
import { createMemoryHostService } from "./memory-host-service.mjs";
import { createMemorySourceIntakeHostService } from "./memory-source-intake-host-service.mjs";
import { createMemorySourceSettingsService } from "./memory-source-settings-service.mjs";
import { opencodeRuntimeDiagnostics } from "./opencode-runtime.mjs";
import {
  hermesCommand,
  hermesHome,
  hermesPythonRuntimeDiagnostics,
} from "./hermes-runtime.mjs";
import { createProviderHostService } from "./provider-host-service.mjs";
import {
  memorySourceMoveHistoryPath as sourceMoveHistoryPath,
  memorySourceRepairHistoryPath as sourceRepairHistoryPath,
  memorySourceSyncHistoryPath as sourceSyncHistoryPath,
} from "./memory-source-history.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resonantExtension = path.join(repoRoot, "browser-first", "resonantos-side-panel-extension");
const defaultBridgePort = 47773;
const resonantExtensionId = "cdpdmmalhmokbfcfgogoepnjplaakgnl";
const resonantExtensionOrigin = `chrome-extension://${resonantExtensionId}`;
const args = parseArgs(process.argv.slice(2));

function userRoot() {
  return path.resolve(process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT || path.join(os.homedir(), "ResonantOS_User"));
}

function memoryRoot() {
  return path.join(userRoot(), "Memory");
}

function memorySettingsPath() {
  return path.join(memoryRoot(), "CONFIG", "memory-settings.json");
}

function memorySourceAuditPath() {
  return path.join(memoryRoot(), "CONFIG", "source-audit.md");
}

function memorySourceFileManifestPath() {
  return path.join(memoryRoot(), "CONFIG", "source-file-versions.json");
}

function memorySourceSyncHistoryPath() {
  return sourceSyncHistoryPath(memoryRoot());
}

function memorySourceRepairHistoryPath() {
  return sourceRepairHistoryPath(memoryRoot());
}

function memorySourceMoveHistoryPath() {
  return sourceMoveHistoryPath(memoryRoot());
}

function browserFirstRoot() {
  return path.join(userRoot(), "BrowserFirst");
}

function extractJsonObject(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error("Planner returned an empty response.");
  }
  try {
    return JSON.parse(text);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim();
    if (fenced) {
      return JSON.parse(fenced);
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Planner response was not valid JSON.");
  }
}

const bridgePublicUrlHolder = { value: undefined };
const getBridgePublicUrlValue = () => bridgePublicUrlHolder.value;
let addonRuntimeSelfTestHomeDir = null;
const addonRuntimeResolverOptions = () => addonRuntimeSelfTestHomeDir
  ? { homeDir: addonRuntimeSelfTestHomeDir }
  : {};
const resolveHermesCommand = () => hermesCommand(addonRuntimeResolverOptions());
const resolveHermesPythonRuntime = (command) =>
  hermesPythonRuntimeDiagnostics(command, addonRuntimeResolverOptions());
const resolveOpenCodeRuntimeDiagnostics = () => opencodeRuntimeDiagnostics(addonRuntimeResolverOptions());
const resolveOpenCodeCommand = () => resolveOpenCodeRuntimeDiagnostics().command;
const setAddonRuntimeSelfTestHomeDir = (homeDir) => {
  addonRuntimeSelfTestHomeDir = homeDir
    ? realpathSync.native(path.resolve(homeDir))
    : null;
};

const {
  executeProviderStatus,
  extractAssistantContent,
  openAiReasoningEffort,
  providerBridgeRoutes,
  providerRouteForModel,
  allModelCatalog,
  allProviderProfiles,
  readProviderSecrets,
  runArchiveIngestWriter,
  runArchiveSemanticVerifier,
  sanitizeAssistantContent,
} = createProviderHostService({
  redactDiagnosticText,
  extractJsonObject,
});

const addonDelegationService = createAddonDelegationService({
  browserFirstRoot,
  bridgePublicUrl: getBridgePublicUrlValue,
  dashboardTarget,
  execFileStdout,
  expandUserPath,
  firstExistingExecutable,
  hermesCommand: resolveHermesCommand,
  hermesHome,
  hermesPythonRuntime: resolveHermesPythonRuntime,
  listFilesRecursive,
  memoryRoot,
  opencodeCommand: resolveOpenCodeCommand,
  opencodeRuntimeDiagnostics: resolveOpenCodeRuntimeDiagnostics,
  redactPathForDiagnostics,
  readProviderSecrets,
  repoRoot,
  safeFileSlug,
  socketOpen,
  uniqueRuntimeId,
  userRoot,
});

const { executeAddonsStatus } = addonDelegationService;
const { addonDelegationRoutes } = createAddonDelegationHostService(addonDelegationService);

const memorySourceSettingsService = createMemorySourceSettingsService({
  memoryRoot,
  userRoot,
  memorySettingsPath,
  memorySourceAuditPath,
  countFiles,
  pathSummary,
  listFilesRecursive,
  expandUserPath,
  stableMemorySourceId,
  redactPathForDiagnostics,
  redactDiagnosticText,
  execFileStdout,
  firstExistingExecutable,
  isInsidePath,
  executeAddonsStatus,
});

const {
  appendMemorySourceAudit,
  appendMemorySourceRepairHistory,
  appendMemorySourceSyncHistory,
  classifyMemorySourceFile,
  executeMemorySettings,
  executeMemorySettingsSave,
  executeMemorySourceAction,
  executeMemorySourceBrowse,
  executeMemorySourceMoveExecute,
  executeMemorySourceMovePreflight,
  executeMemorySourceMoveRollback,
  executeMemorySourceScan,
  executeMemoryStatus,
  readMemorySettings,
  readMemorySourceMoveHistory,
  readMemorySourceRepairHistory,
} = memorySourceSettingsService;

const archiveReviewService = createArchiveReviewHostService({
  memoryRoot,
  userRoot,
  listFilesRecursive,
  safeFileSlug,
  runArchiveIngestWriter,
  runArchiveSemanticVerifier,
});

const {
  executeArchiveIntake,
  executeArchiveIntakeList,
  executeArchiveIntakeRead,
  executeArchivePromotionList,
  executeArchivePromotionRestore,
  executeArchiveReviewArtifactPromote,
  executeArchiveReviewArtifactRead,
  executeArchiveReviewArtifactRevise,
  executeArchiveReviewArtifactVerify,
  executeArchiveReviewDraft,
  executeArchiveReviewList,
  executeArchiveReviewRequest,
  executeArchiveReviewTransition,
  executeArchiveVerificationRead,
  executeMemoryWikiPageRead,
} = archiveReviewService;

const memorySourceIntakeService = createMemorySourceIntakeHostService({
  appendMemorySourceAudit,
  appendMemorySourceRepairHistory,
  appendMemorySourceSyncHistory,
  classifyMemorySourceFile,
  executeArchiveReviewRequest,
  executeMemorySourceScan,
  expandUserPath,
  listFilesRecursive,
  memoryRoot,
  memorySourceFileManifestPath,
  readMemorySettings,
  redactDiagnosticText,
  safeFileSlug,
});

const {
  executeMemorySourceReview,
  executeMemorySourceIntake,
  executeMemorySourceFileIntake,
  executeMemorySourceSync,
  executeMemorySearch,
  executeMemoryWikiHealth,
  executeMemoryWikiLint,
  executeMemorySourceVersions,
  executeMemorySourceVersionsRepair,
  executeMemorySourceDiff,
} = memorySourceIntakeService;

const { memoryBridgeRoutes } = createMemoryHostService({
  executeMemoryStatus,
  executeMemorySettings,
  executeMemorySettingsSave,
  executeMemorySourceBrowse,
  executeMemorySourceScan,
  executeMemorySourceAction,
  executeMemorySourceMovePreflight,
  executeMemorySourceMoveExecute,
  executeMemorySourceMoveRollback,
  executeMemorySourceReview,
  executeMemorySourceIntake,
  executeMemorySourceFileIntake,
  executeMemorySourceSync,
  executeMemorySearch,
  executeMemoryWikiHealth,
  executeMemoryWikiPageRead,
  executeMemoryWikiLint,
  executeMemorySourceVersions,
  executeMemorySourceVersionsRepair,
  executeMemorySourceDiff,
  executeArchiveIntake,
  executeArchiveIntakeList,
  executeArchiveIntakeRead,
  executeArchiveReviewRequest,
  executeArchiveReviewList,
  executeArchiveReviewTransition,
  executeArchiveReviewDraft,
  executeArchiveReviewArtifactRead,
  executeArchiveReviewArtifactVerify,
  executeArchiveVerificationRead,
  executeArchiveReviewArtifactRevise,
  executeArchiveReviewArtifactPromote,
  executeArchivePromotionList,
  executeArchivePromotionRestore,
});

const { browserDiagnosticsRoutes, executeSystemStatus } = createBrowserDiagnosticsHostService({
  repoRoot,
  resonantExtension,
  userRoot,
  browserFirstRoot,
  memoryRoot,
  profileDir: path.join(userRoot(), "BrowserFirst", "Profiles", "main"),
  executeProviderStatus,
  executeAddonsStatus,
  executeMemoryStatus,
  readProviderSecrets,
  countFiles,
  redactPathForDiagnostics,
  redactDiagnosticText,
});

const { agentControlRoutes } = createAgentControlHostService({
  extractAssistantContent,
  extractJsonObject,
  openAiReasoningEffort,
  providerRouteForModel,
  allModelCatalog,
  allProviderProfiles,
  readProviderSecrets,
  sanitizeAssistantContent,
});

const { extensionPrefsRoutes, flushPendingExtensionPrefs } = createExtensionPrefsHostService({ userRoot });

const bridgeRoutes = [
  ...browserDiagnosticsRoutes,
  ...providerBridgeRoutes,
  ...agentControlRoutes,
  ...memoryBridgeRoutes,
  ...addonDelegationRoutes,
  ...extensionPrefsRoutes,
];

const bridgeToken = args.get("bridge-token") ?? process.env.RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN ?? createBridgeToken();
const capabilityBootstrapToken = args.get("capability-bootstrap-token") ??
  process.env.RESONANTOS_BROWSER_FIRST_CAPABILITY_BOOTSTRAP_TOKEN ??
  createBridgeToken();
const bridgeCapabilityTokens = buildBridgeCapabilityTokens({ args, mint: createBridgeToken });

async function invokeBridgeRouteForSelfTest({ method = "POST", routePath, body = {}, capabilityToken = "" } = {}) {
  const route = bridgeRoutes.find((entry) => entry.method === method && entry.path === routePath);
  if (!route) {
    return { status: 404, payload: { ok: false, error: "Unknown browser-first bridge route." } };
  }
  if (route.requiredCapability && capabilityToken !== bridgeCapabilityTokens[route.requiredCapability]) {
    return { status: 403, payload: { ok: false, error: `Bridge route requires ${route.requiredCapability} capability.` } };
  }
  try {
    const result = await route.handler(body, { headers: {} });
    return { status: 200, payload: { ok: true, ...result } };
  } catch (error) {
    return { status: 500, payload: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

const selfTestHandled = await runBrowserFirstSelfTest({
  args,
  bridgeCapabilityTokens,
  bridgeRoutes,
  bridgeToken,
  invokeBridgeRouteForSelfTest,
  memoryRoot,
  memorySettingsPath,
  memorySourceFileManifestPath,
  memorySourceSyncHistoryPath,
  readMemorySourceMoveHistory,
  readMemorySourceRepairHistory,
  resonantExtensionOrigin,
  safeFileSlug,
  setAddonRuntimeSelfTestHomeDir,
});

if (selfTestHandled) {
  process.exit(0);
}

if (!existsSync(path.join(resonantExtension, "manifest.json"))) {
  console.error(`ResonantOS extension is missing: ${resonantExtension}`);
  process.exit(1);
}

const bridgePort = Number(args.get("bridge-port") ?? process.env.RESONANTOS_BROWSER_FIRST_BRIDGE_PORT ?? defaultBridgePort);
const bridgeInfo = await startBridgeServerWithFallback({
  port: bridgePort,
  bridgeToken,
  bridgeCapabilityTokens,
  capabilityBootstrapToken,
  extensionOrigin: resonantExtensionOrigin,
  routes: bridgeRoutes,
  host: getBridgeHost(),
});

const activeBridgePort = bridgeInfo.actualPort;
const bridgePublicUrl = getBridgePublicUrl(activeBridgePort);
bridgePublicUrlHolder.value = bridgePublicUrl;
const bridgeConfigPath = await writeBridgeConfig({
  extensionRoot: resonantExtension,
  bridgePort: activeBridgePort,
  bridgeToken,
  capabilityBootstrapToken,
  publicUrl: bridgePublicUrl,
});

console.log(JSON.stringify({
  event: "browser.first.bridge_started",
  requestedPort: bridgeInfo.requestedPort,
  attemptedPort: bridgeInfo.attemptedPort,
  actualPort: activeBridgePort,
  recovered: bridgeInfo.recovered,
  bridgeUrl: bridgePublicUrl,
  bridgeConfigPath,
}, null, 2));
console.log("Load browser-first/resonantos-side-panel-extension in Chrome as an unpacked extension.");

const shutdown = async () => {
  await flushPendingExtensionPrefs().catch(() => undefined);
  await new Promise((resolve) => bridgeInfo.server.close(resolve));
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
