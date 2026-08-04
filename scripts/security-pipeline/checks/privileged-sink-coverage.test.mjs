import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  comparePrivilegedSinkBaseline,
  run,
  scanPrivilegedSinks,
} from "./privileged-sink-coverage.mjs";

test("privileged sink coverage matches the checked-in repository baseline", async () => {
  const result = await run({
    check: {
      baseline: "scripts/security-pipeline/privileged-sink-baseline.json",
      scope: [
        "browser-first/host",
        "browser-first/resonantos-side-panel-extension/src",
        "addons/resonant-browser-host/src",
        "src/core",
        "src/modules",
      ],
    },
    repoRoot: process.cwd(),
  });
  assert.equal(result.status, "pass");
});

test("a newly added privileged sink fails until its baseline is reviewed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "privileged-sink-coverage-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const filePath = path.join(root, "src", "service.mjs");
    await writeFile(filePath, "export function safe() { return true; }\n");
    const baseline = await scanPrivilegedSinks({ repoRoot: root, scope: ["src"] });
    await writeFile(filePath, "export function unsafe() { return fetch('https://example.test'); }\n");
    const changed = await scanPrivilegedSinks({ repoRoot: root, scope: ["src"] });
    const comparison = comparePrivilegedSinkBaseline(changed, baseline);
    assert.equal(comparison.ok, false);
    assert.deepEqual(comparison.missingBaseline, ["src/service.mjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
