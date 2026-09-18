import {
  browserJobSchedulerState,
  normalizeBrowserJob
} from "./browser-job-store.js";
import {
  controlActionStateLabel,
  controlRunProgressSummary
} from "./monitor-renderers.js";

const ACTIVE_STATUSES = new Set(["queued", "running", "approval", "paused"]);

export function mainBrowserJobSnapshot({ activeJobId = "", jobs = [], maxConcurrent = 2 } = {}) {
  const normalizedJobs = Array.isArray(jobs)
    ? jobs.map((job) => normalizeBrowserJob(job)).filter((job) => job.id)
    : [];
  const activeJobs = normalizedJobs.filter((job) => ACTIVE_STATUSES.has(job.status));
  const approvalJobs = activeJobs.filter((job) => job.status === "approval" && job.pendingApproval);
  const activeFocusedJob = normalizedJobs.find((job) => job.id === activeJobId && ACTIVE_STATUSES.has(job.status));
  const focusedJob = activeFocusedJob ?? approvalJobs[0] ?? activeJobs[0] ?? normalizedJobs[0] ?? null;
  const scheduler = browserJobSchedulerState(normalizedJobs, { maxConcurrent });
  const blocked = activeJobs.filter((job) => ["approval", "paused"].includes(job.status)).length +
    scheduler.lockBlockedQueued.length +
    scheduler.capacityBlockedQueued.length;
  return {
    activeCount: activeJobs.length,
    approvalJobs,
    blocked,
    focusedJob,
    jobs: normalizedJobs,
    scheduler
  };
}

function statusLabel(job) {
  if (!job) return "No browser jobs";
  if (job.status === "approval") return "Needs approval";
  if (job.status === "running") return "Running";
  if (job.status === "queued") return "Queued";
  if (job.status === "paused") return "Paused";
  if (job.status === "blocked") return "Blocked";
  if (job.status === "failed") return "Failed";
  if (job.status === "cancelled") return "Stopped";
  if (job.status === "completed") return "Completed";
  return String(job.status || "Unknown");
}

function jobTarget(job) {
  return [
    job?.pageLock?.siteKey,
    job?.pageLock?.tabId !== null && job?.pageLock?.tabId !== undefined ? `tab ${job.pageLock.tabId}` : ""
  ].filter(Boolean).join(" · ");
}

function jobRecoveryEvidence(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const step = [...steps].reverse()
    .find((candidate) => candidate?.details?.verificationRetry || candidate?.details?.actionRetry);
  const details = step?.details ?? {};
  return [
    details.verificationRetry ? `rechecked: ${details.verificationRetry}` : "",
    details.actionRetry ? `retried: ${details.actionRetry}` : ""
  ].filter(Boolean).join(" · ");
}

function jobCurrentAction(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const step = steps.find((candidate) => candidate?.state === "active") ??
    (job?.status === "approval" ? job?.pendingApproval?.step : null) ??
    (job?.status === "approval" || job?.status === "blocked" ? [...steps].reverse().find((candidate) => ["blocked", "failed"].includes(candidate?.state)) : null) ??
    steps.find((candidate) => candidate?.state === "pending") ??
    null;
  if (!step) return "";
  const label = String(step.label ?? step.text ?? step.url ?? step.query ?? step.type ?? "browser action").trim();
  if (!label) return "";
  return `Now: ${controlActionStateLabel(step.state ?? (job?.status === "approval" ? "blocked" : "pending"))} · ${label.slice(0, 180)}`;
}

function jobBlockerGuidance(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const step = [...steps].reverse()
    .find((candidate) => candidate?.details?.nextHumanAction || candidate?.details?.uncertainty || candidate?.details?.recoveryOptions?.length);
  const details = step?.details ?? {};
  const options = Array.isArray(details.recoveryOptions) ? details.recoveryOptions.filter(Boolean).slice(0, 3) : [];
  return [
    details.nextHumanAction ? `Next: ${details.nextHumanAction}` : "",
    details.uncertainty ? `Why stopped: ${details.uncertainty}` : "",
    options.length ? `Options: ${options.join(" · ")}` : "",
    job?.lastError ? `Last error: ${job.lastError}` : ""
  ].filter(Boolean).join(" ");
}

