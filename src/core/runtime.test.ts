import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddOnManifest, HarnessRegistryProjection, InstallationStatus, ResonantShellState } from "./contracts";
import { buildDefaultState } from "./defaults";
import { applyProviderCredentialStatuses, hydrateState, loadBundledManifests, persistState, normalizeState, rebaseStateOnManifests, requestProviderSmokeTest, requestProviderServiceChatCompletion, requestProviderServiceChatCompletionStream } from "./runtime";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const testManifest = (id: string): AddOnManifest => ({
  id,
  name: id,
  version: "0.1.0",
  author: "test",
  category: "integration",
  description: "test",
  runtimeType: "local-service",
  surfaces: [],
  requestedCapabilities: [],
  providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
  archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
  health: { strategy: "none" },
  installHooks: {},
  compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
});

describe("runtime state migration", () => {
  it("migrates legacy recovery state onto the Resonant Engineer Agent and Gemma local runtime", () => {
    const base = buildDefaultState([]);
    const legacy = {
      ...base,
      agents: [
        {
          ...base.agents.find((agent) => agent.id === "strategist.core")!,
          providerProfileId: "shared-minimax",
          fallbackProviderProfileId: "shared-openai",
        },
        {
          ...base.agents.find((agent) => agent.id === "setup.core")!,
          displayName: "Setup",
          providerProfileId: "shared-minimax",
          fallbackProviderProfileId: "shared-openai",
          archiveReadScopes: ["configuration"],
          channelIds: ["desktop-setup"],
        },
        {
          id: "engineer.core",
          displayName: "Engineer Agent",
          trustTier: "core",
          workspaceBehavior: "delegated",
          providerProfileId: "shared-local",
          archiveReadScopes: ["configuration", "constitution"],
          archiveIntakeWriteScopes: ["LivingArchive/REVIEW"],
          canWriteKnowledgePages: false,
          channelIds: ["desktop-engineer"],
        },
        base.agents.find((agent) => agent.id === "archive-ingest.core")!,
      ],
      providers: base.providers.map((provider) =>
        provider.id === "shared-local"
          ? {
              ...provider,
              allowedModels: ["local/creative", "local/transcribe"],
              primaryModel: "local/creative",
            }
          : provider,
      ),
      runtimeNodes: base.runtimeNodes.map((node) =>
        node.id === "node-local-resurrect"
          ? {
              ...node,
              supportedModels: ["local/creative", "local/transcribe"],
            }
          : node,
      ),
      recoverySession: {
        ...base.recoverySession,
        engineerAgentId: "engineer.core",
        active: true,
      },
      conversationThreads: base.conversationThreads.filter((thread) => thread.id !== "thread-recovery-engineer"),
    } satisfies ResonantShellState;

    const normalized = normalizeState(legacy, base);

    const setupAgent = normalized.agents.find((agent) => agent.id === "setup.core");
    expect(setupAgent?.displayName).toBe("Resonant Engineer Agent");
    expect(setupAgent?.providerProfileId).toBe("shared-local");
    expect(normalized.recoverySession.engineerAgentId).toBe("setup.core");
    expect(normalized.providers.find((provider) => provider.id === "shared-local")?.primaryModel).toBe("batiai/gemma4-e2b:q4");
    expect(normalized.runtimeNodes.find((node) => node.id === "node-local-resurrect")?.supportedModels).toContain("batiai/gemma4-e2b:q4");
    expect(normalized.conversationThreads.find((thread) => thread.id === "thread-recovery-engineer")).toBeDefined();
    expect(normalized.modelStrategy.profileId).toBe("personal-studio-default");
    expect(normalized.modelStrategy.workloadStrategies.length).toBeGreaterThan(0);
  });

  it("preserves persisted user-created conversation threads during normalization", () => {
    const base = buildDefaultState([]);
    const persistedFork = {
      ...base.conversationThreads[0],
      id: "thread-fork-custom",
      title: "Custom fork",
      summary: "User-created fork that must survive reload.",
      messages: [
        {
          ...base.conversationThreads[0].messages[0],
          id: "thread-fork-custom:m1",
          threadId: "thread-fork-custom",
        },
      ],
    };
    const persisted = {
      ...base,
      conversationThreads: [...base.conversationThreads, persistedFork],
      uiPreferences: {
        ...base.uiPreferences,
        activeChatThreadId: persistedFork.id,
        pinnedChatThreadIds: [persistedFork.id],
      },
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);

    expect(normalized.conversationThreads.find((thread) => thread.id === "thread-fork-custom")).toBeDefined();
    expect(normalized.uiPreferences.activeChatThreadId).toBe("thread-fork-custom");
    expect(normalized.uiPreferences.pinnedChatThreadIds).toContain("thread-fork-custom");
  });

  it("adds the default archive automation policy to older persisted state", () => {
    const base = buildDefaultState([]);
    const legacy = { ...base } as Partial<ResonantShellState>;
    delete legacy.archiveAutomationPolicy;

    const normalized = normalizeState(legacy as ResonantShellState, base);

    expect(normalized.archiveAutomationPolicy).toEqual({
      autoSyncEnabled: false,
      aiMemoryBuilds: "off",
    });
  });

  it("preserves user-created provider profiles and runtime nodes during normalization", () => {
    const base = buildDefaultState([]);
    const gx10Provider = {
      ...base.providers.find((provider) => provider.id === "shared-local")!,
      id: "provider-asus-gx10-test",
      label: "ASUS GX10",
      providerType: "openai-compatible" as const,
      apiBaseUrl: "http://gx10-23bd.local:30000/v1",
      allowedModels: ["gemma-4-26b-a4b-q4_k_m.gguf"],
      primaryModel: "gemma-4-26b-a4b-q4_k_m.gguf",
      fallbackModel: undefined,
      status: "ready" as const,
    };
    const gx10Node = {
      ...base.runtimeNodes.find((node) => node.id === "node-gx10-qwen")!,
      id: "node-provider-asus-gx10-test",
      providerProfileId: gx10Provider.id,
      endpoint: "http://gx10-23bd.local:30000/v1",
      supportedModels: ["gemma-4-26b-a4b-q4_k_m.gguf"],
      healthState: "ready" as const,
    };
    const persisted = {
      ...base,
      providers: [...base.providers, gx10Provider],
      runtimeNodes: [...base.runtimeNodes, gx10Node],
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);

    expect(normalized.providers.find((provider) => provider.id === gx10Provider.id)?.allowedModels).toEqual([
      "gemma-4-26b-a4b-q4_k_m.gguf",
    ]);
    expect(normalized.runtimeNodes.find((node) => node.id === gx10Node.id)?.supportedModels).toEqual([
      "gemma-4-26b-a4b-q4_k_m.gguf",
    ]);
  });

  it("rebases execution adapter capability contracts from code defaults", () => {
    const base = buildDefaultState([]);
    const persisted = {
      ...base,
      providerRouting: {
        ...base.providerRouting,
        executionAdapters: base.providerRouting.executionAdapters.map((adapter) =>
          adapter.id === "cloud-openai-compatible"
            ? {
                ...adapter,
                supportedRuntimeKinds: ["cloud" as const],
                supportedAuthMethods: ["api-key" as const],
                requiresCredential: true,
              }
            : adapter,
        ),
      },
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);
    const adapter = normalized.providerRouting.executionAdapters.find((item) => item.id === "cloud-openai-compatible");

    expect(adapter?.supportedRuntimeKinds).toContain("remote-user-owned");
    expect(adapter?.supportedAuthMethods).toContain("local-runtime");
    expect(adapter?.requiresCredential).toBe(false);
  });

  it("treats local-runtime OpenAI-compatible providers as credential-ready without stored secrets", () => {
    const base = buildDefaultState([]);
    const provider = {
      ...base.providers.find((item) => item.id === "shared-local")!,
      id: "provider-asus-gx10-test",
      label: "ASUS GX10",
      providerType: "openai-compatible" as const,
      authMethod: "local-runtime" as const,
      credentialStatus: "missing" as const,
    };
    const state = {
      ...base,
      providers: [...base.providers, provider],
    } satisfies ResonantShellState;

    const updated = applyProviderCredentialStatuses(state, {});

    expect(updated.providers.find((item) => item.id === provider.id)?.credentialStatus).toBe("configured");
  });

  it("fails provider smoke tests closed when the alpha bridge is not configured", async () => {
    await expect(requestProviderSmokeTest({
      providerId: "provider-coder7",
      providerType: "openai-compatible",
      apiBaseUrl: "http://192.168.1.13:8081/v1",
      runtimeNodeId: "node-coder7",
      runtimeNodeKind: "remote-user-owned",
      runtimeNodeEndpoint: "http://192.168.1.13:8081/v1",
      authTier: "supported",
      model: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M",
    })).rejects.toThrow("Browser-first bridge is not configured.");
  });

  it("rebases stale placeholder GX10 runtime state onto the verified default runtime", () => {
    const base = buildDefaultState([]);
    const persisted = {
      ...base,
      runtimeNodes: base.runtimeNodes.map((node) =>
        node.id === "node-gx10-qwen"
          ? {
              ...node,
              endpoint: "gx10://primary-runtime",
              supportedModels: ["qwen-3.5", "gemma-4"],
              healthState: "degraded" as const,
            }
          : node,
      ),
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);
    const gx10 = normalized.runtimeNodes.find((node) => node.id === "node-gx10-qwen");

    expect(gx10?.endpoint).toBe("http://192.168.1.77:30004/v1");
    expect(gx10?.healthState).toBe("ready");
    expect(gx10?.supportedModels).toEqual(["Qwen3.6-35B-A3B-Q4_K_M.gguf"]);
  });

  it("migrates older persisted state onto the default Z.AI GLM fallback provider and runtime", () => {
    const base = buildDefaultState([]);
    const persisted = {
      ...base,
      providers: base.providers.filter((provider) => provider.id !== "shared-zai-glm"),
      runtimeNodes: base.runtimeNodes.filter((node) => node.id !== "node-zai-glm-cloud"),
      providerRouting: {
        ...base.providerRouting,
        fallbackPolicies: base.providerRouting.fallbackPolicies.map((policy) =>
          policy.id === "core-default"
            ? {
                ...policy,
                orderedProviderProfileIds: policy.orderedProviderProfileIds.filter((id) => id !== "shared-zai-glm"),
                orderedRuntimeNodeIds: (policy.orderedRuntimeNodeIds ?? []).filter((id) => id !== "node-zai-glm-cloud"),
              }
            : policy,
        ),
      },
      modelStrategy: {
        ...base.modelStrategy,
        fallbackChains: base.modelStrategy.fallbackChains.map((chain) => ({
          ...chain,
          orderedRoutes: chain.orderedRoutes.filter((route) => route.providerProfileId !== "shared-zai-glm"),
        })),
      },
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);

    expect(normalized.providers.find((provider) => provider.id === "shared-zai-glm")?.primaryModel).toBe("zai/glm-5.2");
    expect(normalized.runtimeNodes.find((node) => node.id === "node-zai-glm-cloud")?.supportedModels).toEqual(["zai/glm-5.2"]);
    expect(
      normalized.providerRouting.fallbackPolicies
        .find((policy) => policy.id === "core-default")
        ?.orderedProviderProfileIds,
    ).toContain("shared-zai-glm");
    expect(
      normalized.modelStrategy.fallbackChains
        .find((chain) => chain.id === "chain-core-fast")
        ?.orderedRoutes.some((route) => route.providerProfileId === "shared-zai-glm"),
    ).toBe(true);
  });

  it("adds the default workspace layout to older persisted UI preferences", () => {
    const base = buildDefaultState([]);
    const legacy = {
      ...base,
      uiPreferences: {
        ...base.uiPreferences,
        workspaceLayout: undefined,
      },
    } as unknown as ResonantShellState;

    const normalized = normalizeState(legacy, base);

    expect(normalized.uiPreferences.workspaceLayout).toBe("main-chat");
  });

  it("preserves the transcript ledger during state normalization", () => {
    const base = buildDefaultState([]);
    const persisted = {
      ...base,
      transcriptLedger: [
        {
          id: "thread-main-desktop:e1",
          createdAt: "2026-04-25T10:00:00.000Z",
          action: "message-appended" as const,
          threadId: "thread-main-desktop",
          channelId: "desktop-main",
          messageId: "thread-main-desktop:m2",
          role: "user" as const,
          agentId: "strategist.core",
          payload: {
            content: "Preserve this raw turn.",
          },
        },
      ],
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);

    expect(normalized.transcriptLedger).toHaveLength(1);
    expect(normalized.transcriptLedger[0]?.payload.content).toBe("Preserve this raw turn.");
  });

  it("preserves stored context memory states during state normalization", () => {
    const base = buildDefaultState([]);
    const persisted = {
      ...base,
      contextMemoryStates: [
        {
          threadId: "thread-main-desktop",
          compactedAt: "2026-04-25T10:00:00.000Z",
          sourceRange: {
            fromMessageId: "thread-main-desktop:m1",
            toMessageId: "thread-main-desktop:m2",
          },
          userIntent: {
            goal: "Implement compaction.",
            why: "Avoid amnesia.",
            successCriteria: ["Context survives reload."],
            prioritySignals: ["quality"],
            sourceMessageIds: ["thread-main-desktop:m1"],
          },
          workingSummary: "Compaction work in progress.",
          decisions: [],
          facts: [],
          preferences: [],
          openTasks: [],
          artifacts: [],
          risks: [],
          unresolvedQuestions: [],
          preservedRecentMessageIds: ["thread-main-desktop:m2"],
          checksum: "fnv32:test",
        },
      ],
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);

    expect(normalized.contextMemoryStates).toHaveLength(1);
    expect(normalized.contextMemoryStates[0]?.userIntent.why).toBe("Avoid amnesia.");
  });

  it("rebases stale add-on installations onto new manifest capabilities", () => {
    const browserManifest: AddOnManifest = {
      id: "addon.browser",
      name: "Resonant Browser",
      version: "0.1.0",
      author: "test",
      category: "tool",
      description: "Browser",
      runtimeType: "embedded-module",
      surfaces: [],
      requestedCapabilities: [
        { capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
        { capability: "ui-embedding", granted: false, scope: "system", revocationBehavior: "hide-surface" },
      ],
      providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
      archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
      health: { strategy: "none" },
      installHooks: {},
      compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
      grantPresets: [
        {
          id: "browser-visible-session",
          label: "Visible browser session",
          description: "Visible browser access.",
          grants: [],
        },
      ],
    };
    const base = buildDefaultState([browserManifest]);
    const stale = {
      ...base,
      installations: {
        ...base.installations,
        "addon.browser": {
          ...base.installations["addon.browser"],
          installed: true,
          enabled: true,
          status: "enabled",
          grantedCapabilities: [],
        },
      },
    } satisfies ResonantShellState;

    const rebased = rebaseStateOnManifests(stale, [browserManifest], []);

    expect(rebased.installations["addon.browser"].grantedCapabilities.map((grant) => grant.capability)).toEqual([
      "network",
      "ui-embedding",
    ]);
    expect(rebased.installations["addon.browser"].recommendedGrantPresetIds).toContain("browser-visible-session");
  });

  it("rebaseStateOnManifests treats saved installations as untrusted catalog suggestions", () => {
    const manifest = {
      ...testManifest("addon.obsidian"),
      requestedCapabilities: [{ capability: "filesystem", granted: false, scope: "shared", revocationBehavior: "hard-stop" }],
    } satisfies AddOnManifest;
    const base = buildDefaultState([manifest]);
    const stale = {
      ...base,
      installations: {
        ...base.installations,
        "addon.obsidian": {
          ...base.installations["addon.obsidian"],
          installed: false,
          enabled: false,
          status: "uninstalled" as InstallationStatus,
          grantedCapabilities: [{ capability: "filesystem", granted: true, scope: "shared", revocationBehavior: "hard-stop" }],
          privateProviderProfileIds: ["profile-stale"],
          config: { vaultPath: "/tmp/stale-vault" },
        },
      },
    } satisfies ResonantShellState;

    const rebased = rebaseStateOnManifests(stale, [manifest], []);
    const installation = rebased.installations["addon.obsidian"];

    expect(installation.status).toBe("available");
    expect(installation.installed).toBe(false);
    expect(installation.enabled).toBe(false);
    expect(installation.grantedCapabilities).toEqual(manifest.requestedCapabilities);
    expect(installation.privateProviderProfileIds).toEqual([]);
    expect(installation.config).toEqual({});
  });

  it("normalizeState discards saved slot selections instead of promoting suggestions", () => {
    const defaultMemoryProvider = {
      ...testManifest("addon.default-memory"),
      systemSlots: [
        { id: "memory-system", role: "default-provider", replaceable: true, recommended: true },
      ],
    } satisfies AddOnManifest;
    const persistedChatProvider = {
      ...testManifest("addon.persisted-chat"),
      systemSlots: [
        { id: "chat-interface", role: "default-provider", replaceable: true, recommended: true },
      ],
    } satisfies AddOnManifest;
    const base = buildDefaultState([defaultMemoryProvider, persistedChatProvider]);
    const persisted = {
      ...base,
      activeSystemSlotProviderIds: { "chat-interface": "addon.custom-chat" },
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);

    expect(normalized.activeSystemSlotProviderIds).toEqual({});
  });

  it("rebaseStateOnManifests discards legacy owners with or without a saved selection", () => {
    const defaultChatProvider = {
      ...testManifest("addon.default-chat"),
      systemSlots: [
        { id: "chat-interface", role: "default-provider", replaceable: true, recommended: true },
      ],
    } satisfies AddOnManifest;
    const persistedMemoryProvider = {
      ...testManifest("addon.persisted-memory"),
      systemSlots: [
        { id: "memory-system", role: "default-provider", replaceable: true, recommended: true },
      ],
    } satisfies AddOnManifest;
    const base = buildDefaultState([defaultChatProvider, persistedMemoryProvider]);
    const legacy = { ...base };
    delete (legacy as Partial<ResonantShellState>).activeSystemSlotProviderIds;

    const rebasedLegacy = rebaseStateOnManifests(legacy as ResonantShellState, [defaultChatProvider], []);
    const rebasedPersisted = rebaseStateOnManifests(
      {
        ...base,
        activeSystemSlotProviderIds: { "memory-system": "addon.missing-from-catalog" },
      },
      [defaultChatProvider, persistedMemoryProvider],
      [],
    );

    expect(rebasedLegacy.activeSystemSlotProviderIds).toEqual({});
    expect(rebasedPersisted.activeSystemSlotProviderIds).toEqual({});
  });
});

 it.each([false, true])("completion and stream preserve structured context through web transport (stream=%s)", async (stream) => {
  vi.stubGlobal("__RESONANTOS_BRIDGE_CONFIG__", { bridgeUrl: "http://127.0.0.1:47773" });
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, reply: "reply" })));
  vi.stubGlobal("fetch", fetchMock);
  const input = { runId: "run", providerId: "test", providerType: "openai-compatible" as const, model: "test", reasoningEffort: "high" as const,
    systemPrompt: "trusted", messages: [{ id: "m", threadId: "t", channelId: "c", author: "You", createdAt: "now", role: "user" as const, content: "hello" }],
    contextSources: [{ source: "living-archive" as const, kind: "page" as const, title: "title", path: "path", text: "SECRET" }] };
  const events = vi.fn();
  expect(await (stream ? requestProviderServiceChatCompletionStream(input, events) : requestProviderServiceChatCompletion(input))).toBe("reply");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ workload: "augmentor-chat", surface: "react-shell", model: "test", thinkingDepth: "high", systemPrompt: "trusted", messages: input.messages, contextSources: input.contextSources });
  expect(events.mock.calls).toEqual(stream ? [[{ runId: "run", type: "chunk", content: "reply" }], [{ runId: "run", type: "completed", content: "" }]] : []);
 });

