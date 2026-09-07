#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import {
  createBridgeToken,
  getBridgeHost,
  getBridgePublicUrl,
  startBridgeServerWithFallback,
  writeBridgeConfig,
} from "./bridge-server.mjs";
import { createBridgeRouteSelfTestInvoker } from "./bridge-self-test-invoker.mjs";
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
import { createBridgeGrantsStore } from "./bridge-grants-store.mjs";
import { createBridgeAuditLedger } from "./bridge-audit-ledger.mjs";
import { createBridgeTokenKey } from "./bridge-token-key.mjs";
import { createAddonDelegationHostService } from "./addon-delegation-host-service.mjs";
import { createAddonDelegationService } from "./addon-delegation-service.mjs";
import { createOpencodeHttpClient, ensureOpencodeServer } from "./opencode-client.mjs";
import { createOpencodeSessionHandlers, createOpencodeSessionHostService } from "./opencode-session-host-service.mjs";
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
const defaultResonantExtension = path.join(repoRoot, "browser-first", "resonantos-side-panel-extension");
const resonantExtension = resolveResonantExtensionRoot();
const defaultBridgePort = 47773;
const resonantExtensionId = "cdpdmmalhmokbfcfgogoepnjplaakgnl";
const resonantExtensionOrigin = `chrome-extension://${resonantExtensionId}`;
const args = parseArgs(process.argv.slice(2));

function resolveResonantExtensionRoot() {
  const configured = String(process.env.RESONANTOS_EXTENSION_ROOT ?? "").trim();
  if (!configured) return defaultResonantExtension;
  if (!path.isAbsolute(configured)) {
    console.error(`RESONANTOS_EXTENSION_ROOT must be an absolute path: ${configured}`);
    process.exit(1);
  }
  try {
    const resolved = realpathSync.native(configured);
    if (!statSync(resolved).isDirectory()) {
      throw new Error("not a directory");
    }
    return resolved;
  } catch {
    console.error(`RESONANTOS_EXTENSION_ROOT must point to an existing directory: ${configured}`);
    process.exit(1);
  }
}

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

// Live OpenCode session: the bridge starts (reuses) `opencode serve` on an
// ephemeral loopback port with a bridge-minted credential and proxies
// session/prompt/permission; the extension streams the server's /event bus
// directly (host_permissions cover 127.0.0.1).
const opencodeSessionHandlers = createOpencodeSessionHandlers({
  ensureServer: () => ensureOpencodeServer({
    fetchImpl: (...args) => fetch(...args),
    spawnImpl: (cmd, cmdArgs, opts) => spawn(cmd, cmdArgs, opts),
    command: resolveOpenCodeCommand(),
    hostname: "127.0.0.1",
    port: process.env.RESONANTOS_OPENCODE_PORT ? Number(process.env.RESONANTOS_OPENCODE_PORT) : undefined,
    env: process.env,
  }),
  createClient: (baseUrl, opts = {}) => createOpencodeHttpClient({ fetchImpl: (...args) => fetch(...args), baseUrl, ...opts }),
});
const { opencodeSessionRoutes } = createOpencodeSessionHostService(opencodeSessionHandlers);

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
  ...opencodeSessionRoutes,
  ...extensionPrefsRoutes,
];

const bridgeToken = args.get("bridge-token") ?? process.env.RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN ?? createBridgeToken();
const capabilityBootstrapToken = args.get("capability-bootstrap-token") ??
  process.env.RESONANTOS_BROWSER_FIRST_CAPABILITY_BOOTSTRAP_TOKEN ??
  createBridgeToken();
const bridgeCapabilityTokens = buildBridgeCapabilityTokens({ args, mint: createBridgeToken });