function jobOutcomeSummary(job) {
  if (job?.status !== "completed") return "";
  const summary = String(job?.summary ?? "").trim();
  if (summary) return `Result: ${summary}`;
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const step = [...steps].reverse()
    .find((candidate) => ["completed", "done", "success"].includes(candidate?.state) && String(candidate?.note ?? "").trim());
  return step?.note ? `Result: ${String(step.note).trim()}` : "";
}

function approvalActionLabel(job) {
  const approval = job?.pendingApproval;
  const step = approval?.step ?? {};
  return String(step.label ?? step.text ?? step.url ?? step.query ?? step.type ?? "pending action").slice(0, 120);
}

function approvalTargetLabel(job) {
  return [
    job?.pageLock?.siteKey,
    job?.pageLock?.tabId !== null && job?.pageLock?.tabId !== undefined ? `tab ${job.pageLock.tabId}` : "",
    job?.pendingApproval?.history?.at?.(-1)?.observation?.title
  ].filter(Boolean).join(" · ");
}

function createButton(documentRef, label, title, handler, { primary = false } = {}) {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  if (primary) button.dataset.primary = "true";
  button.addEventListener("click", handler);
  return button;
}

function canPauseJob(job) {
  return ["approval", "queued", "running"].includes(job?.status);
}

function canContinueJob(job) {
  return ["blocked", "cancelled", "completed", "denied", "failed", "paused"].includes(job?.status);
}

