import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createAddonDelegationService,
  OPENCODE_EXPLICIT_PROVIDER_ENV_KEYS,
} from "../../../browser-first/host/addon-delegation-service.mjs";
import {
  generateCa,
  generateLeaf,
  getCertSans,
  resolveOpenSslPath,
  runOpenSsl,
} from "../../../browser-first/host/bridge-tls.mjs";
import { launchDiagnosticDownload } from "../../../browser-first/host/browser-diagnostics-service.mjs";
import {
  executableCandidates,
  resolveWindowsSystemRoot,
  TRUSTED_WINDOWS_SYSTEM_ROOT,
} from "../../../browser-first/host/browser-first-host-utils.mjs";
import * as hostUtils from "../../../browser-first/host/browser-first-host-utils.mjs";
import * as hermesRuntime from "../../../browser-first/host/hermes-runtime.mjs";
import { createMemorySourceSettingsService } from "../../../browser-first/host/memory-source-settings-service.mjs";
import { opencodeRuntimeDiagnostics } from "../../../browser-first/host/opencode-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const REGISTRY_PATH = path.join(REPO_ROOT, ".github", "security-pipeline", "checks.yml");
const RUNNER_PATH = path.join(REPO_ROOT, "scripts", "security-pipeline", "run-check.mjs");
const RECORD_SET = "browser-first-production-spawns";
const LINUX_PICKER_SEARCH_PATH = ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter);
const HERMES_PROVIDERS = [
  ["anthropic", "claude-sonnet-4"],
  ["deepseek", "deepseek-chat"],
  ["gemini", "gemini-2.5-pro"],
  ["minimax", "MiniMax-M3"],
  ["openai-api", "gpt-5.4-mini"],
  ["openrouter", "openai/gpt-5.4-mini"],
  ["xai", "grok-4"],
  ["zai", "glm-4.5"],
];
const OPENCODE_PROVIDERS = [
  ["anthropic/claude-sonnet-4", ["ANTHROPIC_API_KEY"]],
  ["deepseek/deepseek-chat", ["DEEPSEEK_API_KEY"]],
  ["gemini/gemini-2.5-pro", ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"]],
  ["google/gemini-2.5-pro", ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]],
  ["glm/glm-4.5", ["GLM_API_KEY", "ZAI_API_KEY", "ZHIPUAI_API_KEY"]],
  ["minimax/MiniMax-M3", ["MINIMAX_API_KEY"]],
  ["openai/gpt-5.4-mini", ["OPENAI_API_KEY"]],
  ["openrouter/openai/gpt-5.4-mini", ["OPENROUTER_API_KEY"]],
  ["xai/grok-4", ["XAI_API_KEY"]],
  ["zai/glm-4.5", ["ZAI_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"]],
  ["zhipuai/glm-4.5", ["ZHIPUAI_API_KEY", "ZAI_API_KEY", "GLM_API_KEY"]],
];
const HERMES_CAPTURE_ENVIRONMENT = {
  HOME: "/Users/reviewer",
  PATH: "/usr/bin:/bin",
  SHELL: "/bin/zsh",
  TERM: "xterm-256color",
  TMPDIR: "/tmp/reviewer",
  TEMP: "/tmp/reviewer",
  TMP: "/tmp/reviewer",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  XDG_CONFIG_HOME: "/Users/reviewer/.config",
  XDG_DATA_HOME: "/Users/reviewer/.local/share",
  XDG_CACHE_HOME: "/Users/reviewer/.cache",
  OPENAI_BASE_URL: "https://provider.example/v1",
  HERMES_CONFIG: "/Users/reviewer/.config/hermes/config.json",
  ANTHROPIC_API_KEY: "secret-anthropic",
  DEEPSEEK_API_KEY: "secret-deepseek",
  GEMINI_API_KEY: "secret-gemini",
  GOOGLE_GENERATIVE_AI_API_KEY: "secret-google-generative-ai",
  GOOGLE_API_KEY: "secret-google",
  MINIMAX_API_KEY: "secret-minimax",
  OPENAI_API_KEY: "secret-openai",
  OPENROUTER_API_KEY: "secret-openrouter",
  XAI_API_KEY: "secret-xai",
  ZAI_API_KEY: "secret-zai",
  GLM_API_KEY: "secret-glm",
  ZHIPUAI_API_KEY: "secret-zhipuai",
  RESONANTOS_BRIDGE_PUBLIC_URL: "http://dashboard.review.example:47773",
  SECRET_SENTINEL: "must-not-reach-child",
};

