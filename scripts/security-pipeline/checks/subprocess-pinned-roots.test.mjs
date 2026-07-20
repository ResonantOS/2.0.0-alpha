import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./subprocess-pinned-roots.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const SURFACE = ["browser-first/host"];

// Unpinned: resolved from CWD -> block -> fail.
const UNPINNED_RECORD = {
  site: "fixture:unpinned-load",
  kind: "native-library",
  program: "libBridge.so",
  resolution: { base: "cwd", path: "addons/libBridge.so" },
};

// Pinned: absolute system path -> pass.
const PINNED_RECORD = {
  site: "fixture:pinned-load",
  kind: "binary",
  program: "ditto",
  resolution: { base: "absolute", path: "/usr/bin/ditto" },
};

test("unpinned native load -> fail", async () => {
  const res = await run({
    check: { surfaces: SURFACE, records: [UNPINNED_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "fail");
});

test("pinned absolute path -> pass", async () => {
  const res = await run({
    check: { surfaces: SURFACE, records: [PINNED_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "pass");
});

test("missing surface -> skipped", async () => {
  const res = await run({
    check: { surfaces: ["does-not-exist/nope"], records: [UNPINNED_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "skipped");
});
