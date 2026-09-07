// Intent citation: docs/architecture/ADR-005-provider-fabric-routing.md
// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md

import type {
  AddOnManifest,
  ArchiveAiMemoryBuildJobSummary,
  ArchiveAiMemoryBuildResult,
  ArchiveBackgroundCycleResult,
  ArchiveDocumentPayload,
  ArchivePromoteReviewArtifactResult,
  ArchiveProcessIngestResult,
  ArchiveQueuedIngestRequest,
  ArchiveReviewArtifact,
  ArchiveReviewDecisionResult,
  ArchiveIngestRequestResult,
  ArchiveIngestProbeResult,
  ArchiveIntakeWriteResult,
  ArchiveImportedLibrarySummary,
  ArchiveLibraryClassificationReview,
  ArchiveQueueImportedLibraryResult,
  ArchiveLibraryReorganisationPlan,
  ArchiveLibraryImportMode,
  ArchiveLibraryImportResult,
  ArchiveLintResult,
  ArchiveLibraryPreflightResult,
  ArchiveMaintenanceCycleResult,
  ArchiveMemoryDomain,
  ArchiveRuntimeStatus,
  ArchiveSearchResult,
  ArchiveSemanticLintResult,
  ArchiveSourceFolderScanResult,
  ArchiveSystemMemoryRefreshResult,
  ArchiveSystemMemoryStatus,
  ArchiveWikiNavigationRefreshResult,
  BrowserEngineInstallResult,
  BrowserEngineStatus,
  BrowserCloseSessionResult,
  BrowserExtensionListResult,
  BrowserInteractionResult,
  BrowserOpenUrlResult,
  BrowserReadPageResult,
  BrowserToolCommand,
  BrowserViewportInput,
  ComputePassiveDiagnosticsResult,
  ComputeRemoteProbeRequest,
  ComputeRemoteProbeResult,
  ComputeSafeCommandRequest,
  ComputeSafeCommandResult,
  ConversationMessage,
  DelegationPacket,
  EngineerRecoveryTurnResult,
  ExecuteOpenCodeTaskResult,
  FinishTaskWorkspaceResult,
  HermesChatResult,
  HermesDashboardStatus,
  HermesInstallResult,
  HermesInstallStatus,
  HermesWorkspaceSnapshot,
  Gx10LlamaStatusResult,
  Gx10LlamaSwitchRequest,
  Gx10LlamaSwitchResult,
  LocalRuntimeStatus,
  LivingArchiveMemoryServiceResult,
  LivingArchiveMemoryServiceStatus,
  ObsidianNoteOperationResult,
  ObsidianNotePayload,
  ObsidianNoteSummary,
  ObsidianOpenNoteResult,
  ObsidianVaultIndex,
  ObsidianWriteNoteResult,
  ObsidianVaultStatus,
  NasBackupStatusResult,
  OpenCodeInjectPromptResult,
  OpenCodeLaunchMode,
  OpenCodeServiceResult,
  OpenCodeStatus,
  PaperclipServiceResult,
  PaperclipStatus,
  PaperclipDashboardSnapshot,
  PaperclipCreateIssueResult,
  ProviderDiagnosticReport,
  ProviderProfile,
  ProviderRequestAuditRecord,
  ProviderSetupProbeResult,
  ProviderSmokeTestResult,
  RecoveryRouteCandidate,
  ResonantShellState,
  TaskWorkspace,
  TaskWorkspacePayload,
  TelegramServiceStatus,
  TrustKernelAdvisory,
} from "./contracts";
import type { BrowserToolResult } from "./browser-tools";
import { buildDefaultState } from "./defaults";
import { renderDelegationTaskMarkdown, validateDelegationPacket } from "./delegation";
import { normalizeGoalWorkspaces } from "./goal-workspace";
import { providerNeedsStoredCredential } from "./provider-credentials";
import { createInstallationSnapshot } from "./policies";
import { assertValidAddOnManifest } from "../sdk/addons";
import { webInvoke } from "./web-transport";

const STORAGE_KEY = "resonantos-vnext.runtime-state";

const hasCommandHost = (): boolean => false;
const invoke = async <T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> => webInvoke<T>(command, args);
const listen = async <T>(
  _eventName: string,
  _handler: (event: { payload: T }) => void,
): Promise<() => void> => () => undefined;
const open = async (_options: Record<string, unknown>): Promise<null> => null;
const hostInvoke = invoke;

export type BrowserLiveWebviewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const LIVE_BROWSER_WEBVIEW_LABEL = "resonant-browser-live";

const assertBrowserHttpUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Live Browser accepts only http and https URLs.");
  }
  return parsed.toString();
};

export const bundledManifestIndex = "/addons/index.json";
const devBundledManifestIndex = "/addons/dev-index.json";

const isLocalDevelopmentMode = (): boolean => import.meta.env.MODE === "development";

const loadBundledManifestIndex = async (): Promise<string[]> => {
  const indexPath = isLocalDevelopmentMode() ? devBundledManifestIndex : bundledManifestIndex;
  const response = await fetch(indexPath);
  if (!response.ok) {
    if (isLocalDevelopmentMode()) {
      const productionResponse = await fetch(bundledManifestIndex);
      if (!productionResponse.ok) {
        throw new Error(`Failed to load add-on index: ${productionResponse.status}`);
      }
      return (await productionResponse.json()) as string[];
    }
    throw new Error(`Failed to load add-on index: ${response.status}`);
  }
  return (await response.json()) as string[];
};

export const loadBundledManifests = async (): Promise<AddOnManifest[]> => {
  const files = await loadBundledManifestIndex();
  const manifests = await Promise.all(
    files.map(async (file) => {
      const manifestResponse = await fetch(`/addons/${file}`);
      if (!manifestResponse.ok) {
        throw new Error(`Failed to load add-on manifest ${file}`);
      }
      return assertValidAddOnManifest(await manifestResponse.json(), { source: "bundled", label: file });
    }),
  );
  return manifests;
};

export const loadSideloadedManifests = async (): Promise<AddOnManifest[]> => {
  if (hasCommandHost()) {
    const manifests = (await invoke("list_sideloaded_addons")) as unknown[];
    return manifests.map((manifest, index) =>
      assertValidAddOnManifest(manifest, { source: "sideload", label: `sideloaded add-on ${index + 1}` }),
    );
  }
  return [];
};

export const sideloadManifest = async (manifestPath: string): Promise<AddOnManifest> => {
  if (hasCommandHost()) {
    return assertValidAddOnManifest(await invoke("sideload_addon_manifest", { manifestPath }), {
      source: "sideload",
      label: manifestPath,
    });
  }
  throw new Error("Sideloading add-ons is available only through the local bridge.");
};

export const loadProviderCredentialStatuses = async (): Promise<Record<string, boolean>> => {
  if (hasCommandHost()) {
    return hostInvoke<Record<string, boolean>>("load_provider_secret_statuses");
  }
  if (hasCommandHost()) {
    return (await invoke("load_provider_secret_statuses")) as Record<string, boolean>;
  }
  return {};
};

export const saveProviderSecret = async (providerId: string, apiKey: string): Promise<void> => {
  if (hasCommandHost()) {
    await hostInvoke("save_provider_secret", { providerId, apiKey });
    return;
  }
  if (hasCommandHost()) {
    await invoke("save_provider_secret", { providerId, apiKey });
    return;
  }
  // SECURITY: credentials resolved host-side via provider_service.
  // Raw API keys must never be stored in the renderer (localStorage is readable
  // by any script in the same origin). Record only an opaque profile-configured
  // marker so the UI can reflect credential status without holding the secret.
  window.localStorage.setItem(`${STORAGE_KEY}.secret.${providerId}`, "__configured__");
};

export const saveTelegramBotToken = async (botToken: string): Promise<void> => {
  if (hasCommandHost()) {
    await invoke("telegram_save_bot_token", { botToken });
    return;
  }
  // SECURITY: credentials resolved host-side via provider_service.
  // Store only a presence marker; the raw bot token is not persisted in the renderer.
  window.localStorage.setItem(`${STORAGE_KEY}.secret.addon.telegram-channel.bot-token`, "__configured__");
};

export const requestTelegramServiceStatus = async (channelId = "telegram-primary"): Promise<TelegramServiceStatus> => {
  if (hasCommandHost()) {
    return (await invoke("telegram_service_status", { channelId })) as TelegramServiceStatus;
  }
  return {
    running: false,
    tokenConfigured: Boolean(window.localStorage.getItem(`${STORAGE_KEY}.secret.addon.telegram-channel.bot-token`)),
    channelId,
  };
};

export const startTelegramService = async (input: {
  channelId?: string;
  allowedChatIds?: string[];
  preferredModel?: string;
}): Promise<TelegramServiceStatus> => {
  if (hasCommandHost()) {
    return (await invoke("telegram_service_start", { request: input })) as TelegramServiceStatus;
  }
  throw new Error("Telegram channel service is available only through the local bridge.");
};

export const stopTelegramService = async (channelId = "telegram-primary"): Promise<TelegramServiceStatus> => {
  if (hasCommandHost()) {
    return (await invoke("telegram_service_stop", { channelId })) as TelegramServiceStatus;
  }
  return { running: false, tokenConfigured: false, channelId };
};

