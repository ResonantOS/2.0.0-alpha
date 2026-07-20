import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemorySourceSettingsService } from "../host/memory-source-settings-service.mjs";
import * as hostUtils from "../host/browser-first-host-utils.mjs";

async function withBrowseService({
  environment,
  firstExistingExecutable,
  platform,
  windowsPowerShellDiagnostics,
}, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-source-browse-"));
  const calls = [];
  const service = createMemorySourceSettingsService({
    memoryRoot: () => root,
    userRoot: () => root,
    memorySettingsPath: () => path.join(root, "settings.json"),
    memorySourceAuditPath: () => path.join(root, "audit.jsonl"),
    countFiles: async () => 0,
    pathSummary: async () => ({ exists: false }),
    listFilesRecursive: async () => [],
    expandUserPath: (value) => path.resolve(String(value ?? "")),
    stableMemorySourceId: () => "source-test",
    redactPathForDiagnostics: String,
    redactDiagnosticText: String,
    execFileStdout: async (command, args, options) => {
      calls.push({ command, args, options });
      return root;
    },
    firstExistingExecutable,
    isInsidePath: () => true,
    executeAddonsStatus: async () => ({}),
    environment,
    platform,
    windowsPowerShellDiagnostics,
  });
  try {
    await run({ calls, root, service });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("memory source macOS picker keeps custom labels and ambient secrets off argv and env", async () => {
  await withBrowseService({
    environment: {
      HOME: "/Users/test",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/tmp/test",
      SECRET_SENTINEL: "do-not-inherit",
    },
    firstExistingExecutable: () => null,
    platform: "darwin",
  }, async ({ calls, service }) => {
    await service.executeMemorySourceBrowse({ prompt: "private-project-name" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/usr/bin/osascript");
    assert.doesNotMatch(JSON.stringify(calls[0].args), /private-project-name/);
    assert.deepEqual(calls[0].options.env, {
      HOME: "/Users/test",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/tmp/test",
    });
  });
});

test("memory source Linux picker resolves only from fixed executable roots", async () => {
  const lookups = [];
  await withBrowseService({
    environment: {
      HOME: "/home/test",
      DISPLAY: ":0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      PATH: "/tmp/attacker-bin",
      SECRET_SENTINEL: "do-not-inherit",
    },
    firstExistingExecutable: (command, options) => {
      lookups.push({ command, options });
      return command === "zenity" ? "/usr/bin/zenity" : null;
    },
    platform: "linux",
  }, async ({ calls, service }) => {
    await service.executeMemorySourceBrowse({ prompt: "private-project-name" });
    assert.deepEqual(lookups, [{
      command: "zenity",
      options: { searchPath: ["/usr/bin", "/bin", "/usr/local/bin"].join(path.delimiter) },
    }]);
    assert.equal(calls[0].command, "/usr/bin/zenity");
    assert.doesNotMatch(JSON.stringify(calls[0].args), /private-project-name/);
    assert.deepEqual(calls[0].options.env, {
      HOME: "/home/test",
      DISPLAY: ":0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });
});

test("memory source Windows picker ignores command shims and disables shell execution", async () => {
  const lookups = [];
  const resolverCalls = [];
  const powerShellRoot = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0";
  const powerShellCommand = `${powerShellRoot}\\powershell.exe`;
  const commandShim = `${powerShellRoot}\\powershell.cmd`;
  await withBrowseService({
    environment: {
      SystemRoot: "D:\\Windows",
      WINDIR: "D:\\Windows",
      COMSPEC: "D:\\Attacker\\cmd.exe",
      USERPROFILE: "C:\\Users\\test",
      TEMP: "C:\\Temp",
      SECRET_SENTINEL: "do-not-inherit",
    },
    firstExistingExecutable: (command, options) => {
      lookups.push({ command, options });
      return commandShim;
    },
    platform: "win32",
    windowsPowerShellDiagnostics: () => {
      resolverCalls.push(true);
      assert.equal(typeof hostUtils.windowsPowerShellDiagnostics, "function");
      return hostUtils.windowsPowerShellDiagnostics({
        exists: (candidate) => candidate === commandShim || candidate === powerShellCommand,
        realpath: (candidate) => candidate,
        stat: () => ({ isFile: () => true }),
      });
    },
  }, async ({ calls, service }) => {
    await service.executeMemorySourceBrowse({ prompt: "private-project-name" });
    assert.deepEqual(resolverCalls, [true]);
    assert.deepEqual(lookups, []);
    assert.equal(calls[0].command, powerShellCommand);
    assert.equal(calls[0].options.shell, false);
    assert.doesNotMatch(JSON.stringify(calls[0].args), /private-project-name/);
    assert.deepEqual(calls[0].options.env, {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      USERPROFILE: "C:\\Users\\test",
      TEMP: "C:\\Temp",
    });
  });
});

test("memory source Windows picker fails closed when only powershell.cmd is present", async () => {
  const powerShellRoot = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0";
  const commandShim = `${powerShellRoot}\\powershell.cmd`;
  await withBrowseService({
    environment: { USERPROFILE: "C:\\Users\\test" },
    firstExistingExecutable: () => commandShim,
    platform: "win32",
    windowsPowerShellDiagnostics: () => {
      assert.equal(typeof hostUtils.windowsPowerShellDiagnostics, "function");
      return hostUtils.windowsPowerShellDiagnostics({
        exists: (candidate) => candidate === commandShim,
        realpath: (candidate) => candidate,
        stat: () => ({ isFile: () => true }),
      });
    },
  }, async ({ calls, service }) => {
    await assert.rejects(
      service.executeMemorySourceBrowse(),
      /Windows PowerShell was not found in the fixed system directory/i,
    );
    assert.equal(calls.length, 0);
  });
});
