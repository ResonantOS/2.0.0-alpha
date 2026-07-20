// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-022-portable-user-state-secure-vault.md
// Intent citation: docs/architecture/ADR-027-living-archive-llm-wiki-compliance.md

import { useEffect, useRef, useState } from "react";
import type {
  ArchiveAiMemoryBuildJobSummary,
  ArchiveAiMemoryBuildResult,
  ArchiveAutomationPolicy,
  ArchiveImportedLibrarySummary,
  ArchiveQueuedIngestRequest,
  ArchiveReviewArtifact,
  ArchiveRuntimeStatus,
  ChatRunPhase,
  ConversationThread,
} from "../../core/contracts";
import { Panel } from "../../components/Panel";
import { MessageContent } from "../chat/MessageContent";
import { selectArchiveRecommendedAction, selectLatestArchiveBuild } from "./archive-action-center";
import { shouldInspectImportedLibraryCoverage } from "./archive-agent-tools";

type ArchiveMemoryOverviewProps = {
  archiveImportedLibraries: ArchiveImportedLibrarySummary[];
  archiveAiMemoryBuildResult: ArchiveAiMemoryBuildResult | null;
  archiveAiMemoryBuildJobs: ArchiveAiMemoryBuildJobSummary[];
  archiveAutomationPolicy: ArchiveAutomationPolicy;
  archiveStatus: ArchiveRuntimeStatus | null;
  archiveStatusBusy: boolean;
  archiveQueue: ArchiveQueuedIngestRequest[];
  archiveReviewArtifacts: ArchiveReviewArtifact[];
  needsWork: number;
  onOpenSources: () => void;
  onOpenReview: () => void;
  onImportAnother: () => void;
  onBuildAiMemory: (manifestPath: string) => Promise<void>;
  onRunArchiveMaintenance: () => Promise<void>;
  onPromoteApprovedArtifacts: () => Promise<void>;
  onAskAugmentor: (message: string, contextPrompt?: string) => Promise<void>;
  onInspectImportedLibraryCoverage: (library: ArchiveImportedLibrarySummary) => Promise<string>;
  archiveAgentThread: ConversationThread | null;
  archiveAgentBusy: boolean;
  archiveAgentRunPhase: ChatRunPhase;
  archiveAgentActivityLabel: string;
};

