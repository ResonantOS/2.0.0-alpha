import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalBoundaryForStep,
  sanitizeNextActionDecision,
  sanitizePlannerPlan,
  sanitizePlannerStep,
  sanitizePlannerUrl,
} from "../resonantos-side-panel-extension/src/lib/approval-policy.js";

test("approval policy classifies hard wallet, credential, and signing boundaries", () => {
  assert.equal(approvalBoundaryForStep({ type: "click", text: "Connect Wallet" }), "hard");
  assert.equal(approvalBoundaryForStep({ type: "type", field: "Password", text: "secret" }), "hard");
  assert.equal(approvalBoundaryForStep({ type: "type", field: "Email address", text: "person@example.com" }, "Personal contact fields require a human-controlled autofill flow."), "hard");
  assert.equal(approvalBoundaryForStep({ type: "type", field: "Card number", text: "4111111111111111" }, "Payment and wallet fields are human-only."), "hard");
  assert.equal(approvalBoundaryForStep({ type: "click", text: "Submit public form" }), "public-submit");
  assert.equal(approvalBoundaryForStep({ type: "click", text: "Submit" }, "Clicking Submit requires human approval."), "public-submit");
  assert.equal(approvalBoundaryForStep({ type: "click", text: "Details" }, "Safe action requires human approval."), "safe");
  assert.equal(approvalBoundaryForStep({ type: "click", text: "Details" }), "safe");
});

test("approval policy rejects unsafe planner URLs and restricted targets", () => {
  assert.equal(sanitizePlannerUrl("resonantos.com/dao"), "https://resonantos.com/dao");
  assert.throws(() => sanitizePlannerUrl("file:///tmp/secret.txt"), /http and https/);
  assert.throws(() => sanitizePlannerStep({ type: "open", target: "phantom://wallet" }), /http and https|restricted/);
});

test("approval policy sanitizes safe planner steps", () => {
  assert.deepEqual(sanitizePlannerStep({ type: "inspect" }), { type: "read" });
  assert.deepEqual(sanitizePlannerStep({ type: "search", action: "news", query: "AI browsers" }), {
    type: "search",
    action: "news",
    query: "AI browsers",
  });
  assert.deepEqual(sanitizePlannerStep({ type: "type", text: "pizza stone", submit: true }), {
    type: "type",
    text: "pizza stone",
    field: "",
    ref: "",
    submit: true,
  });
});

test("approval policy blocks restricted clicks and typing", () => {
  assert.throws(() => sanitizePlannerStep({ type: "click", text: "Approve transaction" }), /restricted click/);
  assert.throws(() => sanitizePlannerStep({ type: "type", text: "seed phrase words" }), /restricted typing/);
});

test("approval policy sanitizes planner plans and next-action decisions", () => {
  const plan = sanitizePlannerPlan({
    source: "test",
    summary: "Open and read",
    steps: [{ type: "open", target: "resonantos.com" }, { type: "read" }],
  });
  assert.equal(plan.needsApproval, false);
  assert.equal(plan.steps.length, 2);

  assert.deepEqual(sanitizePlannerPlan({ needsApproval: true, approvalReason: "Wallet action" }).steps, []);
  assert.equal(sanitizeNextActionDecision({ status: "done", thought: "finished" }).doneSummary, "finished");
  assert.equal(sanitizeNextActionDecision({ status: "blocked", thought: "unsafe" }).approvalReason, "unsafe");
  const approvalDecision = sanitizeNextActionDecision({
    status: "needs_approval",
    approvalReason: "Public action requires a human.",
    proposedAction: { type: "click", text: "Submit public form" },
  });
  assert.equal(approvalDecision.action, null);
  assert.deepEqual(approvalDecision.proposedAction, { type: "click", text: "Submit public form", ref: "" });
  const decision = sanitizeNextActionDecision({
    status: "continue",
    action: { type: "scroll", direction: "sideways" },
    strategyPhase: "Read first",
    strategyRationale: "Use page-work runbook",
    completionCheck: "Visible page proves progress",
    scenarioName: "Generic page control",
    preferredProbes: ["Read page title", ""],
    successSignals: ["URL matches goal"],
    stopConditions: ["Wallet action required"]
  });
  assert.equal(decision.action.direction, "down");
  assert.equal(decision.strategyPhase, "Read first");
  assert.equal(decision.strategyRationale, "Use page-work runbook");
  assert.equal(decision.completionCheck, "Visible page proves progress");
  assert.equal(decision.scenarioName, "Generic page control");
  assert.deepEqual(decision.preferredProbes, ["Read page title"]);
  assert.deepEqual(decision.successSignals, ["URL matches goal"]);
  assert.deepEqual(decision.stopConditions, ["Wallet action required"]);
});