export const requestProviderServiceChatCompletion = async (input: {
  requestId?: string;
  threadId?: string;
  agentId?: string;
  channelId?: string;
  providerId: string;
  providerType: ProviderProfile["providerType"];
  apiBaseUrl?: string;
  runtimeNodeId?: string;
  runtimeNodeKind?: string;
  runtimeNodeEndpoint?: string;
  authTier?: string;
  model: string;
  reasoningEffort: "minimal" | "medium" | "high";
  systemPrompt: string;
  messages: ConversationMessage[];
}): Promise<string> => {
  return (await invoke("provider_service_chat_completion", input)) as string;
};

export const requestStrategistReply = requestProviderServiceChatCompletion;

export type ProviderChatStreamEvent = {
  runId: string;
  type: "chunk" | "completed" | "interrupted" | "error" | "usage";
  content: string;
};

export const requestProviderServiceChatCompletionStream = async (
  input: {
    runId: string;
    threadId?: string;
    agentId?: string;
    channelId?: string;
    providerId: string;
    providerType: ProviderProfile["providerType"];
    apiBaseUrl?: string;
    runtimeNodeId?: string;
    runtimeNodeKind?: string;
    runtimeNodeEndpoint?: string;
    authTier?: string;
    model: string;
    reasoningEffort: "minimal" | "medium" | "high";
    systemPrompt: string;
    messages: ConversationMessage[];
  },
  onEvent: (event: ProviderChatStreamEvent) => void,
): Promise<string> => {
  const reply = await requestProviderServiceChatCompletion(input);
  onEvent({ runId: input.runId, type: "chunk", content: reply });
  onEvent({ runId: input.runId, type: "completed", content: "" });
  return reply;
};

export const abortProviderServiceChatCompletion = async (runId: string): Promise<void> => {
  if (hasCommandHost()) {
    await invoke("provider_service_abort_chat_completion", { runId });
  }
};

export const requestLocalRuntimeStatus = async (targetModel?: string): Promise<LocalRuntimeStatus> => {
  if (hasCommandHost()) {
    return (await invoke("local_runtime_status", { targetModel })) as LocalRuntimeStatus;
  }
  throw new Error("Local runtime diagnostics are available only through the local bridge.");
};

export const requestComputeLocalPassiveDiagnostics = async (): Promise<ComputePassiveDiagnosticsResult> => {
  if (hasCommandHost()) {
    return (await invoke("compute_local_passive_diagnostics")) as ComputePassiveDiagnosticsResult;
  }
  const platform = typeof navigator === "undefined" ? "web-preview" : navigator.platform || "web-preview";
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return {
    nodeId: "compute-local-node",
    os: platform.toLowerCase().includes("mac") ? "macos" : platform.toLowerCase().includes("win") ? "windows" : "web-preview",
    arch: userAgent.includes("arm64") || userAgent.includes("aarch64") ? "aarch64" : "unknown",
    family: "web-preview",
    executableSuffix: "",
    checkedAt: "web-preview",
    summary: "Web preview can only report browser platform hints. Local diagnostics are exposed through the alpha bridge.",
  };
};

export const requestComputeLocalSafeCommand = async (
  request: ComputeSafeCommandRequest,
): Promise<ComputeSafeCommandResult> => {
  if (hasCommandHost()) {
    return (await invoke("compute_local_safe_command", { request })) as ComputeSafeCommandResult;
  }
  throw new Error("Compute safe commands are available only through the local bridge.");
};

export const requestComputeRemoteProbe = async (
  request: ComputeRemoteProbeRequest,
): Promise<ComputeRemoteProbeResult> => {
  if (hasCommandHost()) {
    return (await invoke("compute_remote_probe", { request })) as ComputeRemoteProbeResult;
  }
  throw new Error("Remote compute probes are available only through the local bridge.");
};

export const requestGx10LlamaStatus = async (): Promise<Gx10LlamaStatusResult> => {
  if (hasCommandHost()) {
    return (await invoke("compute_gx10_llama_status")) as Gx10LlamaStatusResult;
  }
  throw new Error("GX10 llama status is available only through the local bridge.");
};

export const requestGx10LlamaSwitch = async (
  request: Gx10LlamaSwitchRequest,
): Promise<Gx10LlamaSwitchResult> => {
  if (hasCommandHost()) {
    return (await invoke("compute_gx10_llama_switch", { request })) as Gx10LlamaSwitchResult;
  }
  throw new Error("GX10 llama model switching is available only through the local bridge.");
};

export const requestNasBackupStatus = async (): Promise<NasBackupStatusResult> => {
  if (hasCommandHost()) {
    return (await invoke("compute_nas_backup_status")) as NasBackupStatusResult;
  }
  throw new Error("NAS backup status is available only through the local bridge.");
};

export const requestEngineerRecoveryTurn = async (input: {
  providerId: string;
  providerType: ProviderProfile["providerType"];
  apiBaseUrl?: string;
  runtimeNodeId?: string;
  runtimeNodeKind?: string;
  model: string;
  systemPrompt: string;
  messages: ConversationMessage[];
  runtimeNodeEndpoint?: string;
  authTier?: string;
}): Promise<EngineerRecoveryTurnResult> => {
  if (hasCommandHost()) {
    return (await invoke("engineer_recovery_turn", input)) as EngineerRecoveryTurnResult;
  }
  throw new Error("Engineer recovery tooling is available only through the local bridge.");
};

export const requestRecoveryRouteCandidates = async (): Promise<RecoveryRouteCandidate[]> => {
  if (hasCommandHost()) {
    return (await invoke("recovery_route_candidates")) as RecoveryRouteCandidate[];
  }
  throw new Error("Recovery route probing is available only through the local bridge.");
};

export const requestHermesStatus = async (input: {
  profileHome?: string;
  executable?: boolean;
} = {}): Promise<HermesInstallStatus> => {
  if (hasCommandHost()) {
    return (await invoke("hermes_status", {
      request: {
        profileHome: input.profileHome,
        executable: input.executable,
      },
    })) as HermesInstallStatus;
  }
  throw new Error("Hermes compatibility audit is available only through the local bridge.");
};

export const requestHermesInstall = async (input: {
  profileHome?: string;
  branch?: string;
} = {}): Promise<HermesInstallResult> => {
  if (hasCommandHost()) {
    return (await invoke("hermes_install", {
      request: {
        profileHome: input.profileHome,
        branch: input.branch,
      },
    })) as HermesInstallResult;
  }
  throw new Error("Hermes installation is available only through the local bridge.");
};

export const requestHermesWorkspaceSnapshot = async (profileHome?: string): Promise<HermesWorkspaceSnapshot> => {
  if (hasCommandHost()) {
    return (await invoke("hermes_workspace_snapshot", { profileHome })) as HermesWorkspaceSnapshot;
  }
  throw new Error("Hermes workspace snapshot is available only through the local bridge.");
};

export const requestHermesDashboardStart = async (input: {
  profileHome?: string;
  host?: string;
  port?: number;
  includeTui?: boolean;
}): Promise<HermesDashboardStatus> => {
  if (hasCommandHost()) {
    return (await invoke("hermes_dashboard_start", {
      request: {
        profileHome: input.profileHome,
        host: input.host,
        port: input.port,
        includeTui: input.includeTui,
      },
    })) as HermesDashboardStatus;
  }
  throw new Error("Hermes dashboard launch is available only through the local bridge.");
};

export const requestHermesDashboardStop = async (profileHome?: string): Promise<HermesDashboardStatus> => {
  if (hasCommandHost()) {
    return (await invoke("hermes_dashboard_stop", { profileHome })) as HermesDashboardStatus;
  }
  throw new Error("Hermes dashboard stop is available only through the local bridge.");
};

export const requestHermesChatCompletion = async (input: {
  prompt: string;
  profileHome?: string;
  model?: string;
}): Promise<HermesChatResult> => {
  if (hasCommandHost()) {
    return (await invoke("hermes_chat", {
      request: {
        prompt: input.prompt,
        profileHome: input.profileHome,
        model: input.model,
      },
    })) as HermesChatResult;
  }
  throw new Error("Hermes chat bridge is available only through the local bridge.");
};

export const requestArchiveIngestProbe = async (input: {
  providerId: string;
  providerType: ProviderProfile["providerType"];
  apiBaseUrl?: string;
  runtimeNodeId?: string;
  runtimeNodeKind?: string;
  runtimeNodeEndpoint?: string;
  authTier?: string;
  model: string;
  sourceLabel: string;
  sourceExcerpt: string;
}): Promise<ArchiveIngestProbeResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_ingest_probe", input)) as ArchiveIngestProbeResult;
  }
  throw new Error("Archive ingest probing is available only through the local bridge.");
};

export const requestArchiveRuntimeStatus = async (): Promise<ArchiveRuntimeStatus> => {
  if (hasCommandHost()) {
    return (await invoke("archive_runtime_status")) as ArchiveRuntimeStatus;
  }
  throw new Error("Living Archive runtime status is available only through the local bridge.");
};

