import { describe, expect, it } from "vitest";
import { buildDefaultState } from "./defaults";
import {
  buildStrategyRouteOptions,
  costPostureLabel,
  routeFromOptionKey,
  routeOptionKey,
  updateWorkloadStrategy,
} from "./model-strategy";
import { resolveRoutineRoute } from "./provider-service";

describe("model strategy planner", () => {
  it("builds editable route options with cost posture metadata", () => {
    const state = buildDefaultState([]);
    const options = buildStrategyRouteOptions(state);

    expect(options.some((option) => option.key === "shared-minimax::node-minimax-cloud::MiniMax-M3")).toBe(true);
    expect(options.some((option) => option.key === "shared-zai-glm::node-zai-glm-cloud::zai/glm-5.2")).toBe(true);
    expect(options.find((option) => option.key === "shared-zai-glm::node-zai-glm-cloud::zai/glm-5.2")?.costPosture).toBe("paid-api");
    expect(options.find((option) => option.runtimeNodeId === "node-local-resurrect")?.costPosture).toBe("emergency-only");
    expect(options.some((option) => option.key === "gx10-local-llama::node-gx10-qwen::Qwen3.6-35B-A3B-Q4_K_M.gguf")).toBe(true);
    expect(costPostureLabel("subscription")).toBe("Subscription");
  });

  it("updates a workload primary route and changes routing deterministically", () => {
    const state = buildDefaultState([]);
    const route = routeFromOptionKey(state, "gx10-local-llama::node-gx10-qwen::Qwen3.6-35B-A3B-Q4_K_M.gguf");

    expect(route).toBeDefined();
    const updated = updateWorkloadStrategy(state, "strategy-routine-background", {
      primaryRoute: route,
      fallbackChainId: "chain-routine-economical",
    });

    const resolved = resolveRoutineRoute(updated);

    expect(routeOptionKey(updated.modelStrategy.workloadStrategies.find((strategy) => strategy.id === "strategy-routine-background")!.primaryRoute)).toBe(
      "gx10-local-llama::node-gx10-qwen::Qwen3.6-35B-A3B-Q4_K_M.gguf",
    );
    expect(resolved.provider?.id).toBe("gx10-local-llama");
    expect(resolved.runtimeNode?.id).toBe("node-gx10-qwen");
    expect(resolved.model).toBe("Qwen3.6-35B-A3B-Q4_K_M.gguf");
  });

  it("ignores unknown route option keys rather than corrupting a strategy", () => {
    const state = buildDefaultState([]);
    expect(routeFromOptionKey(state, "missing")).toBeUndefined();
  });
});
