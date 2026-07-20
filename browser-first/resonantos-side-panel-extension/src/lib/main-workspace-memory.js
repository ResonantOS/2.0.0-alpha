// Intent citation: docs/architecture/ADR-037-browser-first-chromium-resonantos.md
// Intent citation: docs/architecture/ADR-027-living-archive-llm-wiki-compliance.md

import { singleFileIntakeContent } from "./memory-single-file-intake.js";
import {
  sourceArtifactPreviewCard,
  sourceCard,
  sourceDiffCard,
  sourceMoveHistoryPanel,
  sourceRepairHistoryPanel,
  sourceReviewCard,
  sourceSyncHistoryPanel,
  sourceVersionsCard,
  wikiPagePreviewCard
} from "./memory-source-renderers.js";
import {
  promotionCard,
  reviewRequestCard,
  reviewRequestNextAction
} from "./memory-review-renderers.js";
import {
  formatCount,
  memoryMetric,
  memoryResultCard,
  promotionMatchesHandoff,
  reviewMatchesHandoff,
  setMemoryStatus,
  wikiHealthCard
} from "./main-workspace-memory-dom.js";
import { createLivingArchiveLayout } from "./main-workspace-memory-layout.js";

export { reviewRequestNextAction } from "./memory-review-renderers.js";

