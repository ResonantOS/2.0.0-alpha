import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as fsPromises from "node:fs/promises";

import { createAddonDelegationService } from "../host/addon-delegation-service.mjs";
import { createAddonDelegationHostService } from "../host/addon-delegation-host-service.mjs";
import { createOpenCodeBoundary } from "../host/opencode-boundary.mjs";
import { evaluateBridgeRequestForSelfTest } from "../host/bridge-server.mjs";

function safeFileSlug(value) {
  return String(value ?? "item")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
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
    hermesCommand: () => null,
    hermesHome: () => path.join(root, "HermesHome"),
    hermesPythonRuntime: () => null,
    listFilesRecursive: async () => [],
    memoryRoot: () => path.join(root, "Memory"),
    opencodeCommand: overrides.opencodeCommand ?? (() => null),
    opencodeRuntimeDiagnostics: overrides.opencodeRuntimeDiagnostics ?? (() => ({ installed: false, command: null })),
    redactPathForDiagnostics: (value) => String(value ?? "").replace(root, "<root>"),
    readProviderSecrets: async () => ({}),
    repoRoot: overrides.repoRoot ?? root,
    safeFileSlug,
    fs: overrides.fs,
    platform: overrides.platform ?? "linux",
    spawnProcess: overrides.spawnProcess,
    timers: overrides.timers,
    socketOpen: async () => false,
    uniqueRuntimeId: (prefix) => `${prefix}-test-${++id}`,
    userRoot: () => root,
  });
}

async function withTempService(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ros-opencode-revoke-"));
  try {
    return await fn(createService(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  return child;
}

function boundaryFixture(t, { executionEnabled } = {}) {
  const password = randomBytes(32).toString("base64url");
  const header = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  const child = new EventEmitter();
  child.kill = () => { child.exitCode = 0; child.emit("exit"); };
  const info = { baseUrl: "http://127.0.0.1:45125", directory: "/fixture", auth: { username: "opencode", password, header }, process: child };
  const client = {
    createSession: async () => ({ id: "A" }),
    listSessions: async () => [{ id: "A", title: "title" }],
    supportsPromptMessageId: async () => false,
    prompt: async () => null,
    replyPermission: async () => true,
    messages: async () => [],
    abort: async () => true,
    sessionDiff: async () => [],
    rename: async () => ({ id: "A" }),
    remove: async () => true,
    archive: async () => ({ id: "A" }),
    listAgents: async () => [{ name: "build" }],
  };
  const boundary = createOpenCodeBoundary({
    ensureServer: async () => {
      if (info.process.exitCode != null || info.process.signalCode != null) {
        const fresh = new EventEmitter();
        fresh.kill = () => { fresh.exitCode = 0; fresh.emit("exit"); };
        info.process = fresh;
      }
      return info;
    },
    createClient: () => client,
    fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }),
    executionEnabled: executionEnabled ?? (async () => true),
    forgetServer: async () => {},
    log: () => {},
  });
  t.after(() => boundary.dispose());
  return { boundary, info };
}

async function postSettings(service, body, { token, writeToken } = {}) {
  const bridgeToken = token ?? randomBytes(16).toString("hex");
  const capabilityToken = writeToken ?? randomBytes(16).toString("hex");
  const { addonDelegationRoutes } = createAddonDelegationHostService(service);
  return evaluateBridgeRequestForSelfTest({
    method: "POST",
    url: "/addons/execution-settings",
    body,
    headers: {
      "X-ResonantOS-Bridge-Token": bridgeToken,
      "X-ResonantOS-Bridge-Capability-Token": capabilityToken,
    },
    bridgeToken,
    bridgeCapabilityTokens: { "addon-execution-settings-write": capabilityToken },
    routes: addonDelegationRoutes,
  });
}

test("off closes live SSE before settings acknowledgement", async (t) => {
  await withTempService(async (service) => {
    await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: true });
    const { boundary } = boundaryFixture(t, { executionEnabled: () => service.openCodeProxyExecutionEnabled() });
    await boundary.run("start", {});
    const sub = await boundary.openEvents("A");
    let closeAt = 0;
    let eofAt = 0;
    let release;
    const closed = new Promise((resolve) => { release = resolve; });
    sub.attachTransport({
      bufferedBytes: () => 0,
      closed,
      terminate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        closeAt = Date.now();
        eofAt = Date.now();
        release();
      },
    });
    const unsubscribe = service.subscribeOpenCodeExecution((enabled) => (enabled ? undefined : boundary.revoke()));
    const dispatchAt = Date.now();
    const result = await postSettings(service, { addon: "opencode", localCliExecution: false });
    const ackAt = Date.now();
    unsubscribe();
    assert.deepEqual(
      [closeAt >= dispatchAt + 300, ackAt > closeAt, eofAt <= ackAt + 1000, result.status],
      [true, true, true, 200],
    );
  });
});

