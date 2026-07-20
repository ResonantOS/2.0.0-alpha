import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryHostService } from "../host/memory-host-service.mjs";

const handlerNames = [
  "executeMemoryStatus",
  "executeMemorySettings",
  "executeMemorySettingsSave",
  "executeMemorySourceBrowse",
  "executeMemorySourceScan",
  "executeMemorySourceAction",
  "executeMemorySourceMovePreflight",
  "executeMemorySourceMoveExecute",
  "executeMemorySourceMoveRollback",
  "executeMemorySourceReview",
  "executeMemorySourceIntake",
  "executeMemorySourceFileIntake",
  "executeMemorySourceSync",
  "executeMemorySearch",
  "executeMemoryWikiHealth",
  "executeMemoryWikiPageRead",
  "executeMemoryWikiLint",
  "executeMemorySourceVersions",
  "executeMemorySourceVersionsRepair",
  "executeMemorySourceDiff",
  "executeArchiveIntake",
  "executeArchiveIntakeList",
  "executeArchiveIntakeRead",
  "executeArchiveReviewRequest",
  "executeArchiveReviewList",
  "executeArchiveReviewTransition",
  "executeArchiveReviewDraft",
  "executeArchiveReviewArtifactRead",
  "executeArchiveReviewArtifactVerify",
  "executeArchiveVerificationRead",
  "executeArchiveReviewArtifactRevise",
  "executeArchiveReviewArtifactPromote",
  "executeArchivePromotionList",
  "executeArchivePromotionRestore",
];

function createHandlers() {
  return Object.fromEntries(handlerNames.map((name) => [name, () => ({ ok: true, name })]));
}

test("memory host service owns Living Archive bridge routes and capability gates", () => {
  const { memoryBridgeRoutes } = createMemoryHostService(createHandlers());
  const routes = new Map(memoryBridgeRoutes.map((route) => [`${route.method} ${route.path}`, route]));

  assert.equal(typeof routes.get("GET /memory/status")?.handler, "function");
  assert.equal(typeof routes.get("GET /memory/settings")?.handler, "function");
  assert.equal(typeof routes.get("POST /memory/search")?.handler, "function");
  assert.equal(typeof routes.get("GET /memory/wiki/health")?.handler, "function");
  assert.equal(typeof routes.get("POST /memory/wiki/page/read")?.handler, "function");
  assert.equal(typeof routes.get("POST /archive/review/request")?.handler, "function");
  assert.equal(typeof routes.get("POST /archive/review/artifact/promote")?.handler, "function");

  assert.equal(routes.get("POST /memory/settings")?.requiredCapability, "memory-settings-write");
  assert.equal(routes.get("POST /memory/source/browse")?.requiredCapability, "memory-source-browse");
  assert.equal(routes.get("POST /memory/source/scan")?.requiredCapability, "memory-source-scan");
  assert.equal(routes.get("POST /memory/source/action")?.requiredCapability, "memory-source-manage");
  assert.equal(routes.get("POST /memory/source/move-preflight")?.requiredCapability, "memory-source-move");
  assert.equal(routes.get("POST /memory/source/move-execute")?.requiredCapability, "memory-source-move");
  assert.equal(routes.get("POST /memory/source/move-rollback")?.requiredCapability, "memory-source-move");
  assert.equal(routes.get("POST /memory/source/review")?.requiredCapability, "memory-source-review");
  assert.equal(routes.get("POST /memory/source/intake")?.requiredCapability, "memory-source-intake");
  assert.equal(routes.get("POST /memory/source/file-intake")?.requiredCapability, "memory-source-file-intake");
  assert.equal(routes.get("POST /memory/source/sync")?.requiredCapability, "memory-source-file-intake");
  assert.equal(routes.get("POST /memory/search")?.requiredCapability, "archive-read");
  assert.equal(routes.get("POST /memory/wiki/page/read")?.requiredCapability, "archive-read");
  assert.equal(routes.get("POST /memory/wiki/lint")?.requiredCapability, "memory-source-review");
  assert.equal(routes.get("POST /memory/source/versions")?.requiredCapability, "memory-source-review");
  assert.equal(routes.get("POST /memory/source/versions/repair")?.requiredCapability, "memory-source-manage");
  assert.equal(routes.get("POST /memory/source/diff")?.requiredCapability, "memory-source-review");
  assert.equal(routes.get("POST /archive/intake")?.requiredCapability, "archive-write");
  assert.equal(routes.get("POST /archive/intake/list")?.requiredCapability, "archive-read");
  assert.equal(routes.get("POST /archive/intake/read")?.requiredCapability, "archive-read");
  assert.equal(routes.get("POST /archive/review/request")?.requiredCapability, "archive-write");
  assert.equal(routes.get("POST /archive/review/list")?.requiredCapability, "archive-read");
  assert.equal(routes.get("POST /archive/review/transition")?.requiredCapability, "archive-write");
  assert.equal(routes.get("POST /archive/review/draft")?.requiredCapability, "archive-write");
  assert.equal(routes.get("POST /archive/review/artifact/read")?.requiredCapability, "archive-read");
  assert.equal(routes.get("POST /archive/review/artifact/verify")?.requiredCapability, "archive-write");
  assert.equal(routes.get("POST /archive/review/verification/read")?.requiredCapability, "archive-read");
  assert.equal(routes.get("POST /archive/review/artifact/revise")?.requiredCapability, "archive-write");
  assert.equal(routes.get("POST /archive/review/artifact/promote")?.requiredCapability, "archive-write");
  assert.equal(routes.get("POST /archive/review/promotions/list")?.requiredCapability, "archive-read");
  assert.equal(routes.get("POST /archive/review/promotions/restore")?.requiredCapability, "archive-write");
});

test("memory host service fails fast when a route handler is missing", () => {
  const handlers = createHandlers();
  delete handlers.executeMemorySourceDiff;

  assert.throws(
    () => createMemoryHostService(handlers),
    /Memory host service missing handler: executeMemorySourceDiff/,
  );
});
