import { isClearableBrowserJobStatus, staleBrowserJobEvidence } from "./browser-job-store.js";
import {
  controlActionStateLabel,
  controlRunPhaseLabel,
  controlRunProgress,
  controlRunProgressSummary,
  controlRunSummary,
  formatDurationMs,
  sitePermissionDescription,
} from "./monitor-progress.js";
import { renderStepList } from "./step-list.js";

export {
  controlActionStateLabel,
  controlRunPhase,
  controlRunPhaseLabel,
  controlRunProgress,
  controlRunProgressSummary,
  controlRunSummary,
  formatDurationMs,
  sitePermissionDescription,
} from "./monitor-progress.js";

function latestAudit(audit, key) {
  const entries = audit?.[key] ?? [];
  return entries[0] ?? null;
}

function auditLabel(entry) {
  if (!entry) return "";
  const date = Number.isFinite(Number(entry.at)) ? new Date(Number(entry.at)).toLocaleString() : "unknown time";
  return `${entry.action} · ${date} · ${entry.source || "unknown"} · ${entry.reason || "no reason recorded"}`;
}

function preflightDecisionLabel(decision) {
  if (!decision) return "";
  const modeLabels = {
    "allowed-task-class-once": "allowed task class once",
    "approved-once": "approved once",
    "trusted-safe-actions": "trusted safe actions",
    "skipped-by-consent": "used stored consent",
    resumed: "resumed previous job",
    "not-required": "not required"
  };
  return [
    `Preflight: ${modeLabels[decision.mode] ?? decision.mode}`,
    decision.taskClass,
    decision.siteKey,
    decision.reason
  ].filter(Boolean).join(" · ");
}

function jobNextHumanAction(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const step = [...steps].reverse()
    .find((candidate) => candidate?.details?.nextHumanAction);
  return step?.details?.nextHumanAction ?? "";
}

function jobRecoveryEvidence(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const step = [...steps].reverse()
    .find((candidate) => candidate?.details?.verificationRetry || candidate?.details?.actionRetry);
  const details = step?.details ?? {};
  const evidence = [
    details.verificationRetry ? `verification retry: ${details.verificationRetry}` : "",
    details.actionRetry ? `action retry: ${details.actionRetry}` : ""
  ].filter(Boolean);
  return evidence.join(" · ");
}

function targetCandidateText(candidate = {}) {
  return [
    candidate.label || candidate.text || candidate.name || candidate.ref || "",
    candidate.ref ? `#${candidate.ref}` : "",
    candidate.visibleIndex ? `index:${candidate.visibleIndex}` : "",
    candidate.context ? `context:${candidate.context}` : "",
    candidate.form?.label ? `form:${candidate.form.label}` : "",
    candidate.fieldKind ? `kind:${candidate.fieldKind}` : "",
    candidate.approvalRequired ? "approval-required" : ""
  ].filter(Boolean).join(" · ");
}

function jobAmbiguityEvidence(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const step = [...steps].reverse()
    .find((candidate) => candidate?.details?.ambiguousTarget || candidate?.details?.targetCandidates?.length);
  const candidates = Array.isArray(step?.details?.targetCandidates) ? step.details.targetCandidates : [];
  if (!step || !candidates.length) return "";
  return candidates.slice(0, 4).map(targetCandidateText).filter(Boolean).join("; ");
}

function pendingApprovalEvidence(job) {
  const approval = job?.pendingApproval;
  if (!approval) return null;
  const history = Array.isArray(approval.history) ? approval.history : [];
  const lastObservation = [...history].reverse().find((entry) => entry?.observation)?.observation ?? null;
  const stepLabel = approval.step ? String(approval.step.label ?? approval.step.text ?? approval.step.type ?? "pending action") : "pending action";
  return {
    action: stepLabel.slice(0, 180),
    reason: String(approval.reason ?? "This browser action requires human approval.").slice(0, 500),
    title: String(lastObservation?.title ?? "").slice(0, 180),
    url: String(lastObservation?.url ?? job?.pageLock?.url ?? "").slice(0, 240),
    target: pageLockLabel(job?.pageLock).replace(/^Target: /, "")
  };
}

function pageLockLabel(pageLock) {
  if (!pageLock) return "";
  return [
    `Target: ${pageLock.siteKey || "unknown-site"}`,
    pageLock.tabId !== null && pageLock.tabId !== undefined ? `tab ${pageLock.tabId}` : "",
    pageLock.reason || ""
  ].filter(Boolean).join(" · ");
}

