import { describe, expect, it } from "vitest";
import { buildDefaultState } from "./defaults";
import {
  buildStrategyRouteOptions,
  costPostureLabel,
  routeFromOptionKey,
  routeOptionKey,
  updateWorkloadStrategy,
} from "./model-strategy";
import { resolveRoutineRoute, resolveStrategistChatRoute } from "./provider-service";
import { updateModelWorkloadStrategyRoute } from "../modules/settings/controller";
import type { ProviderProfile, ProviderRuntimeNode, ResonantShellState } from "./contracts";

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

  it("propagates a newly created provider into route options", () => {
    const state = buildDefaultState([]);

    const newProvider: ProviderProfile = {
      id: "provider-openrouter-a1b2c3d4",
      label: "OpenRouter",
      providerType: "openai-compatible",
      authSource: "shared-vault",
      authMethod: "api-key",
      authTier: "supported",
      apiBaseUrl: "https://openrouter.ai/api/v1",
      allowedModels: ["openai/gpt-5.5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
      primaryModel: "openai/gpt-5.5",
      fallbackModel: "anthropic/claude-sonnet-4.5",
      modelContext: [],
      consumerScopes: ["strategist", "setup", "routine"],
      shared: true,
      status: "ready",
      credentialStatus: "configured",
    };

    const newRuntimeNode: ProviderRuntimeNode = {
      id: "node-provider-openrouter-a1b2c3d4",
      label: "OpenRouter Runtime",
      providerProfileId: "provider-openrouter-a1b2c3d4",
      kind: "cloud",
      locality: "cloud",
      endpoint: "https://openrouter.ai/api/v1",
      supportedModels: ["openai/gpt-5.5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
      authTier: "supported",
      healthState: "ready",
      deployableOnDemand: false,
      notes: [],
    };

    const updatedState = {
      ...state,
      providers: [...state.providers, newProvider],
      runtimeNodes: [...state.runtimeNodes, newRuntimeNode],
    };

    const options = buildStrategyRouteOptions(updatedState);

    const openRouterOptions = options.filter((o) => o.providerLabel === "OpenRouter");
    expect(openRouterOptions).toHaveLength(3);
    expect(openRouterOptions.map((o) => o.model).sort()).toEqual([
      "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-pro",
      "openai/gpt-5.5",
    ]);
  });

  it("selects a new provider route and reaches resolveStrategistChatRoute", () => {
    const state = buildDefaultState([]);
    const newProvider: ProviderProfile = {
      id: "provider-openrouter-test",
      label: "OpenRouter Test",
      providerType: "openai-compatible",
      authSource: "shared-vault",
      authMethod: "api-key",
      authTier: "supported",
      apiBaseUrl: "https://openrouter.ai/api/v1",
      allowedModels: ["openai/gpt-5.5"],
      primaryModel: "openai/gpt-5.5",
      fallbackModel: undefined,
      modelContext: [],
      consumerScopes: ["strategist", "setup", "routine"],
      shared: true,
      status: "ready",
      credentialStatus: "configured",
    };
    const newNode: ProviderRuntimeNode = {
      id: "node-provider-openrouter-test",
      label: "OpenRouter Runtime",
      providerProfileId: "provider-openrouter-test",
      kind: "cloud",
      locality: "cloud",
      endpoint: "https://openrouter.ai/api/v1",
      supportedModels: ["openai/gpt-5.5"],
      authTier: "supported",
      healthState: "ready",
      deployableOnDemand: false,
      notes: [],
    };

    const withNewProvider = {
      ...state,
      providers: [...state.providers, newProvider],
      runtimeNodes: [...state.runtimeNodes, newNode],
    };

    const routeKey = "provider-openrouter-test::node-provider-openrouter-test::openai/gpt-5.5";

    let captured: ResonantShellState | undefined;
    updateModelWorkloadStrategyRoute("strategy-augmentor-primary", routeKey, (fn) => {
      captured = fn(withNewProvider);
    });

    expect(captured).toBeDefined();
    const resolved = resolveStrategistChatRoute(captured!);

    expect(resolved.provider?.id).toBe("provider-openrouter-test");
    expect(resolved.runtimeNode?.id).toBe("node-provider-openrouter-test");
    expect(resolved.model).toBe("openai/gpt-5.5");
  });

  it("removes a provider from strategies, agents, and fallback chains", () => {
    const state = buildDefaultState([]);
    const profileId = "shared-minimax";

    const result = {
      ...state,
      providers: state.providers.filter((p) => p.id !== profileId),
      runtimeNodes: state.runtimeNodes.filter((n) => n.providerProfileId !== profileId),
      agents: state.agents.map((agent) => ({
        ...agent,
        providerProfileId: agent.providerProfileId === profileId ? "shared-openai" : agent.providerProfileId,
        fallbackProviderProfileId: agent.fallbackProviderProfileId === profileId ? undefined : agent.fallbackProviderProfileId,
      })),
      modelStrategy: {
        ...state.modelStrategy,
        workloadStrategies: state.modelStrategy.workloadStrategies.map((strategy) => ({
          ...strategy,
          primaryRoute:
            strategy.primaryRoute.providerProfileId === profileId
              ? { providerProfileId: "", runtimeNodeId: "", model: "", costPosture: "unknown" as const }
              : strategy.primaryRoute,
        })),
        fallbackChains: state.modelStrategy.fallbackChains.map((chain) => ({
          ...chain,
          orderedRoutes: chain.orderedRoutes.filter((r) => r.providerProfileId !== profileId),
          lastResortRoute: chain.lastResortRoute?.providerProfileId === profileId ? undefined : chain.lastResortRoute,
        })),
      },
    };

    expect(result.providers.find((p) => p.id === profileId)).toBeUndefined();
    expect(result.runtimeNodes.find((n) => n.providerProfileId === profileId)).toBeUndefined();
    expect(result.agents.every((a) => a.providerProfileId !== profileId)).toBe(true);
    expect(result.agents.every((a) => a.fallbackProviderProfileId !== profileId)).toBe(true);
    expect(result.modelStrategy.workloadStrategies.every((s) => s.primaryRoute.providerProfileId !== profileId)).toBe(true);
    expect(result.modelStrategy.fallbackChains.every((c) => c.orderedRoutes.every((r) => r.providerProfileId !== profileId))).toBe(true);
    expect(result.modelStrategy.fallbackChains.every((c) => !c.lastResortRoute || c.lastResortRoute.providerProfileId !== profileId)).toBe(true);
  });
});