export function renderMainBrowserJobStatus({
  activeJobId = "",
  container,
  jobs = [],
  historyState = "ready",
  onRetryHistory,
  maxConcurrent = 2,
  onCancelFocused,
  onContinueFocused,
  onFocusJob,
  onOpenMonitor,
  onPauseFocused
} = {}) {
  if (historyState !== "ready") {
    const snapshot = mainBrowserJobSnapshot();
    if (!container) return snapshot;
    const documentRef = container.ownerDocument;
    container.replaceChildren();
    container.hidden = false;
    container.dataset.status = "blocked";
    const copy = documentRef.createElement("div");
    copy.className = "main-browser-jobs-copy";
    copy.dataset.status = "blocked";
    const title = documentRef.createElement("strong");
    title.textContent = historyState === "loading"
      ? "Loading browser job history…"
      : "Browser job history could not be loaded.";
    copy.append(title);
    const actions = documentRef.createElement("div");
    actions.className = "main-browser-jobs-actions";
    const retry = createButton(documentRef, "Retry", "Reload browser job history", () => onRetryHistory?.());
    retry.disabled = historyState === "loading";
    actions.append(retry);
    container.append(copy, actions);
    return snapshot;
  }
  if (!container) return mainBrowserJobSnapshot({ activeJobId, jobs, maxConcurrent });
  const snapshot = mainBrowserJobSnapshot({ activeJobId, jobs, maxConcurrent });
  const documentRef = container.ownerDocument;
  const { activeCount, approvalJobs, blocked, focusedJob, scheduler } = snapshot;
  container.replaceChildren();
  container.hidden = activeCount === 0 && !focusedJob;
  if (container.hidden) {
    delete container.dataset.status;
    return snapshot;
  }

  container.dataset.status = focusedJob?.status ?? "idle";
  const copy = documentRef.createElement("div");
  copy.className = "main-browser-jobs-copy";
  const eyebrow = documentRef.createElement("small");
  eyebrow.textContent = "Agent Control";
  const title = documentRef.createElement("strong");
  title.textContent = focusedJob ? `${statusLabel(focusedJob)} · ${focusedJob.goal}` : "No active browser work";
  const meta = documentRef.createElement("span");
  meta.textContent = [
    `${activeCount} active`,
    `${scheduler.runnableQueued.length} runnable`,
    `${scheduler.lockBlockedQueued.length} locked`,
    `${scheduler.capacityBlockedQueued.length} waiting`,
    blocked ? `${blocked} needs attention` : "",
    focusedJob ? jobTarget(focusedJob) : ""
  ].filter(Boolean).join(" · ");
  copy.append(eyebrow, title, meta);

  if (focusedJob?.steps?.length) {
    const progress = documentRef.createElement("span");
    progress.className = "main-browser-jobs-progress";
    progress.textContent = controlRunProgressSummary(focusedJob);
    copy.append(progress);
  }
  const currentAction = jobCurrentAction(focusedJob);
  if (currentAction) {
    const current = documentRef.createElement("span");
    current.className = "main-browser-jobs-current";
    current.textContent = currentAction;
    copy.append(current);
  }
  const recoveryEvidence = jobRecoveryEvidence(focusedJob);
  if (recoveryEvidence) {
    const recovery = documentRef.createElement("span");
    recovery.className = "main-browser-jobs-recovery";
    recovery.textContent = `Recovery: ${recoveryEvidence}`;
    copy.append(recovery);
  }
  const blockerGuidance = ["blocked", "failed", "cancelled", "denied", "paused"].includes(focusedJob?.status)
    ? jobBlockerGuidance(focusedJob)
    : "";
  if (blockerGuidance) {
    const blocker = documentRef.createElement("span");
    blocker.className = "main-browser-jobs-blocker";
    blocker.textContent = blockerGuidance;
    copy.append(blocker);
  }
  const outcomeSummary = jobOutcomeSummary(focusedJob);
  if (outcomeSummary) {
    const outcome = documentRef.createElement("span");
    outcome.className = "main-browser-jobs-outcome";
    outcome.textContent = outcomeSummary;
    copy.append(outcome);
  }
  if (approvalJobs.length) {
    const approvalQueue = documentRef.createElement("div");
    approvalQueue.className = "main-browser-jobs-approvals";
    const approvalLabel = documentRef.createElement("small");
    approvalLabel.textContent = `${approvalJobs.length} approval ${approvalJobs.length === 1 ? "card" : "cards"}`;
    approvalQueue.append(approvalLabel);
    approvalJobs.slice(0, 3).forEach((job) => {
      const card = documentRef.createElement("article");
      card.className = "main-browser-jobs-approval-card";
      card.dataset.active = job.id === activeJobId ? "true" : "false";
      const details = documentRef.createElement("div");
      const title = documentRef.createElement("strong");
      title.textContent = `${job.goal}: ${approvalActionLabel(job)}`;
      const reason = documentRef.createElement("span");
      reason.textContent = job.pendingApproval?.reason ?? "This browser action requires human approval.";
      const target = documentRef.createElement("small");
      target.textContent = approvalTargetLabel(job) || "Review in Browser Jobs before approval.";
      details.append(title, reason, target);
      const review = createButton(
        documentRef,
        job.id === activeJobId ? "Open review" : "Focus review",
        `Review approval for ${job.goal}`,
        () => (job.id === activeJobId ? onOpenMonitor?.() : onFocusJob?.(job)),
        { primary: job.id !== activeJobId }
      );
      card.append(details, review);
      approvalQueue.append(card);
    });
    if (approvalJobs.length > 3) {
      const more = documentRef.createElement("small");
      more.textContent = `${approvalJobs.length - 3} more approval jobs in Browser Jobs.`;
      approvalQueue.append(more);
    }
    copy.append(approvalQueue);
  }

  const actions = documentRef.createElement("div");
  actions.className = "main-browser-jobs-actions";
  if (focusedJob && typeof onFocusJob === "function") {
    actions.append(createButton(documentRef, "Focus", `Focus ${focusedJob.goal}`, () => onFocusJob(focusedJob)));
  }
  const canContinueFocusedJob = focusedJob && canContinueJob(focusedJob) && typeof onContinueFocused === "function";
  if (typeof onOpenMonitor === "function") {
    actions.append(createButton(
      documentRef,
      "Open monitor",
      "Open the full Browser Jobs monitor in the Augmentor side panel",
      onOpenMonitor,
      { primary: !canContinueFocusedJob }
    ));
  }
  if (focusedJob && canPauseJob(focusedJob) && typeof onPauseFocused === "function") {
    actions.append(createButton(documentRef, "Pause", `Pause ${focusedJob.goal}`, () => onPauseFocused(focusedJob)));
  }
  if (canContinueFocusedJob) {
    actions.append(createButton(documentRef, "Continue", `Continue ${focusedJob.goal}`, () => onContinueFocused(focusedJob), { primary: true }));
  }
  if (focusedJob && !["completed", "cancelled", "failed", "blocked", "denied"].includes(focusedJob.status) && typeof onCancelFocused === "function") {
    actions.append(createButton(documentRef, "Stop", `Stop ${focusedJob.goal}`, () => onCancelFocused(focusedJob)));
  }

  container.append(copy, actions);
  return snapshot;
}