const EXPECTED_OPERATION_IDS = [
  "addon-delegation:hermes-python-adapter",
  "addon-delegation:opencode-cli",
  "addon-delegation:hermes-dashboard-start",
  "addon-delegation:hermes-dashboard-stop",
  "memory-source-browse:macos-picker",
  "memory-source-browse:windows-picker",
  "memory-source-browse:zenity-picker",
  "memory-source-browse:kdialog-picker",
  "browser-diagnostics:macos-open",
  "browser-diagnostics:macos-reveal",
  "browser-diagnostics:windows-open",
  "browser-diagnostics:windows-reveal",
  "browser-diagnostics:linux-open",
  "browser-diagnostics:linux-reveal",
  "bridge-tls:generate-ca",
  "bridge-tls:generate-leaf",
  "bridge-tls:sign-leaf",
  "bridge-tls:inspect-sans",
];

const EXPECTED_SOURCE_PATHS = [
  "browser-first/host/addon-delegation-service.mjs",
  "browser-first/host/hermes-runtime.mjs",
  "browser-first/host/browser-first-host-utils.mjs",
  "browser-first/host/browser-diagnostics-service.mjs",
  "browser-first/host/memory-source-settings-service.mjs",
  "browser-first/host/opencode-runtime.mjs",
  "browser-first/host/bridge-tls.mjs",
];

const { hermesRuntimeDiagnostics } = hermesRuntime;

async function readRegistry() {
  return JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
}

async function withEnvironment(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function createRuntimeFixture(root) {
  const canonicalRoot = await realpath(root);
  const hermesHome = path.join(canonicalRoot, ".hermes");
  const hermesBin = path.join(hermesHome, "hermes-agent", "venv", "bin");
  const hermesExecutable = path.join(hermesBin, "hermes");
  const opencodeBin = path.join(canonicalRoot, ".opencode", "bin");
  const opencodeExecutable = path.join(opencodeBin, "opencode");
  await Promise.all([
    mkdir(hermesBin, { recursive: true }),
    mkdir(opencodeBin, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(hermesExecutable, "#!/bin/sh\n"),
    writeFile(path.join(hermesBin, "python"), "#!/bin/sh\n"),
    writeFile(path.join(hermesHome, "hermes-agent", "run_agent.py"), ""),
    writeFile(opencodeExecutable, "#!/bin/sh\n"),
  ]);
  await Promise.all([
    chmod(hermesExecutable, 0o755),
    chmod(path.join(hermesBin, "python"), 0o755),
    chmod(opencodeExecutable, 0o755),
  ]);
  const hermes = hermesRuntimeDiagnostics({
    env: { HERMES_COMMAND: hermesExecutable, PATH: path.join(canonicalRoot, "attacker-bin") },
    homeDir: canonicalRoot,
    platform: process.platform,
  });
  assert.equal(typeof hermesRuntime.hermesPythonRuntimeDiagnostics, "function");
  const hermesPython = hermesRuntime.hermesPythonRuntimeDiagnostics(hermes.command, {
    env: { HERMES_COMMAND: hermesExecutable, PATH: path.join(canonicalRoot, "attacker-bin") },
    homeDir: canonicalRoot,
    platform: process.platform,
  });
  const opencode = opencodeRuntimeDiagnostics({
    env: { OPENCODE_COMMAND: opencodeExecutable, PATH: path.join(canonicalRoot, "attacker-bin") },
    homeDir: canonicalRoot,
    platform: process.platform,
  });
  assert.equal(hermes.command, hermesExecutable);
  assert.equal(hermes.overrideAccepted, true);
  assert.equal(hermesPython.installed, true);
  assert.equal(opencode.command, opencodeExecutable);
  assert.equal(opencode.overrideAccepted, true);
  return { hermes, hermesHome, hermesPython, opencode, root: canonicalRoot };
}

function dashboardCaptureService(root, calls, runtime) {
  let socketChecks = 0;
  return createAddonDelegationService({
    browserFirstRoot: () => path.join(root, "BrowserFirst"),
    bridgePublicUrl: "http://127.0.0.1:47773",
    dashboardTarget: () => ({ host: "127.0.0.1", port: 9119, url: "http://127.0.0.1:9119" }),
    execFileStdout: async () => "",
    expandUserPath: (value) => path.resolve(root, String(value ?? "")),
    firstExistingExecutable: () => null,
    hermesCommand: () => runtime.hermes.command,
    hermesHome: () => runtime.hermesHome,
    hermesPythonRuntime: () => runtime.hermesPython,
    listFilesRecursive: async () => [],
    memoryRoot: () => path.join(root, "Memory"),
    opencodeCommand: () => null,
    opencodeRuntimeDiagnostics: () => ({ installed: false, command: null }),
    redactPathForDiagnostics: String,
    readProviderSecrets: async () => ({}),
    repoRoot: root,
    safeFileSlug: (value) => String(value ?? "item"),
    socketOpen: async () => {
      socketChecks += 1;
      return socketChecks > 1;
    },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => undefined;
      if (args.includes("--stop")) {
        queueMicrotask(() => child.emit("exit", 0));
      }
      return child;
    },
    uniqueRuntimeId: (prefix) => `${prefix}-registry-test`,
    userRoot: () => root,
  });
}

function delegatedCliCaptureService(root, calls, runtime) {
  return createAddonDelegationService({
    browserFirstRoot: () => path.join(root, "BrowserFirst"),
    bridgePublicUrl: "http://127.0.0.1:47773",
    dashboardTarget: () => ({ host: "127.0.0.1", port: 9119, url: "http://127.0.0.1:9119" }),
    execFileStdout: async () => "",
    expandUserPath: (value) => path.resolve(root, String(value ?? "")),
    firstExistingExecutable: () => null,
    hermesCommand: () => runtime.hermes.command,
    hermesHome: () => runtime.hermesHome,
    hermesPythonRuntime: () => runtime.hermesPython,
    listFilesRecursive: async () => [],
    memoryRoot: () => path.join(root, "Memory"),
    opencodeCommand: () => runtime.opencode.command,
    opencodeRuntimeDiagnostics: () => runtime.opencode,
    redactPathForDiagnostics: String,
    readProviderSecrets: async () => ({}),
    repoRoot: root,
    safeFileSlug: (value) => String(value ?? "item")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item",
    socketOpen: async () => true,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      queueMicrotask(() => child.emit("error", new Error("registry capture complete")));
      return child;
    },
    uniqueRuntimeId: (prefix) => `${prefix}-registry-${calls.length + 1}`,
    userRoot: () => root,
  });
}

