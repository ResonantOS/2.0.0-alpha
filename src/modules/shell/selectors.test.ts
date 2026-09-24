import { describe, expect, it } from "vitest";
import type { AddOnManifest, ChannelDefinition, ConversationThread, HarnessRegistryProjection } from "../../core/contracts";
import augmentor from "../../../public/addons/augmentor-chat.json";
import { buildDefaultState } from "../../core/defaults";
import {
  buildShellViewModel,
  channelAllowedByOwningAddon,
  resolveActiveProviderForSelection,
  resolveSelectableChatModelsForSelection,
} from "./selectors";

describe("resolveActiveProviderForSelection", () => {
  it("returns undefined when state is null", () => {
    expect(resolveActiveProviderForSelection(null, "")).toBeUndefined();
  });

  it("returns shared-local provider for Hermes agent thread", () => {
    const state = buildDefaultState([]);
    const hermesThread = state.conversationThreads.find((t) => t.owningAgentId === "hermes.agent");
    if (!hermesThread) return;

    const provider = resolveActiveProviderForSelection(state, "", hermesThread.id);
    expect(provider?.id).toBe("shared-local");
  });
});

describe("channelAllowedByOwningAddon", () => {
  it("returns true when the channel has no owning addon", () => {
    const state = buildDefaultState([]);
    const channel: ChannelDefinition = {
      id: "desktop-main",
      type: "desktop",
      label: "Main",
      owningAgentId: "strategist.core",
      strategistIdentityId: "strategist.identity",
      enabled: true,
      sessionMode: "shared-identity",
      workspaceId: "ws-main",
      metadata: {},
    };
    expect(channelAllowedByOwningAddon(state, channel)).toBe(true);
  });

  it("returns false when the owning addon is disabled", () => {
    const state = buildDefaultState([]);
    state.installations["addon.companion"] = {
      addonId: "addon.companion",
      source: "bundled",
      provenanceTier: "curated-signed",
      verificationState: "verified",
      installed: true,
      enabled: false,
      status: "disabled",
      grantedCapabilities: [],
      recommendedGrantPresetIds: [],
      privateProviderProfileIds: [],
      notes: [],
    };
    const channel: ChannelDefinition = {
      id: "desktop-companion",
      type: "desktop",
      label: "Companion",
      owningAgentId: "addon.companion",
      strategistIdentityId: "strategist.identity",
      enabled: true,
      sessionMode: "isolated-session",
      workspaceId: "ws-companion",
      metadata: { addonId: "addon.companion" },
    };
    expect(channelAllowedByOwningAddon(state, channel)).toBe(false);
  });
});

