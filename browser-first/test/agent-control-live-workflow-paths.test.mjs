// #350: the live-browser certification must run for any change that can break the live panel.
// Guards the pull_request path filter of .github/workflows/agent-control-live.yml.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const WORKFLOW = new URL("../../.github/workflows/agent-control-live.yml", import.meta.url);

const REQUIRED_PATH_GLOBS = [
  "browser-first/host/**",
  "browser-first/host/opencode-version.json",
  "browser-first/test/live-harness.mjs",
  "browser-first/test/live-harness.test.mjs",
  "browser-first/test/live-sdk-lane.mjs",
  "browser-first/test/live-sdk-lane.test.mjs",
  "browser-first/test/settings-shapes-live.mjs",
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

test("live SDK workflow job installs pinned OpenCode and uploads evidence (#350)", async () => {
  const workflow = parse(await readFile(WORKFLOW, "utf8"));
  const job = workflow.jobs?.["live-sdk"];
  assert.ok(job, "workflow must include a live-sdk job");

  const install = job.steps.find((step) => /Install pinned OpenCode/i.test(step.name ?? ""));
  assert.ok(install, "live-sdk job must install the pinned OpenCode version");
  assert.match(
    install.run,
    /npm install -g --prefix "\$HOME\/\.local" opencode-ai@\$\(node -p "require\('\.\/browser-first\/host\/opencode-version\.json'\)\.pinned"\)/,
    "the pinned install must target $HOME/.local so the bridge's pinned-roots discovery can see the binary",
  );
  assert.equal(job.needs, undefined, "live-sdk must not depend on the agent-control job (independent evidence)");
  assert.equal(job["timeout-minutes"], 15);
  const selfTests = job.steps.find((step) => /Run live SDK fault self-tests/i.test(step.name ?? ""));
  assert.ok(selfTests, "live-sdk job must run the lane's fault self-tests where Chrome and the pinned binary exist");
  assert.match(selfTests.run, /^OPENCODE_COMMAND="\$HOME\/\.local\/bin\/opencode" xvfb-run -a node --test browser-first\/test\/live-sdk-lane\.test\.mjs$/, "self-tests launch Chrome (headless:false) and need the virtual display too");
  assert.equal(selfTests.env?.CI, "true", "self-tests must run in CI mode");
  assert.equal(selfTests.id, "live-sdk-self-tests");
  assert.equal(selfTests["continue-on-error"], true, "a self-test failure must not skip the certification run and its evidence upload");
  assert.ok(selfTests.env?.RESONANTOS_LIVE_CHROME_PATH, "self-tests need the setup-chrome path (no Playwright Chromium on the runner)");
  const certificationStep = job.steps.find((step) => step.id === "live-sdk-certification");
  assert.equal(certificationStep.env.OPENCODE_COMMAND, undefined, "OPENCODE_COMMAND must not be set via the Actions env context (no runner HOME there)");
  assert.match(certificationStep.run, /^OPENCODE_COMMAND="\$HOME\/\.local\/bin\/opencode" xvfb-run -a npm run test:browser-first:live-sdk$/,
  );

  const runStep = job.steps.find((step) => step.id === "live-sdk-certification");
  assert.ok(runStep, "live-sdk job must have a certification run step");
  assert.equal(runStep["continue-on-error"], true);
  assert.match(runStep.run, /xvfb-run -a npm run test:browser-first:live-sdk/);
  assert.equal(runStep.env.CI, "true");
  assert.ok(runStep.env.RESONANTOS_LIVE_CHROME_PATH);
  assert.ok(runStep.env.RESONANTOS_LIVE_ARTIFACT_DIR);

  const upload = job.steps.find((step) => /upload-artifact/.test(step.uses ?? "") && /live-sdk/.test(step.with?.name ?? ""));
  assert.ok(upload, "live-sdk job must upload live SDK evidence");
  assert.equal(upload.if, "always()");
  assert.match(upload.with.name, /live-sdk-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.equal(upload.with["retention-days"], 14);

  const reject = job.steps.find((step) => step.name === "Reject uncertified live SDK run");
  assert.match(reject.if, /steps\.live-sdk-self-tests\.outcome != 'success'/, "the reject step must also fail the job on a self-test failure");
  assert.ok(reject, "live-sdk job must reject uncertified runs");
  assert.match(reject.if, /steps\.live-sdk-certification\.outcome != 'success'/);
});

// #404 review: the settings-shapes check must never be able to skip the
// certification run and its evidence upload — mirror of the live-sdk
// self-test convention, plus path-filter and step pinning.
test("agent-control job pins the settings-shapes check without skipping certification (#404)", async () => {
  const workflow = parse(await readFile(WORKFLOW, "utf8"));
  const job = workflow.jobs?.["agent-control-live"];
  assert.ok(job, "workflow must include an agent-control-live job");

  const shapes = job.steps.find((step) => /Check rendered Settings component shapes/i.test(step.name ?? ""));
  assert.ok(shapes, "agent-control job must run the rendered settings-shapes check");
  assert.equal(shapes.id, "settings-shapes");
  assert.equal(
    shapes["continue-on-error"],
    true,
    "a shapes failure must not skip the certification run and its evidence upload",
  );
  assert.equal(shapes.env?.CI, "true");
  assert.ok(shapes.env?.RESONANTOS_LIVE_CHROME_PATH, "shapes check needs the setup-chrome path");
  assert.ok(shapes.env?.RESONANTOS_SETTINGS_ARTIFACT_DIR, "shapes check must declare its artifact dir");
  assert.match(shapes.run, /test:browser-first:settings-shapes/);

  const certification = job.steps.find((step) => step.name === "Run live Agent Control certification");
  assert.ok(certification, "agent-control job must keep its certification run");
  assert.equal(certification["continue-on-error"], true, "certification outcome must be surfaced, not skipped");
  assert.equal(certification.if, undefined, "certification must not be conditioned on the shapes outcome");

  const reject = job.steps.find((step) => step.name === "Reject uncertified run");
  assert.ok(reject, "agent-control job must reject uncertified runs");
  assert.match(reject.if, /steps\.certification\.outcome != 'success'/);
  assert.match(
    reject.if,
    /steps\.settings-shapes\.outcome != 'success'/,
    "the reject step must also fail the job on a shapes failure",
  );
});