export const requestLivingArchiveMemoryServiceStatus = async (input: {
  port?: number;
  sessionId?: string;
} = {}): Promise<LivingArchiveMemoryServiceStatus> => {
  if (hasCommandHost()) {
    return (await invoke("living_archive_memory_service_status", { request: input })) as LivingArchiveMemoryServiceStatus;
  }
  return {
    available: false,
    running: false,
    endpoint: `http://127.0.0.1:${input.port ?? 4888}`,
    memoryRoot: "",
    sessionId: input.sessionId ?? "living-archive-memory-service",
    readonly: false,
    pid: null,
    command: "node examples/living-archive-memory-service.mjs",
    statusDetail: "Living Archive memory service controls are available only through the local bridge.",
  };
};

export const requestLivingArchiveMemoryServiceStart = async (input: {
  port?: number;
  sessionId?: string;
  readonly?: boolean;
} = {}): Promise<LivingArchiveMemoryServiceResult> => {
  if (hasCommandHost()) {
    return (await invoke("living_archive_memory_service_start", { request: input })) as LivingArchiveMemoryServiceResult;
  }
  throw new Error("Living Archive memory service launch is available only through the local bridge.");
};

export const requestLivingArchiveMemoryServiceStop = async (
  sessionId?: string,
): Promise<LivingArchiveMemoryServiceResult> => {
  if (hasCommandHost()) {
    return (await invoke("living_archive_memory_service_stop", { request: { sessionId } })) as LivingArchiveMemoryServiceResult;
  }
  throw new Error("Living Archive memory service shutdown is available only through the local bridge.");
};

export const requestArchiveSourceFolderScan = async (rootPath?: string): Promise<ArchiveSourceFolderScanResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_scan_source_folders", { request: { rootPath } })) as ArchiveSourceFolderScanResult;
  }
  throw new Error("Living Archive source folder scanning is available only through the local bridge.");
};

export const requestArchiveLibraryImport = async (input: {
  sourcePath: string;
  domain: ArchiveMemoryDomain;
  importMode: ArchiveLibraryImportMode;
  libraryName?: string;
  actorId: string;
  excludedTopFolders?: string[];
}): Promise<ArchiveLibraryImportResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_import_library", { request: input })) as ArchiveLibraryImportResult;
  }
  throw new Error("Living Archive library import is available only through the local bridge.");
};

export const requestArchiveLibraryPreflight = async (sourcePath: string): Promise<ArchiveLibraryPreflightResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_preflight_library_import", { request: { sourcePath } })) as ArchiveLibraryPreflightResult;
  }
  throw new Error("Living Archive library preflight is available only through the local bridge.");
};

export const requestArchiveImportedLibraries = async (): Promise<ArchiveImportedLibrarySummary[]> => {
  if (hasCommandHost()) {
    return (await invoke("archive_imported_libraries")) as ArchiveImportedLibrarySummary[];
  }
  throw new Error("Living Archive imported library registry is available only through the local bridge.");
};

export const requestArchiveLibraryClassificationReview = async (
  classificationManifestPath: string,
): Promise<ArchiveLibraryClassificationReview> => {
  if (hasCommandHost()) {
    return (await invoke("archive_library_classification_review", {
      request: { classificationManifestPath },
    })) as ArchiveLibraryClassificationReview;
  }
  throw new Error("Living Archive classification review is available only through the local bridge.");
};

export const requestArchiveLibraryReorganisationPlan = async (
  classificationManifestPath: string,
  actorId: string,
): Promise<ArchiveLibraryReorganisationPlan> => {
  if (hasCommandHost()) {
    return (await invoke("archive_library_reorganisation_plan", {
      request: { classificationManifestPath, actorId },
    })) as ArchiveLibraryReorganisationPlan;
  }
  throw new Error("Living Archive reorganisation planning is available only through the local bridge.");
};

export const requestArchiveQueueImportedLibraryIngest = async (input: {
  manifestPath: string;
  actorId?: string;
  maxRecords?: number;
}): Promise<ArchiveQueueImportedLibraryResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_queue_imported_library_ingest", { request: input })) as ArchiveQueueImportedLibraryResult;
  }
  throw new Error("Living Archive imported-library ingest queueing is available only through the local bridge.");
};

export const requestArchiveSystemMemory = async (): Promise<ArchiveSystemMemoryStatus> => {
  if (hasCommandHost()) {
    return (await invoke("archive_system_memory")) as ArchiveSystemMemoryStatus;
  }
  throw new Error("ResonantOS system memory status is available only through the local bridge.");
};

export const requestArchiveSystemMemoryRefresh = async (): Promise<ArchiveSystemMemoryRefreshResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_refresh_system_memory")) as ArchiveSystemMemoryRefreshResult;
  }
  throw new Error("ResonantOS system memory refresh is available only through the local bridge.");
};

export const requestArchiveLibraryFolderSelection = async (): Promise<string | null> => {
  if (hasCommandHost()) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose a folder or Obsidian vault for Living Archive import",
    });
    return typeof selected === "string" ? selected : null;
  }
  throw new Error("Folder selection is available only through the local bridge.");
};

export const requestObsidianVaultFolderSelection = async (): Promise<string | null> => {
  if (hasCommandHost()) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose an Obsidian vault or markdown folder",
    });
    return typeof selected === "string" ? selected : null;
  }
  throw new Error("Vault selection is available only through the local bridge.");
};

export const requestObsidianVaultStatus = async (vaultPath: string): Promise<ObsidianVaultStatus> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_vault_status", { request: { vaultPath } })) as ObsidianVaultStatus;
  }
  throw new Error("Obsidian vault status is available only through the local bridge.");
};

export const requestObsidianNoteList = async (vaultPath: string, limit = 200): Promise<ObsidianNoteSummary[]> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_list_notes", { request: { vaultPath, limit } })) as ObsidianNoteSummary[];
  }
  throw new Error("Obsidian note listing is available only through the local bridge.");
};

export const requestObsidianNote = async (vaultPath: string, notePath: string): Promise<ObsidianNotePayload> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_read_note", { request: { vaultPath, notePath } })) as ObsidianNotePayload;
  }
  throw new Error("Obsidian note reads are available only through the local bridge.");
};

export const requestObsidianOpenNote = async (vaultPath: string, notePath: string): Promise<ObsidianOpenNoteResult> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_open_note", { request: { vaultPath, notePath } })) as ObsidianOpenNoteResult;
  }
  throw new Error("Opening Obsidian notes is available only through the local bridge.");
};

export const requestObsidianWriteNote = async (input: {
  vaultPath: string;
  notePath: string;
  content: string;
  expectedModifiedAt?: string;
  actorId?: string;
}): Promise<ObsidianWriteNoteResult> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_write_note", { request: input })) as ObsidianWriteNoteResult;
  }
  throw new Error("Obsidian note writes are available only through the local bridge.");
};

export const requestObsidianCreateNote = async (input: {
  vaultPath: string;
  notePath: string;
  content?: string;
  actorId?: string;
}): Promise<ObsidianNoteOperationResult> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_create_note", { request: input })) as ObsidianNoteOperationResult;
  }
  throw new Error("Obsidian note creation is available only through the local bridge.");
};

export const requestObsidianCreateFolder = async (input: {
  vaultPath: string;
  folderPath: string;
  actorId?: string;
}): Promise<ObsidianNoteOperationResult> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_create_folder", { request: input })) as ObsidianNoteOperationResult;
  }
  throw new Error("Obsidian folder creation is available only through the local bridge.");
};

export const requestObsidianMoveNote = async (input: {
  vaultPath: string;
  fromNotePath: string;
  toNotePath: string;
  expectedModifiedAt?: string;
  actorId?: string;
}): Promise<ObsidianNoteOperationResult> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_move_note", { request: input })) as ObsidianNoteOperationResult;
  }
  throw new Error("Obsidian note moves are available only through the local bridge.");
};

export const requestObsidianArchiveNote = async (input: {
  vaultPath: string;
  notePath: string;
  expectedModifiedAt?: string;
  actorId?: string;
}): Promise<ObsidianNoteOperationResult> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_archive_note", { request: input })) as ObsidianNoteOperationResult;
  }
  throw new Error("Obsidian note archiving is available only through the local bridge.");
};

export const requestObsidianVaultIndex = async (vaultPath: string, query = "", limit = 200): Promise<ObsidianVaultIndex> => {
  if (hasCommandHost()) {
    return (await invoke("obsidian_vault_index", { request: { vaultPath, query, limit } })) as ObsidianVaultIndex;
  }
  throw new Error("Obsidian vault indexing is available only through the local bridge.");
};

export const requestOpenCodeWorkspaceFolderSelection = async (): Promise<string | null> => {
  if (hasCommandHost()) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose a scoped OpenCode workspace folder",
    });
    return typeof selected === "string" ? selected : null;
  }
  throw new Error("OpenCode workspace selection is available only through the local bridge.");
};

export const requestOpenCodeStatus = async (): Promise<OpenCodeStatus> => {
  if (hasCommandHost()) {
    return (await invoke("opencode_status")) as OpenCodeStatus;
  }
  return {
    installed: false,
    installHint: "OpenCode status is available only through the local bridge.",
    supportsWebUi: true,
    supportsServerApi: true,
  };
};

export const requestOpenCodeStartService = async (input: {
  workspacePath: string;
  port?: number;
  mode?: OpenCodeLaunchMode;
  sessionId?: string;
}): Promise<OpenCodeServiceResult> => {
  if (hasCommandHost()) {
    return (await invoke("opencode_start_service", { request: input })) as OpenCodeServiceResult;
  }
  throw new Error("OpenCode service launch is available only through the local bridge.");
};

