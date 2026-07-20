// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-007-living-archive-boundaries.md

import { useEffect, useRef, useState } from "react";
import type {
  ArchiveDocumentPayload,
  ArchiveAiMemoryBuildJobSummary,
  ArchiveAiMemoryBuildResult,
  ArchiveAutomationPolicy,
  ChatRunPhase,
  ArchiveImportedLibrarySummary,
  ArchiveLibraryClassificationReview,
  ArchiveLibraryReorganisationPlan,
  ArchivePromoteReviewArtifactResult,
  ArchiveProcessIngestResult,
  ArchiveIngestProbeResult,
  ArchiveLibraryImportMode,
  ArchiveLibraryImportResult,
  ArchiveLibraryPreflightResult,
  ArchiveLintResult,
  ArchiveMaintenanceCycleResult,
  ArchiveMemoryDomain,
  ConversationThread,
  ArchiveQueuedIngestRequest,
  ArchiveReviewArtifact,
  ArchiveReviewDecisionResult,
  ArchiveRuntimeStatus,
  ArchiveSearchResult,
  ArchiveSearchSourceHit,
  ArchiveSemanticLintResult,
  ArchiveSourceFolderScanResult,
  ArchiveSourceWatchRecord,
  ProviderCostPosture,
  ResonantShellState,
} from "../../core/contracts";
import { Panel } from "../../components/Panel";
import { ArchiveClassificationReviewPanel } from "./ArchiveClassificationReviewPanel";
import { ArchiveDiagnostics } from "./ArchiveDiagnostics";
import { ArchiveDocumentReader } from "./ArchiveDocumentReader";
import { ArchiveLibraryImporter } from "./ArchiveLibraryImporter";
import { ArchiveMemoryOverview } from "./ArchiveMemoryOverview";
import { ArchiveRecentActivity } from "./ArchiveRecentActivity";
import { ArchiveReviewDesk } from "./ArchiveReviewDesk";
import { ArchiveSearchPanel } from "./ArchiveSearchPanel";
import { ArchiveSourceScanResults } from "./ArchiveSourceScanResults";
import { ArchiveSourceRegistry } from "./ArchiveSourceRegistry";
import { selectAutoContinuableAiMemoryJob } from "./archive-ai-memory-jobs";

type ArchiveWorkspaceTab = "start" | "review" | "sources" | "search" | "help" | "advanced";

