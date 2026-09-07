import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fsPromises from "node:fs/promises";
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAddonDelegationService } from "../host/addon-delegation-service.mjs";
import { listFilesRecursive } from "../host/browser-first-host-utils.mjs";
import {
  hermesPythonRuntimeDiagnostics,
  hermesRuntimeDiagnostics,
} from "../host/hermes-runtime.mjs";

function safeFileSlug(value) {
  return String(value ?? "item")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function providerSecretsPath() {
  return path.join(os.homedir(), "ResonantOS_User", "Secrets", "provider-secrets.json");
}

function createService(root, overrides = {}) {
  let id = 0;
  const browserFirstRoot = () => path.join(root, "BrowserFirst");
  return createAddonDelegationService({
    browserFirstRoot,
    bridgePublicUrl: "http://127.0.0.1:47773",
    dashboardTarget: () => ({ host: "127.0.0.1", port: 9119, url: "http://127.0.0.1:9119" }),
    execFileStdout: async () => {
      throw new Error("CLI execution should not run in deterministic tests.");
    },
    expandUserPath: (value) => path.resolve(root, String(value ?? "")),
    firstExistingExecutable: () => null,
    hermesCommand: overrides.hermesCommand ?? (() => null),
    hermesHome: overrides.hermesHome ?? (() => path.join(root, "HermesHome")),
    hermesPythonRuntime: overrides.hermesPythonRuntime ?? (() => null),
    listFilesRecursive: overrides.listFilesRecursive ?? (async () => []),
    memoryRoot: () => path.join(root, "Memory"),
    opencodeCommand: overrides.opencodeCommand ?? (() => null),
    opencodeRuntimeDiagnostics: overrides.opencodeRuntimeDiagnostics ?? (() => ({ installed: false, command: null })),
    ensureOpenCodeServer: overrides.ensureOpenCodeServer,
    peekOpenCodeServer: overrides.peekOpenCodeServer,
    redactPathForDiagnostics: (value) => String(value ?? "").replace(root, "<root>"),
    readProviderSecrets: overrides.readProviderSecrets ?? (async () => ({})),
    repoRoot: overrides.repoRoot ?? root,
    safeFileSlug,
    fs: overrides.fs,
    isolation: overrides.isolation,
    platform: overrides.platform,
    spawnProcess: overrides.spawnProcess,
    socketOpen: async () => false,
    uniqueRuntimeId: (prefix) => `${prefix}-test-${++id}`,
    userRoot: () => root,
  });
}

function successfulOpenCodeOutput(summary = "OpenCode isolation test completed.") {
  return [
    "## Final Summary",
    summary,
    "",
    "## Changed Files",
    "- seeded.txt",
    "",
    "## Commands Run",
    "- fake opencode run",
    "",
    "## Tests",
    "- fake child process completed.",
    "",
    "## Residual Risks",
    "- fake runtime only.",
    "",
    "## Verification",
    "- profile was inspected during fake spawn.",
  ].join("\n");
}

function successfulHermesResponse(summary = "Hermes isolation test completed.") {
  return [
    "Final Summary",
    summary,
    "",
    "Actions Taken",
    "- Ran through the injected Hermes child process.",
    "",
    "Approval Needs",
    "- None.",
    "",
    "Residual Risks",
    "- fake runtime only.",
    "",
    "Verification",
    "- profile was inspected during fake spawn.",
  ].join("\n");
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  return child;
}

async function readAuditEntries(root) {
  const auditPath = path.join(root, "BrowserFirst", "Settings", "addon-governance-audit.jsonl");
  return (await readFile(auditPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function validUninstallAuditRecord(overrides = {}) {
  return {
    actor: "human",
    addonId: "addon.hermes",
    alsoDeleteUserDataOffered: false,
    at: "2026-09-07T00:00:00.000Z",
    clearedCapabilities: ["agent-delegation", "archive-read"],
    clearedPrivateProviderProfileIds: 2,
    configDeleted: true,
    event: "addonUninstalled",
    previousEnabled: true,
    previousInstalled: true,
    previousStatus: "enabled",
    source: "bundled",
    userDataRetained: true,
    ...overrides,
  };
}

async function rewriteDelegationStatus(root, delegation, statusValue) {
  const filePath = path.join(root, delegation.path);
  const content = await readFile(filePath, "utf8");
  await writeFile(filePath, content.replace(/^- status:\s*.+$/mi, `- status: ${statusValue}`));
  return filePath;
}

async function withTempService(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ros-delegation-errors-"));
  try {
    return await fn(createService(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function blockArtifactRoot(root) {
  const browserFirstRoot = path.join(root, "BrowserFirst");
  await mkdir(browserFirstRoot, { recursive: true });
  await writeFile(path.join(browserFirstRoot, "DelegationArtifacts"), "not a directory");
}

async function assertFinalizationFailureIsTerminal(target) {
  await withTempService(async (service, root) => {
    const created = await service.executeDelegationRecord({
      target,
      mission: `Exercise ${target} finalization failure handling.`,
    });
    await blockArtifactRoot(root);

    const started = target === "hermes"
      ? await service.executeHermesDelegationStart({ path: created.path, adapter: "deterministic" })
      : await service.executeOpenCodeDelegationStart({ path: created.path, adapter: "deterministic" });

    assert.equal(started.status, "failed");
    assert.match(started.failureReason, /DelegationArtifacts|not a directory|ENOTDIR|EEXIST/i);

    const taskPacket = await readFile(path.join(root, created.path), "utf8");
    assert.match(taskPacket, /^- status:\s*failed$/mi);
    assert.doesNotMatch(taskPacket, /^- status:\s*running$/mi);
    assert.match(taskPacket, /^- failureReason:\s*.+$/mi);
  });
}

function withEnv(values = {}, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });
}

test("Hermes delegation records failed status when artifact finalization fails", async () => {
  await assertFinalizationFailureIsTerminal("hermes");
});

test("OpenCode delegation records failed status when artifact finalization fails", async () => {
  await assertFinalizationFailureIsTerminal("opencode");
});

test("add-on execution setting updates append an operator audit trail only for real toggles", async () => {
  await withTempService(async (service, root) => {
    const auditPath = path.join(root, "BrowserFirst", "Settings", "addon-governance-audit.jsonl");

    await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
    });

    const firstLines = (await readFile(auditPath, "utf8")).trim().split("\n");
    assert.equal(firstLines.length, 1);
    const first = JSON.parse(firstLines[0]);
    assert.equal(first.addonId, "opencode");
    assert.equal(first.field, "localCliExecution");
    assert.equal(first.from, false);
    assert.equal(first.to, true);
    assert.doesNotThrow(() => new Date(first.at).toISOString());
    assert.equal((await stat(auditPath)).mode & 0o777, 0o600);

    await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
    });

    const afterNoopLines = (await readFile(auditPath, "utf8")).trim().split("\n");
    assert.equal(afterNoopLines.length, 1);

    await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: false,
    });
    await service.executeAddonExecutionSettingsUpdate({
      addon: "opencode",
      localCliExecution: true,
    });

    const entries = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => [entry.from, entry.to]), [
      [false, true],
      [true, false],
      [false, true],
    ]);
    assert.deepEqual(entries.map((entry) => entry.addonId), ["opencode", "opencode", "opencode"]);
    assert.ok(entries.every((entry) => entry.field === "localCliExecution"));
  });
});

