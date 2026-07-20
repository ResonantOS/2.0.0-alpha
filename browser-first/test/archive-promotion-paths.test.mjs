import assert from "node:assert/strict";
import test from "node:test";

import { promotionBackupFilename, promotionBackupPath } from "../host/archive-promotion-paths.mjs";

const toPortablePath = (value) => String(value ?? "").replace(/\\/g, "/");

test("promotion backup filenames include the full wiki-relative path identity", () => {
  const first = promotionBackupFilename("AI_MEMORY/wiki/projects/dao/index.md");
  const second = promotionBackupFilename("AI_MEMORY/wiki/people/dao/index.md");

  assert.match(first, /^projects-dao-index-[a-f0-9]{12}\.md$/);
  assert.match(second, /^people-dao-index-[a-f0-9]{12}\.md$/);
  assert.notEqual(first, second);
});

test("promotion backup filenames are stable and markdown-safe", () => {
  assert.equal(
    promotionBackupFilename("AI_MEMORY/wiki/Projects/DAO Index.markdown"),
    promotionBackupFilename("AI_MEMORY/wiki/Projects/DAO Index.markdown")
  );
  assert.match(
    promotionBackupFilename("../outside/page.txt"),
    /^outside-page-[a-f0-9]{12}\.md$/
  );
});

test("promotion backup paths stay under the selected backup category", () => {
  const promotionPath = promotionBackupPath({
    memoryRoot: "/tmp/ResonantOS_User/Memory",
    pagePath: "AI_MEMORY/wiki/projects/dao/index.md",
    timestamp: "2026-06-01T10:00:00.000Z",
    category: "promotions",
  });
  const restorePath = promotionBackupPath({
    memoryRoot: "/tmp/ResonantOS_User/Memory",
    pagePath: "AI_MEMORY/wiki/projects/dao/index.md",
    timestamp: "2026-06-01T10:00:00.000Z",
    category: "restores",
  });

  assert.match(toPortablePath(promotionPath), /AI_MEMORY\/backups\/promotions\/2026-06-01T10-00-00-000Z\/projects-dao-index-[a-f0-9]{12}\.md$/);
  assert.match(toPortablePath(restorePath), /AI_MEMORY\/backups\/restores\/2026-06-01T10-00-00-000Z\/projects-dao-index-[a-f0-9]{12}\.md$/);
});
