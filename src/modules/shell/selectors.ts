// Intent citation: docs/architecture/ADR-002-modular-codebase.md

import type {
  AddOnInstallation,
  AddOnManifest,
  ChannelDefinition,
  ContextBudget,
  ContextMemoryState,
  HarnessRegistryProjection,
  ConversationThread,
  ProviderProfile,
  ProviderRuntimeNode,
  ProviderUsageTelemetry,
  ResonantShellState,
} from "../../core/contracts";
import {
  buildContextBudget,
  contextBudgetTitle,
  contextUsageRatio as ratioFromContextBudget,
  latestCompactStateForThread,
  promptMessagesForThread,
} from "../../core/context-memory";
import { resolveProviderPath, strategistDisplayName } from "../../core/policies";
import {
  resolveAgentChatRoute,
  resolveStrategistChatRoute,
  selectableAgentChatModels,
  type ProviderRouteResolution,
} from "../../core/provider-service";
import { canUseDictation } from "../chat/dictation";
import type { ComposerAttachment } from "../chat/types";
import { systemSlotAvailable } from "./system-slots";

type ViewModelInput = {
  state: ResonantShellState;
  harnessProjection?: HarnessRegistryProjection | null;
  bundled: AddOnManifest[];
  sideloaded: AddOnManifest[];
  deferredSearch: string;
  selectedAddonId: string;
  composer: string;
  attachments: ComposerAttachment[];
  selectedChatModel: string;
};

const latestProviderUsageFor = (thread: ConversationThread | null): ProviderUsageTelemetry | undefined =>
  [...(thread?.messages ?? [])].reverse().find((message) => message.providerUsage)?.providerUsage;

const DEFAULT_HERMES_MODEL = "gemma-4-26b-a4b-q4_k_m.gguf";

const uniqueModels = (models: string[]): string[] =>
  Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));

const configuredHermesModels = (state: ResonantShellState): string[] => {
  const config = state.installations["addon.hermes"]?.config ?? {};
  const configuredModel = typeof config.hermesModel === "string" ? config.hermesModel : "";
  const configuredModels = Array.isArray(config.hermesAvailableModels)
    ? config.hermesAvailableModels.filter((item): item is string => typeof item === "string")
    : [];
  return uniqueModels([configuredModel, ...configuredModels, DEFAULT_HERMES_MODEL]);
};

export const channelAllowedByOwningAddon = (state: ResonantShellState, channel: ChannelDefinition): boolean => {
  const addonId = channel.metadata?.addonId;
  if (!addonId) {
    return true;
  }
  const installation = state.installations[addonId];
  return Boolean(installation?.enabled);
};

const formatProviderUsageTitle = (usage: ProviderUsageTelemetry): string => {
  const lines = [`Last measured provider usage for ${usage.model} (${usage.source}).`];
  if (typeof usage.promptTokens === "number") {
    lines.push(`Prompt tokens: ${usage.promptTokens.toLocaleString()}.`);
  }
  if (typeof usage.completionTokens === "number") {
    lines.push(`Completion tokens: ${usage.completionTokens.toLocaleString()}.`);
  }
  if (typeof usage.totalTokens === "number") {
    lines.push(`Total tokens: ${usage.totalTokens.toLocaleString()}.`);
  }
  if (usage.source === "local-runtime" && typeof usage.tokensPerSecond === "number") {
    lines.push(`Completion TPS: ${usage.tokensPerSecond.toFixed(1)}.`);
  }
  return lines.join(" ");
};