function normalizeTempArg(value, basename) {
  assert.equal(path.basename(value), basename);
  return `/tmp/${basename}`;
}

function normalizeRootPath(value, root) {
  assert.ok(String(value).startsWith(root), `${value} must be inside ${root}`);
  return path.posix.join("<home>", path.relative(root, String(value)).split(path.sep).join("/"));
}

function normalizedResolution(resolution, root, overrides = {}) {
  assert.ok(resolution);
  return {
    ...resolution,
    path: normalizeRootPath(resolution.path, root),
    ...(resolution.canonical_path
      ? { canonical_path: normalizeRootPath(resolution.canonical_path, root) }
      : {}),
    ...(resolution.derived_from
      ? { derived_from: normalizeRootPath(resolution.derived_from, root) }
      : {}),
    ...(resolution.installation_root
      ? { installation_root: normalizeRootPath(resolution.installation_root, root) }
      : {}),
    ...overrides,
  };
}

function normalizeDashboardDescriptor(calls, actualArgs, normalizedArgs, runtime, root) {
  const matching = calls.filter((call) => isDeepStrictEqual(call.args, actualArgs));
  assert.equal(matching.length, HERMES_PROVIDERS.length);
  assert.ok(matching.every(({ command }) => command === runtime.hermes.command));
  assert.ok(matching.every(({ options }) => !("SECRET_SENTINEL" in options.env)));
  assert.ok(matching.every(({ options }) => options.shell === false));
  return {
    command: normalizeRootPath(runtime.hermes.command, root),
    args: normalizedArgs ?? actualArgs,
    envClear: true,
    envKeys: [...new Set(matching.flatMap(({ options }) => Object.keys(options.env)))].sort(),
    resolution: normalizedResolution(runtime.hermes.resolution, root),
    candidates: null,
    shell: false,
  };
}

function registryDescriptor(record) {
  return {
    command: record.program,
    args: record.args,
    envClear: record.env_clear,
    envKeys: [...record.env_vars].sort(),
    resolution: record.resolution ?? null,
    candidates: record.candidates ?? null,
    shell: record.shell,
  };
}

function capturedDescriptor(call, { command = call.command, resolution = null, candidates = null } = {}) {
  assert.ok(call.options.env);
  assert.ok(!("SECRET_SENTINEL" in call.options.env));
  return {
    command,
    args: call.args,
    envClear: true,
    envKeys: Object.keys(call.options.env).sort(),
    resolution,
    candidates,
    shell: Boolean(call.options.shell),
  };
}

