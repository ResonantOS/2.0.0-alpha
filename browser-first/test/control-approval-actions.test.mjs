import assert from "node:assert/strict";
import test from "node:test";

import { createControlApprovalActions } from "../resonantos-side-panel-extension/src/lib/control-approval-actions.js";

function createHarness(overrides = {}) {
  const events = [];
  const pendingApproval = overrides.pendingApproval ?? {
    reason: "safe click",
    step: { type: "click", text: "Continue" },
  };
  const currentControlRun = overrides.currentControlRun ?? {
    goal: "find a result",
    id: "run-1",
  };
  const runner = {
    approvePendingControlStep: async (approval) => events.push(["approve", approval]),
    denyPendingControlStep: async (approval) => events.push(["deny", approval]),
  };
  const taskConsentStore = {
    consumeTaskConsent: async (consent) => {
      events.push(["consume-consent", consent]);
      return consent;
    },
    setTaskConsent: async (consent) => {
      events.push(["set-consent", consent]);
      return {
        ...consent,
        taskClass: "research",
      };
    },
  };
  const actions = createControlApprovalActions({
    activeTab: async () => overrides.tab ?? { id: 7, url: "https://example.com/path" },
    addMessage: async (...args) => events.push(["message", ...args]),
    agentControlRunner: overrides.agentControlRunner ?? runner,
    approvalBoundaryForStep: overrides.approvalBoundaryForStep ?? (() => "safe"),
    controlStepLabel: overrides.controlStepLabel ?? ((step) => `${step.type}:${step.text ?? ""}`),
    getCurrentControlRun: () => Object.hasOwn(overrides, "currentControlRunValue") ? overrides.currentControlRunValue : currentControlRun,
    getPendingApproval: () => Object.hasOwn(overrides, "pendingApprovalValue") ? overrides.pendingApprovalValue : pendingApproval,
    renderControlMonitor: () => events.push(["render-control-monitor"]),
    renderTaskConsentPanel: async (tab) => events.push(["render-task-consent", tab]),
    siteKeyForUrl: (url) => String(url ?? "").replace(/^https?:\/\//, "").split("/")[0] || "unknown-site",
    taskConsentStore: overrides.taskConsentStore ?? taskConsentStore,
  });
  return { actions, events, pendingApproval };
}

test("control approval actions approve safe pending steps through the runner", async () => {
  const harness = createHarness();

  await harness.actions.approvePendingControlStep();

  assert.deepEqual(harness.events, [["approve", harness.pendingApproval]]);
});

test("control approval actions block hard-boundary automation", async () => {
  const harness = createHarness({
    approvalBoundaryForStep: () => "hard",
  });

  await harness.actions.approvePendingControlStep();

  assert.equal(harness.events.some((event) => event[0] === "approve"), false);
  assert.match(harness.events.find((event) => event[0] === "message")?.[2], /human-only/);
});

test("#240: control approval actions block public-submit automation", async () => {
  const harness = createHarness({
    approvalBoundaryForStep: () => "public-submit",
    pendingApproval: { reason: "public submit", step: { type: "click", text: "Submit public form" } },
  });

  await harness.actions.approvePendingControlStep();

  assert.equal(harness.events.some((event) => event[0] === "approve"), false, "public-submit must not reach the runner approve path");
  assert.match(harness.events.find((event) => event[0] === "message")?.[2], /human-only/);
});

test("control approval actions trust only safe task classes before approving", async () => {
  const harness = createHarness();

  await harness.actions.trustCurrentTaskForSafeActions();

  assert.deepEqual(harness.events[0], ["set-consent", {
    goal: "find a result",
    mode: "allow-safe",
    reason: "Trusted after approval for: click:Continue",
    siteKey: "example.com",
    source: "approval-card",
  }]);
  assert.match(harness.events.find((event) => event[0] === "message")?.[2], /Trusted safe research actions/);
  assert.ok(harness.events.some((event) => event[0] === "approve"));
  assert.ok(harness.events.some((event) => event[0] === "render-task-consent"));
});

test("control approval actions allow a safe task class once without persisting broad trust", async () => {
  const harness = createHarness();

  await harness.actions.allowCurrentTaskOnceForSafeActions();

  assert.deepEqual(harness.events[0], ["set-consent", {
    goal: "find a result",
    mode: "allow-once",
    reason: "Allowed once after approval for: click:Continue",
    siteKey: "example.com",
    source: "approval-card",
  }]);
  assert.ok(harness.events.some((event) => event[0] === "consume-consent" && event[1].taskClass === "research"));
  assert.match(harness.events.find((event) => event[0] === "message")?.[2], /for this execution only/);
  assert.ok(harness.events.some((event) => event[0] === "approve"));
});

test("control approval actions refuse broad trust for non-safe boundaries", async () => {
  const harness = createHarness({
    approvalBoundaryForStep: () => "public-submit",
  });

  await harness.actions.trustCurrentTaskForSafeActions();

  assert.equal(harness.events.some((event) => event[0] === "set-consent"), false);
  assert.equal(harness.events.some((event) => event[0] === "approve"), false);
  assert.match(harness.events.find((event) => event[0] === "message")?.[2], /Cannot trust this task class/);
  assert.ok(harness.events.some((event) => event[0] === "render-control-monitor"));
});

test("control approval actions refuse one-time task class consent for non-safe boundaries", async () => {
  const harness = createHarness({
    approvalBoundaryForStep: () => "public-submit",
  });

  await harness.actions.allowCurrentTaskOnceForSafeActions();

  assert.equal(harness.events.some((event) => event[0] === "set-consent"), false);
  assert.equal(harness.events.some((event) => event[0] === "approve"), false);
  assert.match(harness.events.find((event) => event[0] === "message")?.[2], /Cannot allow this task class once/);
  assert.ok(harness.events.some((event) => event[0] === "render-control-monitor"));
});

test("control approval actions deny through the runner", async () => {
  const harness = createHarness();

  await harness.actions.denyPendingControlStep();

  assert.deepEqual(harness.events, [["deny", harness.pendingApproval]]);
});

test("control approval actions no-op without pending approval or active run", async () => {
  const noApproval = createHarness({ pendingApprovalValue: null });
  const noRun = createHarness({ currentControlRunValue: null });

  await noApproval.actions.approvePendingControlStep();
  await noApproval.actions.trustCurrentTaskForSafeActions();
  await noApproval.actions.denyPendingControlStep();
  await noRun.actions.approvePendingControlStep();
  await noRun.actions.trustCurrentTaskForSafeActions();
  await noRun.actions.denyPendingControlStep();

  assert.deepEqual(noApproval.events, []);
  assert.deepEqual(noRun.events, []);
});
