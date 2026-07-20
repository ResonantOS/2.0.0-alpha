// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-007-living-archive-boundaries.md

import type { Dispatch, SetStateAction } from "react";
import type {
  AddOnManifest,
  ArchiveAiMemoryBuildJobSummary,
  ArchiveAiMemoryBuildResult,
  ArchiveBackgroundCycleResult,
  ArchiveDocumentPayload,
  ArchiveImportedLibrarySummary,
  ArchivePromoteReviewArtifactResult,
  ArchiveProcessIngestResult,
  ArchiveIngestProbeResult,
  ArchiveLibraryClassificationReview,
  ArchiveLibraryImportMode,
  ArchiveLibraryImportResult,
  ArchiveLibraryPreflightResult,
  ArchiveLibraryReorganisationPlan,
  ArchiveLintResult,
  ArchiveMaintenanceCycleResult,
  ArchiveMemoryDomain,
  ArchiveQueuedIngestRequest,
  ArchiveReviewArtifact,
  ArchiveReviewDecisionResult,
  ArchiveSourceFolderScanResult,
  ArchiveSourceWatchRecord,
  ArchiveSearchSourceHit,
  ArchiveSemanticLintResult,
  ArchiveRuntimeStatus,
  ArchiveSearchResult,
  ProviderDiagnosticReport,
  ResonantShellState,
} from "../../core/contracts";
import type { MemoryProviderBroker } from "../../core/memory-provider";
import { livingArchiveMemoryProvider } from "../../core/memory-provider";
import { applyProviderDiagnostics } from "../../core/policies";
import { providerCredentialReady } from "../../core/provider-credentials";
import { resolveArchiveIngestRoute, resolveRoutineRoute, routedProviderLabel } from "../../core/provider-service";
import {
  requestArchiveAiMemoryBuildJob,
  requestArchiveAiMemoryBuildJobs,
  requestArchiveBackgroundCycle,
  requestArchiveIngestProbe,
  requestArchiveImportedLibraries,
  requestArchiveLibraryFolderSelection,
  requestArchiveLibraryClassificationReview,
  requestArchiveLibraryImport,
  requestArchiveLint,
  requestArchiveQueueImportedLibraryIngest,
  requestArchiveSemanticLint,
  requestArchiveLibraryPreflight,
  requestArchiveLibraryReorganisationPlan,
  requestArchiveReviewArtifacts,
  requestArchiveReviewQueue,
  requestArchiveSourceFolderScan,
  requestProviderDiagnostics,
} from "../../core/runtime";

type ReadyShellSnapshot = {
  state: ResonantShellState;
  bundled: AddOnManifest[];
  sideloaded: AddOnManifest[];
};

