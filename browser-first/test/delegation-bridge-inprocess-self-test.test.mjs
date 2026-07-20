import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const toPortablePath = (value) => String(value ?? "").replace(/\\/g, "/");

async function runSelfTest(flag) {
  const { stdout } = await execFileAsync(process.execPath, [
    "browser-first/host/run-browser-first.mjs",
    flag,
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test("Hermes delegation bridge routes pass in-process deterministic smoke test", async () => {
  const result = await runSelfTest("--hermes-delegation-inprocess-self-test=true");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "in-process");
  assert.equal(result.gatedStatus, "blocked");
  assert.equal(result.statusAfter, "completed");
  assert.equal(result.hermesMode, "local-hermes-cli-disabled");
  assert.ok(toPortablePath(result.artifactPath).includes("BrowserFirst/DelegationArtifacts/hermes/"));
  assert.equal(result.listed >= 1, true);
});

test("OpenCode delegation bridge routes pass in-process deterministic smoke test", async () => {
  const result = await runSelfTest("--opencode-delegation-inprocess-self-test=true");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "in-process");
  assert.equal(result.gatedStatus, "blocked");
  assert.equal(result.statusAfter, "completed");
  assert.ok(toPortablePath(result.artifactPath).includes("BrowserFirst/DelegationArtifacts/opencode/"));
  assert.equal(result.listed >= 1, true);
});
