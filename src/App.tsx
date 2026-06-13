// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-003-engineering-standards.md

import { Suspense, lazy, startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type {
  AddOnManifest,
  ArchiveAiMemoryBuildJobSummary,
  ArchiveAiMemoryBuildResult,
  ArchiveBackgroundCycleResult,
  ArchiveDocumentPayload,
  ArchiveImportedLibrarySummary,
  ArchiveLibraryClassificationReview,
  ArchiveLibraryReorganisationPlan,
  ArchiveLintResult,
  ArchiveMaintenanceCycleResult,
  ArchivePromoteReviewArtifactResult,
  ArchiveProcessIngestResult,
  ArchiveQueuedIngestRequest,
  ArchiveReviewArtifact,
  ArchiveReviewDecisionResult,
  ArchiveLibraryImportResult,
  ArchiveLibraryImportMode,
  ArchiveLibraryPreflightResult,
  ArchiveMemoryDomain,
  ArchiveSourceFolderScanResult,
  ArchiveSourceWatchRecord,
  ArchiveTolBundleBuildResult,
  ArchiveTolBundleCandidate,
  ArchiveIngestProbeResult,
  ArchiveRuntimeStatus,
  BrowserExtensionListResult,
  BrowserExtensionLoadResult,
  BrowserExtensionState,
  BrowserOpenUrlResult,
  ArchiveSearchResult,
  ArchiveSemanticLintResult,
  ChatRunEvent,
  ChatRunPhase,
  ConversationThread,
  LivingArchiveMemoryServiceResult,
  LivingArchiveMemoryServiceStatus,
  LocalRuntimeStatus,
  ProviderDiagnosticReport,
  ProviderSmokeTestResult,
  RecoveryRouteCandidate,
  ResonantShellState,
} from "./core/contracts";
import { resolveMemoryProviderBroker } from "./core/memory-provider";
import { routedProviderLabel } from "./core/provider-service";
import {
  hideLiveBrowserWebview,
  openLiveBrowserWebview,
  openFloatingChatWindow,
  persistState,
  resizeLiveBrowserWebview,
  requestBrowserNativeWebviewHide,
  requestBrowserNativeWebviewResize,
  requestBrowserNativeWebviewShow,
  requestBrowserSessionReadPage,
  requestBrowserSessionOpenUrl,
  requestBrowserSessionScroll,
  requestBrowserStartSession,
  requestBrowserVisibleHostCommand,
  requestBrowserExtensionFolderSelection,
  requestComputeLocalPassiveDiagnostics,
  requestComputeLocalSafeCommand,
  requestNativeBrowserAttachSmoke,
  requestNativeBrowserBridgeProbe,
  requestNativeBrowserProbe,
  requestObsidianVaultFolderSelection,
  subscribeRuntimeStateUpdates,
} from "./core/runtime";
import {
  executeSideloadManifest,
  grantAddonCapabilities,
  runAddonLogicianHook,
  runAddonLogicianScript,
  toggleAddonCapabilityGrant,
  toggleAddonInstallation,
  updateAddonConfig,
} from "./modules/addons/controller";
import {
  executeArchiveIngestProbe,
  executeArchiveSearch,
  buildArchiveTolBundle,
  decideArchiveReviewArtifact,
  generateArchiveLibraryReorganisationPlan,
  importArchiveLibrary,
  loadArchiveAiMemoryBuildJobs,
  loadArchiveLibraryClassificationReview,
  loadArchiveImportedLibraries,
  loadArchiveTolBundles,
  loadArchiveDocument,
  loadArchiveReviewQueue,
  loadArchiveRuntimeStatus,
  pickArchiveLibraryFolder,
  preflightArchiveLibrary,
  processArchiveQueuedRequest,
  promoteApprovedArchiveReviewArtifacts,
  promoteArchiveReviewArtifact,
  queueArchiveSourceForIngest,
  queueWatchedArchiveSourceForIngest,
  runArchiveAiMemoryBuildJob,
  runArchiveBackgroundCycle,
  runArchiveLint,
  runArchiveSemanticLint,
  scanArchiveSourceFolders,
} from "./modules/archive/controller";
import { buildArchivePreflightAugmentorPrompt } from "./modules/archive/archive-augmentor-handoff";
import { inspectImportedLibraryCoverage } from "./modules/archive/archive-agent-tools";
import {
  attachComposerFiles,
  BrowserSpeechRecognition,
  removeComposerAttachment,
  toggleComposerDictation,
} from "./modules/chat/composer-controller";
import { saveChatMessageToArchiveIntake } from "./modules/chat/archive-intake-controller";
import { executeChatTurn } from "./modules/chat/controller";
import { claimChatRun, releaseChatRun } from "./modules/chat/run-guard";
import { StrategistChatRail } from "./modules/chat/StrategistChatRail";
import { appendTranscriptEvent } from "./core/context-memory";
import {
  applyComputePassiveDiagnostics,
  applyComputeSafeCommandResult,
  quarantineComputeNodeForReview,
  revokeComputeNodeTrust,
  submitLocalSafeCommandProbe,
} from "./modules/compute/controller";
import {
  branchChatFromMessageAction,
  branchChatProjectAction,
  branchChatThreadAction,
  createAgentChatThreadAction,
  createChatProjectAction,
  deleteChatProjectAction,
  compactActiveChatContextAction,
  deleteChatMessageAction,
  deleteChatThreadAction,
  editUserMessageAction,
  moveChatThreadToProjectAction,
  renameChatProjectAction,
  renameChatThreadAction,
  selectChatAgentAction,
  stopChatGenerationAction,
  togglePinnedChatProjectAction,
  togglePinnedChatThreadAction,
  updateCompactMemoryAction,
} from "./modules/chat/thread-controller";
import type { ComposerAttachment, ThinkingDepth } from "./modules/chat/types";
import { Panel } from "./components/Panel";
import { HermesWorkspace } from "./modules/hermes/HermesWorkspace";
import { OpenCodeWorkspace } from "./modules/opencode/OpenCodeWorkspace";
import { PaperclipWorkspace } from "./modules/paperclip/PaperclipWorkspace";
import { promoteRecoveryRoute, RECOVERY_RUNBOOK_PROMPT, setRecoveryMode } from "./modules/recovery/controller";
import {
  applyFirstRunRecommendedAddOns,
  loadInitialShellState,
  loadRecoveryRuntimeSnapshot,
  markFirstRunRecommendedAddOnsReviewed,
} from "./modules/shell/controller";
import {
  buildShellViewModel,
  channelAllowedByOwningAddon,
  resolveActiveProviderForSelection,
  resolveSelectableChatModelsForSelection,
} from "./modules/shell/selectors";
import {
  activeSystemSlotProvider,
  hasSystemSlotManifest,
  recommendedSystemSlotManifests,
  systemSlotAvailable,
} from "./modules/shell/system-slots";
import { createAddOnSurfaceDockRoutes } from "./sdk/addons";
import {
  executeCreateProviderProfile,
  executeRefreshProviderDiagnostics,
  executeRefreshMemoryServiceStatus,
  executeProviderSmokeTest,
  executeSaveProviderSecret,
  executeSetupProviderProfile,
  executeStartMemoryService,
  executeStopMemoryService,
  updateModelWorkloadStrategy,
  updateModelWorkloadStrategyRoute,
  updateProviderProfile,
  type CreateProviderProfileInput,
} from "./modules/settings/controller";
import type { SettingsSection } from "./modules/settings/SettingsWorkspace";
import {
  activateChatThread,
  renameStrategistIdentity,
  toggleStrategistChannel,
} from "./modules/strategist/controller";

const ArchiveWorkspace = lazy(() =>
  import("./modules/archive/ArchiveWorkspace").then((module) => ({ default: module.ArchiveWorkspace })),
);
const BrowserWorkspace = lazy(() =>
  import("./modules/browser/BrowserWorkspace").then((module) => ({ default: module.BrowserWorkspace })),
);
const AddOnsWorkspace = lazy(() =>
  import("./modules/addons/AddOnsWorkspace").then((module) => ({ default: module.AddOnsWorkspace })),
);
const SettingsWorkspace = lazy(() =>
  import("./modules/settings/SettingsWorkspace").then((module) => ({ default: module.SettingsWorkspace })),
);
const DelegationWorkspace = lazy(() =>
  import("./modules/delegation/DelegationWorkspace").then((module) => ({ default: module.DelegationWorkspace })),
);
const ComputeFabricWorkspace = lazy(() =>
  import("./modules/compute/ComputeFabricWorkspace").then((module) => ({ default: module.ComputeFabricWorkspace })),
);
const OverviewWorkspace = lazy(() =>
  import("./modules/overview/OverviewWorkspace").then((module) => ({ default: module.OverviewWorkspace })),
);
const RecoveryWorkspace = lazy(() =>
  import("./modules/recovery/RecoveryWorkspace").then((module) => ({ default: module.RecoveryWorkspace })),
);
const StrategistWorkspace = lazy(() =>
  import("./modules/strategist/StrategistWorkspace").then((module) => ({ default: module.StrategistWorkspace })),
);
const TerminalWorkspace = lazy(() =>
  import("./modules/terminal/TerminalWorkspace").then((module) => ({ default: module.TerminalWorkspace })),
);
const ObsidianWorkspace = lazy(() =>
  import("./modules/obsidian/ObsidianWorkspace").then((module) => ({ default: module.ObsidianWorkspace })),
);
const Audio2TolWorkspace = lazy(() =>
  import("./modules/audio2tol/Audio2TolWorkspace").then((module) => ({ default: module.Audio2TolWorkspace })),
);

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; state: ResonantShellState; bundled: AddOnManifest[]; sideloaded: AddOnManifest[] }
  | { phase: "error"; message: string };

type Section = ResonantShellState["uiPreferences"]["activeSection"];
type DockIconId =
  | "home"
  | "archive"
  | "delegation"
  | "compute"
  | "addons"
  | "browser"
  | "obsidian"
  | "opencode"
  | "paperclip"
  | "hermes"
  | "terminal"
  | "audio2tol"
  | "agent"
  | "settings";
type VendorIconId =
  | "apps"
  | "archive"
  | "database"
  | "chart-bar"
  | "home"
  | "layout-sidebar-left-expand"
  | "layout-sidebar-right-collapse"
  | "robot"
  | "route-alt-left"
  | "settings"
  | "world";

const dockIconMap: Record<Exclude<DockIconId, "obsidian" | "opencode" | "paperclip" | "hermes" | "terminal" | "audio2tol">, VendorIconId> = {
  home: "home",
  archive: "database",
  delegation: "route-alt-left",
  compute: "chart-bar",
  addons: "apps",
  browser: "world",
  agent: "robot",
  settings: "settings",
};

const navItems: Array<{ id: Section; label: string; eyebrow: string; icon: DockIconId; pinned?: boolean }> = [
  { id: "overview", label: "Home", eyebrow: "apps", icon: "home", pinned: true },
  { id: "archive", label: "Living Archive", eyebrow: "memory", icon: "archive", pinned: true },
  { id: "delegation", label: "Delegation", eyebrow: "tasks", icon: "delegation", pinned: true },
  { id: "compute", label: "Compute", eyebrow: "runners", icon: "compute", pinned: true },
  { id: "addons", label: "Add-ons", eyebrow: "catalog", icon: "addons", pinned: true },
  { id: "strategist", label: "Agent Identity", eyebrow: "identity", icon: "agent" },
  { id: "settings", label: "Settings", eyebrow: "system", icon: "settings", pinned: true },
];

const CHAT_HISTORY_WIDTH = 300;
const CHAT_RAIL_MIN_WIDTH = 420;
const CHAT_RAIL_MAX_WIDTH = 1240;
const CHAT_RAIL_WITH_HISTORY_MIN_WIDTH = 760;
const ZOOM_STEP = 0.05;
const MIN_WINDOW_ZOOM = 0.85;
const MAX_WINDOW_ZOOM = 1.25;
const appSurfaceMode = (): "shell" | "floating-chat" => {
  if (typeof window === "undefined") {
    return "shell";
  }
  return new URLSearchParams(window.location.search).get("surface") === "floating-chat" ? "floating-chat" : "shell";
};

const clampChatWidth = (width: number): number => Math.min(CHAT_RAIL_MAX_WIDTH, Math.max(CHAT_RAIL_MIN_WIDTH, Math.round(width)));
const clampWindowZoom = (zoom: number): number => Math.min(MAX_WINDOW_ZOOM, Math.max(MIN_WINDOW_ZOOM, Number(zoom.toFixed(2))));

const errorMessageOf = (error: unknown, fallback: string): string =>
  typeof error === "string" ? error : error instanceof Error ? error.message : fallback;