const storageKey = "resonantos-vnext.runtime-state";
const governanceManifest = (): AddOnManifest => ({
  ...testManifest("addon.governance"),
  requestedCapabilities: [{ capability: "chat-interface", granted: true, scope: "system", revocationBehavior: "hard-stop" }],
  systemSlots: [{ id: "chat-interface", role: "default-provider", replaceable: true, recommended: true }],
});
const stubStorage = (saved: unknown = null) => {
  const values = new Map<string, string>(saved ? [[storageKey, JSON.stringify(saved)]] : []);
  const localStorage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  vi.stubGlobal("window", { localStorage });
  return () => JSON.parse(values.get(storageKey)!);
};
const forgedState = () => {
  const manifest = governanceManifest();
  const state = buildDefaultState([manifest]);
  state.installations[manifest.id] = { ...state.installations[manifest.id], installed: true, enabled: true,
    status: "enabled", grantedCapabilities: manifest.requestedCapabilities };
  state.activeSystemSlotProviderIds = { "chat-interface": manifest.id };
  return { ...state, candidates: [manifest], grants: manifest.requestedCapabilities,
    owners: state.activeSystemSlotProviderIds, governanceActivated: true,
    harnessProjection: { installations: state.installations, slots: { "chat-interface": { addonId: manifest.id, available: true } } } };
};

