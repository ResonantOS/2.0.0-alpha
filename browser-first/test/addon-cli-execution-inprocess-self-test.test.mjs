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

test("add-on execution settings pass in-process deterministic smoke test", async () => {
  const result = await runSelfTest("--addon-execution-settings-inprocess-self-test=true");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "in-process");
  assert.equal(result.deniedStatus, 403);
  assert.equal(result.enabled, true);
  assert.equal(result.hermesMode, "local-hermes-cli");
  assert.equal(result.opencodeMode, "local-opencode-cli");
  assert.equal(result.settings.hermes.localCliExecution, true);
  assert.equal(result.settings.opencode.localCliExecution, true);
});

test("Hermes CLI execution bridge routes prompts through the safe local runtime adapter", async () => {
  const result = await runSelfTest("--hermes-cli-execution-inprocess-self-test=true");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "in-process");
  assert.equal(result.adapter, "hermes-cli");
  assert.equal(result.hermesMode, "local-hermes-cli");
  assert.equal(result.statusAfter, "completed");
  assert.match(result.summary, /Hermes CLI adapter completed/);
  assert.ok(toPortablePath(result.artifactPath).includes("BrowserFirst/DelegationArtifacts/hermes/"));
});

test("OpenCode CLI execution bridge routes pass in-process deterministic smoke test", async () => {
  const result = await runSelfTest("--opencode-cli-execution-inprocess-self-test=true");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "in-process");
  assert.equal(result.adapter, "opencode-cli");
  assert.equal(result.opencodeMode, "local-opencode-cli");
  assert.equal(result.statusAfter, "completed");
  assert.match(result.summary, /OpenCode CLI adapter completed/);
  assert.ok(toPortablePath(result.artifactPath).includes("BrowserFirst/DelegationArtifacts/opencode/"));
});
