import {
  controlRunProgress,
  controlRunProgressSummary
} from "./monitor-renderers.js";

export function createControlReportingService({
  addMessage,
  bridgeRequest,
  getBridgeRequest,
  controlStepLabel,
  getCurrentControlRun,
  getLastSnapshot,
  getPendingApproval
}) {
  const bridge = () => (typeof getBridgeRequest === "function" ? getBridgeRequest() : bridgeRequest);
  const formatDurationMs = (value) => {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) return "";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} sec`;
    return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} sec`;
  };

  const stepTimingSuffix = (step) => {
    const duration = formatDurationMs(step?.timing?.durationMs);
    return duration ? ` · ${duration}` : "";
  };

  const stepEvidenceSuffix = (step) => {
    const confidence = step?.details?.confidence ? ` · confidence: ${step.details.confidence}` : "";
    return `${stepTimingSuffix(step)}${confidence}`;
  };

  const stepEvidenceLines = (step) => [
    step?.details?.strategyPhase ? `     - strategy phase: ${step.details.strategyPhase}` : "",
    step?.details?.strategyRationale ? `     - strategy rationale: ${step.details.strategyRationale}` : "",
    step?.details?.completionCheck ? `     - completion check: ${step.details.completionCheck}` : "",
    step?.details?.approvalDecision ? `     - approval decision: ${step.details.approvalDecision}` : "",
    step?.details?.scenarioName ? `     - scenario: ${step.details.scenarioName}` : "",
    ...(Array.isArray(step?.details?.successSignals)
      ? step.details.successSignals.filter(Boolean).slice(0, 5).map((signal, index) => `     - success signal ${index + 1}: ${signal}`)
      : []),
    ...(Array.isArray(step?.details?.stopConditions)
      ? step.details.stopConditions.filter(Boolean).slice(0, 5).map((condition, index) => `     - stop boundary ${index + 1}: ${condition}`)
      : []),
    ...(Array.isArray(step?.details?.preferredProbes)
      ? step.details.preferredProbes.filter(Boolean).slice(0, 5).map((probe, index) => `     - preferred probe ${index + 1}: ${probe}`)
      : []),
    step?.details?.humanInterventionState ? `     - human state: ${step.details.humanInterventionState}` : "",
    step?.details?.uncertainty ? `     - uncertainty: ${step.details.uncertainty}` : "",
    step?.details?.ambiguousTarget ? "     - ambiguous target: yes" : "",
    ...(Array.isArray(step?.details?.targetCandidates)
      ? step.details.targetCandidates.filter((candidate) => candidate?.ref || candidate?.label).slice(0, 8).map((candidate, index) => {
        const label = [
          candidate.label,
          candidate.ref ? `#${candidate.ref}` : "",
          candidate.visibleIndex ? `index:${candidate.visibleIndex}` : "",
          candidate.context ? `context:${candidate.context}` : "",
          candidate.form?.label ? `form:${candidate.form.label}` : "",
          candidate.fieldKind ? `kind:${candidate.fieldKind}` : "",
          candidate.approvalRequired ? "approval-required" : ""
        ].filter(Boolean).join(" · ");
        return `     - target candidate ${index + 1}: ${label}`;
      })
      : []),
    step?.details?.verificationRetry ? `     - verification retry: ${step.details.verificationRetry}` : "",
    step?.details?.actionRetry ? `     - action retry: ${step.details.actionRetry}` : "",
    step?.details?.nextHumanAction ? `     - next human action: ${step.details.nextHumanAction}` : "",
    ...(Array.isArray(step?.details?.recoveryOptions)
      ? step.details.recoveryOptions.filter(Boolean).slice(0, 4).map((option, index) => `     - recovery ${index + 1}: ${option}`)
      : [])
  ].filter(Boolean);

  const pageLockLines = (pageLock) => pageLock
    ? [
      `- targetSite: ${pageLock.siteKey || "unknown-site"}`,
      `- targetTab: ${pageLock.tabId !== null && pageLock.tabId !== undefined ? pageLock.tabId : "unknown"}`,
      `- targetUrl: ${pageLock.url || "unknown"}`,
      `- targetReason: ${pageLock.reason || "not recorded"}`
    ]
    : ["No controlled browser target was recorded."];

  const aggregateProgressLines = (run) => {
    const progress = controlRunProgress(run);
    return [
      `- phase: ${progress.phase}`,
      `- summary: ${controlRunProgressSummary(run)}`,
      `- completedSteps: ${progress.completed}`,
      `- totalSteps: ${progress.total}`,
      `- percentComplete: ${progress.percent}`,
      `- pendingSteps: ${progress.pending}`,
      `- blockedSteps: ${progress.blockedCount}`,
      `- failedSteps: ${progress.failed}`
    ];
  };

  const buildControlReport = (results, status) => {
    const currentControlRun = getCurrentControlRun();
    if (!currentControlRun) return "";
    const lastSnapshot = getLastSnapshot();
    return [
      "# Browser Agent Control Report",
      "",
      `- id: ${currentControlRun.id}`,
      `- status: ${status}`,
      `- planner: ${currentControlRun.planner}`,
      `- startedAt: ${currentControlRun.startedAt}`,
      `- completedAt: ${new Date().toISOString()}`,
      `- duration: ${formatDurationMs(currentControlRun.timing?.durationMs) || "unknown"}`,
      `- page: ${lastSnapshot?.title ?? "unknown"} (${lastSnapshot?.url ?? "unknown"})`,
      "",
      "## Controlled Target",
      ...pageLockLines(currentControlRun.pageLock),
      "",
      "## Aggregate Progress",
      ...aggregateProgressLines(currentControlRun),
      "",
      "## Goal",
      currentControlRun.goal,
      "",
      "## Plan",
      currentControlRun.summary,
      "",
      "## Steps",
      ...results.flatMap(({ step, result }, index) => [
        `${index + 1}. ${controlStepLabel(step)} — ${result?.ok ? "ok" : result?.approvalRequired ? "approval-required" : "failed"}${stepEvidenceSuffix(step)}${result?.error ? ` — ${result.error}` : ""}`,
        ...stepEvidenceLines(step)
      ]),
      "",
      "## Boundary",
      "This is an intake artifact only. Wallet, credential, public-submit, payment, and destructive actions require explicit human approval.",
      ""
    ].join("\n");
  };

  const saveControlReportToArchive = async (results, status) => {
    const currentControlRun = getCurrentControlRun();
    const lastSnapshot = getLastSnapshot();
    const content = buildControlReport(results, status);
    if (!content) return null;
    return bridge()("/archive/intake", {
      method: "POST",
      body: {
        title: `Browser control ${status}: ${currentControlRun?.goal ?? "task"}`.slice(0, 160),
        content,
        url: lastSnapshot?.url ?? null,
        sourceMessageId: currentControlRun?.id ?? null
      }
    }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  };

  const buildBrowserJobReport = (job) => {
    if (!job) return "";
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
    const preflight = job.preflightDecision;
    return [
      "# Browser Job Report",
      "",
      `- id: ${job.id}`,
      `- status: ${job.status}`,
      `- planner: ${job.planner}`,
      `- createdAt: ${job.createdAt}`,
      `- updatedAt: ${job.updatedAt}`,
      `- duration: ${formatDurationMs(job.timing?.durationMs) || "unknown"}`,
      "",
      "## Controlled Target",
      ...pageLockLines(job.pageLock),
      "",
      "## Aggregate Progress",
      ...aggregateProgressLines(job),
      "",
      "## Goal",
      job.goal,
      "",
      "## Summary",
      job.summary || "No summary recorded.",
      "",
      "## Preflight Decision",
      ...(preflight
        ? [
          `- mode: ${preflight.mode}`,
          `- site: ${preflight.siteKey}`,
          `- taskClass: ${preflight.taskClass}`,
          `- permissionMode: ${preflight.permissionMode || "unknown"}`,
          `- source: ${preflight.source}`,
          `- decidedAt: ${preflight.decidedAt || "unknown"}`,
          `- reason: ${preflight.reason || "none recorded"}`
        ]
        : ["No preflight decision was recorded for this job."]),
      "",
      "## Steps",
      ...(steps.length
        ? steps.flatMap((step, index) => [
          `${index + 1}. ${step.label} — ${step.state}${stepEvidenceSuffix(step)}${step.note ? ` — ${step.note}` : ""}`,
          ...stepEvidenceLines(step)
        ])
        : ["No persisted step transcript is available for this job."]),
      "",
      "## Artifacts",
      ...(artifacts.length
        ? artifacts.map((artifact) => `- ${artifact.type ?? "artifact"}: ${artifact.path ?? JSON.stringify(artifact)}`)
        : ["No artifacts recorded yet."]),
      "",
      "## Boundary",
      "This is an intake artifact only. Wallet, credential, public-submit, payment, and destructive actions require explicit human approval.",
      ""
    ].join("\n");
  };

  const buildControlDelegationPacket = () => {
    const pendingApproval = getPendingApproval();
    const currentControlRun = getCurrentControlRun();
    if (!pendingApproval && !currentControlRun) return "";
    const lastSnapshot = getLastSnapshot();
    const step = pendingApproval?.step;
    const steps = Array.isArray(currentControlRun?.steps) ? currentControlRun.steps : [];
    return [
      "# Browser Control Delegation Context",
      "",
      "## Requested Outcome",
      "Diagnose the blocked browser-control task and return a safe recovery plan or bounded implementation task. Do not request provider secrets, wallet signing, credentials, payment, or public submission authority.",
      "",
      "## Source Task",
      `- controlRunId: ${currentControlRun?.id ?? "unknown"}`,
      `- status: ${currentControlRun?.status ?? "unknown"}`,
      `- goal: ${currentControlRun?.goal ?? "unknown"}`,
      `- page: ${lastSnapshot?.title ?? "unknown"} (${lastSnapshot?.url ?? "unknown"})`,
      "",
      "## Controlled Target",
      ...pageLockLines(currentControlRun?.pageLock),
      "",
      "## Aggregate Progress",
      ...(currentControlRun ? aggregateProgressLines(currentControlRun) : ["No active control run progress was available."]),
      "",
      "## Blocker",
      step ? `- blockedStep: ${controlStepLabel(step)}` : "- blockedStep: not recorded",
      pendingApproval?.reason ? `- reason: ${pendingApproval.reason}` : "- reason: not recorded",
      ...(step?.details?.uncertainty ? [`- uncertainty: ${step.details.uncertainty}`] : []),
      ...(step?.details?.nextHumanAction ? [`- nextHumanAction: ${step.details.nextHumanAction}`] : []),
      "",
      "## Recent Trace",
      ...(steps.length
        ? steps.slice(-8).flatMap((traceStep, index) => [
          `${index + 1}. ${controlStepLabel(traceStep)} — ${traceStep.state ?? "unknown"}${stepEvidenceSuffix(traceStep)}${traceStep.note ? ` — ${traceStep.note}` : ""}`,
          ...stepEvidenceLines(traceStep)
        ])
        : ["No persisted step trace was available."]),
      "",
      "## Boundary",
      "The receiving add-on gets this context packet only. ResonantOS keeps provider routing, wallet actions, credentials, browser permissions, and trusted memory writes mediated.",
      ""
    ].join("\n");
  };

  const saveBrowserJobReportToArchive = async (job) => {
    const content = buildBrowserJobReport(job);
    if (!content) return null;
    return bridge()("/archive/intake", {
      method: "POST",
      body: {
        title: `Browser job ${job.status}: ${job.goal ?? "task"}`.slice(0, 160),
        content,
        url: null,
        sourceMessageId: job.id ?? null
      }
    }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  };

  const delegateControlIssue = async () => {
    const pendingApproval = getPendingApproval();
    const currentControlRun = getCurrentControlRun();
    if (!pendingApproval && !currentControlRun) return;
    const step = pendingApproval?.step;
    const result = await bridge()("/addons/delegate", {
      method: "POST",
      body: {
        target: "engineer",
        contextMarkdown: buildControlDelegationPacket(),
        source: "browser-control-blocker",
        sourceControlRunId: currentControlRun?.id ?? "",
        mission: [
          "Investigate blocked browser-control task.",
          `Goal: ${currentControlRun?.goal ?? "unknown"}`,
          step ? `Blocked step: ${controlStepLabel(step)}` : "",
          pendingApproval?.reason ? `Reason: ${pendingApproval.reason}` : ""
        ].filter(Boolean).join("\n")
      }
    }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    await addMessage(
      "system",
      result.error ? `Delegation failed: ${result.error}` : `Delegated blocked control task to ${result.target}: ${result.id}`
    );
  };

  return {
    buildBrowserJobReport,
    buildControlReport,
    buildControlDelegationPacket,
    delegateControlIssue,
    saveBrowserJobReportToArchive,
    saveControlReportToArchive
  };
}
