import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  bashCandidates,
  resolveBash,
  runScan,
} from "./run-pre-release-scan.mjs";

test("resolves only fixed Bash installation roots", () => {
  const candidates = bashCandidates("win32");
  assert.ok(candidates.includes("C:\\Program Files\\Git\\bin\\bash.exe"));
  assert.ok(candidates.every((candidate) => pathIsAbsoluteWindows(candidate)));
  assert.equal(candidates.some((candidate) => /WindowsApps/i.test(candidate)), false);

  const selected = resolveBash({
    platform: "win32",
    exists: (candidate) => candidate === "C:\\Program Files\\Git\\bin\\bash.exe",
  });
  assert.equal(selected, "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("pre-release scan launches the fixed script without a command shell", async () => {
  const child = new EventEmitter();
  const calls = [];
  const env = { RELEASE_SCAN_SENTINEL: "private" };
  const pending = runScan(["package.zip"], {
    bash: "C:\\Program Files\\Git\\bin\\bash.exe",
    cwd: "G:\\repo",
    env,
    script: "G:\\repo\\scripts\\pre-release-scan.sh",
    spawnImpl: (...args) => {
      calls.push(args);
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  assert.deepEqual(await pending, { exitCode: 0, signal: null });
  assert.deepEqual(calls, [[
    "C:\\Program Files\\Git\\bin\\bash.exe",
    ["G:\\repo\\scripts\\pre-release-scan.sh", "package.zip"],
    { cwd: "G:\\repo", env, shell: false, stdio: "inherit" },
  ]]);
});

test("pre-release scan refuses ambient Bash lookup", async () => {
  assert.equal(resolveBash({ platform: "win32", exists: () => false }), null);
  await assert.rejects(() => runScan([], { bash: null }), /fixed Bash installation/i);
});

function pathIsAbsoluteWindows(candidate) {
  return /^[A-Za-z]:\\/.test(candidate);
}