export function App() {
  const surfaceMode = appSurfaceMode();
  const isFloatingChatSurface = surfaceMode === "floating-chat";
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" });
  const currentReadyStateRef = useRef<ResonantShellState | null>(null);
  const [search, setSearch] = useState("");
  const [sideloadPath, setSideloadPath] = useState("");
  const [selectedAddonId, setSelectedAddonId] = useState<string>("");
  const [firstRunSelections, setFirstRunSelections] = useState<Record<string, boolean>>({});
  const [archiveFocusTarget, setArchiveFocusTarget] = useState<"review" | null>(null);
  const [composer, setComposer] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatRunPhase, setChatRunPhase] = useState<ChatRunPhase>("idle");
  const [chatRunEvents, setChatRunEvents] = useState<ChatRunEvent[]>([]);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, string>>({});
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("providers");
  const [providerDiagnostics, setProviderDiagnostics] = useState<ProviderDiagnosticReport[]>([]);
  const [providerDiagnosticsBusy, setProviderDiagnosticsBusy] = useState(false);
  const [activeProviderProbeId, setActiveProviderProbeId] = useState<string | null>(null);
  const [providerSmokeResults, setProviderSmokeResults] = useState<Record<string, ProviderSmokeTestResult>>({});
  const [providerSmokeBusyId, setProviderSmokeBusyId] = useState<string | null>(null);
  const [memoryServiceStatus, setMemoryServiceStatus] = useState<LivingArchiveMemoryServiceStatus | null>(null);
  const [memoryServiceBusy, setMemoryServiceBusy] = useState(false);
  const [memoryServiceLastResult, setMemoryServiceLastResult] = useState<LivingArchiveMemoryServiceResult | null>(null);
  const [thinkingDepth, setThinkingDepth] = useState<ThinkingDepth>("high");
  const [selectedChatModel, setSelectedChatModel] = useState<string>("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dictating, setDictating] = useState(false);
  const [agentActivityLabel, setAgentActivityLabel] = useState("Standing by.");
  const [floatingChatHistoryOpen, setFloatingChatHistoryOpen] = useState(false);
  const [systemClockLabel, setSystemClockLabel] = useState(() =>
    new Date().toLocaleString([], {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    }),
  );
  const nativeBrowserNavigationRef = useRef<{ tabId: string; url: string } | null>(null);
  const [recoveryRuntimeStatus, setRecoveryRuntimeStatus] = useState<LocalRuntimeStatus | null>(null);
  const [recoveryCandidates, setRecoveryCandidates] = useState<RecoveryRouteCandidate[]>([]);
  const [archiveStatusBusy, setArchiveStatusBusy] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState<ArchiveRuntimeStatus | null>(null);
  const [archiveSearchBusy, setArchiveSearchBusy] = useState(false);
  const [archiveSearchResult, setArchiveSearchResult] = useState<ArchiveSearchResult | null>(null);
  const [archiveDocumentBusy, setArchiveDocumentBusy] = useState(false);
  const [archiveDocument, setArchiveDocument] = useState<ArchiveDocumentPayload | null>(null);
  const [archiveQueueBusy, setArchiveQueueBusy] = useState(false);
  const [archiveQueue, setArchiveQueue] = useState<ArchiveQueuedIngestRequest[]>([]);
  const [archiveReviewArtifacts, setArchiveReviewArtifacts] = useState<ArchiveReviewArtifact[]>([]);
  const [archiveProcessResult, setArchiveProcessResult] = useState<ArchiveProcessIngestResult | null>(null);
  const [archiveReviewDecisionResult, setArchiveReviewDecisionResult] = useState<ArchiveReviewDecisionResult | null>(null);
  const [archivePromotionResult, setArchivePromotionResult] = useState<ArchivePromoteReviewArtifactResult | null>(null);
  const [archiveMaintenanceResult, setArchiveMaintenanceResult] = useState<ArchiveMaintenanceCycleResult | null>(null);
  const [archiveAiMemoryBuildResult, setArchiveAiMemoryBuildResult] = useState<ArchiveAiMemoryBuildResult | null>(null);
  const [archiveAiMemoryBuildJobs, setArchiveAiMemoryBuildJobs] = useState<ArchiveAiMemoryBuildJobSummary[]>([]);
  const [archiveBackgroundResult, setArchiveBackgroundResult] = useState<ArchiveBackgroundCycleResult | null>(null);
  const [archiveLintResult, setArchiveLintResult] = useState<ArchiveLintResult | null>(null);
  const [archiveSemanticLintResult, setArchiveSemanticLintResult] = useState<ArchiveSemanticLintResult | null>(null);
  const [archiveTolBundles, setArchiveTolBundles] = useState<ArchiveTolBundleCandidate[]>([]);
  const [archiveTolBundleResult, setArchiveTolBundleResult] = useState<ArchiveTolBundleBuildResult | null>(null);
  const [archiveSourceScanBusy, setArchiveSourceScanBusy] = useState(false);
  const [archiveSourceScanResult, setArchiveSourceScanResult] = useState<ArchiveSourceFolderScanResult | null>(null);
  const [archiveImportedLibraries, setArchiveImportedLibraries] = useState<ArchiveImportedLibrarySummary[]>([]);
  const [archiveClassificationReview, setArchiveClassificationReview] = useState<ArchiveLibraryClassificationReview | null>(null);
  const [archiveReorganisationPlan, setArchiveReorganisationPlan] = useState<ArchiveLibraryReorganisationPlan | null>(null);
  const [archiveLibraryImportResult, setArchiveLibraryImportResult] = useState<ArchiveLibraryImportResult | null>(null);
  const [archiveLibraryPreflightResult, setArchiveLibraryPreflightResult] = useState<ArchiveLibraryPreflightResult | null>(null);
  const [archiveProbeBusy, setArchiveProbeBusy] = useState(false);
  const [archiveProbeResult, setArchiveProbeResult] = useState<{
    probe: ArchiveIngestProbeResult;
    routeLabel: string;
    model: string;
    resolutionReason: string;
  } | null>(null);
  const chatScrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const activeChatRunTokenRef = useRef<string | null>(null);
  const deferredSearch = useDeferredValue(search);
  const activeProviderForSelection = resolveActiveProviderForSelection(
    loadState.phase === "ready" ? loadState.state : null,
    selectedChatModel,
    loadState.phase === "ready" ? loadState.state.uiPreferences.activeChatThreadId : undefined,
  );
  const selectableChatModelsForSelection = resolveSelectableChatModelsForSelection(
    loadState.phase === "ready" ? loadState.state : null,
    loadState.phase === "ready" ? loadState.state.uiPreferences.activeChatThreadId : undefined,
  );
  const selectableChatModelKey = selectableChatModelsForSelection.join("\u0000");

  useEffect(() => {
    void (async () => {
      try {
        const booted = await loadInitialShellState();
        setLoadState({
          phase: "ready",
          state: booted.state,
          bundled: booted.bundled,
          sideloaded: booted.sideloaded,
        });
        setSelectedAddonId(booted.selectedAddonId);
      } catch (error) {
        setLoadState({
          phase: "error",
          message: errorMessageOf(error, "Failed to boot ResonantOS vNext."),
        });
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void subscribeRuntimeStateUpdates((nextState) => {
      if (cancelled) {
        return;
      }
      currentReadyStateRef.current = nextState;
      setLoadState((current) =>
        current.phase === "ready"
          ? { ...current, state: nextState }
          : current,
      );
    }).then((cleanup) => {
      if (cancelled) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (loadState.phase !== "ready" || !loadState.state.uiPreferences.chatSidebarOpen) {
      return;
    }
    const selectedThread = loadState.state.conversationThreads.find(
      (thread) => thread.id === loadState.state.uiPreferences.activeChatThreadId,
    );
    const activeAgentId = loadState.state.recoverySession.active
      ? loadState.state.recoverySession.engineerAgentId
      : selectedThread?.owningAgentId ?? "strategist.core";
    const visibleThreads = loadState.state.conversationThreads.filter((thread) => thread.owningAgentId === activeAgentId);
    const activeThread =
      visibleThreads.find((thread) => thread.id === loadState.state.uiPreferences.activeChatThreadId) ?? visibleThreads[0] ?? null;
    if (!activeThread) {
      return;
    }
    chatScrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [loadState]);

  useEffect(() => {
    if (!activeProviderForSelection || selectableChatModelsForSelection.length === 0) {
      return;
    }
    if (!selectedChatModel || !selectableChatModelsForSelection.includes(selectedChatModel)) {
      setSelectedChatModel(
        selectableChatModelsForSelection.includes(activeProviderForSelection.primaryModel)
          ? activeProviderForSelection.primaryModel
          : selectableChatModelsForSelection[0],
      );
    }
  }, [activeProviderForSelection, selectableChatModelKey, selectedChatModel]);

  useEffect(() => {
    if (loadState.phase !== "ready" || !loadState.state.recoverySession.active) {
      setRecoveryRuntimeStatus(null);
      setRecoveryCandidates([]);
      return;
    }

    void (async () => {
      try {
        const snapshot = await loadRecoveryRuntimeSnapshot(loadState.state);
        setRecoveryRuntimeStatus(snapshot.status);
        setRecoveryCandidates(snapshot.candidates);
      } catch {
        setRecoveryRuntimeStatus(null);
        setRecoveryCandidates([]);
      }
    })();
  }, [loadState]);

  useEffect(() => {
    if (loadState.phase !== "ready" || settingsSection !== "providers" || providerDiagnostics.length) {
      return;
    }
    void refreshProviderDiagnostics();
  }, [loadState, settingsSection, providerDiagnostics.length]);

  useEffect(() => {
    if (loadState.phase !== "ready" || settingsSection !== "memory" || memoryServiceStatus) {
      return;
    }
    void refreshMemoryServiceStatus();
  }, [loadState, settingsSection, memoryServiceStatus]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setSystemClockLabel(
        new Date().toLocaleString([], {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "short",
        }),
      );
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }

      const key = event.key;
      const direction = key === "+" || key === "=" ? 1 : key === "-" || key === "_" ? -1 : key === "0" ? 0 : null;
      if (direction === null) {
        return;
      }

      event.preventDefault();
      setLoadState((current) => {
        if (current.phase !== "ready") {
          return current;
        }
        const currentZoom = current.state.uiPreferences.windowZoom ?? 1;
        const nextZoom = direction === 0 ? 1 : clampWindowZoom(currentZoom + direction * ZOOM_STEP);
        const nextState = {
          ...current.state,
          uiPreferences: {
            ...current.state.uiPreferences,
            windowZoom: nextZoom,
          },
        };
        void persistState(nextState);
        return {
          ...current,
          state: nextState,
        };
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (loadState.phase !== "ready") {
      return;
    }
    if (loadState.state.uiPreferences.activeSection !== "archive" || loadState.state.recoverySession.active) {
      return;
    }
    const manifests = [...loadState.bundled, ...loadState.sideloaded];
    const activeProvider = activeSystemSlotProvider(loadState.state, manifests, "memory-system");
    if (hasSystemSlotManifest(manifests, "memory-system") && activeProvider?.manifest.id !== "addon.living-archive") {
      return;
    }
    if (archiveStatusBusy || archiveStatus) {
      return;
    }
    void refreshArchiveRuntime();
  }, [loadState, archiveStatusBusy, archiveStatus]);

  useEffect(() => {
    if (loadState.phase !== "ready") {
      return;
    }
    if (loadState.state.uiPreferences.activeSection !== "archive" || loadState.state.recoverySession.active) {
      return;
    }
    const manifests = [...loadState.bundled, ...loadState.sideloaded];
    const activeProvider = activeSystemSlotProvider(loadState.state, manifests, "memory-system");
    if (hasSystemSlotManifest(manifests, "memory-system") && activeProvider?.manifest.id !== "addon.living-archive") {
      return;
    }
    if (archiveQueueBusy || archiveQueue.length) {
      return;
    }
    void refreshArchiveQueue();
  }, [loadState, archiveQueueBusy, archiveQueue.length]);

  if (loadState.phase === "loading") {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <p className="eyebrow">ResonantOS vNext</p>
          <h1>Booting the new shell.</h1>
          <p>
            Loading the core runtime, Living Archive policy, provider vault, and bundled add-on manifests.
          </p>
        </div>
      </div>
    );
  }

  if (loadState.phase === "error") {
    return (
      <div className="boot-screen">
        <div className="boot-card error">
          <p className="eyebrow">Boot failed</p>
          <h1>ResonantOS did not initialize.</h1>
          <p>{loadState.message}</p>
        </div>
      </div>
    );
  }

  const { state, bundled, sideloaded } = loadState;
  currentReadyStateRef.current = state;
  const cloneState = (current: ResonantShellState): ResonantShellState =>
    JSON.parse(JSON.stringify(current)) as ResonantShellState;
  const commitReadyState = (nextState: ResonantShellState, nextSideloaded = sideloaded) => {
    currentReadyStateRef.current = nextState;
    setLoadState({ phase: "ready", state: nextState, bundled, sideloaded: nextSideloaded });
    void persistState(nextState);
  };
  const updateRuntimeState = (updater: (current: ResonantShellState) => ResonantShellState) => {
    const nextState = updater(cloneState(currentReadyStateRef.current ?? state));
    commitReadyState(nextState);
  };
  const {
    allManifests,
    filteredManifests,
    currentSection,
    displayedStrategistName,
    selectedManifest,
    selectedInstallation,
    recoveryModeActive,
    visibleThreads,
    activeThread,
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
    dictationAvailable,
  } = buildShellViewModel({
    state,
    bundled,
    sideloaded,
    deferredSearch,
    selectedAddonId,
    composer,
    attachments,
    selectedChatModel,
  });
  const chatSlotAvailable = systemSlotAvailable(state, allManifests, "chat-interface");
  const engineerSettingsConsoleActive = !recoveryModeActive && !chatSlotAvailable && currentSection === "settings";
  const chatInterfaceAvailable = recoveryModeActive || chatSlotAvailable || engineerSettingsConsoleActive;
  const memorySystemAvailable = systemSlotAvailable(state, allManifests, "memory-system");
  const memorySlotHasProviders = hasSystemSlotManifest(allManifests, "memory-system");
  const activeMemoryProvider = activeSystemSlotProvider(state, allManifests, "memory-system");
  const livingArchiveMemoryActive =
    !memorySlotHasProviders || activeMemoryProvider?.manifest.id === "addon.living-archive";
  const memoryProviderBroker = resolveMemoryProviderBroker(state, allManifests);
  const archiveAgentThread = state.conversationThreads.find((thread) => thread.id === "thread-living-archive-agent") ?? null;
  const recommendedAddOns = recommendedSystemSlotManifests(allManifests);
  const showFirstRunRecommendedAddOns =
    !isFloatingChatSurface && !state.uiPreferences.recommendedAddOnsReviewed && recommendedAddOns.length > 0;
  const firstRunSelectionFor = (manifestId: string): boolean => firstRunSelections[manifestId] ?? true;
  const homeChatSurface =
    !isFloatingChatSurface &&
    !recoveryModeActive &&
    currentSection === "overview" &&
    chatInterfaceAvailable &&
    state.uiPreferences.chatSidebarOpen;
  const centerWorkspaceOwnsAgentChat = !isFloatingChatSurface && currentSection === "archive";
  const effectiveChatOpen =
    chatInterfaceAvailable &&
    !centerWorkspaceOwnsAgentChat &&
    (isFloatingChatSurface || engineerSettingsConsoleActive || state.uiPreferences.chatSidebarOpen);

  const setSection = (section: Section) => {
    startTransition(() => {
      if (section !== "archive") {
        setArchiveFocusTarget(null);
      }
      updateRuntimeState((draft) => {
        draft.uiPreferences.activeSection = section;
        return draft;
      });
    });
  };

  const openArchiveReview = () => {
    setArchiveFocusTarget("review");
    setSection("archive");
  };

  const toggleChatSidebar = () => {
    updateRuntimeState((draft) => {
      draft.uiPreferences.chatSidebarOpen = !draft.uiPreferences.chatSidebarOpen;
      return draft;
    });
  };

  const toggleWorkspaceLayout = () => {
    updateRuntimeState((draft) => {
      if (currentSection === "archive" && !isFloatingChatSurface) {
        draft.uiPreferences.activeSection = "overview";
        draft.uiPreferences.chatSidebarOpen = true;
        return draft;
      }
      draft.uiPreferences.workspaceLayout = draft.uiPreferences.workspaceLayout === "chat-main" ? "main-chat" : "chat-main";
      draft.uiPreferences.chatSidebarOpen = true;
      return draft;
    });
  };

  const setChatHistoryOpen = (open: boolean) => {
    updateRuntimeState((draft) => {
      const currentWidth = clampChatWidth(draft.uiPreferences.chatSidebarWidth);
      draft.uiPreferences.chatHistoryOpen = open;
      draft.uiPreferences.chatSidebarOpen = true;
      draft.uiPreferences.chatSidebarWidth = open
        ? Math.max(CHAT_RAIL_WITH_HISTORY_MIN_WIDTH, clampChatWidth(currentWidth + CHAT_HISTORY_WIDTH))
        : clampChatWidth(currentWidth - CHAT_HISTORY_WIDTH);
      return draft;
    });
  };

  const startChatRailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (loadState.phase !== "ready") {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = loadState.state.uiPreferences.chatSidebarWidth;
    const resizeDirection = loadState.state.uiPreferences.workspaceLayout === "chat-main" ? 1 : -1;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampChatWidth(startWidth + (moveEvent.clientX - startX) * resizeDirection);
      setLoadState((current) => {
        if (current.phase !== "ready") {
          return current;
        }

        return {
          ...current,
          state: {
            ...current.state,
            uiPreferences: {
              ...current.state.uiPreferences,
              chatSidebarWidth: nextWidth,
            },
          },
        };
      });
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);

      setLoadState((current) => {
        if (current.phase !== "ready") {
          return current;
        }

        void persistState(current.state);
        return current;
      });
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const handleSaveProviderSecret = async (profileId: string) => {
    await executeSaveProviderSecret({
      snapshot: { state, bundled, sideloaded },
      profileId,
      secret: providerDrafts[profileId] ?? "",
      commitReadyState,
      updateRuntimeState,
      setProviderDrafts,
      setSettingsNotice,
      setProviderDiagnosticsBusy,
      setActiveProviderProbeId,
      setProviderDiagnostics,
      errorMessageOf,
    });
  };

  const handleCreateProviderProfile = async (input: CreateProviderProfileInput) => {
    await executeCreateProviderProfile({
      ...input,
      updateRuntimeState,
      setSettingsNotice,
      errorMessageOf,
    });
  };

  const handleSetupProviderProfile = async (profileId: string) => {
    await executeSetupProviderProfile({
      snapshot: { state, bundled, sideloaded },
      profileId,
      updateRuntimeState,
      setSettingsNotice,
      errorMessageOf,
    });
  };

  const refreshProviderDiagnostics = async (providerId?: string) => {
    await executeRefreshProviderDiagnostics({
      snapshot: { state, bundled, sideloaded },
      providerId,
      commitReadyState,
      updateRuntimeState,
      setProviderDiagnosticsBusy,
      setActiveProviderProbeId,
      setProviderDiagnostics,
      setSettingsNotice,
      errorMessageOf,
    });
  };

  const refreshComputeLocalDiagnostics = async () => {
    const diagnostics = await requestComputeLocalPassiveDiagnostics();
    updateRuntimeState((draft) => {
      const result = applyComputePassiveDiagnostics(draft, diagnostics);
      if (!result.validation.valid) {
        throw new Error(result.validation.issues.map((issue) => issue.message).join(" "));
      }
      return result.state;
    });
  };

  const runComputeLocalCommandProbe = async () => {
    let commandRequest: Parameters<typeof requestComputeLocalSafeCommand>[0] | undefined;
    updateRuntimeState((draft) => {
      const result = submitLocalSafeCommandProbe(draft);
      if (!result.validation.valid || !result.request) {
        throw new Error(result.validation.issues.map((issue) => issue.message).join(" "));
      }
      commandRequest = result.request;
      return result.state;
    });

    if (!commandRequest) {
      throw new Error("Compute local command probe did not produce a command request.");
    }

    const request = commandRequest;
    try {
      const commandResult = await requestComputeLocalSafeCommand(request);
      updateRuntimeState((draft) => applyComputeSafeCommandResult(draft, commandResult));
    } catch (error) {
      const now = new Date().toISOString();
      updateRuntimeState((draft) =>
        applyComputeSafeCommandResult(draft, {
          nodeId: request.nodeId,
          jobId: request.jobId,
          command: request.command,
          status: "failed",
          exitCode: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : "Compute local command probe failed.",
          startedAt: now,
          completedAt: now,
          summary: "Compute safe command probe failed before completion.",
        }),
      );
      throw error;
    }
  };

  const quarantineComputeNode = (nodeId: string) => {
    updateRuntimeState((draft) => {
      const result = quarantineComputeNodeForReview(draft, nodeId, "Manual quarantine from the Compute Fabric workspace.");
      if (!result.validation.valid) {
        throw new Error(result.validation.issues.map((issue) => issue.message).join(" "));
      }
      return result.state;
    });
  };

  const revokeComputeNode = (nodeId: string) => {
    updateRuntimeState((draft) => {
      const result = revokeComputeNodeTrust(draft, nodeId, "Manual trust revocation from the Compute Fabric workspace.");
      if (!result.validation.valid) {
        throw new Error(result.validation.issues.map((issue) => issue.message).join(" "));
      }
      return result.state;
    });
  };

  const runProviderSmokeTest = async (providerId: string) => {
    await executeProviderSmokeTest({
      snapshot: { state, bundled, sideloaded },
      providerId,
      setProviderSmokeBusyId,
      setProviderSmokeResults,
      setSettingsNotice,
      errorMessageOf,
    });
  };

  const refreshMemoryServiceStatus = async () => {
    await executeRefreshMemoryServiceStatus({
      setMemoryServiceBusy,
      setMemoryServiceStatus,
      setSettingsNotice,
      errorMessageOf,
    });
  };

  const startMemoryService = async () => {
    await executeStartMemoryService({
      setMemoryServiceBusy,
      setMemoryServiceStatus,
      setMemoryServiceLastResult,
      setSettingsNotice,
      errorMessageOf,
    });
  };

  const stopMemoryService = async () => {
    await executeStopMemoryService({
      setMemoryServiceBusy,
      setMemoryServiceStatus,
      setMemoryServiceLastResult,
      setSettingsNotice,
      errorMessageOf,
    });
  };

  const refreshArchiveRuntime = async () => {
    await loadArchiveRuntimeStatus({
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveStatusBusy,
      setArchiveStatus,
      errorMessageOf,
    });
    await loadArchiveImportedLibraries({
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveImportedLibraries,
      errorMessageOf,
    });
  };

  const refreshArchiveSourceRegistry = async () => {
    await loadArchiveImportedLibraries({
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveImportedLibraries,
      errorMessageOf,
    });
  };

  const refreshArchiveQueue = async () => {
    await loadArchiveReviewQueue({
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      errorMessageOf,
    });
    await loadArchiveAiMemoryBuildJobs({
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveAiMemoryBuildJobs,
      errorMessageOf,
    });
  };

  const runArchiveSearch = async (query: string) => {
    await executeArchiveSearch({
      query,
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveSearchBusy,
      setArchiveSearchResult,
      errorMessageOf,
    });
  };

  const queueArchiveSource = async (source: ArchiveSearchResult["sources"][number]) => {
    await queueArchiveSourceForIngest({
      source,
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      errorMessageOf,
    });
  };

  const queueWatchedArchiveSource = async (source: ArchiveSourceWatchRecord) => {
    await queueWatchedArchiveSourceForIngest({
      source,
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      errorMessageOf,
    });
  };

  const runArchiveSourceFolderScan = async (rootPath?: string) => {
    await scanArchiveSourceFolders({
      rootPath,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveSourceScanResult,
      errorMessageOf,
    });
  };

  const runArchiveLibraryImport = async (input: {
    sourcePath: string;
    domain: ArchiveMemoryDomain;
    importMode: ArchiveLibraryImportMode;
    libraryName?: string;
    excludedTopFolders?: string[];
  }) => {
    await importArchiveLibrary({
      ...input,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveLibraryImportResult,
      setArchiveImportedLibraries,
      errorMessageOf,
    });
  };

  const runArchiveLibraryPreflight = async (sourcePath: string) => {
    await preflightArchiveLibrary({
      sourcePath,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveLibraryPreflightResult,
      errorMessageOf,
    });
  };

  const openArchiveClassificationReview = async (classificationManifestPath: string) => {
    await loadArchiveLibraryClassificationReview({
      classificationManifestPath,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveClassificationReview,
      errorMessageOf,
    });
    setArchiveReorganisationPlan(null);
  };

  const runArchiveReorganisationPlan = async (classificationManifestPath: string) => {
    await generateArchiveLibraryReorganisationPlan({
      classificationManifestPath,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveReorganisationPlan,
      errorMessageOf,
    });
  };

  const queueImportedLibraryIngest = async (manifestPath: string) => {
    await runArchiveAiMemoryBuildJob({
      snapshot: { state, bundled, sideloaded },
      manifestPath,
      commitReadyState,
      setProviderDiagnostics,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      setArchiveProcessResult,
      setArchivePromotionResult,
      setArchiveMaintenanceResult,
      setArchiveAiMemoryBuildResult,
      setArchiveAiMemoryBuildJobs,
      errorMessageOf,
    });
  };

  const runPickArchiveLibraryFolder = async (): Promise<string | null> =>
    pickArchiveLibraryFolder({
      setChatNotice,
      errorMessageOf,
    });

  const runArchiveQueuedRequest = async (requestFile: string) => {
    await processArchiveQueuedRequest({
      snapshot: { state, bundled, sideloaded },
      requestFile,
      memoryProvider: memoryProviderBroker,
      commitReadyState,
      setProviderDiagnostics,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveProcessResult,
      setArchiveReviewArtifacts,
      errorMessageOf,
    });
  };

  const runArchiveReviewDecision = async (
    artifactFile: string,
    action: "approve" | "reject" | "escalate",
    actorId: string,
  ) => {
    await decideArchiveReviewArtifact({
      artifactFile,
      action,
      actorId,
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveReviewArtifacts,
      setArchiveReviewDecisionResult,
      errorMessageOf,
    });
  };

  const runArchivePromotion = async (artifactFile: string) => {
    await promoteArchiveReviewArtifact({
      artifactFile,
      actorId: "archive-ingest.core",
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveReviewArtifacts,
      setArchivePromotionResult,
      errorMessageOf,
    });
  };

  const runApprovedArchivePromotion = async () => {
    await promoteApprovedArchiveReviewArtifacts({
      artifacts: archiveReviewArtifacts,
      actorId: "archive-ingest.core",
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveReviewArtifacts,
      setArchivePromotionResult,
      errorMessageOf,
    });
  };

  const runArchiveMaintenance = async () => {
    await runArchiveBackgroundCycle({
      snapshot: { state, bundled, sideloaded },
      memoryProvider: memoryProviderBroker,
      commitReadyState,
      setProviderDiagnostics,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      setArchiveProcessResult,
      setArchivePromotionResult,
      setArchiveMaintenanceResult,
      setArchiveSourceScanResult,
      setArchiveBackgroundResult,
      errorMessageOf,
    });
    await refreshArchiveRuntime();
  };

  const runArchiveHealthLint = async () => {
    await runArchiveLint({
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveLintResult,
      errorMessageOf,
    });
    await refreshArchiveRuntime();
  };

  const runArchiveSemanticHealthLint = async () => {
    await runArchiveSemanticLint({
      snapshot: { state, bundled, sideloaded },
      memoryProvider: memoryProviderBroker,
      commitReadyState,
      setProviderDiagnostics,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveSemanticLintResult,
      errorMessageOf,
    });
    await refreshArchiveRuntime();
  };

  const refreshArchiveTolBundles = async () => {
    await loadArchiveTolBundles({
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveTolBundles,
      errorMessageOf,
    });
  };

  const runArchiveTolBundleBuild = async (sessionId: string) => {
    await buildArchiveTolBundle({
      sessionId,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveTolBundles,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      setArchiveTolBundleResult,
      errorMessageOf,
    });
  };

  const openArchiveDocument = async (path: string) => {
    await loadArchiveDocument({
      path,
      memoryProvider: memoryProviderBroker,
      setChatNotice,
      setArchiveDocumentBusy,
      setArchiveDocument,
      errorMessageOf,
    });
  };

  const handleSideload = async () => {
    await executeSideloadManifest({
      sideloadPath,
      bundled,
      sideloaded,
      setReadyState: (nextState, nextSideloaded) => commitReadyState(nextState, nextSideloaded),
      setSelectedAddonId,
      setSideloadPath,
      setErrorState: (message) => setLoadState({ phase: "error", message }),
      errorMessageOf,
    });
  };

  const sendStrategistMessage = async (overrideMessage?: string) => {
    if (!recoveryModeActive && !chatInterfaceAvailable) {
      setChatNotice("No active chat-interface add-on is enabled. Enable Augmentor Chat or select another chat add-on.");
      return;
    }
    if (!activeThread || !(overrideMessage ?? composer).trim()) {
      return;
    }
    const runToken = claimChatRun(activeChatRunTokenRef, activeThread.id);
    if (!runToken) {
      setChatNotice("Hermes is already working on the current message.");
      return;
    }
    if (chatBusy) {
      releaseChatRun(activeChatRunTokenRef, runToken);
      setChatNotice("Stop the current response before sending a follow-up correction.");
      return;
    }
    await executeChatTurn({
      snapshot: { state, bundled, sideloaded },
      activeThread,
      composer,
      attachments,
      activeChatModel,
      thinkingDepth,
      overrideMessage,
      commitReadyState,
      setComposer,
      setAttachments,
      setChatNotice,
      setChatBusy,
      setChatRunPhase,
      setChatRunEvents,
      setAgentActivityLabel,
      setProviderDiagnostics,
      setRecoveryRuntimeStatus,
      runToken,
      isRunCurrent: (token) => activeChatRunTokenRef.current === token,
      errorMessageOf,
    });
    if (releaseChatRun(activeChatRunTokenRef, runToken)) {
      setChatRunPhase("idle");
    }
  };

  const sendLivingArchiveAgentMessage = async (message: string, contextPrompt?: string) => {
    if (!chatInterfaceAvailable) {
      setChatNotice("No active chat-interface add-on is enabled for the Living Archive Agent.");
      return;
    }
    if (chatBusy) {
      setChatNotice("Stop the current response before asking the Living Archive Agent.");
      return;
    }

    const baseState = currentReadyStateRef.current ?? state;
    const channel =
      baseState.channels.find((item) => item.id === "desktop-main" && item.enabled) ??
      baseState.channels.find((item) => item.owningAgentId === "strategist.core" && item.enabled) ??
      null;
    if (!channel) {
      setChatNotice("No enabled Augmentor desktop channel is available for the Living Archive Agent.");
      return;
    }

    const threadId = "thread-living-archive-agent";
    const existingThread = baseState.conversationThreads.find((thread) => thread.id === threadId);
    const thread: ConversationThread =
      existingThread ?? {
        id: threadId,
        title: "Living Archive Agent",
        owningAgentId: "strategist.core",
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        summary: "Central Living Archive configuration and repair session.",
        messages: [],
      };
    const stateWithThread = existingThread
      ? baseState
      : {
          ...appendTranscriptEvent(baseState, {
            action: "thread-created",
            threadId,
            channelId: channel.id,
            agentId: "strategist.core",
            payload: {
              title: thread.title,
              workspaceId: channel.workspaceId,
              source: "living-archive-agent",
            },
          }),
          conversationThreads: [thread, ...baseState.conversationThreads],
        };

    if (!existingThread) {
      commitReadyState(stateWithThread);
    }

    const runToken = claimChatRun(activeChatRunTokenRef, thread.id);
    if (!runToken) {
      setChatNotice("Another agent turn is already running.");
      return;
    }

    await executeChatTurn({
      snapshot: { state: stateWithThread, bundled, sideloaded },
      activeThread: thread,
      composer: "",
      attachments: [],
      activeChatModel,
      thinkingDepth,
      overrideMessage: message,
      overrideContextPrompt: contextPrompt,
      commitReadyState,
      setComposer,
      setAttachments,
      setChatNotice,
      setChatBusy,
      setChatRunPhase,
      setChatRunEvents,
      setAgentActivityLabel,
      setProviderDiagnostics,
      setRecoveryRuntimeStatus,
      runToken,
      isRunCurrent: (token) => activeChatRunTokenRef.current === token,
      errorMessageOf,
    });
    if (releaseChatRun(activeChatRunTokenRef, runToken)) {
      setChatRunPhase("idle");
    }
  };

  const startArchivePreflightAugmentorSession = async (report: ArchiveLibraryPreflightResult) => {
    if (!chatInterfaceAvailable) {
      setChatNotice("No active chat-interface add-on is enabled for an Augmentor discussion.");
      return;
    }
    if (chatBusy) {
      setChatNotice("Stop the current response before opening a Living Archive plan discussion.");
      return;
    }
    const channel =
      state.channels.find((item) => item.id === "desktop-main" && item.enabled) ??
      state.channels.find((item) => item.owningAgentId === "strategist.core" && item.enabled) ??
      null;
    if (!channel) {
      setChatNotice("No enabled Augmentor desktop channel is available for this discussion.");
      return;
    }

    const threadId = `thread-archive-preflight-${Date.now()}`;
    const thread: ConversationThread = {
      id: threadId,
      title: "Living Archive import plan",
      owningAgentId: "strategist.core",
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      summary: "Augmentor discussion about a Living Archive import preflight and recommended plan.",
      messages: [],
    };
    const nextState = appendTranscriptEvent(
      {
        ...cloneState(state),
        conversationThreads: [thread, ...state.conversationThreads],
        uiPreferences: {
          ...state.uiPreferences,
          activeChatThreadId: threadId,
          chatSidebarOpen: true,
          chatHistoryOpen: false,
        },
      },
      {
        action: "thread-created",
        threadId,
        channelId: channel.id,
        agentId: "strategist.core",
        payload: {
          title: thread.title,
          workspaceId: channel.workspaceId,
          source: "living-archive-preflight",
        },
      },
    );
    commitReadyState(nextState);

    const runToken = claimChatRun(activeChatRunTokenRef, threadId);
    if (!runToken) {
      setChatNotice("Hermes is already working on a response. Please wait.");
      return;
    }
    await executeChatTurn({
      snapshot: { state: nextState, bundled, sideloaded },
      activeThread: thread,
      composer: "",
      attachments: [],
      activeChatModel,
      thinkingDepth,
      overrideMessage: buildArchivePreflightAugmentorPrompt(report),
      commitReadyState,
      setComposer,
      setAttachments,
      setChatNotice,
      setChatBusy,
      setChatRunPhase,
      setChatRunEvents,
      setAgentActivityLabel,
      setProviderDiagnostics,
      setRecoveryRuntimeStatus,
      runToken,
      isRunCurrent: (token) => activeChatRunTokenRef.current === token,
      errorMessageOf,
    });
    if (releaseChatRun(activeChatRunTokenRef, runToken)) {
      setChatRunPhase("idle");
    }
  };

  const startRecoveryRunbook = () => {
    if (!recoveryModeActive || chatBusy) {
      return;
    }
    void sendStrategistMessage(RECOVERY_RUNBOOK_PROMPT);
  };

  const detachChatWindow = async () => {
    try {
      await openFloatingChatWindow();
      updateRuntimeState((draft) => {
        draft.uiPreferences.chatSidebarOpen = false;
        draft.uiPreferences.chatHistoryOpen = false;
        return draft;
      });
    } catch (error) {
      setChatNotice(errorMessageOf(error, "Failed to open floating chat window."));
    }
  };

  const runArchiveIngestProbe = async () => {
    if (archiveProbeBusy || recoveryModeActive) {
      return;
    }

    await executeArchiveIngestProbe({
      snapshot: { state, bundled, sideloaded },
      commitReadyState,
      setProviderDiagnostics,
      setChatNotice,
      setArchiveProbeBusy,
      setArchiveProbeResult,
      errorMessageOf,
    });
  };

  const shellStyle = {
    "--chat-rail-width": `${clampChatWidth(state.uiPreferences.chatSidebarWidth)}px`,
    "--chat-history-width": `${CHAT_HISTORY_WIDTH}px`,
  } as CSSProperties;
  const zoomStyle = {
    "--app-zoom": `${state.uiPreferences.windowZoom ?? 1}`,
  } as CSSProperties;
  const activeChatAgent = activeThread ? state.agents.find((agent) => agent.id === activeThread.owningAgentId) : null;
  const activeChatAgentName =
    activeChatAgent?.id === "strategist.core" ? displayedStrategistName : activeChatAgent?.displayName ?? displayedStrategistName;
  const browserManifest = allManifests.find((manifest) => manifest.id === "addon.browser");
  const browserInstallation = state.installations["addon.browser"];
  const obsidianManifest = allManifests.find((manifest) => manifest.id === "addon.obsidian");
  const obsidianInstallation = state.installations["addon.obsidian"];
  const opencodeManifest = allManifests.find((manifest) => manifest.id === "addon.opencode");
  const opencodeInstallation = state.installations["addon.opencode"];
  const paperclipManifest = allManifests.find((manifest) => manifest.id === "addon.paperclip");
  const paperclipInstallation = state.installations["addon.paperclip"];
  const hermesManifest = allManifests.find((manifest) => manifest.id === "addon.hermes");
  const hermesInstallation = state.installations["addon.hermes"];
  const terminalManifest = allManifests.find((manifest) => manifest.id === "addon.terminal");
  const terminalInstallation = state.installations["addon.terminal"];
  const audio2TolManifest = allManifests.find((manifest) => manifest.id === "addon.audio2tol");
  const audio2TolInstallation = state.installations["addon.audio2tol"];
  const grantBrowserVisibleAccess = () => {
    if (!browserManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[browserManifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = browserManifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        ["network", "ui-embedding", "browser-control", "filesystem"].includes(grant.capability) ? { ...grant, granted: true } : grant,
      );
      installation.status = "enabled";
      installation.notes = ["Installed, enabled, and granted network, ui-embedding, browser-control, filesystem through Browser v2 setup."];
      draft.uiPreferences.activeSection = "browser";
      return draft;
    });
  };
  const updateBrowserWorkspaceState = (browserWorkspace: ResonantShellState["uiPreferences"]["browserWorkspace"]) => {
    updateRuntimeState((draft) => {
      draft.uiPreferences.browserWorkspace = browserWorkspace;
      return draft;
    });
  };
  const patchControlledBrowserSession = (
    controlledSession: Partial<ResonantShellState["uiPreferences"]["browserWorkspace"]["controlledSession"]>,
  ) => {
    updateRuntimeState((draft) => {
      draft.uiPreferences.browserWorkspace.controlledSession = {
        ...draft.uiPreferences.browserWorkspace.controlledSession,
        ...controlledSession,
      };
      return draft;
    });
  };
  const openInternalBrowserPreview = async (
    url: string,
    viewport?: { viewportWidth?: number; viewportHeight?: number },
  ): Promise<BrowserOpenUrlResult> => {
    const existingSessionId = state.uiPreferences.browserWorkspace.controlledSession.sessionId;
    patchControlledBrowserSession({
      status: "starting",
      url,
      error: null,
      lastSyncedAt: new Date().toISOString(),
    });
    try {
      let result: BrowserOpenUrlResult;
      if (existingSessionId) {
        try {
          result = await requestBrowserSessionOpenUrl(existingSessionId, url, viewport);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/not started|not found|missing|closed|detached/i.test(message)) {
            throw error;
          }
          result = await requestBrowserStartSession(url, viewport);
        }
      } else {
        result = await requestBrowserStartSession(url, viewport);
      }
      patchControlledBrowserSession({
        sessionId: result.sessionId,
        status: "ready",
        url: result.finalUrl,
        title: result.title,
        error: null,
        lastSyncedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal Browser navigation failed.";
      patchControlledBrowserSession({
        status: "error",
        error: message,
        lastSyncedAt: new Date().toISOString(),
      });
      throw new Error(message);
    }
  };
  const hideNativeBrowserWebview = async (): Promise<void> => {
    await requestBrowserNativeWebviewHide();
  };
  const openNativeBrowserSurface = async (
    url: string,
    bounds: { x: number; y: number; width: number; height: number },
  ): Promise<void> => {
    const activeTabId = state.uiPreferences.browserWorkspace.activeTabId;
    const lastNavigation = nativeBrowserNavigationRef.current;
    const shouldNavigate = !lastNavigation || lastNavigation.tabId !== activeTabId || lastNavigation.url !== url;
    const result = await requestBrowserNativeWebviewShow({ url, bounds, navigate: shouldNavigate });
    nativeBrowserNavigationRef.current = { tabId: activeTabId, url };
    patchControlledBrowserSession({
      status: "ready",
      url: result.url ?? url,
      title: "Native Chromium Browser",
      error: null,
      lastSyncedAt: new Date().toISOString(),
    });
  };
  const resizeNativeBrowserSurface = async (bounds: { x: number; y: number; width: number; height: number }): Promise<void> => {
    await requestBrowserNativeWebviewResize(bounds);
  };
  const openLiveBrowserSurface = async (
    url: string,
    bounds: { x: number; y: number; width: number; height: number },
  ): Promise<void> => {
    await openLiveBrowserWebview(url, bounds);
  };
  const resizeLiveBrowserSurface = async (bounds: { x: number; y: number; width: number; height: number }): Promise<void> => {
    await resizeLiveBrowserWebview(bounds);
  };
  const hideLiveBrowserSurface = async (): Promise<void> => {
    await hideLiveBrowserWebview();
  };
  const probeNativeBrowserHost = async () => requestNativeBrowserProbe("cef-chrome-runtime");
  const smokeTestNativeBrowserAttach = async () => requestNativeBrowserAttachSmoke("external-process");
  const probeNativeBrowserBridge = async () => requestNativeBrowserBridgeProbe("in-process-native-library");
  const listVisibleBrowserExtensions = async (): Promise<BrowserExtensionState[]> => {
    const result = (await requestBrowserVisibleHostCommand({ type: "extensions_list" })) as BrowserExtensionListResult;
    return result.extensions;
  };
  const loadPriorityBrowserExtension = async (target: "phantom" | "bitwarden"): Promise<string> => {
    if (target === "phantom") {
      try {
        const result = (await requestBrowserVisibleHostCommand({
          type: "extensions_load_unpacked",
          params: { pinned: true, expectedTarget: "phantom" },
          humanApproved: true,
        })) as BrowserExtensionLoadResult;
        return `${result.extension.name} loaded in the guarded extension host. Wallet signing remains human-approved only.`;
      } catch {
        // Fall through to manual folder selection when Phantom is not present in a known browser profile.
      }
    }
    const selectedPath = await requestBrowserExtensionFolderSelection();
    if (!selectedPath) {
      return `${target === "phantom" ? "Phantom" : "Bitwarden"} extension loading cancelled.`;
    }
    const result = (await requestBrowserVisibleHostCommand({
      type: "extensions_load_unpacked",
      params: { path: selectedPath, pinned: target === "phantom", expectedTarget: target },
      humanApproved: true,
    })) as BrowserExtensionLoadResult;
    return `${result.extension.name} loaded in the guarded extension host. Wallet signing remains human-approved only.`;
  };
  const setVisibleBrowserExtensionPinned = async (extensionId: string, pinned: boolean): Promise<BrowserExtensionState[]> => {
    const result = (await requestBrowserVisibleHostCommand({
      type: "extensions_set_pinned",
      params: { extensionId, pinned },
      humanApproved: true,
    })) as BrowserExtensionListResult;
    return result.extensions;
  };
  const disableVisibleBrowserExtension = async (extensionId: string): Promise<BrowserExtensionState[]> => {
    const result = (await requestBrowserVisibleHostCommand({
      type: "extensions_disable",
      params: { extensionId },
      humanApproved: true,
    })) as BrowserExtensionListResult;
    return result.extensions;
  };
  const openWalletBrowserHost = async (url: string): Promise<string> => {
    const result = (await requestBrowserVisibleHostCommand({
      type: "wallet_host_start",
      params: { url },
      humanApproved: true,
    })) as {
      ready?: boolean;
      browserName?: string | null;
      url?: string | null;
      profilePath?: string | null;
      phantomInstallUrl?: string;
    };
    patchControlledBrowserSession({
      sessionId: "wallet-browser-main",
      status: result.ready ? "ready" : "error",
      url: result.url ?? url,
      title: result.browserName ?? "Wallet Browser Host",
      error: result.ready ? null : "Wallet Browser host is not ready.",
      lastSyncedAt: new Date().toISOString(),
    });
    if (!result.ready) {
      return `Wallet Browser host is not ready. Install Brave or Chrome, then use ${result.phantomInstallUrl ?? "the official Phantom Chrome Web Store listing"}.`;
    }
    return `Wallet Browser opened in ${result.browserName ?? "Chrome/Brave"} using the dedicated ResonantOS profile. Install or unlock Phantom there; wallet approvals remain human-only.`;
  };
  const readWalletBrowserHost = async (): Promise<string> => {
    const result = (await requestBrowserVisibleHostCommand({
      type: "wallet_host_read_page",
      humanApproved: true,
    })) as { sessionId: string; finalUrl: string; title: string; text: string; links: unknown[] };
    patchControlledBrowserSession({
      sessionId: result.sessionId,
      status: "ready",
      url: result.finalUrl,
      title: result.title,
      error: null,
      lastSyncedAt: new Date().toISOString(),
    });
    return `Wallet Browser read: ${result.title || "Untitled"} · ${result.text.length} text characters · ${result.links.length} links`;
  };
  const inspectWalletDappGate = async (): Promise<string> => {
    const result = (await requestBrowserVisibleHostCommand({
      type: "wallet_host_inspect_dapp_gate",
      humanApproved: true,
    })) as unknown as {
      title: string;
      providerDetected: boolean;
      manualApprovalRequired: boolean;
      actionCandidates: Array<{ text: string }>;
      blockedActions: string[];
    };
    const candidateSummary = result.actionCandidates.length
      ? `${result.actionCandidates.length} wallet-related page controls detected`
      : "no wallet-related page controls detected";
    return `Wallet gate: ${result.providerDetected ? "Phantom/Solana provider detected" : "wallet provider not detected"} · ${candidateSummary}. Manual approval required: ${result.manualApprovalRequired ? "yes" : "no"}. Blocked AI actions: ${result.blockedActions.join(", ")}.`;
  };
  const readActiveBrowserPage = async (url: string): Promise<string> => {
    await openWalletBrowserHost(url);
    const summary = await readWalletBrowserHost();
    setChatNotice(summary);
    return summary;
  };
  const scrollInternalBrowserPreview = async (
    sessionId: string,
    deltaX: number,
    deltaY: number,
    viewport?: { viewportWidth?: number; viewportHeight?: number },
  ) => {
    const result = await requestBrowserSessionScroll(sessionId, deltaX, deltaY, viewport);
    patchControlledBrowserSession({
      sessionId: result.sessionId,
      status: "ready",
      url: result.finalUrl,
      title: result.title,
      error: null,
      lastSyncedAt: new Date().toISOString(),
    });
    return result;
  };
  const grantObsidianWorkspaceAccess = async () => {
    if (!obsidianManifest) {
      return;
    }
    const currentVaultPath =
      typeof obsidianInstallation?.config?.vaultPath === "string" ? obsidianInstallation.config.vaultPath : "";
    const selectedVaultPath = currentVaultPath || (await requestObsidianVaultFolderSelection());
    updateRuntimeState((draft) => {
      const installation = draft.installations[obsidianManifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      installation.status = "enabled";
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = obsidianManifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        grant.capability === "filesystem" || grant.capability === "ui-embedding" ? { ...grant, granted: true } : grant,
      );
      if (selectedVaultPath) {
        installation.config = {
          ...(installation.config ?? {}),
          vaultPath: selectedVaultPath,
          lastWorkspaceConnectedAt: new Date().toISOString(),
        };
      }
      installation.notes = selectedVaultPath
        ? [`Workspace access granted for ${selectedVaultPath}.`]
        : ["Workspace access granted. Choose a vault to open the Resonant Notes workspace."];
      return draft;
    });
  };
  const grantOpenCodeWorkspaceAccess = () => {
    if (!opencodeManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[opencodeManifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      installation.status = "enabled";
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = opencodeManifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        ["filesystem", "shell", "ui-embedding"].includes(grant.capability) ? { ...grant, granted: true } : grant,
      );
      installation.notes = ["Installed, enabled, and granted scoped filesystem, shell, and UI embedding for OpenCode workspace spike."];
      draft.uiPreferences.activeSection = "opencode";
      return draft;
    });
  };
  const updateOpenCodeWorkspacePath = (workspacePath: string) => {
    if (!opencodeManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[opencodeManifest.id];
      if (!installation) {
        return draft;
      }
      installation.config = {
        ...(installation.config ?? {}),
        workspacePath,
        lastWorkspaceSelectedAt: new Date().toISOString(),
      };
      return draft;
    });
  };
  const consumePendingOpenCodeWorkspace = () => {
    updateRuntimeState((draft) => {
      draft.uiPreferences.pendingOpenCodeWorkspaceId = null;
      return draft;
    });
  };
  const grantPaperclipWorkspaceAccess = () => {
    if (!paperclipManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[paperclipManifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      installation.status = "enabled";
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = paperclipManifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        ["network", "ui-embedding", "agent-delegation"].includes(grant.capability) ? { ...grant, granted: true } : grant,
      );
      installation.config = {
        ...(installation.config ?? {}),
        endpoint: typeof installation.config?.endpoint === "string" ? installation.config.endpoint : "http://127.0.0.1:3100",
      };
      installation.notes = ["Installed, enabled, and granted local network, UI embedding, and delegation issue creation for Paperclip."];
      draft.uiPreferences.activeSection = "paperclip";
      return draft;
    });
  };
  const updatePaperclipEndpoint = (endpoint: string) => {
    if (!paperclipManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[paperclipManifest.id];
      if (!installation) {
        return draft;
      }
      installation.config = {
        ...(installation.config ?? {}),
        endpoint,
        lastEndpointUpdatedAt: new Date().toISOString(),
      };
      return draft;
    });
  };
  const grantHermesWorkspaceAccess = () => {
    if (!hermesManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[hermesManifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      installation.status = "enabled";
      const workspaceCapabilities = ["shell", "ui-embedding"];
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = hermesManifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        workspaceCapabilities.includes(grant.capability)
          ? { ...grant, granted: true }
          : grant,
      );
      installation.notes = [
        "Installed, enabled, and granted scoped shell and UI embedding for the Hermes workspace. Provider, network, archive-read, and archive-intake-write remain separately approval-gated.",
      ];
      const hermesChannel = draft.channels.find((channel) => channel.id === "desktop-hermes");
      if (hermesChannel) {
        hermesChannel.enabled = true;
      }
      draft.uiPreferences.activeSection = "hermes";
      return draft;
    });
  };
  const updateHermesProfileHome = (profileHome: string) => {
    if (!hermesManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[hermesManifest.id];
      if (!installation) {
        return draft;
      }
      installation.config = {
        ...(installation.config ?? {}),
        profileHome,
        lastProfileHomeUpdatedAt: new Date().toISOString(),
      };
      return draft;
    });
  };
  const updateHermesModelMetadata = (model: string, availableModels: string[] = []) => {
    if (!hermesManifest || !model.trim()) {
      return;
    }
    const uniqueModels = Array.from(new Set([model.trim(), ...availableModels.map((item) => item.trim()).filter(Boolean)]));
    updateRuntimeState((draft) => {
      const installation = draft.installations[hermesManifest.id];
      if (!installation) {
        return draft;
      }
      installation.config = {
        ...(installation.config ?? {}),
        hermesModel: model.trim(),
        hermesAvailableModels: uniqueModels,
        lastHermesModelUpdatedAt: new Date().toISOString(),
      };
      return draft;
    });
  };
  const handleChatModelChange = (model: string) => {
    setSelectedChatModel(model);
    if (activeThread?.owningAgentId === "hermes.agent") {
      updateHermesModelMetadata(model, selectableChatModels);
    }
  };
  const grantTerminalWorkspaceAccess = () => {
    if (!terminalManifest) {
      return;
    }
    grantAddonCapabilities(
      terminalManifest.id,
      ["shell", "ui-embedding"],
      terminalManifest.requestedCapabilities,
      updateRuntimeState,
    );
  };
  const grantAndOpenTerminalWorkspace = (manifest: AddOnManifest) => {
    updateRuntimeState((draft) => {
      const installation = draft.installations[manifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      installation.status = "enabled";
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = manifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        grant.capability === "shell" || grant.capability === "ui-embedding" ? { ...grant, granted: true } : grant,
      );
      installation.notes = ["Installed, enabled, and opened as a center-column Terminal workspace."];
      draft.uiPreferences.activeSection = "terminal";
      return draft;
    });
  };
  const browserDockEnabled = Boolean(browserManifest && browserInstallation?.installed && browserInstallation.enabled);
  const obsidianDockEnabled = Boolean(obsidianManifest && obsidianInstallation?.installed && obsidianInstallation.enabled);
  const opencodeDockEnabled = Boolean(opencodeManifest && opencodeInstallation?.installed && opencodeInstallation.enabled);
  const paperclipDockEnabled = Boolean(paperclipManifest && paperclipInstallation?.installed && paperclipInstallation.enabled);
  const hermesDockEnabled = Boolean(hermesManifest && hermesInstallation?.installed && hermesInstallation.enabled);
  const terminalDockEnabled = Boolean(terminalManifest && terminalInstallation?.installed && terminalInstallation.enabled);
  const manifestSurfaceDockItems = createAddOnSurfaceDockRoutes(allManifests, state.installations).map((route) => ({
    id: route.sectionId as Section,
    label: route.label,
    eyebrow: route.eyebrow,
    icon: route.dockIcon as DockIconId,
    pinned: true,
  }));
  const addOnNavItems = [
    ...(obsidianDockEnabled
      ? [{ id: "obsidian" as Section, label: obsidianManifest?.name ?? "Resonant Notes", eyebrow: "notes", icon: "obsidian" as DockIconId, pinned: true }]
      : []),
    ...(browserDockEnabled
      ? [{ id: "browser" as Section, label: browserManifest?.name ?? "Browser", eyebrow: "web", icon: "browser" as DockIconId, pinned: true }]
      : []),
    ...(opencodeDockEnabled
      ? [{ id: "opencode" as Section, label: opencodeManifest?.name ?? "OpenCode", eyebrow: "code", icon: "opencode" as DockIconId, pinned: true }]
      : []),
    ...(paperclipDockEnabled
      ? [{ id: "paperclip" as Section, label: paperclipManifest?.name ?? "Paperclip", eyebrow: "org", icon: "paperclip" as DockIconId, pinned: true }]
      : []),
    ...(hermesDockEnabled
      ? [{ id: "hermes" as Section, label: hermesManifest?.name ?? "Hermes", eyebrow: "agent", icon: "hermes" as DockIconId, pinned: true }]
      : []),
    ...(terminalDockEnabled
      ? [
          {
            id: "terminal" as Section,
            label: terminalManifest?.name ?? "Terminal",
            eyebrow: "shell",
            icon: "terminal" as DockIconId,
            pinned: true,
          },
        ]
      : []),
    ...manifestSurfaceDockItems,
  ];
  const visibleNavItems = addOnNavItems.length
    ? [
        ...navItems.slice(0, 4),
        ...addOnNavItems,
        ...navItems.slice(4),
      ]
    : navItems;

  return (
    <div className="app-zoom-viewport" style={zoomStyle}>
      <div className="app-zoom-stage">
        <div
          className={`shell ${effectiveChatOpen ? "chat-open" : "chat-closed"} ${chatInterfaceAvailable ? "" : "chat-unavailable"} ${isFloatingChatSurface ? "floating-chat-surface" : ""} ${homeChatSurface ? "home-chat-surface" : ""} ${centerWorkspaceOwnsAgentChat ? "center-chat-owner" : ""} layout-${state.uiPreferences.workspaceLayout}`}
          style={shellStyle}
        >
      <header className="system-topbar" aria-label="ResonantOS system bar">
        <div className="system-menu">
          <button type="button" className="system-logo-button" title="ResonantOS Home" onClick={() => setSection("overview")}>
            Resonant<span>OS</span>
          </button>
          <span className="system-active-app">
            {recoveryModeActive ? "Emergency Recovery" : visibleNavItems.find((item) => item.id === currentSection)?.label}
          </span>
        </div>
        <div className="system-status-strip">
          <button
            type="button"
            className="system-icon-button"
            title={
              centerWorkspaceOwnsAgentChat
                ? "Open main chat"
                : state.uiPreferences.workspaceLayout === "chat-main"
                ? "Move chat back to the right"
                : "Move chat beside the launcher"
            }
            aria-label={
              centerWorkspaceOwnsAgentChat
                ? "Open main chat"
                : state.uiPreferences.workspaceLayout === "chat-main"
                ? "Move chat back to the right"
                : "Move chat beside the launcher"
            }
            onClick={toggleWorkspaceLayout}
            disabled={!chatInterfaceAvailable}
          >
            <VendorIcon
              icon={
                centerWorkspaceOwnsAgentChat
                  ? "layout-sidebar-left-expand"
                  : state.uiPreferences.workspaceLayout === "chat-main"
                  ? "layout-sidebar-right-collapse"
                  : "layout-sidebar-left-expand"
              }
            />
          </button>
          <span
            className={`system-health ${strategistRecoveryActive ? "warning" : "ready"}`}
            title={`${recoveryModeActive ? "Recovery Active" : strategistRecoveryActive ? "Local runtime active" : "System Ready"} · ${activeRuntimeNode?.label ?? "No runtime"}`}
            aria-label={`${recoveryModeActive ? "Recovery Active" : strategistRecoveryActive ? "Local runtime active" : "System Ready"} · ${activeRuntimeNode?.label ?? "No runtime"}`}
          />
          <button type="button" className="system-icon-button" title="Help and documentation" aria-label="Help and documentation" onClick={() => setSection("settings")}>
            <SystemTopIcon icon="help" />
          </button>
          <button
            type="button"
            className={`system-icon-button system-emergency-button ${recoveryModeActive ? "active" : ""}`}
            onClick={() =>
              setRecoveryMode(
                !recoveryModeActive,
                updateRuntimeState,
                setChatNotice,
                setAgentActivityLabel,
                setSelectedChatModel,
              )
            }
            disabled={chatBusy}
            title={recoveryModeActive ? "Exit Emergency Recovery mode" : "Open Emergency Resurrection mode"}
            aria-label={recoveryModeActive ? "Exit Recovery" : "Resurrect Local"}
          >
            <SystemTopIcon icon="resurrect" />
          </button>
          <span>{systemClockLabel}</span>
        </div>
      </header>

      <aside className="sidebar app-dock" aria-label="ResonantOS app launcher">
        <nav className="nav-list">
          {visibleNavItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${currentSection === item.id ? "active" : ""} ${item.pinned ? "pinned" : ""}`}
              onClick={() => setSection(item.id)}
              aria-label={item.label}
              title={`${item.label} · ${item.eyebrow}`}
            >
              <span className="nav-icon" aria-hidden="true">
                <DockIcon icon={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
              <small>{item.eyebrow}</small>
            </button>
          ))}
        </nav>
      </aside>

      <main className={`main-shell ${!recoveryModeActive && currentSection === "obsidian" ? "notes-shell-active" : ""}`}>

        {recoveryModeActive && (
          <div className="inline-notice warning recovery-notice">
            Recovery mode is active. Augmentor and archive ingest are offline while the Resonant Engineer Agent handles diagnosis and repair.
          </div>
        )}

        <section
          className={`content-grid ${recoveryModeActive ? "recovery-active" : ""} ${
            !recoveryModeActive && currentSection === "browser" ? "browser-active" : ""
          } ${
            !recoveryModeActive && currentSection === "terminal" ? "terminal-active" : ""
          } ${
            !recoveryModeActive && currentSection === "audio2tol" ? "audio2tol-active" : ""
          } ${
            !recoveryModeActive && currentSection === "opencode" ? "opencode-active" : ""
          } ${
            !recoveryModeActive && currentSection === "paperclip" ? "paperclip-active" : ""
          } ${
            !recoveryModeActive && currentSection === "hermes" ? "hermes-active" : ""
          } ${
            !recoveryModeActive && currentSection === "obsidian" ? "notes-active" : ""
          }`}
        >
          {recoveryModeActive ? (
            <Suspense
              fallback={
                <Panel title="Loading Recovery" subtitle="Resonant Engineer">
                  <p className="muted-copy">Preparing recovery controls...</p>
                </Panel>
              }
            >
              <RecoveryWorkspace
                state={state}
                activeRouteLabel={activeRuntimeNode?.label ?? "No live node"}
                activeModel={activeChatModel || "Missing"}
                recoveryRuntimeStatus={recoveryRuntimeStatus}
                recoveryCandidates={recoveryCandidates}
                recoveryBusy={chatBusy}
                recoveryActivityLabel={agentActivityLabel}
                onStartRecovery={startRecoveryRunbook}
                onPromoteCandidate={(candidate) =>
                  promoteRecoveryRoute(
                    candidate,
                    updateRuntimeState,
                    setSelectedChatModel,
                    setChatNotice,
                    setAgentActivityLabel,
                  )
                }
              />
            </Suspense>
          ) : currentSection === "overview" ? (
            <Suspense
              fallback={
                <Panel title="Loading Home" subtitle="ResonantOS overview">
                  <p className="muted-copy">Preparing workspace overview...</p>
                </Panel>
              }
            >
              <OverviewWorkspace
                state={state}
                manifests={allManifests}
                displayedStrategistName={displayedStrategistName}
                providerLabel={routedProviderLabel(strategistRoute)}
                onOpenArchive={() => setSection("archive")}
                onOpenDelegation={() => setSection("delegation")}
                onOpenAddons={() => setSection("addons")}
                onOpenBrowser={() => setSection("browser")}
                onOpenOpenCode={() => setSection("opencode")}
                onGrantBrowserVisibleAccess={grantBrowserVisibleAccess}
                onOpenSettings={() => setSection("settings")}
              />
            </Suspense>
          ) : null}

          {!recoveryModeActive && currentSection === "strategist" && (
            <Suspense
              fallback={
                <Panel title="Loading Agent Identity" subtitle="Strategist configuration">
                  <p className="muted-copy">Preparing identity controls...</p>
                </Panel>
              }
            >
              <StrategistWorkspace
                state={state}
                displayedStrategistName={displayedStrategistName}
                onStrategistRename={(value) => renameStrategistIdentity(value, updateRuntimeState)}
                onToggleChannel={(channelId) => toggleStrategistChannel(channelId, updateRuntimeState)}
              />
            </Suspense>
          )}

          {!recoveryModeActive && currentSection === "archive" && !memorySystemAvailable && (
            <Panel title="Select a memory add-on" subtitle="Replaceable memory slot">
              <div className="slot-empty-state">
                <p>
                  ResonantOS has no active memory-system provider. Enable Living Archive or sideload another memory
                  add-on before opening the memory workspace.
                </p>
                <p>
                  Memory is intentionally replaceable. The shell keeps the slot, but the user chooses which add-on owns
                  Human Knowledge, External Knowledge, and AI Memory operations.
                </p>
                <div className="slot-empty-actions">
                  <button
                    type="button"
                    className="button-primary touch-action"
                    onClick={() => {
                      setSelectedAddonId(
                        activeMemoryProvider?.manifest.id ??
                          allManifests.find((manifest) => manifest.systemSlots?.some((slot) => slot.id === "memory-system"))?.id ??
                          "addon.living-archive",
                      );
                      setSection("addons");
                    }}
                  >
                    Choose Memory Add-on
                  </button>
                  <button type="button" className="button-secondary touch-action" onClick={() => setSection("settings")}>
                    Open Settings
                  </button>
                </div>
                {!memorySlotHasProviders ? (
                  <small>No memory-system add-on manifests are installed. Sideload a compatible memory add-on.</small>
                ) : null}
              </div>
            </Panel>
          )}

          {!recoveryModeActive && currentSection === "archive" && memorySystemAvailable && !livingArchiveMemoryActive && (
            <Panel title="Memory Provider Active" subtitle="Replaceable memory slot">
              <div className="slot-empty-state">
                <p>
                  {activeMemoryProvider?.manifest.name ?? "Another memory add-on"} is currently active as the memory-system
                  provider. The bundled Living Archive workspace is not shown because memory is replaceable and only the
                  active provider should own this surface.
                </p>
                <p>
                  To use the Living Archive LLM Wiki, enable the Living Archive add-on with the recommended grants. To keep
                  this provider, open its add-on surface or settings instead.
                </p>
                <div className="slot-empty-actions">
                  <button
                    type="button"
                    className="button-primary touch-action"
                    onClick={() => {
                      setSelectedAddonId(activeMemoryProvider?.manifest.id ?? "addon.living-archive");
                      setSection("addons");
                    }}
                  >
                    Manage Active Memory Add-on
                  </button>
                  <button
                    type="button"
                    className="button-secondary touch-action"
                    onClick={() => {
                      setSelectedAddonId("addon.living-archive");
                      setSection("addons");
                    }}
                  >
                    Configure Living Archive
                  </button>
                </div>
              </div>
            </Panel>
          )}

          {!recoveryModeActive && currentSection === "archive" && livingArchiveMemoryActive && (
            <Suspense
              fallback={
                <Panel title="Loading Living Archive" subtitle="Memory workspace">
                  <p className="muted-copy">Preparing archive controls...</p>
                </Panel>
              }
            >
              <ArchiveWorkspace
                state={state}
                focusTarget={archiveFocusTarget}
                archiveStatusBusy={archiveStatusBusy}
                archiveStatus={archiveStatus}
                archiveSearchBusy={archiveSearchBusy}
                archiveSearchResult={archiveSearchResult}
                archiveDocumentBusy={archiveDocumentBusy}
                archiveDocument={archiveDocument}
                archiveQueueBusy={archiveQueueBusy}
                archiveQueue={archiveQueue}
                archiveReviewArtifacts={archiveReviewArtifacts}
                archiveProcessResult={archiveProcessResult}
                archiveReviewDecisionResult={archiveReviewDecisionResult}
                archivePromotionResult={archivePromotionResult}
                archiveMaintenanceResult={archiveMaintenanceResult}
                archiveAiMemoryBuildResult={archiveAiMemoryBuildResult}
                archiveAiMemoryBuildJobs={archiveAiMemoryBuildJobs}
                archiveLintResult={archiveLintResult}
                archiveSemanticLintResult={archiveSemanticLintResult}
                archiveTolBundles={archiveTolBundles}
                archiveTolBundleResult={archiveTolBundleResult}
                archiveSourceScanBusy={archiveSourceScanBusy}
                archiveSourceScanResult={archiveSourceScanResult}
                archiveImportedLibraries={archiveImportedLibraries}
                archiveClassificationReview={archiveClassificationReview}
                archiveReorganisationPlan={archiveReorganisationPlan}
                archiveLibraryImportResult={archiveLibraryImportResult}
                archiveLibraryPreflightResult={archiveLibraryPreflightResult}
                ingestProbeBusy={archiveProbeBusy}
                ingestProbeResult={archiveProbeResult}
                onRefreshArchiveStatus={() => void refreshArchiveRuntime()}
                onRefreshArchiveSourceRegistry={() => void refreshArchiveSourceRegistry()}
                onRefreshArchiveQueue={() => void refreshArchiveQueue()}
                onRunArchiveSearch={(query) => void runArchiveSearch(query)}
                onOpenArchiveDocument={(path) => void openArchiveDocument(path)}
                onQueueArchiveSource={(source) => void queueArchiveSource(source)}
                onScanSourceFolders={(rootPath) => void runArchiveSourceFolderScan(rootPath)}
                onPickLibraryFolder={runPickArchiveLibraryFolder}
                onPreflightLibrary={(sourcePath) => void runArchiveLibraryPreflight(sourcePath)}
                onAskAugmentorAboutPreflight={(report) => void startArchivePreflightAugmentorSession(report)}
                onOpenClassificationReview={(classificationManifestPath) => void openArchiveClassificationReview(classificationManifestPath)}
                onGenerateReorganisationPlan={(classificationManifestPath) => void runArchiveReorganisationPlan(classificationManifestPath)}
                onQueueImportedLibraryForIngest={queueImportedLibraryIngest}
                onImportLibrary={(input) => void runArchiveLibraryImport(input)}
                onQueueWatchedSource={(source) => void queueWatchedArchiveSource(source)}
                onProcessArchiveRequest={(requestFile) => void runArchiveQueuedRequest(requestFile)}
                onApproveReviewArtifact={(artifactFile) => void runArchiveReviewDecision(artifactFile, "approve", "strategist.core")}
                onHumanApproveReviewArtifact={(artifactFile) => void runArchiveReviewDecision(artifactFile, "approve", "human.user")}
                onEscalateReviewArtifact={(artifactFile) => void runArchiveReviewDecision(artifactFile, "escalate", "strategist.core")}
                onRejectReviewArtifact={(artifactFile) => void runArchiveReviewDecision(artifactFile, "reject", "strategist.core")}
                onHumanRejectReviewArtifact={(artifactFile) => void runArchiveReviewDecision(artifactFile, "reject", "human.user")}
                onPromoteReviewArtifact={(artifactFile) => void runArchivePromotion(artifactFile)}
                onPromoteApprovedArtifacts={runApprovedArchivePromotion}
                onRunArchiveMaintenance={runArchiveMaintenance}
                onRunArchiveLint={() => void runArchiveHealthLint()}
                onRunArchiveSemanticLint={() => void runArchiveSemanticHealthLint()}
                onRefreshTolBundles={() => void refreshArchiveTolBundles()}
                onBuildTolBundle={(sessionId) => void runArchiveTolBundleBuild(sessionId)}
                onRunIngestProbe={() => void runArchiveIngestProbe()}
                onAskAugmentor={sendLivingArchiveAgentMessage}
                onInspectImportedLibraryCoverage={inspectImportedLibraryCoverage}
                archiveAgentThread={archiveAgentThread}
                archiveAgentBusy={chatBusy}
                archiveAgentRunPhase={chatRunPhase}
                archiveAgentActivityLabel={agentActivityLabel}
                onUpdateArchiveAutomationPolicy={(policy) =>
                  updateRuntimeState((draft) => {
                    draft.archiveAutomationPolicy = policy;
                    return draft;
                  })
                }
              />
            </Suspense>
          )}

          {!recoveryModeActive && currentSection === "delegation" && (
            <Suspense
              fallback={
                <Panel title="Loading Delegation" subtitle="Task workspaces">
                  <p className="muted-copy">Preparing delegation controls...</p>
                </Panel>
              }
            >
              <DelegationWorkspace
                state={state}
                chatBusy={chatBusy}
                hermesProfileHome={
                  typeof state.installations["addon.hermes"]?.config?.profileHome === "string"
                    ? state.installations["addon.hermes"]?.config?.profileHome
                    : undefined
                }
                hermesModel={
                  typeof state.installations["addon.hermes"]?.config?.hermesModel === "string"
                    ? state.installations["addon.hermes"]?.config?.hermesModel
                    : undefined
                }
                onStartWorkspace={async (workspaceId) => {
                  await sendStrategistMessage(`start engineer task ${workspaceId}`);
                }}
                onAskAugmentor={async (message) => {
                  await sendStrategistMessage(message);
                }}
              />
            </Suspense>
          )}

          {!recoveryModeActive && currentSection === "compute" && (
            <Suspense
              fallback={
                <Panel title="Loading Compute Fabric" subtitle="Runner registry">
                  <p className="muted-copy">Preparing compute controls...</p>
                </Panel>
              }
            >
              <ComputeFabricWorkspace
                state={state}
                onRefreshLocalDiagnostics={refreshComputeLocalDiagnostics}
                onRunLocalCommandProbe={runComputeLocalCommandProbe}
                onQuarantineNode={quarantineComputeNode}
                onRevokeNode={revokeComputeNode}
              />
            </Suspense>
          )}

          {!recoveryModeActive && currentSection === "browser" && (
            <Suspense
              fallback={
                <Panel title="Loading Browser" subtitle="Chromium workspace">
                  <p className="muted-copy">Preparing browser controls...</p>
                </Panel>
              }
            >
              <BrowserWorkspace
                manifest={browserManifest}
                installation={browserInstallation}
                workspaceState={state.uiPreferences.browserWorkspace}
                onWorkspaceStateChange={updateBrowserWorkspaceState}
                onConfigureAddon={() => setSection("addons")}
                onGrantVisibleAccess={grantBrowserVisibleAccess}
                onOpenInternalPreview={openInternalBrowserPreview}
                onScrollInternalPreview={scrollInternalBrowserPreview}
                onReadActivePage={readActiveBrowserPage}
                onProbeNativeBrowser={probeNativeBrowserHost}
                onSmokeTestNativeAttach={smokeTestNativeBrowserAttach}
                onProbeNativeBridge={probeNativeBrowserBridge}
                onLoadPriorityExtension={loadPriorityBrowserExtension}
                onOpenWalletBrowserHost={openWalletBrowserHost}
                onReadWalletBrowserHost={readWalletBrowserHost}
                onInspectWalletDappGate={inspectWalletDappGate}
                onListVisibleExtensions={listVisibleBrowserExtensions}
                onSetExtensionPinned={setVisibleBrowserExtensionPinned}
                onDisableExtension={disableVisibleBrowserExtension}
              />
            </Suspense>
          )}

          {!recoveryModeActive && (
            <OpenCodeWorkspace
              active={currentSection === "opencode"}
              manifest={opencodeManifest}
              installation={opencodeInstallation}
              onConfigureAddon={() => {
                setSelectedAddonId("addon.opencode");
                setSection("addons");
              }}
              onGrantWorkspaceAccess={grantOpenCodeWorkspaceAccess}
              onWorkspacePathChange={updateOpenCodeWorkspacePath}
              onOpenDelegationMonitor={() => setSection("delegation")}
              pendingTaskWorkspaceId={state.uiPreferences.pendingOpenCodeWorkspaceId}
              onPendingTaskConsumed={consumePendingOpenCodeWorkspace}
            />
          )}

          {!recoveryModeActive && (
            <PaperclipWorkspace
              active={currentSection === "paperclip"}
              manifest={paperclipManifest}
              installation={paperclipInstallation}
              onConfigureAddon={() => {
                setSelectedAddonId("addon.paperclip");
                setSection("addons");
              }}
              onGrantWorkspaceAccess={grantPaperclipWorkspaceAccess}
              onEndpointChange={updatePaperclipEndpoint}
            />
          )}

          {!recoveryModeActive && (
            <HermesWorkspace
              active={currentSection === "hermes"}
              manifest={hermesManifest}
              installation={hermesInstallation}
              onConfigureAddon={() => {
                setSelectedAddonId("addon.hermes");
                setSection("addons");
              }}
              onGrantWorkspaceAccess={grantHermesWorkspaceAccess}
              onProfileHomeChange={updateHermesProfileHome}
              onModelMetadataChange={updateHermesModelMetadata}
              onAskAugmentor={sendStrategistMessage}
            />
          )}

          {!recoveryModeActive && currentSection === "terminal" && (
            <Suspense
              fallback={
                <Panel title="Loading Terminal" subtitle="Local shell add-on">
                  <p className="muted-copy">Preparing terminal controls...</p>
                </Panel>
              }
            >
              <TerminalWorkspace
                manifest={terminalManifest}
                installation={terminalInstallation}
                onConfigureAddon={() => {
                  setSelectedAddonId("addon.terminal");
                  setSection("addons");
                }}
                onGrantWorkspaceAccess={grantTerminalWorkspaceAccess}
              />
            </Suspense>
          )}

          {!recoveryModeActive && currentSection === "obsidian" && (
            <div className="full-pane-route notes-pane-route">
              <Suspense
                fallback={
                  <Panel title="Loading Resonant Notes" subtitle="Markdown vault workspace">
                    <p className="muted-copy">Preparing the vault workspace...</p>
                  </Panel>
                }
              >
                <ObsidianWorkspace
                  manifest={obsidianManifest}
                  installation={obsidianInstallation}
                  onConfigureAddon={() => {
                    setSelectedAddonId("addon.obsidian");
                    setSection("addons");
                  }}
                  onGrantWorkspaceAccess={grantObsidianWorkspaceAccess}
                />
              </Suspense>
            </div>
          )}

          {!recoveryModeActive && currentSection === "audio2tol" && (
            <Suspense
              fallback={
                <Panel title="Loading Audio2TOL" subtitle="TOL audio intake add-on">
                  <p className="muted-copy">Preparing TOL intake controls...</p>
                </Panel>
              }
            >
              <Audio2TolWorkspace
                manifest={audio2TolManifest}
                installation={audio2TolInstallation}
                archiveQueueBusy={archiveQueueBusy}
                archiveTolBundles={archiveTolBundles}
                archiveTolBundleResult={archiveTolBundleResult}
                onConfigureAddon={() => {
                  setSelectedAddonId("addon.audio2tol");
                  setSection("addons");
                }}
                onRefreshTolBundles={() => void refreshArchiveTolBundles()}
                onBuildTolBundle={(sessionId) => void runArchiveTolBundleBuild(sessionId)}
                onOpenArchiveDocument={(path) => void openArchiveDocument(path)}
                onUpdateAddonConfig={(config) => updateAddonConfig("addon.audio2tol", config, updateRuntimeState)}
                providerProfiles={state.providers}
                runtimeNodes={state.runtimeNodes}
              />
            </Suspense>
          )}

          {!recoveryModeActive && currentSection === "addons" && (
            <Suspense
              fallback={
                <Panel title="Loading Add-ons" subtitle="Extension catalog">
                  <p className="muted-copy">Preparing add-on controls...</p>
                </Panel>
              }
            >
              <AddOnsWorkspace
                search={search}
                sideloadPath={sideloadPath}
                filteredManifests={filteredManifests}
                installations={state.installations}
                selectedManifest={selectedManifest}
                selectedInstallation={selectedInstallation}
                onSearchChange={(value) => {
                  startTransition(() => setSearch(value));
                }}
                onSideloadPathChange={setSideloadPath}
                onSideload={() => void handleSideload()}
                onSelectManifest={setSelectedAddonId}
                onToggleAddonInstall={(manifest) => toggleAddonInstallation(manifest, updateRuntimeState)}
                onToggleGrant={(manifestId, capability) =>
                  toggleAddonCapabilityGrant(manifestId, capability, updateRuntimeState)
                }
                onGrantCapabilities={(manifestId, capabilities, requestedCapabilities) =>
                  grantAddonCapabilities(manifestId, capabilities, requestedCapabilities, updateRuntimeState)
                }
                onGrantTerminalWorkspaceAccess={grantAndOpenTerminalWorkspace}
                onUpdateAddonConfig={(manifestId, config) => updateAddonConfig(manifestId, config, updateRuntimeState)}
                onRunLogicianScript={(manifest, installation, script) =>
                  runAddonLogicianScript(manifest, installation, script, updateRuntimeState)
                }
                onRunLogicianHook={(manifest, installation, hook) =>
                  runAddonLogicianHook(manifest, installation, hook, updateRuntimeState)
                }
                onAskAugmentor={async (message) => {
                  await sendStrategistMessage(message);
                }}
                onOpenArchiveReview={openArchiveReview}
                onOpenSurface={(sectionId) => setSection(sectionId)}
              />
            </Suspense>
          )}

          {!recoveryModeActive && currentSection === "settings" && (
            <Suspense
              fallback={
                <Panel title="Loading Settings" subtitle="System configuration">
                  <p className="muted-copy">Preparing settings controls...</p>
                </Panel>
              }
            >
              <SettingsWorkspace
                state={state}
                manifests={allManifests}
                settingsSection={settingsSection}
                settingsNotice={settingsNotice}
                providerDiagnostics={providerDiagnostics}
                providerDiagnosticsBusy={providerDiagnosticsBusy}
                activeProviderProbeId={activeProviderProbeId}
                providerSmokeResults={providerSmokeResults}
                providerSmokeBusyId={providerSmokeBusyId}
                providerDrafts={providerDrafts}
                memoryServiceStatus={memoryServiceStatus}
                memoryServiceBusy={memoryServiceBusy}
                memoryServiceLastResult={memoryServiceLastResult}
                onSettingsSectionChange={setSettingsSection}
                onUpdateProvider={(profileId, field, value) =>
                  updateProviderProfile(profileId, field, value, updateRuntimeState)
                }
                onCreateProvider={(input) => void handleCreateProviderProfile(input)}
                onUpdateWorkloadStrategy={(strategyId, patch) =>
                  updateModelWorkloadStrategy(strategyId, patch, updateRuntimeState)
                }
                onUpdateWorkloadStrategyRoute={(strategyId, routeKey) =>
                  updateModelWorkloadStrategyRoute(strategyId, routeKey, updateRuntimeState)
                }
                onProviderDraftChange={(profileId, value) =>
                  setProviderDrafts((current) => ({ ...current, [profileId]: value }))
                }
                onSaveProviderSecret={(profileId) => void handleSaveProviderSecret(profileId)}
                onProbeProvider={(profileId) => void refreshProviderDiagnostics(profileId)}
                onProbeAllProviders={() => void refreshProviderDiagnostics()}
                onSetupProvider={(profileId) => void handleSetupProviderProfile(profileId)}
                onSmokeTestProvider={(profileId) => void runProviderSmokeTest(profileId)}
                onRefreshMemoryServiceStatus={() => void refreshMemoryServiceStatus()}
                onStartMemoryService={() => void startMemoryService()}
                onStopMemoryService={() => void stopMemoryService()}
                onOpenLogicianAddOn={() => {
                  setSection("addons");
                  setSelectedAddonId("addon.logician");
                }}
              />
            </Suspense>
          )}
        </section>
      </main>

      {chatInterfaceAvailable && (
      <StrategistChatRail
        isOpen={effectiveChatOpen}
        showCollapsedToggle={!centerWorkspaceOwnsAgentChat}
        mode={recoveryModeActive ? "emergency" : "strategist"}
        title={activeChatAgentName}
        eyebrow={
          recoveryModeActive
            ? "Emergency recovery console"
            : engineerSettingsConsoleActive
              ? "Setup and settings assistant"
              : "Persistent Strategist Chat"
        }
        description={
          recoveryModeActive
            ? "The Resonant Engineer Agent handles diagnosis, recovery logging, documentation checks, and the final repair report."
            : engineerSettingsConsoleActive
              ? "The Resonant Engineer stays available for setup even when Augmentor Chat is disabled."
            : "Primary trusted conversation channel."
        }
        activeThread={activeThread}
        strategistThreads={state.conversationThreads}
        chatProjects={state.chatProjects ?? []}
        pinnedThreadIds={state.uiPreferences.pinnedChatThreadIds}
        pinnedProjectIds={state.uiPreferences.pinnedChatProjectIds ?? []}
        availableAgents={state.agents
          .filter((agent) =>
            engineerSettingsConsoleActive
              ? agent.id === state.recoverySession.engineerAgentId
              :
            state.channels.some(
              (channel) =>
                channel.owningAgentId === agent.id &&
                channel.type === "desktop" &&
                channel.enabled &&
                channelAllowedByOwningAddon(state, channel),
            ),
          )
          .map((agent) => ({
            id: agent.id,
            displayName: agent.id === "strategist.core" ? displayedStrategistName : agent.displayName,
            shortLabel: agent.id === "strategist.core" ? "A" : agent.id === state.recoverySession.engineerAgentId ? "E" : agent.displayName.slice(0, 1),
          }))}
        activeAgentId={activeThread?.owningAgentId ?? (recoveryModeActive ? state.recoverySession.engineerAgentId : "strategist.core")}
        channels={state.channels}
        chatBusy={chatBusy}
        chatCanStop={chatRunPhase !== "idle"}
        chatSupportsAbort={activeRoute.executionAdapter?.supportsAbort === true}
        chatRunPhase={chatRunPhase}
        chatRunEvents={chatRunEvents}
        chatNotice={chatNotice}
        composer={composer}
        attachments={attachments}
        dictating={dictating}
        dictationAvailable={dictationAvailable}
        activeChatModel={activeChatModel}
        availableModels={selectableChatModels.length ? selectableChatModels : activeProvider?.allowedModels ?? []}
        thinkingDepth={thinkingDepth}
        contextUsageLabel={contextUsageLabel}
        contextUsageRatio={contextUsageRatio}
        contextUsageTitle={contextUsageTitle}
        contextBudget={contextBudget}
        compactState={latestCompactState}
        historyOpen={isFloatingChatSurface ? floatingChatHistoryOpen : state.uiPreferences.chatHistoryOpen}
        activityLabel={agentActivityLabel}
        recoveryRuntimeStatus={
          recoveryModeActive
            ? {
                activeRouteLabel: activeRuntimeNode?.label ?? "No live node",
                activeModel: activeChatModel || "Missing",
                targetModel: recoveryRuntimeStatus?.targetModel ?? "batiai/gemma4-e2b:q4",
                available: recoveryRuntimeStatus?.available ?? false,
                installed: recoveryRuntimeStatus?.recoveryModelInstalled ?? false,
                running: recoveryRuntimeStatus?.recoveryModelRunning ?? false,
                runningModels: recoveryRuntimeStatus?.runningModels ?? [],
              }
            : null
        }
        chatScrollAnchorRef={chatScrollAnchorRef}
        fileInputRef={fileInputRef}
        onCreateNewChat={(agentId, projectId) =>
          createAgentChatThreadAction({
            agentId,
            projectId,
            state,
            updateRuntimeState,
            setComposer,
            setAttachments,
            setChatNotice,
          })
        }
        onCreateProject={(title) =>
          createChatProjectAction({
            title,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onSetHistoryOpen={isFloatingChatSurface ? setFloatingChatHistoryOpen : setChatHistoryOpen}
        onToggleSidebar={isFloatingChatSurface ? () => undefined : toggleChatSidebar}
        onSetActiveThread={(threadId) =>
          activateChatThread(threadId, updateRuntimeState, setComposer, setChatNotice, setAttachments)
        }
        onTogglePinnedThread={(threadId) => togglePinnedChatThreadAction({ threadId, updateRuntimeState })}
        onRenameThread={(threadId, title) =>
          renameChatThreadAction({
            threadId,
            title,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onMoveThreadToProject={(threadId, projectId) =>
          moveChatThreadToProjectAction({
            threadId,
            projectId,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onDeleteThread={(threadId) =>
          deleteChatThreadAction({
            activeThread,
            threadId,
            updateRuntimeState,
            setComposer,
            setAttachments,
            setChatNotice,
          })
        }
        onBranchThread={(threadId) =>
          branchChatThreadAction({
            threadId,
            updateRuntimeState,
            setComposer,
            setAttachments,
            setChatNotice,
          })
        }
        onTogglePinnedProject={(projectId) => togglePinnedChatProjectAction({ projectId, updateRuntimeState })}
        onRenameProject={(projectId, title) =>
          renameChatProjectAction({
            projectId,
            title,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onBranchProject={(projectId) =>
          branchChatProjectAction({
            projectId,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onDeleteProject={(projectId) =>
          deleteChatProjectAction({
            projectId,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onSelectAgent={(agentId) =>
          selectChatAgentAction({
            agentId,
            state,
            updateRuntimeState,
            setComposer,
            setChatNotice,
            setAttachments,
          })
        }
        onComposerChange={setComposer}
        onSend={() => void sendStrategistMessage()}
        onStopGeneration={() => {
          stopChatGenerationAction({
            chatBusy,
            activeThread,
            activeChatRunTokenRef,
            updateRuntimeState,
            setChatBusy,
            setChatRunPhase,
            setAgentActivityLabel,
            setChatNotice,
          });
          setChatRunEvents([]);
        }}
        onCompactThread={() =>
          compactActiveChatContextAction({
            activeThread,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onUpdateCompactMemory={(patch) =>
          updateCompactMemoryAction({
            activeThread,
            patch,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onSaveMessageToArchive={(message) => {
          if (!activeThread) {
            return;
          }
          void saveChatMessageToArchiveIntake({
            thread: activeThread,
            message,
            memoryProvider: resolveMemoryProviderBroker(state, allManifests),
            setChatNotice,
            setArchiveQueueBusy,
            setArchiveQueue,
            setArchiveReviewArtifacts,
            errorMessageOf,
          });
        }}
        onBranchFromMessage={(message) =>
          branchChatFromMessageAction({
            activeThread,
            message,
            updateRuntimeState,
            setComposer,
            setAttachments,
            setChatNotice,
          })
        }
        onEditUserMessage={(message) =>
          editUserMessageAction({
            activeThread,
            message,
            updateRuntimeState,
            setComposer,
            setChatNotice,
          })
        }
        onDeleteMessage={(message) =>
          deleteChatMessageAction({
            message,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onToggleDictation={() =>
          toggleComposerDictation({
            dictating,
            speechRecognitionRef,
            setDictating,
            setComposer,
            setChatNotice,
            errorMessageOf,
          })
        }
        onModelChange={handleChatModelChange}
        onThinkingDepthChange={setThinkingDepth}
        onFileAttach={(files) => void attachComposerFiles(files, setAttachments, fileInputRef)}
        onRemoveAttachment={(attachmentId) => removeComposerAttachment(attachmentId, setAttachments)}
        onStartResize={startChatRailResize}
        onDetachChat={isFloatingChatSurface ? undefined : () => void detachChatWindow()}
      />
      )}
      {showFirstRunRecommendedAddOns && (
        <div className="first-run-backdrop" role="dialog" aria-modal="true" aria-label="Choose recommended ResonantOS add-ons">
          <section className="first-run-card">
            <span className="eyebrow">First-run setup</span>
            <h2>Choose the recommended default add-ons.</h2>
            <p>
              ResonantOS can start as a minimal shell, or you can enable the recommended replaceable defaults now.
              You can disable or replace them later from Add-ons.
            </p>
            <div className="first-run-choice-list">
              {recommendedAddOns.map((manifest) => (
                <label key={manifest.id} className="first-run-choice">
                  <input
                    type="checkbox"
                    checked={firstRunSelectionFor(manifest.id)}
                    onChange={(event) =>
                      setFirstRunSelections((current) => ({
                        ...current,
                        [manifest.id]: event.target.checked,
                      }))
                    }
                  />
                  <span>
                    <strong>{manifest.name}</strong>
                    <small>{manifest.description}</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="first-run-actions">
              <button
                type="button"
                className="button-primary touch-action"
                onClick={() => {
                  const selectedIds = recommendedAddOns
                    .filter((manifest) => firstRunSelectionFor(manifest.id))
                    .map((manifest) => manifest.id);
                  commitReadyState(applyFirstRunRecommendedAddOns(state, allManifests, selectedIds));
                }}
              >
                Apply Selection
              </button>
              <button
                type="button"
                className="button-secondary touch-action"
                onClick={() => {
                  const nextState = markFirstRunRecommendedAddOnsReviewed(state);
                  nextState.uiPreferences.activeSection = "addons";
                  nextState.uiPreferences.chatSidebarOpen = false;
                  commitReadyState(nextState);
                }}
              >
                Choose Add-ons Manually
              </button>
              <button
                type="button"
                className="button-secondary touch-action"
                onClick={() => commitReadyState(markFirstRunRecommendedAddOnsReviewed(state))}
              >
                Continue Minimal
              </button>
            </div>
          </section>
        </div>
      )}
        </div>
      </div>
    </div>
  );
}

function DockIcon(props: { icon: DockIconId }) {
  if (props.icon === "opencode") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <use href="/icons/resonant.svg#ros-opencode" />
      </svg>
    );
  }

  if (props.icon === "terminal") {
    return (
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <use href="/icons/resonant.svg#ros-terminal" />
      </svg>
    );
  }

  if (props.icon === "paperclip") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.2 12.6 13.8 7a3.2 3.2 0 0 1 4.5 4.5l-7.1 7.1a4.8 4.8 0 0 1-6.8-6.8l7.7-7.7a6.2 6.2 0 0 1 8.8 8.8l-7.8 7.8" />
      </svg>
    );
  }

  if (props.icon === "hermes") {
    return (
      <span className="hermes-dock-icon" aria-hidden="true">
        <img src="/icons/custom/hermes-agent.png" alt="" />
      </span>
    );
  }

  if (props.icon === "obsidian") {
    return (
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <use href="/icons/resonant.svg#ros-resonant-notes" />
      </svg>
    );
  }

  if (props.icon === "audio2tol") {
    return (
      <svg
        viewBox="0 0 64 64"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M13 36V26" />
        <path d="M21 45V17" />
        <path d="M29 52V12" />
        <path d="M37 45V19" />
        <path d="M45 38V26" />
        <path d="M51 32h-6" />
        <path d="m47 28 4 4-4 4" />
      </svg>
    );
  }

  return <VendorIcon icon={dockIconMap[props.icon]} />;
}

function VendorIcon(props: { icon: VendorIconId }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <use href={`/icons/vendor-ui.svg#tabler-${props.icon}`} />
    </svg>
  );
}

function SystemTopIcon(props: { icon: "help" | "resurrect" }) {
  if (props.icon === "help") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M9.5 9a2.7 2.7 0 0 1 5.1 1.3c0 2.2-2.8 2.3-2.8 4M12 18h.01M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4Z"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3v4M12 17v4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M3 12h4M17 12h4M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8M9.2 12a2.8 2.8 0 1 0 5.6 0 2.8 2.8 0 0 0-5.6 0Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}
