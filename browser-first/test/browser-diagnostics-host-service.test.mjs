import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrowserDiagnosticsHostService } from "../host/browser-diagnostics-host-service.mjs";
import { launchDiagnosticDownload } from "../host/browser-diagnostics-service.mjs";

function createService(overrides = {}) {
  return createBrowserDiagnosticsHostService({
    repoRoot: "/tmp/resonantos-repo",
    resonantExtension: "/tmp/resonantos-extension",
    userRoot: () => "/tmp/resonantos-user",
    browserFirstRoot: () => "/tmp/resonantos-user/BrowserFirst",
    memoryRoot: () => "/tmp/resonantos-user/Memory",
    profileDir: "/tmp/resonantos-profile",
    browserLaunchLogPath: () => "/tmp/resonantos-browser.log",
    readProviderSecrets: async () => ({ "shared-minimax": "redacted", "shared-zai-glm": "", "shared-openai": "" }),
    executeProviderStatus: async () => ({ providers: [] }),
    executeAddonsStatus: async () => ({ addons: [{ id: "living-archive" }] }),
    executeMemoryStatus: async () => ({ exists: true }),
    countFiles: async (root) => root.includes("Goals") ? 2 : 3,
    redactPathForDiagnostics: (value) => String(value ?? "").replace("/tmp", "~"),
    redactDiagnosticText: (value) => String(value ?? ""),
    ...overrides,
  });
}

function captureDiagnosticLaunch({ action, environment, filePath, platform, resolveExecutable }) {
  const calls = [];
  let unrefCount = 0;
  launchDiagnosticDownload({
    action,
    environment,
    filePath,
    platform,
    resolveExecutable,
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return { unref: () => { unrefCount += 1; } };
    },
  });
  return { calls, unrefCount };
}

test("browser diagnostics pins macOS open and scopes its environment", () => {
  const environment = {
    HOME: "/Users/test",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: "/tmp/test",
    SECRET_SENTINEL: "do-not-inherit",
  };
  const filePath = "/Users/test/Downloads/report.pdf";
  const opened = captureDiagnosticLaunch({ action: "open", environment, filePath, platform: "darwin" });
  const revealed = captureDiagnosticLaunch({ action: "reveal", environment, filePath, platform: "darwin" });

  assert.deepEqual(opened.calls, [{
    command: "/usr/bin/open",
    args: [filePath],
    options: {
      detached: true,
      stdio: "ignore",
      env: { HOME: "/Users/test", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TMPDIR: "/tmp/test" },
    },
  }]);
  assert.deepEqual(revealed.calls[0].args, ["-R", filePath]);
  assert.equal(opened.unrefCount, 1);
  assert.equal(revealed.unrefCount, 1);
});

test("browser diagnostics pins Windows open and reveal commands", () => {
  const environment = {
    SystemRoot: "D:\\Windows",
    WINDIR: "D:\\Windows",
    COMSPEC: "D:\\Attacker\\cmd.exe",
    USERPROFILE: "C:\\Users\\test",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    SECRET_SENTINEL: "do-not-inherit",
  };
  const filePath = "C:\\Users\\test\\Downloads\\report & budget|draft^100%.pdf";
  const opened = captureDiagnosticLaunch({ action: "open", environment, filePath, platform: "win32" });
  const revealed = captureDiagnosticLaunch({ action: "reveal", environment, filePath, platform: "win32" });
  const expectedEnvironment = {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    USERPROFILE: "C:\\Users\\test",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
  };

  assert.deepEqual(opened.calls, [{
    command: "C:\\Windows\\explorer.exe",
    args: [filePath],
    options: { detached: true, stdio: "ignore", env: expectedEnvironment },
  }]);
  assert.deepEqual(revealed.calls, [{
    command: "C:\\Windows\\explorer.exe",
    args: ["/select,", filePath],
    options: { detached: true, stdio: "ignore", env: expectedEnvironment },
  }]);
});