export function ArchiveMemoryOverview({
  archiveImportedLibraries,
  archiveAiMemoryBuildResult,
  archiveAiMemoryBuildJobs,
  archiveAutomationPolicy,
  archiveStatus,
  archiveStatusBusy,
  archiveQueue,
  archiveReviewArtifacts,
  needsWork,
  onOpenSources,
  onOpenReview,
  onImportAnother,
  onBuildAiMemory,
  onRunArchiveMaintenance,
  onPromoteApprovedArtifacts,
  onAskAugmentor,
  onInspectImportedLibraryCoverage,
  archiveAgentThread,
  archiveAgentBusy,
  archiveAgentRunPhase,
  archiveAgentActivityLabel,
}: ArchiveMemoryOverviewProps) {
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [agentActionBusy, setAgentActionBusy] = useState(false);
  const dialogueEndRef = useRef<HTMLDivElement | null>(null);
  const latestLibrary = archiveImportedLibraries[0];
  const latestBuild = selectLatestArchiveBuild(latestLibrary, archiveAiMemoryBuildResult, archiveAiMemoryBuildJobs);
  const recommendedAction = selectArchiveRecommendedAction({
    latestLibrary,
    latestBuild,
    archiveQueue,
    archiveReviewArtifacts,
  });
  const filesImported = archiveImportedLibraries.reduce((total, library) => total + library.filesImported, 0);
  const trustedPages = archiveStatus?.stats?.pagesTotal ?? 0;
  const unprocessedSources = archiveStatus?.stats?.sourcesUnprocessed ?? 0;
  const pendingReview = archiveReviewArtifacts.filter((artifact) => artifact.decision.status === "pending").length;
  const approvedUnpromoted = archiveReviewArtifacts.filter(
    (artifact) =>
      artifact.decision.status === "approved" &&
      artifact.promotion?.status !== "promoted" &&
      artifact.proposedPages.length > 0,
  ).length;
  const latestBuildStatus =
    latestBuild?.status === "ready-to-promote" ? "ready for AI Memory update" : (latestBuild?.status ?? "not-started").replaceAll("-", " ");

  useEffect(() => {
    dialogueEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [archiveAgentThread?.messages.length, archiveAgentBusy, agentStatus]);

  const runRecommendedAction = async ({ keepStatus = false }: { keepStatus?: boolean } = {}): Promise<string> => {
    setAgentActionBusy(true);
    setAgentStatus(`${recommendedAction.buttonLabel} is running...`);
    try {
      switch (recommendedAction.kind) {
        case "import":
          onImportAnother();
          return "I opened the folder import flow.";
        case "build":
        case "continue":
        case "repair":
          if (recommendedAction.manifestPath) {
            await onBuildAiMemory(recommendedAction.manifestPath);
            return `I ran ${recommendedAction.buttonLabel}.`;
          }
          return "I could not run the AI Memory action because no import manifest is available.";
        case "promote":
          await onPromoteApprovedArtifacts();
          return "I updated AI Memory with the approved archive work.";
        case "maintenance":
          await onRunArchiveMaintenance();
          return "I ran Living Archive maintenance.";
        case "review-exceptions":
          onOpenReview();
          return "I opened the exceptions that need human judgment.";
        case "complete":
          onOpenSources();
          return "I opened the current archive structure.";
      }
    } finally {
      setAgentActionBusy(false);
      if (!keepStatus) {
        setAgentStatus(`${recommendedAction.buttonLabel} finished.`);
      }
    }
  };
  const askAugmentor = async () => {
    const message = agentPrompt.trim();
    if (!message) {
      return;
    }
    setAgentStatus("Asking Augmentor inside this workspace...");
    setAgentPrompt("");
    const inspectionContext =
      latestLibrary && shouldInspectImportedLibraryCoverage(message)
        ? await runCoverageInspection(latestLibrary)
        : null;
    try {
      await onAskAugmentor(
        message,
        [
          "Living Archive workspace context for this turn:",
          "You are helping me configure the Living Archive in ResonantOS.",
          "Do the work for me where possible. Ask only one necessary question at a time.",
          "This conversation is happening inside the Living Archive workspace. Do not tell the user to move to the right chat rail.",
          "Do not claim you will run a check, listing, scan, import, repair, or archive operation unless the host has already returned that result in this turn.",
          "If host inspection results are supplied below, answer from those results and clearly separate imported, skipped, unsupported, and genuinely missing coverage.",
          latestLibrary
            ? `Current imported library: ${latestLibrary.libraryName} at ${latestLibrary.canonicalRoot}.`
            : "No library is imported yet.",
          `Recommended next action from the archive system: ${recommendedAction.title}. ${recommendedAction.description}`,
          inspectionContext ? `\n${inspectionContext}` : "",
        ].join("\n"),
      );
    } finally {
      setAgentStatus(null);
    }
  };
  const runCoverageInspection = async (library: ArchiveImportedLibrarySummary): Promise<string> => {
    setAgentStatus(`Inspecting ${library.libraryName} folder coverage before Augmentor answers...`);
    try {
      return await onInspectImportedLibraryCoverage(library);
    } catch (error) {
      return `Host archive coverage inspection failed before Augmentor answered: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  };
  const working = archiveAgentBusy || agentActionBusy;
  const idleStatus = latestLibrary
    ? `Ready. Next: ${recommendedAction.buttonLabel}.`
    : "Ready. Add a folder to start building your memory.";
  const visibleStatus =
    agentStatus ??
    (archiveAgentBusy
      ? archiveAgentActivityLabel || (archiveAgentRunPhase === "idle" ? "Augmentor is working..." : archiveAgentRunPhase)
      : idleStatus);

  return (
    <Panel className="archive-memory-overview-panel">
      <section className="archive-agent-workspace" aria-label="Living Archive Agent workspace">
        <div className="archive-agent-chat-card">
          <div className="archive-agent-console-head">
            <span className="archive-agent-orb" aria-hidden="true" />
            <div>
              <span className="eyebrow">Living Archive Agent</span>
              <h3>Human Knowledge is preserved; AI Memory is the maintained wiki.</h3>
            </div>
          </div>

          <div className="archive-agent-dialogue" aria-label="Living Archive Agent conversation">
            {archiveAgentThread?.messages.length ? (
              archiveAgentThread.messages.slice(-8).map((message) => {
                const content =
                  message.role === "user" ? visibleArchiveUserMessage(message.content) : message.content;
                return (
                  <article key={message.id} className={`archive-agent-message ${message.role}`}>
                    <strong>{message.role === "user" ? "You" : message.author}</strong>
                    <MessageContent content={content} />
                  </article>
                );
              })
            ) : (
              <article className="archive-agent-message assistant">
                <strong>Augmentor</strong>
                <MessageContent content="I can connect any knowledge folder, keep the original material safe, and maintain the AI Memory wiki after review. Obsidian-compatible vaults are optional; they are just one way to work with the same memory files." />
              </article>
            )}
            {working ? (
              <article className="archive-agent-message assistant thinking">
                <strong>Augmentor</strong>
                <MessageContent content={visibleStatus} />
              </article>
            ) : null}
            <div ref={dialogueEndRef} />
          </div>

          <form
            className="archive-agent-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void askAugmentor();
            }}
          >
            <textarea
              aria-label="Ask Augmentor to configure the Living Archive"
              value={agentPrompt}
              onChange={(event) => setAgentPrompt(event.target.value)}
              placeholder="Ask Augmentor what to do with this archive..."
              rows={2}
            />
            <div className="archive-agent-composer-actions">
              <button type="button" className="button-secondary touch-action" onClick={onImportAnother}>
                Add Folder
              </button>
              <button type="button" className="button-secondary touch-action" onClick={() => void runRecommendedAction()} disabled={working}>
                {agentActionBusy ? "Working..." : recommendedAction.buttonLabel}
              </button>
              <button type="submit" className="button-primary touch-action" aria-label="Ask Augmentor from Living Archive Agent" disabled={working || !agentPrompt.trim()}>
                Send
              </button>
            </div>
          </form>

          <div className={`archive-agent-live-status ${working ? "active" : ""}`} role="status" aria-live="polite">
            <span className="archive-agent-pulse" aria-hidden="true" />
            <p>{visibleStatus}</p>
          </div>
        </div>

        <section className="archive-setup-dashboard" aria-label="Living Archive setup status">
          <header className="archive-setup-dashboard-head">
            <div>
              <span className="eyebrow">Setup check</span>
              <h4>Current memory configuration</h4>
            </div>
            <span className={latestLibrary ? "archive-setup-pill ready" : "archive-setup-pill warning"}>
              {latestLibrary ? "Connected" : "Needs folder"}
            </span>
          </header>

          <div className="archive-setup-grid">
            <SetupCard
              label="Source"
              value={latestLibrary?.libraryName ?? "No folder connected"}
              detail={latestLibrary ? `${filesImported.toLocaleString()} managed file(s)` : "Add any folder once. Obsidian-compatible vaults are optional."}
              actionLabel="Add Folder"
              onAction={onImportAnother}
            />
            <SetupCard
              label="Storage"
              value={archiveStatus?.portableUserState.memoryRoot ? "Portable memory root" : "Waiting for archive status"}
              detail={archiveStatus?.portableUserState.memoryRoot ?? "Check Archive will load the managed ResonantOS_User/Memory location."}
              actionLabel="Sources"
              onAction={onOpenSources}
            />
            <SetupCard
              label="AI Memory"
              value={`${trustedPages.toLocaleString()} trusted page(s)`}
              detail={`${latestBuildStatus} · ${needsWork.toLocaleString()} item(s) need attention · ${unprocessedSources.toLocaleString()} raw source(s) unprocessed`}
              actionLabel={recommendedAction.buttonLabel}
              onAction={() => void runRecommendedAction()}
              disabled={working}
            />
            <SetupCard
              label="Automation"
              value={archiveAutomationPolicy.autoSyncEnabled ? "Auto maintenance on" : "Manual control"}
              detail={`AI builds: ${archiveAutomationPolicy.aiMemoryBuilds}. Pending review: ${pendingReview}. Ready for AI Memory update: ${approvedUnpromoted}.`}
              actionLabel={archiveStatusBusy ? "Checking..." : "Review"}
              onAction={onOpenReview}
              disabled={archiveStatusBusy}
            />
          </div>

          {latestLibrary ? (
            <details className="archive-agent-memory-details">
              <summary>Show managed source path</summary>
              <p>{latestLibrary.canonicalRoot}</p>
            </details>
          ) : null}
        </section>
      </section>
    </Panel>
  );
}

const visibleArchiveUserMessage = (content: string): string => {
  const requestMatch = content.match(/(?:^|\n)My request:\s*([\s\S]+)$/i);
  if (requestMatch?.[1]?.trim()) {
    return requestMatch[1].trim();
  }
  return content;
};

function SetupCard({
  label,
  value,
  detail,
  actionLabel,
  onAction,
  disabled = false,
}: {
  label: string;
  value: string;
  detail: string;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <article className="archive-setup-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
      <button type="button" className="button-secondary touch-action" onClick={onAction} disabled={disabled}>
        {actionLabel}
      </button>
    </article>
  );
}
