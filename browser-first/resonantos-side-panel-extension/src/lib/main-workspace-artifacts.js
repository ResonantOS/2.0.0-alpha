// Intent citation: docs/architecture/ADR-037-browser-first-chromium-resonantos.md
// Intent citation: docs/architecture/ADR-027-living-archive-llm-wiki-compliance.md

import { artifactInsightsFromMarkdown } from "./artifact-insights.js";

const formatBytes = (bytes) => {
  const value = Number(bytes ?? 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const kindLabel = (kind) => ({
  "browser-job-report": "Browser Job",
  "browser-control-report": "Agent Control",
  "browser-intake": "Browser Intake",
  intake: "Intake"
}[kind] ?? "Artifact");

export function artifactCategory(artifact = {}) {
  const kind = String(artifact.kind ?? "").toLowerCase();
  const insights = normalizedArtifactInsights(artifact);
  if (insights.evidenceType === "Wallet / DAO Audit" || /wallet\s*\/\s*dao\s+audit/i.test(String(artifact.title ?? ""))) return "wallet-dao";
  if (kind === "browser-control-report") return "agent-control";
  if (kind === "browser-job-report") return "browser-job";
  if (kind === "browser-intake" || insights.pageUrl) return "browser-intake";
  return "intake";
}

function artifactCategoryLabel(category) {
  return {
    "agent-control": "Agent Control",
    "browser-intake": "Browser Intake",
    "browser-job": "Browser Jobs",
    intake: "Other Intake",
    "wallet-dao": "Wallet / DAO"
  }[category] ?? "Artifacts";
}

export { artifactInsightsFromMarkdown };

function normalizedArtifactInsights(artifact) {
  const fallback = artifactInsightsFromMarkdown(artifact?.content ?? artifact?.excerpt ?? "");
  return {
    ...fallback,
    ...(artifact?.insights && typeof artifact.insights === "object" ? artifact.insights : {})
  };
}

function setStatus(node, text, tone = "neutral") {
  node.textContent = text;
  node.dataset.tone = tone;
}

function artifactRow(artifact, onOpen) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "artifact-row";
  row.dataset.kind = artifact.kind ?? "intake";
  const title = document.createElement("strong");
  title.textContent = artifact.title || "Untitled artifact";
  const meta = document.createElement("span");
  meta.textContent = `${kindLabel(artifact.kind)} · ${formatBytes(artifact.bytes)} · ${artifact.path}`;
  const excerpt = document.createElement("small");
  excerpt.textContent = artifact.excerpt || "No preview available.";
  row.append(title, meta, excerpt);
  const insights = normalizedArtifactInsights(artifact);
  if (insights.summary || insights.nextHumanAction) {
    const insight = document.createElement("small");
    insight.className = insights.nextHumanAction ? "artifact-row-guidance" : "artifact-row-progress";
    insight.textContent = insights.nextHumanAction
      ? `Next: ${insights.nextHumanAction}`
      : `Progress: ${insights.summary}`;
    row.append(insight);
  } else if (insights.pageTitle || insights.pageUrl) {
    const source = document.createElement("small");
    source.className = "artifact-row-progress";
    source.textContent = `Source: ${[insights.pageTitle, insights.pageUrl].filter(Boolean).join(" · ")}`;
    row.append(source);
  }
  row.addEventListener("click", () => onOpen(artifact));
  return row;
}

function actionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function reviewHandoffCard(review, onOpenReviewQueue) {
  const card = document.createElement("article");
  card.className = "artifact-review-handoff";
  const label = document.createElement("span");
  label.className = "module-eyebrow";
  label.textContent = "Review queued";
  const title = document.createElement("strong");
  title.textContent = "Next: inspect this artifact in Living Archive review.";
  const detail = document.createElement("p");
  detail.textContent = [
    review?.path ? `Request: ${review.path}.` : "Review request created.",
    "This is still intake evidence; trusted AI Memory changes happen only after draft, verify, and promote."
  ].join(" ");
  const actions = document.createElement("div");
  actions.className = "artifact-actions";
  const open = actionButton("Open Review Queue", () => {
    if (typeof onOpenReviewQueue === "function") onOpenReviewQueue(review);
  });
  open.disabled = typeof onOpenReviewQueue !== "function";
  actions.append(open);
  card.append(label, title, detail, actions);
  return card;
}

function previewArticle(artifact, actions) {
  const article = document.createElement("article");
  article.className = "artifact-preview";
  const heading = document.createElement("div");
  heading.className = "artifact-preview-heading";
  const copy = document.createElement("div");
  const label = document.createElement("span");
  label.className = "module-eyebrow";
  label.textContent = kindLabel(artifact.kind);
  const title = document.createElement("h2");
  title.textContent = artifact.title || "Artifact preview";
  const path = document.createElement("code");
  path.textContent = artifact.path || "INTAKE";
  copy.append(label, title, path);
  const meta = document.createElement("small");
  meta.textContent = `${formatBytes(artifact.bytes)} · ${artifact.modifiedAt || "unknown time"}`;
  heading.append(copy, meta);
  const content = document.createElement("pre");
  content.textContent = artifact.content || "No artifact content returned.";
  const insights = normalizedArtifactInsights(artifact);
  const insightRows = [
    ["Status", insights.status],
    ["Evidence", insights.evidenceType],
    ["Source type", insights.sourceType],
    ["Source detail", insights.sourceStats],
    ["Summary model", [insights.summaryModel, insights.fallbackSummary ? `fallback: ${insights.fallbackSummary}` : ""].filter(Boolean).join(" · ")],
    ["Wallet", insights.walletSummary],
    ["Source", [insights.pageTitle, insights.pageUrl].filter(Boolean).join(" · ")],
    ["Captured", insights.capturedAt],
    ["Progress", insights.summary],
    ["Phase", insights.phase],
    ["Complete", insights.percentComplete ? `${insights.percentComplete}%` : ""],
    ["Target", [insights.targetSite, insights.targetReason].filter(Boolean).join(" · ")],
    ["Next human action", insights.nextHumanAction]
  ].filter(([, value]) => Boolean(value));
  const insightPanel = document.createElement("section");
  insightPanel.className = "artifact-insights";
  insightPanel.hidden = insightRows.length === 0;
  if (insightRows.length) {
    const insightTitle = document.createElement("strong");
    insightTitle.textContent = "Action Summary";
    insightPanel.append(insightTitle);
    insightRows.forEach(([labelText, value]) => {
      const row = document.createElement("p");
      const label = document.createElement("span");
      label.textContent = labelText;
      const copy = document.createElement("b");
      copy.textContent = value;
      row.append(label, copy);
      insightPanel.append(row);
    });
  }
  const actionRow = document.createElement("div");
  actionRow.className = "artifact-actions";
  actionRow.append(
    actionButton("Copy Path", () => void actions.copyPath(artifact)),
    actionButton("Request Review", () => void actions.requestReview(artifact)),
    actionButton("Continue", () => void actions.continueFrom(artifact))
  );
  article.append(heading, insightPanel, actionRow, content);
  if (artifact.truncated) {
    const truncated = document.createElement("p");
    truncated.className = "artifact-warning";
    truncated.textContent = "Preview truncated for safety. The full artifact remains in Living Archive intake.";
    article.append(truncated);
  }
  return article;
}

export function renderArtifactsWorkspace({ container, bridgeRequest, getBridgeRequest, onContinueArtifact, onOpenReviewQueue }) {
  // Resolve at call time. The module-level `bridgeRequest` may be
  // null at construction (rebind still in flight); the getter lets
  // us re-read the current value on every call.
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const section = document.createElement("section");
  section.className = "artifacts-workspace";
  section.setAttribute("aria-label", "Artifacts workspace");

  const header = document.createElement("header");
  header.className = "artifacts-hero";
  const eyebrow = document.createElement("span");
  eyebrow.className = "module-eyebrow";
  eyebrow.textContent = "Artifacts";
  const title = document.createElement("h1");
  title.textContent = "Reports and intake created by browser work.";
  const body = document.createElement("p");
  body.textContent = "Review completed browser jobs, Agent Control reports, and saved intake without hunting through memory folders. These are evidence artifacts, not trusted wiki pages.";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh";
  header.append(eyebrow, title, body, refresh);

  const layout = document.createElement("div");
  layout.className = "artifacts-layout";
  const list = document.createElement("ol");
  list.className = "artifact-list";
  const preview = document.createElement("div");
  preview.className = "artifact-preview-shell";
  const status = document.createElement("p");
  status.className = "artifact-status";
  const filters = document.createElement("nav");
  filters.className = "artifact-filters";
  filters.setAttribute("aria-label", "Artifact filters");
  layout.append(list, preview);
  section.append(header, status, filters, layout);
  container.append(section);
  let currentFilter = "all";
  let currentEntries = [];

  const openArtifact = async (artifact) => {
    preview.replaceChildren();
    setStatus(status, `Loading ${artifact.title || artifact.path}…`);
    try {
      const result = await bridge()("/archive/intake/read", {
        method: "POST",
        body: { path: artifact.path }
      });
      preview.append(previewArticle(result, {
        copyPath: async (selected) => {
          try {
            await navigator.clipboard?.writeText?.(selected.path);
            setStatus(status, `Copied ${selected.path}.`, "success");
          } catch {
            setStatus(status, `Path: ${selected.path}`, "warning");
          }
        },
        requestReview: async (selected) => {
          setStatus(status, `Creating review request for ${selected.path}…`);
          try {
            const review = await bridge()("/archive/review/request", {
              method: "POST",
              body: {
                path: selected.path,
                reason: "Evaluate this browser artifact for Living Archive ingestion, contradictions, entities, and durable wiki updates."
              }
            });
            preview.querySelector(".artifact-review-handoff")?.remove();
            preview.append(reviewHandoffCard(review, onOpenReviewQueue));
            setStatus(status, `Review request created: ${review.path}. Next: open the Living Archive review queue.`, "success");
          } catch (error) {
            setStatus(status, error instanceof Error ? error.message : String(error), "error");
          }
        },
        continueFrom: async (selected) => {
          if (typeof onContinueArtifact !== "function") {
            setStatus(status, "Continuation is not available in this workspace.", "warning");
            return;
          }
          await onContinueArtifact(selected);
          setStatus(status, `Sent ${selected.path} to Augmentor sidebar continuation.`, "success");
        }
      }));
      setStatus(status, `Previewing ${result.path}.`, "success");
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const loadArtifacts = async () => {
    refresh.disabled = true;
    list.replaceChildren();
    preview.replaceChildren();
    setStatus(status, "Loading intake artifacts…");
    try {
      const result = await bridge()("/archive/intake/list", {
        method: "POST",
        body: { limit: 60 }
      });
      const entries = Array.isArray(result.entries) ? result.entries : [];
      currentEntries = entries;
      if (!entries.length) {
        filters.replaceChildren();
        setStatus(status, "No browser reports or intake artifacts found yet.", "warning");
        return;
      }
      const renderEntries = async () => {
        list.replaceChildren();
        const visibleEntries = currentFilter === "all"
          ? currentEntries
          : currentEntries.filter((entry) => artifactCategory(entry) === currentFilter);
        if (!visibleEntries.length) {
          setStatus(status, `No ${artifactCategoryLabel(currentFilter).toLowerCase()} artifacts in this intake view.`, "warning");
          return;
        }
        list.append(...visibleEntries.map((entry) => {
          const item = document.createElement("li");
          item.append(artifactRow(entry, openArtifact));
          return item;
        }));
        await openArtifact(visibleEntries[0]);
        setStatus(
          status,
          `${visibleEntries.length}/${currentEntries.length} artifact(s) shown from ${result.root}. Previewing ${visibleEntries[0].path}.`,
          "success"
        );
      };
      const categories = ["all", ...new Set(entries.map(artifactCategory))];
      if (!categories.includes(currentFilter)) currentFilter = "all";
      filters.replaceChildren(...categories.map((category) => {
        const count = category === "all"
          ? entries.length
          : entries.filter((entry) => artifactCategory(entry) === category).length;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${category === "all" ? "All" : artifactCategoryLabel(category)} ${count}`;
        button.dataset.filter = category;
        button.setAttribute("aria-pressed", category === currentFilter ? "true" : "false");
        button.addEventListener("click", () => {
          currentFilter = category;
          [...filters.querySelectorAll("button")].forEach((candidate) => {
            candidate.setAttribute("aria-pressed", candidate.dataset.filter === currentFilter ? "true" : "false");
          });
          void renderEntries();
        });
        return button;
      }));
      await renderEntries();
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : String(error), "error");
    } finally {
      refresh.disabled = false;
    }
  };

  refresh.addEventListener("click", () => void loadArtifacts());
  void loadArtifacts();
}