export type ShellViewModel = {
  allManifests: AddOnManifest[];
  filteredManifests: AddOnManifest[];
  currentSection: ResonantShellState["uiPreferences"]["activeSection"];
  displayedStrategistName: string;
  selectedManifest: AddOnManifest | null;
  selectedInstallation: AddOnInstallation | null;
  recoveryModeActive: boolean;
  visibleThreads: ConversationThread[];
  activeThread: ConversationThread | null;
  activeThreadChannel: ChannelDefinition | null;
  strategist: ResonantShellState["agents"][number] | undefined;
  engineerAgent: ResonantShellState["agents"][number] | undefined;
  strategistRoute: ProviderRouteResolution;
  activeRoute: ProviderRouteResolution;
  activeProvider: ProviderProfile | undefined;
  activeRuntimeNode: ProviderRuntimeNode | undefined;
  activeChatModel: string;
  selectableChatModels: string[];
  strategistRecoveryActive: boolean;
  contextBudget: ContextBudget;
  contextUsageRatio: number;
  contextUsageLabel: string;
  contextUsageTitle: string;
  latestCompactState: ContextMemoryState | null;
  dictationAvailable: boolean;
};

export const resolveActiveProviderForSelection = (
  state: ResonantShellState | null,
  selectedChatModel: string,
  activeThreadId?: string,
): ProviderProfile | undefined => {
  if (!state) {
    return undefined;
  }

  const activeThread = activeThreadId ? state.conversationThreads.find((thread) => thread.id === activeThreadId) : null;
  const activeAgentId =
    activeThread?.owningAgentId ?? (state.recoverySession.active ? state.recoverySession.engineerAgentId : "strategist.core");
  if (activeAgentId === "hermes.agent") {
    return state.providers.find((profile) => profile.id === "shared-local") ?? state.providers.find((profile) => profile.providerType === "local");
  }
  return (
    resolveAgentChatRoute(state, activeAgentId, selectedChatModel).provider ??
    resolveProviderPath(
      state.providers.find(
        (profile) =>
          profile.id === state.agents.find((agent) => agent.id === activeAgentId)?.providerProfileId,
      ),
      state.providers.find(
        (profile) =>
          profile.id === state.agents.find((agent) => agent.id === activeAgentId)?.fallbackProviderProfileId,
      ),
    ).active
  );
};

export const resolveSelectableChatModelsForSelection = (
  state: ResonantShellState | null,
  activeThreadId?: string,
): string[] => {
  if (!state) {
    return [];
  }
  const activeThread = activeThreadId ? state.conversationThreads.find((thread) => thread.id === activeThreadId) : null;
  const activeAgentId =
    activeThread?.owningAgentId ?? (state.recoverySession.active ? state.recoverySession.engineerAgentId : "strategist.core");
  if (activeAgentId === "hermes.agent") {
    return configuredHermesModels(state);
  }
  return selectableAgentChatModels(state, activeAgentId);
};

