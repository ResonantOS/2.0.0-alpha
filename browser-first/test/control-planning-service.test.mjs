import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlanningService } from "../resonantos-side-panel-extension/src/lib/control-planning-service.js";

function createHarness(overrides = {}) {
  const calls = [];
  const bridgeRequest = async (path, request) => {
    calls.push(["bridge", path, request.body]);
    if (overrides.bridgeError) throw new Error(overrides.bridgeError);
    if (path === "/augmentor/control-plan") {
      return overrides.planResponse ?? {
        plan: {
          summary: "Open and read",
          steps: [{ type: "open", target: "https://example.com/" }, { type: "read" }]
        }
      };
    }
    if (path === "/augmentor/next-action") {
      return overrides.decisionResponse ?? {
        decision: {
          status: "continue",
          thought: "Open the requested site",
          action: { type: "open", target: "https://example.com/" }
        }
      };
    }
    throw new Error(`Unexpected path ${path}`);
  };
  const service = createControlPlanningService({
    bridgeRequest,
    getLastSnapshot: () => overrides.lastSnapshot ?? { title: "Last", url: "https://last.example/" },
    getModel: () => "MiniMax-M3",
    getThinkingDepth: () => "high",
    globalScope: overrides.globalScope ?? {},
    readActivePage: async () => {
      calls.push(["read"]);
      if (overrides.readError) throw new Error(overrides.readError);
      return overrides.snapshotResponse ?? { snapshot: { title: "Active", url: "https://active.example/" } };
    }
  });
  return { calls, service };
}

test("control planning service requests and sanitizes full plans through the bridge", async () => {
  const harness = createHarness({
    planResponse: {
      plan: {
        source: "remote",
        summary: "duplicated plan",
        steps: [
          { type: "open", target: "https://example.com/" },
          { type: "open", target: "https://example.com/" }
        ]
      }
    }
  });

  const plan = await harness.service.requestControlPlan("open example", { title: "Page" });

  assert.equal(plan.source, "remote");
  assert.equal(plan.steps.length, 1);
  assert.equal(harness.calls[0][0], "bridge");
  assert.equal(harness.calls[0][1], "/augmentor/control-plan");
  assert.equal(harness.calls[0][2].goal, "open example");
  assert.equal(harness.calls[0][2].model, "MiniMax-M3");
  assert.equal(harness.calls[0][2].thinkingDepth, "high");
  assert.deepEqual(harness.calls[0][2].pageSnapshot, { title: "Page" });
  assert.equal(harness.calls[0][2].runbook.taskClass, "page-work");
  assert.equal(harness.calls[0][2].runbook.scenarioId, "generic-page-control");
  assert.match(harness.calls[0][2].runbook.strategy, /generic page control scenario runbook/);
  assert.ok(harness.calls[0][2].runbook.successSignals.some((signal) => /current URL/.test(signal)));
  assert.ok(harness.calls[0][2].runbook.stopConditions.some((condition) => /target control/.test(condition)));
  assert.notDeepEqual(harness.calls[0], [
    "bridge",
    "/augmentor/control-plan",
    {
      goal: "open example",
      model: "MiniMax-M3",
      thinkingDepth: "high",
      pageSnapshot: { title: "Page" }
    }
  ]);
  assert.equal(harness.calls[0][2].runbook.taskClass, "page-work");
});

test("control planning service supports test planner overrides behind sanitizer", async () => {
  const harness = createHarness({
    globalScope: {
      __resonantosControlPlannerOverride: async () => ({
        summary: "override",
        steps: [{ type: "open", target: "https://override.example/" }]
      })
    }
  });

  const plan = await harness.service.requestControlPlan("use override", null);

  assert.equal(plan.summary, "override");
  assert.equal(plan.steps[0].target, "https://override.example/");
  assert.equal(harness.calls.length, 0);
});

