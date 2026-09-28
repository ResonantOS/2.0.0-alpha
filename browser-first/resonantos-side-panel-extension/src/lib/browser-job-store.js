import { redactTraceText, redactTraceValue } from "./trace-redaction.js";

const TERMINAL_JOB_STATUSES = ["completed", "blocked", "denied", "cancelled", "failed"];
const ACTIVE_JOB_STATUSES = ["queued", "running", "paused", "approval"];
const LOCK_HOLDING_JOB_STATUSES = ["queued", "running", "approval"];
const VALID_JOB_STATUSES = [...ACTIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES];
// "Settled" jobs the human can clear or collapse in the monitor: finished with
// nothing left to act on. blocked/failed are intentionally excluded — they
// usually still need a human, so "Clear done" must not silently discard them.
const CLEARABLE_JOB_STATUSES = ["completed", "cancelled", "denied"];
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

export function isClearableBrowserJobStatus(status) {
  return CLEARABLE_JOB_STATUSES.includes(status);
}

export function isActiveBrowserJobStatus(status) {
  return ACTIVE_JOB_STATUSES.includes(status);
}

// A job is "blocking" when it needs the human before it can go on: awaiting
// approval, or blocked/failed/denied. Drives the dock's red activity dot the
// same way on both surfaces.
const BLOCKING_JOB_STATUSES = new Set(["approval", "blocked", "failed", "denied"]);
export function hasBlockingBrowserJob(jobs = []) {
  return (Array.isArray(jobs) ? jobs : []).some(
    (job) => BLOCKING_JOB_STATUSES.has(job?.status) || Boolean(job?.pendingApproval)
  );
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

// Admission uses the original JSON sizes first, then checks sanitized sizes.
// A rejected executable step must never reappear because redaction shrank it.
function sanitizedJobInput(input) {
  const clean = redactTraceValue(input);
  if (Object.hasOwn(input, "pendingApproval")) {
    const admitted = normalizePendingApproval(input.pendingApproval);
    clean.pendingApproval = admitted ? normalizePendingApproval({
      ...redactTraceValue(admitted),
      reason: redactTraceText(String(input.pendingApproval.reason ?? "This browser action requires human approval."))
    }) : null;
  }
  return clean;
}

const SAVED_TARGET_REDACTED = "Saved target details were redacted. Check the page before resuming.";
const changedRouting = (value, fields) => Boolean(value && fields.some((field) => {
  const text = String(value[field] ?? "");
  return redactTraceText(text) !== text;
}));

function selectSafeId(value, reserved, nextReplacement) {
  const original = String(value);
  if (redactTraceText(original) === original && !reserved.has(original)) return original;
  let id;
  do { id = `job-redacted-${nextReplacement()}`; } while (reserved.has(id));
  return id;
}

function durableRecord(input, live, previous = null) {
  const clean = sanitizedJobInput(input);
  const unsafeLock = Object.hasOwn(input, "pageLock")
    ? changedRouting(input.pageLock, ["url", "siteKey"]) : previous?.unsafeLock ?? false;
  const unsafePreflight = Object.hasOwn(input, "preflightDecision")
    ? changedRouting(input.preflightDecision, ["id", "siteKey", "taskClass"]) : previous?.unsafePreflight ?? false;
  const candidate = {
    ...previous?.job, ...clean,
    id: live.id, status: live.status,
    createdAt: redactTraceValue(live.createdAt),
    updatedAt: redactTraceValue(live.updatedAt),
    completedAt: redactTraceValue(live.completedAt)
  };
  if (unsafeLock) candidate.pageLock = null;
  if (unsafePreflight) candidate.preflightDecision = null;
  if ((unsafeLock || unsafePreflight) && LOCK_HOLDING_JOB_STATUSES.includes(candidate.status)) {
    candidate.status = "paused";
    candidate.pageLock = null;
    candidate.pendingApproval = null;
    candidate.lastError = SAVED_TARGET_REDACTED;
  }
  return { job: normalizeBrowserJob(candidate, { now: () => live.updatedAt }), unsafeLock, unsafePreflight };
}

// External mutations coordinate only within this realm, adapter and jobs key.
// Live stores retain their own hydration/write queues and failed-read guards.
const externalMutationQueues = new WeakMap();
class BrowserJobMutationError extends Error {
  constructor(message, code = "storage") { super(message); this.code = code; }
}
const unsafeFocus = () => new BrowserJobMutationError(
  "This saved browser job cannot be focused safely. Reopen the side panel to reload and repair browser job history.",
  "unsafe-focus"
);
const focusableId = (id) => typeof id === "string" && id.length > 0 &&
  !/[\s\u0000-\u001f\u007f-\u009f]/u.test(id) && redactTraceText(id) === id;
const objectRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function mutateBrowserJobStorage({ storage, storageKeys, mutation, now = defaultNow }) {
  if (typeof storage?.get !== "function" || typeof storage?.set !== "function") {
    return Promise.reject(new BrowserJobMutationError("Browser job storage is unavailable."));
  }
  const jobsKey = storageKeys?.browserJobs ?? "augmentorBrowserJobs";
  const activeKey = storageKeys?.activeBrowserJob ?? "augmentorActiveBrowserJob";
  const promptKey = storageKeys?.pendingSidebarPrompt ?? "augmentorPendingSidebarPrompt";
  const operation = async () => {
    try {
      // Settings adapters accept string keys; Chrome storage and workspace
      // adapters accept them too. Missing history is unknown, never empty.
      const history = await storage.get(jobsKey);
      if (!objectRecord(history) || !Object.hasOwn(history, jobsKey) || !Array.isArray(history[jobsKey])) {
        throw new BrowserJobMutationError("Browser job history could not be read safely.");
      }
      const originals = history[jobsKey];
      for (const record of originals) {
        if (!objectRecord(record)) throw new BrowserJobMutationError("Browser job history could not be read safely.");
      }
      const active = Object.hasOwn(history, activeKey) ? history : await storage.get(activeKey);
      if (!objectRecord(active)) {
        throw new BrowserJobMutationError("Browser job history could not be read safely.");
      }
      const stored = { [activeKey]: active[activeKey] };
      const { type, jobId, command } = mutation;
      if (!["cancel", "clear-settings-terminal", "focus"].includes(type)) {
        throw new BrowserJobMutationError("Browser job mutation is unavailable.");
      }
      const matches = originals.filter((job) => job.id === jobId);
      if (type === "focus") {
        if (matches.length !== 1 || !focusableId(jobId)) throw unsafeFocus();
        if (!["jobs focus", "pause", "continue"].includes(command)) throw unsafeFocus();
        const envelope = redactTraceValue({
          [activeKey]: jobId,
          [promptKey]: { createdAt: now(), prompt: `/${command} ${jobId}` }
        });
        await storage.set(envelope);
        return { changed: true, job: null, removed: 0, activeJobId: jobId };
      }
      if (type === "cancel" && matches.length > 1) {
        throw new BrowserJobMutationError("Browser job identity could not be resolved safely.");
      }
      const target = matches[0];
      if (type === "cancel" && (!target || isTerminalBrowserJobStatus(target.status))) {
        return { changed: false, job: null, removed: 0, activeJobId: redactTraceValue(stored[activeKey] ?? null) };
      }
      const timestamp = now();
      const reserved = new Set(originals.map((job) => String(job.id ?? "")));
      const counts = new Map();
      for (const job of originals) counts.set(job.id, (counts.get(job.id) ?? 0) + 1);
      let replacementIndex = 0;
      const mapped = new Map();
      let removed = 0;
      const jobs = [];
      for (const original of originals) {
        // Settings selects by original status, before invalid-status quarantine.
        if (type === "clear-settings-terminal" && isTerminalBrowserJobStatus(original.status)) {
          removed++; continue;
        }
        const id = focusableId(original.id) && counts.get(original.id) === 1
          ? original.id : selectSafeId(original.id ?? "", reserved, () => ++replacementIndex);
        reserved.add(id);
        let input = { ...original, id };
        if (type === "cancel" && original === target) {
          input = { ...input, status: "cancelled", updatedAt: timestamp, completedAt: timestamp, pageLock: null };
        } else if (!VALID_JOB_STATUSES.includes(original.status)) {
          input = { ...input, status: "paused", pendingApproval: null, pageLock: null, preflightDecision: null,
            lastError: "Saved job status was invalid. Review this job before continuing." };
        }
        const live = normalizeBrowserJob(sanitizedJobInput(input), { now: () => timestamp });
        const job = durableRecord(input, live).job;
        mapped.set(original, job);
        jobs.push(job);
      }
      const activeMatches = originals.filter((job) => job.id === stored[activeKey]);
      const focused = stored[activeKey] != null && stored[activeKey] !== "" && activeMatches.length === 1
        ? mapped.get(activeMatches[0]) : null;
      const committedTarget = type === "cancel" ? mapped.get(target) : null;
      const activeJobId = focused?.id ?? committedTarget?.id ?? null;
      const envelope = redactTraceValue({
        [jobsKey]: jobs,
        ...(type === "cancel" || activeJobId !== (stored[activeKey] ?? null) ? { [activeKey]: activeJobId } : {})
      });
      const result = redactTraceValue({ changed: true, job: committedTarget, removed, activeJobId });
      await storage.set(envelope);
      return result;
    } catch (error) {
      if (error instanceof BrowserJobMutationError) throw error;
      throw new BrowserJobMutationError("Browser job history could not be updated safely.");
    }
  };
  let queues = externalMutationQueues.get(storage);
  if (!queues) { queues = new Map(); externalMutationQueues.set(storage, queues); }
  const previous = queues.get(jobsKey);
  const result = previous ? previous.then(operation) : operation();
  const settled = () => { if (queues.get(jobsKey) === tail) queues.delete(jobsKey); };
  const tail = result.then(settled, settled);
  queues.set(jobsKey, tail);
  return result;
}

export function createBrowserJobStore({
  storage,
  storageKeys,
  maxJobs = 40,
  now = defaultNow,
  createId = defaultId
}) {
  let jobs = [];
  // Each immutable identity pairs a live record with its pre-truncation
  // sanitized durable record and routing invalidation state.
  let durableJobs = new Map();
  let hydrationQueue = null;
  let writeQueue = null;
  let historyReadBlocked = false;
  const enqueue = (operation) => (...args) => {
    // Ordinary mutations update live state immediately, as scheduler callers
    // require. Only hydration gates them; writes serialize detached snapshots.
    const barrier = hydrationQueue ?? (operation === hydrate ? writeQueue : null);
    const result = barrier ? barrier.then(() => operation(...args)) : operation(...args);
    if (operation === hydrate) {
      const settled = () => { if (hydrationQueue === tail) hydrationQueue = null; };
      const tail = result.then(settled, settled);
      hydrationQueue = tail;
    }
    return result;
  };
  function writeEnvelope(envelope, { hydration = false } = {}) {
    const save = () => historyReadBlocked && !hydration
      ? undefined
      : storage?.set?.(envelope).catch(() => undefined);
    const result = writeQueue ? writeQueue.then(save) : Promise.resolve(save());
    const settled = () => { if (writeQueue === tail) writeQueue = null; };
    const tail = result.then(settled, settled);
    writeQueue = tail;
    return result;
  }
  let replacementIndex = 0;
  function safeId(value, reserved) {
    return selectSafeId(value, reserved, () => ++replacementIndex);
  }

  let activeJobId = null;
  let monitorCollapsed = true;

  function compact(nextJobs = jobs) {
    jobs = nextJobs
      .map((job) => normalizeBrowserJob(job, { now }))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, maxJobs);
    durableJobs = new Map(jobs.map((job) => [job.id, durableJobs.get(job.id)]));
    if (activeJobId && !jobs.some((job) => job.id === activeJobId)) {
      activeJobId = null;
    }
    return jobs;
  }

  async function persist() {
    compact();
    await writeEnvelope({
      [storageKeys.activeBrowserJob]: activeJobId,
      [storageKeys.browserJobs]: redactTraceValue(jobs.map((job) => durableJobs.get(job.id).job)),
      [storageKeys.jobMonitorCollapsed]: monitorCollapsed
    });
    return snapshot();
  }

  async function hydrate() {
    // A mutation queued behind an earlier hydration may have started a write
    // since this hydration was queued. Read only after that snapshot settles.
    if (writeQueue) await writeQueue;
    const previousReplacementIndex = replacementIndex;
    try {
      let readSucceeded = false;
      let stored;
      if (typeof storage?.get === "function") {
        try {
          stored = await storage.get([
            storageKeys.browserJobs,
            storageKeys.activeBrowserJob,
            storageKeys.jobMonitorCollapsed
          ]);
          readSucceeded = true;
        } catch {
          stored = {};
          historyReadBlocked = true;
        }
      }
      const originals = Array.isArray(stored?.[storageKeys.browserJobs]) ? stored[storageKeys.browserJobs] : [];
      const reserved = new Set(originals.map((job) => String(job?.id ?? "")));
      const used = new Set();
      const identities = new Map();
      const candidates = originals.map((original) => {
        const originalId = String(original?.id ?? createId());
        const id = redactTraceText(originalId) === originalId && !used.has(originalId)
          ? originalId : safeId(originalId, new Set([...reserved, ...used]));
        used.add(id); reserved.add(id);
        if (!identities.has(originalId)) identities.set(originalId, id);
        const input = { ...original, id };
        const clean = sanitizedJobInput(input);
        const live = normalizeBrowserJob(clean, { now });
        return durableRecord(input, live).job;
      }).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, maxJobs);
      const collapsed = typeof stored?.[storageKeys.jobMonitorCollapsed] === "boolean"
        ? stored[storageKeys.jobMonitorCollapsed] : true;
      const storedActiveId = identities.get(String(stored?.[storageKeys.activeBrowserJob] ?? ""));
      const storedActive = candidates.find((job) => job.id === storedActiveId);
      const nextActiveId = storedActive && isActiveBrowserJobStatus(storedActive.status)
        ? storedActive.id
        : candidates.find((job) => isActiveBrowserJobStatus(job.status))?.id ?? storedActive?.id ?? null;
      const envelope = {
        [storageKeys.activeBrowserJob]: nextActiveId,
        [storageKeys.browserJobs]: candidates,
        [storageKeys.jobMonitorCollapsed]: collapsed
      };
      // Missing keys already represent these defaults. Migrate only a changed
      // effective value, including newly selected focus or sanitized job records.
      const defaults = {
        [storageKeys.activeBrowserJob]: null,
        [storageKeys.browserJobs]: [],
        [storageKeys.jobMonitorCollapsed]: true
      };
      // Prepare the complete state before migration or any live installation.
      const nextDurableJobs = new Map(candidates.map((job) => [job.id, { job: redactTraceValue(job), unsafeLock: false, unsafePreflight: false }]));
      if (readSucceeded && Object.entries(envelope).some(([key, value]) => {
        const previous = stored?.[key] === undefined ? defaults[key] : stored[key];
        return JSON.stringify(value) !== JSON.stringify(previous);
      })) {
        // Recovery may migrate this validated envelope while ordinary writes
        // remain blocked until hydration completes.
        await writeEnvelope(redactTraceValue(envelope), { hydration: true });
      }
      jobs = candidates;
      durableJobs = nextDurableJobs;
      activeJobId = nextActiveId;
      monitorCollapsed = collapsed;
      if (readSucceeded) historyReadBlocked = false;
      return snapshot();
    } catch (error) {
      historyReadBlocked = true;
      replacementIndex = previousReplacementIndex;
      throw error;
    }
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
    // A failed history read cannot safely admit a new durable job.
    // The controller converts this fulfilled null into a reported refusal.
    if (historyReadBlocked) return null;
    const normalizedLock = normalizePageLock(pageLock, { now });
    const conflict = conflictingActiveJobForLock(normalizedLock);
    const initialStatus = VALID_JOB_STATUSES.includes(status) ? status : "running";
    if (conflict && initialStatus !== "queued") {
      throw new Error(`Browser target is already controlled by ${conflict.id}: ${conflict.goal}`);
    }
    const input = {
      id: safeId(createId(), new Set(jobs.map((job) => job.id))),
      goal,
      planner,
      summary,
      preflightDecision,
      pageLock: pageLock ? { ...pageLock, acquiredAt: normalizedLock?.acquiredAt } : null,
      status: initialStatus,
      createdAt: now(),
      updatedAt: now()
    };
    const job = normalizeBrowserJob(input, { now: () => input.updatedAt });
    durableJobs.set(job.id, durableRecord(input, job));
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
        id: job.id,
        status,
        pageLock: normalizedPatchLock !== undefined
          ? normalizedPatchLock
          : isLockHoldingBrowserJobStatus(status) ? job.pageLock : null,
        updatedAt: now(),
        completedAt: patch.completedAt ?? (isTerminalBrowserJobStatus(patch.status) ? now() : job.completedAt)
      }, { now });
      const durablePatch = { ...patch, id: job.id };
      if (normalizedPatchLock !== undefined) {
        durablePatch.pageLock = patch.pageLock ? { ...patch.pageLock, acquiredAt: normalizedPatchLock?.acquiredAt } : null;
      }
      durableJobs.set(job.id, durableRecord(durablePatch, updated, durableJobs.get(job.id)));
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
      durableJobs.set(job.id, durableRecord({ lastError: reason }, recoveredJob, durableJobs.get(job.id)));
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

  async function clearCompletedJobs() {
    const before = jobs.length;
    // Keep the focused job even if it settled, so we never yank a card the human
    // is currently inspecting; persist() re-nulls activeJobId if it went away.
    jobs = jobs.filter((job) => job.id === activeJobId || !isClearableBrowserJobStatus(job.status));
    const removed = before - jobs.length;
    await persist();
    return removed;
  }

  return {
    activateJob: enqueue(activateJob),
    clearCompletedJobs: enqueue(clearCompletedJobs),
    conflictingActiveJobForLock,
    createJob: enqueue(createJob),
    currentJob,
    findJob,
    getActiveJobId,
    getJobs,
    getMonitorCollapsed,
    getSchedulerState,
    getStaleJobs,
    hydrate: enqueue(hydrate),
    isHistoryReadBlocked: () => historyReadBlocked,
    persist: enqueue(persist),
    recoverInterruptedJobs: enqueue(recoverInterruptedJobs),
    setMonitorCollapsed: enqueue(setMonitorCollapsed),
    snapshot,
    toggleMonitorCollapsed: enqueue(toggleMonitorCollapsed),
    updateJob: enqueue(updateJob)
  };
}