test("add-on uninstall appends governance audit entry without secrets", async () => {
  await withTempService(async (service, root) => {
    const record = validUninstallAuditRecord();

    const result = await service.executeAddonUninstallAudit(record);

    assert.equal(result.recorded, true);
    assert.equal(result.addonId, "addon.hermes");
    assert.doesNotThrow(() => new Date(result.recordedAt).toISOString());
    const [entry] = await readAuditEntries(root);
    assert.deepEqual(Object.keys(entry).sort(), [
      "actor",
      "addonId",
      "alsoDeleteUserDataOffered",
      "at",
      "clearedCapabilities",
      "clearedPrivateProviderProfileIds",
      "configDeleted",
      "event",
      "previousEnabled",
      "previousInstalled",
      "previousStatus",
      "recordedAt",
      "recordedVia",
      "source",
      "userDataRetained",
    ].sort());
    assert.deepEqual(entry, {
      ...record,
      recordedAt: result.recordedAt,
      recordedVia: "bridge",
    });
    const serialized = JSON.stringify(entry);
    assert.doesNotMatch(serialized, /\/[A-Za-z0-9._-]+/);
    assert.doesNotMatch(serialized, /sk-[a-z0-9_-]+/i);
    assert.doesNotMatch(serialized, /api[_-]?key|token|secret/i);
  });
});

test("uninstall audit rejects malformed records and appends nothing", async () => {
  await withTempService(async (service, root) => {
    const cases = [
      ["extra key", { ...validUninstallAuditRecord(), configValues: { secret: "sk-extra" } }, ["configValues", "sk-extra"]],
      ["missing actor", (() => {
        const record = validUninstallAuditRecord();
        delete record.actor;
        return record;
      })(), ["actor"]],
      ["path addon id", validUninstallAuditRecord({ addonId: "../x" }), ["../x"]],
      ["path capability", validUninstallAuditRecord({ clearedCapabilities: ["/tmp/x"] }), ["/tmp/x"]],
      ["too many capabilities", validUninstallAuditRecord({ clearedCapabilities: Array.from({ length: 65 }, (_, index) => `cap-${index}`) }), ["cap-64"]],
      ["profile ids array", validUninstallAuditRecord({ clearedPrivateProviderProfileIds: ["id-1"] }), ["id-1"]],
      ["profile ids float", validUninstallAuditRecord({ clearedPrivateProviderProfileIds: 1.5 }), ["1.5"]],
      ["user data deleted", validUninstallAuditRecord({ userDataRetained: false }), ["false"]],
      ["agent actor", validUninstallAuditRecord({ actor: "agent" }), ["agent"]],
      ["wrong event", validUninstallAuditRecord({ event: "delegationExecuted" }), ["delegationExecuted"]],
      ["garbage date", validUninstallAuditRecord({ at: "yesterday" }), ["yesterday"]],
      ["path date", validUninstallAuditRecord({ at: "/Users/x" }), ["/Users/x"]],
      ["non-canonical date", validUninstallAuditRecord({ at: "2026-09-07T00:00:00Z" }), ["2026-09-07T00:00:00Z"]],
      ["array payload", [validUninstallAuditRecord()], ["addon.hermes"]],
    ];

    for (const [name, payload, forbiddenValues] of cases) {
      await assert.rejects(
        () => service.executeAddonUninstallAudit(payload),
        (error) => {
          assert.match(error.message, /^Uninstall audit record rejected: /, name);
          for (const value of forbiddenValues) {
            assert.equal(error.message.includes(value), false, `${name} leaked ${value}`);
          }
          return true;
        },
      );
    }

    const auditPath = path.join(root, "BrowserFirst", "Settings", "addon-governance-audit.jsonl");
    await assert.rejects(() => access(auditPath), /ENOENT/);
  });
});

test("running-work reports running delegations per add-on", async () => {
  await withTempService(async (_service, root) => {
    const service = createService(root, { listFilesRecursive });
    const running = await service.executeDelegationRecord({
      target: "hermes",
      mission: "Keep one Hermes delegation marked as running.",
    });
    const queued = await service.executeDelegationRecord({
      target: "hermes",
      mission: "Keep one Hermes delegation queued.",
    });
    const completed = await service.executeDelegationRecord({
      target: "hermes",
      mission: "Keep one Hermes delegation completed.",
    });
    await rewriteDelegationStatus(root, running, "running");
    await rewriteDelegationStatus(root, queued, "queued");
    await rewriteDelegationStatus(root, completed, "completed");

    const hermes = await service.executeAddonRunningWork({ addonId: "addon.hermes" });
    const opencode = await service.executeAddonRunningWork({ addonId: "addon.opencode" });
    const obsidian = await service.executeAddonRunningWork({ addonId: "addon.obsidian" });

    assert.equal(hermes.addonId, "addon.hermes");
    assert.deepEqual(hermes.targets, ["hermes"]);
    assert.equal(hermes.running.length, 1);
    assert.equal(hermes.running[0].id, running.id);
    assert.equal(hermes.running[0].target, "hermes");
    assert.doesNotThrow(() => new Date(hermes.running[0].updatedAt).toISOString());
    assert.equal(JSON.stringify(hermes.running).includes(root), false);
    assert.equal(JSON.stringify(hermes.running).includes("/BrowserFirst/Delegations"), false);
    assert.equal(hermes.queuedCount, 1);
    assert.equal(hermes.stopped, false);
    assert.equal(hermes.detail, "1 running delegation(s) for this add-on; cancel them or wait for them to finish before uninstalling.");
    assert.deepEqual(opencode.running, []);
    assert.equal(opencode.stopped, true);
    assert.deepEqual(obsidian.targets, []);
    assert.deepEqual(obsidian.running, []);
    assert.equal(obsidian.stopped, true);
  });
});