export function renderLivingArchiveWorkspace({
  container,
  bridgeRequest,
  // Optional getter for the late-bound bridge client. The extension's
  // rebind chain sets the module-level `bridgeRequest` *after* this
  // workspace is constructed, so passing a value here captures a
  // stale `null`. When a getter is provided, it wins.
  getBridgeRequest,
  initialQuery = "",
  initialReviewPath = "",
  initialArtifactPath = "",
  initialPromotedPage = ""
}) {
  // Resolve at call time. Falls back to the captured value.
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const {
    contentInput,
    draftPreview,
    fileInput,
    intakeButton,
    intakeForm,
    intakeStatus,
    metrics,
    promotionList,
    promotionPreview,
    promotionStatus,
    refreshPromotions,
    refreshReview,
    refreshSources,
    reviewList,
    reviewStatus,
    runSourceSync,
    searchForm,
    searchButton,
    searchInput,
    searchResults,
    searchStatus,
    sourceFilterCount,
    sourceList,
    sourceMoveHistory,
    sourcePreview,
    sourceRepairHistory,
    sourceStateFilter,
    sourceStatus,
    sourceSyncHistory,
    sourceTextFilter,
    titleInput,
    wikiHealthPanel,
  } = createLivingArchiveLayout({ container });

  const loadStatus = async () => {
    try {
      const status = await bridge()("/memory/status", { method: "GET" });
      const [wikiPages, intakeArtifacts, reviewWork] = metrics.querySelectorAll(".memory-metric strong");
      const [wikiMeta, intakeMeta, reviewMeta] = metrics.querySelectorAll(".memory-metric small");
      wikiPages.textContent = formatCount(status.wiki?.pages);
      intakeArtifacts.textContent = formatCount(status.intake?.artifacts);
      reviewWork.textContent = formatCount(Number(status.review?.requests ?? 0) + Number(status.review?.artifacts ?? 0));
      wikiMeta.textContent = status.wiki?.index?.exists ? "ready to search" : "index needs repair";
      intakeMeta.textContent = status.exists ? "source vault active" : "memory root missing";
      reviewMeta.textContent = `${formatCount(status.review?.requests)} requests · ${formatCount(status.review?.artifacts)} drafts`;
    } catch (error) {
      metrics.append(memoryMetric("Status", "Unavailable", error instanceof Error ? error.message : String(error)));
    }
  };

  const loadWikiHealth = async () => {
    try {
      const health = await bridge()("/memory/wiki/health", { method: "GET" });
      const card = wikiHealthCard(health, () => {
        wikiHealthPanel.replaceChildren();
        wikiHealthPanel.textContent = "Refreshing wiki health…";
        void loadWikiHealth();
      }, async () => {
        wikiHealthPanel.replaceChildren();
        wikiHealthPanel.textContent = "Running wiki lint and writing review artifact…";
        try {
          const result = await bridge()("/memory/wiki/lint", {
            method: "POST",
            capability: "memory-source-review",
            body: { reason: "Manual Living Archive workspace lint" }
          });
          wikiHealthPanel.textContent = `Wiki lint saved: ${result.relativeArtifactPath || result.artifactPath || "review artifact"}`;
          await loadWikiHealth();
        } catch (error) {
          wikiHealthPanel.textContent = `Wiki lint failed: ${error instanceof Error ? error.message : String(error)}`;
          wikiHealthPanel.dataset.tone = "error";
        }
      });
      wikiHealthPanel.dataset.tone = card.querySelector(".memory-status")?.dataset.tone ?? "neutral";
      wikiHealthPanel.replaceChildren(...card.childNodes);
    } catch (error) {
      wikiHealthPanel.textContent = `Wiki health unavailable: ${error instanceof Error ? error.message : String(error)}`;
      wikiHealthPanel.dataset.tone = "error";
    }
  };

  const loadReviewQueue = async () => {
    refreshReview.disabled = true;
    reviewList.replaceChildren();
    setMemoryStatus(reviewStatus, "Loading review queue…");
    try {
      const result = await bridge()("/archive/review/list", {
        method: "POST",
        body: { limit: 12 }
      });
      const requests = Array.isArray(result.requests) ? result.requests : [];
      if (!requests.length) {
        setMemoryStatus(reviewStatus, "No pending review requests. Browser artifacts can request review from the Artifacts workspace.", "warning");
        return;
      }
      const focusedRequest = requests.find((request) => reviewMatchesHandoff(request, { initialReviewPath, initialArtifactPath }));
      reviewList.append(...requests.map((request) => reviewRequestCard(
        request,
        transitionReviewRequest,
        draftReviewRequest,
        previewDraftArtifact,
        previewSourceArtifact,
        previewReviewPromotedPage,
        { focused: reviewMatchesHandoff(request, { initialReviewPath, initialArtifactPath }) }
      )));
      if (focusedRequest) {
        setMemoryStatus(reviewStatus, `Focused review request: ${focusedRequest.path}. Inspect the preserved source, then draft, verify, and promote only if it belongs in AI Memory.`, "success");
        queueMicrotask(async () => {
          reviewList.querySelector('[data-focused="true"]')?.scrollIntoView?.({ block: "center", behavior: "smooth" });
          if (focusedRequest.artifactPath) {
            await previewSourceArtifact(focusedRequest);
            setMemoryStatus(reviewStatus, `Focused review request: ${focusedRequest.path}. Source preview loaded; draft only after checking the preserved evidence.`, "success");
          }
        });
      } else if (initialReviewPath || initialArtifactPath) {
        setMemoryStatus(reviewStatus, `Review queue loaded, but the requested handoff is not in the first ${requests.length} item(s). Use Refresh or search memory history if it was already processed.`, "warning");
      } else {
        setMemoryStatus(reviewStatus, `${requests.length} review request(s) waiting in ${result.root}.`, "success");
      }
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    } finally {
      refreshReview.disabled = false;
    }
  };

  const loadPromotionHistory = async () => {
    refreshPromotions.disabled = true;
    promotionList.replaceChildren();
    promotionPreview.hidden = true;
    promotionPreview.replaceChildren();
    setMemoryStatus(promotionStatus, "Loading promotion history…");
    try {
      const result = await bridge()("/archive/review/promotions/list", {
        method: "POST",
        body: { limit: 10 }
      });
      const promotions = Array.isArray(result.promotions) ? result.promotions : [];
      if (!promotions.length) {
        setMemoryStatus(promotionStatus, "No promoted wiki updates yet.", "warning");
        return;
      }
      const focusedPromotion = promotions.find((entry) => promotionMatchesHandoff(entry, { initialReviewPath, initialPromotedPage }));
      promotionList.append(...promotions.map((entry) => promotionCard(
        entry,
        restorePromotionBackup,
        previewPromotedPage,
        { focused: promotionMatchesHandoff(entry, { initialReviewPath, initialPromotedPage }) }
      )));
      if (focusedPromotion) {
        setMemoryStatus(promotionStatus, `Focused promoted page: ${focusedPromotion.promotedPage}. Previewing trusted AI Memory below.`, "success");
        queueMicrotask(async () => {
          promotionList.querySelector('[data-focused="true"]')?.scrollIntoView?.({ block: "center", behavior: "smooth" });
          await previewPromotedPage(focusedPromotion, { handoff: true });
        });
      } else {
        setMemoryStatus(promotionStatus, `${promotions.length} promoted wiki update(s) in ${result.root}.`, "success");
      }
    } catch (error) {
      setMemoryStatus(promotionStatus, error instanceof Error ? error.message : String(error), "error");
    } finally {
      refreshPromotions.disabled = false;
    }
  };

  let connectedSources = [];
  let sourceSyncHistoryEntries = [];
  let sourceRepairHistoryEntries = [];
  let sourceMoveHistoryEntries = [];

  const renderSourceList = () => {
    sourceList.replaceChildren();
    sourceSyncHistory.replaceChildren(sourceSyncHistoryPanel(sourceSyncHistoryEntries));
    sourceRepairHistory.replaceChildren(sourceRepairHistoryPanel(sourceRepairHistoryEntries));
    sourceMoveHistory.replaceChildren(sourceMoveHistoryPanel(sourceMoveHistoryEntries));
    const state = sourceStateFilter.value;
    const query = sourceTextFilter.value.trim().toLowerCase();
    const visible = connectedSources.filter((source) => {
      const sourceState = source.disabledAt ? "disabled" : source.exists ? "active" : "missing";
      const text = `${source.path ?? ""} ${source.kind ?? ""} ${source.ownership ?? ""} ${source.importMode ?? ""}`.toLowerCase();
      return (state === "all" || sourceState === state) && (!query || text.includes(query));
    });
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "memory-status";
      empty.dataset.tone = connectedSources.length ? "warning" : "neutral";
      empty.textContent = connectedSources.length
        ? "No connected sources match the current filters."
        : "No connected sources. Add folders or Obsidian vaults in Settings > Memory.";
      sourceList.append(empty);
    } else {
      sourceList.append(...visible.map((source) => sourceCard(source, reviewSource, createSourceIntake, showSourceVersions)));
    }
    sourceFilterCount.textContent = `${visible.length}/${connectedSources.length} source(s) visible`;
    setMemoryStatus(
      sourceStatus,
      connectedSources.length
        ? `${visible.length}/${connectedSources.length} connected source(s) visible. Review before creating governed intake.`
        : "No connected sources. Add folders or Obsidian vaults in Settings > Memory.",
      connectedSources.length ? "success" : "warning"
    );
  };

  const loadSources = async () => {
    refreshSources.disabled = true;
    sourceList.replaceChildren();
    sourcePreview.replaceChildren();
    setMemoryStatus(sourceStatus, "Loading connected sources…");
    try {
      const result = await bridge()("/memory/settings", { method: "GET" });
      connectedSources = result.settings?.sources ?? [];
      sourceSyncHistoryEntries = result.syncHistory ?? [];
      sourceRepairHistoryEntries = result.sourceRepairHistory ?? [];
      sourceMoveHistoryEntries = result.sourceMoveHistory ?? [];
      renderSourceList();
    } catch (error) {
      setMemoryStatus(sourceStatus, error instanceof Error ? error.message : String(error), "error");
    } finally {
      refreshSources.disabled = false;
    }
  };

  sourceStateFilter.addEventListener("change", renderSourceList);
  sourceTextFilter.addEventListener("input", renderSourceList);

  runSourceSync.addEventListener("click", async () => {
    runSourceSync.disabled = true;
    refreshSources.disabled = true;
    setMemoryStatus(sourceStatus, "Running governed source sync…");
    try {
      const result = await bridge()("/memory/source/sync", {
        method: "POST",
        capability: "memory-source-file-intake",
        body: { limit: 2_000 }
      });
      const settingsResult = await bridge()("/memory/settings", { method: "GET" });
      connectedSources = settingsResult.settings?.sources ?? connectedSources;
      sourceSyncHistoryEntries = settingsResult.syncHistory ?? sourceSyncHistoryEntries;
      sourceRepairHistoryEntries = settingsResult.sourceRepairHistory ?? sourceRepairHistoryEntries;
      sourceMoveHistoryEntries = settingsResult.sourceMoveHistory ?? sourceMoveHistoryEntries;
      renderSourceList();
      if (result.status === "paused") {
        setMemoryStatus(sourceStatus, "Memory source sync is paused. Change sync mode in Settings > Memory before running sync.", "warning");
      } else if (result.autoIntake) {
        setMemoryStatus(
          sourceStatus,
          `Sync reviewed ${formatCount(result.reviewedSources)} source(s), created ${formatCount(result.createdArtifacts)} intake artifact(s), and queued ${formatCount(result.reviewRequests)} review request(s).`,
          "success"
        );
        await loadStatus();
        await loadReviewQueue();
      } else {
        setMemoryStatus(
          sourceStatus,
          `Sync reviewed ${formatCount(result.reviewedSources)} source(s) and found ${formatCount(result.eligibleFiles)} new/changed file(s).`,
          "success"
        );
      }
    } catch (error) {
      setMemoryStatus(sourceStatus, error instanceof Error ? error.message : String(error), "error");
    } finally {
      runSourceSync.disabled = false;
      refreshSources.disabled = false;
    }
  });

  const reviewSource = async (source) => {
    sourcePreview.replaceChildren();
    setMemoryStatus(sourceStatus, `Reviewing ${source.path || source.id}…`);
    try {
      const result = await bridge()("/memory/source/review", {
        method: "POST",
        capability: "memory-source-review",
        body: { sourceId: source.id, limit: 2_000 }
      });
      sourcePreview.replaceChildren(sourceReviewCard(result, createSelectedFileIntake, (candidate) => {
        void previewSourceDiff(result.source, candidate);
      }, repairSourceVersions));
      setMemoryStatus(sourceStatus, `Source review ready: ${result.candidates?.length ?? 0} candidate file(s).`, "success");
    } catch (error) {
      setMemoryStatus(sourceStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const previewSourceDiff = async (source, candidate) => {
    if (!source?.id || !candidate?.path) {
      setMemoryStatus(sourceStatus, "Source diff requires a source and candidate file.", "error");
      return;
    }
    setMemoryStatus(sourceStatus, `Loading diff for ${candidate.path}…`);
    try {
      const result = await bridge()("/memory/source/diff", {
        method: "POST",
        capability: "memory-source-review",
        body: {
          sourceId: source.id,
          file: candidate.path,
          limit: 80
        }
      });
      sourcePreview.append(sourceDiffCard(result));
      setMemoryStatus(sourceStatus, `Diff ready for ${candidate.path}: ${result.status}.`, "success");
    } catch (error) {
      setMemoryStatus(sourceStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const repairSourceVersions = async (review) => {
    if (!review.source?.id) {
      setMemoryStatus(sourceStatus, "Source version repair requires a source id.", "error");
      return;
    }
    setMemoryStatus(sourceStatus, "Repairing source version tracking…");
    try {
      const result = await bridge()("/memory/source/versions/repair", {
        method: "POST",
        capability: "memory-source-manage",
        body: {
          sourceId: review.source.id,
          confirmation: "REPAIR SOURCE VERSIONS"
        }
      });
      const refreshedReview = await bridge()("/memory/source/review", {
        method: "POST",
        capability: "memory-source-review",
        body: { sourceId: review.source.id, limit: 2_000 }
      });
      sourcePreview.replaceChildren(sourceReviewCard(refreshedReview, createSelectedFileIntake, (candidate) => {
        void previewSourceDiff(refreshedReview.source, candidate);
      }, repairSourceVersions));
      const settingsResult = await bridge()("/memory/settings", { method: "GET" });
      connectedSources = settingsResult.settings?.sources ?? connectedSources;
      sourceSyncHistoryEntries = settingsResult.syncHistory ?? sourceSyncHistoryEntries;
      sourceRepairHistoryEntries = settingsResult.sourceRepairHistory ?? sourceRepairHistoryEntries;
      renderSourceList();
      setMemoryStatus(
        sourceStatus,
        result.status === "repaired"
          ? `Source version tracking repaired. Backup: ${result.backupPath}. Review refreshed before intake.`
          : result.message || `Source version repair status: ${result.status}.`,
        result.status === "healthy" || result.status === "not-needed" ? "warning" : "success"
      );
    } catch (error) {
      setMemoryStatus(sourceStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const showSourceVersions = async (source) => {
    sourcePreview.replaceChildren();
    setMemoryStatus(sourceStatus, `Loading source versions for ${source.path || source.id}…`);
    try {
      const result = await bridge()("/memory/source/versions", {
        method: "POST",
        body: { sourceId: source.id, limit: 100 }
      });
      sourcePreview.replaceChildren(sourceVersionsCard(source, result));
      setMemoryStatus(sourceStatus, `${result.entries?.length ?? 0} imported source-file version record(s).`, "success");
    } catch (error) {
      setMemoryStatus(sourceStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const createSelectedFileIntake = async (review, files) => {
    if (!files.length) {
      setMemoryStatus(sourceStatus, "Select one or more compatible source files first.", "warning");
      return;
    }
    setMemoryStatus(sourceStatus, `Creating governed intake from ${files.length} selected file(s)…`);
    try {
      const result = await bridge()("/memory/source/file-intake", {
        method: "POST",
        capability: "memory-source-file-intake",
        body: {
          sourceId: review.source?.id,
          files
        }
      });
      for (const created of result.created ?? []) {
        await bridge()("/archive/review/request", {
          method: "POST",
          body: {
            path: created.path,
            reason: `Review selected source file ${created.sourceFile} for possible Living Archive promotion.`
          }
        });
      }
      setMemoryStatus(
        sourceStatus,
        `Created ${result.created?.length ?? 0} selected file intake artifact(s); ${result.rejected?.length ?? 0} rejected.`,
        "success"
      );
      await loadStatus();
      await loadReviewQueue();
      if (review.source?.id) {
        const refreshedReview = await bridge()("/memory/source/review", {
          method: "POST",
          capability: "memory-source-review",
          body: { sourceId: review.source.id, limit: 2_000 }
        });
        sourcePreview.replaceChildren(sourceReviewCard(refreshedReview, createSelectedFileIntake, (candidate) => {
          void previewSourceDiff(refreshedReview.source, candidate);
        }, repairSourceVersions));
        setMemoryStatus(
          sourceStatus,
          `Created ${result.created?.length ?? 0} selected file intake artifact(s); ${result.rejected?.length ?? 0} rejected. Source review refreshed.`,
          "success"
        );
      }
    } catch (error) {
      setMemoryStatus(sourceStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const createSourceIntake = async (source) => {
    setMemoryStatus(sourceStatus, `Creating governed intake summary for ${source.path || source.id}…`);
    try {
      const result = await bridge()("/memory/source/intake", {
        method: "POST",
        capability: "memory-source-intake",
        body: { sourceId: source.id }
      });
      const reviewRequest = await bridge()("/archive/review/request", {
        method: "POST",
        body: {
          path: result.path,
          reason: "Review this connected source intake summary for possible Living Archive promotion."
        }
      });
      setMemoryStatus(
        sourceStatus,
        `Source intake created: ${result.path} (${result.candidates} candidate files). Review request: ${reviewRequest.path}.`,
        "success"
      );
      await loadStatus();
      await loadReviewQueue();
    } catch (error) {
      setMemoryStatus(sourceStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const restorePromotionBackup = async (entry) => {
    if (!entry.path) {
      setMemoryStatus(promotionStatus, "Promotion entry is missing its review artifact path.", "error");
      return;
    }
    if (!entry.backupPath) {
      setMemoryStatus(promotionStatus, "This promotion has no backup to restore.", "warning");
      return;
    }
    setMemoryStatus(promotionStatus, `Restoring ${entry.promotedPage || "wiki page"} from backup…`);
    try {
      const result = await bridge()("/archive/review/promotions/restore", {
        method: "POST",
        body: { path: entry.path }
      });
      await loadStatus();
      await loadPromotionHistory();
      setMemoryStatus(promotionStatus, `Restored ${result.promotedPage} from ${result.backupPath}.`, "success");
    } catch (error) {
      setMemoryStatus(promotionStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const previewPromotedPage = async (entry, { handoff = false } = {}) => {
    if (!entry.promotedPage) {
      setMemoryStatus(promotionStatus, "Promotion entry is missing its AI Memory page path.", "error");
      return;
    }
    setMemoryStatus(promotionStatus, `Loading ${entry.promotedPage}…`);
    try {
      const result = await bridge()("/memory/wiki/page/read", {
        method: "POST",
        body: { path: entry.promotedPage }
      });
      const previewCard = wikiPagePreviewCard(result);
      promotionPreview.hidden = false;
      promotionPreview.replaceChildren(...previewCard.childNodes);
      setMemoryStatus(
        promotionStatus,
        handoff
          ? `Focused promoted page: ${result.path}. Previewing trusted AI Memory below.`
          : `Previewing ${result.path}.`,
        "success"
      );
    } catch (error) {
      setMemoryStatus(promotionStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const transitionReviewRequest = async (request, status) => {
    if (!request.path) {
      setMemoryStatus(reviewStatus, "Review request is missing its path.", "error");
      return;
    }
    setMemoryStatus(reviewStatus, `Updating review request to ${status}…`);
    try {
      const result = await bridge()("/archive/review/transition", {
        method: "POST",
        body: {
          path: request.path,
          status,
          actor: "human",
          actorType: "human",
          note: `Set from Living Archive workspace UI.`
        }
      });
      setMemoryStatus(reviewStatus, `Updated ${result.path} to ${result.status}.`, "success");
      await loadStatus();
      await loadReviewQueue();
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const draftReviewRequest = async (request) => {
    if (!request.path) {
      setMemoryStatus(reviewStatus, "Review request is missing its path.", "error");
      return;
    }
    setMemoryStatus(reviewStatus, "Generating draft wiki update artifact…");
    try {
      const result = await bridge()("/archive/review/draft", {
        method: "POST",
        body: { path: request.path }
      });
      setMemoryStatus(reviewStatus, `Draft artifact ready: ${result.path}.`, "success");
      await loadStatus();
      await loadReviewQueue();
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const previewSourceArtifact = async (request) => {
    if (!request.artifactPath) {
      setMemoryStatus(reviewStatus, "Review request has no source artifact to inspect.", "warning");
      return;
    }
    setMemoryStatus(reviewStatus, "Loading source intake artifact…");
    draftPreview.hidden = true;
    draftPreview.replaceChildren();
    try {
      const result = await bridge()("/archive/intake/read", {
        method: "POST",
        body: { path: request.artifactPath }
      });
      draftPreview.replaceChildren(sourceArtifactPreviewCard(result));
      draftPreview.hidden = false;
      setMemoryStatus(reviewStatus, result.truncated ? "Source preview loaded and truncated for safety." : "Source preview loaded.", "success");
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const previewReviewPromotedPage = async (request) => {
    if (!request.promotedPage) {
      setMemoryStatus(reviewStatus, "Review request has no promoted AI Memory page yet.", "warning");
      return;
    }
    setMemoryStatus(reviewStatus, `Loading promoted page ${request.promotedPage}…`);
    draftPreview.hidden = true;
    draftPreview.replaceChildren();
    try {
      const result = await bridge()("/memory/wiki/page/read", {
        method: "POST",
        body: { path: request.promotedPage }
      });
      draftPreview.replaceChildren(wikiPagePreviewCard(result));
      draftPreview.hidden = false;
      setMemoryStatus(reviewStatus, `Previewing promoted page ${result.path}.`, "success");
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const previewDraftArtifact = async (request) => {
    if (!request.draftArtifactPath) {
      setMemoryStatus(reviewStatus, "Review request has no draft artifact yet.", "warning");
      return;
    }
    setMemoryStatus(reviewStatus, "Loading draft artifact preview…");
    draftPreview.hidden = true;
    draftPreview.replaceChildren();
    try {
      const result = await bridge()("/archive/review/artifact/read", {
        method: "POST",
        body: { path: request.draftArtifactPath }
      });
      const heading = document.createElement("div");
      heading.className = "memory-preview-heading";
      const title = document.createElement("strong");
      title.textContent = result.title || "Draft artifact";
      const pathNode = document.createElement("code");
      pathNode.textContent = result.path || request.draftArtifactPath;
      heading.append(title, pathNode);
      const meta = document.createElement("p");
      const verificationStatus = result.verificationStatus || "not verified";
      const semanticStatus = result.semanticVerifierStatus || "not run";
      const writerStatus = result.writerStatus || "unknown writer";
      meta.textContent = result.proposedPage
        ? `Proposed page: ${result.proposedPage}`
        : `Type: ${result.type || "archive artifact"}`;
      meta.textContent = `${meta.textContent} · Writer: ${writerStatus} · Verification: ${verificationStatus} · Semantic: ${semanticStatus}`;
      const content = document.createElement("pre");
      content.textContent = result.content || "";
      const actions = document.createElement("div");
      actions.className = "memory-review-actions";
      const verifyButton = document.createElement("button");
      verifyButton.type = "button";
      verifyButton.textContent = result.verificationStatus === "verified" ? "Verified" : "Verify";
      verifyButton.disabled = result.status === "promoted" || result.verificationStatus === "verified";
      verifyButton.addEventListener("click", () => {
        void verifyDraftArtifact(result.path);
      });
      const verifierPreviewButton = document.createElement("button");
      verifierPreviewButton.type = "button";
      verifierPreviewButton.textContent = "Preview Verification";
      verifierPreviewButton.disabled = !result.verifierArtifactPath;
      verifierPreviewButton.addEventListener("click", () => {
        void previewVerificationArtifact(result.verifierArtifactPath);
      });
      const reviseButton = document.createElement("button");
      reviseButton.type = "button";
      reviseButton.textContent = "Revise Draft";
      reviseButton.disabled = result.status === "promoted" || result.verificationStatus !== "needs-revision";
      reviseButton.addEventListener("click", () => {
        void reviseDraftArtifact(result.path);
      });
      const promoteButton = document.createElement("button");
      promoteButton.type = "button";
      promoteButton.textContent = result.status === "promoted" ? "Promoted" : "Promote";
      promoteButton.disabled = result.status === "promoted" || result.verificationStatus !== "verified";
      promoteButton.addEventListener("click", () => {
        void promoteDraftArtifact(result.path);
      });
      actions.append(verifyButton, verifierPreviewButton, reviseButton, promoteButton);
      draftPreview.append(heading, meta, content, actions);
      draftPreview.hidden = false;
      setMemoryStatus(reviewStatus, result.truncated ? "Draft preview loaded and truncated for safety." : "Draft preview loaded.", "success");
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const previewVerificationArtifact = async (path) => {
    if (!path) {
      setMemoryStatus(reviewStatus, "Draft artifact has no verifier artifact yet.", "warning");
      return;
    }
    setMemoryStatus(reviewStatus, "Loading verifier artifact preview…");
    try {
      const result = await bridge()("/archive/review/verification/read", {
        method: "POST",
        body: { path }
      });
      const heading = document.createElement("div");
      heading.className = "memory-preview-heading";
      const title = document.createElement("strong");
      title.textContent = result.title || "Archive verification";
      const pathNode = document.createElement("code");
      pathNode.textContent = result.path || path;
      heading.append(title, pathNode);
      const meta = document.createElement("p");
      meta.textContent = `Status: ${result.status || "unknown"} · Semantic: ${result.semanticVerifierStatus || "unknown"} · Provider: ${result.semanticVerifierProvider || "none"}`;
      const content = document.createElement("pre");
      content.textContent = result.content || "";
      draftPreview.replaceChildren(heading, meta, content);
      draftPreview.hidden = false;
      setMemoryStatus(reviewStatus, result.truncated ? "Verifier preview loaded and truncated for safety." : "Verifier preview loaded.", "success");
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const verifyDraftArtifact = async (path) => {
    if (!path) {
      setMemoryStatus(reviewStatus, "Draft artifact is missing its path.", "error");
      return;
    }
    setMemoryStatus(reviewStatus, "Verifying draft wiki update…");
    try {
      const result = await bridge()("/archive/review/artifact/verify", {
        method: "POST",
        body: { path }
      });
      await loadStatus();
      await loadReviewQueue();
      setMemoryStatus(
        reviewStatus,
        result.status === "verified"
          ? `Verified draft: ${result.verifierArtifactPath} (${result.semanticVerifierStatus || "semantic unavailable"}).`
          : `Draft needs revision: ${(result.findings || []).join("; ")}`,
        result.status === "verified" ? "success" : "warning"
      );
      draftPreview.hidden = true;
      draftPreview.replaceChildren();
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const reviseDraftArtifact = async (path) => {
    if (!path) {
      setMemoryStatus(reviewStatus, "Draft artifact is missing its path.", "error");
      return;
    }
    setMemoryStatus(reviewStatus, "Revising draft from verifier findings…");
    try {
      const result = await bridge()("/archive/review/artifact/revise", {
        method: "POST",
        body: { path }
      });
      await loadStatus();
      await loadReviewQueue();
      setMemoryStatus(reviewStatus, `Revised draft ready: ${result.path}.`, "success");
      draftPreview.hidden = true;
      draftPreview.replaceChildren();
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const promoteDraftArtifact = async (path) => {
    if (!path) {
      setMemoryStatus(reviewStatus, "Draft artifact is missing its path.", "error");
      return;
    }
    setMemoryStatus(reviewStatus, "Promoting draft into trusted AI Memory…");
    try {
      const result = await bridge()("/archive/review/artifact/promote", {
        method: "POST",
        body: { path }
      });
      await loadStatus();
      await loadReviewQueue();
      await loadPromotionHistory();
      setMemoryStatus(reviewStatus, `Promoted ${result.promotedPage}.`, "success");
    } catch (error) {
      setMemoryStatus(reviewStatus, error instanceof Error ? error.message : String(error), "error");
    }
  };

  refreshReview.addEventListener("click", () => {
    void loadReviewQueue();
  });
  refreshPromotions.addEventListener("click", () => {
    void loadPromotionHistory();
  });
  refreshSources.addEventListener("click", () => {
    void loadSources();
  });

  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (query.length < 2) {
      setMemoryStatus(searchStatus, "Search requires at least two characters.", "warning");
      return;
    }
    searchButton.disabled = true;
    setMemoryStatus(searchStatus, "Searching AI Memory…");
    searchResults.replaceChildren();
    try {
      const result = await bridge()("/memory/search", {
        method: "POST",
        body: { query, limit: 8 }
      });
      if (!result.matches?.length) {
        setMemoryStatus(searchStatus, "No matches found in AI Memory.", "warning");
        return;
      }
      setMemoryStatus(searchStatus, `${result.matches.length} match(es) found.`, "success");
      searchResults.append(...result.matches.map(memoryResultCard));
    } catch (error) {
      setMemoryStatus(searchStatus, error instanceof Error ? error.message : String(error), "error");
    } finally {
      searchButton.disabled = false;
    }
  });

  intakeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = fileInput.files?.[0] ?? null;
    const title = titleInput.value.trim() || file?.name || "Browser workspace note";
    let content = contentInput.value.trim();
    if (file) {
      try {
        content = await singleFileIntakeContent(file);
      } catch (error) {
        setMemoryStatus(intakeStatus, error instanceof Error ? error.message : String(error), "warning");
        return;
      }
    }
    if (!content) {
      setMemoryStatus(intakeStatus, "Write content or choose a supported file before saving intake.", "warning");
      return;
    }
    intakeButton.disabled = true;
    setMemoryStatus(intakeStatus, "Saving governed intake…");
    try {
      const result = await bridge()("/archive/intake", {
        method: "POST",
        body: { title, content, origin: "main-workspace" }
      });
      setMemoryStatus(intakeStatus, `Saved to ${result.path} (${formatCount(result.bytes)} bytes).`, "success");
      contentInput.value = "";
      fileInput.value = "";
      await loadStatus();
      await loadReviewQueue();
    } catch (error) {
      setMemoryStatus(intakeStatus, error instanceof Error ? error.message : String(error), "error");
    } finally {
      intakeButton.disabled = false;
    }
  });

  void loadStatus();
  void loadWikiHealth();
  void loadSources();
  void loadReviewQueue();
  void loadPromotionHistory();
  if (initialQuery.trim()) {
    searchInput.value = initialQuery.trim();
    queueMicrotask(() => {
      searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }
}
