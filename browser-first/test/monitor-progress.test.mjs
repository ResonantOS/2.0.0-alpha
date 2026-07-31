import assert from "node:assert/strict";
import test from "node:test";

import {
  controlActionStateLabel,
  controlRunPhase,
  controlRunPhaseLabel,
  controlRunProgress,
  controlRunProgressSummary,
  controlRunSummary,
  formatDurationMs,
  sitePermissionDescription,
} from "../resonantos-side-panel-extension/src/lib/monitor-progress.js";

test("monitor progress helpers describe site permission modes and phases", () => {
  assert.match(sitePermissionDescription("blocked"), /nothing on this site/);
  assert.match(sitePermissionDescription("read-only"), /page text, controls, fields, frames, and metadata/);
  assert.match(sitePermissionDescription("trusted-for-safe-actions"), /safe clicks/);
  assert.match(sitePermissionDescription("ask-before-action"), /asks before risky clicks/);

  assert.equal(controlRunPhase({ status: "running", currentStep: { type: "read" } }), "reading");
  assert.equal(controlRunPhase({ status: "running", currentStep: { type: "open" } }), "navigating");
  assert.equal(controlRunPhase({ status: "running", currentStep: { type: "click" } }), "acting");
  assert.equal(controlRunPhase({ status: "approval", currentStep: { type: "click" } }), "approval");
  assert.equal(controlRunPhaseLabel("cancelled"), "Stopped");
  assert.equal(controlRunPhaseLabel("unknown"), "Working");
});

test("monitor progress helpers calculate summaries and labels", () => {
  const run = {
    status: "running",
    steps: [{ state: "completed" }, { state: "active", type: "click" }, { state: "pending" }],
  };

  assert.deepEqual(controlRunProgress(run), {
    active: 1,
    activeLabel: "step 2/3",
    blocked: -1,
    blockedCount: 0,
    completed: 1,
    currentStep: { state: "active", type: "click" },
    failed: 0,
    label: "running · step 2/3",
    pending: 1,
    percent: 33,
    phase: "acting",
    terminal: 1,
    total: 3,
  });
  assert.equal(controlRunProgressSummary(run), "Acting · 1/3 complete · 1 queued · 33%");
  assert.equal(controlActionStateLabel("blocked"), "needs review");
  assert.equal(controlActionStateLabel(""), "queued");
  assert.equal(formatDurationMs(450), "450 ms");
  assert.equal(formatDurationMs(1_250), "1.3 sec");
  assert.equal(formatDurationMs(62_000), "1 min 2 sec");
});

test("monitor progress helpers summarize terminal runs", () => {
  assert.deepEqual(controlRunSummary({ status: "completed", steps: [{ state: "completed" }] }), {
    state: "completed",
    title: "Task completed",
    body: "1/1 actions completed. Review the trace below or save the report to Living Archive intake.",
  });
  assert.match(controlRunSummary({
    status: "approval",
    steps: [{ state: "active", type: "click" }],
  }).body, /approve once/);
  assert.match(controlRunSummary({
    status: "blocked",
    steps: [{ state: "blocked", details: { nextHumanAction: "Pick the target." } }],
  }).body, /Pick the target/);
  assert.equal(controlRunSummary({ status: "running", steps: [] }), null);
  assert.deepEqual(controlRunSummary({
    status: "cancelled",
    steps: [{ state: "cancelled", details: { nextHumanAction: "Review the page state." } }],
  }), {
    state: "cancelled",
    title: "Task stopped",
    body: "Augmentor stopped before the next browser action. No pending approval or page control remains active. Review the page state, then continue the job, start a new task, or save a report.",
  });
});
