import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  firstExistingExecutable,
  resolveWindowsSystemRoot,
} from "./browser-first-host-utils.mjs";

const linuxOpenSearchPath = ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter);

function diagnosticLaunchEnvironment(platform, environment, windowsSystemRoot) {
  const keys = platform === "win32"
    ? ["USERPROFILE", "TEMP", "TMP"]
    : platform === "darwin"
      ? ["HOME", "LANG", "LC_ALL", "TMPDIR"]
      : [
        "HOME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
      ];
  const scopedEnvironment = Object.fromEntries(
    keys.map((key) => [key, environment[key]]).filter(([, value]) => value !== undefined),
  );
  return platform === "win32"
    ? { SystemRoot: windowsSystemRoot, WINDIR: windowsSystemRoot, ...scopedEnvironment }
    : platform === "darwin"
      ? scopedEnvironment
      : { ...scopedEnvironment, PATH: linuxOpenSearchPath };
}

export function launchDiagnosticDownload({
  action,
  environment = process.env,
  filePath,
  platform = process.platform,
  resolveExecutable = firstExistingExecutable,
  spawnImpl = spawn,
}) {
  let command;
  let args;
  const windowsSystemRoot = platform === "win32"
    ? resolveWindowsSystemRoot(environment)
    : null;
  if (platform === "darwin") {
    command = "/usr/bin/open";
    args = action === "reveal" ? ["-R", filePath] : [filePath];
  } else if (platform === "win32") {
    command = path.win32.join(windowsSystemRoot, "explorer.exe");
    if (action === "reveal") {
      args = ["/select,", filePath];
    } else {
      args = [filePath];
    }
  } else {
    command = resolveExecutable("xdg-open", { searchPath: linuxOpenSearchPath });
    if (!command) {
      throw new Error("xdg-open was not found in a trusted system installation path.");
    }
    args = [action === "reveal" ? path.dirname(filePath) : filePath];
  }

  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
    env: diagnosticLaunchEnvironment(platform, environment, windowsSystemRoot),
  });
  child.unref();
}

