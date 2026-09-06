import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("browser-first bridge auth passes in-process deterministic smoke test", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "browser-first/host/run-browser-first.mjs",
    "--bridge-auth-inprocess-self-test=true",
    "--bridge-token=test-token",
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "in-process");
  assert.equal(result.route, "/status");
  assert.equal(result.unauthorizedStatus, 401);
  assert.equal(result.wrongTokenStatus, 401);
  assert.equal(result.bridgeTokenOnlyStatus, 403);
  assert.equal(result.authorizedStatus, 200);
});