async function captureMemoryPicker({
  environment,
  platform,
  resolvedCommand,
  windowsPowerShellOptions,
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `runtime-registry-memory-${platform}-`));
  const calls = [];
  const lookups = [];
  const windowsPowerShellResolutions = [];
  const service = createMemorySourceSettingsService({
    memoryRoot: () => root,
    userRoot: () => root,
    memorySettingsPath: () => path.join(root, "settings.json"),
    memorySourceAuditPath: () => path.join(root, "audit.jsonl"),
    countFiles: async () => 0,
    pathSummary: async () => ({ exists: false }),
    listFilesRecursive: async () => [],
    expandUserPath: (value) => path.resolve(String(value ?? "")),
    stableMemorySourceId: () => "source-registry-test",
    redactPathForDiagnostics: String,
    redactDiagnosticText: String,
    execFileStdout: async (command, args, options) => {
      calls.push({ command, args, options });
      return root;
    },
    firstExistingExecutable: (command, options) => {
      lookups.push({ command, options });
      if (command === "zenity" && resolvedCommand?.endsWith("zenity")) return resolvedCommand;
      if (command === "kdialog" && resolvedCommand?.endsWith("kdialog")) return resolvedCommand;
      if (command === "powershell" && resolvedCommand) return resolvedCommand;
      return null;
    },
    isInsidePath: () => true,
    executeAddonsStatus: async () => ({}),
    environment,
    platform,
    windowsPowerShellDiagnostics: () => {
      assert.equal(typeof hostUtils.windowsPowerShellDiagnostics, "function");
      const diagnostics = hostUtils.windowsPowerShellDiagnostics(windowsPowerShellOptions);
      windowsPowerShellResolutions.push(diagnostics);
      return diagnostics;
    },
  });
  try {
    await service.executeMemorySourceBrowse();
    assert.equal(calls.length, 1);
    return { call: calls[0], lookups, windowsPowerShellResolutions };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function captureDiagnostic({ action, environment, filePath, platform, resolvedCommand }) {
  const calls = [];
  const lookups = [];
  launchDiagnosticDownload({
    action,
    environment,
    filePath,
    platform,
    resolveExecutable(command, options) {
      lookups.push({ command, options });
      return resolvedCommand;
    },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return { unref: () => undefined };
    },
  });
  assert.equal(calls.length, 1);
  return { call: calls[0], lookups };
}

function openSslCandidatesFromProduction() {
  const candidates = [];
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.throws(() => resolveOpenSslPath({
      platform,
      exists(candidate) {
        candidates.push(candidate);
        return false;
      },
    }), /OpenSSL was not found/);
  }
  return [...new Set(candidates)].map((candidatePath) => ({ base: "system-bin", path: candidatePath }));
}

function normalizeTlsArgs(args, root) {
  return args.map((arg, index) => {
    if (index > 0 && args[index - 1] === "-set_serial") return "<serial>";
    if (String(arg).startsWith(root)) {
      return path.posix.join("/user/BridgeTLS", path.relative(root, String(arg)).split(path.sep).join("/"));
    }
    if (path.basename(String(arg)).startsWith("resonantos-cert-")) return "/tmp/resonantos-cert.pem";
    return arg;
  });
}

