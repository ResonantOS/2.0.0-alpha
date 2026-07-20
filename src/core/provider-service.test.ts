import { describe, expect, it } from "vitest";
import { buildDefaultState } from "./defaults";
import {
  assertExecutableProviderRoute,
  resolveArchiveIngestRoute,
  resolveRoutineRoute,
  resolveStrategistChatRoute,
  selectableAgentChatModels,
} from "./provider-service";

describe("strategist provider service routing", () => {
  it("prefers the cloud route while it is healthy", () => {
    const state = buildDefaultState([]);
    const configuredState = {
      ...state,
      providers: state.providers.map((p) =>
        p.id === "shared-minimax" ? { ...p, credentialStatus: "configured" as const } : p,
      ),
    };
    const resolved = resolveStrategistChatRoute(configuredState);

    expect(resolved.provider?.id).toBe("shared-minimax");
    expect(resolved.runtimeNode?.id).toBe("node-minimax-cloud");
    expect(resolved.decision.executionAdapterId).toBe("cloud-minimax-compatible");
    expect(resolved.model).toBe("MiniMax-M3");
    expect(resolved.executionAdapter?.supportsStreaming).toBe(true);
    expect(resolved.executionAdapter?.supportsAbort).toBe(true);
    expect(resolved.decision.resolutionReason).toBe("primary-healthy");
    expect(assertExecutableProviderRoute(resolved, "test chat").executionAdapter.id).toBe("cloud-minimax-compatible");
  });

  it("hard-stops execution when a provider route lacks an approved adapter", () => {
    const state = buildDefaultState([]);
    const withoutLocalAdapter = {
      ...state,
      providerRouting: {
        ...state.providerRouting,
        executionAdapters: state.providerRouting.executionAdapters.filter((adapter) => adapter.id !== "local-ollama"),
      },
      providers: state.providers.map((provider) =>
        provider.providerType === "local" ? provider : { ...provider, status: "missing" as const },
      ),
      runtimeNodes: state.runtimeNodes.map((node) =>
        node.kind === "cloud" || node.kind === "remote-user-owned" ? { ...node, healthState: "unavailable" as const } : node,
      ),
    };

    const resolved = resolveStrategistChatRoute(withoutLocalAdapter);

    expect(resolved.provider?.id).toBe("shared-local");
    expect(resolved.decision.executionAdapterId).toBeUndefined();
    expect(() => assertExecutableProviderRoute(resolved, "test chat")).toThrow("no approved execution adapter");
  });

  it("shows only canonical verified chat models in a stable order", () => {
    const state = buildDefaultState([]);

    expect(selectableAgentChatModels(state, "strategist.core")).toEqual([
      "MiniMax-M3",
      "zai/glm-5.2",
      "gpt-5.5",
      "gpt-5.4-mini",
      "batiai/gemma4-e2b:q4",
      "Qwen3.6-35B-A3B-Q4_K_M.gguf",
    ]);
  });

  it("uses Z.AI GLM as the first cloud fallback when the primary route is unavailable", () => {
    const state = buildDefaultState([]);
    const glmFallbackState = {
      ...state,
      providers: state.providers.map((provider) =>
        provider.id === "shared-zai-glm"
          ? { ...provider, credentialStatus: "configured" as const }
          : provider.id === "shared-minimax"
            ? { ...provider, status: "missing" as const }
            : provider,
      ),
      runtimeNodes: state.runtimeNodes.map((node) =>
        node.id === "node-minimax-cloud" ? { ...node, healthState: "unavailable" as const } : node,
      ),
    };

    const resolved = resolveStrategistChatRoute(glmFallbackState);

    expect(resolved.provider?.id).toBe("shared-zai-glm");
    expect(resolved.runtimeNode?.id).toBe("node-zai-glm-cloud");
    expect(resolved.decision.executionAdapterId).toBe("cloud-openai-compatible");
    expect(resolved.model).toBe("zai/glm-5.2");
    expect(resolved.decision.resolutionReason).toBe("fallback-in-policy");
  });

  it("uses the verified GX10 runtime as a supported fallback route", () => {
    const state = buildDefaultState([]);
    const degradedState = {
      ...state,
      providers: state.providers.map((provider) =>
        provider.id === "gx10-local-llama" || provider.providerType === "local" ? provider : { ...provider, status: "missing" as const },
      ),
      runtimeNodes: state.runtimeNodes.map((node) =>
        node.kind === "cloud"
          ? { ...node, healthState: "unavailable" as const }
          : node,
      ),
    };

    const resolved = resolveStrategistChatRoute(degradedState);

    expect(resolved.provider?.id).toBe("gx10-local-llama");
    expect(resolved.runtimeNode?.id).toBe("node-gx10-qwen");
    expect(resolved.decision.executionAdapterId).toBe("cloud-openai-compatible");
    expect(resolved.model).toBe("Qwen3.6-35B-A3B-Q4_K_M.gguf");
    expect(resolved.decision.resolutionReason).toBe("fallback-in-policy");
  });

  it("uses the desktop resurrect floor when cloud and remote user-owned routes are unavailable", () => {
    const state = buildDefaultState([]);
    const unavailableState = {
      ...state,
      providers: state.providers.map((provider) =>
        provider.providerType === "local" ? provider : { ...provider, status: "missing" as const },
      ),
      runtimeNodes: state.runtimeNodes.map((node) =>
        node.kind === "cloud" || node.kind === "remote-user-owned" ? { ...node, healthState: "unavailable" as const } : node,
      ),
    };

    const resolved = resolveStrategistChatRoute(unavailableState);

    expect(resolved.provider?.id).toBe("shared-local");
    expect(resolved.runtimeNode?.id).toBe("node-local-resurrect");
    expect(resolved.decision.executionAdapterId).toBe("local-ollama");
    expect(resolved.model).toBe("batiai/gemma4-e2b:q4");
    expect(resolved.decision.resolutionReason).toBe("fallback-in-policy");
  });

  it("exposes verified GX10 models from the default LAN runtime", () => {
    const state = {
      ...buildDefaultState([]),
      providers: buildDefaultState([]).providers.map((provider) =>
        provider.id === "gx10-local-llama" || provider.providerType === "local" ? provider : { ...provider, status: "missing" as const },
      ),
      runtimeNodes: buildDefaultState([]).runtimeNodes.map((node) =>
        node.kind === "cloud" ? { ...node, healthState: "unavailable" as const } : node,
      ),
    };

    const selectable = selectableAgentChatModels(state, "strategist.core");
    const resolved = resolveStrategistChatRoute(state, "Qwen3.6-35B-A3B-Q4_K_M.gguf");

    expect(selectable).toContain("Qwen3.6-35B-A3B-Q4_K_M.gguf");
    expect(selectable).not.toContain("gemma-4-26B-A4B-it-UD-Q4_K_M.gguf");
    expect(selectable).not.toContain("Qwen3.6-27B-Q4_K_M.gguf");
    expect(resolved.runtimeNode?.id).toBe("node-gx10-qwen");
    expect(resolved.model).toBe("Qwen3.6-35B-A3B-Q4_K_M.gguf");
  });

  it("keeps custom LAN routes out of the chat picker unless they use canonical verified chat models", () => {
    const state = buildDefaultState([]);
    const gx10Provider = {
      ...state.providers.find((provider) => provider.id === "shared-local")!,
      id: "provider-asus-gx10-test",
      label: "ASUS GX10",
      providerType: "openai-compatible" as const,
      apiBaseUrl: "http://192.168.1.42:30000/v1",
      allowedModels: ["Qwen3.6-35B-A3B-Q4_K_M.gguf"],
      primaryModel: "Qwen3.6-35B-A3B-Q4_K_M.gguf",
      fallbackModel: undefined,
      status: "ready" as const,
      credentialStatus: "configured" as const,
    };
    const gx10Node = {
      ...state.runtimeNodes.find((node) => node.id === "node-gx10-qwen")!,
      id: "node-provider-asus-gx10-test",
      label: "ASUS GX10 Runtime",
      providerProfileId: gx10Provider.id,
      endpoint: "http://192.168.1.42:30000/v1",
      supportedModels: ["Qwen3.6-35B-A3B-Q4_K_M.gguf"],
      healthState: "ready" as const,
    };
    const updatedState = {
      ...state,
      providers: [...state.providers, gx10Provider],
      runtimeNodes: [...state.runtimeNodes, gx10Node],
    };

    expect(selectableAgentChatModels(updatedState, "strategist.core")).toContain("Qwen3.6-35B-A3B-Q4_K_M.gguf");
    expect(selectableAgentChatModels(updatedState, "strategist.core")).not.toContain("gemma-4-26b-a4b-q4_k_m.gguf");

    const resolved = resolveStrategistChatRoute(updatedState, "Qwen3.6-35B-A3B-Q4_K_M.gguf");

    expect(resolved.provider?.id).toBe("gx10-local-llama");
    expect(resolved.runtimeNode?.id).toBe("node-gx10-qwen");
    expect(resolved.model).toBe("Qwen3.6-35B-A3B-Q4_K_M.gguf");
  });

  it("stays pinned to the local resurrect runtime when recovery mode is enabled", () => {
    const state = buildDefaultState([]);
    const pinnedState = {
      ...state,
      agents: state.agents.map((agent) =>
        agent.id === "strategist.core"
          ? { ...agent, providerProfileId: "shared-local", fallbackProviderProfileId: undefined }
          : agent,
      ),
    };

    const resolved = resolveStrategistChatRoute(pinnedState);

    expect(resolved.provider?.id).toBe("shared-local");
    expect(resolved.runtimeNode?.id).toBe("node-local-resurrect");
    expect(resolved.decision.executionAdapterId).toBe("local-ollama");
    expect(resolved.decision.fallbackPolicyId).toBe("strict-supported-only");
  });

  it("ignores stale selected models that are outside the active Strategist strategy", () => {
    const state = buildDefaultState([]);
    const model = "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M";
    const provider = {
      ...state.providers.find((item) => item.id === "gx10-local-llama")!,
      id: "local-llamacpp-primary",
      label: "Local llama.cpp Test",
      apiBaseUrl: "http://192.168.1.13:8081/v1",
      allowedModels: [model],
      primaryModel: model,
      modelContext: [{ model, maxContextTokens: 8192, tokenEstimateMethod: "provider-metadata" as const, source: "runtime-node" as const }],
      status: "ready" as const,
      credentialStatus: "configured" as const,
    };
    const runtimeNode = {
      ...state.runtimeNodes.find((item) => item.id === "node-gx10-qwen")!,
      id: "node-local-llamacpp-primary",
      label: "Local llama.cpp Test Runtime",
      providerProfileId: provider.id,
      endpoint: "http://192.168.1.13:8081/v1",
      supportedModels: [model],
      healthState: "ready" as const,
    };
    const configuredState = {
      ...state,
      providers: [...state.providers, provider],
      runtimeNodes: [...state.runtimeNodes, runtimeNode],
      agents: state.agents.map((agent) =>
        agent.id === "strategist.core"
          ? { ...agent, providerProfileId: provider.id, fallbackProviderProfileId: "shared-openai" }
          : agent,
      ),
      modelStrategy: {
        ...state.modelStrategy,
        workloadStrategies: state.modelStrategy.workloadStrategies.map((strategy) =>
          strategy.id === "strategy-augmentor-primary"
            ? {
                ...strategy,
                primaryRoute: {
                  providerProfileId: provider.id,
                  runtimeNodeId: runtimeNode.id,
                  model,
                  costPosture: "free-local" as const,
                },
                fallbackChainId: "chain-local-llamacpp-test",
              }
            : strategy,
        ),
      },
    };

    const resolved = resolveStrategistChatRoute(configuredState, "batiai/gemma4-e2b:q4");

    expect(resolved.provider?.id).toBe("local-llamacpp-primary");
    expect(resolved.runtimeNode?.id).toBe("node-local-llamacpp-primary");
    expect(resolved.decision.executionAdapterId).toBe("cloud-openai-compatible");
    expect(resolved.model).toBe(model);
  });
});