export function createBrowserDiagnosticsService({
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
} = {}) {
  function assertDependency(name, value) {
    if (!value) {
      throw new Error(`Browser diagnostics service missing dependency: ${name}`);
    }
  }
  for (const [name, value] of Object.entries({
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
  })) {
    assertDependency(name, value);
  }

  function diagnosticsRoot() {
    return path.join(browserFirstRoot(), "Diagnostics");
  }

  function browserDownloadsRoot() {
    return path.join(os.homedir(), "Downloads");
  }

  function browserDownloadsStatePath() {
    return path.join(browserFirstRoot(), "downloads-state.json");
  }

  async function browserDownloadsState() {
    if (!existsSync(browserDownloadsStatePath())) {
      return {};
    }
    try {
      return JSON.parse(await readFile(browserDownloadsStatePath(), "utf8"));
    } catch {
      return {};
    }
  }

  async function writeBrowserDownloadsState(state) {
    await mkdir(browserFirstRoot(), { recursive: true });
    await writeFile(browserDownloadsStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  function resolveDownloadFile(nameOrPath) {
    const root = path.resolve(browserDownloadsRoot());
    const raw = String(nameOrPath ?? "").trim();
    if (!raw) {
      throw new Error("Download action requires a file name.");
    }
    const unredacted = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
    const candidate = path.isAbsolute(unredacted)
      ? path.resolve(unredacted)
      : path.resolve(root, unredacted);
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
      throw new Error("Download action is limited to files inside the browser downloads folder.");
    }
    return candidate;
  }

  async function openOrRevealDownload(filePath, action) {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile?.()) {
      throw new Error("Download file was not found.");
    }
    launchDiagnosticDownload({ action, filePath });
  }

  async function readPackageVersion() {
    try {
      const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
      return String(pkg.version ?? "unknown");
    } catch {
      return "unknown";
    }
  }

  async function readExtensionVersion() {
    try {
      const manifest = JSON.parse(await readFile(path.join(resonantExtension, "manifest.json"), "utf8"));
      return String(manifest.version ?? "unknown");
    } catch {
      return "unknown";
    }
  }

  async function readJsonFile(filePath) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function uniqueEntries(entries) {
    const byId = new Map();
    for (const entry of entries.filter(Boolean)) {
      const id = String(entry.id ?? entry.label ?? entry.name ?? "").toLowerCase();
      if (!id || byId.has(id)) continue;
      byId.set(id, entry);
    }
    return [...byId.values()];
  }

  function packageDependencies(pkg) {
    return new Set([
      ...Object.keys(pkg?.dependencies ?? {}),
      ...Object.keys(pkg?.devDependencies ?? {}),
      ...Object.keys(pkg?.peerDependencies ?? {}),
      ...Object.keys(pkg?.optionalDependencies ?? {}),
    ]);
  }

  async function collectWorkspaceFiles(root, limit = 20_000) {
    const skipDirs = new Set([
      ".git",
      ".next",
      ".turbo",
      ".vite",
      ".cache",
      "build",
      "coverage",
      "dist",
      "node_modules",
      "target",
    ]);
    const files = [];
    async function walk(dir) {
      if (files.length >= limit) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (files.length >= limit || entry.name.startsWith(".")) continue;
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) await walk(filePath);
          continue;
        }
        if (entry.isFile()) files.push(filePath);
      }
    }
    await walk(root);
    return files;
  }

  function languageInventory(files) {
    const labels = new Map([
      [".css", "CSS"],
      [".html", "HTML"],
      [".js", "JavaScript"],
      [".jsx", "JavaScript/React"],
      [".mjs", "JavaScript"],
      [".cjs", "JavaScript"],
      [".json", "JSON"],
      [".md", "Markdown"],
      [".py", "Python"],
      [".sh", "Shell"],
      [".toml", "TOML"],
      [".ts", "TypeScript"],
      [".tsx", "TypeScript/React"],
      [".yaml", "YAML"],
      [".yml", "YAML"],
    ]);
    const counts = new Map();
    for (const filePath of files) {
      const label = labels.get(path.extname(filePath).toLowerCase());
      if (!label) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }

  function detectFrameworks({ dependencies, extensionManifest }) {
    return uniqueEntries([
      dependencies.has("react") ? { id: "react", label: "React", detail: "react dependency" } : null,
      dependencies.has("vite") ? { id: "vite", label: "Vite", detail: "vite dependency" } : null,
      dependencies.has("vitest") ? { id: "vitest", label: "Vitest", detail: "vitest dependency" } : null,
      dependencies.has("@testing-library/react") ? { id: "testing-library", label: "Testing Library", detail: "@testing-library/react dependency" } : null,
      dependencies.has("lucide-react") ? { id: "lucide-react", label: "Lucide React", detail: "lucide-react dependency" } : null,
      extensionManifest?.manifest_version === 3 ? { id: "chrome-mv3", label: "Chrome Extension MV3", detail: "extension manifest" } : null,
    ]);
  }

  function detectRuntimes({ dependencies, extensionManifest }) {
    return uniqueEntries([
      { id: "node", label: "Node.js", detail: "npm scripts and browser-first host services" },
      dependencies.has("typescript") ? { id: "typescript", label: "TypeScript compiler", detail: "typescript dependency" } : null,
      dependencies.has("vite") ? { id: "vite-dev-server", label: "Vite dev/build runtime", detail: "vite dependency" } : null,
      extensionManifest?.manifest_version === 3 ? { id: "chromium", label: "Chromium extension runtime", detail: "Manifest V3 side panel" } : null,
    ]);
  }

  function detectPackageManagers(pkg) {
    return uniqueEntries([
      existsSync(path.join(repoRoot, "package-lock.json")) || /^npm@/i.test(String(pkg?.packageManager ?? ""))
        ? { id: "npm", label: "npm", detail: "package-lock.json/package.json" }
        : null,
      existsSync(path.join(repoRoot, "pnpm-lock.yaml")) || /^pnpm@/i.test(String(pkg?.packageManager ?? ""))
        ? { id: "pnpm", label: "pnpm", detail: "pnpm lock/packageManager field" }
        : null,
      existsSync(path.join(repoRoot, "yarn.lock")) || /^yarn@/i.test(String(pkg?.packageManager ?? ""))
        ? { id: "yarn", label: "Yarn", detail: "yarn.lock/packageManager field" }
        : null,
    ]);
  }

  async function executeWorkspaceInspection() {
    const [pkg, extensionManifest, files] = await Promise.all([
      readJsonFile(path.join(repoRoot, "package.json")),
      readJsonFile(path.join(resonantExtension, "manifest.json")),
      collectWorkspaceFiles(repoRoot),
    ]);
    const dependencies = packageDependencies(pkg);
    const evidence = [
      existsSync(path.join(repoRoot, "package.json")) ? { label: "package.json", detail: "project scripts and npm dependencies" } : null,
      existsSync(path.join(repoRoot, "package-lock.json")) ? { label: "package-lock.json", detail: "npm lockfile" } : null,
      extensionManifest ? { label: "browser-first extension manifest", detail: `Manifest V${extensionManifest.manifest_version ?? "?"}` } : null,
      { label: "source file scan", detail: `${files.length} file(s) sampled outside build/vendor directories` },
    ];
    return {
      generatedAt: new Date().toISOString(),
      project: {
        name: String(pkg?.name ?? "resonantos-workspace"),
        version: String(pkg?.version ?? ""),
        packageManager: String(pkg?.packageManager ?? ""),
        root: redactPathForDiagnostics(repoRoot),
      },
      languages: languageInventory(files),
      frameworks: detectFrameworks({ dependencies, extensionManifest }),
      runtimes: detectRuntimes({ dependencies, extensionManifest }),
      packageManagers: detectPackageManagers(pkg),
      evidence: evidence.filter(Boolean),
      boundary: "Read-only metadata inspection. Provider credentials, bridge tokens, wallet secrets, private keys, and full home paths are excluded or redacted.",
    };
  }

  async function executeBrowserLaunchDiagnostics() {
    return {
      status: "not-applicable",
      releaseScope: "chrome-extension-alpha",
      detail: "Chrome extension alpha uses the local Node bridge. Packaged app launch diagnostics are not part of this release.",
    };
  }

  async function executeDiagnosticsReport() {
    const generatedAt = new Date().toISOString();
    const [statusResult, providerResult, addonResult, memoryResult, browserLaunchResult] = await Promise.allSettled([
      executeSystemStatus(),
      executeProviderStatus(),
      executeAddonsStatus(),
      executeMemoryStatus(),
      executeBrowserLaunchDiagnostics(),
    ]);
    const settledValue = (result) => result.status === "fulfilled"
      ? result.value
      : { unavailable: true, error: redactDiagnosticText(result.reason instanceof Error ? result.reason.message : result.reason) };
    const providers = settledValue(providerResult).providers ?? [];
    const addons = settledValue(addonResult).addons ?? [];
    const memory = settledValue(memoryResult);
    const report = {
      generatedAt,
      product: "ResonantOS Browser",
      version: await readPackageVersion(),
      extensionVersion: await readExtensionVersion(),
      platform: {
        os: process.platform,
        arch: process.arch,
        node: process.version,
      },
      paths: {
        userRoot: redactPathForDiagnostics(userRoot()),
        browserFirstRoot: redactPathForDiagnostics(browserFirstRoot()),
        memoryRoot: redactPathForDiagnostics(memoryRoot()),
        profileDir: redactPathForDiagnostics(profileDir),
      },
      status: settledValue(statusResult),
      providers: {
        total: providers.length,
        configured: providers.filter((provider) => provider.configured).length,
        entries: providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          configured: Boolean(provider.configured),
          models: provider.models ?? [],
          role: provider.role ?? "",
        })),
      },
      addons: {
        total: addons.length,
        available: addons.filter((addon) => addon.available || addon.enabled).length,
        entries: addons.map((addon) => ({
          id: addon.id,
          name: addon.name,
          available: Boolean(addon.available || addon.enabled),
          mode: addon.mode,
          trust: addon.trust,
        })),
      },
      memory: {
        wikiPages: memory?.wiki?.pages ?? 0,
        intakeArtifacts: memory?.intake?.artifacts ?? 0,
        reviewRequests: memory?.review?.requests ?? 0,
        reviewArtifacts: memory?.review?.artifacts ?? 0,
      },
      browserLaunch: settledValue(browserLaunchResult),
      redaction: "Provider credentials, bridge tokens, wallet secrets, private keys, and full home paths are excluded or redacted.",
    };
    const serialized = redactDiagnosticText(JSON.stringify(report, null, 2));
    await mkdir(diagnosticsRoot(), { recursive: true });
    const filePath = path.join(diagnosticsRoot(), `diagnostics-${generatedAt.replace(/[:.]/g, "-")}.json`);
    await writeFile(filePath, `${serialized}\n`, { mode: 0o600 });
    return {
      path: redactPathForDiagnostics(filePath),
      generatedAt,
      summary: {
        providers: report.providers,
        addons: report.addons,
        memory: report.memory,
        browserLaunch: report.browserLaunch,
      },
    };
  }

  async function executeBrowserDownloads() {
    const root = browserDownloadsRoot();
    const state = await browserDownloadsState();
    const clearedAtMs = Number.isFinite(Date.parse(state.clearedAt ?? ""))
      ? Date.parse(state.clearedAt)
      : 0;
    if (!existsSync(root)) {
      return {
        root: redactPathForDiagnostics(root),
        entries: [],
        total: 0,
        clearedAt: state.clearedAt ?? "",
      };
    }
    const names = await readdir(root).catch(() => []);
    const entries = [];
    for (const name of names) {
      if (!name || name.startsWith(".")) {
        continue;
      }
      const filePath = path.join(root, name);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile?.()) {
        continue;
      }
      if (clearedAtMs && fileStat.mtime.getTime() <= clearedAtMs) {
        continue;
      }
      entries.push({
        name,
        path: redactPathForDiagnostics(filePath),
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      });
    }
    entries.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
    return {
      root: redactPathForDiagnostics(root),
      entries: entries.slice(0, 20),
      total: entries.length,
      clearedAt: state.clearedAt ?? "",
    };
  }

  async function executeBrowserDownloadAction(payload = {}) {
    const action = String(payload.action ?? "").trim();
    if (action === "clear-history") {
      const clearedAt = new Date().toISOString();
      await writeBrowserDownloadsState({ clearedAt });
      return {
        action,
        clearedAt,
        message: "Download history was cleared. Files were not deleted.",
      };
    }
    if (action !== "open" && action !== "reveal") {
      throw new Error("Unsupported download action.");
    }
    const filePath = resolveDownloadFile(payload.name ?? payload.path);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile?.()) {
      throw new Error("Download file was not found.");
    }
    if (!payload.dryRun) {
      await openOrRevealDownload(filePath, action);
    }
    return {
      action,
      dryRun: Boolean(payload.dryRun),
      name: path.basename(filePath),
      path: redactPathForDiagnostics(filePath),
    };
  }

  return {
    browserDownloadsRoot,
    executeBrowserDownloadAction,
    executeBrowserDownloads,
    executeBrowserLaunchDiagnostics,
    executeDiagnosticsReport,
    executeWorkspaceInspection,
  };
}