test("running-work sees an old running packet behind newer ones", async () => {
  await withTempService(async (_service, root) => {
    const service = createService(root, { listFilesRecursive });
    const oldRunning = await service.executeDelegationRecord({
      target: "hermes",
      mission: "Keep the old Hermes packet running behind newer packets.",
    });
    await rewriteDelegationStatus(root, oldRunning, "running");

    for (let index = 0; index < 45; index += 1) {
      const completed = await service.executeDelegationRecord({
        target: "hermes",
        mission: `Create newer completed Hermes packet ${index}.`,
      });
      await rewriteDelegationStatus(root, completed, "completed");
    }

    const result = await service.executeAddonRunningWork({ addonId: "addon.hermes" });

    assert.equal(result.stopped, false);
    assert.equal(result.running.length, 1);
    assert.equal(result.running[0].id, oldRunning.id);
  });
});

test("running-work does not treat blocked or cancelled as running", async () => {
  await withTempService(async (_service, root) => {
    const service = createService(root, { listFilesRecursive });
    const blocked = await service.executeDelegationRecord({
      target: "opencode",
      mission: "Keep one OpenCode delegation blocked.",
    });
    const cancelled = await service.executeDelegationRecord({
      target: "opencode",
      mission: "Keep one OpenCode delegation cancelled.",
    });
    await rewriteDelegationStatus(root, blocked, "blocked");
    await rewriteDelegationStatus(root, cancelled, "cancelled");

    const result = await service.executeAddonRunningWork({ addonId: "addon.opencode" });

    assert.deepEqual(result.running, []);
    assert.equal(result.queuedCount, 0);
    assert.equal(result.stopped, true);
  });
});

test("running-work rejects unknown keys", async () => {
  await withTempService(async (service) => {
    await assert.rejects(
      () => service.executeAddonRunningWork({ addonId: "addon.hermes", target: "hermes" }),
      /^Error: Running-work query rejected: unexpected-keys$/,
    );
  });
});

test("OpenCode web cockpit URL refuses with a structured error when execution is disabled", async () => {
  await withTempService(async (service) => {
    await assert.rejects(
      () => service.executeOpenCodeWebUrl({}),
      (error) => {
        assert.equal(error.code, "opencode_web_url_execution_disabled");
        assert.equal(error.addonId, "opencode");
        assert.match(error.message, /explicit OpenCode execution/);
        return true;
      },
    );
  });
});

test("OpenCode web cockpit URL issuance is execution-gated, loopback-only, and intent-audited", async () => {
  await withTempService(async (_service, root) => {
    let ensured = 0;
    const service = createService(root, {
      opencodeCommand: () => "/usr/local/bin/opencode",
      opencodeRuntimeDiagnostics: () => ({
        installed: true,
        command: "/usr/local/bin/opencode",
        commandRedacted: "<opencode>",
      }),
      ensureOpenCodeServer: async () => {
        ensured += 1;
        return { baseUrl: "http://127.0.0.1:4231/session?directory=%2Frepo" };
      },
      // a server is already registered -> the handler may issue the URL (#343 peek)
      peekOpenCodeServer: () => ({ baseUrl: "http://127.0.0.1:4231" }),
    });
    const auditPath = path.join(root, "BrowserFirst", "Settings", "addon-governance-audit.jsonl");

    const first = await service.executeOpenCodeWebUrl({ enableOpenCodeExecution: true });
    const second = await service.executeOpenCodeWebUrl({ enableOpenCodeExecution: true });

    assert.equal(ensured, 2);
    assert.equal(new URL(first.url).hostname, "127.0.0.1");
    assert.deepEqual(first, { url: "http://127.0.0.1:4231/" });
    assert.deepEqual(second, { url: "http://127.0.0.1:4231/" });
    assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
    const entries = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.addonId === "opencode"));
    assert.ok(entries.every((entry) => entry.event === "webCockpitUrlIssued"));
    assert.ok(entries.every((entry) => entry.url === "http://127.0.0.1:4231/"));
    assert.ok(entries.every((entry) => new URL(entry.url).hostname === "127.0.0.1"));
  });
});

test("Hermes status prefers session MiniMax credentials for alpha provider routing", async () => {
  await withTempService(async (_service, root) => {
    const service = createService(root, {
      hermesCommand: () => "/usr/local/bin/hermes",
      readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
    });

    const status = await service.executeHermesStatus();

    assert.equal(status.provider, "minimax");
    assert.equal(status.model, "MiniMax-M3");
    assert.deepEqual(status.providerEnvKeys, ["MINIMAX_API_KEY"]);
  });
});

test("Hermes delegation ignores an attacker-controlled profileHome Python before spawn", async () => {
  await withEnv({
    RESONANTOS_HERMES_EXECUTION: "enabled",
    MINIMAX_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  }, async () => {
    await withTempService(async (_service, root) => {
      const canonicalRoot = await realpath(root);
      const trustedCommand = path.join(canonicalRoot, ".hermes", "hermes-agent", "venv", "bin", "hermes");
      const attackerHome = path.join(canonicalRoot, "attacker-profile");
      const attackerBin = path.join(attackerHome, "hermes-agent", "venv", "bin");
      await mkdir(path.dirname(trustedCommand), { recursive: true });
      await mkdir(attackerBin, { recursive: true });
      await writeFile(trustedCommand, "");
      await writeFile(path.join(attackerBin, "python"), "");
      await writeFile(path.join(attackerHome, "hermes-agent", "run_agent.py"), "");
      await chmod(trustedCommand, 0o755);
      await chmod(path.join(attackerBin, "python"), 0o755);
      const resolverOptions = {
        env: { HERMES_COMMAND: trustedCommand },
        homeDir: canonicalRoot,
        platform: process.platform,
      };
      const trustedRuntime = hermesRuntimeDiagnostics(resolverOptions);
      assert.equal(trustedRuntime.command, trustedCommand);

      let spawnCount = 0;
      const service = createService(root, {
        platform: "linux",
        hermesCommand: () => trustedRuntime.command,
        hermesHome: (profileHome) => profileHome
          ? path.resolve(profileHome)
          : path.join(root, "HermesHome"),
        hermesPythonRuntime: (command) => hermesPythonRuntimeDiagnostics(command, resolverOptions),
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
        spawnProcess: () => {
          spawnCount += 1;
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => undefined;
          queueMicrotask(() => child.emit("error", new Error("attacker runtime spawned")));
          return child;
        },
      });
      const created = await service.executeDelegationRecord({
        target: "hermes",
        mission: "Do not execute an attacker profile runtime.",
      });

      const started = await service.executeHermesDelegationStart({
        path: created.path,
        profileHome: attackerHome,
      });

      assert.equal(spawnCount, 0);
      assert.equal(started.status, "failed");
      assert.match(started.failureReason, /prompt-safe local runtime/i);
    });
  });
});

