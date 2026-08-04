import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  lineDiffSummary,
  listSourceFileVersions,
  recordSourceFileIntakeArtifact,
  reserveSourceFileVersion,
  rollbackSourceFileVersionReservation,
  sourceContentHash,
  sourceFileSnapshotPath,
  writeSourceFileSnapshot,
} from "../host/memory-source-versioning.mjs";

async function removeTestRoot(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test("source file versioning increments only when content changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-source-versioning-"));
  const manifestPath = path.join(root, "Memory", "CONFIG", "source-file-versions.json");
  try {
    const firstHash = sourceContentHash("# First\n");
    const first = await reserveSourceFileVersion({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      contentHash: firstHash,
      sourceModifiedAt: "2026-05-29T10:00:00.000Z",
      now: "2026-05-29T10:01:00.000Z",
    });
    assert.deepEqual(first, {
      changed: true,
      version: 1,
      contentHash: firstHash,
      previousHash: "",
      previousVersion: 0,
    });

    const duplicate = await reserveSourceFileVersion({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      contentHash: firstHash,
      sourceModifiedAt: "2026-05-29T10:00:00.000Z",
      now: "2026-05-29T10:02:00.000Z",
    });
    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.version, 1);
    assert.equal(duplicate.previousHash, firstHash);

    const secondHash = sourceContentHash("# First\n\nUpdated.\n");
    const second = await reserveSourceFileVersion({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      contentHash: secondHash,
      sourceModifiedAt: "2026-05-29T11:00:00.000Z",
      now: "2026-05-29T11:01:00.000Z",
    });
    assert.equal(second.changed, true);
    assert.equal(second.version, 2);
    assert.equal(second.previousHash, firstHash);
    assert.equal(second.previousVersion, 1);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.files["source-vault::notes/identity.md"];
    assert.equal(entry.latestHash, secondHash);
    assert.equal(entry.latestVersion, 2);
    assert.equal(entry.history.length, 2);

    const recorded = await recordSourceFileIntakeArtifact({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      version: 2,
      intakePath: "INTAKE/sources/identity-v2.md",
      snapshotPath: sourceFileSnapshotPath(secondHash),
    });
    assert.equal(recorded.latestIntakePath, "INTAKE/sources/identity-v2.md");
    assert.equal(recorded.latestSnapshotPath, sourceFileSnapshotPath(secondHash));

    const listed = await listSourceFileVersions({ manifestPath, sourceId: "source-vault" });
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0].sourceFile, "notes/identity.md");
    assert.equal(listed.entries[0].latestVersion, 2);
    assert.equal(listed.entries[0].latestIntakePath, "INTAKE/sources/identity-v2.md");
    assert.equal(listed.entries[0].latestSnapshotPath, sourceFileSnapshotPath(secondHash));
  } finally {
    await removeTestRoot(root);
  }
});

test("source file snapshots are content-addressed immutable history blobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-source-snapshots-"));
  try {
    const content = "# Snapshot\n\nHuman source version.\n";
    const contentHash = sourceContentHash(content);
    const snapshot = await writeSourceFileSnapshot({
      memoryRoot: path.join(root, "Memory"),
      contentHash,
      content,
    });
    assert.equal(snapshot.path, sourceFileSnapshotPath(contentHash));
    assert.equal(snapshot.reused, false);
    assert.equal(await readFile(path.join(root, "Memory", snapshot.path), "utf8"), content);

    const reused = await writeSourceFileSnapshot({
      memoryRoot: path.join(root, "Memory"),
      contentHash,
      content,
    });
    assert.equal(reused.reused, true);
    assert.equal(await readFile(path.join(root, "Memory", snapshot.path), "utf8"), content);
  } finally {
    await removeTestRoot(root);
  }
});

