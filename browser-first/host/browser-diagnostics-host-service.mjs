import path from "node:path";
import { createBrowserDiagnosticsService } from "./browser-diagnostics-service.mjs";

export function createBrowserDiagnosticsHostService({
  repoRoot,
  resonantExtension,
  userRoot,
  browserFirstRoot,
  memoryRoot,
  profileDir,
  readProviderSecrets,
  executeProviderStatus,
  executeAddonsStatus,
  executeMemoryStatus,
  countFiles,
  redactPathForDiagnostics,
  redactDiagnosticText,
} = {}) {
  function required(name, value) {
    if (!value) {
      throw new Error(`Browser diagnostics host service missing dependency: ${name}`);
    }
    return value;
  }
  for (const [name, value] of Object.entries({
    repoRoot,
    resonantExtension,
    userRoot,
    browserFirstRoot,
    memoryRoot,
    profileDir,
    readProviderSecrets,
    executeProviderStatus,
    executeAddonsStatus,
    executeMemoryStatus,
    countFiles,
    redactPathForDiagnostics,
    redactDiagnosticText,
  })) {
    required(name, value);
  }

  async function executeSystemStatus() {
    const secrets = await readProviderSecrets();
    const [memory, addons] = await Promise.all([executeMemoryStatus(), executeAddonsStatus()]);
    const goalsDir = path.join(browserFirstRoot(), "Goals");
    const delegationsDir = path.join(browserFirstRoot(), "Delegations");
    return {
      bridge: "resonantos-browser-first",
      providers: {
        "shared-minimax": Boolean(secrets["shared-minimax"]),
        "shared-zai-glm": Boolean(secrets["shared-zai-glm"]),
        "shared-openai": Boolean(secrets["shared-openai"]),
      },
      memory,
      addons: addons.addons,
      records: {
        goals: await countFiles(goalsDir, (filePath) => filePath.endsWith(".json")),
        delegations: await countFiles(delegationsDir, (filePath) => filePath.endsWith(".md")),
      },
    };
  }

  const service = createBrowserDiagnosticsService({
    repoRoot,
    resonantExtension,
    userRoot,
    browserFirstRoot,
    memoryRoot,
    profileDir,
    executeSystemStatus,
    executeProviderStatus,
    executeAddonsStatus,
    executeMemoryStatus,
    redactPathForDiagnostics,
    redactDiagnosticText,
  });

  return {
    ...service,
    executeSystemStatus,
    browserDiagnosticsRoutes: [
      { method: "GET", path: "/status", handler: executeSystemStatus },
      { method: "GET", path: "/workspace/inspect", handler: service.executeWorkspaceInspection },
      { method: "GET", path: "/browser/downloads", handler: service.executeBrowserDownloads },
      { method: "GET", path: "/browser/launch-diagnostics", handler: service.executeBrowserLaunchDiagnostics },
      {
        method: "POST",
        path: "/browser/downloads/action",
        requiredCapability: "browser-download-action",
        handler: service.executeBrowserDownloadAction,
      },
      {
        method: "POST",
        path: "/diagnostics/report",
        requiredCapability: "diagnostics-report-export",
        handler: service.executeDiagnosticsReport,
      },
    ],
  };
}