type ArchiveWorkspaceProps = {
  state: ResonantShellState;
  focusTarget?: "review" | null;
  archiveStatusBusy: boolean;
  archiveStatus: ArchiveRuntimeStatus | null;
  archiveSearchBusy: boolean;
  archiveSearchResult: ArchiveSearchResult | null;
  archiveDocumentBusy: boolean;
  archiveDocument: ArchiveDocumentPayload | null;
  archiveQueueBusy: boolean;
  archiveQueue: ArchiveQueuedIngestRequest[];
  archiveReviewArtifacts: ArchiveReviewArtifact[];
  archiveProcessResult: ArchiveProcessIngestResult | null;
  archiveReviewDecisionResult: ArchiveReviewDecisionResult | null;
  archivePromotionResult: ArchivePromoteReviewArtifactResult | null;
  archiveMaintenanceResult: ArchiveMaintenanceCycleResult | null;
  archiveAiMemoryBuildResult: ArchiveAiMemoryBuildResult | null;
  archiveAiMemoryBuildJobs: ArchiveAiMemoryBuildJobSummary[];
  archiveLintResult: ArchiveLintResult | null;
  archiveSemanticLintResult: ArchiveSemanticLintResult | null;
  archiveSourceScanBusy: boolean;
  archiveSourceScanResult: ArchiveSourceFolderScanResult | null;
  archiveImportedLibraries: ArchiveImportedLibrarySummary[];
  archiveClassificationReview: ArchiveLibraryClassificationReview | null;
  archiveReorganisationPlan: ArchiveLibraryReorganisationPlan | null;
  archiveLibraryImportResult: ArchiveLibraryImportResult | null;
  archiveLibraryPreflightResult: ArchiveLibraryPreflightResult | null;
  ingestProbeBusy: boolean;
  ingestProbeResult: {
    probe: ArchiveIngestProbeResult;
    routeLabel: string;
    model: string;
    resolutionReason: string;
  } | null;
  onRefreshArchiveStatus: () => void;
  onRefreshArchiveSourceRegistry: () => void;
  onRefreshArchiveQueue: () => void;
  onRunArchiveSearch: (query: string) => void;
  onOpenArchiveDocument: (path: string) => void;
  onQueueArchiveSource: (source: ArchiveSearchSourceHit) => void;
  onScanSourceFolders: (rootPath?: string) => void;
  onPickLibraryFolder: () => Promise<string | null>;
  onPreflightLibrary: (sourcePath: string) => void;
  onAskAugmentorAboutPreflight: (report: ArchiveLibraryPreflightResult) => void;
  onOpenClassificationReview: (classificationManifestPath: string) => void;
  onGenerateReorganisationPlan: (classificationManifestPath: string) => void;
  onQueueImportedLibraryForIngest: (manifestPath: string) => Promise<void>;
  onImportLibrary: (input: {
    sourcePath: string;
    domain: ArchiveMemoryDomain;
    importMode: ArchiveLibraryImportMode;
    libraryName?: string;
    excludedTopFolders?: string[];
  }) => void;
  onQueueWatchedSource: (source: ArchiveSourceWatchRecord) => void;
  onProcessArchiveRequest: (requestFile: string) => void;
  onApproveReviewArtifact: (artifactFile: string) => void;
  onHumanApproveReviewArtifact: (artifactFile: string) => void;
  onEscalateReviewArtifact: (artifactFile: string) => void;
  onRejectReviewArtifact: (artifactFile: string) => void;
  onHumanRejectReviewArtifact: (artifactFile: string) => void;
  onPromoteReviewArtifact: (artifactFile: string) => void;
  onPromoteApprovedArtifacts: () => Promise<void>;
  onRunArchiveMaintenance: () => Promise<void>;
  onRunArchiveLint: () => void;
  onRunArchiveSemanticLint: () => void;
  onRunIngestProbe: () => void;
  onUpdateArchiveAutomationPolicy: (policy: ArchiveAutomationPolicy) => void;
  onAskAugmentor: (message: string, contextPrompt?: string) => Promise<void>;
  onInspectImportedLibraryCoverage: (library: ArchiveImportedLibrarySummary) => Promise<string>;
  archiveAgentThread: ConversationThread | null;
  archiveAgentBusy: boolean;
  archiveAgentRunPhase: ChatRunPhase;
  archiveAgentActivityLabel: string;
};