describe("storage and development mode cannot restore governance", () => {
  it.each(["test", "development"])("ignores a forged saved consent/owner payload in %s mode", async mode => {
    vi.stubEnv("MODE", mode);
    const saved = forgedState();
    saved.uiPreferences.windowZoom = 1.25;
    stubStorage(saved);
    const state = await hydrateState([governanceManifest()], []);
    expect(state.activeSystemSlotProviderIds).toEqual({});
    expect(state.installations["addon.governance"]).toMatchObject({ installed: false, enabled: false });
    expect(state.installations["addon.governance"].grantedCapabilities.every(grant => !grant.granted)).toBe(true);
    expect(state).not.toHaveProperty("harnessProjection");
    expect(state).not.toHaveProperty("candidates");
    expect(state.uiPreferences.windowZoom).toBe(1.25);
  });

  it("development startup produces no effective grant without host acknowledgement", async () => {
    vi.stubEnv("MODE", "development");
    // Exercise the runtime's own MODE branch, not just the test's environment.
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]"));
    vi.stubGlobal("fetch", fetchMock);
    await loadBundledManifests();
    expect(fetchMock).toHaveBeenCalledWith("/addons/dev-index.json");
    stubStorage();
    const state = await hydrateState([governanceManifest()], []);
    expect(state.installations["addon.governance"].enabled).toBe(false);
    expect(state.installations["addon.governance"].grantedCapabilities.every(grant => !grant.granted)).toBe(true);
    expect(state.activeSystemSlotProviderIds).toEqual({});
    expect(state.uiPreferences.recommendedAddOnsReviewed).toBe(false);
  });

  it.each([false, true])("derives addon channels from host installations across reload (saved=%s)", async saved => {
    const manifest = testManifest("addon.hermes");
    const previous = buildDefaultState([manifest]);
    previous.channels.find(channel => channel.id === "desktop-hermes")!.enabled = true;
    previous.channels.find(channel => channel.id === "telegram-primary")!.enabled = true;
    stubStorage(saved ? previous : null);
    const projection: HarnessRegistryProjection = {
      bootEpoch: "boot", revision: 1, governanceActivated: true, candidates: [manifest], slots: {},
      installations: { [manifest.id]: { addonId: manifest.id, installed: true, enabled: true,
        grantedCapabilities: [], disabledOperations: [], hiddenSurfaceIds: [] } },
    };
    const enabled = await hydrateState([manifest], [], projection);
    expect(enabled.installations[manifest.id].enabled).toBe(true);
    expect(enabled.channels.find(channel => channel.id === "desktop-hermes")!.enabled).toBe(true);
    expect(enabled.channels.find(channel => channel.id === "telegram-primary")!.enabled).toBe(saved);

    // Neither saved channel enablement nor a prior acknowledgement survives host denial.
    const offline = await hydrateState([manifest], [], null);
    expect(offline.channels.find(channel => channel.id === "desktop-hermes")!.enabled).toBe(false);
    const disabled = structuredClone(projection);
    disabled.installations[manifest.id].enabled = false;
    const denied = await hydrateState([manifest], [], disabled);
    expect(denied.channels.find(channel => channel.id === "desktop-hermes")!.enabled).toBe(false);

    // A disabled projection persisted during an outage must not freeze the next boot.
    const restored = await hydrateState([manifest], [], projection);
    expect(restored.channels.find(channel => channel.id === "desktop-hermes")!.enabled).toBe(true);
  });

  it("serializes UI state without any installation, grant, owner, candidate or projection cache", async () => {
    const readSaved = stubStorage();
    const state = forgedState();
    await persistState(state);
    const saved = readSaved();
    for (const key of ["installations", "activeSystemSlotProviderIds", "grants", "owners", "candidates", "harnessProjection", "governanceActivated"])
      expect(saved, key).not.toHaveProperty(key);
    expect(saved.uiPreferences).toEqual(state.uiPreferences);
    expect(saved.conversationThreads).toEqual(state.conversationThreads);
    expect(state.installations["addon.governance"].enabled).toBe(true);
  });

  it.each([true, false])("hydrates only acknowledged host governance in development (enabled=%s)", async enabled => {
    vi.stubEnv("MODE", "development");
    const readSaved = stubStorage(forgedState());
    const manifest = governanceManifest();
    const hostOnly = { ...manifest, id: "addon.host-only" };
    const projection: HarnessRegistryProjection = {
      bootEpoch: "current-boot", revision: 7, governanceActivated: true, candidates: [hostOnly],
      installations: { [hostOnly.id]: { addonId: hostOnly.id, installed: true, enabled,
        grantedCapabilities: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: enabled })),
        disabledOperations: [], hiddenSurfaceIds: [] } },
      slots: { "chat-interface": { addonId: hostOnly.id, available: enabled, generation: 2 } },
    };
    vi.stubGlobal("__RESONANTOS_BRIDGE_CONFIG__", { bridgeUrl: "http://127.0.0.1:47773" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, ...projection })));
    vi.stubGlobal("fetch", fetchMock);
    const state = await hydrateState([manifest], []);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:47773/addons/registry");
    expect(state.activeSystemSlotProviderIds).toEqual({ "chat-interface": hostOnly.id });
    expect(state.installations[manifest.id].enabled).toBe(false);
    expect(state.installations[hostOnly.id]).toMatchObject({ installed: true, enabled,
      grantedCapabilities: projection.installations[hostOnly.id].grantedCapabilities });
    expect(readSaved()).not.toHaveProperty("installations");
    expect(readSaved()).not.toHaveProperty("activeSystemSlotProviderIds");
  });
});
