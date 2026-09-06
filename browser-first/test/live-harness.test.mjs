import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stageExtensionCopy } from "./live-harness.mjs";

test("stageExtensionCopy creates an isolated extension tree without generated config or node_modules", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "resonantos-live-harness-repo-"));
  try {
    const extensionRoot = path.join(repoRoot, "browser-first", "resonantos-side-panel-extension");
    await mkdir(path.join(extensionRoot, "src"), { recursive: true });
    await mkdir(path.join(extensionRoot, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(extensionRoot, "manifest.json"), JSON.stringify({ manifest_version: 3 }));
    await writeFile(path.join(extensionRoot, "src", "side-panel.js"), "export {};\n");
    await writeFile(path.join(extensionRoot, "src", "bridge-config.generated.js"), "secret config\n");
    await writeFile(path.join(extensionRoot, "node_modules", "ignored", "package.json"), "{}\n");

    const staged = await stageExtensionCopy(repoRoot);
    try {
      assert.notEqual(staged.extensionRoot, extensionRoot);
      assert.equal(existsSync(path.join(staged.extensionRoot, "manifest.json")), true);
      assert.equal(await readFile(path.join(staged.extensionRoot, "src", "side-panel.js"), "utf8"), "export {};\n");
      assert.equal(existsSync(path.join(staged.extensionRoot, "src", "bridge-config.generated.js")), false);
      assert.equal(existsSync(path.join(staged.extensionRoot, "node_modules")), false);
    } finally {
      await staged.cleanup();
      assert.equal(existsSync(staged.root), false);
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