// Phase 3.5 (caller-attributed capability tokens). The minimal launcher
// constructs an in-memory grants store and a JSONL audit ledger and passes
// both to startBridgeServerWithFallback so that every successful capability-
// scoped bridge request carries caller attribution through to the audit log.
// Production launcher (resonantos-bridge-full.mjs) is not yet wired; that
// lands in a follow-up commit.
// Seed minimal-launcher demo callers for the bundled add-ons so any
// immediate caller-attribution exercises against the minimal launcher
// observe distinct audit records. Minting happens here so auditSink sees
// only authorised requests, not mint events.
const bridgeTokenKey = createBridgeTokenKey();
// Phase 3.5 H3 allowlist: only known add-on callerIds may mint grants. The
// list is hard-coded at the launcher level because it represents the set of
// bundled add-ons this minimal launcher is willing to serve. The audit line
// below records the allowlist at boot so a misconfigured launcher is
// observable in the launcher log.
const minimalLauncherCallerIds = ["hermes", "opencode", "resonant-context", "resonator"];
const minimalLauncherCallerGrants = (() => {
  const grants = createBridgeGrantsStore({
    tokenKey: bridgeTokenKey,
    callerIdAllowlist: minimalLauncherCallerIds,
  });
  grants.mintGrant("hermes", "provider-model-invoke");
  grants.mintGrant("hermes", "agent-control-plan");
  grants.mintGrant("opencode", "provider-model-invoke");
  grants.mintGrant("resonant-context", "archive-read");
  grants.mintGrant("resonator", "memory-source-manage");
  return grants;
})();
const bridgeAuditFilePath = path.join(userRoot(), "BrowserFirst", "audit.jsonl");
let bridgeAudit;
try {
  bridgeAudit = createBridgeAuditLedger({
    filePath: bridgeAuditFilePath,
    onError: (error) => console.error("[bridge-audit-ledger] write failed:", error?.message ?? error),
  });
} catch (error) {
  // Fail-fast (H3): a misconfigured audit ledger must not allow the bridge
  // to start. Otherwise the launcher silently loses its only observability
  // surface for caller-attributed requests.
  console.error("[run-bridge-minimal] failed to initialise audit ledger:", error?.message ?? error);
  console.error("[run-bridge-minimal] filePath:", bridgeAuditFilePath);
  process.exit(1);
}

const invokeBridgeRouteForSelfTest = createBridgeRouteSelfTestInvoker({
  bridgeToken,
  bridgeCapabilityTokens,
  capabilityBootstrapToken,
  routes: bridgeRoutes,
  perCallerGrants: minimalLauncherCallerGrants.snapshot(),
  tokenKey: bridgeTokenKey,
  callerGrantVerifier: minimalLauncherCallerGrants.verifyCallerGrant.bind(minimalLauncherCallerGrants),
  auditSink: bridgeAudit.sink,
});

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
  perCallerGrants: minimalLauncherCallerGrants.snapshot(),
  tokenKey: bridgeTokenKey,
  callerGrantVerifier: minimalLauncherCallerGrants.verifyCallerGrant.bind(minimalLauncherCallerGrants),
  auditSink: bridgeAudit.sink,
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
// H3 startup log: caller count and grant count are observable at boot so a
// misconfigured launcher doesn't silently ship with no add-ons authorised. We
// also emit a SHA-256 fingerprint of the tokenKey (first 8 hex chars) so two
// bridge processes can be told apart without leaking the key.
const tokenKeyFingerprint = createHash("sha256")
  .update(bridgeTokenKey)
  .digest("hex")
  .slice(0, 8);

console.log(JSON.stringify({
  event: "browser.first.caller_grants_ready",
  callerCount: minimalLauncherCallerGrants.listCallers().length,
  grantCount: minimalLauncherCallerGrants.listGrants().length,
  callerIds: minimalLauncherCallerGrants.listCallers(),
  tokenKeyFingerprint,
  auditLedgerPath: bridgeAuditFilePath,
}, null, 2));
console.log(JSON.stringify({
  event: "browser.first.bridge_started",
  requestedPort: bridgeInfo.requestedPort,
  attemptedPort: bridgeInfo.attemptedPort,
  actualPort: activeBridgePort,
  recovered: bridgeInfo.recovered,
  bridgeUrl: bridgePublicUrl,
  bridgeConfigPath,
  extensionRoot: resonantExtension,
}, null, 2));
console.log(`Load ${resonantExtension} in Chrome as an unpacked extension.`);

const shutdown = async () => {
  await flushPendingExtensionPrefs().catch(() => undefined);
  await new Promise((resolve) => bridgeInfo.server.close(resolve));
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