test("Hermes MiniMax execution uses OpenAI-compatible custom runtime endpoint", async () => {
  await withEnv({
    RESONANTOS_HERMES_EXECUTION: "enabled",
    MINIMAX_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    RESONANTOS_HERMES_MINIMAX_BASE_URL: undefined,
    RESONANTOS_MINIMAX_OPENAI_BASE_URL: undefined,
  }, async () => {
    await withTempService(async (_service, root) => {
      const hermesBin = path.join(root, "HermesHome", "hermes-agent", "venv", "bin");
      const hermesCommand = path.join(hermesBin, "hermes");
      await mkdir(hermesBin, { recursive: true });
      await writeFile(hermesCommand, "");
      await writeFile(path.join(hermesBin, "python"), "");
      await writeFile(path.join(root, "HermesHome", "hermes-agent", "run_agent.py"), "");

      let captured = null;
      const service = createService(root, {
        platform: "linux",
        hermesCommand: () => hermesCommand,
        hermesPythonRuntime: () => ({
          installed: true,
          agentRoot: path.join(root, "HermesHome", "hermes-agent"),
          pythonPath: path.join(hermesBin, "python"),
        }),
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
        spawnProcess: (_command, args, options) => {
          captured = { args, options };
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => undefined;
          setImmediate(() => {
            writeFile(args[2], JSON.stringify({
              ok: true,
              completed: true,
              apiCalls: 1,
              finalResponse: [
                "Final Summary",
                "HERMES MAIN DELEGATION OK",
                "",
                "Actions Taken",
                "- Ran through the injected Hermes child process.",
                "",
                "Approval Needs",
                "- None.",
                "",
                "Residual Risks",
                "- None for this deterministic adapter test.",
                "",
                "Verification",
                "- Captured the Hermes runtime environment.",
              ].join("\n"),
            }))
              .then(() => child.emit("close", 0, null))
              .catch((error) => child.emit("error", error));
          });
          return child;
        },
      });

      const created = await service.executeDelegationRecord({
        target: "hermes",
        mission: "Exercise MiniMax runtime adapter environment.",
      });
      const started = await service.executeHermesDelegationStart({ path: created.path });

      assert.equal(started.status, "completed");
      assert.equal(captured?.options?.env?.HERMES_INFERENCE_PROVIDER, "custom");
      assert.equal(captured?.options?.env?.HERMES_INFERENCE_MODEL, "MiniMax-M3");
      assert.equal(captured?.options?.env?.RESONANTOS_HERMES_BASE_URL, "https://api.minimax.io/v1");
      assert.equal(captured?.options?.env?.OPENAI_BASE_URL, "https://api.minimax.io/v1");
      assert.equal(captured?.options?.env?.RESONANTOS_HERMES_API_MODE, "chat_completions");
      assert.equal(captured?.options?.env?.MINIMAX_API_KEY, "session-minimax-credential");
      assert.equal(captured?.options?.env?.OPENAI_API_KEY, "session-minimax-credential");
      assert.equal(captured?.options?.env?.RESONANTOS_HERMES_API_KEY, "session-minimax-credential");
    });
  });
});

test("Hermes delegation fails closed when runtime returns unresolved tool-call markup", async () => {
  await withEnv({
    RESONANTOS_HERMES_EXECUTION: "enabled",
    MINIMAX_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  }, async () => {
    await withTempService(async (_service, root) => {
      const hermesBin = path.join(root, "HermesHome", "hermes-agent", "venv", "bin");
      const hermesCommand = path.join(hermesBin, "hermes");
      await mkdir(hermesBin, { recursive: true });
      await writeFile(hermesCommand, "");
      await writeFile(path.join(hermesBin, "python"), "");
      await writeFile(path.join(root, "HermesHome", "hermes-agent", "run_agent.py"), "");

      const service = createService(root, {
        platform: "linux",
        hermesCommand: () => hermesCommand,
        hermesPythonRuntime: () => ({
          installed: true,
          agentRoot: path.join(root, "HermesHome", "hermes-agent"),
          pythonPath: path.join(hermesBin, "python"),
        }),
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
        spawnProcess: (_command, args) => {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => undefined;
          setImmediate(() => {
            writeFile(args[2], JSON.stringify({
              ok: true,
              completed: true,
              apiCalls: 1,
              finalResponse: [
                "Final Summary",
                "I'll create a local-only delegation smoke artifact.]<]minimax[>[<tool_call>",
                "",
                "Actions Taken",
                "- Hermes attempted a provider tool call.",
                "",
                "Approval Needs",
                "- None.",
                "",
                "Residual Risks",
                "- Provider tool-call markup leaked into the result.",
                "",
                "Verification",
                "- Simulated malformed runtime output.",
              ].join("\n"),
            }))
              .then(() => child.emit("close", 0, null))
              .catch((error) => child.emit("error", error));
          });
          return child;
        },
      });

      const created = await service.executeDelegationRecord({
        target: "hermes",
        mission: "Create a local-only Hermes delegation smoke artifact.",
      });
      const started = await service.executeHermesDelegationStart({ path: created.path });

      assert.equal(started.status, "failed");
      assert.match(started.failureReason, /unresolved provider tool-call markup/i);
      const taskPacket = await readFile(path.join(root, created.path), "utf8");
      assert.match(taskPacket, /^- status:\s*failed$/mi);
      assert.match(taskPacket, /^- failureReason:\s*Hermes returned unresolved provider tool-call markup/m);
    });
  });
});

test("OpenCode status prefers MiniMax model when MiniMax credential is available", async () => {
  await withTempService(async (_service, root) => {
    const service = createService(root, {
      opencodeRuntimeDiagnostics: () => ({
        installed: true,
        command: "/usr/local/bin/opencode",
        commandRedacted: "/usr/local/bin/opencode",
      }),
      readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
    });

    const status = await service.executeOpenCodeStatus();

    assert.equal(status.model, "minimax/MiniMax-M3");
    assert.equal(status.modelSource, "provider-default");
    assert.deepEqual(status.providerEnvKeys, ["MINIMAX_API_KEY"]);
  });
});