describe("buildShellViewModel", () => {
  it.each([true, false])("uses acknowledged chat ownership instead of contradictory local availability (host available: %s)", available => {
    const manifest = augmentor as AddOnManifest;
    const state = buildDefaultState([manifest]);
    state.uiPreferences.activeSection = "overview";
    if (!available) {
      state.installations[manifest.id] = { ...state.installations[manifest.id], installed: true, enabled: true,
        grantedCapabilities: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: true })) };
      state.activeSystemSlotProviderIds = { "chat-interface": manifest.id };
    }
    const before = structuredClone(state);
    const harnessProjection: HarnessRegistryProjection = {
      bootEpoch: "first-run", revision: 3, governanceActivated: true, candidates: [manifest],
      installations: { [manifest.id]: { addonId: manifest.id, installed: true, enabled: true,
        grantedCapabilities: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: true })),
        disabledOperations: [], hiddenSurfaceIds: [] } },
      slots: { "chat-interface": { addonId: available ? manifest.id : null, generation: 1, available } },
    };
    const input = { state, bundled: [manifest], sideloaded: [], deferredSearch: "", selectedAddonId: "",
      composer: "Hello after first run", attachments: [], selectedChatModel: "", harnessProjection };
    const viewModel = buildShellViewModel(input);
    if (available) expect(viewModel.activeThread).not.toBeNull();
    else expect(viewModel.activeThread).toBeNull();
    expect(state).toEqual(before);
    // An unowned slot remains vacant even when local state claims consent.
    expect(buildShellViewModel({ ...input, harnessProjection: { ...harnessProjection, slots: {} } }).activeThread === null)
      .toBe(true);
  });

  it("surfaces and labels agree with projected governance despite forged local identity", () => {
    const manifest = { ...augmentor as AddOnManifest, id: "addon.projected-agent", name: "Projected Agent" };
    const state = buildDefaultState([manifest]);
    state.strategistIdentity.customName = "Forged local agent";
    state.activeSystemSlotProviderIds = { "primary-agent": "addon.forged" };
    const harnessProjection: HarnessRegistryProjection = {
      bootEpoch: "identity", revision: 1, governanceActivated: true, candidates: [manifest],
      installations: { [manifest.id]: { addonId: manifest.id, installed: true, enabled: true,
        grantedCapabilities: [], disabledOperations: [], hiddenSurfaceIds: [] } },
      slots: { "primary-agent": { addonId: manifest.id, generation: 1, available: true },
        "chat-interface": { addonId: manifest.id, generation: 1, available: true } },
    };
    const input = { state, bundled: [manifest], sideloaded: [], deferredSearch: "", selectedAddonId: "",
      composer: "", attachments: [], selectedChatModel: "", harnessProjection };
    expect(buildShellViewModel(input).displayedStrategistName).toBe("Projected Agent");
    expect(buildShellViewModel({ ...input, harnessProjection: { ...harnessProjection, slots: {} } }).displayedStrategistName)
      .toBe("No active agent");
    const chatOnly = { ...harnessProjection, slots: { "chat-interface": harnessProjection.slots["chat-interface"]! } };
    expect(buildShellViewModel({ ...input, harnessProjection: chatOnly }).displayedStrategistName).toBe("Projected Agent");
  });

  it("filters manifests by search query", () => {
    const state = buildDefaultState([]);
    const bundled: AddOnManifest[] = [
      {
        id: "addon.alpha",
        name: "Alpha Addon",
        version: "0.1.0",
        author: "test",
        category: "tool",
        description: "UI tools",
        runtimeType: "ui-module",
        surfaces: [],
        requestedCapabilities: [],
        providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
        archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
        health: { strategy: "none" },
        installHooks: {},
        compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
      },
      {
        id: "addon.beta",
        name: "Beta Service",
        version: "0.1.0",
        author: "test",
        category: "agent",
        description: "Background agent service",
        runtimeType: "local-service",
        surfaces: [],
        requestedCapabilities: [],
        providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
        archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
        health: { strategy: "none" },
        installHooks: {},
        compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
      },
    ];

    const withMatch = buildShellViewModel({
      state,
      bundled,
      sideloaded: [],
      deferredSearch: "alpha",
      selectedAddonId: "",
      composer: "",
      attachments: [],
      selectedChatModel: "",
    });
    expect(withMatch.filteredManifests).toHaveLength(1);
    expect(withMatch.filteredManifests[0].id).toBe("addon.alpha");
  });

  it("returns all manifests when search is empty", () => {
    const state = buildDefaultState([]);
    const bundled: AddOnManifest[] = [
      {
        id: "addon.one",
        name: "One",
        version: "0.1.0",
        author: "test",
        category: "agent",
        description: "",
        runtimeType: "agent-addon",
        surfaces: [],
        requestedCapabilities: [],
        providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
        archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
        health: { strategy: "none" },
        installHooks: {},
        compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
      },
    ];

    const vm = buildShellViewModel({
      state,
      bundled,
      sideloaded: [],
      deferredSearch: "",
      selectedAddonId: "",
      composer: "",
      attachments: [],
      selectedChatModel: "",
    });
    expect(vm.filteredManifests).toHaveLength(1);
    expect(vm.allManifests).toHaveLength(1);
  });

  it("reports recovery mode active", () => {
    const state = buildDefaultState([]);
    state.recoverySession.active = true;

    const vm = buildShellViewModel({
      state,
      bundled: [],
      sideloaded: [],
      deferredSearch: "",
      selectedAddonId: "",
      composer: "",
      attachments: [],
      selectedChatModel: "",
    });

    expect(vm.recoveryModeActive).toBe(true);
    expect(vm.strategistRecoveryActive).toBe(true);
  });
});

describe("Hermes chat model selection", () => {
  it("uses Hermes' configured local model instead of the generic agent route", () => {
    const state = buildDefaultState([]);
    state.installations["addon.hermes"] = {
      ...state.installations["addon.hermes"],
      installed: true,
      enabled: true,
      status: "enabled",
      config: {
        ...(state.installations["addon.hermes"]?.config ?? {}),
        hermesModel: "gemma-4-26b-a4b-q4_k_m.gguf",
        hermesAvailableModels: ["gemma-4-26b-a4b-q4_k_m.gguf"],
      },
    };
    const hermesThread =
      state.conversationThreads.find((thread) => thread.owningAgentId === "hermes.agent") ??
      ({
        id: "thread-hermes-selector-test",
        title: "Hermes selector test",
        owningAgentId: "hermes.agent",
        workspaceId: "workspace-hermes",
        channelId: "desktop-hermes",
        summary: "",
        messages: [],
      } satisfies ConversationThread);
    state.conversationThreads = [hermesThread, ...state.conversationThreads.filter((thread) => thread.id !== hermesThread.id)];
    state.uiPreferences.activeChatThreadId = hermesThread.id;

    const selectable = resolveSelectableChatModelsForSelection(state, hermesThread.id);
    const manifest = augmentor as AddOnManifest;
    const harnessProjection: HarnessRegistryProjection = {
      bootEpoch: "hermes-chat", revision: 1, governanceActivated: true, candidates: [manifest],
      installations: { [manifest.id]: { addonId: manifest.id, installed: true, enabled: true,
        grantedCapabilities: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: true })),
        disabledOperations: [], hiddenSurfaceIds: [] } },
      slots: { "chat-interface": { addonId: manifest.id, generation: 1, available: true } },
    };
    const viewModel = buildShellViewModel({
      state,
      harnessProjection,
      bundled: [],
      sideloaded: [],
      deferredSearch: "",
      selectedAddonId: "",
      composer: "",
      attachments: [],
      selectedChatModel: "",
    });

    expect(selectable).toEqual(["gemma-4-26b-a4b-q4_k_m.gguf"]);
    expect(viewModel.activeChatModel).toBe("gemma-4-26b-a4b-q4_k_m.gguf");
  });
});