export const requestOpenCodeStopService = async (sessionId?: string): Promise<OpenCodeServiceResult> => {
  if (hasCommandHost()) {
    return (await invoke("opencode_stop_service", { request: { sessionId } })) as OpenCodeServiceResult;
  }
  throw new Error("OpenCode service shutdown is available only through the local bridge.");
};

export const requestOpenCodeTrustEventRecord = async (input: {
  sessionId?: string;
  eventType: "user_message" | "assistant_message" | "tool_call" | "artifact_written" | "agent_end" | "verification_report";
  content?: string;
  command?: string;
  tool?: string;
  path?: string;
  returncode?: number;
  metadata?: Record<string, unknown>;
}): Promise<TrustKernelAdvisory> => {
  if (hasCommandHost()) {
    return (await invoke("opencode_record_trust_event", { request: input })) as TrustKernelAdvisory;
  }
  throw new Error("OpenCode Trust Kernel event recording is available only through the local bridge.");
};

export const requestOpenCodeInjectPrompt = async (input: {
  sessionId?: string;
  prompt: string;
  clearExisting?: boolean;
  submit?: boolean;
}): Promise<OpenCodeInjectPromptResult> => {
  if (hasCommandHost()) {
    return (await invoke("opencode_inject_prompt", { request: input })) as OpenCodeInjectPromptResult;
  }
  throw new Error("OpenCode prompt injection is available only through the local bridge.");
};

export const requestPaperclipStatus = async (endpoint?: string): Promise<PaperclipStatus> => {
  const normalizedEndpoint = endpoint?.trim() || "http://127.0.0.1:3100";
  if (hasCommandHost()) {
    return (await invoke("paperclip_status", { request: { endpoint: normalizedEndpoint } })) as PaperclipStatus;
  }
  return {
    installed: false,
    version: null,
    binaryPath: null,
    endpoint: normalizedEndpoint,
    endpointReachable: false,
    installHint: "Paperclip status is available only through the local bridge.",
    supportsWebUi: true,
    supportsServerApi: true,
    managedLaunchAvailable: false,
  };
};

export const requestPaperclipStartService = async (input: {
  endpoint?: string;
  sessionId?: string;
}): Promise<PaperclipServiceResult> => {
  if (hasCommandHost()) {
    return (await invoke("paperclip_start_service", { request: input })) as PaperclipServiceResult;
  }
  throw new Error("Paperclip connection is available only through the local bridge.");
};

export const requestPaperclipStopService = async (sessionId?: string): Promise<PaperclipServiceResult> => {
  if (hasCommandHost()) {
    return (await invoke("paperclip_stop_service", { request: { sessionId } })) as PaperclipServiceResult;
  }
  throw new Error("Paperclip disconnect is available only through the local bridge.");
};

export const requestPaperclipDashboardSnapshot = async (input: {
  endpoint?: string;
  apiToken: string;
  companyId?: string;
}): Promise<PaperclipDashboardSnapshot> => {
  if (hasCommandHost()) {
    return (await invoke("paperclip_dashboard_snapshot", { request: input })) as PaperclipDashboardSnapshot;
  }
  throw new Error("Paperclip API snapshots are available only through the local bridge.");
};

export const requestPaperclipCreateIssueFromDelegation = async (input: {
  endpoint?: string;
  apiToken: string;
  companyId: string;
  title: string;
  description: string;
  priority?: "low" | "medium" | "high" | "urgent";
  assigneeAgentId?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
}): Promise<PaperclipCreateIssueResult> => {
  if (hasCommandHost()) {
    return (await invoke("paperclip_create_issue_from_delegation", { request: input })) as PaperclipCreateIssueResult;
  }
  throw new Error("Paperclip issue creation is available only through the local bridge.");
};

export const requestBrowserOpenUrl = async (url: string, viewport?: BrowserViewportInput): Promise<BrowserOpenUrlResult> => {
  if (hasCommandHost()) {
    return (await invoke("browser_open_url", { request: { url, ...viewport } })) as BrowserOpenUrlResult;
  }
  throw new Error("Chromium Browser engine is available only through the local bridge.");
};

export const requestBrowserEngineStatus = async (): Promise<BrowserEngineStatus> => {
  if (hasCommandHost()) {
    return (await invoke("browser_engine_status")) as BrowserEngineStatus;
  }
  throw new Error("Chromium Browser engine status is available only through the local bridge.");
};

export const requestBrowserInstallEngine = async (): Promise<BrowserEngineInstallResult> => {
  if (hasCommandHost()) {
    return (await invoke("browser_install_engine")) as BrowserEngineInstallResult;
  }
  throw new Error("Chromium Browser engine install is available only through the local bridge.");
};

export const requestBrowserStartSession = async (url: string, viewport?: BrowserViewportInput): Promise<BrowserOpenUrlResult> => {
  if (hasCommandHost()) {
    return (await invoke("browser_start_session", { request: { url, ...viewport } })) as BrowserOpenUrlResult;
  }
  throw new Error("Chromium Browser engine is available only through the local bridge.");
};

export const openLiveBrowserWebview = async (url: string, bounds: BrowserLiveWebviewBounds): Promise<void> => {
  assertBrowserHttpUrl(url);
  void bounds;
  throw new Error("Live Browser webviews are not part of the browser-first Chrome extension alpha.");
};

export const resizeLiveBrowserWebview = async (_bounds: BrowserLiveWebviewBounds): Promise<void> => {
  return;
};

export const hideLiveBrowserWebview = async (): Promise<void> => {
  return;
};

export const requestBrowserSessionOpenUrl = async (sessionId: string, url: string, viewport?: BrowserViewportInput): Promise<BrowserOpenUrlResult> => {
  if (hasCommandHost()) {
    return (await invoke("browser_session_open_url", { request: { sessionId, url, ...viewport } })) as BrowserOpenUrlResult;
  }
  throw new Error("Chromium Browser engine is available only through the local bridge.");
};

export const requestBrowserSessionScreenshot = async (sessionId: string, viewport?: BrowserViewportInput): Promise<BrowserOpenUrlResult> => {
  if (hasCommandHost()) {
    return (await invoke("browser_session_screenshot", { request: { sessionId, ...viewport } })) as BrowserOpenUrlResult;
  }
  throw new Error("Chromium Browser engine is available only through the local bridge.");
};

export const requestBrowserSessionReadPage = async (sessionId: string): Promise<BrowserReadPageResult> => {
  if (hasCommandHost()) {
    return (await invoke("browser_session_read_page", { request: { sessionId } })) as BrowserReadPageResult;
  }
  throw new Error("Chromium Browser engine is available only through the local bridge.");
};

export const requestBrowserSessionClick = async (
  sessionId: string,
  x: number,
  y: number,
  viewport?: BrowserViewportInput,
): Promise<BrowserInteractionResult> => {
  if (hasCommandHost()) {
    return (await invoke("browser_session_click", { request: { sessionId, x, y, ...viewport } })) as BrowserInteractionResult;
  }
  throw new Error("Chromium Browser click control is available only through the local bridge.");
};

export const requestBrowserSessionScroll = async (
  sessionId: string,
  deltaX: number,
  deltaY: number,
  viewport?: BrowserViewportInput,
): Promise<BrowserInteractionResult> => {
  if (hasCommandHost()) {
    return (await invoke("browser_session_scroll", { request: { sessionId, deltaX, deltaY, ...viewport } })) as BrowserInteractionResult;
  }
  throw new Error("Chromium Browser scroll control is available only through the local bridge.");
};

export const requestBrowserCloseSession = async (sessionId: string): Promise<BrowserCloseSessionResult> => {
  if (hasCommandHost()) {
    return (await invoke("browser_close_session", { request: { sessionId } })) as BrowserCloseSessionResult;
  }
  throw new Error("Chromium Browser engine is available only through the local bridge.");
};

const browserCommandTypeToMethod = (type: BrowserToolCommand["type"]): string =>
  type === "start"
    ? "browser.start"
    : type === "open_url"
      ? "browser.open_url"
      : type === "read_page"
        ? "browser.read_page"
        : type === "click"
          ? "browser.click"
          : type === "type"
            ? "browser.type"
            : type === "capture_evidence"
              ? "browser.capture_evidence"
              : type === "close"
                ? "browser.close_session"
                : type === "extensions_list"
                  ? "browser.extensions.list"
                  : type === "extensions_set_pinned"
                    ? "browser.extensions.set_pinned"
                    : type === "extensions_disable"
                      ? "browser.extensions.disable"
                      : type === "wallet_host_health"
                        ? "browser.wallet_host.health"
                        : type === "wallet_host_start"
                          ? "browser.wallet_host.start"
                          : type === "wallet_host_open_url"
                            ? "browser.wallet_host.open_url"
                            : type === "wallet_host_read_page"
                              ? "browser.wallet_host.read_page"
                              : type === "wallet_host_inspect_dapp_gate"
                                ? "browser.wallet_host.inspect_dapp_gate"
                                : type === "wallet_host_list_tabs"
                                  ? "browser.wallet_host.list_tabs"
                                  : "browser.health";