test("control planning service requests next actions and falls back deterministically on provider failure", async () => {
  const planned = createHarness();
  const decision = await planned.service.requestNextControlAction({
    goal: "open example.com",
    snapshot: { title: "Start" },
    history: []
  });
  assert.equal(decision.status, "continue");
  assert.equal(decision.action.type, "open");
  assert.match(decision.strategyPhase, /Read the active page|Open or search|Search or open|Read the page/);
  assert.match(decision.strategyRationale, /runbook/);
  assert.equal(decision.scenarioName, "generic page control");
  assert.ok(decision.successSignals.some((signal) => /current URL/.test(signal)));
  assert.ok(decision.stopConditions.some((condition) => /target control/.test(condition)));
  assert.ok(decision.preferredProbes.some((probe) => /visible page/.test(probe)));
  assert.equal(planned.calls[0][1], "/augmentor/next-action");
  assert.equal(planned.calls[0][2].runbook.taskClass, "page-work");

  const fallback = createHarness({ bridgeError: "provider down" });
  const fallbackDecision = await fallback.service.requestNextControlAction({
    goal: "open example.com",
    snapshot: { title: "Start" },
    history: []
  });
  assert.equal(fallbackDecision.source, "deterministic-fallback");
  assert.equal(fallbackDecision.status, "continue");
  assert.equal(fallbackDecision.action.type, "open");
  assert.match(fallbackDecision.completionCheck, /visible page state proves/);
  assert.equal(fallbackDecision.scenarioName, "generic page control");
});

test("control planning service preserves only non-executable proposed action metadata for human handoff", async () => {
  const harness = createHarness({
    decisionResponse: {
      decision: {
        status: "needs_approval",
        thought: "Stop before the public action.",
        approvalReason: "Publishing requires direct human action.",
        action: null,
        proposedAction: { type: "click", text: "Publish scripted article" }
      }
    }
  });

  const decision = await harness.service.requestNextControlAction({
    goal: "publish this article",
    snapshot: { title: "Draft" },
    history: []
  });

  assert.equal(decision.status, "needs_approval");
  assert.equal(decision.action, null);
  assert.deepEqual(decision.proposedAction, {
    type: "click",
    text: "Publish scripted article",
    ref: ""
  });
});

test("control planning service converts unsafe next-action override failures into blocked decisions", async () => {
  const harness = createHarness({
    globalScope: {
      __resonantosNextActionOverride: async () => {
        throw new Error("restricted action");
      }
    }
  });

  const decision = await harness.service.requestNextControlAction({
    goal: "sign wallet",
    snapshot: null,
    history: []
  });

  assert.equal(decision.status, "blocked");
  assert.match(decision.approvalReason, /restricted action/);
  assert.equal(decision.scenarioName, "DAO / wallet review");
  assert.match(decision.strategyRationale, /DAO \/ wallet review scenario runbook/);
  assert.equal(harness.calls.length, 0);
});

test("control planning service can use a scoped next-action override for a single job", async () => {
  const harness = createHarness({
    globalScope: {
      __resonantosNextActionOverride: async () => ({
        status: "continue",
        thought: "global",
        action: { type: "read" }
      })
    }
  });

  const decision = await harness.service.requestNextControlAction({
    goal: "scoped job",
    snapshot: null,
    history: [],
    override: async () => ({
      status: "done",
      thought: "scoped",
      doneSummary: "Scoped override finished the job."
    })
  });

  assert.equal(decision.status, "done");
  assert.equal(decision.thought, "scoped");
  assert.equal(harness.calls.length, 0);
});

test("control planning service creates deterministic plan fallback when planning fails", async () => {
  const harness = createHarness({ bridgeError: "planner offline", readError: "page unavailable" });

  const plan = await harness.service.planAgentControlSteps("search for AI news");

  assert.equal(plan.source, "deterministic-fallback");
  assert.match(plan.summary, /planner offline/);
  assert.ok(plan.steps.some((step) => step.type === "search"));
  assert.ok(harness.calls.some((call) => call[0] === "read"));
});
