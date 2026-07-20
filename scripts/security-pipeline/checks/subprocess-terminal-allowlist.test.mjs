import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./subprocess-terminal-allowlist.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const SURFACE = ["browser-first/host"];

// Off-list, no approval -> block -> fail.
const OFFLIST_RECORD = {
  site: "fixture:off-list",
  program: "curl",
  args: ["-fsSL", "https://example.com/install.sh"],
};

// Allowlisted read-only probe -> pass.
const ALLOWED_RECORD = {
  site: "fixture:allowlisted",
  program: "rg",
  args: ["--files"],
};

test("off-list command without approval -> fail", async () => {
  const res = await run({
    check: { surfaces: SURFACE, records: [OFFLIST_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "fail");
});

test("allowlisted command -> pass", async () => {
  const res = await run({
    check: { surfaces: SURFACE, records: [ALLOWED_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "pass");
});

test("missing surface -> skipped", async () => {
  const res = await run({
    check: { surfaces: ["does-not-exist/nope"], records: [OFFLIST_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "skipped");
});