export function ArchiveWorkspace({
  state,
  focusTarget,
  archiveStatusBusy,
  archiveStatus,
  archiveSearchBusy,
  archiveSearchResult,
  archiveDocumentBusy,
  archiveDocument,
  archiveQueueBusy,
  archiveQueue,
  archiveReviewArtifacts,
  archiveProcessResult,
  archiveReviewDecisionResult,
  archivePromotionResult,
  archiveMaintenanceResult,
  archiveAiMemoryBuildResult,
  archiveAiMemoryBuildJobs,
  archiveLintResult,
  archiveSemanticLintResult,
  archiveSourceScanBusy,
  archiveSourceScanResult,
  archiveImportedLibraries,
  archiveClassificationReview,
  archiveReorganisationPlan,
  archiveLibraryImportResult,
  archiveLibraryPreflightResult,
  ingestProbeBusy,
  ingestProbeResult,
  onRefreshArchiveStatus,
  onRefreshArchiveSourceRegistry,
  onRefreshArchiveQueue,
  onRunArchiveSearch,
  onOpenArchiveDocument,
  onQueueArchiveSource,
  onScanSourceFolders,
  onPickLibraryFolder,
  onPreflightLibrary,
  onAskAugmentorAboutPreflight,
  onOpenClassificationReview,
  onGenerateReorganisationPlan,
  onQueueImportedLibraryForIngest,
  onImportLibrary,
  onQueueWatchedSource,
  onProcessArchiveRequest,
  onApproveReviewArtifact,
  onHumanApproveReviewArtifact,
  onEscalateReviewArtifact,
  onRejectReviewArtifact,
  onHumanRejectReviewArtifact,
  onPromoteReviewArtifact,
  onPromoteApprovedArtifacts,
  onRunArchiveMaintenance,
  onRunArchiveLint,
  onRunArchiveSemanticLint,
  onRunIngestProbe,
  onUpdateArchiveAutomationPolicy,
  onAskAugmentor,
  onInspectImportedLibraryCoverage,
  archiveAgentThread,
  archiveAgentBusy,
  archiveAgentRunPhase,
  archiveAgentActivityLabel,
}: ArchiveWorkspaceProps) {
  const archiveReady = archiveStatus?.status === "ready";
  const reviewDeskRef = useRef<HTMLDivElement | null>(null);
  const importerRef = useRef<HTMLDivElement | null>(null);
  const runMaintenanceRef = useRef(onRunArchiveMaintenance);
  const continueAiMemoryBuildRef = useRef(onQueueImportedLibraryForIngest);
  const [activeTab, setActiveTab] = useState<ArchiveWorkspaceTab>("start");
  const [importerOpen, setImporterOpen] = useState(false);

  useEffect(() => {
    if (focusTarget !== "review") {
      return;
    }

    setActiveTab("review");
    reviewDeskRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusTarget]);
  const archiveModeLabel = archiveStatus ? `${archiveStatus.mode} mode` : "not loaded";
  const pagesTotal = archiveStatus?.stats?.pagesTotal ?? 0;
  const unprocessedSources = archiveStatus?.stats?.sourcesUnprocessed ?? 0;
  const pendingArtifacts = archiveReviewArtifacts.filter((artifact) => artifact.decision.status === "pending").length;
  const needsWork = archiveQueue.length + pendingArtifacts + unprocessedSources;
  const hasImportedLibraries = archiveImportedLibraries.length > 0;
  const archiveRouteCostPosture = archiveIngestRouteCostPosture(state);
  const importerVisible =
    importerOpen || !hasImportedLibraries || Boolean(archiveLibraryPreflightResult) || Boolean(archiveLibraryImportResult);

  useEffect(() => {
    runMaintenanceRef.current = onRunArchiveMaintenance;
  }, [onRunArchiveMaintenance]);

  useEffect(() => {
    continueAiMemoryBuildRef.current = onQueueImportedLibraryForIngest;
  }, [onQueueImportedLibraryForIngest]);

  useEffect(() => {
    if (!state.archiveAutomationPolicy.autoSyncEnabled) {
      return;
    }

    const runIfWorkExists = () => {
      if (archiveQueueBusy) {
        return;
      }
      const resumableJob = selectAutoContinuableAiMemoryJob(
        archiveAiMemoryBuildJobs,
        state.archiveAutomationPolicy.aiMemoryBuilds,
        archiveRouteCostPosture,
      );
      if (resumableJob) {
        // Intent citation: docs/architecture/ADR-011-living-archive-host-service.md
        continueAiMemoryBuildRef.current(resumableJob.manifestPath);
        return;
      }

      runMaintenanceRef.current();
    };

    const intervalId = window.setInterval(runIfWorkExists, 120_000);
    return () => window.clearInterval(intervalId);
  }, [archiveAiMemoryBuildJobs, archiveQueueBusy, archiveRouteCostPosture, state.archiveAutomationPolicy]);

  const updateArchiveAutomationPolicy = (patch: Partial<ArchiveAutomationPolicy>) => {
    onUpdateArchiveAutomationPolicy({
      ...state.archiveAutomationPolicy,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  };

  const scrollToImporter = () => {
    setActiveTab("start");
    setImporterOpen(true);
    window.requestAnimationFrame(() => {
      importerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <>
      {activeTab !== "start" ? (
        <Panel className="archive-subpage-bar">
          <button type="button" className="button-secondary touch-action" onClick={() => setActiveTab("start")}>
            Back to Living Archive Agent
          </button>
          {activeTab !== "review" && needsWork > 0 ? (
            <button type="button" className="button-secondary touch-action" onClick={() => setActiveTab("review")}>
              Open Review section
            </button>
          ) : null}
          <span className={archiveReady ? "ready" : "warning"}>{archiveReady ? "Archive online" : "Archive needs check"}</span>
          <span>{pagesTotal} trusted page(s)</span>
        </Panel>
      ) : null}

      {activeTab === "start" ? (
        <>
          <ArchiveMemoryOverview
            archiveImportedLibraries={archiveImportedLibraries}
            archiveAiMemoryBuildResult={archiveAiMemoryBuildResult}
            archiveAiMemoryBuildJobs={archiveAiMemoryBuildJobs}
            archiveAutomationPolicy={state.archiveAutomationPolicy}
            archiveStatus={archiveStatus}
            archiveStatusBusy={archiveStatusBusy}
            archiveQueue={archiveQueue}
            archiveReviewArtifacts={archiveReviewArtifacts}
            needsWork={needsWork}
            onOpenSources={() => setActiveTab("sources")}
            onOpenReview={() => setActiveTab("review")}
            onImportAnother={scrollToImporter}
            onBuildAiMemory={onQueueImportedLibraryForIngest}
            onRunArchiveMaintenance={onRunArchiveMaintenance}
            onPromoteApprovedArtifacts={onPromoteApprovedArtifacts}
            onAskAugmentor={onAskAugmentor}
            onInspectImportedLibraryCoverage={onInspectImportedLibraryCoverage}
            archiveAgentThread={archiveAgentThread}
            archiveAgentBusy={archiveAgentBusy || archiveQueueBusy}
            archiveAgentRunPhase={archiveAgentRunPhase}
            archiveAgentActivityLabel={archiveAgentActivityLabel}
          />
          {importerVisible ? (
            <div ref={importerRef}>
              <ArchiveLibraryImporter
                archiveSourceScanBusy={archiveSourceScanBusy}
                archiveLibraryImportResult={archiveLibraryImportResult}
                archiveLibraryPreflightResult={archiveLibraryPreflightResult}
                onPickLibraryFolder={onPickLibraryFolder}
                onPreflightLibrary={onPreflightLibrary}
                onAskAugmentorAboutPreflight={onAskAugmentorAboutPreflight}
                onImportLibrary={onImportLibrary}
              />
            </div>
          ) : null}
          <details className="archive-advanced-tools">
            <summary>Advanced tools</summary>
            <div className="archive-tabs" aria-label="Advanced Living Archive sections">
              {[
                ["review", `Exceptions${needsWork ? ` (${needsWork})` : ""}`],
                ["sources", "Sources"],
                ["search", "Search"],
                ["help", "Help"],
                ["advanced", "Diagnostics"],
              ].map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  aria-label={`Open ${label} section`}
                  onClick={() => setActiveTab(tab as ArchiveWorkspaceTab)}
                >
                  {label}
                </button>
              ))}
              <button type="button" className="button-secondary touch-action" onClick={onRefreshArchiveStatus} disabled={archiveStatusBusy}>
                {archiveStatusBusy ? "Checking..." : archiveReady ? "Archive Online" : "Check Archive"}
              </button>
            </div>
          </details>
        </>
      ) : null}

      {activeTab === "review" ? (
        <div
          ref={reviewDeskRef}
          className={`archive-focus-target ${focusTarget === "review" ? "active" : ""}`}
          aria-label="Focused archive review area"
        >
          {focusTarget === "review" ? (
            <div className="archive-focus-cue" role="status">
              Opened from Obsidian intake history. Review queued notes here before any trusted memory write.
            </div>
          ) : null}
          <ArchiveReviewDesk
            archiveQueueBusy={archiveQueueBusy}
            archiveQueue={archiveQueue}
            archiveReviewArtifacts={archiveReviewArtifacts}
            archiveProcessResult={archiveProcessResult}
            archiveReviewDecisionResult={archiveReviewDecisionResult}
            archivePromotionResult={archivePromotionResult}
            archiveMaintenanceResult={archiveMaintenanceResult}
            archiveAiMemoryBuildResult={archiveAiMemoryBuildResult}
            archiveAiMemoryBuildJobs={archiveAiMemoryBuildJobs}
            archiveAutomationPolicy={state.archiveAutomationPolicy}
            archiveAiMemoryRouteCostPosture={archiveRouteCostPosture}
            onRefreshArchiveQueue={onRefreshArchiveQueue}
            onProcessArchiveRequest={onProcessArchiveRequest}
            onApproveReviewArtifact={onApproveReviewArtifact}
            onHumanApproveReviewArtifact={onHumanApproveReviewArtifact}
            onEscalateReviewArtifact={onEscalateReviewArtifact}
            onRejectReviewArtifact={onRejectReviewArtifact}
            onHumanRejectReviewArtifact={onHumanRejectReviewArtifact}
            onPromoteReviewArtifact={onPromoteReviewArtifact}
            onPromoteApprovedArtifacts={onPromoteApprovedArtifacts}
            onUpdateArchiveAutomationPolicy={updateArchiveAutomationPolicy}
            onRunArchiveMaintenance={onRunArchiveMaintenance}
            onContinueAiMemoryBuild={onQueueImportedLibraryForIngest}
          />
          {archiveClassificationReview ? (
            <ArchiveClassificationReviewPanel
              review={archiveClassificationReview}
              plan={archiveReorganisationPlan}
              busy={archiveSourceScanBusy}
              onGenerateReorganisationPlan={onGenerateReorganisationPlan}
            />
          ) : null}
        </div>
      ) : null}

      {activeTab === "sources" ? (
        <>
          <ArchiveSourceRegistry
            archiveStatus={archiveStatus}
            archiveSourceScanBusy={archiveSourceScanBusy}
            archiveSourceScanResult={archiveSourceScanResult}
            archiveImportedLibraries={archiveImportedLibraries}
            archiveAiMemoryBuildResult={archiveAiMemoryBuildResult}
            onRefreshArchiveSourceRegistry={onRefreshArchiveSourceRegistry}
            onScanSourceFolders={onScanSourceFolders}
            onOpenClassificationReview={onOpenClassificationReview}
            onQueueImportedLibraryForIngest={onQueueImportedLibraryForIngest}
          />
          {archiveClassificationReview ? (
            <ArchiveClassificationReviewPanel
              review={archiveClassificationReview}
              plan={archiveReorganisationPlan}
              busy={archiveSourceScanBusy}
              onGenerateReorganisationPlan={onGenerateReorganisationPlan}
            />
          ) : null}
          <ArchiveSourceScanResults
            archiveSourceScanResult={archiveSourceScanResult}
            archiveQueueBusy={archiveQueueBusy}
            onOpenArchiveDocument={onOpenArchiveDocument}
            onQueueWatchedSource={onQueueWatchedSource}
          />
        </>
      ) : null}

      {activeTab === "search" ? (
        <>
          <ArchiveSearchPanel
            archiveSearchBusy={archiveSearchBusy}
            archiveSearchResult={archiveSearchResult}
            onRunArchiveSearch={onRunArchiveSearch}
            onOpenArchiveDocument={onOpenArchiveDocument}
            onQueueArchiveSource={onQueueArchiveSource}
          />
          <section className="archive-secondary-grid">
            <ArchiveDocumentReader archiveDocumentBusy={archiveDocumentBusy} archiveDocument={archiveDocument} />
            <ArchiveRecentActivity archiveStatus={archiveStatus} />
          </section>
        </>
      ) : null}

      {activeTab === "help" ? <ArchiveHelpPanel /> : null}

      {activeTab === "advanced" ? (
        <>
          <div className="archive-command-metrics compact" aria-label="Advanced archive status summary">
            <ArchiveMetric label="Status" value={archiveReady ? "Archive online" : "Archive needs check"} meta={archiveModeLabel} tone={archiveReady ? "ready" : "warning"} />
            <ArchiveMetric label="Wiki Pages" value={String(pagesTotal)} meta={archiveStatus?.wikiRoot ?? "runtime not loaded"} />
            <ArchiveMetric label="Needs Work" value={String(needsWork)} meta={`${archiveQueue.length} queued · ${pendingArtifacts} review · ${unprocessedSources} sources`} />
          </div>
          <ArchiveDiagnostics
            state={state}
            archiveStatus={archiveStatus}
            archiveQueueBusy={archiveQueueBusy}
            archiveLintResult={archiveLintResult}
            archiveSemanticLintResult={archiveSemanticLintResult}
            ingestProbeBusy={ingestProbeBusy}
            ingestProbeResult={ingestProbeResult}
            onRunArchiveLint={onRunArchiveLint}
            onRunArchiveSemanticLint={onRunArchiveSemanticLint}
            onRunIngestProbe={onRunIngestProbe}
          />
        </>
      ) : null}
    </>
  );
}

function archiveIngestRouteCostPosture(state: ResonantShellState): ProviderCostPosture | undefined {
  return state.modelStrategy.workloadStrategies.find(
    (strategy) => strategy.ownerType === "workload" && strategy.ownerId === "archive-ingest",
  )?.primaryRoute.costPosture;
}

function ArchiveHelpPanel() {
  return (
    <Panel className="archive-help-panel" title="How The Living Archive Works" subtitle="The short version, without diagnostics.">
      <div className="archive-help-sections">
        <section>
          <h3>What it is</h3>
          <p>
            Human Knowledge is preserved; AI Memory is the maintained wiki. The Living Archive keeps your original material
            safe, then helps Augmentor maintain organised AI-readable knowledge after review.
          </p>
        </section>
        <section>
          <h3>How to use it</h3>
          <ol>
            <li>Start with any folder. Obsidian-compatible vaults are optional.</li>
            <li>Let ResonantOS analyse what can be imported and what should stay out.</li>
            <li>Ask Augmentor to review the plan if anything is unclear.</li>
            <li>Import the recommended plan, then review proposed knowledge before it becomes AI Memory.</li>
          </ol>
        </section>
        <section>
          <h3>Why the separation matters</h3>
          <p>
            Human Knowledge, External Knowledge, and AI Memory stay separate so ResonantOS does not confuse your own identity and
            thinking with research, meeting material, project files, or AI-generated synthesis.
          </p>
        </section>
        <section>
          <h3>Add-ons</h3>
          <p>
            Obsidian is optional. When the Resonant Notes add-on is installed, it can manage markdown and vault workflows
            over the same memory files; the base Living Archive still works with ordinary folders.
          </p>
        </section>
      </div>
    </Panel>
  );
}

function ArchiveMetric({
  label,
  value,
  meta,
  tone,
}: {
  label: string;
  value: string;
  meta: string;
  tone?: "ready" | "warning";
}) {
  return (
    <div className={`archive-command-metric ${tone ?? ""}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{meta}</p>
    </div>
  );
}
