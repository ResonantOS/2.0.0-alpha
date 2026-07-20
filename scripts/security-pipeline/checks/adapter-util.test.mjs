import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCore } from "./lib/adapter-util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

function runRecords(records, core) {
  return runCore({
    check: { surfaces: ["browser-first/host"], records },
    repoRoot: REPO_ROOT,
    core,
    label: "fixture-core",
  });
}

test("all throwing records make the aggregate unscored instead of pass", () => {
  const result = runRecords(
    [{ site: "fixture:throw-one" }, { site: "fixture:throw-two" }],
    () => {
      throw new Error("fixture failure");
    },
  );

  assert.equal(result.status, "warn");
  assert.match(result.summary, /2 unscored descriptor\(s\)/);
  assert.deepEqual(result.evidence.map(({ status }) => status), ["skipped", "skipped"]);
});

test("a throwing record makes a mixed pass aggregate non-pass", () => {
  const result = runRecords(
    [{ site: "fixture:pass", throws: false }, { site: "fixture:throw", throws: true }],
    (record) => {
      if (record.throws) throw new Error("fixture failure");
      return { result: "pass", site: record.site, evidence: [] };
    },
  );

  assert.equal(result.status, "warn");
  assert.match(result.summary, /1 unscored descriptor\(s\)/);
  assert.deepEqual(result.evidence.map(({ status }) => status), ["pass", "skipped"]);
});
