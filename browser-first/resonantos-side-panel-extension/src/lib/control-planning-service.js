import {
  sanitizeNextActionDecision,
  sanitizePlannerPlan
} from "./approval-policy.js";
import {
  buildControlRunbook,
  dedupeControlSteps,
  deterministicNextAction,
  planControlSteps
} from "./agent-control-planner.js";

function attachRunbookDefaults(decision, runbook) {
  return {
    ...decision,
    strategyPhase: decision.strategyPhase ?? runbook.currentPhase,
    strategyRationale: decision.strategyRationale ?? `${runbook.strategy} Success signals: ${runbook.successSignals.join("; ")}.`,
    completionCheck: decision.completionCheck ?? runbook.completionCheck,
    scenarioName: decision.scenarioName ?? runbook.scenarioName,
    preferredProbes: decision.preferredProbes?.length ? decision.preferredProbes : runbook.preferredProbes,
    successSignals: decision.successSignals?.length ? decision.successSignals : runbook.successSignals,
    stopConditions: decision.stopConditions?.length ? decision.stopConditions : runbook.stopConditions
  };
}

export function createControlPlanningService({
  bridgeRequest,
  getBridgeRequest,
  getLastSnapshot,
  getModel,
  getThinkingDepth,
  globalScope = globalThis,
  readActivePage
}) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const requestControlPlan = async (goal, snapshot) => {
    const runbook = buildControlRunbook(goal, snapshot, []);
    if (typeof globalScope.__resonantosControlPlannerOverride === "function") {
      return sanitizePlannerPlan(
        await globalScope.__resonantosControlPlannerOverride({ goal, snapshot, runbook }),
        { dedupeControlSteps }
      );
    }
    const result = await bridge()("/augmentor/control-plan", {
      method: "POST",
      body: {
        goal,
        model: getModel(),
        thinkingDepth: getThinkingDepth(),
        pageSnapshot: snapshot ?? null,
        runbook
      }
    });
    return sanitizePlannerPlan({
      source: "llm",
      ...result.plan
    }, { dedupeControlSteps });
  };

  const requestNextControlAction = async ({ goal, snapshot, history, override = null }) => {
    const runbook = buildControlRunbook(goal, snapshot, history);
    const scopedOverride = typeof override === "function" ? override : globalScope.__resonantosNextActionOverride;
    if (typeof scopedOverride === "function") {
      try {
        return attachRunbookDefaults(
          sanitizeNextActionDecision(await scopedOverride({ goal, snapshot, history, runbook })),
          runbook
        );
      } catch (error) {
        return attachRunbookDefaults({
          source: "test-override",
          status: "blocked",
          thought: "The proposed browser action crossed a safety boundary.",
          action: null,
          approvalReason: error instanceof Error ? error.message : String(error),
          doneSummary: null,
          strategyPhase: null,
          strategyRationale: null,
          completionCheck: null,
          scenarioName: null,
          preferredProbes: [],
          successSignals: [],
          stopConditions: []
        }, runbook);
      }
    }
    try {
      const result = await bridge()("/augmentor/next-action", {
        method: "POST",
        body: {
          goal,
          model: getModel(),
          thinkingDepth: getThinkingDepth(),
          pageSnapshot: snapshot ?? null,
          history,
          runbook
        }
      });
      const decision = sanitizeNextActionDecision({
        source: "llm",
        ...result.decision
      });
      return attachRunbookDefaults(decision, runbook);
    } catch (error) {
      const fallback = deterministicNextAction(goal, snapshot, history);
      const fallbackDecision = fallback.status === "blocked" && !history.length
        ? {
            ...fallback,
            approvalReason: `${fallback.approvalReason ?? "No safe fallback is available."} Planner error: ${error instanceof Error ? error.message : String(error)}`
          }
        : fallback;
      return attachRunbookDefaults(fallbackDecision, runbook);
    }
  };

  const planAgentControlSteps = async (goal) => {
    const snapshotResponse = await readActivePage({ announce: false }).catch(() => null);
    const snapshot = snapshotResponse?.snapshot ?? getLastSnapshot();
    try {
      return await requestControlPlan(goal, snapshot);
    } catch (error) {
      const fallbackSteps = planControlSteps(goal);
      return {
        source: "deterministic-fallback",
        summary: `Planner unavailable; using deterministic control parser. ${error instanceof Error ? error.message : String(error)}`,
        steps: fallbackSteps,
        needsApproval: false,
        approvalReason: null
      };
    }
  };

  return {
    planAgentControlSteps,
    requestControlPlan,
    requestNextControlAction
  };
}