test("Hermes dashboard registry descriptors match captured production start and stop invocations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-registry-dashboard-"));
  const calls = [];
  try {
    const runtime = await createRuntimeFixture(root);
    await withEnvironment(HERMES_CAPTURE_ENVIRONMENT, async () => {
      for (const [provider, model] of HERMES_PROVIDERS) {
        const service = dashboardCaptureService(runtime.root, calls, runtime);
        await service.executeHermesDashboardStart({ provider, model });
        await service.executeHermesDashboardStop({ provider, model });
      }
    });

    const registry = await readRegistry();
    const records = new Map(registry.recordSets[RECORD_SET].map((record) => [record.id, record]));
    const capturedStartArgs = [
      "dashboard",
      "--host",
      "dashboard.review.example",
      "--port",
      "9119",
      "--no-open",
      "--tui",
    ];
    const normalizedStartArgs = capturedStartArgs.with(2, "<clientReachableHost>");
    const stopArgs = ["dashboard", "--stop"];
    assert.deepEqual(
      registryDescriptor(records.get("addon-delegation:hermes-dashboard-start")),
      normalizeDashboardDescriptor(calls, capturedStartArgs, normalizedStartArgs, runtime, runtime.root),
    );
    assert.deepEqual(
      registryDescriptor(records.get("addon-delegation:hermes-dashboard-stop")),
      normalizeDashboardDescriptor(calls, stopArgs, stopArgs, runtime, runtime.root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delegated CLI registry descriptors match captured production invocations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-registry-addon-cli-"));
  const calls = [];
  try {
    const runtime = await createRuntimeFixture(root);
    const service = delegatedCliCaptureService(runtime.root, calls, runtime);
    const cliEnvironment = {
      ...HERMES_CAPTURE_ENVIRONMENT,
      RESONANTOS_BRIDGE_PUBLIC_URL: undefined,
      RESONANTOS_HERMES_EXECUTION: "enabled",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      OPENCODE_CONFIG: "/Users/reviewer/.config/opencode/config.json",
      OPENCODE_DATA: "/Users/reviewer/.local/share/opencode",
      OPENCODE_CACHE: "/Users/reviewer/.cache/opencode",
      OPENCODE_SERVER_USERNAME: "reviewer",
      OPENCODE_SERVER_PASSWORD: "secret-opencode-server-password",
      RESONANTOS_OPENCODE_PROVIDER_ENV: OPENCODE_EXPLICIT_PROVIDER_ENV_KEYS.join(","),
      ...Object.fromEntries(OPENCODE_EXPLICIT_PROVIDER_ENV_KEYS.map((key) => [
        key,
        `https://${key.toLowerCase().replaceAll("_", "-")}.review.example/v1`,
      ])),
    };
    await withEnvironment(cliEnvironment, async () => {
      for (const [provider, model] of HERMES_PROVIDERS) {
        const created = await service.executeDelegationRecord({
          target: "hermes",
          mission: `Capture the ${provider} Hermes adapter invocation.`,
        });
        await service.executeHermesDelegationStart({ path: created.path, provider, model });
      }
      for (const [model] of OPENCODE_PROVIDERS) {
        const created = await service.executeDelegationRecord({
          target: "opencode",
          mission: `Capture the ${model} OpenCode CLI invocation.`,
        });
        await service.executeOpenCodeDelegationStart({ path: created.path, model });
      }
    });

    const registry = await readRegistry();
    const records = new Map(registry.recordSets[RECORD_SET].map((record) => [record.id, record]));
    const openCodeCalls = calls.filter(({ command }) => command === runtime.opencode.command);
    assert.equal(openCodeCalls.length, OPENCODE_PROVIDERS.length, "OpenCode must use the hardened production resolver and injected spawnProcess dependency");
    for (const [index, [model, providerKeys]] of OPENCODE_PROVIDERS.entries()) {
      const call = openCodeCalls[index];
      assert.equal(call.options.shell, false);
      assert.ok(call.args.includes(model));
      const envKeys = Object.keys(call.options.env);
      assert.ok(providerKeys.every((key) => envKeys.includes(key)));
      assert.ok(OPENCODE_EXPLICIT_PROVIDER_ENV_KEYS.every((key) => envKeys.includes(key)));
      assert.ok(!envKeys.includes("SECRET_SENTINEL"));
    }
    const openCodeCall = openCodeCalls.find(({ args }) => args.includes("openai/gpt-5.4-mini"));
    assert.ok(openCodeCall);
    const normalizedOpenCodeArgs = [...openCodeCall.args];
    normalizedOpenCodeArgs[3] = normalizeTempArg(openCodeCall.args[3], "resonantos-opencode-task.md");
    assert.equal(openCodeCall.args[5], runtime.root);
    normalizedOpenCodeArgs[5] = "/repo";
    const normalizedOpenCode = capturedDescriptor({ ...openCodeCall, args: normalizedOpenCodeArgs }, {
      command: normalizeRootPath(runtime.opencode.command, runtime.root),
      resolution: normalizedResolution(runtime.opencode.resolution, runtime.root),
    });
    normalizedOpenCode.envKeys = [...new Set(openCodeCalls.flatMap(({ options }) => Object.keys(options.env)))].sort();
    assert.deepEqual(registryDescriptor(records.get("addon-delegation:opencode-cli")), normalizedOpenCode);

    const hermesCalls = calls.filter(({ command }) => command.endsWith(`${path.sep}python`));
    assert.equal(hermesCalls.length, HERMES_PROVIDERS.length);
    const normalizedHermesArgs = [
      normalizeTempArg(hermesCalls[0].args[0], "resonantos_hermes_adapter.py"),
      normalizeTempArg(hermesCalls[0].args[1], "resonantos-hermes-task.md"),
      normalizeTempArg(hermesCalls[0].args[2], "result.json"),
    ];
    assert.ok(hermesCalls.every(({ args }) => args.map((value) => path.basename(value)).join("|") ===
      hermesCalls[0].args.map((value) => path.basename(value)).join("|")));
    assert.ok(hermesCalls.every(({ options }) => !("SECRET_SENTINEL" in options.env)));
    const normalizedHermes = {
      command: normalizeRootPath(hermesCalls[0].command, runtime.root),
      args: normalizedHermesArgs,
      envClear: true,
      envKeys: [...new Set(hermesCalls.flatMap(({ options }) => Object.keys(options.env)))].sort(),
      resolution: normalizedResolution(runtime.hermesPython.resolution, runtime.root),
      candidates: null,
      shell: false,
    };
    assert.deepEqual(
      registryDescriptor(records.get("addon-delegation:hermes-python-adapter")),
      normalizedHermes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native picker registry descriptors match captured production invocations", async () => {
  const registry = await readRegistry();
  const records = new Map(registry.recordSets[RECORD_SET].map((record) => [record.id, record]));
  const commonUnixEnvironment = {
    HOME: "/home/user",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: "/tmp/reviewer",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XAUTHORITY: "/home/user/.Xauthority",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    SECRET_SENTINEL: "must-not-reach-child",
  };
  const linuxSearchPath = ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter);
  const linuxCandidates = (command) => executableCandidates(command, {
    platform: "linux",
    searchPath: linuxSearchPath,
  }).map((candidatePath) => ({ base: "system-bin", path: candidatePath }));

  const mac = await captureMemoryPicker({
    environment: { ...commonUnixEnvironment, HOME: "/Users/reviewer" },
    platform: "darwin",
  });
  assert.deepEqual(
    registryDescriptor(records.get("memory-source-browse:macos-picker")),
    capturedDescriptor(mac.call, {
      resolution: { base: "system-bin", path: "/usr/bin/osascript" },
    }),
  );

  const ambientWindowsSystemRoot = "D:\\Windows";
  const windowsSystemRoot = resolveWindowsSystemRoot();
  assert.equal(windowsSystemRoot, TRUSTED_WINDOWS_SYSTEM_ROOT);
  const windowsCommand = `${windowsSystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const windowsCommandShim = `${windowsSystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.cmd`;
  const windowsProbes = [];
  const windows = await captureMemoryPicker({
    environment: {
      SystemRoot: ambientWindowsSystemRoot,
      WINDIR: ambientWindowsSystemRoot,
      USERPROFILE: "C:\\Users\\reviewer",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      SECRET_SENTINEL: "must-not-reach-child",
    },
    platform: "win32",
    resolvedCommand: windowsCommandShim,
    windowsPowerShellOptions: {
      exists(candidate) {
        windowsProbes.push(candidate);
        return candidate === windowsCommand || candidate === windowsCommandShim;
      },
      realpath: (candidate) => candidate,
      stat: () => ({ isFile: () => true }),
    },
  });
  assert.deepEqual(windows.lookups, []);
  assert.deepEqual(windowsProbes, [windowsCommand]);
  assert.equal(windows.windowsPowerShellResolutions.length, 1);
  assert.equal(windows.call.command, windowsCommand);
  assert.equal(windows.call.options.shell, false);
  assert.deepEqual(
    registryDescriptor(records.get("memory-source-browse:windows-picker")),
    capturedDescriptor(windows.call, {
      command: windows.windowsPowerShellResolutions[0].command,
      resolution: windows.windowsPowerShellResolutions[0].resolution,
    }),
  );

  for (const command of ["zenity", "kdialog"]) {
    const resolvedCommand = `/usr/bin/${command}`;
    const linux = await captureMemoryPicker({
      environment: commonUnixEnvironment,
      platform: "linux",
      resolvedCommand,
    });
    const expectedLookups = command === "zenity"
      ? [{ command: "zenity", options: { searchPath: linuxSearchPath } }]
      : [
        { command: "zenity", options: { searchPath: linuxSearchPath } },
        { command: "kdialog", options: { searchPath: linuxSearchPath } },
      ];
    assert.deepEqual(linux.lookups, expectedLookups);
    assert.deepEqual(
      registryDescriptor(records.get(`memory-source-browse:${command}-picker`)),
      capturedDescriptor(linux.call, {
        candidates: linuxCandidates(command),
      }),
    );
  }
});

test("diagnostic open and reveal registry descriptors match captured production invocations", async () => {
  const registry = await readRegistry();
  const records = new Map(registry.recordSets[RECORD_SET].map((record) => [record.id, record]));
  const macEnvironment = {
    HOME: "/Users/reviewer",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: "/tmp/reviewer",
    SECRET_SENTINEL: "must-not-reach-child",
  };
  const linuxEnvironment = {
    HOME: "/home/reviewer",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: "/tmp/reviewer",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XAUTHORITY: "/home/reviewer/.Xauthority",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    SECRET_SENTINEL: "must-not-reach-child",
  };
  const windowsEnvironment = {
    SystemRoot: "D:\\Windows",
    WINDIR: "D:\\Windows",
    USERPROFILE: "C:\\Users\\reviewer",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    SECRET_SENTINEL: "must-not-reach-child",
  };
  const cases = [
    {
      id: "browser-diagnostics:macos-open",
      action: "open",
      environment: macEnvironment,
      filePath: "/Users/reviewer/Downloads/report.pdf",
      platform: "darwin",
      resolution: { base: "system-bin", path: "/usr/bin/open" },
    },
    {
      id: "browser-diagnostics:macos-reveal",
      action: "reveal",
      environment: macEnvironment,
      filePath: "/Users/reviewer/Downloads/report.pdf",
      platform: "darwin",
      resolution: { base: "system-bin", path: "/usr/bin/open" },
    },
    {
      id: "browser-diagnostics:windows-open",
      action: "open",
      command: `${TRUSTED_WINDOWS_SYSTEM_ROOT}\\explorer.exe`,
      environment: windowsEnvironment,
      filePath: "C:\\Users\\reviewer\\Downloads\\report & budget|draft^100%.pdf",
      platform: "win32",
      resolution: {
        base: "absolute",
        path: `${TRUSTED_WINDOWS_SYSTEM_ROOT}\\explorer.exe`,
        validated_by: "fixedWindowsSystemRootPolicy",
        source: "fixed-windows-system-root",
      },
    },
    {
      id: "browser-diagnostics:windows-reveal",
      action: "reveal",
      command: `${TRUSTED_WINDOWS_SYSTEM_ROOT}\\explorer.exe`,
      environment: windowsEnvironment,
      filePath: "C:\\Users\\reviewer\\Downloads\\report.pdf",
      platform: "win32",
      resolution: {
        base: "absolute",
        path: `${TRUSTED_WINDOWS_SYSTEM_ROOT}\\explorer.exe`,
        validated_by: "fixedWindowsSystemRootPolicy",
        source: "fixed-windows-system-root",
      },
    },
    {
      id: "browser-diagnostics:linux-open",
      action: "open",
      environment: linuxEnvironment,
      filePath: "/home/reviewer/Downloads/report.pdf",
      platform: "linux",
      resolvedCommand: "/usr/bin/xdg-open",
    },
    {
      id: "browser-diagnostics:linux-reveal",
      action: "reveal",
      environment: linuxEnvironment,
      filePath: "/home/reviewer/Downloads/report.pdf",
      platform: "linux",
      resolvedCommand: "/usr/bin/xdg-open",
    },
  ];
  const linuxCandidates = executableCandidates("xdg-open", {
    platform: "linux",
    searchPath: ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter),
  }).map((candidatePath) => ({ base: "system-bin", path: candidatePath }));

  for (const fixture of cases) {
    const captured = captureDiagnostic(fixture);
    if (fixture.platform === "linux") {
      assert.deepEqual(captured.lookups, [{
        command: "xdg-open",
        options: { searchPath: ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter) },
      }]);
    }
    assert.deepEqual(
      registryDescriptor(records.get(fixture.id)),
      capturedDescriptor(captured.call, {
        command: fixture.command ?? captured.call.command,
        resolution: fixture.resolution ?? null,
        candidates: fixture.platform === "linux" ? linuxCandidates : null,
      }),
    );
  }
});

test("bridge TLS registry descriptors match captured production OpenSSL invocations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-registry-tls-"));
  const calls = [];
  const environment = {
    HOME: "/home/reviewer",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: "/tmp/reviewer",
    SECRET_SENTINEL: "must-not-reach-child",
  };
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(async () => {
      try {
        for (const flag of ["-keyout", "-out"]) {
          const flagIndex = args.indexOf(flag);
          const target = flagIndex >= 0 ? args[flagIndex + 1] : null;
          if (target) await writeFile(target, `fixture for ${flag}`);
        }
        if (args.includes("subjectAltName")) {
          child.stdout.emit("data", "X509v3 Subject Alternative Name:\n    DNS:localhost, IP Address:127.0.0.1\n");
        }
        child.emit("close", 0);
      } catch (error) {
        child.emit("error", error);
      }
    });
    return child;
  };
  const runOpenSslImpl = (args) => runOpenSsl(args, {
    environment,
    exists: (candidate) => candidate === "/usr/bin/openssl",
    platform: "linux",
    spawnImpl,
  });

  try {
    const ca = await generateCa({ dir: root, runOpenSslImpl });
    const leaf = await generateLeaf({
      dir: root,
      caKeyPath: ca.caKey,
      caCrtPath: ca.caCrt,
      sans: ["localhost", "127.0.0.1"],
      runOpenSslImpl,
    });
    const sans = await getCertSans(await readFile(leaf.bridgeCrt), { runOpenSslImpl });
    assert.deepEqual(sans, ["localhost", "127.0.0.1"]);
    assert.equal(calls.length, 4, "TLS operations must use the injected runOpenSsl implementation");

    const registry = await readRegistry();
    const records = new Map(registry.recordSets[RECORD_SET].map((record) => [record.id, record]));
    const candidates = openSslCandidatesFromProduction();
    const operationCalls = new Map([
      ["bridge-tls:generate-ca", calls.find(({ args }) => args[0] === "req" && args.includes("-x509"))],
      ["bridge-tls:generate-leaf", calls.find(({ args }) => args[0] === "req" && !args.includes("-x509"))],
      ["bridge-tls:sign-leaf", calls.find(({ args }) => args[0] === "x509" && args.includes("-req"))],
      ["bridge-tls:inspect-sans", calls.find(({ args }) => args.includes("subjectAltName"))],
    ]);
    for (const [id, call] of operationCalls) {
      assert.ok(call, `missing captured call for ${id}`);
      assert.deepEqual(
        registryDescriptor(records.get(id)),
        capturedDescriptor({ ...call, args: normalizeTlsArgs(call.args, root) }, {
          candidates,
        }),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active runtime-hardening checks share production-derived spawn records", async () => {
  const registry = await readRegistry();
  const runtimeChecks = registry.checks.filter((check) =>
    check.family === "runtime-hardening" && check.policy !== "disabled"
  );
  assert.equal(registry.families["runtime-hardening"].status, "active");
  assert.equal(runtimeChecks.length, 4);
  for (const check of runtimeChecks) {
    assert.deepEqual(check.recordSets, [RECORD_SET], `${check.id} must use the production record set`);
  }

  const records = registry.recordSets?.[RECORD_SET];
  assert.ok(Array.isArray(records) && records.length > 0, "production record set must not be empty");
  assert.deepEqual(records.map((record) => record.id), EXPECTED_OPERATION_IDS);

  for (const command of ["zenity", "kdialog"]) {
    const record = records.find(({ id }) => id === `memory-source-browse:${command}-picker`);
    const expectedCandidates = executableCandidates(command, {
      platform: "linux",
      searchPath: LINUX_PICKER_SEARCH_PATH,
    });
    assert.equal(record.program, expectedCandidates[0]);
    assert.equal(record.resolution, undefined);
    assert.deepEqual(
      record.candidates.map(({ path: candidatePath }) => candidatePath),
      expectedCandidates,
    );
  }

  for (const id of [
    "bridge-tls:generate-ca",
    "bridge-tls:generate-leaf",
    "bridge-tls:sign-leaf",
    "bridge-tls:inspect-sans",
  ]) {
    const record = records.find((candidate) => candidate.id === id);
    assert.equal(record.program, resolveOpenSslPath({
      platform: "linux",
      exists: (candidate) => candidate === "/usr/bin/openssl",
    }));
    assert.equal(record.resolution, undefined);
    assert.deepEqual(record.candidates, openSslCandidatesFromProduction());
  }

  const windowsPowerShellRecord = records.find(({ id }) => id === "memory-source-browse:windows-picker");
  assert.equal(windowsPowerShellRecord.resolution.base, "absolute");
  assert.equal(windowsPowerShellRecord.resolution.validated_by, "windowsPowerShellDiagnostics");
  assert.equal(windowsPowerShellRecord.resolution.source, "fixed-windows-system-root");
  assert.equal(windowsPowerShellRecord.program, windowsPowerShellRecord.resolution.canonical_path);
  assert.ok(windowsPowerShellRecord.sources.some(({ path: sourcePath, anchor }) =>
    sourcePath === "browser-first/host/browser-first-host-utils.mjs" &&
    anchor === "export function windowsPowerShellDiagnostics"
  ));

  const windowsRecords = [
    records.find(({ id }) => id === "browser-diagnostics:windows-open"),
    records.find(({ id }) => id === "browser-diagnostics:windows-reveal"),
  ];
  for (const record of windowsRecords) {
    assert.equal(record.resolution.base, "absolute");
    assert.equal(record.resolution.validated_by, "fixedWindowsSystemRootPolicy");
    assert.equal(record.resolution.source, "fixed-windows-system-root");
    assert.ok(record.sources.some(({ path: sourcePath, anchor }) =>
      sourcePath === "browser-first/host/browser-first-host-utils.mjs" &&
      anchor === "export const TRUSTED_WINDOWS_SYSTEM_ROOT"
    ));
  }
  for (const id of ["browser-diagnostics:windows-open", "browser-diagnostics:windows-reveal"]) {
    const record = records.find((candidate) => candidate.id === id);
    assert.equal(record.program, record.resolution.path);
    assert.doesNotMatch(JSON.stringify(record.args), /(?:^|\W)(?:cmd\.exe|start)(?:\W|$)/i);
  }

  const sourcePaths = new Set();
  for (const record of records) {
    assert.equal(record.shell, false, `${record.id} must record direct, non-shell invocation`);
    assert.ok(Array.isArray(record.sources) && record.sources.length > 0, `${record.id} must cite production source`);
    for (const source of record.sources) {
      sourcePaths.add(source.path);
      const sourceText = await readFile(path.join(REPO_ROOT, source.path), "utf8");
      assert.ok(sourceText.includes(source.anchor), `${record.id} source anchor drifted: ${source.anchor}`);
    }
  }
  assert.deepEqual([...sourcePaths].sort(), EXPECTED_SOURCE_PATHS.sort());
});

test("production runtime-hardening records pass strict certification", () => {
  const result = spawnSync(
    process.execPath,
    [RUNNER_PATH, "--family", "runtime-hardening", "--certify"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const results = result.stdout.trim().split(/\n(?=\{)/).map((document) => JSON.parse(document));
  assert.equal(results.length, 4, result.stdout);
  assert.deepEqual(results.map(({ status }) => status), ["pass", "pass", "pass", "pass"]);
});