export const requestBrowserHostCommand = async (command: BrowserToolCommand): Promise<BrowserToolResult> => {
  if (hasCommandHost()) {
    const { type, params, humanApproved } = command;
    const method = browserCommandTypeToMethod(type);
    return (await invoke("browser_host_command", {
      request: { method, params: params ?? {}, humanApproved: Boolean(humanApproved) },
    })) as BrowserToolResult;
  }
  throw new Error("Governed Browser host commands are available only through the local bridge.");
};

export const requestBrowserVisibleHostCommand = async (command: BrowserToolCommand): Promise<BrowserToolResult> => {
  if (hasCommandHost()) {
    const { type, params, humanApproved } = command;
    const method = browserCommandTypeToMethod(type);
    return hostInvoke<BrowserToolResult>("browser_visible_host_command", {
      request: { method, params: params ?? {}, humanApproved: Boolean(humanApproved) },
    });
  }
  if (hasCommandHost()) {
    const { type, params, humanApproved } = command;
    const method = browserCommandTypeToMethod(type);
    return (await invoke("browser_visible_host_command", {
      request: { method, params: params ?? {}, humanApproved: Boolean(humanApproved) },
    })) as BrowserToolResult;
  }
  throw new Error("Visible Browser v2 host commands are available only through the local bridge.");
};

export const requestArchiveSearch = async (query: string, limit = 12): Promise<ArchiveSearchResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_search", { request: { query, limit } })) as ArchiveSearchResult;
  }
  throw new Error("Living Archive search is available only through the local bridge.");
};

export const requestArchiveDocument = async (path: string): Promise<ArchiveDocumentPayload> => {
  if (hasCommandHost()) {
    return (await invoke("archive_read_document", { request: { path } })) as ArchiveDocumentPayload;
  }
  throw new Error("Living Archive document reads are available only through the local bridge.");
};

export const requestArchiveIntakeWrite = async (input: {
  actorId: string;
  bucket: string;
  fileName: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<ArchiveIntakeWriteResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_write_intake_artifact", { request: input })) as ArchiveIntakeWriteResult;
  }
  throw new Error("Living Archive intake writes are available only through the local bridge.");
};

export const requestArchiveIngestRequest = async (input: {
  actorId: string;
  sourcePath: string;
  sourceType: string;
  sourceRole?: string;
  intent: string;
  provenance?: Record<string, unknown>;
}): Promise<ArchiveIngestRequestResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_request_ingest", { request: input })) as ArchiveIngestRequestResult;
  }
  throw new Error("Living Archive ingest requests are available only through the local bridge.");
};

export const requestArchiveReviewQueue = async (): Promise<ArchiveQueuedIngestRequest[]> => {
  if (hasCommandHost()) {
    return (await invoke("archive_review_queue")) as ArchiveQueuedIngestRequest[];
  }
  throw new Error("Living Archive review queue is available only through the local bridge.");
};

export const requestArchiveReviewArtifacts = async (): Promise<ArchiveReviewArtifact[]> => {
  if (hasCommandHost()) {
    return (await invoke("archive_review_artifacts")) as ArchiveReviewArtifact[];
  }
  throw new Error("Living Archive review artifacts are available only through the local bridge.");
};

export const requestArchiveProcessIngestRequest = async (input: {
  requestFile: string;
  providerId: string;
  providerType: ProviderProfile["providerType"];
  apiBaseUrl?: string;
  runtimeNodeId?: string;
  runtimeNodeKind?: string;
  runtimeNodeEndpoint?: string;
  authTier?: string;
  model: string;
  verifierProviderId?: string;
  verifierProviderType?: ProviderProfile["providerType"];
  verifierApiBaseUrl?: string;
  verifierRuntimeNodeId?: string;
  verifierRuntimeNodeKind?: string;
  verifierRuntimeNodeEndpoint?: string;
  verifierAuthTier?: string;
  verifierModel?: string;
}): Promise<ArchiveProcessIngestResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_process_ingest_request", { request: input })) as ArchiveProcessIngestResult;
  }
  throw new Error("Living Archive ingest processing is available only through the local bridge.");
};

export const requestArchiveMaintenanceCycle = async (input: {
  providerId: string;
  providerType: ProviderProfile["providerType"];
  apiBaseUrl?: string;
  runtimeNodeId?: string;
  runtimeNodeKind?: string;
  runtimeNodeEndpoint?: string;
  authTier?: string;
  model: string;
  verifierProviderId?: string;
  verifierProviderType?: ProviderProfile["providerType"];
  verifierApiBaseUrl?: string;
  verifierRuntimeNodeId?: string;
  verifierRuntimeNodeKind?: string;
  verifierRuntimeNodeEndpoint?: string;
  verifierAuthTier?: string;
  verifierModel?: string;
  maxRequests?: number;
  autoPromote?: boolean;
  actorId?: string;
}): Promise<ArchiveMaintenanceCycleResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_maintenance_cycle", { request: input })) as ArchiveMaintenanceCycleResult;
  }
  throw new Error("Living Archive maintenance cycles are available only through the local bridge.");
};

export const requestArchiveAiMemoryBuildJob = async (input: {
  manifestPath: string;
  actorId?: string;
  maxQueueRecords?: number;
  maintenance: {
    providerId: string;
    providerType: ProviderProfile["providerType"];
    apiBaseUrl?: string;
    runtimeNodeId?: string;
    runtimeNodeKind?: string;
    runtimeNodeEndpoint?: string;
    authTier?: string;
    model: string;
    verifierProviderId?: string;
    verifierProviderType?: ProviderProfile["providerType"];
    verifierApiBaseUrl?: string;
    verifierRuntimeNodeId?: string;
    verifierRuntimeNodeKind?: string;
    verifierRuntimeNodeEndpoint?: string;
    verifierAuthTier?: string;
    verifierModel?: string;
    maxRequests?: number;
    autoPromote?: boolean;
    actorId?: string;
  };
}): Promise<ArchiveAiMemoryBuildResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_ai_memory_build_job", { request: input })) as ArchiveAiMemoryBuildResult;
  }
  throw new Error("Living Archive AI Memory build jobs are available only through the local bridge.");
};

export const requestArchiveAiMemoryBuildJobs = async (): Promise<ArchiveAiMemoryBuildJobSummary[]> => {
  if (hasCommandHost()) {
    return (await invoke("archive_ai_memory_build_jobs")) as ArchiveAiMemoryBuildJobSummary[];
  }
  return [];
};

export const requestArchiveBackgroundCycle = async (input: {
  providerId: string;
  providerType: ProviderProfile["providerType"];
  apiBaseUrl?: string;
  runtimeNodeId?: string;
  runtimeNodeKind?: string;
  runtimeNodeEndpoint?: string;
  authTier?: string;
  model: string;
  verifierProviderId?: string;
  verifierProviderType?: ProviderProfile["providerType"];
  verifierApiBaseUrl?: string;
  verifierRuntimeNodeId?: string;
  verifierRuntimeNodeKind?: string;
  verifierRuntimeNodeEndpoint?: string;
  verifierAuthTier?: string;
  verifierModel?: string;
  maxRequests?: number;
  autoPromote?: boolean;
  actorId?: string;
  rootPath?: string;
}): Promise<ArchiveBackgroundCycleResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_background_cycle", { request: input })) as ArchiveBackgroundCycleResult;
  }
  throw new Error("Living Archive background cycles are available only through the local bridge.");
};

export const requestArchiveWikiNavigationRefresh = async (): Promise<ArchiveWikiNavigationRefreshResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_refresh_wiki_navigation")) as ArchiveWikiNavigationRefreshResult;
  }
  throw new Error("Living Archive wiki navigation refresh is available only through the local bridge.");
};

export const requestArchiveLint = async (): Promise<ArchiveLintResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_lint")) as ArchiveLintResult;
  }
  throw new Error("Living Archive lint is available only through the local bridge.");
};

export const requestArchiveSemanticLint = async (input: {
  providerId: string;
  providerType: ProviderProfile["providerType"];
  apiBaseUrl?: string;
  runtimeNodeId?: string;
  runtimeNodeKind?: string;
  runtimeNodeEndpoint?: string;
  authTier?: string;
  model: string;
  maxCandidates?: number;
}): Promise<ArchiveSemanticLintResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_semantic_lint", { request: input })) as ArchiveSemanticLintResult;
  }
  throw new Error("Living Archive semantic lint is available only through the local bridge.");
};

export const requestArchiveReviewDecision = async (input: {
  artifactFile: string;
  actorId: string;
  action: "approve" | "reject" | "escalate";
  notes?: string;
}): Promise<ArchiveReviewDecisionResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_review_decision", { request: input })) as ArchiveReviewDecisionResult;
  }
  throw new Error("Living Archive review decisions are available only through the local bridge.");
};

export const requestArchivePromoteReviewArtifact = async (input: {
  artifactFile: string;
  actorId: string;
}): Promise<ArchivePromoteReviewArtifactResult> => {
  if (hasCommandHost()) {
    return (await invoke("archive_promote_review_artifact", { request: input })) as ArchivePromoteReviewArtifactResult;
  }
  throw new Error("Trusted Living Archive promotion is available only through the local bridge.");
};

export const requestProviderDiagnostics = async (providerId?: string): Promise<ProviderDiagnosticReport[]> => {
  return (await invoke("provider_diagnostics", { providerId })) as ProviderDiagnosticReport[];
};

