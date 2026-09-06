// #350: the live-browser certification must run for any change that can break the live panel.
// Guards the pull_request path filter of .github/workflows/agent-control-live.yml.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const WORKFLOW = new URL("../../.github/workflows/agent-control-live.yml", import.meta.url);

const REQUIRED_PATH_GLOBS = [
  "browser-first/host/**",
  "browser-first/resonantos-side-panel-extension/src/**",
  "browser-first/resonantos-side-panel-extension/manifest.json",
  ".github/workflows/agent-control-live.yml",
  "package.json",
  "package-lock.json",
];

test("live certification workflow triggers on bridge host and extension source changes (#350)", async () => {
  const workflow = parse(await readFile(WORKFLOW, "utf8"));
  const pullRequest = workflow.on?.pull_request ?? workflow.true?.pull_request;
  assert.ok(pullRequest, "workflow must declare a pull_request trigger");
  assert.deepEqual(pullRequest.branches, ["dev"]);
  const paths = pullRequest.paths ?? [];
  for (const glob of REQUIRED_PATH_GLOBS) {
    assert.ok(paths.includes(glob), `pull_request.paths must include ${glob}`);
  }
});
