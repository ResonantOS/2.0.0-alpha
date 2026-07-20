import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  createLiveCertificationReport,
  decidePublicSubmitScenario,
  decideUnavailableCertification,
  sanitizeEvidenceText,
} from "./agent-control-live-report.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("CI-unavailable certification is non-passing while a local sandbox denial is an explicit skip", () => {
  assert.deepEqual(decideUnavailableCertification({ ci: true, reason: "Chrome missing" }), {
    status: "not-certified",
    exitCode: 78,
    reason: "Chrome missing",
  });
  assert.deepEqual(decideUnavailableCertification({ ci: false, reason: "Loopback denied" }), {
    status: "not-certified",
    exitCode: 0,
    reason: "Loopback denied",
  });
});

test("public-submit live proof gates legacy behavior and passes only the #240 human handoff", () => {
  assert.deepEqual(decidePublicSubmitScenario({ mode: "auto", humanHandoff: false }), {
    status: "gated",
    reason: "#240 human-only public-submit handoff is not present in this revision.",
  });
  assert.deepEqual(decidePublicSubmitScenario({ mode: "auto", humanHandoff: true }), {
    status: "passed",
    reason: "#240 human-only public-submit handoff is active and no executable approval is exposed.",
  });
  assert.deepEqual(decidePublicSubmitScenario({ mode: "required", humanHandoff: false }), {
    status: "failed",
    reason: "#240 human-only public-submit handoff was required but the legacy approval path remained.",
  });
});

test("certification evidence redacts tokens and private paths", () => {
  const value = sanitizeEvidenceText(
    "bridgeToken=secret-bridge capability-token: secret-cap /home/alice/private/repo C:\\Users\\alice\\private",
    { roots: ["/home/alice/private/repo"] },
  );
  assert.doesNotMatch(value, /secret-bridge|secret-cap|alice|private\/repo/);
  assert.match(value, /\[redacted-token\]/);
  assert.match(value, /\[redacted-path\]/);
});

test("certification report emits a scenario matrix without absolute artifact paths", async () => {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "resonantos-live-report-test-"));
  try {
    const report = createLiveCertificationReport({
      artifactDir,
      profile: "agent-control",
      roots: ["/home/alice/private/repo"],
      runId: "123",
      runAttempt: "2",
    });
    report.assert(true, "safe click remained bounded");
    report.record("post-approval-public-submit", "gated", "pending #240");
    const output = await report.write({
      status: "passed-with-gates",
      screenshots: [{ ok: true, path: "/tmp/panel.png" }],
      error: new Error("failed under /home/alice/private/repo bridgeToken=secret"),
    });

    const json = await readFile(output.jsonPath, "utf8");
    const markdown = await readFile(output.markdownPath, "utf8");
    assert.doesNotMatch(json, /\/home\/alice|bridgeToken=secret|\/tmp\/panel\.png/);
    assert.doesNotMatch(markdown, /\/home\/alice|bridgeToken=secret|\/tmp\/panel\.png/);
    assert.match(json, /"post-approval-public-submit"/);
    assert.match(markdown, /passed-with-gates/);
    assert.match(json, /"path": "panel.png"/);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("forced Chrome unavailability cannot certify a CI run and still emits evidence", async () => {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "resonantos-live-unavailable-test-"));
  try {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "browser-first", "test", "agent-control-live.mjs")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: "true",
        RESONANTOS_LIVE_ARTIFACT_DIR: artifactDir,
        RESONANTOS_LIVE_FORCE_UNAVAILABLE: "1",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 78, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(await readFile(path.join(artifactDir, "scenario-matrix.json"), "utf8"));
    assert.equal(payload.status, "not-certified");
    assert.equal(payload.scenarios[0].id, "environment-chrome");
    assert.equal(payload.scenarios[0].status, "failed");
    await readFile(path.join(artifactDir, "scenario-matrix.md"), "utf8");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("live Agent Control workflow is dedicated, pinned, path-filtered, nightly, and uploads evidence", async () => {
  const workflowPath = path.join(repoRoot, ".github", "workflows", "agent-control-live.yml");
  const source = await readFile(workflowPath, "utf8");
  const workflow = parse(source);
  const trigger = workflow.on;
  const job = workflow.jobs["agent-control-live"];

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(trigger.pull_request.paths.includes("browser-first/resonantos-side-panel-extension/src/lib/agent-control*"));
  assert.ok(trigger.pull_request.paths.includes("browser-first/resonantos-side-panel-extension/src/lib/control-*"));
  assert.ok(trigger.pull_request.paths.includes("browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js"));
  assert.ok(trigger.pull_request.paths.includes("browser-first/resonantos-side-panel-extension/src/content.js"));
  assert.ok(trigger.pull_request.paths.includes("browser-first/resonantos-side-panel-extension/src/lib/content-field-safety.js"));
  assert.ok(trigger.pull_request.paths.includes("browser-first/test/agent-control-live.mjs"));
  assert.equal(trigger.schedule.length, 1);

  const uses = job.steps.filter((step) => step.uses).map((step) => step.uses);
  assert.ok(uses.length >= 3);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);

  const runStep = job.steps.find((step) => step.id === "certification");
  assert.equal(runStep["continue-on-error"], true);
  assert.match(runStep.run, /xvfb-run -a npm run test:browser-first:live/);
  assert.equal(runStep.env.CI, "true");

  const upload = job.steps.find((step) => /upload-artifact/.test(step.uses ?? ""));
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["retention-days"], 14);
  assert.match(upload.with.name, /github\.run_id/);
  assert.match(upload.with.name, /github\.run_attempt/);

  const failStep = job.steps.find((step) => step.name === "Reject uncertified run");
  assert.match(failStep.if, /steps\.certification\.outcome != 'success'/);
  assert.match(failStep.run, /exit 1/);
});