export const requestProviderRequestAudit = async (limit = 80): Promise<ProviderRequestAuditRecord[]> => {
  if (hasCommandHost()) {
    return (await invoke("provider_request_audit", { limit })) as ProviderRequestAuditRecord[];
  }
  return [];
};

export const requestProviderSmokeTest = async (input: {
  providerId: string;
  providerType: ProviderProfile["providerType"];
  apiBaseUrl?: string;
  runtimeNodeId?: string;
  runtimeNodeKind?: string;
  runtimeNodeEndpoint?: string;
  authTier?: string;
  model: string;
}): Promise<ProviderSmokeTestResult> => {
  const checkedAt = new Date().toISOString();
  const reply = await requestProviderServiceChatCompletion({
    requestId: `provider-smoke:${input.providerId}:${Date.now()}`,
    threadId: "settings-provider-smoke",
    agentId: "settings.provider-smoke",
    channelId: "settings",
    providerId: input.providerId,
    providerType: input.providerType,
    apiBaseUrl: input.apiBaseUrl,
    runtimeNodeId: input.runtimeNodeId,
    runtimeNodeKind: input.runtimeNodeKind,
    runtimeNodeEndpoint: input.runtimeNodeEndpoint,
    authTier: input.authTier,
    model: input.model,
    reasoningEffort: "minimal",
    systemPrompt: "You are a provider smoke test. Reply briefly and do not ask follow-up questions.",
    messages: [
      {
        id: `provider-smoke:${input.providerId}:user`,
        threadId: "settings-provider-smoke",
        channelId: "settings",
        role: "user",
        author: "Settings",
        content: "Reply with one short sentence confirming this provider can answer.",
        createdAt: checkedAt,
      },
    ],
  });
  return {
    providerId: input.providerId,
    model: input.model,
    ok: true,
    replyPreview: reply.slice(0, 500),
    checkedAt,
    summary: `Provider smoke test succeeded for ${input.model}.`,
  };
};

export const requestProviderSetupProbe = async (input: {
  providerId: string;
  providerType: ProviderProfile["providerType"];
  apiBaseUrl?: string;
  runtimeNodeKind?: string;
  runtimeNodeEndpoint?: string;
  authTier?: string;
}): Promise<ProviderSetupProbeResult> => {
  if (hasCommandHost()) {
    const endpoint = input.runtimeNodeEndpoint ?? input.apiBaseUrl ?? "";
    return {
      providerId: input.providerId,
      ok: false,
      setupState: "adapter-pending",
      discoveredModels: [],
      endpoint,
      checkedAt: new Date().toISOString(),
      summary: "Provider setup probing is not exposed in the extension preview. Use Check Health or Test to verify this provider.",
      detail: "The alpha bridge supports provider diagnostics and smoke tests; setup probing remains a future bridge route.",
      source: "unsupported-adapter",
    };
  }
  if (hasCommandHost()) {
    return (await invoke("provider_setup_probe", input)) as ProviderSetupProbeResult;
  }
  throw new Error("Provider setup probes are available only through the local bridge.");
};

