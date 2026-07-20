import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const toPortablePath = (value) => String(value ?? "").replace(/\\/g, "/");

test("move-on-import bridge routes pass in-process deterministic smoke test", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "browser-first/host/run-browser-first.mjs",
    "--memory-source-move-inprocess-self-test=true",
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "in-process");
  assert.equal(result.unauthorizedCapabilityStatus, 403);
  assert.equal(result.ordinaryMoveSettings.status, 500);
  assert.match(result.ordinaryMoveSettings.error, /audited move preflight and execute flow/i);
  assert.equal(result.stalePreflight.executeStatus, 500);
  assert.equal(result.stalePreflight.sourcePreserved, true);
  assert.match(result.stalePreflight.error, /source changed after preflight/i);
  assert.equal(result.preflight.okToMove, true);
  assert.equal(result.preflight.hiddenFiles, 1);
  assert.equal(result.execute.status, "moved");
  assert.equal(result.execute.sourceRemoved, true);
  assert.equal(result.execute.movedNoteExists, true);
  assert.equal(result.rollback.restoredCount, 2);
  assert.equal(result.rollback.restoredNoteExists, true);
  assert.equal(result.rollback.outsideLedgerStatus, 500);
  assert.equal(result.partialRollback.restoredCount, 0);
  assert.equal(result.partialRollback.skippedCount, 1);
  assert.equal(result.partialRollback.sourceStillRegistered, true);
  assert.ok(result.moveHistory.count >= 4);
  assert.equal(result.moveHistory.latestAction, "move-rollback");
  assert.equal(result.moveHistory.latestStatus, "partial");
  assert.match(toPortablePath(result.moveHistory.sourcePathSample), /^\[path\]\//);
  assert.match(toPortablePath(result.moveHistory.latestOriginalPath), /^\[path\]\//);
  assert.match(toPortablePath(result.moveHistory.latestManagedPath), /^INTAKE\/imports\/mixed\/partial-rollback-vault-/);
  assert.match(toPortablePath(result.moveHistory.latestManifestPath), /^CONFIG\/move-imports\//);
  assert.match(toPortablePath(result.moveHistory.ledgerPathSample), /^CONFIG\/move-imports\//);
  assert.equal(result.moveHistory.redactsSourcePaths, true);
});
