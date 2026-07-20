import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_RUNNER = path.resolve(HERE, "..", "run-check.mjs");

async function createRunnerFixture(status) {
  const root = await mkdtemp(path.join(os.tmpdir(), "security-run-check-"));
  const scriptsRoot = path.join(root, "scripts", "security-pipeline");
  const checksRoot = path.join(scriptsRoot, "checks");
  const configPath = path.join(root, "checks.json");
  const runnerPath = path.join(scriptsRoot, "run-check.mjs");
  await mkdir(checksRoot, { recursive: true });
  await copyFile(SOURCE_RUNNER, runnerPath);
  await writeFile(
    path.join(checksRoot, "fixture-status.mjs"),
    `export async function run() { return { status: ${JSON.stringify(status)}, summary: "fixture", evidence: [] }; }\n`,
  );
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    families: {
      fixture: { status: "active", description: "Runner behavior fixture." },
    },
    checks: [{
      id: "fixture-status",
      family: "fixture",
      policy: "observe",
      adapter: "fixture-status",
    }],
  }, null, 2)}\n`);
  return { configPath, root, runnerPath };
}

function executeRunner({ configPath, root, runnerPath }, args = []) {
  return spawnSync(
    process.execPath,
    [runnerPath, "--config", configPath, ...args],
    { cwd: root, encoding: "utf8" },
  );
}

test("observe mode preserves policy-based exit behavior", async () => {
  const fixture = await createRunnerFixture("fail");
  try {
    const result = executeRunner(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status": "fail"/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("certification mode requires every enabled result to pass", async (t) => {
  for (const [status, expectedExit] of [
    ["pass", 0],
    ["skipped", 1],
    ["warn", 1],
    ["fail", 1],
  ]) {
    await t.test(status, async () => {
      const fixture = await createRunnerFixture(status);
      try {
        const result = executeRunner(fixture, ["--certify"]);
        assert.match(result.stdout, new RegExp(`"status": "${status}"`), result.stderr);
        assert.equal(result.status, expectedExit, result.stderr);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});