const readPersistedState = async (): Promise<ResonantShellState | null> => {
  if (hasCommandHost()) {
    return (await hostInvoke<ResonantShellState | null>("load_runtime_state")) ?? null;
  }
  if (hasCommandHost()) {
    return ((await invoke("load_runtime_state")) as ResonantShellState | null) ?? null;
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as ResonantShellState;
};

export const persistState = async (state: ResonantShellState): Promise<void> => {
  // The extension preview stores UI state locally. Security-sensitive bridge
  // state, provider secrets, and capability grants are not written from here.
  if (hasCommandHost()) {
    await hostInvoke("save_runtime_state", { state });
    return;
  }
  if (hasCommandHost()) {
    await invoke("save_runtime_state", { state });
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

export const openFloatingChatWindow = async (): Promise<void> => {
  throw new Error("Floating chat windows are not part of the browser-first Chrome extension alpha.");
};

export const subscribeRuntimeStateUpdates = async (
  onState: (state: ResonantShellState) => void,
): Promise<() => void> => {
  if (!hasCommandHost()) {
    return () => undefined;
  }
  return listen<ResonantShellState>("runtime-state-updated", (event) => onState(event.payload));
};

export const requestCreateTaskWorkspace = async (packet: DelegationPacket): Promise<TaskWorkspace> => {
  const validation = validateDelegationPacket(packet);
  if (!validation.valid) {
    const errors = validation.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.code}: ${issue.message}`)
      .join("; ");
    throw new Error(`Delegation packet is invalid: ${errors}`);
  }
  const taskMarkdown = renderDelegationTaskMarkdown(packet);
  if (hasCommandHost()) {
    return (await invoke("delegation_create_task_workspace", {
      request: {
        packet,
        taskMarkdown,
      },
    })) as TaskWorkspace;
  }
  throw new Error("Task workspace creation is available only through the local bridge.");
};

export const requestListTaskWorkspaces = async (): Promise<TaskWorkspace[]> => {
  if (hasCommandHost()) {
    return (await invoke("delegation_list_task_workspaces")) as TaskWorkspace[];
  }
  throw new Error("Task workspace listing is available only through the local bridge.");
};

export const requestReadTaskWorkspace = async (workspaceId: string): Promise<TaskWorkspacePayload> => {
  if (hasCommandHost()) {
    return (await invoke("delegation_read_task_workspace", {
      request: {
        workspaceId,
      },
    })) as TaskWorkspacePayload;
  }
  throw new Error("Task workspace reads are available only through the local bridge.");
};

export const requestFinishTaskWorkspace = async (input: {
  workspaceId: string;
  resultMarkdown: string;
  verification: Record<string, unknown>;
  auditEvent: Record<string, unknown>;
}): Promise<FinishTaskWorkspaceResult> => {
  if (hasCommandHost()) {
    return (await invoke("delegation_finish_task_workspace", { request: input })) as FinishTaskWorkspaceResult;
  }
  throw new Error("Task workspace finalization is available only through the local bridge.");
};

export const requestExecuteOpenCodeTask = async (workspaceId: string): Promise<ExecuteOpenCodeTaskResult> => {
  if (hasCommandHost()) {
    return (await invoke("delegation_execute_opencode_task", {
      request: {
        workspaceId,
      },
    })) as ExecuteOpenCodeTaskResult;
  }
  throw new Error("OpenCode task execution is available only through the local bridge.");
};

export const hydrateState = async (bundled: AddOnManifest[], sideloaded: AddOnManifest[]): Promise<ResonantShellState> => {
  const manifests = [...bundled, ...sideloaded];
  const base = buildDefaultState(bundled);
  const persisted = await readPersistedState();

  if (!persisted) {
    const next = enableBundledAddonsForLocalDevelopment(
      rebaseStateOnManifests(base, manifests, sideloaded.map((manifest) => manifest.id)),
      bundled,
    );
    await persistState(next);
    return next;
  }

  const next = enableBundledAddonsForLocalDevelopment(
    rebaseStateOnManifests(normalizeState(persisted, base), manifests, sideloaded.map((manifest) => manifest.id)),
    bundled,
  );
  await persistState(next);
  return next;
};

const enableBundledAddonsForLocalDevelopment = (
  state: ResonantShellState,
  bundled: AddOnManifest[],
): ResonantShellState => {
  if (!isLocalDevelopmentMode()) {
    return state;
  }

  const installations = { ...state.installations };
  for (const manifest of bundled) {
    const current = installations[manifest.id];
    if (!current) {
      continue;
    }

    installations[manifest.id] = {
      ...current,
      installed: true,
      enabled: true,
      status: "enabled",
      grantedCapabilities: current.grantedCapabilities.map((grant) => ({ ...grant, granted: true })),
      notes: ["Local development catalog mode: installed and enabled for full add-on testing."],
    };
  }

  return {
    ...state,
    installations,
    uiPreferences: {
      ...state.uiPreferences,
      recommendedAddOnsReviewed: true,
    },
  };
};

export const rebaseStateOnManifests = (
  state: ResonantShellState,
  manifests: AddOnManifest[],
  sideloadedIds: string[],
): ResonantShellState => {
  const installations = { ...state.installations };
  for (const manifest of manifests) {
    const snapshot = createInstallationSnapshot(
      manifest,
      installations[manifest.id],
      sideloadedIds.includes(manifest.id) ? "sideload" : "bundled",
    );
    if (snapshot.status === "uninstalled") {
      const uninstalledSnapshot = {
        ...snapshot,
        installed: false,
        enabled: false,
        grantedCapabilities: [],
        privateProviderProfileIds: [],
      };
      delete uninstalledSnapshot.config;
      installations[manifest.id] = uninstalledSnapshot;
      continue;
    }
    installations[manifest.id] = snapshot;
  }

  for (const installation of Object.values(installations)) {
    if (sideloadedIds.includes(installation.addonId)) {
      installation.source = "sideload";
    }
  }

  return { ...state, installations };
};

export const applyProviderCredentialStatuses = (
  state: ResonantShellState,
  credentialStatuses: Record<string, boolean>,
): ResonantShellState => ({
  ...state,
  providers: state.providers.map((profile) => ({
    ...profile,
    credentialStatus: credentialStatuses[profile.id] || !providerNeedsStoredCredential(profile) ? "configured" : "missing",
  })),
});

const mergeById = <T extends { id: string }>(persisted: T[] | undefined, defaults: T[]): T[] => {
  const persistedById = new Map((persisted ?? []).map((item) => [item.id, item]));
  return defaults.map((item) => ({ ...item, ...persistedById.get(item.id) }));
};

const RETIRED_RUNTIME_NODE_IDS = new Set(["node-gx10-gemma"]);
const LEGACY_MINIMAX_MODELS = new Set(["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]);
const GX10_QWEN35_MODEL = "Qwen3.6-35B-A3B-Q4_K_M.gguf";
const GX10_QWEN35_ENDPOINT = "http://192.168.1.77:30004/v1";

const mergeConversationThreads = (
  persisted: ResonantShellState["conversationThreads"] | undefined,
  defaults: ResonantShellState["conversationThreads"],
): ResonantShellState["conversationThreads"] => {
  const persistedById = new Map((persisted ?? []).map((thread) => [thread.id, thread]));
  const defaultThreads = defaults.map((thread) => ({ ...thread, ...(persistedById.get(thread.id) ?? {}) }));
  const defaultIds = new Set(defaults.map((thread) => thread.id));
  const extraPersistedThreads = (persisted ?? []).filter((thread) => !defaultIds.has(thread.id));
  return [...defaultThreads, ...extraPersistedThreads];
};

const normalizeProviders = (
  persisted: ResonantShellState["providers"] | undefined,
  defaults: ResonantShellState["providers"],
): ResonantShellState["providers"] => {
  const defaultIds = new Set(defaults.map((profile) => profile.id));
  const normalizedDefaults = defaults.map((profile) => {
    const current = persisted?.find((item) => item.id === profile.id);
    if (!current) {
      return profile;
    }
    const primaryModel =
      profile.id === "shared-minimax" && LEGACY_MINIMAX_MODELS.has(current.primaryModel)
        ? profile.primaryModel
        : profile.allowedModels.includes(current.primaryModel)
          ? current.primaryModel
          : profile.primaryModel;
    const fallbackModel =
      current.fallbackModel && profile.allowedModels.includes(current.fallbackModel)
        ? current.fallbackModel
        : profile.fallbackModel;
    return {
      ...profile,
      ...current,
      apiBaseUrl: profile.id === "gx10-local-llama" ? profile.apiBaseUrl : current.apiBaseUrl,
      allowedModels: profile.allowedModels,
      modelContext: profile.modelContext,
      consumerScopes: profile.consumerScopes,
      authMethod: profile.authMethod,
      authTier: profile.authTier,
      providerType: profile.providerType,
      primaryModel,
      fallbackModel,
    };
  });
  const extraPersisted = (persisted ?? [])
    .filter((profile) => !defaultIds.has(profile.id))
    .map((profile) => {
      const isLegacyGx10 =
        profile.providerType === "openai-compatible" &&
        String(profile.apiBaseUrl ?? "").includes("192.168.1.77:30000") &&
        profile.allowedModels.some((model) => model.toLowerCase().includes("gemma-4-26"));
      if (!isLegacyGx10) {
        return profile;
      }
      return {
        ...profile,
        apiBaseUrl: GX10_QWEN35_ENDPOINT,
        allowedModels: [GX10_QWEN35_MODEL],
        primaryModel: GX10_QWEN35_MODEL,
        fallbackModel: undefined,
        modelContext: [
          {
            model: GX10_QWEN35_MODEL,
            maxContextTokens: 400_000,
            tokenEstimateMethod: "provider-metadata" as const,
            source: "runtime-node" as const,
          },
        ],
      };
    });
  return [...normalizedDefaults, ...extraPersisted];
};

const normalizeRuntimeNodes = (
  persisted: ResonantShellState["runtimeNodes"] | undefined,
  defaults: ResonantShellState["runtimeNodes"],
): ResonantShellState["runtimeNodes"] => {
  const defaultIds = new Set(defaults.map((node) => node.id));
  const normalizedDefaults = defaults.map((node) => {
    const current = persisted?.find((item) => item.id === node.id);
    if (!current) {
      return node;
    }
    const merged = {
      ...node,
      ...current,
      kind: node.kind,
      locality: node.locality,
      providerProfileId: node.providerProfileId,
      supportedModels: node.supportedModels,
      authTier: node.authTier,
      deployableOnDemand: node.deployableOnDemand,
      notes: node.notes,
    };
    if (node.id === "node-gx10-qwen" && merged.endpoint !== node.endpoint) {
      return {
        ...merged,
        endpoint: node.endpoint,
        healthState: node.healthState,
      };
    }
    return merged;
  });
  const extraPersisted = (persisted ?? [])
    .filter((node) => !defaultIds.has(node.id) && !RETIRED_RUNTIME_NODE_IDS.has(node.id))
    .map((node) => {
      const isLegacyGx10 =
        String(node.endpoint ?? "").includes("192.168.1.77:30000") &&
        node.supportedModels.some((model) => model.toLowerCase().includes("gemma-4-26"));
      if (!isLegacyGx10) {
        return node;
      }
      return {
        ...node,
        endpoint: GX10_QWEN35_ENDPOINT,
        supportedModels: [GX10_QWEN35_MODEL],
        healthState: "ready" as const,
        notes: [
          "Migrated from the retired GX10 Gemma route to the verified Qwen 3.6 35B llama.cpp endpoint on 2026-05-16.",
        ],
      };
    });
  return [...normalizedDefaults, ...extraPersisted];
};

const normalizeAgents = (
  persisted: ResonantShellState["agents"] | undefined,
  defaults: ResonantShellState["agents"],
): ResonantShellState["agents"] => {
  const byId = new Map((persisted ?? []).map((agent) => [agent.id, agent]));
  const legacyEngineer = byId.get("engineer.core");
  return defaults.map((agent) => {
    const current = byId.get(agent.id);
    if (agent.id === "setup.core") {
      const providerProfileId =
        current?.providerProfileId === "shared-minimax" && legacyEngineer?.providerProfileId
          ? legacyEngineer.providerProfileId
          : current?.providerProfileId ?? legacyEngineer?.providerProfileId ?? agent.providerProfileId;
      const fallbackProviderProfileId =
        current?.providerProfileId === "shared-minimax" && legacyEngineer?.fallbackProviderProfileId
          ? legacyEngineer.fallbackProviderProfileId
          : current?.fallbackProviderProfileId ?? legacyEngineer?.fallbackProviderProfileId ?? agent.fallbackProviderProfileId;
      return {
        ...agent,
        ...(legacyEngineer ?? current ?? {}),
        id: "setup.core",
        displayName: agent.displayName,
        providerProfileId,
        fallbackProviderProfileId,
        archiveReadScopes: agent.archiveReadScopes,
        archiveIntakeWriteScopes: agent.archiveIntakeWriteScopes,
        channelIds: agent.channelIds,
      };
    }
    return {
      ...agent,
      ...(current ?? {}),
      id: agent.id,
      channelIds: agent.channelIds,
      archiveReadScopes: agent.archiveReadScopes,
      archiveIntakeWriteScopes: agent.archiveIntakeWriteScopes,
    };
  });
};

const normalizeChannels = (
  installations: ResonantShellState["installations"],
  persisted: ResonantShellState["channels"] | undefined,
  defaults: ResonantShellState["channels"],
): ResonantShellState["channels"] =>
  defaults.map((channel) => {
    const current = persisted?.find((item) => item.id === channel.id);
    const addonId = channel.metadata.addonId ?? current?.metadata?.addonId;
    const addonEnabled = addonId ? installations[addonId]?.enabled === true : true;
    return {
      ...channel,
      ...(current ?? {}),
      owningAgentId: channel.owningAgentId,
      workspaceId: channel.workspaceId,
      label: channel.label,
      enabled: addonId ? Boolean((current ?? channel).enabled && addonEnabled) : (current?.enabled ?? channel.enabled),
      metadata: { ...channel.metadata, ...(current?.metadata ?? {}) },
    };
  });

const normalizeWorkspaces = (
  persisted: ResonantShellState["workspaces"] | undefined,
  defaults: ResonantShellState["workspaces"],
): ResonantShellState["workspaces"] =>
  defaults.map((workspace) => {
    const current = persisted?.find((item) => item.id === workspace.id);
    return {
      ...workspace,
      ...(current ?? {}),
      owningEntityId: workspace.owningEntityId,
      channelIds: workspace.channelIds,
      surfaces: workspace.surfaces,
      title: workspace.title,
    };
  });

const mergeInstallations = (
  persisted: ResonantShellState["installations"] | undefined,
  defaults: ResonantShellState["installations"],
): ResonantShellState["installations"] =>
  Object.fromEntries(
    Object.entries(defaults).map(([addonId, installation]) => [
      addonId,
      {
        ...installation,
        ...(persisted?.[addonId] ?? {}),
      },
    ]),
  );

const normalizeProviderRouting = (
  persisted: ResonantShellState["providerRouting"] | undefined,
  defaults: ResonantShellState["providerRouting"],
): ResonantShellState["providerRouting"] => ({
  ...defaults,
  ...(persisted ?? {}),
  executionAdapters: defaults.executionAdapters.map((defaultAdapter) => ({
    ...defaultAdapter,
    ...(persisted?.executionAdapters ?? []).find((adapter) => adapter.id === defaultAdapter.id),
    supportedProviderTypes: defaultAdapter.supportedProviderTypes,
    supportedRuntimeKinds: defaultAdapter.supportedRuntimeKinds,
    supportedAuthMethods: defaultAdapter.supportedAuthMethods,
    requiresCredential: defaultAdapter.requiresCredential,
    experimental: defaultAdapter.experimental,
    supportsStreaming:
      (persisted?.executionAdapters ?? []).find((adapter) => adapter.id === defaultAdapter.id)?.supportsStreaming ??
      defaultAdapter.supportsStreaming,
    supportsAbort:
      (persisted?.executionAdapters ?? []).find((adapter) => adapter.id === defaultAdapter.id)?.supportsAbort ??
      defaultAdapter.supportsAbort,
  })),
  fallbackPolicies: defaults.fallbackPolicies,
  recoveryActions: defaults.recoveryActions,
  experimentalPolicy: {
    ...defaults.experimentalPolicy,
    ...(persisted?.experimentalPolicy ?? {}),
  },
});

const normalizeModelStrategy = (
  persisted: ResonantShellState["modelStrategy"] | undefined,
  defaults: ResonantShellState["modelStrategy"],
): ResonantShellState["modelStrategy"] => {
  const defaultStrategiesById = new Map(defaults.workloadStrategies.map((strategy) => [strategy.id, strategy]));
  const workloadStrategies = (persisted?.workloadStrategies?.length ? persisted.workloadStrategies : defaults.workloadStrategies).map((strategy) => {
    const defaultStrategy = defaultStrategiesById.get(strategy.id);
    if (!defaultStrategy) {
      return strategy;
    }
    if (
      (strategy.id === "strategy-augmentor-primary" && LEGACY_MINIMAX_MODELS.has(strategy.primaryRoute.model)) ||
      (strategy.id === "strategy-archive-ingest" && strategy.primaryRoute.model === "gpt-5.4")
    ) {
      return {
        ...strategy,
        primaryRoute: defaultStrategy.primaryRoute,
      };
    }
    return strategy;
  });
  return {
    ...defaults,
    ...(persisted ?? {}),
    fallbackChains: defaults.fallbackChains,
    workloadStrategies,
    emergencyPolicy: {
      ...defaults.emergencyPolicy,
      ...(persisted?.emergencyPolicy ?? {}),
      orderedPromotionTargets: defaults.emergencyPolicy.orderedPromotionTargets,
      hardFloorRoute: defaults.emergencyPolicy.hardFloorRoute,
    },
  };
};

const normalizeArchivePolicy = (
  persisted: ResonantShellState["archivePolicy"] | undefined,
  defaults: ResonantShellState["archivePolicy"],
): ResonantShellState["archivePolicy"] => ({
  ...defaults,
  ...(persisted ?? {}),
  approvalPolicy: {
    ...defaults.approvalPolicy,
    ...(persisted?.approvalPolicy ?? {}),
    autoApproveIntents:
      persisted?.approvalPolicy?.autoApproveIntents?.length
        ? persisted.approvalPolicy.autoApproveIntents
        : defaults.approvalPolicy.autoApproveIntents,
    humanReviewSourceTypes:
      persisted?.approvalPolicy?.humanReviewSourceTypes?.length
        ? persisted.approvalPolicy.humanReviewSourceTypes
        : defaults.approvalPolicy.humanReviewSourceTypes,
    humanReviewPageTypes:
      persisted?.approvalPolicy?.humanReviewPageTypes?.length
        ? persisted.approvalPolicy.humanReviewPageTypes
        : defaults.approvalPolicy.humanReviewPageTypes,
    notes: persisted?.approvalPolicy?.notes?.length ? persisted.approvalPolicy.notes : defaults.approvalPolicy.notes,
  },
  actorPolicies: persisted?.actorPolicies?.length ? persisted.actorPolicies : defaults.actorPolicies,
  notes: persisted?.notes?.length ? persisted.notes : defaults.notes,
});

const normalizeArchiveAutomationPolicy = (
  persisted: ResonantShellState["archiveAutomationPolicy"] | undefined,
  defaults: ResonantShellState["archiveAutomationPolicy"],
): ResonantShellState["archiveAutomationPolicy"] => ({
  ...defaults,
  ...(persisted ?? {}),
  autoSyncEnabled: persisted?.autoSyncEnabled ?? defaults.autoSyncEnabled,
  aiMemoryBuilds: persisted?.aiMemoryBuilds ?? defaults.aiMemoryBuilds,
});

export const normalizeState = (state: ResonantShellState, base: ResonantShellState): ResonantShellState => {
  const installations = mergeInstallations(state.installations, base.installations);
  return {
    ...base,
    ...state,
    strategistIdentity: { ...base.strategistIdentity, ...state.strategistIdentity },
    uiPreferences: {
      ...base.uiPreferences,
      ...(state.uiPreferences ?? {}),
      activeSection:
        !state.uiPreferences?.activeChatThreadId && state.uiPreferences?.activeSection === "overview"
          ? "strategist"
          : (state.uiPreferences?.activeSection ?? base.uiPreferences.activeSection),
      activeChatThreadId: state.uiPreferences?.activeChatThreadId ?? base.uiPreferences.activeChatThreadId,
      pinnedChatThreadIds: state.uiPreferences?.pinnedChatThreadIds ?? base.uiPreferences.pinnedChatThreadIds,
      pinnedChatProjectIds: state.uiPreferences?.pinnedChatProjectIds ?? base.uiPreferences.pinnedChatProjectIds,
      leftSidebarOpen: state.uiPreferences?.leftSidebarOpen ?? base.uiPreferences.leftSidebarOpen,
      chatSidebarOpen: state.uiPreferences?.chatSidebarOpen ?? base.uiPreferences.chatSidebarOpen,
      workspaceLayout: state.uiPreferences?.workspaceLayout ?? base.uiPreferences.workspaceLayout,
      chatSidebarWidth: state.uiPreferences?.chatSidebarWidth ?? base.uiPreferences.chatSidebarWidth,
      chatHistoryOpen: state.uiPreferences?.chatHistoryOpen ?? base.uiPreferences.chatHistoryOpen,
      recommendedAddOnsReviewed:
        state.uiPreferences?.recommendedAddOnsReviewed ?? base.uiPreferences.recommendedAddOnsReviewed,
      windowZoom: state.uiPreferences?.windowZoom ?? base.uiPreferences.windowZoom,
      pendingOpenCodeWorkspaceId:
        state.uiPreferences?.pendingOpenCodeWorkspaceId ?? base.uiPreferences.pendingOpenCodeWorkspaceId,
      browserWorkspace: {
        ...base.uiPreferences.browserWorkspace,
        ...(state.uiPreferences?.browserWorkspace ?? {}),
        controlledSession: {
          ...base.uiPreferences.browserWorkspace.controlledSession,
          ...(state.uiPreferences?.browserWorkspace?.controlledSession ?? {}),
        },
      },
    },
    coreServices: mergeById(state.coreServices, base.coreServices),
    providers: normalizeProviders(state.providers, base.providers),
    runtimeNodes: normalizeRuntimeNodes(state.runtimeNodes, base.runtimeNodes),
    providerRouting: normalizeProviderRouting(state.providerRouting, base.providerRouting),
    computeFabric: state.computeFabric
      ? {
          ...base.computeFabric,
          ...state.computeFabric,
          nodes: mergeById(state.computeFabric.nodes, base.computeFabric.nodes),
          jobs: state.computeFabric.jobs ?? base.computeFabric.jobs,
          artifacts: state.computeFabric.artifacts ?? base.computeFabric.artifacts,
          audit: state.computeFabric.audit ?? base.computeFabric.audit,
        }
      : base.computeFabric,
    modelStrategy: normalizeModelStrategy(state.modelStrategy, base.modelStrategy),
    agents: normalizeAgents(state.agents, base.agents),
    channels: normalizeChannels(installations, state.channels, base.channels),
    workspaces: normalizeWorkspaces(state.workspaces, base.workspaces),
    archivePolicy: normalizeArchivePolicy(state.archivePolicy, base.archivePolicy),
    archiveAutomationPolicy: normalizeArchiveAutomationPolicy(state.archiveAutomationPolicy, base.archiveAutomationPolicy),
    chatProjects: state.chatProjects ?? base.chatProjects,
    conversationThreads: mergeConversationThreads(state.conversationThreads, base.conversationThreads),
    transcriptLedger: state.transcriptLedger ?? base.transcriptLedger,
    contextMemoryStates: state.contextMemoryStates ?? base.contextMemoryStates,
    goalWorkspaces: normalizeGoalWorkspaces(state.goalWorkspaces ?? base.goalWorkspaces),
    recoverySession: {
      ...base.recoverySession,
      ...(state.recoverySession ?? {}),
      engineerAgentId: base.recoverySession.engineerAgentId,
      engineerThreadId: base.recoverySession.engineerThreadId,
      checklist: state.recoverySession?.checklist ?? base.recoverySession.checklist,
      changeLog: state.recoverySession?.changeLog ?? base.recoverySession.changeLog,
    },
    installations,
  };
};