test("browser diagnostics resolves Linux xdg-open only from fixed roots", () => {
  const lookups = [];
  const environment = {
    HOME: "/home/test",
    LANG: "en_US.UTF-8",
    DISPLAY: ":0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    PATH: "/tmp/attacker-bin",
    SECRET_SENTINEL: "do-not-inherit",
  };
  const filePath = "/home/test/Downloads/report.pdf";
  const resolveExecutable = (command, options) => {
    lookups.push({ command, options });
    return "/usr/bin/xdg-open";
  };
  const opened = captureDiagnosticLaunch({ action: "open", environment, filePath, platform: "linux", resolveExecutable });
  const revealed = captureDiagnosticLaunch({ action: "reveal", environment, filePath, platform: "linux", resolveExecutable });

  assert.deepEqual(lookups, [
    { command: "xdg-open", options: { searchPath: ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter) } },
    { command: "xdg-open", options: { searchPath: ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter) } },
  ]);
  assert.deepEqual(opened.calls, [{
    command: "/usr/bin/xdg-open",
    args: [filePath],
    options: {
      detached: true,
      stdio: "ignore",
      env: {
        HOME: "/home/test",
        PATH: ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter),
        LANG: "en_US.UTF-8",
        DISPLAY: ":0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
    },
  }]);
  assert.deepEqual(revealed.calls[0].args, [path.dirname(filePath)]);
});

test("browser diagnostics host service owns status, diagnostics, and download routes", () => {
  const service = createService();
  const routes = new Map(service.browserDiagnosticsRoutes.map((route) => [`${route.method} ${route.path}`, route]));

  assert.equal(typeof routes.get("GET /status")?.handler, "function");
  assert.equal(typeof routes.get("GET /workspace/inspect")?.handler, "function");
  assert.equal(typeof routes.get("GET /browser/downloads")?.handler, "function");
  assert.equal(typeof routes.get("GET /browser/launch-diagnostics")?.handler, "function");
  assert.equal(typeof routes.get("POST /browser/downloads/action")?.handler, "function");
  assert.equal(typeof routes.get("POST /diagnostics/report")?.handler, "function");
  assert.equal(routes.get("POST /browser/downloads/action")?.requiredCapability, "browser-download-action");
  assert.equal(routes.get("POST /diagnostics/report")?.requiredCapability, "diagnostics-report-export");
});

test("browser diagnostics host service aggregates system status without exposing secrets", async () => {
  const service = createService();
  const status = await service.executeSystemStatus();

  assert.equal(status.bridge, "resonantos-browser-first");
  assert.deepEqual(status.providers, {
    "shared-minimax": true,
    "shared-zai-glm": false,
    "shared-openai": false,
  });
  assert.deepEqual(status.memory, { exists: true });
  assert.deepEqual(status.addons, [{ id: "living-archive" }]);
  assert.deepEqual(status.records, { goals: 2, delegations: 3 });
});

test("browser diagnostics host service inspects workspace stack metadata without delegated execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-workspace-inspect-"));
  const repoRoot = path.join(root, "repo");
  const extensionRoot = path.join(repoRoot, "browser-first", "resonantos-side-panel-extension");
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
      name: "stack-test",
      version: "2.0.0-alpha",
      packageManager: "npm@10.0.0",
      dependencies: { react: "^19.0.0", vite: "^6.0.0" },
      devDependencies: { typescript: "^5.0.0", vitest: "^4.0.0" }
    }, null, 2));
    await writeFile(path.join(repoRoot, "package-lock.json"), "{}\n");
    await writeFile(path.join(repoRoot, "src", "App.tsx"), "export const App = () => null;\n");
    await writeFile(path.join(repoRoot, "src", "main.ts"), "import './App';\n");
    await writeFile(path.join(extensionRoot, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.1.0" }));

    const service = createService({
      repoRoot,
      resonantExtension: extensionRoot,
      redactPathForDiagnostics: (value) => String(value ?? "").replace(root, "~")
    });
    const report = await service.executeWorkspaceInspection();

    assert.equal(report.project.name, "stack-test");
    assert.ok(report.languages.some((entry) => entry.label === "TypeScript/React"));
    assert.ok(report.frameworks.some((entry) => entry.label === "React"));
    assert.ok(report.frameworks.some((entry) => entry.label === "Vite"));
    assert.ok(report.frameworks.some((entry) => entry.label === "Chrome Extension MV3"));
    assert.ok(report.runtimes.some((entry) => entry.label === "Node.js"));
    assert.ok(report.runtimes.some((entry) => entry.label === "Chromium extension runtime"));
    assert.ok(report.packageManagers.some((entry) => entry.label === "npm"));
    assert.match(report.project.root.replace(/\\/g, "/"), /^~\/repo$/);
    assert.match(report.boundary, /Read-only metadata inspection/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser diagnostics host service fails fast when a dependency is missing", () => {
  assert.throws(
    () => createService({ executeMemoryStatus: null }),
    /Browser diagnostics host service missing dependency: executeMemoryStatus/,
  );
});