for (const kind of ["write", "audit"]) {
  test(`off survives settings write or audit failure: ${kind}`, async (t) => {
    await withTempService(async (_service, root) => {
      let fail = kind === "write";
      const failingFs = {
        ...fsPromises,
        writeFile: async (filePath, ...args) => {
          if (kind === "write" && fail && String(filePath).endsWith("addon-execution.json")) {
            throw new Error("settings write denied");
          }
          return fsPromises.writeFile(filePath, ...args);
        },
        appendFile: async (filePath, ...args) => {
          if (kind === "audit" && fail && String(filePath).endsWith("addon-governance-audit.jsonl")) {
            throw new Error("audit denied");
          }
          return fsPromises.appendFile(filePath, ...args);
        },
      };
      const service = createService(root, { fs: failingFs });
      if (kind === "audit") {
        await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: true });
        fail = true;
      }
      const { boundary } = boundaryFixture(t, { executionEnabled: () => service.openCodeProxyExecutionEnabled() });
      if (kind === "audit") await boundary.run("start", {});
      const unsubscribe = service.subscribeOpenCodeExecution((enabled) => (enabled ? undefined : boundary.revoke()));
      await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: false }).then(() => false, () => true);
      unsubscribe();
      assert.equal(await service.openCodeProxyExecutionEnabled(), false);
    });
  });
}

test("off overrides proxy request and env enable flags", async () => {
  const previous = process.env.RESONANTOS_OPENCODE_EXECUTION;
  process.env.RESONANTOS_OPENCODE_EXECUTION = "enabled";
  try {
    await withTempService(async (service) => {
      assert.equal(await service.openCodeProxyExecutionEnabled(), false);
      await assert.rejects(
        () => service.executeOpenCodeWebUrl({ enableOpenCodeExecution: true }),
        (error) => error.code === "OPENCODE_EXECUTION_DISABLED",
      );
    });
  } finally {
    if (previous === undefined) delete process.env.RESONANTOS_OPENCODE_EXECUTION;
    else process.env.RESONANTOS_OPENCODE_EXECUTION = previous;
  }
});

test("concurrent enable and disable serialize", async () => {
  await withTempService(async (service) => {
    const ordered = [
      { addon: "opencode", localCliExecution: true },
      { addon: "opencode", localCliExecution: false },
      { addon: "opencode", localCliExecution: true },
    ];
    await Promise.all(ordered.map((payload) => service.executeAddonExecutionSettingsUpdate(payload)));
    assert.equal(await service.openCodeProxyExecutionEnabled(), true);
  });
});

for (const kind of ["corrupt", "missing", "false"]) {
  test(`corrupt missing or false settings revoke: ${kind}`, async (t) => {
    await withTempService(async (service, root) => {
      await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: true });
      const { boundary } = boundaryFixture(t, { executionEnabled: () => service.openCodeProxyExecutionEnabled() });
      await boundary.run("start", {});
      const sub = await boundary.openEvents("A");
      const settingsPath = path.join(root, "BrowserFirst", "Settings", "addon-execution.json");
      if (kind === "corrupt") await writeFile(settingsPath, "{not-json");
      else if (kind === "missing") await rm(settingsPath, { force: true });
      else await writeFile(settingsPath, JSON.stringify({ hermes: { localCliExecution: false }, opencode: { localCliExecution: false } }, null, 2));
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && !sub.terminalCode) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(Boolean(sub.terminalCode), true);
    });
  });
}

test("re-enable cannot revive old subscriber", async (t) => {
  await withTempService(async (service) => {
    await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: true });
    const { boundary } = boundaryFixture(t, { executionEnabled: () => service.openCodeProxyExecutionEnabled() });
    await boundary.run("start", {});
    const old = await boundary.openEvents("A");
    const iterator = old.events[Symbol.asyncIterator]();
    await iterator.next();
    const unsubscribe = service.subscribeOpenCodeExecution((enabled) => (enabled ? undefined : boundary.revoke()));
    await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: false });
    await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: true });
    await boundary.run("list", {});
    const next = await iterator.next();
    unsubscribe();
    assert.equal(next.done || next.value == null, true);
  });
});