type ArchiveProbeControllerInput = {
  snapshot: ReadyShellSnapshot;
  commitReadyState: (state: ResonantShellState) => void;
  setProviderDiagnostics: Dispatch<SetStateAction<ProviderDiagnosticReport[]>>;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveProbeBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveProbeResult: Dispatch<
    SetStateAction<{
      probe: ArchiveIngestProbeResult;
      routeLabel: string;
      model: string;
      resolutionReason: string;
    } | null>
  >;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveRuntimeStatusControllerInput = {
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveStatusBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveStatus: Dispatch<SetStateAction<ArchiveRuntimeStatus | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveImportedLibrariesControllerInput = {
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveSourceScanBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveImportedLibraries: Dispatch<SetStateAction<ArchiveImportedLibrarySummary[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveSearchControllerInput = {
  query: string;
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveSearchBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveSearchResult: Dispatch<SetStateAction<ArchiveSearchResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveDocumentControllerInput = {
  path: string;
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveDocumentBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveDocument: Dispatch<SetStateAction<ArchiveDocumentPayload | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveReviewQueueControllerInput = {
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveQueue: Dispatch<SetStateAction<ArchiveQueuedIngestRequest[]>>;
  setArchiveReviewArtifacts?: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveQueueRequestControllerInput = {
  source: ArchiveSearchSourceHit;
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveQueue: Dispatch<SetStateAction<ArchiveQueuedIngestRequest[]>>;
  setArchiveReviewArtifacts?: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveQueueWatchedSourceControllerInput = {
  source: ArchiveSourceWatchRecord;
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveQueue: Dispatch<SetStateAction<ArchiveQueuedIngestRequest[]>>;
  setArchiveReviewArtifacts?: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveSourceFolderScanControllerInput = {
  rootPath?: string;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveSourceScanBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveSourceScanResult: Dispatch<SetStateAction<ArchiveSourceFolderScanResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveLibraryImportControllerInput = {
  sourcePath: string;
  domain: ArchiveMemoryDomain;
  importMode: ArchiveLibraryImportMode;
  libraryName?: string;
  excludedTopFolders?: string[];
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveSourceScanBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveLibraryImportResult: Dispatch<SetStateAction<ArchiveLibraryImportResult | null>>;
  setArchiveImportedLibraries?: Dispatch<SetStateAction<ArchiveImportedLibrarySummary[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveLibraryPreflightControllerInput = {
  sourcePath: string;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveSourceScanBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveLibraryPreflightResult: Dispatch<SetStateAction<ArchiveLibraryPreflightResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveLibraryClassificationReviewControllerInput = {
  classificationManifestPath: string;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveSourceScanBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveClassificationReview: Dispatch<SetStateAction<ArchiveLibraryClassificationReview | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveLibraryReorganisationPlanControllerInput = {
  classificationManifestPath: string;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveSourceScanBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveReorganisationPlan: Dispatch<SetStateAction<ArchiveLibraryReorganisationPlan | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveQueueImportedLibraryControllerInput = {
  manifestPath: string;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveQueue: Dispatch<SetStateAction<ArchiveQueuedIngestRequest[]>>;
  setArchiveReviewArtifacts?: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveProcessRequestControllerInput = {
  snapshot: ReadyShellSnapshot;
  requestFile: string;
  memoryProvider?: MemoryProviderBroker;
  commitReadyState: (state: ResonantShellState) => void;
  setProviderDiagnostics: Dispatch<SetStateAction<ProviderDiagnosticReport[]>>;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveQueue: Dispatch<SetStateAction<ArchiveQueuedIngestRequest[]>>;
  setArchiveProcessResult: Dispatch<SetStateAction<ArchiveProcessIngestResult | null>>;
  setArchiveReviewArtifacts: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveReviewDecisionControllerInput = {
  artifactFile: string;
  action: "approve" | "reject" | "escalate";
  actorId: string;
  notes?: string;
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveReviewArtifacts: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  setArchiveReviewDecisionResult: Dispatch<SetStateAction<ArchiveReviewDecisionResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchivePromoteReviewArtifactControllerInput = {
  artifactFile: string;
  actorId: string;
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveReviewArtifacts: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  setArchivePromotionResult: Dispatch<SetStateAction<ArchivePromoteReviewArtifactResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchivePromoteApprovedArtifactsControllerInput = {
  artifacts: ArchiveReviewArtifact[];
  actorId: string;
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveReviewArtifacts: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  setArchivePromotionResult: Dispatch<SetStateAction<ArchivePromoteReviewArtifactResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveMaintenanceCycleControllerInput = {
  snapshot: ReadyShellSnapshot;
  memoryProvider?: MemoryProviderBroker;
  commitReadyState: (state: ResonantShellState) => void;
  setProviderDiagnostics: Dispatch<SetStateAction<ProviderDiagnosticReport[]>>;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveQueue: Dispatch<SetStateAction<ArchiveQueuedIngestRequest[]>>;
  setArchiveReviewArtifacts: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  setArchiveProcessResult: Dispatch<SetStateAction<ArchiveProcessIngestResult | null>>;
  setArchivePromotionResult: Dispatch<SetStateAction<ArchivePromoteReviewArtifactResult | null>>;
  setArchiveMaintenanceResult: Dispatch<SetStateAction<ArchiveMaintenanceCycleResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveAiMemoryBuildJobControllerInput = {
  snapshot: ReadyShellSnapshot;
  manifestPath: string;
  commitReadyState: (state: ResonantShellState) => void;
  setProviderDiagnostics: Dispatch<SetStateAction<ProviderDiagnosticReport[]>>;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveQueue: Dispatch<SetStateAction<ArchiveQueuedIngestRequest[]>>;
  setArchiveReviewArtifacts: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  setArchiveProcessResult: Dispatch<SetStateAction<ArchiveProcessIngestResult | null>>;
  setArchivePromotionResult: Dispatch<SetStateAction<ArchivePromoteReviewArtifactResult | null>>;
  setArchiveMaintenanceResult: Dispatch<SetStateAction<ArchiveMaintenanceCycleResult | null>>;
  setArchiveAiMemoryBuildResult: Dispatch<SetStateAction<ArchiveAiMemoryBuildResult | null>>;
  setArchiveAiMemoryBuildJobs: Dispatch<SetStateAction<ArchiveAiMemoryBuildJobSummary[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveAiMemoryBuildJobsControllerInput = {
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveAiMemoryBuildJobs: Dispatch<SetStateAction<ArchiveAiMemoryBuildJobSummary[]>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveBackgroundCycleControllerInput = {
  snapshot: ReadyShellSnapshot;
  memoryProvider?: MemoryProviderBroker;
  commitReadyState: (state: ResonantShellState) => void;
  setProviderDiagnostics: Dispatch<SetStateAction<ProviderDiagnosticReport[]>>;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveQueue: Dispatch<SetStateAction<ArchiveQueuedIngestRequest[]>>;
  setArchiveReviewArtifacts: Dispatch<SetStateAction<ArchiveReviewArtifact[]>>;
  setArchiveProcessResult: Dispatch<SetStateAction<ArchiveProcessIngestResult | null>>;
  setArchivePromotionResult: Dispatch<SetStateAction<ArchivePromoteReviewArtifactResult | null>>;
  setArchiveMaintenanceResult: Dispatch<SetStateAction<ArchiveMaintenanceCycleResult | null>>;
  setArchiveSourceScanResult?: Dispatch<SetStateAction<ArchiveSourceFolderScanResult | null>>;
  setArchiveBackgroundResult?: Dispatch<SetStateAction<ArchiveBackgroundCycleResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveLintControllerInput = {
  memoryProvider?: MemoryProviderBroker;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveLintResult: Dispatch<SetStateAction<ArchiveLintResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

type ArchiveSemanticLintControllerInput = {
  snapshot: ReadyShellSnapshot;
  memoryProvider?: MemoryProviderBroker;
  commitReadyState: (state: ResonantShellState) => void;
  setProviderDiagnostics: Dispatch<SetStateAction<ProviderDiagnosticReport[]>>;
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  setArchiveQueueBusy: Dispatch<SetStateAction<boolean>>;
  setArchiveSemanticLintResult: Dispatch<SetStateAction<ArchiveSemanticLintResult | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

const ARCHIVE_PROBE_SOURCE = {
  label: "Synthetic Living Archive Intake Probe",
  excerpt:
    "Transcript excerpt: ResonantOS should remain modular, strategy-driven, and sovereignty-first. The Living Archive must preserve trusted knowledge writes for the Strategist-owned ingest path while allowing add-ons to deposit raw intake artifacts for later interpretation.",
};

export const loadArchiveRuntimeStatus = async ({
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveStatusBusy,
  setArchiveStatus,
  errorMessageOf,
}: ArchiveRuntimeStatusControllerInput): Promise<void> => {
  setArchiveStatusBusy(true);
  setChatNotice(null);
  try {
    const status = await memoryProvider.status();
    setArchiveStatus(status);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to load Living Archive runtime status."));
  } finally {
    setArchiveStatusBusy(false);
  }
};

export const loadArchiveImportedLibraries = async ({
  setChatNotice,
  setArchiveSourceScanBusy,
  setArchiveImportedLibraries,
  errorMessageOf,
}: ArchiveImportedLibrariesControllerInput): Promise<void> => {
  setArchiveSourceScanBusy(true);
  setChatNotice(null);
  try {
    const libraries = await requestArchiveImportedLibraries();
    setArchiveImportedLibraries(libraries);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to load Living Archive source registry."));
  } finally {
    setArchiveSourceScanBusy(false);
  }
};

export const executeArchiveSearch = async ({
  query,
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveSearchBusy,
  setArchiveSearchResult,
  errorMessageOf,
}: ArchiveSearchControllerInput): Promise<void> => {
  setArchiveSearchBusy(true);
  setChatNotice(null);
  try {
    const result = await memoryProvider.search(query);
    setArchiveSearchResult(result);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Living Archive search failed."));
  } finally {
    setArchiveSearchBusy(false);
  }
};

export const loadArchiveDocument = async ({
  path,
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveDocumentBusy,
  setArchiveDocument,
  errorMessageOf,
}: ArchiveDocumentControllerInput): Promise<void> => {
  setArchiveDocumentBusy(true);
  setChatNotice(null);
  try {
    const document = await memoryProvider.read(path);
    setArchiveDocument(document);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to read archive document."));
  } finally {
    setArchiveDocumentBusy(false);
  }
};

export const loadArchiveReviewQueue = async ({
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveQueue,
  setArchiveReviewArtifacts,
  errorMessageOf,
}: ArchiveReviewQueueControllerInput): Promise<void> => {
  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    const [queue, artifacts] = await Promise.all([memoryProvider.reviewQueue(), memoryProvider.reviewArtifacts()]);
    setArchiveQueue(queue);
    setArchiveReviewArtifacts?.(artifacts);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to load archive review queue."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const loadArchiveAiMemoryBuildJobs = async ({
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveAiMemoryBuildJobs,
  errorMessageOf,
}: ArchiveAiMemoryBuildJobsControllerInput): Promise<void> => {
  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    setArchiveAiMemoryBuildJobs(await requestArchiveAiMemoryBuildJobs());
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to load AI Memory build jobs."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const queueArchiveSourceForIngest = async ({
  source,
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveQueue,
  setArchiveReviewArtifacts,
  errorMessageOf,
}: ArchiveQueueRequestControllerInput): Promise<void> => {
  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    await memoryProvider.ingestRequest({
      actorId: "strategist.core",
      sourcePath: source.rawPath,
      sourceType: source.sourceType,
      intent: "review-and-ingest",
      provenance: {
        origin: "archive-search",
        processed: source.processed,
      },
    });
    const [queue, artifacts] = await Promise.all([memoryProvider.reviewQueue(), memoryProvider.reviewArtifacts()]);
    setArchiveQueue(queue);
    setArchiveReviewArtifacts?.(artifacts);
    setChatNotice(`Queued ${source.title} for Living Archive ingest review.`);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to queue archive ingest request."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const queueWatchedArchiveSourceForIngest = async ({
  source,
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveQueue,
  setArchiveReviewArtifacts,
  errorMessageOf,
}: ArchiveQueueWatchedSourceControllerInput): Promise<void> => {
  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    await memoryProvider.ingestRequest({
      actorId: "strategist.core",
      sourcePath: source.path,
      sourceType: source.sourceType,
      sourceRole: source.rootSubtype ?? source.rootRole,
      intent: source.status === "changed" ? "review-and-reingest" : "review-and-ingest",
      provenance: {
        origin: "source-folder-scan",
        status: source.status,
        hash: source.hash,
        previousHash: source.previousHash,
        modifiedAt: source.modifiedAt,
      },
    });
    const [queue, artifacts] = await Promise.all([memoryProvider.reviewQueue(), memoryProvider.reviewArtifacts()]);
    setArchiveQueue(queue);
    setArchiveReviewArtifacts?.(artifacts);
    setChatNotice(`Queued ${source.title} for Living Archive ingest review.`);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to queue scanned source for archive review."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const scanArchiveSourceFolders = async ({
  rootPath,
  setChatNotice,
  setArchiveSourceScanBusy,
  setArchiveSourceScanResult,
  errorMessageOf,
}: ArchiveSourceFolderScanControllerInput): Promise<void> => {
  setArchiveSourceScanBusy(true);
  setChatNotice(null);
  try {
    const result = await requestArchiveSourceFolderScan(rootPath);
    setArchiveSourceScanResult(result);
    setChatNotice(
      `Scanned ${result.filesSeen} source file(s): ${result.newFiles} new, ${result.changedFiles} changed.`,
    );
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to scan Living Archive source folders."));
  } finally {
    setArchiveSourceScanBusy(false);
  }
};

export const importArchiveLibrary = async ({
  sourcePath,
  domain,
  importMode,
  libraryName,
  excludedTopFolders,
  setChatNotice,
  setArchiveSourceScanBusy,
  setArchiveLibraryImportResult,
  setArchiveImportedLibraries,
  errorMessageOf,
}: ArchiveLibraryImportControllerInput): Promise<void> => {
  setArchiveSourceScanBusy(true);
  setChatNotice(null);
  try {
    const result = await requestArchiveLibraryImport({
      sourcePath,
      domain,
      importMode,
      libraryName,
      excludedTopFolders,
      actorId: "strategist.core",
    });
    setArchiveLibraryImportResult(result);
    if (setArchiveImportedLibraries) {
      setArchiveImportedLibraries(await requestArchiveImportedLibraries());
    }
    setChatNotice(
      `Imported ${result.filesImported} file(s) into ${result.libraryName}. Managed location is now canonical.`,
    );
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to import library into Living Archive."));
  } finally {
    setArchiveSourceScanBusy(false);
  }
};

export const preflightArchiveLibrary = async ({
  sourcePath,
  setChatNotice,
  setArchiveSourceScanBusy,
  setArchiveLibraryPreflightResult,
  errorMessageOf,
}: ArchiveLibraryPreflightControllerInput): Promise<void> => {
  setArchiveSourceScanBusy(true);
  setChatNotice(null);
  try {
    const result = await requestArchiveLibraryPreflight(sourcePath);
    setArchiveLibraryPreflightResult(result);
    setChatNotice(
      `Preflight complete: ${result.supportedFiles} supported file(s), ${result.skippedFiles} skipped.`,
    );
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to preflight Living Archive library import."));
  } finally {
    setArchiveSourceScanBusy(false);
  }
};

export const loadArchiveLibraryClassificationReview = async ({
  classificationManifestPath,
  setChatNotice,
  setArchiveSourceScanBusy,
  setArchiveClassificationReview,
  errorMessageOf,
}: ArchiveLibraryClassificationReviewControllerInput): Promise<void> => {
  setArchiveSourceScanBusy(true);
  setChatNotice(null);
  try {
    const review = await requestArchiveLibraryClassificationReview(classificationManifestPath);
    setArchiveClassificationReview(review);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to open Living Archive classification review."));
  } finally {
    setArchiveSourceScanBusy(false);
  }
};

export const generateArchiveLibraryReorganisationPlan = async ({
  classificationManifestPath,
  setChatNotice,
  setArchiveSourceScanBusy,
  setArchiveReorganisationPlan,
  errorMessageOf,
}: ArchiveLibraryReorganisationPlanControllerInput): Promise<void> => {
  setArchiveSourceScanBusy(true);
  setChatNotice(null);
  try {
    const plan = await requestArchiveLibraryReorganisationPlan(classificationManifestPath, "strategist.core");
    setArchiveReorganisationPlan(plan);
    setChatNotice(
      `Generated reorganisation plan for ${plan.libraryName}. No files were moved; approval is still required.`,
    );
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to generate Living Archive reorganisation plan."));
  } finally {
    setArchiveSourceScanBusy(false);
  }
};

export const queueImportedLibraryForIngest = async ({
  manifestPath,
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveQueue,
  setArchiveReviewArtifacts,
  errorMessageOf,
}: ArchiveQueueImportedLibraryControllerInput): Promise<void> => {
  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    const result = await requestArchiveQueueImportedLibraryIngest({
      manifestPath,
      actorId: "strategist.core",
    });
    const [queue, artifacts] = await Promise.all([requestArchiveReviewQueue(), requestArchiveReviewArtifacts()]);
    setArchiveQueue(queue);
    setArchiveReviewArtifacts?.(artifacts);
    setChatNotice(
      `Queued ${result.queued} source file(s) from ${result.libraryName} for AI Memory review. ${result.skippedUnsupported} unsupported and ${result.skippedExistingQueue} already queued were skipped.`,
    );
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to queue imported library for AI Memory review."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const pickArchiveLibraryFolder = async ({
  setChatNotice,
  errorMessageOf,
}: {
  setChatNotice: Dispatch<SetStateAction<string | null>>;
  errorMessageOf: (error: unknown, fallback: string) => string;
}): Promise<string | null> => {
  setChatNotice(null);
  try {
    return await requestArchiveLibraryFolderSelection();
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to open folder picker."));
    return null;
  }
};

const credentialReady = (provider: { providerType: string; authMethod: string; credentialStatus?: string; label: string }): void => {
  if (!providerCredentialReady(provider)) {
    throw new Error(`${provider.label} credential missing. Add it in Settings > Provider Profiles.`);
  }
};

const verifierRouteInput = (state: ResonantShellState) => {
  const verifierRoute = resolveRoutineRoute(state);
  if (!verifierRoute.provider || !verifierRoute.runtimeNode || !verifierRoute.model) {
    return {};
  }
  credentialReady(verifierRoute.provider);
  return {
    verifierProviderId: verifierRoute.provider.id,
    verifierProviderType: verifierRoute.provider.providerType,
    verifierApiBaseUrl: verifierRoute.runtimeNode.endpoint ?? verifierRoute.provider.apiBaseUrl,
    verifierRuntimeNodeId: verifierRoute.runtimeNode.id,
    verifierRuntimeNodeKind: verifierRoute.runtimeNode.kind,
    verifierRuntimeNodeEndpoint: verifierRoute.runtimeNode.endpoint,
    verifierAuthTier: verifierRoute.decision.authTier,
    verifierModel: verifierRoute.model,
  };
};

export const processArchiveQueuedRequest = async ({
  snapshot,
  requestFile,
  memoryProvider = livingArchiveMemoryProvider(),
  commitReadyState,
  setProviderDiagnostics,
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveQueue,
  setArchiveProcessResult,
  setArchiveReviewArtifacts,
  errorMessageOf,
}: ArchiveProcessRequestControllerInput): Promise<void> => {
  const { state } = snapshot;

  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    let routedState = state;
    try {
      const reports = await requestProviderDiagnostics();
      setProviderDiagnostics(reports);
      routedState = applyProviderDiagnostics(state, reports);
      commitReadyState(routedState);
    } catch {
      routedState = state;
    }

    const route = resolveArchiveIngestRoute(routedState);
    const provider = route.provider;
    const runtimeNode = route.runtimeNode;
    if (!provider || !runtimeNode || !route.model) {
      throw new Error(
        route.decision.resolutionReason === "no-viable-route"
          ? "No live archive ingest route is currently available under the agreed strategy."
          : "Archive ingest route is missing provider or runtime details.",
      );
    }
    credentialReady(provider);
    const verifier = verifierRouteInput(routedState);

    const result = await memoryProvider.processIngestRequest({
      requestFile,
      providerId: provider.id,
      providerType: provider.providerType,
      apiBaseUrl: runtimeNode.endpoint ?? provider.apiBaseUrl,
      runtimeNodeId: runtimeNode.id,
      runtimeNodeKind: runtimeNode.kind,
      runtimeNodeEndpoint: runtimeNode.endpoint,
      authTier: route.decision.authTier,
      model: route.model,
      ...verifier,
    });

    const [queue, artifacts] = await Promise.all([memoryProvider.reviewQueue(), memoryProvider.reviewArtifacts()]);
    setArchiveQueue(queue);
    setArchiveReviewArtifacts(artifacts);
    setArchiveProcessResult(result);
    setChatNotice("Archive ingest review artifact created.");
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to process archive ingest request."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const decideArchiveReviewArtifact = async ({
  artifactFile,
  action,
  actorId,
  notes,
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveReviewArtifacts,
  setArchiveReviewDecisionResult,
  errorMessageOf,
}: ArchiveReviewDecisionControllerInput): Promise<void> => {
  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    const result = await memoryProvider.decideReview({ artifactFile, actorId, action, notes });
    const artifacts = await memoryProvider.reviewArtifacts();
    setArchiveReviewArtifacts(artifacts);
    setArchiveReviewDecisionResult(result);
    setChatNotice("Archive review decision recorded.");
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to record archive review decision."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const promoteArchiveReviewArtifact = async ({
  artifactFile,
  actorId,
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveReviewArtifacts,
  setArchivePromotionResult,
  errorMessageOf,
}: ArchivePromoteReviewArtifactControllerInput): Promise<void> => {
  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    const result = await memoryProvider.promoteReviewArtifact({ artifactFile, actorId });
    const artifacts = await memoryProvider.reviewArtifacts();
    setArchiveReviewArtifacts(artifacts);
    setArchivePromotionResult(result);
    setChatNotice(
      result.pagesWritten.length
        ? `Promoted ${result.pagesWritten.length} approved page(s) to the trusted wiki.`
        : "Approved artifact had no promotable trusted wiki pages.",
    );
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to promote archive review artifact."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const promoteApprovedArchiveReviewArtifacts = async ({
  artifacts,
  actorId,
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveReviewArtifacts,
  setArchivePromotionResult,
  errorMessageOf,
}: ArchivePromoteApprovedArtifactsControllerInput): Promise<void> => {
  const promotableArtifacts = artifacts.filter(
    (artifact) =>
      artifact.decision.status === "approved" &&
      artifact.promotion?.status !== "promoted" &&
      artifact.proposedPages.length > 0,
  );

  if (!promotableArtifacts.length) {
    setChatNotice("No approved, unpromoted archive review artifacts are ready for trusted wiki promotion.");
    return;
  }

  setArchiveQueueBusy(true);
  setChatNotice(`Promoting ${promotableArtifacts.length} approved archive artifact(s) to the trusted wiki.`);
  try {
    const promoted: ArchivePromoteReviewArtifactResult[] = [];
    for (const artifact of promotableArtifacts) {
      promoted.push(await memoryProvider.promoteReviewArtifact({ artifactFile: artifact.artifactFile, actorId }));
    }
    const refreshedArtifacts = await memoryProvider.reviewArtifacts();
    setArchiveReviewArtifacts(refreshedArtifacts);
    setArchivePromotionResult(promoted.at(-1) ?? null);
    const pagesWritten = promoted.reduce((total, result) => total + result.pagesWritten.length, 0);
    const pagesSkipped = promoted.reduce((total, result) => total + result.skippedPages.length, 0);
    setChatNotice(`Promoted ${pagesWritten} trusted wiki page(s) from ${promoted.length} approved artifact(s). ${pagesSkipped} skipped.`);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to promote approved archive review artifacts."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const runArchiveMaintenanceCycle = async ({
  snapshot,
  memoryProvider = livingArchiveMemoryProvider(),
  commitReadyState,
  setProviderDiagnostics,
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveQueue,
  setArchiveReviewArtifacts,
  setArchiveProcessResult,
  setArchivePromotionResult,
  setArchiveMaintenanceResult,
  errorMessageOf,
}: ArchiveMaintenanceCycleControllerInput): Promise<void> => {
  const { state } = snapshot;

  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    if (!memoryProvider.maintenanceCycle) {
      throw new Error("The active memory provider does not expose a maintenance-cycle operation.");
    }

    let routedState = state;
    try {
      const reports = await requestProviderDiagnostics();
      setProviderDiagnostics(reports);
      routedState = applyProviderDiagnostics(state, reports);
      commitReadyState(routedState);
    } catch {
      routedState = state;
    }

    const route = resolveArchiveIngestRoute(routedState);
    const provider = route.provider;
    const runtimeNode = route.runtimeNode;
    if (!provider || !runtimeNode || !route.model) {
      throw new Error(
        route.decision.resolutionReason === "no-viable-route"
          ? "No live archive ingest route is currently available under the agreed strategy."
          : "Archive maintenance route is missing provider or runtime details.",
      );
    }
    credentialReady(provider);
    const verifier = verifierRouteInput(routedState);

    const result = await memoryProvider.maintenanceCycle({
      providerId: provider.id,
      providerType: provider.providerType,
      apiBaseUrl: runtimeNode.endpoint ?? provider.apiBaseUrl,
      runtimeNodeId: runtimeNode.id,
      runtimeNodeKind: runtimeNode.kind,
      runtimeNodeEndpoint: runtimeNode.endpoint,
      authTier: route.decision.authTier,
      model: route.model,
      ...verifier,
      maxRequests: 3,
      autoPromote: true,
      actorId: "archive-maintenance.ai",
    });

    const [queue, artifacts] = await Promise.all([memoryProvider.reviewQueue(), memoryProvider.reviewArtifacts()]);
    setArchiveQueue(queue);
    setArchiveReviewArtifacts(artifacts);
    setArchiveMaintenanceResult(result);
    setArchiveProcessResult(result.processed.at(-1) ?? null);
    setArchivePromotionResult(result.promoted.at(-1) ?? null);
    setChatNotice(
      `Archive maintenance finished: ${result.processed.length} processed, ${result.promoted.length} promoted, index/log refreshed.`,
    );
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to run Living Archive maintenance."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const runArchiveAiMemoryBuildJob = async ({
  snapshot,
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
}: ArchiveAiMemoryBuildJobControllerInput): Promise<void> => {
  const { state } = snapshot;

  setArchiveQueueBusy(true);
  setChatNotice("Starting AI Memory build. ResonantOS will queue imported sources, process a safe batch, and report progress.");
  try {
    let routedState = state;
    try {
      const reports = await requestProviderDiagnostics();
      setProviderDiagnostics(reports);
      routedState = applyProviderDiagnostics(state, reports);
      commitReadyState(routedState);
    } catch {
      routedState = state;
    }

    const route = resolveArchiveIngestRoute(routedState);
    const provider = route.provider;
    const runtimeNode = route.runtimeNode;
    if (!provider || !runtimeNode || !route.model) {
      throw new Error(
        route.decision.resolutionReason === "no-viable-route"
          ? "No live archive ingest route is currently available under the agreed strategy."
          : "Archive AI Memory build route is missing provider or runtime details.",
      );
    }
    credentialReady(provider);
    const verifier = verifierRouteInput(routedState);

    const result = await requestArchiveAiMemoryBuildJob({
      manifestPath,
      actorId: "strategist.core",
      maintenance: {
        providerId: provider.id,
        providerType: provider.providerType,
        apiBaseUrl: runtimeNode.endpoint ?? provider.apiBaseUrl,
        runtimeNodeId: runtimeNode.id,
        runtimeNodeKind: runtimeNode.kind,
        runtimeNodeEndpoint: runtimeNode.endpoint,
        authTier: route.decision.authTier,
        model: route.model,
        ...verifier,
        maxRequests: 6,
        autoPromote: true,
        actorId: "archive-build.ai",
      },
    });

    const [queue, artifacts] = await Promise.all([requestArchiveReviewQueue(), requestArchiveReviewArtifacts()]);
    setArchiveQueue(queue);
    setArchiveReviewArtifacts(artifacts);
    setArchiveMaintenanceResult(result.maintenance);
    setArchiveProcessResult(result.maintenance.processed.at(-1) ?? null);
    setArchivePromotionResult(result.maintenance.promoted.at(-1) ?? null);
    setArchiveAiMemoryBuildResult(result);
    setArchiveAiMemoryBuildJobs(await requestArchiveAiMemoryBuildJobs());
    setChatNotice(
      `AI Memory build ${result.status}: ${result.recordsSeen} seen, ${result.queuedThisRun} queued, ${result.processedThisRun} processed, ${result.promotedThisRun} promoted, ${result.queueRemaining} remaining. Skipped: ${result.skippedProcessed} already processed, ${result.skippedUnsupported} unsupported, ${result.skippedMissing} missing.`,
    );
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to run the AI Memory build job."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const runArchiveBackgroundCycle = async ({
  snapshot,
  memoryProvider = livingArchiveMemoryProvider(),
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
}: ArchiveBackgroundCycleControllerInput): Promise<void> => {
  const { state } = snapshot;

  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    let routedState = state;
    try {
      const reports = await requestProviderDiagnostics();
      setProviderDiagnostics(reports);
      routedState = applyProviderDiagnostics(state, reports);
      commitReadyState(routedState);
    } catch {
      routedState = state;
    }

    const route = resolveArchiveIngestRoute(routedState);
    const provider = route.provider;
    const runtimeNode = route.runtimeNode;
    if (!provider || !runtimeNode || !route.model) {
      throw new Error(
        route.decision.resolutionReason === "no-viable-route"
          ? "No live archive ingest route is currently available under the agreed strategy."
          : "Archive background route is missing provider or runtime details.",
      );
    }
    credentialReady(provider);
    const verifier = verifierRouteInput(routedState);

    const input = {
      providerId: provider.id,
      providerType: provider.providerType,
      apiBaseUrl: runtimeNode.endpoint ?? provider.apiBaseUrl,
      runtimeNodeId: runtimeNode.id,
      runtimeNodeKind: runtimeNode.kind,
      runtimeNodeEndpoint: runtimeNode.endpoint,
      authTier: route.decision.authTier,
      model: route.model,
      ...verifier,
      maxRequests: 3,
      autoPromote: true,
      actorId: "archive-background-sync.core",
    };
    const result = memoryProvider.backgroundCycle
      ? await memoryProvider.backgroundCycle(input)
      : await requestArchiveBackgroundCycle(input);

    const [queue, artifacts] = await Promise.all([memoryProvider.reviewQueue(), memoryProvider.reviewArtifacts()]);
    setArchiveQueue(queue);
    setArchiveReviewArtifacts(artifacts);
    setArchiveSourceScanResult?.(result.scan);
    setArchiveMaintenanceResult(result.maintenance);
    setArchiveProcessResult(result.maintenance.processed.at(-1) ?? null);
    setArchivePromotionResult(result.maintenance.promoted.at(-1) ?? null);
    setArchiveBackgroundResult?.(result);
    setChatNotice(
      `Archive background cycle finished: ${result.scan.newFiles} new, ${result.scan.changedFiles} changed, ${result.queuedRequestFiles.length} queued, ${result.maintenance.promoted.length} promoted.`,
    );
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to run Living Archive background cycle."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const runArchiveLint = async ({
  memoryProvider = livingArchiveMemoryProvider(),
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveLintResult,
  errorMessageOf,
}: ArchiveLintControllerInput): Promise<void> => {
  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    const result = memoryProvider.lint ? await memoryProvider.lint() : await requestArchiveLint();
    setArchiveLintResult(result);
    setChatNotice(`Archive lint finished: ${result.findings.length} finding(s), report written.`);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to run Living Archive lint."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const runArchiveSemanticLint = async ({
  snapshot,
  memoryProvider = livingArchiveMemoryProvider(),
  commitReadyState,
  setProviderDiagnostics,
  setChatNotice,
  setArchiveQueueBusy,
  setArchiveSemanticLintResult,
  errorMessageOf,
}: ArchiveSemanticLintControllerInput): Promise<void> => {
  const { state } = snapshot;

  setArchiveQueueBusy(true);
  setChatNotice(null);
  try {
    let routedState = state;
    try {
      const reports = await requestProviderDiagnostics();
      setProviderDiagnostics(reports);
      routedState = applyProviderDiagnostics(state, reports);
      commitReadyState(routedState);
    } catch {
      routedState = state;
    }

    const route = resolveArchiveIngestRoute(routedState);
    const provider = route.provider;
    const runtimeNode = route.runtimeNode;
    if (!provider || !runtimeNode || !route.model) {
      throw new Error(
        route.decision.resolutionReason === "no-viable-route"
          ? "No live archive semantic lint route is currently available under the agreed strategy."
          : "Archive semantic lint route is missing provider or runtime details.",
      );
    }
    if (!providerCredentialReady(provider)) {
      throw new Error(`${provider.label} credential missing. Add it in Settings > Provider Profiles.`);
    }

    const input = {
      providerId: provider.id,
      providerType: provider.providerType,
      apiBaseUrl: runtimeNode.endpoint ?? provider.apiBaseUrl,
      runtimeNodeId: runtimeNode.id,
      runtimeNodeKind: runtimeNode.kind,
      runtimeNodeEndpoint: runtimeNode.endpoint,
      authTier: route.decision.authTier,
      model: route.model,
      maxCandidates: 6,
    };
    const result = memoryProvider.semanticLint
      ? await memoryProvider.semanticLint(input)
      : await requestArchiveSemanticLint(input);
    setArchiveSemanticLintResult(result);
    setChatNotice(`Semantic archive lint finished: ${result.findings.length} finding(s), ${result.candidatesReviewed} candidate(s) reviewed.`);
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Failed to run Living Archive semantic lint."));
  } finally {
    setArchiveQueueBusy(false);
  }
};

export const executeArchiveIngestProbe = async ({
  snapshot,
  commitReadyState,
  setProviderDiagnostics,
  setChatNotice,
  setArchiveProbeBusy,
  setArchiveProbeResult,
  errorMessageOf,
}: ArchiveProbeControllerInput): Promise<void> => {
  const { state } = snapshot;

  setArchiveProbeBusy(true);
  setChatNotice(null);
  try {
    let routedState = state;
    try {
      const reports = await requestProviderDiagnostics();
      setProviderDiagnostics(reports);
      routedState = applyProviderDiagnostics(state, reports);
      commitReadyState(routedState);
    } catch {
      routedState = state;
    }

    const route = resolveArchiveIngestRoute(routedState);
    const provider = route.provider;
    const runtimeNode = route.runtimeNode;
    if (!provider || !runtimeNode || !route.model) {
      throw new Error(
        route.decision.resolutionReason === "no-viable-route"
          ? "No live archive ingest route is currently available under the agreed strategy."
          : "Archive ingest route is missing provider or runtime details.",
      );
    }
    if (!providerCredentialReady(provider)) {
      throw new Error(`${provider.label} credential missing. Add it in Settings > Provider Profiles.`);
    }

    const probe = await requestArchiveIngestProbe({
      providerId: provider.id,
      providerType: provider.providerType,
      apiBaseUrl: runtimeNode.endpoint ?? provider.apiBaseUrl,
      runtimeNodeId: runtimeNode.id,
      runtimeNodeKind: runtimeNode.kind,
      runtimeNodeEndpoint: runtimeNode.endpoint,
      authTier: route.decision.authTier,
      model: route.model,
      sourceLabel: ARCHIVE_PROBE_SOURCE.label,
      sourceExcerpt: ARCHIVE_PROBE_SOURCE.excerpt,
    });

    setArchiveProbeResult({
      probe,
      routeLabel: routedProviderLabel(route),
      model: route.model,
      resolutionReason: route.decision.resolutionReason,
    });
  } catch (error) {
    setChatNotice(errorMessageOf(error, "Archive ingest probe failed."));
  } finally {
    setArchiveProbeBusy(false);
  }
};
