const TERMINAL_JOB_STATUSES = ["completed", "blocked", "denied", "cancelled", "failed"];
const ACTIVE_JOB_STATUSES = ["queued", "running", "paused", "approval"];
const LOCK_HOLDING_JOB_STATUSES = ["queued", "running", "approval"];
const VALID_JOB_STATUSES = [...ACTIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES];
const DEFAULT_STALE_JOB_THRESHOLD_MS = 15 * 60 * 1000;

const defaultNow = () => new Date().toISOString();
const defaultId = () => `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const VALID_PREFLIGHT_DECISION_MODES = [
  "approved-once",
  "allowed-task-class-once",
  "trusted-safe-actions",
  "skipped-by-consent",
  "resumed",
  "not-required"
];

function normalizeStepDetails(details) {
  if (!details || typeof details !== "object") return {};
  const confidence = String(details.confidence ?? "").toLowerCase();
  const normalizeList = (value, max = 5) => Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").slice(0, 220)).filter(Boolean).slice(0, max)
    : [];
  const recoveryOptions = Array.isArray(details.recoveryOptions)
    ? details.recoveryOptions.map((option) => String(option ?? "").slice(0, 220)).filter(Boolean).slice(0, 4)
    : [];
  const targetCandidates = Array.isArray(details.targetCandidates)
    ? details.targetCandidates
      .map((candidate) => ({
        approvalRequired: Boolean(candidate?.approvalRequired),
        context: candidate?.context ? String(candidate.context).slice(0, 160) : "",
        fieldKind: candidate?.fieldKind ? String(candidate.fieldKind).slice(0, 80) : "",
        form: candidate?.form && typeof candidate.form === "object"
          ? {
            id: candidate.form.id ? String(candidate.form.id).slice(0, 80) : "",
            index: Number.isFinite(Number(candidate.form.index)) ? Number(candidate.form.index) : null,
            label: candidate.form.label ? String(candidate.form.label).slice(0, 160) : "",
            name: candidate.form.name ? String(candidate.form.name).slice(0, 80) : ""
          }
          : null,
        label: candidate?.label ? String(candidate.label).slice(0, 160) : "",
        ref: candidate?.ref ? String(candidate.ref).slice(0, 80) : "",
        tagName: candidate?.tagName ? String(candidate.tagName).slice(0, 40) : "",
        visibleIndex: Number.isFinite(Number(candidate?.visibleIndex)) ? Number(candidate.visibleIndex) : null
      }))
      .filter((candidate) => candidate.ref || candidate.label)
      .slice(0, 8)
    : [];
  return {
    phase: details.phase ? String(details.phase).slice(0, 80) : null,
    observation: details.observation && typeof details.observation === "object"
      ? {
        title: details.observation.title ? String(details.observation.title).slice(0, 180) : null,
        url: details.observation.url ? String(details.observation.url).slice(0, 240) : null
      }
      : null,
    decision: details.decision ? String(details.decision).slice(0, 500) : null,
    action: details.action ? String(details.action).slice(0, 120) : null,
    approvalDecision: details.approvalDecision ? String(details.approvalDecision).slice(0, 80) : null,
    result: details.result ? String(details.result).slice(0, 500) : null,
    safetyClass: details.safetyClass ? String(details.safetyClass).slice(0, 80) : null,
    strategyPhase: details.strategyPhase ? String(details.strategyPhase).slice(0, 300) : null,
    strategyRationale: details.strategyRationale ? String(details.strategyRationale).slice(0, 500) : null,
    completionCheck: details.completionCheck ? String(details.completionCheck).slice(0, 500) : null,
    scenarioName: details.scenarioName ? String(details.scenarioName).slice(0, 160) : null,
    preferredProbes: normalizeList(details.preferredProbes),
    successSignals: normalizeList(details.successSignals),
    stopConditions: normalizeList(details.stopConditions),
    confidence: ["high", "medium", "low"].includes(confidence) ? confidence : null,
    humanInterventionState: details.humanInterventionState ? String(details.humanInterventionState).slice(0, 80) : null,
    uncertainty: details.uncertainty ? String(details.uncertainty).slice(0, 500) : null,
    ambiguousTarget: Boolean(details.ambiguousTarget),
    targetCandidates,
    verificationChanged: typeof details.verificationChanged === "boolean" ? details.verificationChanged : null,
    verificationRetry: details.verificationRetry ? String(details.verificationRetry).slice(0, 80) : null,
    actionRetry: details.actionRetry ? String(details.actionRetry).slice(0, 80) : null,
    nextHumanAction: details.nextHumanAction ? String(details.nextHumanAction).slice(0, 500) : null,
    recoveryOptions
  };
}

function normalizeTiming(timing) {
  if (!timing || typeof timing !== "object") return {};
  const normalized = {};
  for (const key of ["startedAt", "completedAt"]) {
    if (timing[key]) normalized[key] = String(timing[key]).slice(0, 40);
  }
  for (const key of ["startedAtMs", "completedAtMs", "durationMs"]) {
    const value = Number(timing[key]);
    if (Number.isFinite(value) && value >= 0) normalized[key] = value;
  }
  return normalized;
}

function boundedJsonClone(value, { maxChars = 20_000 } = {}) {
  if (value === null || value === undefined) return value;
  try {
    const json = JSON.stringify(value);
    if (json.length > maxChars) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function normalizePendingApproval(approval) {
  if (!approval || typeof approval !== "object") return null;
  const stepIndex = Number(approval.stepIndex);
  const step = approval.step && typeof approval.step === "object"
    ? boundedJsonClone(approval.step, { maxChars: 4_000 })
    : null;
  if (!step) return null;
  return {
    history: Array.isArray(approval.history)
      ? boundedJsonClone(approval.history.slice(-20), { maxChars: 12_000 }) ?? []
      : [],
    reason: String(approval.reason ?? "This browser action requires human approval.").slice(0, 700),
    results: Array.isArray(approval.results)
      ? boundedJsonClone(approval.results.slice(-20), { maxChars: 12_000 }) ?? []
      : [],
    step,
    stepIndex: Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : 0
  };
}

export function normalizePreflightDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  return {
    id: decision.id ? String(decision.id).slice(0, 120) : "",
    goal: String(decision.goal ?? "").slice(0, 300),
    siteKey: String(decision.siteKey ?? "unknown-site").slice(0, 120),
    taskClass: String(decision.taskClass ?? "general").slice(0, 80),
    mode: VALID_PREFLIGHT_DECISION_MODES.includes(decision.mode) ? decision.mode : "not-required",
    permissionMode: String(decision.permissionMode ?? "").slice(0, 80),
    decidedAt: decision.decidedAt ? String(decision.decidedAt).slice(0, 40) : "",
    source: String(decision.source ?? "control-preflight").slice(0, 80),
    reason: String(decision.reason ?? "").slice(0, 240)
  };
}

export function normalizePageLock(lock, { now = defaultNow } = {}) {
  if (!lock || typeof lock !== "object") return null;
  const tabId = Number(lock.tabId);
  const hasTabId = Number.isInteger(tabId) && tabId >= 0;
  const url = String(lock.url ?? "").slice(0, 240);
  const siteKey = String(lock.siteKey ?? "").slice(0, 120);
  if (!hasTabId && !url && !siteKey) return null;
  return {
    type: lock.type === "page" ? "page" : "tab",
    tabId: hasTabId ? tabId : null,
    url,
    siteKey: siteKey || "unknown-site",
    acquiredAt: lock.acquiredAt ? String(lock.acquiredAt).slice(0, 40) : now(),
    reason: String(lock.reason ?? "Agent Control owns this browser target.").slice(0, 180)
  };
}

export function normalizeBrowserJob(job, { now = defaultNow } = {}) {
  const status = VALID_JOB_STATUSES.includes(job?.status) ? job.status : "queued";
  const steps = Array.isArray(job?.steps)
    ? job.steps.slice(0, 30).map((step) => ({
      type: String(step?.type ?? "step").slice(0, 80),
      label: String(step?.label ?? step?.text ?? step?.url ?? step?.query ?? step?.type ?? "step").slice(0, 180),
      state: String(step?.state ?? "pending").slice(0, 40),
      note: String(step?.note ?? "").slice(0, 240),
      details: normalizeStepDetails(step?.details),
      timing: normalizeTiming(step?.timing),
      updatedAt: step?.updatedAt ? String(step.updatedAt).slice(0, 40) : null
    }))
    : [];
  return {
    id: String(job?.id ?? `job-${Date.now()}`),
    goal: String(job?.goal ?? "Browser job").slice(0, 300),
    status,
    createdAt: job?.createdAt ?? job?.updatedAt ?? now(),
    updatedAt: job?.updatedAt ?? now(),
    completedAt: job?.completedAt ?? null,
    planner: String(job?.planner ?? "observe-act-verify-loop").slice(0, 120),
    summary: String(job?.summary ?? "").slice(0, 700),
    artifacts: Array.isArray(job?.artifacts) ? job.artifacts.slice(0, 20) : [],
    lastError: job?.lastError ? String(job.lastError).slice(0, 700) : null,
    pendingApproval: status === "approval" ? normalizePendingApproval(job?.pendingApproval) : null,
    preflightDecision: normalizePreflightDecision(job?.preflightDecision),
    pageLock: LOCK_HOLDING_JOB_STATUSES.includes(status) ? normalizePageLock(job?.pageLock, { now }) : null,
    timing: normalizeTiming(job?.timing),
    steps
  };
}

export function isTerminalBrowserJobStatus(status) {
  return TERMINAL_JOB_STATUSES.includes(status);
}

export function isActiveBrowserJobStatus(status) {
  return ACTIVE_JOB_STATUSES.includes(status);
}

export function isLockHoldingBrowserJobStatus(status) {
  return LOCK_HOLDING_JOB_STATUSES.includes(status);
}

function parseTimeMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function latestBrowserJobActivityMs(job) {
  const times = [
    parseTimeMs(job?.createdAt),
    parseTimeMs(job?.updatedAt),
    parseTimeMs(job?.timing?.startedAt),
    parseTimeMs(job?.timing?.completedAt),
    parseTimeMs(job?.timing?.startedAtMs),
    parseTimeMs(job?.timing?.completedAtMs)
  ];
  if (Array.isArray(job?.steps)) {
    for (const step of job.steps) {
      times.push(
        parseTimeMs(step?.updatedAt),
        parseTimeMs(step?.timing?.startedAt),
        parseTimeMs(step?.timing?.completedAt),
        parseTimeMs(step?.timing?.startedAtMs),
        parseTimeMs(step?.timing?.completedAtMs)
      );
    }
  }
  return Math.max(...times.filter((time) => Number.isFinite(time)), 0);
}

export function staleBrowserJobEvidence(job, {
  now = defaultNow,
  thresholdMs = DEFAULT_STALE_JOB_THRESHOLD_MS
} = {}) {
  const normalizedNow = typeof now === "function" ? now : () => String(now);
  const normalized = normalizeBrowserJob(job, { now: normalizedNow });
  if (!["running", "approval"].includes(normalized.status)) return null;
  const currentTimeMs = parseTimeMs(typeof now === "function" ? now() : now);
  const lastActivityMs = latestBrowserJobActivityMs({
    ...normalized,
    createdAt: job?.createdAt ?? null
  });
  const threshold = Number.isFinite(Number(thresholdMs)) && Number(thresholdMs) > 0
    ? Number(thresholdMs)
    : DEFAULT_STALE_JOB_THRESHOLD_MS;
  if (!Number.isFinite(currentTimeMs) || !lastActivityMs) return null;
  const ageMs = currentTimeMs - lastActivityMs;
  if (ageMs < threshold) return null;
  const awaitingApproval = normalized.status === "approval";
  return {
    ageMs,
    lastActivityAt: new Date(lastActivityMs).toISOString(),
    nextHumanAction: awaitingApproval
      ? "Review the pending approval card, then approve once, trust safe actions where allowed, deny, pause, or cancel."
      : "Check the page state. If the task is still valid, continue the job; otherwise pause, cancel, or save a report.",
    reason: awaitingApproval
      ? "Approval has been waiting without recorded progress."
      : "Running job has no recent recorded progress.",
    thresholdMs: threshold
  };
}

function pageLocksConflict(left, right) {
  const leftLock = normalizePageLock(left);
  const rightLock = normalizePageLock(right);
  if (!leftLock || !rightLock) return false;
  if (leftLock.tabId !== null && rightLock.tabId !== null && leftLock.tabId === rightLock.tabId) return true;
  if (leftLock.siteKey && leftLock.siteKey !== "unknown-site" && leftLock.siteKey === rightLock.siteKey) return true;
  return Boolean(leftLock.url && leftLock.url === rightLock.url);
}

function schedulerJobSummary(job, blocker = null) {
  return {
    blockerGoal: blocker?.goal ?? "",
    blockerId: blocker?.id ?? "",
    goal: job.goal,
    id: job.id,
    pageLock: job.pageLock,
    status: job.status
  };
}

export function browserJobSchedulerState(jobs = [], { maxConcurrent = 1 } = {}) {
  const normalizedJobs = Array.isArray(jobs) ? jobs.map((job) => normalizeBrowserJob(job)) : [];
  const capacity = Math.max(1, Math.min(8, Number.isFinite(Number(maxConcurrent)) ? Math.trunc(Number(maxConcurrent)) : 1));
  const runningJobs = normalizedJobs.filter((job) => job.status === "running");
  const approvalJobs = normalizedJobs.filter((job) => job.status === "approval");
  const queuedJobs = normalizedJobs.filter((job) => job.status === "queued");
  const pausedJobs = normalizedJobs.filter((job) => job.status === "paused");
  const terminalJobs = normalizedJobs.filter((job) => isTerminalBrowserJobStatus(job.status));
  const lockHolders = [...runningJobs, ...approvalJobs]
    .filter((job) => job.pageLock);
  const activeSlots = runningJobs.length + approvalJobs.length;
  const availableSlots = Math.max(0, capacity - activeSlots);
  const runnableQueued = [];
  const lockBlockedQueued = [];
  const capacityBlockedQueued = [];

  for (const job of queuedJobs) {
    const blocker = job.pageLock
      ? lockHolders.find((holder) => pageLocksConflict(job.pageLock, holder.pageLock)) ?? null
      : null;
    if (blocker) {
      lockBlockedQueued.push(schedulerJobSummary(job, blocker));
      continue;
    }
    if (runnableQueued.length < availableSlots) {
      runnableQueued.push(schedulerJobSummary(job));
      if (job.pageLock) {
        lockHolders.push(job);
      }
      continue;
    }
    capacityBlockedQueued.push(schedulerJobSummary(job));
  }

  return {
    activeSlots,
    approval: approvalJobs.length,
    availableSlots,
    capacityBlockedQueued,
    lockBlockedQueued,
    maxConcurrent: capacity,
    paused: pausedJobs.length,
    queued: queuedJobs.length,
    runnableQueued,
    running: runningJobs.length,
    terminal: terminalJobs.length,
    total: normalizedJobs.length
  };
}

export function createBrowserJobStore({
  storage,
  storageKeys,
  maxJobs = 40,
  now = defaultNow,
  createId = defaultId
}) {
  let jobs = [];
  let activeJobId = null;
  let monitorCollapsed = true;

  function compact(nextJobs = jobs) {
    jobs = nextJobs
      .map((job) => normalizeBrowserJob(job, { now }))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, maxJobs);
    if (activeJobId && !jobs.some((job) => job.id === activeJobId)) {
      activeJobId = null;
    }
    return jobs;
  }

  async function persist() {
    compact();
    await storage?.set?.({
      [storageKeys.activeBrowserJob]: activeJobId,
      [storageKeys.browserJobs]: jobs,
      [storageKeys.jobMonitorCollapsed]: monitorCollapsed
    }).catch(() => undefined);
    return snapshot();
  }

  async function hydrate() {
    const stored = await storage?.get?.([
      storageKeys.browserJobs,
      storageKeys.activeBrowserJob,
      storageKeys.jobMonitorCollapsed
    ]).catch(() => ({}));
    jobs = Array.isArray(stored?.[storageKeys.browserJobs])
      ? stored[storageKeys.browserJobs].map((job) => normalizeBrowserJob(job, { now }))
      : [];
    monitorCollapsed = typeof stored?.[storageKeys.jobMonitorCollapsed] === "boolean"
      ? stored[storageKeys.jobMonitorCollapsed]
      : true;
    compact();
    const storedActiveJobId = String(stored?.[storageKeys.activeBrowserJob] ?? "");
    const storedActiveJob = jobs.find((job) => job.id === storedActiveJobId) ?? null;
    activeJobId = storedActiveJob && isActiveBrowserJobStatus(storedActiveJob.status)
      ? storedActiveJob.id
      : firstActiveJobId() ?? storedActiveJob?.id ?? null;
    return snapshot();
  }

  function snapshot() {
    return {
      activeJobId,
      jobs,
      monitorCollapsed
    };
  }

  function getJobs() {
    return jobs;
  }

  function getActiveJobId() {
    return activeJobId;
  }

  function getMonitorCollapsed() {
    return monitorCollapsed;
  }

  function getSchedulerState(options = {}) {
    return browserJobSchedulerState(jobs, options);
  }

  function firstActiveJobId({ excludingJobId = "" } = {}) {
    return jobs.find((job) => job.id !== excludingJobId && isActiveBrowserJobStatus(job.status))?.id ?? null;
  }

  function getStaleJobs(options = {}) {
    return jobs
      .map((job) => ({ evidence: staleBrowserJobEvidence(job, { now, ...options }), job }))
      .filter((entry) => entry.evidence);
  }

  function currentJob() {
    return jobs.find((job) => job.id === activeJobId) ?? null;
  }

  function conflictingActiveJobForLock(lock, { excludingJobId = "" } = {}) {
    const normalizedLock = normalizePageLock(lock, { now });
    if (!normalizedLock) return null;
    return jobs.find((job) => {
      if (job.id === excludingJobId) return false;
      if (!isLockHoldingBrowserJobStatus(job.status) || !job.pageLock) return false;
      if (normalizedLock.tabId !== null && job.pageLock.tabId === normalizedLock.tabId) return true;
      if (normalizedLock.siteKey && normalizedLock.siteKey !== "unknown-site" && job.pageLock.siteKey === normalizedLock.siteKey) return true;
      return Boolean(normalizedLock.url && job.pageLock.url === normalizedLock.url);
    }) ?? null;
  }

  function findJob(idOrGoal = "") {
    const needle = String(idOrGoal ?? "").trim().toLowerCase();
    if (!needle) return currentJob() ?? jobs[0] ?? null;
    return jobs.find((job) =>
      job.id.toLowerCase() === needle ||
      job.id.toLowerCase().includes(needle) ||
      job.goal.toLowerCase().includes(needle)
    ) ?? null;
  }

  async function createJob({ goal, planner = "observe-act-verify-loop", summary = "", preflightDecision = null, pageLock = null, status = "running", activate = true }) {
    const normalizedLock = normalizePageLock(pageLock, { now });
    const conflict = conflictingActiveJobForLock(normalizedLock);
    const initialStatus = VALID_JOB_STATUSES.includes(status) ? status : "running";
    if (conflict && initialStatus !== "queued") {
      throw new Error(`Browser target is already controlled by ${conflict.id}: ${conflict.goal}`);
    }
    const job = normalizeBrowserJob({
      id: createId(),
      goal,
      planner,
      summary,
      preflightDecision,
      pageLock: normalizedLock,
      status: initialStatus,
      createdAt: now(),
      updatedAt: now()
    }, { now });
    jobs = compact([job, ...jobs.filter((item) => item.id !== job.id)]);
    if (activate) {
      activeJobId = job.id;
    }
    await persist();
    return job;
  }

  async function updateJob(jobId, patch) {
    if (!jobId) return null;
    const normalizedPatchLock = Object.prototype.hasOwnProperty.call(patch, "pageLock")
      ? normalizePageLock(patch.pageLock, { now })
      : undefined;
    if (normalizedPatchLock) {
      const conflict = conflictingActiveJobForLock(normalizedPatchLock, { excludingJobId: jobId });
      if (conflict) {
        throw new Error(`Browser target is already controlled by ${conflict.id}: ${conflict.goal}`);
      }
    }
    let updated = null;
    jobs = jobs.map((job) => {
      if (job.id !== jobId) return job;
      const requestedStatus = patch.status ?? job.status;
      const preserveHumanStop = ["cancelled", "paused"].includes(job.status) &&
        !["cancelled", "paused"].includes(requestedStatus) &&
        !patch.allowHumanStopOverride;
      const status = preserveHumanStop ? job.status : requestedStatus;
      updated = normalizeBrowserJob({
        ...job,
        ...patch,
        status,
        pageLock: normalizedPatchLock !== undefined
          ? normalizedPatchLock
          : isLockHoldingBrowserJobStatus(status) ? job.pageLock : null,
        updatedAt: now(),
        completedAt: patch.completedAt ?? (isTerminalBrowserJobStatus(patch.status) ? now() : job.completedAt)
      }, { now });
      return updated;
    });
    if (updated && activeJobId === jobId && isTerminalBrowserJobStatus(updated.status)) {
      activeJobId = firstActiveJobId({ excludingJobId: jobId }) ?? activeJobId;
    }
    await persist();
    return updated;
  }

  async function activateJob(jobId) {
    const job = jobs.find((item) => item.id === jobId) ?? null;
    activeJobId = job?.id ?? null;
    await persist();
    return job;
  }

  async function recoverInterruptedJobs({ from = ["running"], to = "paused", reason = "Recovered after browser host reload" } = {}) {
    const interruptedStatuses = new Set(from);
    let recovered = [];
    jobs = jobs.map((job) => {
      if (!interruptedStatuses.has(job.status)) return job;
      const recoveredJob = normalizeBrowserJob({
        ...job,
        status: to,
        lastError: reason,
        updatedAt: now()
      }, { now });
      recovered = [...recovered, recoveredJob];
      return recoveredJob;
    });
    if (activeJobId && !jobs.some((job) => job.id === activeJobId && isActiveBrowserJobStatus(job.status))) {
      activeJobId = recovered[0]?.id ?? jobs.find((job) => isActiveBrowserJobStatus(job.status))?.id ?? null;
    }
    if (!activeJobId && recovered.length) {
      activeJobId = recovered[0].id;
    }
    if (recovered.length) {
      await persist();
    }
    return recovered;
  }

  async function setMonitorCollapsed(collapsed) {
    monitorCollapsed = Boolean(collapsed);
    await persist();
    return monitorCollapsed;
  }

  async function toggleMonitorCollapsed() {
    return setMonitorCollapsed(!monitorCollapsed);
  }

  return {
    activateJob,
    conflictingActiveJobForLock,
    createJob,
    currentJob,
    findJob,
    getActiveJobId,
    getJobs,
    getMonitorCollapsed,
    getSchedulerState,
    getStaleJobs,
    hydrate,
    persist,
    recoverInterruptedJobs,
    setMonitorCollapsed,
    snapshot,
    toggleMonitorCollapsed,
    updateJob
  };
}