function stepDetailRows(step) {
  const details = step?.details ?? {};
  const listValue = (value) => Array.isArray(value)
    ? value.filter(Boolean).map((item, index) => `${index + 1}. ${item}`).join(" ")
    : "";
  const recoveryOptions = Array.isArray(details.recoveryOptions)
    ? details.recoveryOptions.filter(Boolean).map((option, index) => `${index + 1}. ${option}`).join(" ")
    : "";
  const targetCandidates = Array.isArray(details.targetCandidates)
    ? details.targetCandidates.filter(Boolean).map((candidate, index) => `${index + 1}. ${targetCandidateText(candidate)}`).join(" ")
    : "";
  return [
    ["Timing", formatDurationMs(step?.timing?.durationMs)],
    ["Observation", details.observation?.title || details.observation?.url || ""],
    ["Decision", details.decision || ""],
    ["Action", details.action || ""],
    ["Approval decision", details.approvalDecision || ""],
    ["Result", details.result || step?.note || ""],
    ["Safety", details.safetyClass || ""],
    ["Strategy phase", details.strategyPhase || ""],
    ["Strategy rationale", details.strategyRationale || ""],
    ["Completion check", details.completionCheck || ""],
    ["Scenario", details.scenarioName || ""],
    ["Preferred probes", listValue(details.preferredProbes)],
    ["Success signals", listValue(details.successSignals)],
    ["Stop boundaries", listValue(details.stopConditions)],
    ["Confidence", details.confidence || ""],
    ["Human state", details.humanInterventionState || ""],
    ["Uncertainty", details.uncertainty || ""],
    ["Ambiguous target", details.ambiguousTarget ? "yes" : ""],
    ["Target candidates", targetCandidates],
    ["Verification retry", details.verificationRetry || ""],
    ["Action retry", details.actionRetry || ""],
    ["Next human action", details.nextHumanAction || ""],
    ["Recovery options", recoveryOptions]
  ].filter(([, value]) => Boolean(value));
}

function latestStrategyDetails(run) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  return [...steps].reverse()
    .map((step) => step?.details ?? {})
    .find((details) => details.scenarioName || details.successSignals?.length || details.stopConditions?.length || details.preferredProbes?.length)
    ?? null;
}

function strategyList(documentRef, title, entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const section = documentRef.createElement("div");
  const label = documentRef.createElement("small");
  label.textContent = title;
  const list = documentRef.createElement("ul");
  entries.slice(0, 5).forEach((entry) => {
    const item = documentRef.createElement("li");
    item.textContent = entry;
    list.append(item);
  });
  section.append(label, list);
  return section;
}

function controlBoundaryCopy(run = {}) {
  const target = pageLockLabel(run.pageLock).replace(/^Target: /, "");
  return {
    target: target || "active readable browser tab",
    canSee: "visible page text, links, controls, fields, URL, and readable tab context",
    canDo: "safe read, scroll, navigation, click, search, and non-sensitive typing through governed browser actions",
    humanOnly: "wallet signing, payments, login, credentials, public submit/post/send, irreversible value actions"
  };
}

