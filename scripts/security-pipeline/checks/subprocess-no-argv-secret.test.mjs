import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./subprocess-no-argv-secret.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// repoRoot such that <repoRoot>/browser-first/host exists (2.0.0-alpha).
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const SURFACE = ["browser-first/host"];

const exampleSecret = ["sk", "ant", "api03", "EXAMPLEEXAMPLE"].join("-");

const SECRET_RECORD = {
  site: "fixture:argv-secret",
  program: "hermes",
  args: ["chat", "-q", "Summarize the doc", "-H", `Authorization: Bearer ${exampleSecret}`],
};

const CLEAN_RECORD = {
  site: "fixture:clean",
  program: "hermes",
  args: ["--version"],
};

test("secret on argv -> fail", async () => {
  const res = await run({
    check: { surfaces: SURFACE, records: [SECRET_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "fail");
  assert.ok(res.evidence.some((e) => e.status === "fail"));
});

test("clean argv -> pass", async () => {
  const res = await run({
    check: { surfaces: SURFACE, records: [CLEAN_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "pass");
});

test("missing surface -> skipped", async () => {
  const res = await run({
    check: { surfaces: ["does-not-exist/nope"], records: [SECRET_RECORD] },
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.status, "skipped");
});