test("OpenCode status preserves explicit OpenAI model requests", async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    await withTempService(async (_service, root) => {
      const service = createService(root, {
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
      });

      const status = await service.executeOpenCodeStatus({ model: "openai/gpt-5.4-mini" });

      assert.equal(status.model, "openai/gpt-5.4-mini");
      assert.equal(status.modelSource, "request");
      assert.deepEqual(status.providerEnvKeys, []);
    });
  });
});

test("OpenCode delegation blocks before CLI execution when selected provider credential is missing", async () => {
  await withEnv({
    RESONANTOS_OPENCODE_EXECUTION: "enabled",
    MINIMAX_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
  }, async () => {
    await withTempService(async (_service, root) => {
      const service = createService(root, {
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        readProviderSecrets: async () => ({}),
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Exercise missing provider credential guidance before OpenCode execution.",
      });

      const started = await service.executeOpenCodeDelegationStart({ path: created.path });

      assert.equal(started.status, "blocked");
      assert.match(started.blockedReason, /OpenCode provider credential unavailable for openai \/ openai\/gpt-5\.4-mini/);
      assert.match(started.blockedReason, /Settings > Providers/);
      const taskPacket = await readFile(path.join(root, created.path), "utf8");
      assert.match(taskPacket, /^- status:\s*blocked$/mi);
      assert.match(taskPacket, /^- model:\s*openai\/gpt-5\.4-mini$/mi);
    });
  });
});

test("OpenCode rejects Windows command shims before request-controlled argv can spawn", async () => {
  await withEnv({
    OPENAI_API_KEY: "synthetic-openai-key",
    RESONANTOS_OPENCODE_EXECUTION: "enabled",
  }, async () => {
    await withTempService(async (_service, root) => {
      let spawnCount = 0;
      const service = createService(root, {
        platform: "win32",
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "C:\\Trusted & Tools\\opencode.cmd",
          commandRedacted: "C:\\Trusted & Tools\\opencode.cmd",
        }),
        spawnProcess: () => {
          spawnCount += 1;
          throw new Error("command shim must not spawn");
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Exercise Windows command shim rejection.",
      });

      const started = await service.executeOpenCodeDelegationStart({
        path: created.path,
        model: "openai/gpt-5.4-mini&|^%",
      });

      assert.equal(spawnCount, 0);
      assert.equal(started.status, "failed");
      assert.match(started.failureReason, /direct executable|\.cmd|command shim/i);
    });
  });
});

test("OpenCode Windows direct executables keep metacharacters literal with shell disabled", async () => {
  await withEnv({
    OPENAI_API_KEY: "synthetic-openai-key",
    RESONANTOS_OPENCODE_EXECUTION: "enabled",
  }, async () => {
    await withTempService(async (_service, root) => {
      const workspacePath = path.join(root, "workspace &|^%");
      await mkdir(workspacePath, { recursive: true });
      let captured = null;
      const service = createService(root, {
        platform: "win32",
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "C:\\Program Files\\OpenCode\\opencode.exe",
          commandRedacted: "C:\\Program Files\\OpenCode\\opencode.exe",
        }),
        spawnProcess: (command, args, options) => {
          captured = { command, args, options };
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => undefined;
          queueMicrotask(() => child.emit("error", new Error("capture complete")));
          return child;
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Exercise literal Windows argv handling.",
      });

      await service.executeOpenCodeDelegationStart({
        path: created.path,
        model: "openai/gpt-5.4-mini&|^%",
        workspacePath,
      });

      assert.equal(captured.command, "C:\\Program Files\\OpenCode\\opencode.exe");
      assert.equal(captured.options.shell, false);
      assert.ok(captured.args.includes("openai/gpt-5.4-mini&|^%"));
      assert.ok(captured.args.includes(workspacePath));
    });
  });
});

test("OpenCode provider matrix scopes explicit provider environment keys", async () => {
  const explicitProviderKeys = [
    "ANTHROPIC_BASE_URL",
    "DEEPSEEK_BASE_URL",
    "GEMINI_BASE_URL",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
    "GOOGLE_API_BASE_URL",
    "GLM_BASE_URL",
    "MINIMAX_BASE_URL",
    "OPENAI_BASE_URL",
    "OPENROUTER_BASE_URL",
    "XAI_BASE_URL",
    "ZAI_BASE_URL",
    "ZHIPUAI_BASE_URL",
  ];
  const providerCases = [
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
  const providerApiKeys = [...new Set(providerCases.flatMap(([, keys]) => keys))];
  const environment = Object.fromEntries([
    ...providerApiKeys.map((key) => [key, `synthetic-${key.toLowerCase()}`]),
    ...explicitProviderKeys.map((key) => [key, `https://${key.toLowerCase().replaceAll("_", "-")}.example/v1`]),
    ["AWS_SECRET_ACCESS_KEY", "must-not-reach-opencode"],
    ["RESONANTOS_OPENCODE_EXECUTION", "enabled"],
    ["RESONANTOS_OPENCODE_PROVIDER_ENV", [...explicitProviderKeys, "AWS_SECRET_ACCESS_KEY", "RESONANTOS_PROVIDER_SECRETS_JSON"].join(",")],
    ["RESONANTOS_PROVIDER_SECRETS_JSON", "must-not-reach-opencode"],
  ]);

  await withEnv(environment, async () => {
    await withTempService(async (_service, root) => {
      const calls = [];
      const service = createService(root, {
        platform: "linux",
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        spawnProcess: (command, args, options) => {
          calls.push({ command, args, options });
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => undefined;
          queueMicrotask(() => child.emit("error", new Error("provider matrix capture complete")));
          return child;
        },
      });

      for (const [model] of providerCases) {
        const created = await service.executeDelegationRecord({
          target: "opencode",
          mission: `Capture scoped environment for ${model}.`,
        });
        await service.executeOpenCodeDelegationStart({ path: created.path, model });
      }

      assert.equal(calls.length, providerCases.length);
      for (const [index, [model, expectedApiKeys]] of providerCases.entries()) {
        const call = calls[index];
        const envKeys = Object.keys(call.options.env);
        assert.equal(call.command, "/usr/local/bin/opencode");
        assert.equal(call.options.shell, false);
        assert.ok(call.args.includes(model));
        assert.ok(expectedApiKeys.every((key) => envKeys.includes(key)));
        assert.ok(explicitProviderKeys.every((key) => envKeys.includes(key)));
        assert.ok(!envKeys.includes("AWS_SECRET_ACCESS_KEY"));
        assert.ok(!envKeys.includes("RESONANTOS_PROVIDER_SECRETS_JSON"));
      }
    });
  });
});

test("OpenCode web cockpit URL issuance does not spawn a server just to refuse (#343)", async () => {
  await withTempService(async (_service, root) => {
    let ensured = 0;
    const service = createService(root, {
      opencodeCommand: () => "/usr/local/bin/opencode",
      opencodeRuntimeDiagnostics: () => ({ installed: true, command: "/usr/local/bin/opencode", commandRedacted: "<opencode>" }),
      ensureOpenCodeServer: async () => { ensured += 1; return { baseUrl: "http://127.0.0.1:4231" }; },
      peekOpenCodeServer: () => null, // nothing registered
    });
    const result = await service.executeOpenCodeWebUrl({ enableOpenCodeExecution: true });
    assert.equal(ensured, 0);
    assert.deepEqual(result, { url: "", requiresCredential: true });
    const auditPath = path.join(root, "BrowserFirst", "Settings", "addon-governance-audit.jsonl");
    const entries = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, "webCockpitUrlIssued");
    assert.equal(entries[0].url, "");
  });
});