test("unrelated CLI receives no serve credential env", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ros-opencode-cli-env-"));
  const previous = {
    OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    RESONANTOS_OPENCODE_EXECUTION: process.env.RESONANTOS_OPENCODE_EXECUTION,
    RESONANTOS_OPENCODE_PROVIDER_ENV: process.env.RESONANTOS_OPENCODE_PROVIDER_ENV,
  };
  let captured;
  try {
    process.env.OPENCODE_SERVER_USERNAME = randomBytes(16).toString("hex");
    process.env.OPENCODE_SERVER_PASSWORD = randomBytes(32).toString("hex");
    process.env.OPENAI_API_KEY = randomBytes(32).toString("hex");
    process.env.RESONANTOS_OPENCODE_EXECUTION = "enabled";
    process.env.RESONANTOS_OPENCODE_PROVIDER_ENV = "OPENCODE_SERVER_USERNAME,OPENCODE_SERVER_PASSWORD";
    const service = createService(root, {
      platform: "linux",
      opencodeRuntimeDiagnostics: () => ({ installed: true, command: "/usr/local/bin/opencode", commandRedacted: "<opencode>" }),
      spawnProcess: (_command, _args, options) => {
        captured = options.env;
        const child = fakeChild();
        queueMicrotask(() => child.emit("error", new Error("fixture stopped")));
        return child;
      },
    });
    const task = await service.executeDelegationRecord({ target: "opencode", mission: "Check serve credential exclusion." });
    await service.executeOpenCodeDelegationStart({ path: task.path, model: "openai/gpt-5.4-mini" });
    assert.deepEqual(
      [!!captured, !!captured && Object.hasOwn(captured, "OPENCODE_SERVER_USERNAME"), !!captured && Object.hasOwn(captured, "OPENCODE_SERVER_PASSWORD")],
      [true, false, false],
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("disable listener timeout is unrefed and cleared", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ros-opencode-unref-"));
  try {
    const created = [];
    const service = createService(root, {
      timers: {
        setTimeout(handler, ms, ...args) {
          const native = globalThis.setTimeout(handler, ms, ...args);
          const handle = {
            native,
            ms,
            unrefed: false,
            cleared: false,
            unrefBeforeClear: false,
            unref() {
              this.unrefed = true;
              this.unrefBeforeClear = !this.cleared;
              native.unref?.();
              return this;
            },
          };
          created.push(handle);
          return handle;
        },
        clearTimeout(handle) {
          if (!handle) return;
          handle.cleared = true;
          globalThis.clearTimeout(handle.native);
        },
      },
    });
    await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: true });
    const unsubscribe = service.subscribeOpenCodeExecution(async () => {});
    await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: false });
    unsubscribe();
    const revokeTimers = created.filter((handle) => handle.ms === 1000);
    assert.equal(revokeTimers.length, 1);
    assert.deepEqual(
      [revokeTimers[0].unrefed, revokeTimers[0].unrefBeforeClear, revokeTimers[0].cleared],
      [true, true, true],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revoke timeout persists disabled state", async () => {
  await withTempService(async (service) => {
    await service.executeAddonExecutionSettingsUpdate({ addon: "opencode", localCliExecution: true });
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => { logs.push(args.join(" ")); };
    const unsubscribe = service.subscribeOpenCodeExecution(() => new Promise(() => {}));
    const started = Date.now();
    // A live bridge keeps the event loop alive; unref() must not cancel the fail-closed timeout.
    const keepAlive = setTimeout(() => {}, 10000);
    let result;
    let writeCalled = false;
    try {
      result = await postSettings(service, { addon: "opencode", localCliExecution: false });
      writeCalled = result.status === 200;
    } finally {
      clearTimeout(keepAlive);
      console.error = originalError;
      unsubscribe();
    }
    const timeoutCodes = logs.filter((line) => line.includes("OPENCODE_REVOKE_TIMEOUT")).map(() => "OPENCODE_REVOKE_TIMEOUT");
    assert.ok(Date.now() - started >= 1000);
    assert.deepEqual(
      [writeCalled, await service.openCodeProxyExecutionEnabled(), timeoutCodes, result.status],
      [true, false, ["OPENCODE_REVOKE_TIMEOUT"], 200],
    );
  });
});
