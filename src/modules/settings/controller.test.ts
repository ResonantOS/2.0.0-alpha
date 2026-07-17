import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultState } from "../../core/defaults";
import { normalizeState, saveProviderSecret } from "../../core/runtime";
import { resolveStrategistChatRoute } from "../../core/provider-service";
import { executeDeleteProviderProfile, updateModelWorkloadStrategyRoute } from "./controller";
import type { ProviderProfile, ProviderRuntimeNode, ResonantShellState } from "../../core/contracts";

vi.mock("../../core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/runtime")>();
  return { ...actual, saveProviderSecret: vi.fn(async () => undefined) };
});

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

describe("settings controller – provider lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("add → select in Fabric Routing → resolveStrategistChatRoute uses the new provider", () => {
    const state = buildDefaultState([]);
    const withNewProvider: ResonantShellState = {
      ...state,
      providers: [...state.providers, newProvider],
      runtimeNodes: [...state.runtimeNodes, newNode],
    };

    let result: ResonantShellState | undefined;
    const capture = (fn: (d: ResonantShellState) => ResonantShellState) => {
      result = fn(withNewProvider);
    };

    updateModelWorkloadStrategyRoute(
      "strategy-augmentor-primary",
      "provider-openrouter-test::node-provider-openrouter-test::openai/gpt-5.5",
      capture,
    );

    expect(result).toBeDefined();
    const resolved = resolveStrategistChatRoute(result!);
    expect(resolved.provider?.id).toBe("provider-openrouter-test");
    expect(resolved.runtimeNode?.id).toBe("node-provider-openrouter-test");
    expect(resolved.model).toBe("openai/gpt-5.5");
  });

  it("remove → gone from all reference sites", async () => {
    const state = buildDefaultState([]);
    const profileId = "shared-minimax";

    let result: ResonantShellState | undefined;
    const capture = (fn: (d: ResonantShellState) => ResonantShellState) => {
      result = fn(state);
    };

    await executeDeleteProviderProfile({
      snapshot: { state, bundled: [], sideloaded: [] },
      profileId,
      updateRuntimeState: capture,
      setSettingsNotice: () => {},
      errorMessageOf: (_e, fallback) => fallback,
    });

    const s = result!;
    expect(saveProviderSecret).toHaveBeenCalledWith(profileId, "");
    expect(s.providers.find((p) => p.id === profileId)).toBeUndefined();
    expect(s.deletedProviderProfileIds).toContain(profileId);
    expect(s.runtimeNodes.find((n) => n.providerProfileId === profileId)).toBeUndefined();
    expect(s.agents.every((a) => a.providerProfileId !== profileId)).toBe(true);
    expect(s.agents.every((a) => a.fallbackProviderProfileId !== profileId)).toBe(true);
    expect(s.modelStrategy.workloadStrategies.every((st) => st.primaryRoute.providerProfileId !== profileId)).toBe(true);
    expect(s.modelStrategy.fallbackChains.every((c) => c.orderedRoutes.every((r) => r.providerProfileId !== profileId))).toBe(true);
    expect(s.modelStrategy.fallbackChains.every((c) => !c.lastResortRoute || c.lastResortRoute.providerProfileId !== profileId)).toBe(true);
    expect(s.modelStrategy.emergencyPolicy.orderedPromotionTargets.every((t) => t.providerProfileId !== profileId)).toBe(true);
    expect(s.modelStrategy.emergencyPolicy.hardFloorRoute.providerProfileId !== profileId).toBe(true);
    expect(s.providerRouting.fallbackPolicies.every((p) => p.orderedProviderProfileIds.every((id) => id !== profileId))).toBe(true);
    expect(s.providerRouting.fallbackPolicies.every((p) => !(p.orderedRuntimeNodeIds ?? []).includes("node-minimax-cloud"))).toBe(true);
  });

  it("keeps the provider when clearing its credential fails", async () => {
    const state = buildDefaultState([]);
    const setSettingsNotice = vi.fn();
    const updateRuntimeState = vi.fn();
    vi.mocked(saveProviderSecret).mockRejectedValueOnce(new Error("vault unavailable"));

    await executeDeleteProviderProfile({
      snapshot: { state, bundled: [], sideloaded: [] },
      profileId: "shared-minimax",
      updateRuntimeState,
      setSettingsNotice,
      errorMessageOf: (_error, fallback) => fallback,
    });

    expect(updateRuntimeState).not.toHaveBeenCalled();
    expect(setSettingsNotice).toHaveBeenCalledWith("Failed to remove provider credential; provider was not removed.");
  });

  it("remove → stays gone after normalizeState", async () => {
    const base = buildDefaultState([]);
    const profileId = "shared-minimax";

    let removed: ResonantShellState | undefined;
    await executeDeleteProviderProfile({
      snapshot: { state: base, bundled: [], sideloaded: [] },
      profileId,
      updateRuntimeState: (fn) => { removed = fn(base); },
      setSettingsNotice: () => {},
      errorMessageOf: (_e, fallback) => fallback,
    });

    const normalized = normalizeState(removed!, base);

    expect(normalized.providers.find((provider) => provider.id === profileId)).toBeUndefined();
    expect(normalized.runtimeNodes.find((node) => node.providerProfileId === profileId)).toBeUndefined();

    // -- Agent providerProfileId changes survive normalization --
    expect(normalized.agents.every((a) => a.providerProfileId !== profileId)).toBe(true);

    // -- Strategy primary routes are not reset: the delete's empty-route override stays --
    expect(normalized.modelStrategy.workloadStrategies.filter((st) => st.primaryRoute.providerProfileId === profileId)).toHaveLength(0);

    // -- Fallback chains survive normalization: orderedRoutes and lastResortRoute stay cleaned --
    expect(normalized.modelStrategy.fallbackChains.every((c) => c.orderedRoutes.every((r) => r.providerProfileId !== profileId))).toBe(true);
    expect(normalized.modelStrategy.fallbackChains.every((c) => !c.lastResortRoute || c.lastResortRoute.providerProfileId !== profileId)).toBe(true);

    // -- Emergency policy promotion targets survive normalization --
    expect(normalized.modelStrategy.emergencyPolicy.orderedPromotionTargets.every((t) => t.providerProfileId !== profileId)).toBe(true);
    expect(normalized.modelStrategy.emergencyPolicy.hardFloorRoute.providerProfileId !== profileId).toBe(true);

    // -- Fallback policy orderedProviderProfileIds survive normalization --
    expect(normalized.providerRouting.fallbackPolicies.every((p) => p.orderedProviderProfileIds.every((id) => id !== profileId))).toBe(true);
    expect(normalized.providerRouting.fallbackPolicies.every((p) => !(p.orderedRuntimeNodeIds ?? []).includes("node-minimax-cloud"))).toBe(true);

    // -- A non-default (user-added) provider stays completely gone after normalize --
    const withExtra: ResonantShellState = {
      ...base,
      providers: [...base.providers, newProvider],
      runtimeNodes: [...base.runtimeNodes, newNode],
    };

    let removedExtra: ResonantShellState | undefined;
    await executeDeleteProviderProfile({
      snapshot: { state: withExtra, bundled: [], sideloaded: [] },
      profileId: "provider-openrouter-test",
      updateRuntimeState: (fn) => { removedExtra = fn(withExtra); },
      setSettingsNotice: () => {},
      errorMessageOf: (_e, fallback) => fallback,
    });

    const normalizedExtra = normalizeState(removedExtra!, base);
    expect(normalizedExtra.providers.find((p) => p.id === "provider-openrouter-test")).toBeUndefined();
    expect(normalizedExtra.runtimeNodes.find((n) => n.providerProfileId === "provider-openrouter-test")).toBeUndefined();
  });

  it("remove → recovery action stays removed when its runtime node is deleted", async () => {
    const base = buildDefaultState([]);
    let removed: ResonantShellState | undefined;

    await executeDeleteProviderProfile({
      snapshot: { state: base, bundled: [], sideloaded: [] },
      profileId: "shared-local",
      updateRuntimeState: (fn) => { removed = fn(base); },
      setSettingsNotice: () => {},
      errorMessageOf: (_e, fallback) => fallback,
    });

    expect(removed!.providerRouting.recoveryActions).toHaveLength(0);
    expect(normalizeState(removed!, base).providerRouting.recoveryActions).toHaveLength(0);
  });

  it("does not restore deleted emergency promotion targets after normalization", async () => {
    const base = buildDefaultState([]);
    let current = base;
    const deletedProfileIds = ["shared-minimax", "shared-zai-glm", "shared-openai"];

    for (const profileId of deletedProfileIds) {
      await executeDeleteProviderProfile({
        snapshot: { state: current, bundled: [], sideloaded: [] },
        profileId,
        updateRuntimeState: (fn) => { current = fn(current); },
        setSettingsNotice: () => {},
        errorMessageOf: (_e, fallback) => fallback,
      });
      current = normalizeState(current, base);
    }

    expect(current.modelStrategy.emergencyPolicy.orderedPromotionTargets).toEqual([]);
    expect(
      current.modelStrategy.emergencyPolicy.orderedPromotionTargets.some((route) =>
        deletedProfileIds.includes(route.providerProfileId),
      ),
    ).toBe(false);
  });
});