test("OpenCode delegation wraps the CLI with sandbox-exec and records isolation metadata", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      OPENAI_API_KEY: "synthetic-openai-key",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: undefined,
    }, async () => {
      const workspacePath = path.join(root, "workspace");
      const seededPath = path.join(workspacePath, "seeded.txt");
      const bridgeConfigPath = path.join(root, "browser-first", "resonantos-side-panel-extension", "src", "bridge-config.generated.js");
      await mkdir(workspacePath, { recursive: true });
      await mkdir(path.dirname(bridgeConfigPath), { recursive: true });
      await mkdir(path.join(root, "Secrets"), { recursive: true });
      await mkdir(path.dirname(providerSecretsPath()), { recursive: true });
      await writeFile(seededPath, "before");
      await writeFile(bridgeConfigPath, "export const bridgeToken = 'test-token';\n");

      let captured = null;
      let capturedProfilePath = "";
      const service = createService(root, {
        platform: "darwin",
        isolation: {
          isExecutable: async () => true,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        spawnProcess: (command, args, options) => {
          captured = { command, args, options };
          const child = fakeChild();
          setImmediate(async () => {
            try {
              capturedProfilePath = args[1];
              const profile = await readFile(capturedProfilePath, "utf8");
              const profileMode = (await stat(capturedProfilePath)).mode & 0o777;
              assert.equal(profileMode, 0o600);
              assert.ok(profile.indexOf("(deny file-write*)") < profile.indexOf("(allow file-write*"));
              assert.match(profile, new RegExp(`\\(subpath "${(await realpath(workspacePath)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
              assert.doesNotMatch(profile, /\(subpath "\/dev"\)/);
              assert.match(profile, new RegExp(`\\(subpath "${(await realpath(path.dirname(providerSecretsPath()))).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
              assert.match(profile, new RegExp(`\\(literal "${(await realpath(bridgeConfigPath)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
              await writeFile(seededPath, "after");
              child.stdout.emit("data", successfulOpenCodeOutput());
              child.emit("close", 0, null);
            } catch (error) {
              child.emit("error", error);
            }
          });
          return child;
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Exercise OpenCode sandbox wrapping.",
      });

      const started = await service.executeOpenCodeDelegationStart({ path: created.path, workspacePath });

      assert.equal(captured.command, "/usr/bin/sandbox-exec");
      assert.deepEqual(captured.args.slice(0, 3), ["-f", capturedProfilePath, "/usr/local/bin/opencode"]);
      assert.equal(captured.options.shell, false);
      await assert.rejects(() => access(capturedProfilePath), /ENOENT/);
      assert.equal(started.status, "completed");
      assert.equal(started.isolation.mode, "sandbox-exec");
      assert.equal(started.changeAudit.modified, 1);
      const entries = await readAuditEntries(root);
      const audit = entries.find((entry) => entry.event === "delegationExecuted");
      assert.equal(audit.addonId, "opencode");
      assert.equal(audit.outcome, "completed");
      assert.equal(audit.isolation.mode, "sandbox-exec");
      assert.equal(audit.changeAudit.modified, 1);
      const auditText = JSON.stringify(audit);
      assert.equal(auditText.includes(workspacePath), false);
      assert.equal(auditText.includes("synthetic-openai-key"), false);
    });
  });
});

test("OpenCode delegation uses contract-only mode without wrapping on linux", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      OPENAI_API_KEY: "synthetic-openai-key",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: undefined,
    }, async () => {
      let captured = null;
      const service = createService(root, {
        platform: "linux",
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        spawnProcess: (command, args, options) => {
          captured = { command, args, options };
          const child = fakeChild();
          queueMicrotask(() => {
            child.stdout.emit("data", successfulOpenCodeOutput("OpenCode contract-only test completed."));
            child.emit("close", 0, null);
          });
          return child;
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Exercise OpenCode linux isolation metadata.",
      });

      const started = await service.executeOpenCodeDelegationStart({ path: created.path });

      assert.equal(captured.command, "/usr/local/bin/opencode");
      assert.equal(started.isolation.mode, "contract-only");
      assert.equal(started.isolation.reason, "no-os-primitive:linux");
    });
  });
});

test("OpenCode delegation honors darwin contract-only operator override without wrapping", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      OPENAI_API_KEY: "synthetic-openai-key",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: "contract-only",
    }, async () => {
      let captured = null;
      const service = createService(root, {
        platform: "darwin",
        isolation: {
          isExecutable: async () => true,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        spawnProcess: (command, args, options) => {
          captured = { command, args, options };
          const child = fakeChild();
          queueMicrotask(() => {
            child.stdout.emit("data", successfulOpenCodeOutput("OpenCode operator override test completed."));
            child.emit("close", 0, null);
          });
          return child;
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Exercise OpenCode operator override.",
      });

      const started = await service.executeOpenCodeDelegationStart({ path: created.path });

      assert.equal(captured.command, "/usr/local/bin/opencode");
      assert.equal(started.isolation.mode, "contract-only");
      assert.equal(started.isolation.reason, "operator-override");
    });
  });
});

test("OpenCode delegation fails closed on darwin when sandbox-exec is unavailable and audits failure", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      OPENAI_API_KEY: "synthetic-openai-key",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: undefined,
    }, async () => {
      let spawnCount = 0;
      const service = createService(root, {
        platform: "darwin",
        isolation: {
          sandboxExecPath: "/missing/sandbox-exec",
          isExecutable: async () => false,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        spawnProcess: () => {
          spawnCount += 1;
          throw new Error("must not spawn unconfined");
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Exercise missing sandbox-exec fail closed behavior.",
      });

      const started = await service.executeOpenCodeDelegationStart({ path: created.path });

      assert.equal(spawnCount, 0);
      assert.equal(started.status, "failed");
      assert.equal(started.failureReason, "Delegation isolation unavailable: /missing/sandbox-exec is not executable. Set RESONANTOS_DELEGATION_ISOLATION=contract-only to run delegations unconfined (this is recorded in the governance audit).");
      const audit = (await readAuditEntries(root)).find((entry) => entry.event === "delegationExecuted");
      assert.equal(audit.outcome, "failed");
      assert.deepEqual(audit.isolation, {
        mode: "sandbox-exec",
        reason: started.failureReason,
        denials: null,
      });
    });
  });
});

test("OpenCode delegation audits unresolved mode for unknown isolation overrides", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      OPENAI_API_KEY: "synthetic-openai-key",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: "sandbox",
    }, async () => {
      let spawnCount = 0;
      const service = createService(root, {
        platform: "darwin",
        isolation: {
          isExecutable: async () => true,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        spawnProcess: () => {
          spawnCount += 1;
          throw new Error("must not spawn with unresolved isolation mode");
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Refuse unknown isolation override.",
      });

      const started = await service.executeOpenCodeDelegationStart({ path: created.path });

      assert.equal(spawnCount, 0);
      assert.equal(started.status, "failed");
      assert.match(started.failureReason, /^Unknown RESONANTOS_DELEGATION_ISOLATION value "sandbox"/);
      const audit = (await readAuditEntries(root)).find((entry) => entry.event === "delegationExecuted");
      assert.equal(audit.outcome, "failed");
      assert.equal(audit.isolation.mode, "unresolved");
    });
  });
});

test("OpenCode delegation fails closed without spawning when sandbox profile write fails", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      OPENAI_API_KEY: "synthetic-openai-key",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: undefined,
    }, async () => {
      let spawnCount = 0;
      const service = createService(root, {
        platform: "darwin",
        fs: {
          ...fsPromises,
          writeFile: async (filePath, ...args) => {
            if (String(filePath).endsWith(".sb")) throw new Error("profile write denied");
            return fsPromises.writeFile(filePath, ...args);
          },
        },
        isolation: {
          isExecutable: async () => true,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        spawnProcess: () => {
          spawnCount += 1;
          throw new Error("must not spawn unconfined");
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Exercise profile write fail closed behavior.",
      });

      const started = await service.executeOpenCodeDelegationStart({ path: created.path });

      assert.equal(spawnCount, 0);
      assert.equal(started.status, "failed");
      assert.equal(started.failureReason, "Delegation isolation could not be applied: profile write denied");
      const audit = (await readAuditEntries(root)).find((entry) => entry.event === "delegationExecuted");
      assert.equal(audit.outcome, "failed");
      assert.equal(audit.isolation.mode, "sandbox-exec");
    });
  });
});

test("OpenCode delegation completes with unavailable workspace changes when snapshot audit fails", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      OPENAI_API_KEY: "synthetic-openai-key",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: undefined,
    }, async () => {
      const workspacePath = path.join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const service = createService(root, {
        platform: "darwin",
        fs: {
          ...fsPromises,
          opendir: async () => {
            throw new Error("snapshot audit unavailable");
          },
        },
        isolation: {
          isExecutable: async () => true,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        spawnProcess: (_command, _args, _options) => {
          const child = fakeChild();
          queueMicrotask(() => {
            child.stdout.emit("data", successfulOpenCodeOutput("OpenCode completed despite snapshot audit failure."));
            child.emit("close", 0, null);
          });
          return child;
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Record unavailable change audit.",
      });

      const started = await service.executeOpenCodeDelegationStart({ path: created.path, workspacePath });
      const artifact = await service.executeOpenCodeDelegationArtifact({ path: created.path });

      assert.equal(started.status, "completed");
      assert.match(artifact.content, /Isolation: sandbox-exec \(writes confined to \d+ roots; \d+ protected paths unreadable\)/);
      assert.match(artifact.content, /Workspace changes: unavailable \(snapshot audit unavailable; snapshot audit unavailable\)/);
      const audit = (await readAuditEntries(root)).find((entry) => entry.event === "delegationExecuted");
      assert.equal(audit.outcome, "completed");
      assert.equal(audit.changeAudit, null);
    });
  });
});

test("OpenCode delegation fails closed when workspace symlink resolves outside the repository", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      OPENAI_API_KEY: "synthetic-openai-key",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: undefined,
    }, async () => {
      const repoRoot = path.join(root, "repo");
      const outsideTarget = path.join(root, "outside-target");
      const escapedWorkspace = path.join(repoRoot, "evil");
      await mkdir(repoRoot, { recursive: true });
      await mkdir(outsideTarget, { recursive: true });
      await writeFile(path.join(outsideTarget, "outside.txt"), "outside");
      await symlink(outsideTarget, escapedWorkspace);

      let spawnCount = 0;
      const service = createService(root, {
        repoRoot,
        platform: "darwin",
        isolation: {
          isExecutable: async () => true,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: "/usr/local/bin/opencode",
          commandRedacted: "/usr/local/bin/opencode",
        }),
        spawnProcess: () => {
          spawnCount += 1;
          const child = fakeChild();
          queueMicrotask(() => {
            child.stdout.emit("data", successfulOpenCodeOutput("OpenCode symlink escape should not run."));
            child.emit("close", 0, null);
          });
          return child;
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Refuse an OpenCode workspace symlink that escapes the repo.",
      });

      const started = await service.executeOpenCodeDelegationStart({
        path: created.path,
        workspacePath: escapedWorkspace,
      });

      assert.equal(started.status, "failed");
      assert.equal(
        started.failureReason,
        "Delegation isolation could not be applied: OpenCode workspace resolves outside the repository.",
      );
      assert.equal(spawnCount, 0);
      const audit = (await readAuditEntries(root)).find((entry) => entry.event === "delegationExecuted");
      assert.equal(audit.outcome, "failed");
    });
  });
});

test("OpenCode .cmd rejection still applies to the inner command under darwin isolation", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      OPENAI_API_KEY: "synthetic-openai-key",
      RESONANTOS_OPENCODE_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: undefined,
    }, async () => {
      let spawnCount = 0;
      const service = createService(root, {
        platform: "darwin",
        isolation: {
          isExecutable: async () => true,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        opencodeRuntimeDiagnostics: () => ({
          installed: true,
          command: path.join(root, "opencode.cmd"),
          commandRedacted: "<opencode.cmd>",
        }),
        spawnProcess: () => {
          spawnCount += 1;
          throw new Error("command shim must not spawn");
        },
      });
      const created = await service.executeDelegationRecord({
        target: "opencode",
        mission: "Exercise inner command shim rejection under sandbox wrapping.",
      });

      const started = await service.executeOpenCodeDelegationStart({ path: created.path });

      assert.equal(spawnCount, 0);
      assert.equal(started.status, "failed");
      assert.match(started.failureReason, /OpenCode command shims \(\.cmd\/\.bat\) are not supported/);
    });
  });
});

test("Hermes adapter is wrapped with sandbox-exec and PYTHONDONTWRITEBYTECODE", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      MINIMAX_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      RESONANTOS_HERMES_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: undefined,
    }, async () => {
      const hermesBin = path.join(root, "HermesHome", "hermes-agent", "venv", "bin");
      const hermesCommand = path.join(hermesBin, "hermes");
      const pythonPath = path.join(hermesBin, "python");
      const profileHome = path.join(root, "HermesHome");
      await mkdir(hermesBin, { recursive: true });
      await mkdir(path.join(root, "Secrets"), { recursive: true });
      await writeFile(hermesCommand, "");
      await writeFile(pythonPath, "");
      await writeFile(path.join(root, "HermesHome", "hermes-agent", "run_agent.py"), "");
      let captured = null;
      let profileText = "";
      const service = createService(root, {
        platform: "darwin",
        hermesCommand: () => hermesCommand,
        hermesPythonRuntime: () => ({
          installed: true,
          agentRoot: path.join(root, "HermesHome", "hermes-agent"),
          pythonPath,
        }),
        isolation: {
          isExecutable: async () => true,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
        spawnProcess: (command, args, options) => {
          captured = { command, args, options };
          const child = fakeChild();
          setImmediate(async () => {
            try {
              profileText = await readFile(args[1], "utf8");
              await writeFile(args[5], JSON.stringify({
                ok: true,
                completed: true,
                apiCalls: 1,
                finalResponse: successfulHermesResponse(),
              }));
              child.emit("close", 0, null);
            } catch (error) {
              child.emit("error", error);
            }
          });
          return child;
        },
      });
      const created = await service.executeDelegationRecord({
        target: "hermes",
        mission: "Exercise Hermes sandbox wrapping.",
      });

      const started = await service.executeHermesDelegationStart({ path: created.path, profileHome });

      assert.equal(captured.command, "/usr/bin/sandbox-exec");
      assert.deepEqual(captured.args.slice(0, 3), ["-f", captured.args[1], pythonPath]);
      assert.equal(captured.options.env.PYTHONDONTWRITEBYTECODE, "1");
      assert.match(profileText, new RegExp(`\\(subpath "${(await realpath(profileHome)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
      assert.match(profileText, /\(subpath ".+BrowserFirst\/Runtime\/hermes-prompts\/prompt-/);
      assert.equal(started.status, "completed");
      assert.equal(started.isolation.mode, "sandbox-exec");
      const audit = (await readAuditEntries(root)).find((entry) => entry.event === "delegationExecuted");
      assert.equal(audit.addonId, "hermes");
      assert.equal(audit.outcome, "completed");
      assert.equal(JSON.stringify(audit).includes("session-minimax-credential"), false);
      assert.equal(JSON.stringify(audit).includes(profileHome), false);
    });
  });
});

test("Hermes delegation fails closed when profileHome would make home or root writable", async () => {
  await withTempService(async (_service, root) => {
    await withEnv({
      HOME: root,
      MINIMAX_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      RESONANTOS_HERMES_EXECUTION: "enabled",
      RESONANTOS_DELEGATION_ISOLATION: undefined,
    }, async () => {
      const hermesBin = path.join(root, "HermesRuntime", "hermes-agent", "venv", "bin");
      const hermesCommand = path.join(hermesBin, "hermes");
      const pythonPath = path.join(hermesBin, "python");
      await mkdir(hermesBin, { recursive: true });
      await writeFile(hermesCommand, "");
      await writeFile(pythonPath, "");
      await writeFile(path.join(root, "HermesRuntime", "hermes-agent", "run_agent.py"), "");

      let spawnCount = 0;
      const service = createService(root, {
        platform: "darwin",
        hermesCommand: () => hermesCommand,
        hermesHome: (profileHome) => profileHome ? path.resolve(profileHome) : path.join(root, "HermesHome"),
        hermesPythonRuntime: () => ({
          installed: true,
          agentRoot: path.join(root, "HermesRuntime", "hermes-agent"),
          pythonPath,
        }),
        isolation: {
          isExecutable: async () => true,
          readSandboxDenials: async () => ({ count: 0, sample: [] }),
        },
        readProviderSecrets: async () => ({ "shared-minimax": "session-minimax-credential" }),
        spawnProcess: () => {
          spawnCount += 1;
          const child = fakeChild();
          queueMicrotask(() => child.emit("error", new Error("must not spawn with an unbounded profile root")));
          return child;
        },
      });

      const insideSecrets = path.join(root, "ResonantOS_User", "Secrets", "evil-profile");
      const insideBrowserFirstState = path.join(root, "BrowserFirst", "Settings", "evil-profile");
      // Lexically a plain home descendant, but a symlink whose target lies inside the protected Secrets tree:
      // only the post-realpath bound check can catch this one.
      const secretsTarget = path.join(root, "ResonantOS_User", "Secrets", "linked-target");
      await mkdir(secretsTarget, { recursive: true });
      const symlinkedProfileHome = path.join(root, "hermes-link");
      await symlink(secretsTarget, symlinkedProfileHome);
      for (const profileHome of [root, "/", insideSecrets, insideBrowserFirstState, symlinkedProfileHome]) {
        const created = await service.executeDelegationRecord({
          target: "hermes",
          mission: `Refuse unsafe Hermes profileHome ${profileHome}.`,
        });
        const started = await service.executeHermesDelegationStart({ path: created.path, profileHome });

        assert.equal(started.status, "failed");
        assert.match(
          started.failureReason,
          /^Delegation isolation could not be applied: Delegation isolation refused writable root /,
        );
        assert.equal(spawnCount, 0);
        const audit = (await readAuditEntries(root)).filter((entry) => entry.event === "delegationExecuted").at(-1);
        assert.equal(audit.outcome, "failed");
      }
      await assert.rejects(() => access(insideSecrets), /ENOENT/, "a rejected profileHome must not have been created inside the protected Secrets directory");
    });
  });
});