export const buildShellViewModel = ({
  state,
  harnessProjection,
  bundled,
  sideloaded,
  deferredSearch,
  selectedAddonId,
  composer,
  attachments,
  selectedChatModel,
}: ViewModelInput): ShellViewModel => {
  const allManifests = [...bundled, ...sideloaded];
  const needle = deferredSearch.trim().toLowerCase();
  const filteredManifests = !needle
    ? allManifests
    : allManifests.filter((manifest) => {
        const haystack = `${manifest.name} ${manifest.category} ${manifest.description}`.toLowerCase();
        return haystack.includes(needle);
      });
  const manifestMap = new Map(allManifests.map((manifest) => [manifest.id, manifest]));
  const displayedStrategistName = strategistDisplayName(state);
  const selectedManifest =
    manifestMap.get(selectedAddonId) ?? filteredManifests[0] ?? bundled[0] ?? sideloaded[0] ?? null;
  const selectedInstallation = selectedManifest ? state.installations[selectedManifest.id] ?? null : null;
  const recoveryModeActive = state.recoverySession.active;
  const chatSlotAvailable = systemSlotAvailable(state, allManifests, "chat-interface", harnessProjection);
  const engineerSettingsConsoleActive = !recoveryModeActive && !chatSlotAvailable && state.uiPreferences.activeSection === "settings";
  const chatInterfaceAvailable = recoveryModeActive || chatSlotAvailable || engineerSettingsConsoleActive;
  const selectedChatThread = state.conversationThreads.find((thread) => thread.id === state.uiPreferences.activeChatThreadId);
  const visibleAgentId = recoveryModeActive
    ? state.recoverySession.engineerAgentId
    : engineerSettingsConsoleActive
      ? state.recoverySession.engineerAgentId
    : selectedChatThread?.owningAgentId ?? "strategist.core";
  const visibleThreads = state.conversationThreads.filter((thread) => {
    if (thread.owningAgentId !== visibleAgentId) {
      return false;
    }
    const channel = state.channels.find((item) => item.id === thread.channelId);
    return channel ? channelAllowedByOwningAddon(state, channel) : true;
  });
  const activeThread = chatInterfaceAvailable
    ? visibleThreads.find((thread) => thread.id === state.uiPreferences.activeChatThreadId) ?? visibleThreads[0] ?? null
    : null;
  const activeThreadChannel = activeThread
    ? state.channels.find((channel) => channel.id === activeThread.channelId) ?? null
    : null;
  const strategist = state.agents.find((agent) => agent.id === "strategist.core");
  const engineerAgent = state.agents.find((agent) => agent.id === state.recoverySession.engineerAgentId);
  const providerResolution = resolveProviderPath(
    state.providers.find((profile) => profile.id === strategist?.providerProfileId),
    state.providers.find((profile) => profile.id === strategist?.fallbackProviderProfileId),
  );
  const activeAgentId = activeThread?.owningAgentId ?? (recoveryModeActive ? state.recoverySession.engineerAgentId : "strategist.core");
  const activeRoute = resolveAgentChatRoute(state, activeAgentId, selectedChatModel);
  const strategistRoute = resolveStrategistChatRoute(state, selectedChatModel);
  const hermesAgentActive = activeAgentId === "hermes.agent";
  const activeProvider = hermesAgentActive
    ? state.providers.find((profile) => profile.id === "shared-local") ?? activeRoute.provider ?? providerResolution.active
    : activeRoute.provider ?? providerResolution.active;
  const activeRuntimeNode = hermesAgentActive ? undefined : activeRoute.runtimeNode;
  const selectableChatModels = hermesAgentActive ? configuredHermesModels(state) : selectableAgentChatModels(state, activeAgentId);
  const activeChatModel =
    selectedChatModel && selectableChatModels.includes(selectedChatModel)
      ? selectedChatModel
      : hermesAgentActive
        ? selectableChatModels[0] ?? DEFAULT_HERMES_MODEL
        : activeRoute.model || activeProvider?.primaryModel || "";
  const strategistRecoveryActive =
    recoveryModeActive || strategist?.providerProfileId === "shared-local" || activeRuntimeNode?.kind === "local";
  const latestCompactState = activeThread ? latestCompactStateForThread(state, activeThread.id) : null;
  const effectiveBudgetThread =
    activeThread && latestCompactState
      ? { ...activeThread, messages: promptMessagesForThread(activeThread, latestCompactState) }
      : activeThread;
  const contextBudget = buildContextBudget({
    thread: effectiveBudgetThread,
    composer,
    attachments,
    provider: activeProvider,
    runtimeNode: activeRuntimeNode,
    modelId: activeChatModel,
  });
  const contextUsageRatio = ratioFromContextBudget(contextBudget);
  const contextUsageLabel = `${Math.round(contextUsageRatio * 100)}%`;
  const latestProviderUsage = latestProviderUsageFor(activeThread);
  const contextUsageTitle = [
    contextBudgetTitle(contextBudget),
    latestProviderUsage ? formatProviderUsageTitle(latestProviderUsage) : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    allManifests,
    filteredManifests,
    currentSection: state.uiPreferences.activeSection,
    displayedStrategistName,
    selectedManifest,
    selectedInstallation,
    recoveryModeActive,
    visibleThreads,
    activeThread,
    activeThreadChannel,
    strategist,
    engineerAgent,
    strategistRoute,
    activeRoute,
    activeProvider,
    activeRuntimeNode,
    activeChatModel,
    selectableChatModels,
    strategistRecoveryActive,
    contextBudget,
    contextUsageRatio,
    contextUsageLabel,
    contextUsageTitle,
    latestCompactState,
    dictationAvailable: canUseDictation(),
  };
};