describe("workload strategy routing", () => {
  it("routes archive ingest through the premium cloud strategy first", () => {
    const state = buildDefaultState([]);
    const configuredState = {
      ...state,
      providers: state.providers.map((p) =>
        p.id === "shared-openai" ? { ...p, credentialStatus: "configured" as const } : p,
      ),
    };
    const resolved = resolveArchiveIngestRoute(configuredState);

    expect(resolved.provider?.id).toBe("shared-openai");
    expect(resolved.runtimeNode?.id).toBe("node-openai-cloud");
    expect(resolved.decision.executionAdapterId).toBe("cloud-openai-compatible");
    expect(resolved.model).toBe("gpt-5.5");
  });

  it("routes archive ingest to Z.AI GLM when OpenAI is unavailable but Z.AI GLM is configured", () => {
    const state = buildDefaultState([]);
    const glmFallbackState = {
      ...state,
      providers: state.providers.map((provider) =>
        provider.id === "shared-zai-glm"
          ? { ...provider, credentialStatus: "configured" as const }
          : provider.id === "shared-openai"
            ? { ...provider, status: "missing" as const }
            : provider,
      ),
      runtimeNodes: state.runtimeNodes.map((node) =>
        node.id === "node-openai-cloud" ? { ...node, healthState: "unavailable" as const } : node,
      ),
    };
    const resolved = resolveArchiveIngestRoute(glmFallbackState);

    expect(resolved.provider?.id).toBe("shared-zai-glm");
    expect(resolved.runtimeNode?.id).toBe("node-zai-glm-cloud");
    expect(resolved.decision.executionAdapterId).toBe("cloud-openai-compatible");
    expect(resolved.model).toBe("zai/glm-5.2");
  });

  it("hard-stops archive ingest when strategy-approved cloud routes are unavailable", () => {
    const state = buildDefaultState([]);
    const unavailableState = {
      ...state,
      providers: state.providers.map((provider) =>
        provider.providerType === "local" ? provider : { ...provider, status: "missing" as const },
      ),
      runtimeNodes: state.runtimeNodes.map((node) =>
        node.kind === "cloud" ? { ...node, healthState: "unavailable" as const } : node,
      ),
    };

    const resolved = resolveArchiveIngestRoute(unavailableState);

    expect(resolved.provider).toBeUndefined();
    expect(resolved.runtimeNode).toBeUndefined();
    expect(resolved.decision.resolutionReason).toBe("no-viable-route");
  });

  it("routes routine work through the economical strategy chain", () => {
    const state = buildDefaultState([]);
    const configuredState = {
      ...state,
      providers: state.providers.map((p) =>
        p.id === "shared-minimax" ? { ...p, credentialStatus: "configured" as const } : p,
      ),
    };
    const resolved = resolveRoutineRoute(configuredState);

    expect(resolved.provider?.id).toBe("shared-minimax");
    expect(resolved.runtimeNode?.id).toBe("node-minimax-cloud");
    expect(resolved.decision.executionAdapterId).toBe("cloud-minimax-compatible");
    expect(resolved.model).toBe("MiniMax-M3");
  });

  it("routes routine work to Z.AI GLM before the local floor when MiniMax is unavailable", () => {
    const state = buildDefaultState([]);
    const glmFallbackState = {
      ...state,
      providers: state.providers.map((provider) =>
        provider.id === "shared-zai-glm"
          ? { ...provider, credentialStatus: "configured" as const }
          : provider.id === "shared-minimax"
            ? { ...provider, status: "missing" as const }
            : provider,
      ),
      runtimeNodes: state.runtimeNodes.map((node) =>
        node.id === "node-minimax-cloud" ? { ...node, healthState: "unavailable" as const } : node,
      ),
    };
    const resolved = resolveRoutineRoute(glmFallbackState);

    expect(resolved.provider?.id).toBe("shared-zai-glm");
    expect(resolved.runtimeNode?.id).toBe("node-zai-glm-cloud");
    expect(resolved.model).toBe("zai/glm-5.2");
  });
});