test("source file snapshots reject claimed hash mismatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-source-snapshot-mismatch-"));
  try {
    const content = "# Snapshot\n\nHuman source version.\n";
    const contentHash = sourceContentHash(content);
    await assert.rejects(
      () => writeSourceFileSnapshot({
        memoryRoot: path.join(root, "Memory"),
        contentHash,
        content: "different content with the same claimed hash should not write\n",
      }),
      /does not match the claimed content hash/
    );
    await assert.rejects(
      () => readFile(path.join(root, "Memory", sourceFileSnapshotPath(contentHash)), "utf8"),
      /ENOENT/
    );
  } finally {
    await removeTestRoot(root);
  }
});

test("source file snapshots reject corrupt existing blobs before reuse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-source-snapshot-corrupt-"));
  try {
    const content = "# Snapshot\n\nHuman source version.\n";
    const contentHash = sourceContentHash(content);
    const absoluteSnapshotPath = path.join(root, "Memory", sourceFileSnapshotPath(contentHash));
    await mkdir(path.dirname(absoluteSnapshotPath), { recursive: true });
    await writeFile(absoluteSnapshotPath, "corrupted bytes\n", "utf8");

    await assert.rejects(
      () => writeSourceFileSnapshot({
        memoryRoot: path.join(root, "Memory"),
        contentHash,
        content,
      }),
      /existing snapshot is corrupt/
    );
    assert.equal(await readFile(absoluteSnapshotPath, "utf8"), "corrupted bytes\n");
  } finally {
    await removeTestRoot(root);
  }
});

test("source file versioning rolls back unfinalized reservations only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-source-versioning-rollback-"));
  const manifestPath = path.join(root, "Memory", "CONFIG", "source-file-versions.json");
  try {
    const firstHash = sourceContentHash("first");
    await reserveSourceFileVersion({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      contentHash: firstHash,
      sourceModifiedAt: "2026-05-29T10:00:00.000Z",
      now: "2026-05-29T10:01:00.000Z",
    });
    const secondHash = sourceContentHash("second");
    const second = await reserveSourceFileVersion({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      contentHash: secondHash,
      sourceModifiedAt: "2026-05-29T11:00:00.000Z",
      now: "2026-05-29T11:01:00.000Z",
    });

    const rolledBack = await rollbackSourceFileVersionReservation({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      version: second.version,
      contentHash: secondHash,
      now: "2026-05-29T11:02:00.000Z",
    });
    assert.deepEqual(rolledBack, {
      rolledBack: true,
      sourceId: "source-vault",
      sourceFile: "notes/identity.md",
      restoredVersion: 1,
    });
    let listed = await listSourceFileVersions({ manifestPath, sourceId: "source-vault" });
    assert.equal(listed.entries[0].latestVersion, 1);
    assert.equal(listed.entries[0].latestHash, firstHash);

    const thirdHash = sourceContentHash("third");
    const third = await reserveSourceFileVersion({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      contentHash: thirdHash,
      sourceModifiedAt: "2026-05-29T12:00:00.000Z",
      now: "2026-05-29T12:01:00.000Z",
    });
    await recordSourceFileIntakeArtifact({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      version: third.version,
      intakePath: "INTAKE/sources/identity-v2.md",
      snapshotPath: sourceFileSnapshotPath(thirdHash),
    });
    const finalized = await rollbackSourceFileVersionReservation({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      version: third.version,
      contentHash: thirdHash,
    });
    assert.deepEqual(finalized, {
      rolledBack: false,
      reason: "reservation-already-finalized",
    });
    listed = await listSourceFileVersions({ manifestPath, sourceId: "source-vault" });
    assert.equal(listed.entries[0].latestVersion, 2);
    assert.equal(listed.entries[0].latestIntakePath, "INTAKE/sources/identity-v2.md");
    assert.equal(listed.entries[0].latestSnapshotPath, sourceFileSnapshotPath(thirdHash));
  } finally {
    await removeTestRoot(root);
  }
});

