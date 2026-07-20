import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./subprocess-env-clear.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const SURFACE = ["browser-first/host"];

// Blanket inheritance: no env_clear, no injected vars -> block -> fail.
const LEAKY_RECORD = {
  site: "fixture:blanket-inherit",
  runtime: "hermes",
  env_clear: false,
  env_vars: [],
};

// Cleared + only allowlisted var -> pass.
const CLEAN_RECORD = {
  site: "fixture:cleared",
  runtime: "hermes",
  env_clear: true,
  env_vars: ["HERMES_HOME", "PATH"],
};

test("blanket env inheritance -> fail", async () => {
  const res = await run({
    check: { surfaces: SURFACE, records: [LEAKY_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "fail");
});

test("cleared + allowlisted vars -> pass", async () => {
  const res = await run({
    check: { surfaces: SURFACE, records: [CLEAN_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "pass");
});

test("missing surface -> skipped", async () => {
  const res = await run({
    check: { surfaces: ["does-not-exist/nope"], records: [LEAKY_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "skipped");
});
