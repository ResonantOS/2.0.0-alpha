import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertResolvedSourceFileInsideSource,
  assertSourceRootDirectory,
  normalizeSourceRelativeFile,
  resolveSourceRelativeFile,
} from "../host/memory-source-paths.mjs";

test("source path helpers keep selected files inside the source root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resonantos-source-paths-"));
  const source = path.join(root, "vault");
  const outside = path.join(root, "outside");
  try {
    await mkdir(path.join(source, "notes"), { recursive: true });
    await mkdir(outside, { recursive: true });
    const note = path.join(source, "notes", "identity.md");
    const external = path.join(outside, "secret.md");
    await writeFile(note, "# Identity\n");
    await writeFile(external, "secret\n");

    assert.equal(normalizeSourceRelativeFile(" notes/./identity.md "), "notes/identity.md");
    assert.equal(normalizeSourceRelativeFile("notes//identity.md"), "notes/identity.md");
    assert.equal(resolveSourceRelativeFile(source, "notes/identity.md"), note);
    assert.throws(
      () => resolveSourceRelativeFile(source, "."),
      /must stay inside the connected source/
    );
    assert.throws(
      () => resolveSourceRelativeFile(source, "../outside/secret.md"),
      /must stay inside the connected source/
    );
    assert.throws(
      () => resolveSourceRelativeFile(source, "/tmp/secret.md"),
      /must stay inside the connected source/
    );
    assert.throws(
      () => resolveSourceRelativeFile(source, "C:\\Users\\secret.md"),
      /must stay inside the connected source/
    );
    assert.throws(
      () => resolveSourceRelativeFile(source, "notes\0identity.md"),
      /must stay inside the connected source/
    );
    await assert.doesNotReject(() => assertSourceRootDirectory(source));
    await assert.rejects(
      () => assertSourceRootDirectory(note),
      /must be a folder/
    );
    await assert.rejects(
      () => assertSourceRootDirectory(path.join(root, "missing")),
      /does not exist/
    );
    await assert.doesNotReject(() => assertResolvedSourceFileInsideSource(source, note));
    await assert.rejects(
      () => assertResolvedSourceFileInsideSource(source, path.join(source, "notes")),
      /regular file/
    );

    const link = path.join(source, "notes", "secret-link.md");
    try {
      await symlink(external, link);
      await assert.rejects(
        () => assertResolvedSourceFileInsideSource(source, link),
        /symbolic link/
      );
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
        t.skip("Windows symlink creation requires Developer Mode or elevated privileges.");
        return;
      }
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