test("source file artifact recording rejects stale version targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-source-versioning-stale-record-"));
  const manifestPath = path.join(root, "Memory", "CONFIG", "source-file-versions.json");
  try {
    const firstHash = sourceContentHash("first");
    const first = await reserveSourceFileVersion({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      contentHash: firstHash,
      sourceModifiedAt: "2026-05-29T10:00:00.000Z",
      now: "2026-05-29T10:01:00.000Z",
    });
    const secondHash = sourceContentHash("second");
    const second = await reserveSourceFileVersion({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      contentHash: secondHash,
      sourceModifiedAt: "2026-05-29T11:00:00.000Z",
      now: "2026-05-29T11:01:00.000Z",
    });

    await assert.rejects(
      () => recordSourceFileIntakeArtifact({
        manifestPath,
        sourceId: "source-vault",
        relativeFile: "notes/identity.md",
        version: first.version,
        intakePath: "INTAKE/sources/stale.md",
        snapshotPath: sourceFileSnapshotPath(firstHash),
      }),
      /must target the latest reserved source version/
    );

    const listed = await listSourceFileVersions({ manifestPath, sourceId: "source-vault" });
    assert.equal(listed.entries[0].latestVersion, second.version);
    assert.equal(listed.entries[0].latestHash, secondHash);
    assert.equal(listed.entries[0].latestIntakePath, "");
  } finally {
    await removeTestRoot(root);
  }
});

test("source file versioning rejects unsafe source file paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-source-versioning-paths-"));
  const manifestPath = path.join(root, "Memory", "CONFIG", "source-file-versions.json");
  try {
    await assert.rejects(
      () => reserveSourceFileVersion({
        manifestPath,
        sourceId: "source-vault",
        relativeFile: "../outside.md",
        contentHash: sourceContentHash("outside"),
      }),
      /Source file must be a safe relative path/
    );
    await assert.rejects(
      () => reserveSourceFileVersion({
        manifestPath,
        sourceId: "source-vault",
        relativeFile: path.resolve(root, "absolute.md"),
        contentHash: sourceContentHash("absolute"),
      }),
      /Source file must be a safe relative path/
    );
  } finally {
    await removeTestRoot(root);
  }
});

test("source file artifact recording keeps intake and snapshot paths inside managed roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-source-versioning-managed-paths-"));
  const manifestPath = path.join(root, "Memory", "CONFIG", "source-file-versions.json");
  try {
    const contentHash = sourceContentHash("managed source");
    const version = await reserveSourceFileVersion({
      manifestPath,
      sourceId: "source-vault",
      relativeFile: "notes/identity.md",
      contentHash,
    });
    await assert.rejects(
      () => recordSourceFileIntakeArtifact({
        manifestPath,
        sourceId: "source-vault",
        relativeFile: "notes/identity.md",
        version: version.version,
        intakePath: "AI_MEMORY/wiki/identity.md",
        snapshotPath: sourceFileSnapshotPath(contentHash),
      }),
      /Source file intake path must stay under INTAKE/
    );
    await assert.rejects(
      () => recordSourceFileIntakeArtifact({
        manifestPath,
        sourceId: "source-vault",
        relativeFile: "notes/identity.md",
        version: version.version,
        intakePath: "INTAKE/sources/identity.md",
        snapshotPath: "INTAKE/sources/not-a-snapshot.md",
      }),
      /Source file snapshot path must stay under CONFIG\/source-file-history/
    );

    const listed = await listSourceFileVersions({ manifestPath, sourceId: "source-vault" });
    assert.equal(listed.entries[0].latestIntakePath, "");
    assert.equal(listed.entries[0].latestSnapshotPath, "");
  } finally {
    await removeTestRoot(root);
  }
});

test("line diff summary returns bounded added and removed lines", () => {
  const diff = lineDiffSummary("A\nB\nC", "A\nBee\nC\nD", { limit: 10 });
  assert.equal(diff.changed, true);
  assert.equal(diff.previousLines, 3);
  assert.equal(diff.currentLines, 4);
  assert.deepEqual(diff.changes, [
    { type: "removed", line: 2, text: "B" },
    { type: "added", line: 2, text: "Bee" },
    { type: "added", line: 4, text: "D" },
  ]);
});
