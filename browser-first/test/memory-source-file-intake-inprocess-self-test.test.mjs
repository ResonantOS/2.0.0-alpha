import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const toPortablePath = (value) => String(value ?? "").replace(/\\/g, "/");

test("source-file intake bridge routes pass in-process deterministic smoke test", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "browser-first/host/run-browser-first.mjs",
    "--memory-source-file-intake-inprocess-self-test=true",
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "in-process");
  assert.equal(result.unauthorizedCapabilityStatus, 403);
  assert.equal(result.createdCount, 200);
  assert.equal(result.snapshotRecorded, true);
  assert.equal(result.duplicateRejected, true);
  assert.equal(result.escapeRejected, true);
  assert.equal(result.overflowRejected, 5);
  assert.equal(result.failureStatus, 500);
  assert.equal(result.rollbackReservedVersions, 0);
  assert.equal(result.syncFirstStatus, "unchanged");
  assert.equal(result.syncChangedStatus, "changed");
  assert.equal(result.syncNewStatus, "new");
  assert.equal(result.syncChangedVersion, 2);
  assert.equal(result.syncNewVersion, 1);
  assert.equal(result.syncUnchangedStatus, 500);
  assert.equal(result.autoSyncStatus, 200);
  assert.equal(result.autoSyncCreatedArtifacts, 1);
  assert.equal(result.autoSyncReviewRequests, 1);
  assert.equal(result.manualSyncCreatedArtifacts, 0);
  assert.equal(result.manualSyncEligibleFiles, 1);
  assert.equal(result.pausedSyncStatus, "paused");
  assert.equal(result.pausedSyncReviewedSources, 0);
  assert.ok(result.syncHistoryCount >= 3);
  assert.equal(result.syncHistoryLatestStatus, "paused");
  assert.equal(result.syncHistoryPreviousStatus, "review-only");
  assert.equal(result.syncHistoryRedactsSourcePaths, true);
  assert.equal(result.syncHistoryBounded, true);
  assert.ok(result.boundedSyncHistoryCount <= 50);
  assert.equal(result.syncHistoryEligibleFileSample, "manual.md");
  assert.match(toPortablePath(result.syncHistoryCreatedArtifactSample), /^INTAKE\/sources\//);
  assert.match(toPortablePath(result.syncHistorySourcePathSample), /^\[path\]\//);
  assert.equal(result.corruptReviewStatus, 200);
  assert.equal(result.corruptCandidateStatus, "version-manifest-unavailable");
  assert.equal(result.unauthorizedRepairStatus, 403);
  assert.equal(result.missingConfirmationRepairStatus, 500);
  assert.equal(result.repairStatus, 200);
  assert.equal(result.repairPayloadStatus, "repaired");
  assert.match(toPortablePath(result.repairBackupPath), /^CONFIG\/source-file-history\/repairs\//);
  assert.ok(result.repairHistoryCount >= 1);
  assert.equal(result.repairHistoryLatestStatus, "repaired");
  assert.match(toPortablePath(result.repairHistorySourcePathSample), /^\[path\]\//);
  assert.match(toPortablePath(result.repairHistoryBackupPath), /^CONFIG\/source-file-history\/repairs\//);
  assert.equal(result.repairHistoryRedactsSourcePaths, true);
  assert.equal(result.repairedCandidateStatus, "new");
  assert.equal(result.sourceIdCollisionAvoided, true);
});