export function createMonitorRenderers({
  activeTab,
  approvalBoundaryForStep,
  controlStepLabel,
  elements,
  getBrowserJobs,
  getActiveBrowserJobId = () => null,
  getBrowserJobSchedulerState = () => null,
  getContextDockExpanded,
  getCurrentControlRun,
  getJobMonitorCollapsed,
  getPendingApproval,
  getSitePermissionAudit = async () => ({}),
  getSitePermissions = async () => ({}),
  getTaskConsentAudit = async () => ({}),
  getTaskConsents,
  isReadableBrowserTab,
  onContinueBrowserJob,
  onActivateBrowserJob,
  onApproveBrowserJob,
  onCancelBrowserJob,
  onDenyBrowserJob,
  onPauseBrowserJob,
  onResetSitePermission,
  onSaveBrowserJobReport,
  onRevokeTaskConsent,
  permissionForUrl,
  siteKeyForUrl,
  updateContextDockVisibility
}) {
  const {
    approvalAllowOnceButton,
    approvalApproveButton,
    approvalCard,
    approvalReason,
    approvalTitle,
    approvalTrustSiteButton,
    controlArtifacts,
    controlCurrentAction,
    controlMonitor,
    controlSummaryCard,
    controlMonitorStatus,
    controlMonitorTitle,
    controlStopButton,
    controlStepList,
    jobList,
    jobMonitor,
    jobMonitorTitle,
    jobMonitorToggle,
    permissionManagerList,
    permissionManagerPanel,
    permissionManagerTitle,
    sitePermissionHost,
    sitePermissionMode,
    sitePermissionNote,
    sitePermissionPanel,
    taskConsentList,
    taskConsentPanel,
    taskConsentTitle
  } = elements;

  function renderControlMonitor() {
    const currentControlRun = getCurrentControlRun();
    const pendingApproval = getPendingApproval();
    if (!currentControlRun) {
      controlMonitor.hidden = true;
      approvalCard.hidden = true;
      if (controlSummaryCard) {
        controlSummaryCard.hidden = true;
        controlSummaryCard.replaceChildren();
      }
      updateContextDockVisibility();
      return;
    }
    controlMonitor.hidden = false;
    const progress = controlRunProgress(currentControlRun);
    controlMonitor.dataset.status = currentControlRun.status;
    controlMonitor.dataset.activeStep = progress.active >= 0 ? String(progress.active + 1) : "";
    controlMonitorTitle.textContent = currentControlRun.goal;
    controlMonitorStatus.textContent = progress.label;
    controlMonitorStatus.dataset.status = currentControlRun.status;
    controlStopButton.hidden = !["running", "approval", "paused"].includes(currentControlRun.status);
    if (controlSummaryCard) {
      const summary = controlRunSummary(currentControlRun);
      controlSummaryCard.hidden = !summary;
      controlSummaryCard.replaceChildren();
      if (summary) {
        controlSummaryCard.dataset.state = summary.state;
        const title = document.createElement("strong");
        title.textContent = summary.title;
        const body = document.createElement("p");
        body.textContent = summary.body;
        controlSummaryCard.append(title, body);
      }
    }
    const documentRef = controlMonitor.ownerDocument;
    let strategyCard = controlMonitor.querySelector(".control-strategy-card");
    if (!strategyCard) {
      strategyCard = documentRef.createElement("div");
      strategyCard.className = "control-strategy-card";
      controlCurrentAction.insertAdjacentElement("afterend", strategyCard);
    }
    const strategy = latestStrategyDetails(currentControlRun);
    strategyCard.hidden = !strategy;
    strategyCard.replaceChildren();
    if (strategy) {
      const header = documentRef.createElement("div");
      const eyebrow = documentRef.createElement("small");
      eyebrow.textContent = "Control strategy";
      const title = documentRef.createElement("strong");
      title.textContent = strategy.scenarioName || "Active browser strategy";
      const phase = documentRef.createElement("span");
      phase.textContent = strategy.strategyPhase || "Following observe-act-verify loop.";
      header.append(eyebrow, title, phase);
      strategyCard.append(header);
      [
        strategyList(documentRef, "Success signals", strategy.successSignals),
        strategyList(documentRef, "Stop boundaries", strategy.stopConditions),
        strategyList(documentRef, "Preferred probes", strategy.preferredProbes)
      ].filter(Boolean).forEach((section) => strategyCard.append(section));
    }
    let boundaryCard = controlMonitor.querySelector(".control-boundary-card");
    if (!boundaryCard) {
      boundaryCard = documentRef.createElement("div");
      boundaryCard.className = "control-boundary-card";
      strategyCard.insertAdjacentElement("afterend", boundaryCard);
    }
    const boundary = controlBoundaryCopy(currentControlRun);
    boundaryCard.replaceChildren();
    const boundaryHeader = documentRef.createElement("div");
    const boundaryEyebrow = documentRef.createElement("small");
    boundaryEyebrow.textContent = "Current authority";
    const boundaryTitle = documentRef.createElement("strong");
    boundaryTitle.textContent = boundary.target;
    boundaryHeader.append(boundaryEyebrow, boundaryTitle);
    boundaryCard.append(boundaryHeader);
    [
      ["Can see", boundary.canSee],
      ["Can do", boundary.canDo],
      ["Human-only", boundary.humanOnly]
    ].forEach(([label, value]) => {
      const row = documentRef.createElement("p");
      const key = documentRef.createElement("span");
      key.textContent = label;
      const text = documentRef.createElement("b");
      text.textContent = value;
      row.append(key, text);
      boundaryCard.append(row);
    });
    controlCurrentAction.dataset.state = progress.currentStep?.state ?? currentControlRun.status;
    const actionKicker = controlCurrentAction.querySelector("small");
    const actionLabel = controlCurrentAction.querySelector("strong");
    if (actionKicker) {
      actionKicker.textContent = currentControlRun.status === "running"
        ? "Now"
        : currentControlRun.status === "approval"
          ? "Needs approval"
          : "State";
    }
    if (actionLabel) {
      actionLabel.textContent = progress.currentStep
        ? controlStepLabel(progress.currentStep)
        : currentControlRun.status === "running"
          ? "Observing the active page..."
          : currentControlRun.status;
    }
    const actionCopy = controlCurrentAction.querySelector("div");
    let targetMeta = controlCurrentAction.querySelector(".control-target-meta");
    if (!targetMeta && actionCopy) {
      targetMeta = document.createElement("small");
      targetMeta.className = "control-target-meta";
      actionCopy.append(targetMeta);
    }
    if (targetMeta) {
      const target = pageLockLabel(currentControlRun.pageLock);
      targetMeta.hidden = !target;
      targetMeta.textContent = target;
    }
    let phaseMeta = controlCurrentAction.querySelector(".control-phase-meta");
    if (!phaseMeta && actionCopy) {
      phaseMeta = document.createElement("small");
      phaseMeta.className = "control-phase-meta";
      actionCopy.append(phaseMeta);
    }
    if (phaseMeta) {
      phaseMeta.hidden = false;
      phaseMeta.textContent = controlRunProgressSummary(currentControlRun);
    }
    let progressTrack = controlCurrentAction.querySelector(".control-progress-track");
    if (!progressTrack && actionCopy) {
      progressTrack = document.createElement("span");
      progressTrack.className = "control-progress-track";
      progressTrack.append(document.createElement("i"));
      actionCopy.append(progressTrack);
    }
    if (progressTrack) {
      progressTrack.querySelector("i").style.width = `${progress.percent}%`;
      progressTrack.setAttribute("aria-label", `Agent Control progress ${progress.percent} percent`);
    }
    // The step list uses the shared Claude-app-style component (glyph + label +
    // "N of M" progress pill), consistent with the rest of the Augmentor. Each
    // step keeps its full action/safety detail in an expander via renderExtra, so
    // adopting the clean look never costs the #240 pre-approval visibility.
    renderStepList(controlStepList, currentControlRun.steps, {
      document,
      label: (step) => controlStepLabel(step),
      renderExtra: (step) => {
        // Settled steps (completed/cancelled) stay as clean single lines — a
        // detail toggle on the done list is just clutter. Detail appears only
        // where it is actionable: the running step and any blocked/failed one.
        if (step.state === "completed" || step.state === "cancelled") return null;
        const rows = stepDetailRows(step);
        if (!rows.length) return null;
        const detail = document.createElement("details");
        detail.className = "control-step-detail";
        // A step that needs the human (blocked/failed) opens its detail by
        // default — that is exactly when its action, safety class, and next step
        // must be visible before you approve. Settled steps stay collapsed.
        if (step.state === "blocked" || step.state === "failed") detail.open = true;
        const summary = document.createElement("summary");
        summary.textContent = "Details";
        detail.append(summary);
        rows.forEach(([label, value]) => {
          const row = document.createElement("p");
          const key = document.createElement("span");
          key.textContent = label;
          const text = document.createElement("b");
          text.textContent = value;
          row.append(key, text);
          detail.append(row);
        });
        return detail;
      }
    });
    if (currentControlRun.artifacts?.length) {
      controlArtifacts.hidden = false;
      controlArtifacts.replaceChildren();
      const label = document.createElement("strong");
      label.textContent = "Artifacts";
      controlArtifacts.append(label);
      currentControlRun.artifacts.forEach((artifact) => {
        controlArtifacts.append(document.createElement("br"));
        const line = document.createElement("span");
        line.textContent = `${artifact.type}: ${artifact.path}`;
        controlArtifacts.append(line);
      });
    } else {
      controlArtifacts.hidden = true;
      controlArtifacts.replaceChildren();
    }
    if (pendingApproval) {
      approvalCard.hidden = false;
      const boundary = approvalBoundaryForStep(pendingApproval.step, pendingApproval.reason);
      approvalTitle.textContent = `Approval required: ${controlStepLabel(pendingApproval.step)}`;
      approvalReason.textContent = [
        pendingApproval.reason,
        boundary === "hard"
          ? "Hard boundary: wallet, payment, login, credential, signing, or irreversible value actions cannot be trusted by site."
          : boundary === "public-submit"
            ? "Public-submit boundary: use approve once only when you have reviewed the page state."
            : "Safe-action boundary: you may approve once or trust this task class for this site."
      ].filter(Boolean).join("\n");
      approvalApproveButton.disabled = boundary === "hard";
      if (approvalAllowOnceButton) {
        approvalAllowOnceButton.disabled = boundary !== "safe";
        approvalAllowOnceButton.title = boundary === "safe"
          ? "Allow this safe task class for this execution only. This does not persist."
          : "One-time task-class consent never bypasses wallet, payment, login, credential, or public-submit boundaries.";
      }
      approvalTrustSiteButton.disabled = boundary !== "safe";
      approvalTrustSiteButton.title = boundary === "safe"
        ? "Trust safe non-sensitive actions for this task class on this site."
        : "Task trust never bypasses wallet, payment, login, credential, or public-submit boundaries.";
    } else {
      approvalCard.hidden = true;
      approvalApproveButton.disabled = false;
      if (approvalAllowOnceButton) approvalAllowOnceButton.disabled = false;
      approvalTrustSiteButton.disabled = false;
    }
    updateContextDockVisibility();
  }

  async function renderSitePermissionPanel(tab = null) {
    const current = tab ?? await activeTab();
    if (!getContextDockExpanded() || !isReadableBrowserTab(current)) {
      sitePermissionPanel.hidden = true;
      updateContextDockVisibility();
      return;
    }
    const mode = await permissionForUrl(current.url);
    sitePermissionPanel.hidden = false;
    sitePermissionHost.textContent = siteKeyForUrl(current.url);
    sitePermissionMode.value = mode;
    sitePermissionNote.textContent = sitePermissionDescription(mode);
    updateContextDockVisibility();
  }

  async function renderTaskConsentPanel(tab = null) {
    const current = tab ?? await activeTab();
    if (!getContextDockExpanded() || !isReadableBrowserTab(current)) {
      taskConsentPanel.hidden = true;
      updateContextDockVisibility();
      return;
    }
    const siteKey = siteKeyForUrl(current.url);
    const consents = Object.values(await getTaskConsents())
      .filter((consent) => consent.siteKey === siteKey)
      .sort((a, b) => b.grantedAt - a.grantedAt)
      .slice(0, 8);
    taskConsentPanel.hidden = consents.length === 0;
    taskConsentList.replaceChildren();
    if (!consents.length) {
      updateContextDockVisibility();
      return;
    }
    taskConsentTitle.textContent = `${consents.length} trusted task ${consents.length === 1 ? "class" : "classes"} for ${siteKey}`;
    consents.forEach((consent) => {
      const item = document.createElement("li");
      const details = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = consent.taskClass;
      const meta = document.createElement("small");
      const expiryLabel = consent.mode === "allow-once"
        ? `this execution only · ${consent.usesRemaining ?? 1} use remaining`
        : `expires ${new Date(consent.expiresAt).toLocaleDateString()}`;
      meta.textContent = [
        `${consent.mode} · ${expiryLabel}`,
        consent.reason ? `${consent.source || "human"} · ${consent.reason}` : ""
      ].filter(Boolean).join(" · ");
      details.append(title, meta);
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.title = `Revoke ${consent.taskClass} consent for ${siteKey}`;
      revoke.addEventListener("click", () => onRevokeTaskConsent?.(consent));
      item.append(details, revoke);
      taskConsentList.append(item);
    });
    updateContextDockVisibility();
  }

  async function renderPermissionManager() {
    if (!permissionManagerPanel || !permissionManagerList || !permissionManagerTitle) return;
    if (!getContextDockExpanded()) {
      permissionManagerPanel.hidden = true;
      updateContextDockVisibility();
      return;
    }
    const [sitePermissions, taskConsents, siteAudit, taskAudit] = await Promise.all([
      getSitePermissions().catch(() => ({})),
      getTaskConsents().catch(() => ({})),
      getSitePermissionAudit().catch(() => ({})),
      getTaskConsentAudit().catch(() => ({}))
    ]);
    const permissionEntries = Object.entries(sitePermissions)
      .filter(([siteKey, mode]) => siteKey && mode && mode !== "ask-before-action")
      .sort(([a], [b]) => a.localeCompare(b));
    const consentEntries = Object.values(taskConsents)
      .filter((consent) => consent.siteKey && consent.taskClass)
      .sort((a, b) => `${a.siteKey}::${a.taskClass}`.localeCompare(`${b.siteKey}::${b.taskClass}`));
    const activeConsentKeys = new Set(consentEntries.map((consent) => `${consent.siteKey}::${consent.taskClass}`));
    const taskHistoryEntries = Object.entries(taskAudit)
      .flatMap(([key, entries]) => (Array.isArray(entries) ? entries : []).map((entry) => ({ key, entry })))
      .filter(({ key, entry }) => !activeConsentKeys.has(key) || entry?.action !== "set")
      .sort((a, b) => Number(b.entry?.at ?? 0) - Number(a.entry?.at ?? 0))
      .slice(0, 12);
    permissionManagerPanel.hidden = permissionEntries.length === 0 && consentEntries.length === 0 && taskHistoryEntries.length === 0;
    permissionManagerList.replaceChildren();
    if (permissionManagerPanel.hidden) {
      updateContextDockVisibility();
      return;
    }
    const totalEntries = permissionEntries.length + consentEntries.length + taskHistoryEntries.length;
    permissionManagerTitle.textContent = `${totalEntries} browser ${totalEntries === 1 ? "grant/history entry" : "grant/history entries"}`;
    permissionEntries.forEach(([siteKey, mode]) => {
      const item = document.createElement("li");
      const details = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = siteKey;
      const meta = document.createElement("small");
      meta.textContent = [`site permission · ${mode}`, auditLabel(latestAudit(siteAudit, siteKey))].filter(Boolean).join(" · ");
      details.append(title, meta);
      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "Reset";
      reset.title = `Reset site permission for ${siteKey}`;
      reset.addEventListener("click", () => onResetSitePermission?.(siteKey));
      item.append(details, reset);
      permissionManagerList.append(item);
    });
    consentEntries.forEach((consent) => {
      const item = document.createElement("li");
      const details = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${consent.siteKey} · ${consent.taskClass}`;
      const meta = document.createElement("small");
      const auditKey = `${consent.siteKey}::${consent.taskClass}`;
      const expiryLabel = consent.mode === "allow-once"
        ? `this execution only · ${consent.usesRemaining ?? 1} use remaining`
        : `expires ${new Date(consent.expiresAt).toLocaleDateString()}`;
      meta.textContent = [
        `task-class consent · ${consent.mode} · ${expiryLabel}`,
        auditLabel(latestAudit(taskAudit, auditKey) ?? { action: "set", at: consent.grantedAt, source: consent.source, reason: consent.reason })
      ].filter(Boolean).join(" · ");
      details.append(title, meta);
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.title = `Revoke ${consent.taskClass} consent for ${consent.siteKey}`;
      revoke.addEventListener("click", () => onRevokeTaskConsent?.(consent));
      item.append(details, revoke);
      permissionManagerList.append(item);
    });
    taskHistoryEntries.forEach(({ key, entry }) => {
      const item = document.createElement("li");
      item.dataset.history = "true";
      const details = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${entry?.siteKey || key.split("::")[0]} · ${entry?.taskClass || key.split("::")[1] || "general"}`;
      const meta = document.createElement("small");
      meta.textContent = `task-class history · ${auditLabel(entry)}`;
      details.append(title, meta);
      item.append(details);
      permissionManagerList.append(item);
    });
    updateContextDockVisibility();
  }

  function renderJobMonitor() {
    const browserJobs = getBrowserJobs();
    const activeJobId = getActiveBrowserJobId();
    const jobMonitorCollapsed = getJobMonitorCollapsed();
    jobMonitor.hidden = !getContextDockExpanded() || browserJobs.length === 0;
    if (jobMonitor.hidden) {
      updateContextDockVisibility();
      return;
    }
    const activeCount = browserJobs.filter((job) => ["queued", "running", "paused", "approval"].includes(job.status)).length;
    const focusedJob = activeJobId ? browserJobs.find((job) => job.id === activeJobId) : null;
    const scheduler = getBrowserJobSchedulerState?.() ?? null;
    const schedulerText = scheduler
      ? ` · ${scheduler.runnableQueued.length} runnable · ${scheduler.lockBlockedQueued.length} locked`
      : "";
    jobMonitorTitle.textContent = `${activeCount} active · ${browserJobs.length} total${schedulerText}${focusedJob ? ` · focused ${focusedJob.id}` : ""}`;
    jobMonitorToggle.textContent = jobMonitorCollapsed ? "Show" : "Hide";
    jobList.hidden = jobMonitorCollapsed;
    jobList.replaceChildren();
    if (jobMonitorCollapsed) {
      updateContextDockVisibility();
      return;
    }
    // Surface jobs that still need a human first; Array.sort is stable, so this
    // keeps each group's recency order (the store hands us updatedAt-desc jobs).
    const orderedJobs = [...browserJobs].sort((left, right) => {
      const leftRank = ["queued", "running", "paused", "approval"].includes(left.status) ? 0 : 1;
      const rightRank = ["queued", "running", "paused", "approval"].includes(right.status) ? 0 : 1;
      return leftRank - rightRank;
    });
    orderedJobs.slice(0, 8).forEach((job) => {
      const item = document.createElement("li");
      item.dataset.status = job.status;
      item.dataset.active = job.id === activeJobId ? "true" : "false";
      // Settled jobs (completed / cancelled / denied) that aren't focused collapse
      // to a single readable line — goal + status + time + the two actions that
      // still apply — instead of the full diagnostic card meant for live work.
      if (isClearableBrowserJobStatus(job.status) && job.id !== activeJobId) {
        item.dataset.compact = "true";
        const compactDetails = document.createElement("div");
        const compactTitle = document.createElement("strong");
        compactTitle.textContent = job.goal;
        const compactMeta = document.createElement("small");
        compactMeta.textContent = `${job.status} · ${job.updatedAt.replace("T", " ").slice(0, 16)}`;
        compactDetails.append(compactTitle, compactMeta);
        const compactActions = document.createElement("div");
        compactActions.className = "job-actions";
        const addCompactButton = (label, buttonTitle, handler) => {
          if (typeof handler !== "function") return;
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.title = buttonTitle;
          button.addEventListener("click", () => handler(job));
          compactActions.append(button);
        };
        addCompactButton("Continue", `Continue ${job.goal}`, onContinueBrowserJob);
        addCompactButton("Report", `Save report for ${job.goal}`, onSaveBrowserJobReport);
        const compactState = document.createElement("span");
        compactState.className = "job-state";
        compactState.textContent = job.status;
        compactActions.append(compactState);
        item.append(compactDetails, compactActions);
        jobList.append(item);
        return;
      }
      const details = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = job.goal;
      const meta = document.createElement("small");
      meta.textContent = `${job.updatedAt.replace("T", " ").slice(0, 16)} · ${job.planner}`;
      const id = document.createElement("code");
      id.textContent = job.id;
      details.append(title, meta);
      if (job.id === activeJobId) {
        const focused = document.createElement("small");
        focused.className = "job-focused";
        focused.textContent = "Focused browser job";
        details.append(focused);
      }
      const ownership = document.createElement("small");
      ownership.className = "job-ownership";
      if (job.id === activeJobId) {
        ownership.textContent = job.pageLock?.tabId !== null && job.pageLock?.tabId !== undefined
          ? `Visible page owner: this job controls tab ${job.pageLock.tabId}.`
          : "Visible page owner: this job follows the active readable tab.";
      } else if (job.status === "approval" && job.pendingApproval) {
        ownership.textContent = job.pageLock?.tabId !== null && job.pageLock?.tabId !== undefined
          ? `Background approval: Focus activates tab ${job.pageLock.tabId} before approve or deny.`
          : "Background approval: Focus this job before approve or deny.";
      } else if (["queued", "running", "paused"].includes(job.status)) {
        ownership.textContent = "Background job: focus it before inspecting or continuing this task.";
      }
      if (ownership.textContent) {
        details.append(ownership);
      }
      if (job.preflightDecision) {
        const preflight = document.createElement("small");
        preflight.className = "job-preflight";
        preflight.textContent = preflightDecisionLabel(job.preflightDecision);
        details.append(preflight);
      }
      if (job.pageLock) {
        const lock = document.createElement("small");
        lock.className = "job-page-lock";
        lock.textContent = `Lock: ${job.pageLock.siteKey}${job.pageLock.tabId !== null ? ` · tab ${job.pageLock.tabId}` : ""}`;
        details.append(lock);
      }
      if (job.steps?.length) {
        const progress = document.createElement("small");
        progress.className = "job-progress";
        progress.textContent = `Progress: ${controlRunProgressSummary(job)}`;
        details.append(progress);
      }
      const recoveryEvidence = jobRecoveryEvidence(job);
      if (recoveryEvidence) {
        const recovery = document.createElement("small");
        recovery.className = "job-recovery-evidence";
        recovery.textContent = `Recovery evidence: ${recoveryEvidence}`;
        details.append(recovery);
      }
      const ambiguityEvidence = jobAmbiguityEvidence(job);
      if (ambiguityEvidence) {
        const ambiguity = document.createElement("small");
        ambiguity.className = "job-ambiguity-evidence";
        ambiguity.textContent = `Ambiguous target candidates: ${ambiguityEvidence}`;
        details.append(ambiguity);
      }
      const staleEvidence = staleBrowserJobEvidence(job);
      if (staleEvidence) {
        item.dataset.attention = "stale";
        const stale = document.createElement("small");
        stale.className = "job-stale-guidance";
        stale.textContent = `Attention: ${staleEvidence.reason} Last activity ${formatDurationMs(staleEvidence.ageMs)} ago. ${staleEvidence.nextHumanAction}`;
        details.append(stale);
      }
      if (scheduler?.runnableQueued?.some((candidate) => candidate.id === job.id)) {
        const runnable = document.createElement("small");
        runnable.className = "job-scheduler-state";
        runnable.textContent = `Scheduler: runnable when the runner is available (${scheduler.activeSlots}/${scheduler.maxConcurrent} active).`;
        details.append(runnable);
      }
      const locked = scheduler?.lockBlockedQueued?.find((candidate) => candidate.id === job.id);
      if (locked) {
        const blocked = document.createElement("small");
        blocked.className = "job-scheduler-state";
        blocked.textContent = `Scheduler: locked by ${locked.blockerId}${locked.blockerGoal ? ` · ${locked.blockerGoal}` : ""}.`;
        details.append(blocked);
      }
      if (scheduler?.capacityBlockedQueued?.some((candidate) => candidate.id === job.id)) {
        const waiting = document.createElement("small");
        waiting.className = "job-scheduler-state";
        waiting.textContent = `Scheduler: waiting for capacity (${scheduler.activeSlots}/${scheduler.maxConcurrent} active).`;
        details.append(waiting);
      }
      const nextHumanAction = jobNextHumanAction(job);
      if (nextHumanAction) {
        const blocker = document.createElement("small");
        blocker.className = "job-blocker-guidance";
        blocker.textContent = `Next human action: ${nextHumanAction}`;
        details.append(blocker);
      }
      if (job.status === "approval" && job.pendingApproval) {
        const evidence = pendingApprovalEvidence(job);
        const approval = document.createElement("aside");
        approval.className = "job-approval-card";
        const approvalTitle = document.createElement("strong");
        approvalTitle.textContent = `Approval needed: ${evidence.action}`;
        const approvalReason = document.createElement("p");
        approvalReason.textContent = evidence.reason;
        const preview = document.createElement("dl");
        [
          ["Page", evidence.title || "Unknown page"],
          ["URL", evidence.url || "unknown URL"],
          ["Target", evidence.target || "unknown target"]
        ].forEach(([label, value]) => {
          const term = document.createElement("dt");
          term.textContent = label;
          const definition = document.createElement("dd");
          definition.textContent = value;
          preview.append(term, definition);
        });
        const hint = document.createElement("small");
        hint.textContent = "Review the visible page state before approving. Public-submit, wallet, payment, login, signing, and credential boundaries stay human-gated.";
        approval.append(approvalTitle, approvalReason, preview, hint);
        details.append(approval);
      }
      details.append(id);
      const state = document.createElement("span");
      state.className = "job-state";
      state.textContent = job.status;
      const actions = document.createElement("div");
      actions.className = "job-actions";
      const addJobButton = (label, title, handler, { primary = false } = {}) => {
        if (typeof handler !== "function") return;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        if (primary) button.dataset.primary = "true";
        button.addEventListener("click", () => handler(job));
        actions.append(button);
      };
      if (job.id !== activeJobId && typeof onActivateBrowserJob === "function") {
        addJobButton("Focus", `Focus ${job.goal}`, onActivateBrowserJob);
      }
      if (job.status === "approval" && job.pendingApproval) {
        addJobButton("Approve once", `Approve the pending action for ${job.goal}`, onApproveBrowserJob, { primary: true });
        addJobButton("Deny", `Deny the pending action for ${job.goal}`, onDenyBrowserJob);
      }
      if (["queued", "running", "approval"].includes(job.status)) {
        addJobButton("Pause", `Pause ${job.goal}`, onPauseBrowserJob);
      }
      if (["queued", "running", "paused", "approval"].includes(job.status)) {
        addJobButton("Cancel", `Cancel ${job.goal}`, onCancelBrowserJob);
      }
      const canContinue = ["queued", "paused", "completed", "blocked", "failed", "cancelled", "denied"].includes(job.status);
      if (canContinue && typeof onContinueBrowserJob === "function") {
        addJobButton("Continue", `Continue ${job.goal}`, onContinueBrowserJob);
      }
      if (typeof onSaveBrowserJobReport === "function") {
        addJobButton("Report", `Save report for ${job.goal}`, onSaveBrowserJobReport);
      }
      actions.append(state);
      item.append(details, actions);
      if (job.steps?.length) {
        const steps = document.createElement("ol");
        steps.className = "job-step-replay";
        job.steps.slice(0, 5).forEach((step) => {
          const stepItem = document.createElement("li");
          stepItem.dataset.state = step.state;
          stepItem.textContent = `${controlActionStateLabel(step.state)} · ${step.label}`;
          steps.append(stepItem);
        });
        item.append(steps);
      }
      jobList.append(item);
    });
    updateContextDockVisibility();
  }

  return {
    renderControlMonitor,
    renderJobMonitor,
    renderPermissionManager,
    renderSitePermissionPanel,
    renderTaskConsentPanel
  };
}
